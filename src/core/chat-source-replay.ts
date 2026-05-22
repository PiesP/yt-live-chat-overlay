/**
 * ReplayChatSource — replay polling loop with playerSeek + continuation.
 *
 * Extracted from chat-source.ts to separate live and replay chat concerns.
 */

import type { ChatMessage } from '@app-types';
import { type ChatEvent, extractChatEvents } from '@core/chat-message-parser';
import { ChatSource, type PlaybackSnapshot } from '@core/chat-source-base';
import { findElementMatch, isAbortError, sleep, throwIfAborted, VIDEO_SELECTORS } from '@core/dom';
import { createLogger } from '@core/logging';
import {
  extractPlayerSeekContinuation,
  extractReplayContinuation,
  fetchReplayChat,
  type InnertubeContinuationData,
  type LiveChatPayload,
} from '@core/youtubei-chat';

const log = createLogger('ReplayChatSource');

const REPLAY_LOOP_DELAY_MS = 250;
const REPLAY_FETCH_MIN_DELTA_MS = 1000;
const REPLAY_EMIT_TOLERANCE_MS = 300;
const REPLAY_CONSECUTIVE_FAILURE_LIMIT = 5;
const REPLAY_FAILURE_BACKOFF_MS = 5000;
const REPLAY_PREFETCH_WINDOW_MS = 5000;
const MAX_BUFFERED_REPLAY_MESSAGES = 300;
const RECONNECT_RETRY_DELAY_MS = 1000;

type ReplayMode = 'playerSeek' | 'continuation';

interface ReplayBufferedMessage {
  key: string;
  message: ChatMessage;
  offsetMs: number;
}

export class ReplayChatSource extends ChatSource {
  private static readonly MAX_REPLAY_BATCHES = 12;

  private replayMode: ReplayMode | null = null;
  private replayPlayerSeekContinuation: InnertubeContinuationData | null = null;
  private replayContinuation: InnertubeContinuationData | null = null;
  private replayFallbackLastOffsetMs = -1;
  private lastReplayRequestedOffsetMs = -REPLAY_FETCH_MIN_DELTA_MS;
  private replayConsecutiveFailures = 0;
  private replayNextAllowedFetchAt = 0;
  private replayBuffer: ReplayBufferedMessage[] = [];
  private seekListenerCleanup: (() => void) | null = null;

  protected seedCurrentSession(signal?: AbortSignal): Promise<boolean> {
    return this.initializeReplaySession(signal);
  }

  protected launchCurrentPollLoop(signal?: AbortSignal): void {
    this.launchPollLoop(signal, (loopSignal) => this.runReplayLoop(loopSignal));
    this.installSeekListeners(signal);
  }

  protected resetSessionState(): void {
    super.resetSessionState();
    this.resetReplayState();
  }

  private installSeekListeners(signal?: AbortSignal): void {
    const el = findElementMatch<HTMLVideoElement>(VIDEO_SELECTORS);
    if (!el) return;
    const v = el.element;
    const onSeeked = (): void => {
      if (signal?.aborted) return;
      const offsetMs = Math.max(0, Math.floor(v.currentTime * 1000));
      this.handleSeeked(offsetMs);
    };
    v.addEventListener('seeked', onSeeked);
    this.seekListenerCleanup = () => {
      v.removeEventListener('seeked', onSeeked);
    };
  }

  private handleSeeked(offsetMs: number): void {
    this.replayBuffer = [];
    this.lastReplayRequestedOffsetMs = offsetMs;
    if (this.replayMode === 'playerSeek' && this.replayPlayerSeekContinuation) {
      void this.fetchReplayPlayerSeek(offsetMs)
        .then(() => {
          this.flushReplayBuffer(offsetMs);
        })
        .catch((error: unknown) => {
          if (!isAbortError(error)) {
            log.warn('Seek playerSeek fetch failed:', error);
          }
        });
    } else if (this.replayMode === 'continuation') {
      void this.pollContinuationReplay(offsetMs);
    }
  }

  private resetReplayState(): void {
    this.replayMode = null;
    this.replayPlayerSeekContinuation = null;
    this.replayContinuation = null;
    this.replayFallbackLastOffsetMs = -1;
    this.lastReplayRequestedOffsetMs = -REPLAY_FETCH_MIN_DELTA_MS;
    this.replayConsecutiveFailures = 0;
    this.replayNextAllowedFetchAt = 0;
    this.replayBuffer = [];
    this.seekListenerCleanup?.();
    this.seekListenerCleanup = null;
  }

