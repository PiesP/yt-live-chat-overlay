/**
 * ReplayChatSource — replay chat source with rAF-based exact-timing flush.
 *
 * Separated from chat-source.ts. Uses a requestAnimationFrame loop for
 * frame-accurate message emission synchronized with video playback position.
 * API fetching runs in a decoupled background interval.
 */

import { extractChatEvents } from '@core/chat-message-parser';
import { ChatSource, type PlaybackSnapshot } from '@core/chat-source-base';
import { findElementMatch, isAbortError, throwIfAborted, VIDEO_SELECTORS } from '@core/dom';
import { createLogger } from '@core/logging';
import { ReplayBuffer } from '@core/replay-buffer';
import { fetchReplayChat, type LiveChatPayload } from '@core/youtubei-chat';
import {
  extractPlayerSeekContinuation,
  extractReplayContinuation,
  type InnertubeContinuationData,
} from '@core/youtubei-continuation';

const log = createLogger('ReplayChatSource');

const REPLAY_FETCH_MIN_DELTA_MS = 1000;
const REPLAY_CONSECUTIVE_FAILURE_LIMIT = 5;
const REPLAY_FAILURE_BACKOFF_MS = 5000;
const REPLAY_PREFETCH_WINDOW_MS = 5000;
const BACKGROUND_FETCH_INTERVAL_MS = 1000;
const RAF_FLUSH_BATCH_SIZE = 5;

type ReplayMode = 'playerSeek' | 'continuation';

export class ReplayChatSource extends ChatSource {
  private static readonly MAX_REPLAY_BATCHES = 12;

  private replayMode: ReplayMode | null = null;
  private replayPlayerSeekContinuation: InnertubeContinuationData | null = null;
  private replayContinuation: InnertubeContinuationData | null = null;
  private replayFallbackLastOffsetMs = -1;
  private lastReplayRequestedOffsetMs = -REPLAY_FETCH_MIN_DELTA_MS;
  private replayConsecutiveFailures = 0;
  private replayNextAllowedFetchAt = 0;
  private replayBuffer = new ReplayBuffer();
  private seekListenerCleanup: (() => void) | null = null;
  private rafHandle: ReturnType<typeof requestAnimationFrame> | null = null;
  private backgroundFetchTimer: ReturnType<typeof setInterval> | null = null;

  protected seedCurrentSession(signal?: AbortSignal): Promise<boolean> {
    return this.initializeReplaySession(signal);
  }

  protected launchCurrentPollLoop(signal?: AbortSignal): void {
    this.startRafFlush(signal);
    this.startBackgroundFetch(signal);
    this.installSeekListeners(signal);
  }

  /**
   * Override health check to reflect rAF + background-fetch lifetime
   * instead of the base class's pollLoopManager, which is unused by
   * ReplayChatSource.
   */
  protected isObserverAlive(): boolean {
    return this.rafHandle !== null && this.backgroundFetchTimer !== null && this.callback !== null;
  }

  protected resetSessionState(): void {
    super.resetSessionState();
    this.resetReplayState();
  }

  // ── rAF flush loop ──────────────────────────────────────────────────────

  /**
   * Start a requestAnimationFrame loop that flushes replay messages
   * at the exact video playback position every frame (~16ms precision).
   */
  private startRafFlush(signal?: AbortSignal): void {
    this.stopRafFlush();

    const tick = (): void => {
      if (signal?.aborted) {
        this.rafHandle = null;
        return;
      }

      const playback = this.getPlaybackSnapshot();
      if (playback && !playback.paused) {
        this.markActivity();
        this.flushReplayBuffer(playback.offsetMs);
      }

      this.rafHandle = requestAnimationFrame(tick);
    };

    this.rafHandle = requestAnimationFrame(tick);
  }

