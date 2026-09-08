// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * ReplayChatSource — replay chat source with independent display and I/O timing.
 *
 * Separated from chat-source.ts. A short setTimeout display loop synchronizes
 * buffered emission with video playback without awaiting the independently
 * scheduled, single-concurrency replay request loop.
 */

import type { ChatMessage } from '@app-types';
import { type ChatEvent, extractChatEvents } from '@chat/message-parser';
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
const REPLAY_PREFETCH_TARGET_HORIZON_MS = 30_000;
const REPLAY_PREFETCH_RESUME_HORIZON_MS = 12_000;
// Stop one maximum-sized extracted page before ReplayBuffer's 3,000-message
// hard limit. A larger-than-budget byte page is still trimmed at the buffer's
// far-future edge because the endpoint does not expose byte-sized pagination.
const REPLAY_PREFETCH_MAX_MESSAGES = 2000;
const REPLAY_PREFETCH_RESUME_MESSAGES = 1000;
const REPLAY_PREFETCH_MAX_BYTES = 6 * 1024 * 1024;
const REPLAY_PREFETCH_RESUME_BYTES = 3 * 1024 * 1024;
/** Maximum replay request duration before the cooperative loop can recover. */
const REPLAY_FETCH_TIMEOUT_MS = 20_000;
// replayPrefetchPages — read from this.getSettings()

type ReplayMode = 'playerSeek' | 'continuation';

export class ReplayChatSource extends ChatSource {
  // replayBatchLimit — read from this.getSettings()

  /** Notifies the runtime that all display state belongs to an old timeline. */
  onSeek?: () => void;

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
  private seekVideo: HTMLVideoElement | null = null;
  private seekSignal: AbortSignal | null = null;
  private seekListenerRebindAt = 0;
  private seekAbortController: AbortController | null = null;
  private seekGeneration = 0;
  private cooperativeLoopTimer: ReturnType<typeof setTimeout> | null = null;
  private displayLoopTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeDisplayLoop: (() => void) | null = null;
  private cooperativeLoopRunning = false;
  private cooperativeLoopGeneration = 0;
  private replayRequestQueue: Promise<void> | null = null;
  private activeReplayRequestController: AbortController | null = null;
  private prefetchContinuation: InnertubeContinuationData | null = null;
  private prefetchPagesFetched = 0;
  private prefetchMode: ReplayMode | null = null;
  private prefetchBackoffUntil = 0;
  private prefetchNextAllowedAt = 0;
  private prefetchGeneration = 0;
  private prefetchBudgetSuspended = false;
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

  // ── Independent display and network schedulers ──────────────────────────

  /**
   * Start independent display and network schedulers. Display timing never
   * awaits replay I/O, while the network scheduler starts at most one cycle at
   * a time and requestReplayPayload serializes seek and background requests.
   */
  private startCooperativeLoop(signal?: AbortSignal): void {
    this.stopCooperativeLoop();

    // Prefetch not seeded yet — seeded after the first successful main poll
    // so prefetchContinuation starts from the NEXT page, not the current one.
    this.stopPrefetch();

    this.cooperativeLoopRunning = true;
    const gen = ++this.cooperativeLoopGeneration;

    const displayTick = (): void => {
      if (signal?.aborted || gen !== this.cooperativeLoopGeneration) {
        this.displayLoopTimer = null;
        return;
      }

      if (this.isPaused) {
        this.markActivity();
      }

      const playback = this.getPlaybackSnapshot();
      const isPlaying = playback && !playback.paused;
      if (!this.isPaused && isPlaying) {
        this.markActivity();
        this.flushReplayBuffer(playback.offsetMs);
      }

      const hasPendingFlushes = !this.replayBuffer.isEmpty;
      const videoPaused = playback?.paused ?? true;
      const adaptiveDelay =
        hasPendingFlushes && !this.isPaused && !videoPaused ? 16 : BACKGROUND_FETCH_INTERVAL_MS;

      if (!signal?.aborted && gen === this.cooperativeLoopGeneration) {
        this.displayLoopTimer = setTimeout(displayTick, adaptiveDelay);
      }
    };

    this.wakeDisplayLoop = () => {
      if (signal?.aborted || gen !== this.cooperativeLoopGeneration) return;
      this.displayLoopTimer = clearSafeTimeout(this.displayLoopTimer);
      this.displayLoopTimer = setTimeout(displayTick, 0);
    };

    const networkTick = async (): Promise<void> => {
      if (signal?.aborted || gen !== this.cooperativeLoopGeneration) {
        this.cooperativeLoopRunning = false;
        this.cooperativeLoopTimer = null;
        return;
      }

      if (Date.now() >= this.seekListenerRebindAt) {
        this.installSeekListeners(signal);
      }

      try {
        await this.runNetworkCycle(gen, signal);
      } catch (error: unknown) {
        if (!isAbortError(error)) {
          log.debug('chat.replay.fetch-failed', { error: String(error) });
        }
      }

      if (!signal?.aborted && gen === this.cooperativeLoopGeneration) {
        const playback = this.getPlaybackSnapshot();
        const delay = this.canFetchForPlayback(playback)
          ? this.isVisibilityOnlyPause()
            ? BACKGROUND_FETCH_INTERVAL_MS
            : REPLAY_PREFETCH_MIN_INTERVAL_MS
          : BACKGROUND_FETCH_INTERVAL_MS;
        this.cooperativeLoopTimer = setTimeout(networkTick, delay);
      }
    };

    this.displayLoopTimer = setTimeout(displayTick, 0);
    this.cooperativeLoopTimer = setTimeout(networkTick, 0);
  }

