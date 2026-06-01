// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * ReplayChatSource — replay chat source with rAF-based exact-timing flush.
 *
 * Separated from chat-source.ts. Uses a requestAnimationFrame loop for
 * frame-accurate message emission synchronized with video playback position.
 * API fetching runs in a decoupled background interval.
 */

import { extractChatEvents } from '@core/chat-message-parser';
import type { PlaybackSnapshot } from '@core/chat-source-base';
import { ChatSource } from '@core/chat-source-base';
import {
  clearSafeTimeout,
  findElementMatch,
  isAbortError,
  throwIfAborted,
  VIDEO_SELECTORS,
} from '@core/dom';
import { createLogger } from '@core/logging';
import { ReplayBuffer } from '@core/replay-buffer';
import type { LiveChatPayload } from '@core/youtubei-chat';
import { fetchReplayChat } from '@core/youtubei-chat';
import type { InnertubeContinuationData } from '@core/youtubei-continuation';
import {
  extractPlayerSeekContinuation,
  extractReplayContinuation,
} from '@core/youtubei-continuation';

const log = createLogger('ReplayChatSource');

const REPLAY_FETCH_MIN_DELTA_MS = 1000;
const REPLAY_CONSECUTIVE_FAILURE_LIMIT = 5;
const REPLAY_FAILURE_BACKOFF_MS = 5000;
const REPLAY_PREFETCH_WINDOW_MS = 5000;
const BACKGROUND_FETCH_INTERVAL_MS = 1000;
const RAF_FLUSH_BATCH_SIZE = 5;
// replayPrefetchPages — read from this.getSettings()

type ReplayMode = 'playerSeek' | 'continuation';

export class ReplayChatSource extends ChatSource {
  // replayBatchLimit — read from this.getSettings()

  private replayMode: ReplayMode | null = null;
  private replayPlayerSeekContinuation: InnertubeContinuationData | null = null;
  private replayContinuation: InnertubeContinuationData | null = null;
  private replayFallbackLastOffsetMs = -1;
  private lastReplayRequestedOffsetMs = -REPLAY_FETCH_MIN_DELTA_MS;
  private replayConsecutiveFailures = 0;
  private replayNextAllowedFetchAt = 0;
  private replayBuffer = new ReplayBuffer();
  private seekListenerCleanup: (() => void) | null = null;
  private seekSignal: AbortSignal | null = null;
  private cooperativeLoopTimer: ReturnType<typeof setTimeout> | null = null;
  private cooperativeLoopRunning = false;
  private prefetchContinuation: InnertubeContinuationData | null = null;
  private prefetchPagesFetched = 0;
  private prefetchMode: ReplayMode | null = null;
  private prefetchBackoffUntil = 0;

  protected seedCurrentSession(signal?: AbortSignal): Promise<boolean> {
    return this.initializeReplaySession(signal);
  }

  protected launchCurrentPollLoop(signal?: AbortSignal): void {
    this.startCooperativeLoop(signal);
    this.installSeekListeners(signal);
  }

  /**
   * Override health check to reflect cooperative loop lifetime.
   */
  protected isObserverAlive(): boolean {
    return this.cooperativeLoopRunning && this.callback !== null;
  }

  /**
   * Override setPaused to reset fetch throttles on unpause.
   *
   * When the tab is hidden for more than a few seconds, the background
   * fetch interval skips every tick (`chatPaused` check). If the video
   * kept playing during hidden, the buffer will be empty at the new
   * playback position on return. Resetting the throttles here causes
   * the very next background fetch tick to fire without delay — the
   * first tick after unpause is at most BACKGROUND_FETCH_INTERVAL_MS
   * (1s) away, vs waiting for the normal min-delta throttle (1s) to
   * elapse from the last (stale) fetch offset.
   */
  setPaused(paused: boolean): void {
    super.setPaused(paused);
    if (!paused) {
      this.lastReplayRequestedOffsetMs = -REPLAY_FETCH_MIN_DELTA_MS;
      this.replayNextAllowedFetchAt = 0;
    }
  }

  protected resetSessionState(): void {
    super.resetSessionState();
    this.resetReplayState();
  }

  // ── Cooperative loop (unified flush + fetch + prefetch) ─────────────────