  private async initializeReplaySession(signal?: AbortSignal): Promise<boolean> {
    if (!this.bootstrap) {
      return false;
    }

    this.resetReplayState();

    try {
      const initialPayload = await this.requestReplayPayload(
        this.bootstrap.initialContinuation,
        signal
      );
      if (!initialPayload) {
        return false;
      }

      const playerSeekContinuation = extractPlayerSeekContinuation(initialPayload.continuations);
      if (playerSeekContinuation) {
        this.replayMode = 'playerSeek';
        this.replayPlayerSeekContinuation = playerSeekContinuation;

        const currentOffsetMs = this.getPlaybackSnapshot()?.offsetMs ?? 0;
        const seeded = await this.fetchReplayPlayerSeek(currentOffsetMs, signal);
        this.flushReplayBuffer(currentOffsetMs);
        return seeded;
      }

      const replayContinuation = extractReplayContinuation(initialPayload.continuations);
      if (!replayContinuation) {
        log.warn('Replay session did not expose playerSeek or replay continuation data');
        return false;
      }

      this.replayMode = 'continuation';
      this.replayContinuation = replayContinuation;

      const currentOffsetMs = this.getPlaybackSnapshot()?.offsetMs ?? 0;
      const minimumOffsetMs = Math.max(0, currentOffsetMs - REPLAY_PREFETCH_WINDOW_MS);
      this.replayFallbackLastOffsetMs = this.bufferReplayEvents(
        extractChatEvents(initialPayload.actions, this.getSettings),
        minimumOffsetMs
      );
      let batchesFetched = 0;
      while (
        this.replayContinuation &&
        this.replayFallbackLastOffsetMs < minimumOffsetMs &&
        batchesFetched < ReplayChatSource.MAX_REPLAY_BATCHES
      ) {
        throwIfAborted(signal);
        const fetched = await this.fetchNextReplayFallbackBatch(minimumOffsetMs, signal);
        if (!fetched) break;
        batchesFetched += 1;
      }
      this.flushReplayBuffer(currentOffsetMs);
      return true;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      log.warn('Failed to initialize replay chat session:', error);
      return false;
    }
  }

  private async reinitializeReplaySession(signal?: AbortSignal): Promise<boolean> {
    const bootstrap = await this.bootstrapResolver.refresh(signal);
    if (!bootstrap?.isReplay) {
      return false;
    }
    this.bootstrap = bootstrap;

    return this.initializeReplaySession(signal);
  }