  private async runNetworkCycle(gen: number, signal?: AbortSignal): Promise<void> {
    const playback = this.getPlaybackSnapshot();
    if (!this.canFetchForPlayback(playback) || !this.hasReplayFetchDemand(signal, playback)) {
      return;
    }

    let mainPollSucceeded = false;
    if (this.replayMode === 'playerSeek') {
      mainPollSucceeded = await this.pollPlayerSeekReplay(playback, signal);
    } else if (this.replayMode === 'continuation') {
      mainPollSucceeded = await this.pollContinuationReplay(playback.offsetMs, signal);
    }

    if (signal?.aborted || gen !== this.cooperativeLoopGeneration) return;

    // A pause or large playback jump may occur while the request is in flight.
    // Re-read playback and resource demand before starting another request.
    const currentPlayback = this.getPlaybackSnapshot();
    if (
      !this.canFetchForPlayback(currentPlayback) ||
      !this.hasReplayFetchDemand(signal, currentPlayback)
    ) {
      return;
    }

    if (mainPollSucceeded) {
      if (!this.prefetchMode && this.replayMode === 'playerSeek') {
        this.startPrefetch();
      }
      return;
    }

    const prefetchContinuation = this.prefetchContinuation;
    if (!prefetchContinuation || !this.shouldPrefetch(Date.now(), signal, currentPlayback)) return;

    const prefetchGeneration = this.prefetchGeneration;
    this.prefetchNextAllowedAt = Date.now() + REPLAY_PREFETCH_MIN_INTERVAL_MS;
    try {
      const payload = await this.requestReplayPayload(prefetchContinuation, signal);
      if (signal?.aborted || gen !== this.cooperativeLoopGeneration) return;
      if (!this.isPrefetchGenerationCurrent(prefetchGeneration)) return;
      if (!payload) {
        this.prefetchContinuation = null;
        return;
      }

      const latestPlayback = this.getPlaybackSnapshot();
      const minimumOffsetMs = Math.max(
        0,
        (latestPlayback?.offsetMs ?? currentPlayback.offsetMs) - REPLAY_PREFETCH_WINDOW_MS
      );
      const events = extractChatEvents(
        payload.actions,
        this.getSettings,
        undefined,
        this.isKnownReplacementTarget
      );
      this.appendReplayEvents(events, minimumOffsetMs);
      this.markActivity();
      this.prefetchContinuation = extractPlayerSeekContinuation(payload.continuations);
      this.prefetchPagesFetched += 1;
    } catch (error: unknown) {
      if (!this.isPrefetchGenerationCurrent(prefetchGeneration)) return;
      if (isAbortError(error)) {
        this.prefetchContinuation = null;
      } else {
        log.debug('chat.replay.prefetch-failed', { error: String(error) });
        this.prefetchBackoffUntil = Date.now() + REPLAY_FAILURE_BACKOFF_MS;
      }
    }
  }

  private canFetchForPlayback(playback: PlaybackSnapshot | null): playback is PlaybackSnapshot {
    return Boolean(
      playback && !playback.paused && (!this.isPaused || this.isVisibilityOnlyPause())
    );
  }

  private shouldPrefetch(
    now: number,
    signal?: AbortSignal,
    playback = this.getPlaybackSnapshot()
  ): boolean {
    if (!this.prefetchContinuation) return false;
    if (
      !this.hasReplayFetchDemand(signal, playback) ||
      this.prefetchPagesFetched >= this.getSettings().replayPrefetchPages ||
      now < this.prefetchBackoffUntil ||
      now < this.prefetchNextAllowedAt
    ) {
      return false;
    }

    return true;
  }