  /**
   * Start a single cooperative tick loop that:
   *   1. Flushes buffered replay messages at playback position
   *   2. Fetches more replay pages when the buffer needs data
   *   3. Prefetches continuation pages in the background
   *
   * Replaces the previous 3 independent schedulers (rAF flush, background
   * fetch interval, async prefetch walk) with one setTimeout-driven loop.
   */
  private startCooperativeLoop(signal?: AbortSignal): void {
    this.stopCooperativeLoop();

    // Initialize prefetch state from current shared continuations
    if (this.replayMode) {
      this.prefetchContinuation =
        this.replayMode === 'playerSeek'
          ? this.replayPlayerSeekContinuation
          : this.replayContinuation;
      this.prefetchPagesFetched = 0;
      this.prefetchMode = this.replayMode;
      this.prefetchBackoffUntil = 0;
    }

    this.cooperativeLoopRunning = true;

    const tick = async (): Promise<void> => {
      if (signal?.aborted) {
        this.cooperativeLoopRunning = false;
        this.cooperativeLoopTimer = null;
        return;
      }

      // 1. If paused, reschedule at background rate and skip work
      if (this.chatPaused) {
        this.cooperativeLoopTimer = setTimeout(tick, BACKGROUND_FETCH_INTERVAL_MS);
        return;
      }

      const playback = this.getPlaybackSnapshot();
      const isPlaying = playback && !playback.paused;

      // 2. Flush: emit messages whose video time has arrived
      if (isPlaying) {
        this.markActivity();
        this.flushReplayBuffer(playback.offsetMs);
      }

      // 3. Fetch: if buffer needs more pages, call the appropriate poll method
      if (isPlaying) {
        try {
          if (this.replayMode === 'playerSeek') {
            await this.pollPlayerSeekReplay(playback, signal);
          } else if (this.replayMode === 'continuation') {
            await this.pollContinuationReplay(playback.offsetMs, signal);
          }
        } catch (error: unknown) {
          if (!isAbortError(error)) {
            log.warn('Fetch iteration failed:', error);
          }
        }
      }

      // 4. Prefetch: walk the continuation chain, one page per tick
      if (
        this.prefetchContinuation &&
        this.prefetchPagesFetched < this.getSettings().replayPrefetchPages &&
        !signal?.aborted &&
        Date.now() >= this.prefetchBackoffUntil
      ) {
        try {
          const payload = await this.requestReplayPayload(this.prefetchContinuation, signal);
          if (payload) {
            const events = extractChatEvents(payload.actions, this.getSettings);
            this.replayBuffer.appendEvents(events, -1);
            this.markActivity();
            this.prefetchContinuation =
              this.prefetchMode === 'playerSeek'
                ? extractPlayerSeekContinuation(payload.continuations)
                : extractReplayContinuation(payload.continuations);
            this.prefetchPagesFetched += 1;
          } else {
            this.prefetchContinuation = null;
          }
        } catch (error: unknown) {
          if (isAbortError(error)) {
            this.prefetchContinuation = null;
          } else {
            log.warn('Prefetch page failed:', error);
            this.prefetchBackoffUntil = Date.now() + 5000;
          }
        }
      }

      // 5. Schedule next tick with adaptive delay
      const hasPendingFlushes = !this.replayBuffer.isEmpty;
      const adaptiveDelay = hasPendingFlushes ? 16 : BACKGROUND_FETCH_INTERVAL_MS;

      if (!signal?.aborted && this.cooperativeLoopRunning) {
        this.cooperativeLoopTimer = setTimeout(tick, adaptiveDelay);
      }
    };

    // Fire first tick immediately (after next microtask)
    this.cooperativeLoopTimer = setTimeout(tick, 0);
  }

  private stopCooperativeLoop(): void {
    this.cooperativeLoopTimer = clearSafeTimeout(this.cooperativeLoopTimer);
    this.cooperativeLoopRunning = false;
  }

  /** Reset prefetch state — cooperative loop will skip the prefetch step. */
  private stopPrefetch(): void {
    this.prefetchContinuation = null;
    this.prefetchPagesFetched = 0;
    this.prefetchMode = null;
    this.prefetchBackoffUntil = 0;
  }

  /**
   * Initialize prefetch state from current shared continuations.
   * The cooperative loop picks this up on its next tick.
   */
  private startPrefetch(): void {
    this.stopPrefetch();
    if (!this.replayMode) return;

    this.prefetchContinuation =
      this.replayMode === 'playerSeek'
        ? this.replayPlayerSeekContinuation
        : this.replayContinuation;
    this.prefetchPagesFetched = 0;
    this.prefetchMode = this.replayMode;
    this.prefetchBackoffUntil = 0;
  }

  // ── Seek listeners ──────────────────────────────────────────────────────

  private installSeekListeners(signal?: AbortSignal): void {
    this.seekListenerCleanup?.();
    this.seekSignal = signal ?? null;
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
    // If the session was already stopped, callback is null and all downstream
    // operations (flushReplayBuffer, startPrefetch, pollContinuationReplay)
    // will no-op. Bail out early to avoid unnecessary async work.
    if (!this.callback) return;

    this.replayBuffer.clear();
    this.lastReplayRequestedOffsetMs = offsetMs;
    this.replayConsecutiveFailures = 0;

    // Cancel in-flight prefetch — new one starts from seek position below.
    this.stopPrefetch();

    if (this.replayMode === 'playerSeek' && this.replayPlayerSeekContinuation) {
      const signal = this.seekSignal ?? undefined;
      void (async () => {
        try {
          await this.fetchReplayPlayerSeek(offsetMs, signal);
          this.flushReplayBuffer(offsetMs);
          this.startPrefetch();
        } catch (error: unknown) {
          if (!isAbortError(error)) {
            log.warn('Seek replay fetch failed:', error);
          }
        }
      })();
    } else if (this.replayMode === 'continuation') {
      const signal = this.seekSignal ?? undefined;
      void (async () => {
        try {
          await this.pollContinuationReplay(offsetMs, signal);
          this.startPrefetch();
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
    this.stopCooperativeLoop();
    this.stopPrefetch();
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
        batchesFetched < this.getSettings().replayBatchLimit
      ) {
        throwIfAborted(signal);
        const fetched = await this.fetchNextReplayFallbackBatch(minimumOffsetMs, signal);
        if (!fetched) break;
        batchesFetched += 1;
      }
      this.flushReplayBuffer(currentOffsetMs);
      return true;
    } catch (error: unknown) {
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
    } catch (error: unknown) {
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
    } catch (error: unknown) {
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

    const bootstrap = await this.refreshBootstrap(signal);
    if (!bootstrap?.isReplay) {
      return;
    }
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
      batches < this.getSettings().replayBatchLimit
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