  private async runReplayLoop(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      await this.waitWhilePaused(signal);

      const playback = this.getPlaybackSnapshot();
      const currentOffsetMs = playback?.offsetMs ?? 0;

      if (!playback) {
        await sleep(REPLAY_LOOP_DELAY_MS, signal);
        continue;
      }

      if (playback.paused) {
        await sleep(REPLAY_LOOP_DELAY_MS, signal);
        continue;
      }

      this.flushReplayBuffer(currentOffsetMs);

      if (this.replayMode === 'playerSeek') {
        await this.pollPlayerSeekReplay(playback, signal);
      } else if (this.replayMode === 'continuation') {
        await this.pollContinuationReplay(currentOffsetMs, signal);
      }

      await sleep(REPLAY_LOOP_DELAY_MS, signal);
    }
  }

  private async requestReplayPayload(
    continuation: InnertubeContinuationData,
    signal?: AbortSignal,
    playerOffsetMs?: number
  ): Promise<LiveChatPayload | null> {
    return this.requestPayload(fetchReplayChat, continuation, playerOffsetMs, signal);
  }

  private makeReplayKey(message: ChatMessage, offsetMs: number): string {
    return message.id ?? `${message.kind}:${offsetMs}:${message.author ?? ''}:${message.text}`;
  }

  private trimReplayBuffer(): void {
    if (this.replayBuffer.length <= MAX_BUFFERED_REPLAY_MESSAGES) {
      return;
    }

    const overflow = this.replayBuffer.length - MAX_BUFFERED_REPLAY_MESSAGES;
    if (overflow > 0) {
      this.replayBuffer.splice(0, overflow);
    }
  }

  private bufferReplayEvents(events: ChatEvent[], minimumOffsetMs = 0): number {
    let highestOffsetMs = this.replayFallbackLastOffsetMs;

    for (const event of events) {
      if (event.offsetMs === undefined) {
        continue;
      }

      highestOffsetMs = Math.max(highestOffsetMs, event.offsetMs);
      if (event.offsetMs < minimumOffsetMs) {
        continue;
      }

      const key = this.makeReplayKey(event.message, event.offsetMs);
      this.insertBufferedEvent(key, event.message, event.offsetMs);
    }

    this.trimReplayBuffer();
    return highestOffsetMs;
  }

  private insertBufferedEvent(key: string, message: ChatMessage, offsetMs: number): void {
    let low = 0;
    let high = this.replayBuffer.length;

    while (low < high) {
      const mid = (low + high) >>> 1;
      const midItem = this.replayBuffer[mid];
      if (!midItem) {
        break;
      }

      if (midItem.key === key) {
        return;
      }

      if (midItem.offsetMs <= offsetMs) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    this.replayBuffer.splice(low, 0, { key, message, offsetMs });
  }

  private flushReplayBuffer(currentOffsetMs: number): void {
    if (!this.callback || this.replayBuffer.length === 0) {
      return;
    }

    // Collect a batch of messages (up to 50 at a time) and emit as a group.
    // This lets the runtime session route the batch through the backlog
    // controller instead of flooding the renderer with individual messages.
    const batch: ChatMessage[] = [];
    while (this.replayBuffer.length > 0 && batch.length < 50) {
      const next = this.replayBuffer[0];
      if (!next) break;

      if (next.offsetMs > currentOffsetMs + REPLAY_EMIT_TOLERANCE_MS) {
        break;
      }

      this.replayBuffer.shift();

      if (next.offsetMs < currentOffsetMs - REPLAY_EMIT_TOLERANCE_MS) {
        continue;
      }

      batch.push(next.message);
    }

    if (batch.length === 0) return;
    this.emitBatch(batch, false);
  }

  private async fetchReplayPlayerSeek(offsetMs: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.replayPlayerSeekContinuation) {
      return false;
    }

    try {
      const payload = await this.requestReplayPayload(
        this.replayPlayerSeekContinuation,
        signal,
        offsetMs
      );
      if (!payload) {
        this.recordReplayFailure();
        return false;
      }

      const nextPlayerSeekContinuation = extractPlayerSeekContinuation(payload.continuations);
      this.bufferReplayEvents(
        extractChatEvents(payload.actions, this.getSettings),
        Math.max(0, offsetMs - REPLAY_PREFETCH_WINDOW_MS)
      );
      this.replayPlayerSeekContinuation = nextPlayerSeekContinuation;
      this.lastReplayRequestedOffsetMs = offsetMs;

      this.replayConsecutiveFailures = 0;
      this.replayNextAllowedFetchAt = 0;

      return nextPlayerSeekContinuation !== null || payload.actions.length > 0;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      log.warn('Replay playerSeek request failed:', error);
      this.recordReplayFailure();
      return false;
    }
  }

  private async fetchNextReplayFallbackBatch(
    minimumOffsetMs: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (!this.replayContinuation) {
      return false;
    }

    try {
      const payload = await this.requestReplayPayload(this.replayContinuation, signal);
      if (!payload) {
        this.recordReplayFailure();
        return false;
      }

      const events = extractChatEvents(payload.actions, this.getSettings);
      this.replayFallbackLastOffsetMs = this.bufferReplayEvents(events, minimumOffsetMs);
      this.replayContinuation = extractReplayContinuation(payload.continuations);

      this.replayConsecutiveFailures = 0;
      this.replayNextAllowedFetchAt = 0;

      return this.replayContinuation !== null || events.length > 0;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      log.warn('Replay continuation request failed:', error);
      this.recordReplayFailure();
      return false;
    }
  }

  private recordReplayFailure(): void {
    this.replayConsecutiveFailures += 1;
    if (this.replayConsecutiveFailures >= REPLAY_CONSECUTIVE_FAILURE_LIMIT) {
      const backoffUntil = Date.now() + REPLAY_FAILURE_BACKOFF_MS;
      this.replayNextAllowedFetchAt = backoffUntil;
      this.replayConsecutiveFailures = 0;
      log.warn(
        `Replay fetch failed ${REPLAY_CONSECUTIVE_FAILURE_LIMIT} times consecutively; ` +
          `backing off for ${REPLAY_FAILURE_BACKOFF_MS}ms`
      );
    }
  }

  private shouldFetchReplayAtOffset(currentOffsetMs: number): boolean {
    if (this.replayMode !== 'playerSeek' || !this.replayPlayerSeekContinuation) {
      return false;
    }

    if (this.replayBuffer.length === 0) {
      return true;
    }

    return currentOffsetMs - this.lastReplayRequestedOffsetMs >= REPLAY_FETCH_MIN_DELTA_MS;
  }

  private async pollPlayerSeekReplay(
    playback: PlaybackSnapshot,
    signal?: AbortSignal
  ): Promise<void> {
    if (playback.paused || !this.shouldFetchReplayAtOffset(playback.offsetMs)) {
      return;
    }

    const fetched = await this.fetchReplayPlayerSeek(playback.offsetMs, signal);
    this.flushReplayBuffer(playback.offsetMs);

    if (fetched) {
      return;
    }

    const reinitialized = await this.reinitializeReplaySession(signal);
    if (!reinitialized) {
      await sleep(RECONNECT_RETRY_DELAY_MS, signal);
    }
  }

  private async pollContinuationReplay(
    currentOffsetMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    if (Date.now() < this.replayNextAllowedFetchAt) {
      return;
    }

    const minimumOffsetMs = Math.max(0, currentOffsetMs - REPLAY_PREFETCH_WINDOW_MS);
    let batches = 0;

    while (
      this.replayContinuation &&
      this.replayFallbackLastOffsetMs < minimumOffsetMs &&
      batches < ReplayChatSource.MAX_REPLAY_BATCHES
    ) {
      throwIfAborted(signal);

      const fetched = await this.fetchNextReplayFallbackBatch(minimumOffsetMs, signal);
      if (!fetched) {
        break;
      }

      batches += 1;
    }

    if (
      this.replayContinuation &&
      this.replayNextAllowedFetchAt <= Date.now() &&
      this.replayFallbackLastOffsetMs < currentOffsetMs + REPLAY_PREFETCH_WINDOW_MS
    ) {
      await this.fetchNextReplayFallbackBatch(minimumOffsetMs, signal);
    }

    this.flushReplayBuffer(currentOffsetMs);
  }
}
