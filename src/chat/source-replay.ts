// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * ReplayChatSource — replay chat source with rAF-based exact-timing flush.
 *
 * Separated from chat-source.ts. Uses a requestAnimationFrame loop for
 * frame-accurate message emission synchronized with video playback position.
 * API fetching runs in a decoupled background interval.
 */

import type { ChatMessage } from '@app-types';
import { extractChatEvents } from '@chat/message-parser';
import { ReplayBuffer } from '@chat/replay-buffer';
import type { ChatHealthSnapshot, PlaybackSnapshot } from '@chat/source-base';
import { ChatSource } from '@chat/source-base';
import type { LiveChatPayload } from '@chat/youtube/api';
import { fetchReplayChat } from '@chat/youtube/api';
import type { InnertubeContinuationData } from '@chat/youtube/continuation';
import {
  extractPlayerSeekContinuation,
  extractReplayContinuation,
} from '@chat/youtube/continuation';
import {
  clearSafeTimeout,
  findElementMatch,
  isAbortError,
  throwIfAborted,
  VIDEO_SELECTORS,
} from '@util/dom';
import { createLogger } from '@util/logging';

const log = createLogger('ReplayChatSource');

const REPLAY_FETCH_MIN_DELTA_MS = 1000;
const REPLAY_CONSECUTIVE_FAILURE_LIMIT = 5;
const REPLAY_FAILURE_BACKOFF_MS = 5000;
const REPLAY_TOTAL_FAILURE_LIMIT = 15; // 3 backoff cycles before re-initialization
const REPLAY_PREFETCH_WINDOW_MS = 5000;
const BACKGROUND_FETCH_INTERVAL_MS = 1000;
const REPLAY_PREFETCH_MIN_INTERVAL_MS = 250;
const RAF_FLUSH_BATCH_SIZE = 5;
/** Maximum replay request duration before the cooperative loop can recover. */
const REPLAY_FETCH_TIMEOUT_MS = 20_000;
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
  private replayTotalFailuresSinceSuccess = 0;
  private replayNextAllowedFetchAt = 0;
  private replayBuffer = new ReplayBuffer();
  private seekListenerCleanup: (() => void) | null = null;
  private seekSignal: AbortSignal | null = null;
  private seekAbortController: AbortController | null = null;
  private seekGeneration = 0;
  private cooperativeLoopTimer: ReturnType<typeof setTimeout> | null = null;
  private cooperativeLoopRunning = false;
  private cooperativeLoopGeneration = 0;
  private prefetchContinuation: InnertubeContinuationData | null = null;
  private prefetchPagesFetched = 0;
  private prefetchMode: ReplayMode | null = null;
  private prefetchBackoffUntil = 0;
  private prefetchNextAllowedAt = 0;
  /**
   * Drain all buffered replay messages regardless of their offset.
   *
   * Returns every unconsumed message currently in the buffer (sorted by
   * offsetMs) and clears the buffer. Used by RuntimeManager when returning
   * from a hidden tab — accumulated messages are routed through the
   * backlog controller for gradual emission instead of bursting.
   *
   * Returns an empty array when the buffer has no pending messages.
   */
  drainPendingMessages(): ChatMessage[] {
    // Drain messages at or near current playback position + a small
    // forward buffer (5s). Future messages remain in the buffer for
    // normal flushUpTo() emission when their offset arrives, preserving
    // time ordering instead of dumping all prefetched messages at once.
    const playback = this.getPlaybackSnapshot();
    const currentOffsetMs = playback?.offsetMs;
    const maxOffsetMs = currentOffsetMs != null ? currentOffsetMs + 5000 : undefined;
    return this.replayBuffer.drainUpTo(maxOffsetMs);
  }

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
  protected override isObserverAlive(): boolean {
    return this.cooperativeLoopRunning && this.callback !== null;
  }

  override getHealthSnapshot(options: { activeTimeoutMs?: number } = {}): ChatHealthSnapshot {
    const base = super.getHealthSnapshot(options);
    return {
      ...base,
      isInBackoff: Date.now() < this.replayNextAllowedFetchAt,
    };
  }

  protected override resetSessionState(): void {
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

    // Prefetch not seeded yet — seeded after the first successful main poll
    // so prefetchContinuation starts from the NEXT page, not the current one.
    this.stopPrefetch();

    this.cooperativeLoopRunning = true;
    const gen = ++this.cooperativeLoopGeneration;

    const tick = async (): Promise<void> => {
      if (signal?.aborted || gen !== this.cooperativeLoopGeneration) {
        this.cooperativeLoopRunning = false;
        this.cooperativeLoopTimer = null;
        return;
      }

      // 1. Mark activity even while paused so the health watchdog doesn't
      //    consider this session dead and restart it on unpause.
      if (this.isPaused) {
        this.markActivity();
      }

      const playback = this.getPlaybackSnapshot();
      const isPlaying = playback && !playback.paused;
      const mayFetchWhilePaused = !this.isPaused || this.isVisibilityOnlyPause();

      // 2. Flush: emit messages whose video time has arrived.
      //    Skip when visibility-paused (tab hidden) — messages accumulate
      //    in the replay buffer and will be drained when the tab returns.
      if (!this.isPaused && isPlaying) {
        this.markActivity();
        this.flushReplayBuffer(playback.offsetMs);
      }

      // 3. Fetch: continue fetching replay data when the video is playing,
      //    even if the tab is hidden. This prevents data gaps during long
      //    hidden intervals. When the video itself is paused, skip fetching
      //    — there's no point collecting data that won't be consumed until
      //    the user manually resumes.
      if (isPlaying && mayFetchWhilePaused) {
        let mainPollSucceeded = false;
        try {
          if (this.replayMode === 'playerSeek') {
            mainPollSucceeded = await this.pollPlayerSeekReplay(playback, signal);
          } else if (this.replayMode === 'continuation') {
            mainPollSucceeded = await this.pollContinuationReplay(playback.offsetMs, signal);
          }
        } catch (error: unknown) {
          if (!isAbortError(error)) {
            log.debug('chat.replay.fetch-failed', { error: String(error) });
          }
        }

        // stopCooperativeLoop() invalidates the generation while an async
        // poll is in flight. Do not let its completion mutate prefetch state
        // or the next replay session.
        if (signal?.aborted || gen !== this.cooperativeLoopGeneration) return;

        // Seed prefetch only after a successful main poll. If the poll
        // failed, the continuation wasn't advanced and prefetch would
        // re-request the same stale continuation.
        if (!this.prefetchMode && mainPollSucceeded) {
          this.startPrefetch();
        }
      }

      // 4. Prefetch: walk the continuation chain, one page per tick
      const now = Date.now();
      const prefetchContinuation = this.prefetchContinuation;
      if (prefetchContinuation && this.shouldPrefetch(now, signal)) {
        this.prefetchNextAllowedAt = now + REPLAY_PREFETCH_MIN_INTERVAL_MS;
        try {
          const payload = await this.requestReplayPayload(prefetchContinuation, signal);
          if (payload) {
            if (signal?.aborted || gen !== this.cooperativeLoopGeneration) return;
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
            log.debug('chat.replay.prefetch-failed', { error: String(error) });
            this.prefetchBackoffUntil = Date.now() + 5000;
          }
        }
      }

      // 5. Schedule next tick with adaptive delay
      const hasPendingFlushes = !this.replayBuffer.isEmpty;
      // When the video is paused or the tab is hidden, no flush occurs —
      // a fast 16ms loop just wastes CPU. Use the background interval.
      const videoPaused = playback?.paused ?? true;
      const adaptiveDelay =
        hasPendingFlushes && !this.isPaused && !videoPaused ? 16 : BACKGROUND_FETCH_INTERVAL_MS;

      if (!signal?.aborted && gen === this.cooperativeLoopGeneration) {
        this.cooperativeLoopTimer = setTimeout(tick, adaptiveDelay);
      }
    };

    // Fire first tick immediately (after next microtask).
    // Note: scheduler.yield() could replace setTimeout(tick, 0) here if this were an async function.
    this.cooperativeLoopTimer = setTimeout(tick, 0);
  }

  private shouldPrefetch(now: number, signal?: AbortSignal): boolean {
    return Boolean(
      this.prefetchContinuation &&
        this.prefetchPagesFetched < this.getSettings().replayPrefetchPages &&
        !signal?.aborted &&
        now >= this.prefetchBackoffUntil &&
        now >= this.prefetchNextAllowedAt
    );
  }

  private stopCooperativeLoop(): void {
    this.cooperativeLoopGeneration++;
    this.cooperativeLoopTimer = clearSafeTimeout(this.cooperativeLoopTimer);
    this.cooperativeLoopRunning = false;
    this.clearSeekListener();
  }

  /** Release the listener closure and session signal after detaching. */
  private clearSeekListener(): void {
    const cleanup = this.seekListenerCleanup;
    this.seekListenerCleanup = null;
    this.seekSignal = null;
    cleanup?.();
  }

  /** Reset prefetch state — cooperative loop will skip the prefetch step. */
  private stopPrefetch(): void {
    this.prefetchContinuation = null;
    this.prefetchPagesFetched = 0;
    this.prefetchMode = null;
    this.prefetchBackoffUntil = 0;
    this.prefetchNextAllowedAt = 0;
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
    this.clearSeekListener();
    const el = findElementMatch<HTMLVideoElement>(VIDEO_SELECTORS);
    if (!el) return;
    this.seekSignal = signal ?? null;
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

    // Increment seek generation — cancels any in-flight seek from a prior seek.
    const gen = ++this.seekGeneration;

    // Abort the previous seek's in-flight fetch (if any), then create a fresh
    // AbortController for this seek.  Compose with the session-level signal
    // so the fetch is also cancelled on session stop.
    this.seekAbortController?.abort();
    this.seekAbortController = new AbortController();
    const seekSignal = this.seekSignal
      ? AbortSignal.any([this.seekAbortController.signal, this.seekSignal])
      : this.seekAbortController.signal;

    this.replayBuffer.clear();
    this.lastReplayRequestedOffsetMs = offsetMs;
    this.replayConsecutiveFailures = 0;
    this.replayTotalFailuresSinceSuccess = 0;

    // Cancel in-flight prefetch — new one starts from seek position below.
    this.stopPrefetch();

    if (this.replayMode === 'playerSeek' && this.replayPlayerSeekContinuation) {
      void (async () => {
        try {
          if (gen !== this.seekGeneration) return;
          const seekSuccess = await this.fetchReplayPlayerSeek(offsetMs, seekSignal);
          // Guard: if seekGeneration was incremented by a subsequent seek
          // during the fetch, discard stale data to avoid emitting messages
          // from an outdated seek position.
          if (gen !== this.seekGeneration) return;
          this.flushReplayBuffer(offsetMs);
          if (seekSuccess) {
            this.startPrefetch();
          }
        } catch (error: unknown) {
          if (!isAbortError(error)) {
            log.debug('chat.replay.seek-fetch-failed', { error: String(error) });
          }
        }
      })();
    } else if (this.replayMode === 'continuation') {
      void (async () => {
        try {
          if (gen !== this.seekGeneration) return;
          const pollSuccess = await this.pollContinuationReplay(offsetMs, seekSignal);
          if (gen !== this.seekGeneration) return;
          if (pollSuccess) {
            this.startPrefetch();
          }
        } catch (error: unknown) {
          if (!isAbortError(error)) {
            log.debug('chat.replay.continuation-failed', { error: String(error) });
          }
        }
      })();
    }
  }

  // ── State management ────────────────────────────────────────────────────

  private resetReplayState(): void {
    // Invalidate every in-flight seek callback before aborting its request.
    // Abort is cooperative, so a promise may still settle after reset; the
    // generation guard must reject that late result even when the next
    // session starts with generation zero state.
    this.seekGeneration++;
    this.replayMode = null;
    this.replayPlayerSeekContinuation = null;
    this.replayContinuation = null;
    this.replayFallbackLastOffsetMs = -1;
    this.lastReplayRequestedOffsetMs = -REPLAY_FETCH_MIN_DELTA_MS;
    this.replayConsecutiveFailures = 0;
    this.replayTotalFailuresSinceSuccess = 0;
    this.replayNextAllowedFetchAt = 0;
    this.replayBuffer.clear();
    this.seekAbortController?.abort();
    this.seekAbortController = null;
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
        log.warn('chat.replay.no-seek-data');
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

      log.info('chat.replay.init-failed', { error: String(error) });
      return false;
    }
  }

  // ── API helpers ─────────────────────────────────────────────────────────

  private requestReplayPayload(
    continuation: InnertubeContinuationData,
    signal?: AbortSignal,
    playerOffsetMs?: number
  ): Promise<LiveChatPayload | null> {
    const timeoutSignal = AbortSignal.timeout(REPLAY_FETCH_TIMEOUT_MS);
    const mergedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    return this.requestPayload(fetchReplayChat, continuation, playerOffsetMs, mergedSignal).catch(
      (error: unknown) => {
        if (isAbortError(error) && timeoutSignal.aborted && !signal?.aborted) {
          log.warn('chat.replay.fetch-timeout', { timeoutMs: REPLAY_FETCH_TIMEOUT_MS });
        }
        throw error;
      }
    );
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
      this.replayTotalFailuresSinceSuccess = 0;
      this.replayNextAllowedFetchAt = 0;

      return nextPlayerSeekContinuation !== null || payload.actions.length > 0;
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw error;
      }

      log.debug('chat.replay.player-seek-failed', { error: String(error) });
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
      this.replayTotalFailuresSinceSuccess = 0;
      this.replayNextAllowedFetchAt = 0;

      return this.replayContinuation !== null || events.length > 0;
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw error;
      }

      log.debug('chat.replay.continuation-request-failed', { error: String(error) });
      this.recordReplayFailure();
      return false;
    }
  }

  private recordReplayFailure(): void {
    this.replayConsecutiveFailures += 1;
    this.replayTotalFailuresSinceSuccess += 1;
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

  private needsReplaySessionRecovery(): boolean {
    return this.replayTotalFailuresSinceSuccess >= REPLAY_TOTAL_FAILURE_LIMIT;
  }

  // ── Poll methods (fetch + backoff only — flush is handled by rAF) ───────

  private async pollPlayerSeekReplay(
    playback: PlaybackSnapshot,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (playback.paused || !this.shouldFetchReplayAtOffset(playback.offsetMs)) {
      return false;
    }

    const fetched = await this.fetchReplayPlayerSeek(playback.offsetMs, signal);
    // Flush is handled by the rAF loop — no explicit flush call here.

    if (fetched) {
      return true;
    }

    // Re-initialize only after persistent failures across multiple
    // backoff cycles (REPLAY_TOTAL_FAILURE_LIMIT). Transient errors
    // are handled by recordReplayFailure's consecutive-failure backoff.
    if (!this.needsReplaySessionRecovery()) {
      return false;
    }

    log.warn(
      `Replay fetch failed ${REPLAY_TOTAL_FAILURE_LIMIT} total times; ` +
        're-initializing replay session'
    );

    const bootstrap = await this.refreshBootstrap(signal, (candidate) => candidate.isReplay);
    if (!bootstrap) {
      return false;
    }
    return await this.initializeReplaySession(signal);
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
  ): Promise<boolean> {
    if (Date.now() < this.replayNextAllowedFetchAt) {
      return false;
    }

    const minimumOffsetMs = Math.max(0, currentOffsetMs - REPLAY_PREFETCH_WINDOW_MS);
    let batches = 0;
    let keepAheadFetched = false;

    // M4: Track last offset to detect stalled progress. If the offset doesn't
    // advance after a fetch, the remaining pages have no messages — stop early
    // instead of wastefully fetching up to replayBatchLimit empty pages.
    let lastOffsetBeforeLoop = this.replayFallbackLastOffsetMs;

    while (
      this.replayContinuation &&
      this.replayFallbackLastOffsetMs >= 0 &&
      this.replayFallbackLastOffsetMs < minimumOffsetMs &&
      batches < this.getSettings().replayBatchLimit
    ) {
      throwIfAborted(signal);

      const fetched = await this.fetchNextReplayFallbackBatch(minimumOffsetMs, signal);
      if (!fetched) {
        break;
      }

      // M4: If the offset didn't advance, no more messages are available ahead.
      if (this.replayFallbackLastOffsetMs <= lastOffsetBeforeLoop) {
        break;
      }
      lastOffsetBeforeLoop = this.replayFallbackLastOffsetMs;

      batches += 1;
    }

    if (
      this.replayContinuation &&
      this.replayNextAllowedFetchAt <= Date.now() &&
      this.replayFallbackLastOffsetMs < currentOffsetMs + REPLAY_PREFETCH_WINDOW_MS
    ) {
      keepAheadFetched = await this.fetchNextReplayFallbackBatch(minimumOffsetMs, signal);
    }

    // Flush is handled by the rAF loop — no explicit flush call here.
    return batches > 0 || keepAheadFetched;
  }
}