  private stopRafFlush(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  // ── Background fetch ────────────────────────────────────────────────────

  /**
   * Periodically fetch new replay pages from YouTube so the buffer
   * stays ahead of the playback position.
   *
   * In a future phase this will be replaced by a full-chat prefetch
   * that walks the entire continuation chain in advance.
   */
  private startBackgroundFetch(signal?: AbortSignal): void {
    this.stopBackgroundFetch();

    this.backgroundFetchTimer = setInterval(() => {
      if (signal?.aborted) {
        this.stopBackgroundFetch();
        return;
      }

      const playback = this.getPlaybackSnapshot();
      if (!playback || playback.paused) return;

      void (async () => {
        try {
          if (this.replayMode === 'playerSeek') {
            await this.pollPlayerSeekReplay(playback, signal);
          } else if (this.replayMode === 'continuation') {
            await this.pollContinuationReplay(playback.offsetMs, signal);
          }
        } catch (error: unknown) {
          if (!isAbortError(error)) {
            log.warn('Background fetch iteration failed:', error);
          }
        }
      })();
    }, BACKGROUND_FETCH_INTERVAL_MS);
  }

  private stopBackgroundFetch(): void {
    if (this.backgroundFetchTimer !== null) {
      clearInterval(this.backgroundFetchTimer);
      this.backgroundFetchTimer = null;
    }
  }

  // ── Seek listeners ──────────────────────────────────────────────────────

  private installSeekListeners(signal?: AbortSignal): void {
    this.seekListenerCleanup?.();
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
    this.replayBuffer.clear();
    this.lastReplayRequestedOffsetMs = offsetMs;
    this.replayConsecutiveFailures = 0;
    if (this.replayMode === 'playerSeek' && this.replayPlayerSeekContinuation) {
      void (async () => {
        try {
          await this.fetchReplayPlayerSeek(offsetMs);
          this.flushReplayBuffer(offsetMs);
        } catch (error: unknown) {
          if (!isAbortError(error)) {
            log.warn('Seek replay fetch failed:', error);
          }
        }
      })();
    } else if (this.replayMode === 'continuation') {
      void (async () => {
        try {
          await this.pollContinuationReplay(offsetMs);
        } catch (error: unknown) {
          if (!isAbortError(error)) {
            log.warn('Continuation poll in seek handler failed:', error);
          }
        }
      })();
    }
  }

  // ── State management ────────────────────────────────────────────────────

  private resetReplayState(): void {
    this.replayMode = null;
    this.replayPlayerSeekContinuation = null;
    this.replayContinuation = null;
    this.replayFallbackLastOffsetMs = -1;
    this.lastReplayRequestedOffsetMs = -REPLAY_FETCH_MIN_DELTA_MS;
    this.replayConsecutiveFailures = 0;
    this.replayNextAllowedFetchAt = 0;
    this.replayBuffer.clear();
    this.seekListenerCleanup?.();
    this.seekListenerCleanup = null;
    this.stopRafFlush();
    this.stopBackgroundFetch();
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
      this.replayFallbackLastOffsetMs = this.replayBuffer.appendEvents(
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

  // ── API helpers ─────────────────────────────────────────────────────────

  private requestReplayPayload(
    continuation: InnertubeContinuationData,
    signal?: AbortSignal,
    playerOffsetMs?: number
  ): Promise<LiveChatPayload | null> {
    return this.requestPayload(fetchReplayChat, continuation, playerOffsetMs, signal);
  }

  /**
   * Flush messages whose video time has been reached.
   *
   * Emits at most RAF_FLUSH_BATCH_SIZE (5) messages per frame to prevent
   * visual clumping — same-timestamp messages spread naturally across
   * multiple frames (~16ms each) for a smooth stream.
   */
  private flushReplayBuffer(currentOffsetMs: number): void {
    if (!this.callback) return;

    const batch = this.replayBuffer.flushUpTo(currentOffsetMs, RAF_FLUSH_BATCH_SIZE);

    if (batch.length === 0) return;
    this.emitBatch(batch, false);
  }

  // ── Fetch methods ───────────────────────────────────────────────────────

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
      this.replayBuffer.appendEvents(
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
      this.replayFallbackLastOffsetMs = this.replayBuffer.appendEvents(events, minimumOffsetMs);
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

  // ── Poll methods (fetch + backoff only — flush is handled by rAF) ───────

  private async pollPlayerSeekReplay(
    playback: PlaybackSnapshot,
    signal?: AbortSignal
  ): Promise<void> {
    if (playback.paused || !this.shouldFetchReplayAtOffset(playback.offsetMs)) {
      return;
    }

    const fetched = await this.fetchReplayPlayerSeek(playback.offsetMs, signal);
    // Flush is handled by the rAF loop — no explicit flush call here.

    if (fetched) {
      return;
    }

    const bootstrap = await this.bootstrapResolver.refresh(signal);
    if (!bootstrap?.isReplay) {
      return;
    }
    this.bootstrap = bootstrap;
    await this.initializeReplaySession(signal);
  }

  private shouldFetchReplayAtOffset(currentOffsetMs: number): boolean {
    if (this.replayMode !== 'playerSeek' || !this.replayPlayerSeekContinuation) {
      return false;
    }

    if (this.replayBuffer.isEmpty) {
      return true;
    }

    return currentOffsetMs - this.lastReplayRequestedOffsetMs >= REPLAY_FETCH_MIN_DELTA_MS;
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

    // Flush is handled by the rAF loop — no explicit flush call here.
  }
}