  private hasReplayFetchDemand(
    signal?: AbortSignal,
    playback = this.getPlaybackSnapshot()
  ): boolean {
    if (signal?.aborted || playback?.paused || (this.isPaused && !this.isVisibilityOnlyPause())) {
      return false;
    }

    const horizonMs = playback ? this.replayBuffer.aheadHorizonMs(playback.offsetMs) : 0;
    const atHighWater =
      horizonMs >= REPLAY_PREFETCH_TARGET_HORIZON_MS ||
      this.replayBuffer.messageCount >= REPLAY_PREFETCH_MAX_MESSAGES ||
      this.replayBuffer.estimatedByteSize >= REPLAY_PREFETCH_MAX_BYTES;
    if (atHighWater) {
      this.prefetchBudgetSuspended = true;
      return false;
    }

    if (this.prefetchBudgetSuspended) {
      const belowResumeWater =
        horizonMs <= REPLAY_PREFETCH_RESUME_HORIZON_MS &&
        this.replayBuffer.messageCount <= REPLAY_PREFETCH_RESUME_MESSAGES &&
        this.replayBuffer.estimatedByteSize <= REPLAY_PREFETCH_RESUME_BYTES;
      if (!belowResumeWater) return false;
      this.prefetchBudgetSuspended = false;
    }

    return true;
  }

  private isPrefetchGenerationCurrent(generation: number): boolean {
    return generation === this.prefetchGeneration;
  }

  private stopCooperativeLoop(): void {
    this.cooperativeLoopGeneration++;
    this.cooperativeLoopTimer = clearSafeTimeout(this.cooperativeLoopTimer);
    this.displayLoopTimer = clearSafeTimeout(this.displayLoopTimer);
    this.wakeDisplayLoop = null;
    this.cooperativeLoopRunning = false;
    this.clearSeekListener();
  }

  /** Release the listener closure and session signal after detaching. */
  private clearSeekListener(): void {
    const cleanup = this.seekListenerCleanup;
    this.seekListenerCleanup = null;
    this.seekVideo = null;
    this.seekSignal = null;
    this.seekListenerRebindAt = 0;
    cleanup?.();
  }

  /** Reset prefetch state — cooperative loop will skip the prefetch step. */
  private stopPrefetch(): void {
    this.prefetchGeneration++;
    this.prefetchContinuation = null;
    this.prefetchPagesFetched = 0;
    this.prefetchMode = null;
    this.prefetchBackoffUntil = 0;
    this.prefetchNextAllowedAt = 0;
    this.prefetchBudgetSuspended = false;
  }

  /**
   * Initialize prefetch state from current shared continuations.
   * The cooperative loop picks this up on its next tick.
   */
  private startPrefetch(): void {
    this.stopPrefetch();
    if (this.replayMode !== 'playerSeek') return;

    this.prefetchContinuation = this.replayPlayerSeekContinuation;
    this.prefetchPagesFetched = 0;
    this.prefetchMode = this.replayMode;
    this.prefetchBackoffUntil = 0;
  }

  // ── Seek listeners ──────────────────────────────────────────────────────

  private installSeekListeners(signal?: AbortSignal): void {
    const el = findElementMatch<HTMLVideoElement>(VIDEO_SELECTORS);
    const video = el?.element ?? null;
    this.seekListenerRebindAt = Date.now() + BACKGROUND_FETCH_INTERVAL_MS;
    if (video && video === this.seekVideo && this.seekListenerCleanup) return;

    this.clearSeekListener();
    this.seekListenerRebindAt = Date.now() + BACKGROUND_FETCH_INTERVAL_MS;
    if (!video) return;
    this.seekSignal = signal ?? null;
    this.seekVideo = video;
    const onSeeked = (): void => {
      if (signal?.aborted) return;
      const offsetMs = Math.max(0, Math.floor(video.currentTime * 1000));
      this.handleSeeked(offsetMs);
    };
    video.addEventListener('seeked', onSeeked);
    this.seekListenerCleanup = () => {
      video.removeEventListener('seeked', onSeeked);
    };
  }

  private handleSeeked(offsetMs: number): void {
    // If the session was already stopped, callback is null and all downstream
    // operations (flushReplayBuffer, startPrefetch, pollContinuationReplay)
    // will no-op. Bail out early to avoid unnecessary async work.
    if (!this.callback) return;

    // Increment seek generation — cancels any in-flight seek from a prior seek.
    const gen = ++this.seekGeneration;

    // End stale background I/O before queueing the seek request. The request
    // queue still guarantees one active network operation at a time, while a
    // normal fetch abort settles promptly instead of delaying seek recovery
    // until the request timeout.
    this.activeReplayRequestController?.abort();

    // Abort the previous seek's in-flight fetch (if any), then create a fresh
    // AbortController for this seek.  Compose with the session-level signal
    // so the fetch is also cancelled on session stop.
    this.seekAbortController?.abort();
    this.seekAbortController = new AbortController();
    const seekSignal = this.seekSignal
      ? AbortSignal.any([this.seekAbortController.signal, this.seekSignal])
      : this.seekAbortController.signal;

    this.replayBuffer.clear();
    this.resetMessageDeliveryState();
    this.lastReplayRequestedOffsetMs = offsetMs;
    this.replayConsecutiveFailures = 0;
    this.replayTotalFailuresSinceSuccess = 0;

    // Cancel in-flight prefetch — new one starts from seek position below.
    this.stopPrefetch();
    this.onSeek?.();

    if (this.replayMode === 'playerSeek' && this.replayPlayerSeekContinuation) {
      void (async () => {
        try {
          if (gen !== this.seekGeneration) return;
          const seekSuccess = await this.fetchReplayPlayerSeek(offsetMs, seekSignal, gen);
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
          await this.pollContinuationReplay(offsetMs, seekSignal, gen);
          if (gen !== this.seekGeneration) return;
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
    this.activeReplayRequestController?.abort();
    this.activeReplayRequestController = null;
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
    const generation = this.seekGeneration;

    try {
      const initialPayload = await this.requestReplayPayload(
        this.bootstrap.initialContinuation,
        signal
      );
      if (generation !== this.seekGeneration) {
        return false;
      }
      if (!initialPayload) {
        return false;
      }

      const playerSeekContinuation = extractPlayerSeekContinuation(initialPayload.continuations);
      if (playerSeekContinuation) {
        this.replayMode = 'playerSeek';
        this.replayPlayerSeekContinuation = playerSeekContinuation;

        const currentOffsetMs = this.getPlaybackSnapshot()?.offsetMs ?? 0;
        const seeded = await this.fetchReplayPlayerSeek(currentOffsetMs, signal, generation);
        if (generation !== this.seekGeneration) {
          return false;
        }
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
      this.replayFallbackLastOffsetMs = this.appendReplayEvents(
        extractChatEvents(
          initialPayload.actions,
          this.getSettings,
          undefined,
          this.isKnownReplacementTarget
        ),
        minimumOffsetMs
      );
      let batchesFetched = 0;
      while (
        this.replayContinuation &&
        this.replayFallbackLastOffsetMs < minimumOffsetMs &&
        batchesFetched < this.getSettings().replayBatchLimit &&
        this.hasReplayFetchDemand(signal, {
          offsetMs: currentOffsetMs,
          paused: false,
        })
      ) {
        throwIfAborted(signal);
        const fetched = await this.fetchNextReplayFallbackBatch(
          minimumOffsetMs,
          signal,
          generation
        );
        if (generation !== this.seekGeneration) {
          return false;
        }
        if (!fetched) break;
        batchesFetched += 1;
      }
      this.flushReplayBuffer(currentOffsetMs);
      return true;
    } catch (error: unknown) {
      if (generation !== this.seekGeneration) {
        return false;
      }
      if (isAbortError(error)) {
        throw error;
      }

      log.info('chat.replay.init-failed', { error: String(error) });
      return false;
    }
  }

  // ── API helpers ─────────────────────────────────────────────────────────

  private async requestReplayPayload(
    continuation: InnertubeContinuationData,
    signal?: AbortSignal,
    playerOffsetMs?: number
  ): Promise<LiveChatPayload | null> {
    const previousRequest = this.replayRequestQueue;
    let releaseRequest!: () => void;
    const currentRequest = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    this.replayRequestQueue = previousRequest
      ? previousRequest.then(
          () => currentRequest,
          () => currentRequest
        )
      : currentRequest;

    try {
      if (previousRequest) {
        await previousRequest.catch(() => {});
      }
      throwIfAborted(signal);

      const timeoutSignal = AbortSignal.timeout(REPLAY_FETCH_TIMEOUT_MS);
      const requestController = new AbortController();
      this.activeReplayRequestController = requestController;
      const mergedSignal = AbortSignal.any(
        signal
          ? [signal, timeoutSignal, requestController.signal]
          : [timeoutSignal, requestController.signal]
      );
      try {
        return await this.requestPayload(
          fetchReplayChat,
          continuation,
          playerOffsetMs,
          mergedSignal
        );
      } catch (error: unknown) {
        if (isAbortError(error) && timeoutSignal.aborted && !signal?.aborted) {
          log.warn('chat.replay.fetch-timeout', { timeoutMs: REPLAY_FETCH_TIMEOUT_MS });
        }
        throw error;
      } finally {
        if (this.activeReplayRequestController === requestController) {
          this.activeReplayRequestController = null;
        }
      }
    } finally {
      releaseRequest();
    }
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

  private appendReplayEvents(events: ChatEvent[], minimumOffsetMs: number): number {
    const highestOffsetMs = this.replayBuffer.appendEvents(events, minimumOffsetMs);
    if (!this.replayBuffer.isEmpty) {
      this.wakeDisplayLoop?.();
    }
    return highestOffsetMs;
  }

  // ── Fetch methods ───────────────────────────────────────────────────────

  private async fetchReplayPlayerSeek(
    offsetMs: number,
    signal?: AbortSignal,
    generation = this.seekGeneration
  ): Promise<boolean> {
    const continuation = this.replayPlayerSeekContinuation;
    if (!continuation) {
      return false;
    }

    try {
      const payload = await this.requestReplayPayload(continuation, signal, offsetMs);
      if (generation !== this.seekGeneration) return false;
      if (!payload) {
        this.recordReplayFailure();
        return false;
      }

      const nextPlayerSeekContinuation = extractPlayerSeekContinuation(payload.continuations);
      this.appendReplayEvents(
        extractChatEvents(
          payload.actions,
          this.getSettings,
          undefined,
          this.isKnownReplacementTarget
        ),
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
      if (generation !== this.seekGeneration) return false;

      log.debug('chat.replay.player-seek-failed', { error: String(error) });
      this.recordReplayFailure();
      return false;
    }
  }

  private async fetchNextReplayFallbackBatch(
    minimumOffsetMs: number,
    signal?: AbortSignal,
    generation = this.seekGeneration
  ): Promise<boolean> {
    const continuation = this.replayContinuation;
    if (!continuation) {
      return false;
    }

    try {
      const payload = await this.requestReplayPayload(continuation, signal);
      if (generation !== this.seekGeneration || this.replayContinuation !== continuation) {
        return false;
      }
      if (!payload) {
        this.recordReplayFailure();
        return false;
      }

      const events = extractChatEvents(
        payload.actions,
        this.getSettings,
        undefined,
        this.isKnownReplacementTarget
      );
      this.replayFallbackLastOffsetMs = this.appendReplayEvents(events, minimumOffsetMs);
      this.replayContinuation = extractReplayContinuation(payload.continuations);
      this.replayConsecutiveFailures = 0;
      this.replayTotalFailuresSinceSuccess = 0;
      this.replayNextAllowedFetchAt = 0;

      return this.replayContinuation !== null || events.length > 0;
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw error;
      }
      if (generation !== this.seekGeneration || this.replayContinuation !== continuation) {
        return false;
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
    if (
      playback.paused ||
      Date.now() < this.replayNextAllowedFetchAt ||
      !this.shouldFetchReplayAtOffset(playback.offsetMs)
    ) {
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
    const initialized = await this.initializeReplaySession(signal);
    if (initialized) {
      this.startCooperativeLoop(signal);
      this.installSeekListeners(signal);
    }
    return initialized;
  }

  private shouldFetchReplayAtOffset(currentOffsetMs: number): boolean {
    if (this.replayMode !== 'playerSeek' || !this.replayPlayerSeekContinuation) {
      return false;
    }

    return currentOffsetMs - this.lastReplayRequestedOffsetMs >= REPLAY_FETCH_MIN_DELTA_MS;
  }

  private async pollContinuationReplay(
    currentOffsetMs: number,
    signal?: AbortSignal,
    generation = this.seekGeneration
  ): Promise<boolean> {
    if (Date.now() < this.replayNextAllowedFetchAt) {
      return false;
    }

    if (!this.replayContinuation) return false;

    // Fetch one sequential continuation page per network cycle. This keeps a
    // slow or empty continuation chain from monopolizing the scheduler, and
    // lets every subsequent cycle re-check pause and buffer demand.
    const minimumOffsetMs = Math.max(0, currentOffsetMs - REPLAY_PREFETCH_WINDOW_MS);
    throwIfAborted(signal);
    return this.fetchNextReplayFallbackBatch(minimumOffsetMs, signal, generation);
  }
}
