// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * LiveChatSource — live polling loop with adaptive delay and density-aware seeding.
 *
 * Extracted from chat-source.ts to separate live and replay chat concerns.
 */

import type { ChatMessage } from '@app-types';
import {
  calculateAdaptiveDelay,
  DENSITY_WINDOW_SIZE,
  recordDensitySample,
} from '@chat/live-poll-math';
import { extractChatEvents } from '@chat/message-parser';
import type { ChatHealthSnapshot } from '@chat/source-base';
import { ChatSource } from '@chat/source-base';
import {
  fetchLiveChat,
  type LiveChatPayload,
  YoutubeInnertubeRequestError,
} from '@chat/youtube/api';
import {
  extractNextLiveContinuation,
  type InnertubeContinuationData,
} from '@chat/youtube/continuation';
import { isAbortError, sleep, throwIfAborted } from '@util/dom';
import { createLogger } from '@util/logging';

const log = createLogger('LiveChatSource');

// livePollFallbackMs — read from this.getSettings()
const LIVE_SEED_CUTOFF_MS = 60_000;
// livePollFailureLimit — read from this.getSettings()
/** Base interval for periodic bootstrap refresh during sustained errors. */
const LIVE_BOOTSTRAP_REFRESH_BASE = 5;
/** Maximum multiplier for bootstrap refresh interval. */
const LIVE_BOOTSTRAP_REFRESH_MAX = 50;

/** Maximum poll request timeout (ms) — prevents hung API calls from
 *  stalling the live-chat poll loop indefinitely. */
const LIVE_POLL_TIMEOUT_MS = 20_000;

export class LiveChatSource extends ChatSource {
  private liveContinuation: InnertubeContinuationData | null = null;
  protected consecutiveErrors = 0;
  /** Fixed-size circular buffer for moving-window density tracking. */
  private readonly densityRing = new Uint16Array(DENSITY_WINDOW_SIZE);
  private densityRingWrite = 0;
  private densityRingFilled = 0;

  protected seedCurrentSession(signal?: AbortSignal): Promise<boolean> {
    return this.initializeLiveSession(signal);
  }

  protected launchCurrentPollLoop(signal?: AbortSignal): void {
    this.launchPollLoop(signal, (loopSignal) => this.runLiveLoop(loopSignal));
  }

  /** Expose consecutive error count via health snapshot for status bar feedback. */
  override getHealthSnapshot(options?: { activeTimeoutMs?: number }): ChatHealthSnapshot {
    const base = super.getHealthSnapshot(options);
    return { ...base, consecutiveErrors: this.consecutiveErrors };
  }

  protected override resetSessionState(): void {
    super.resetSessionState();
    this.liveContinuation = null;
    this.consecutiveErrors = 0;
    this.densityRing.fill(0);
    this.densityRingWrite = 0;
    this.densityRingFilled = 0;
  }

  private async initializeLiveSession(signal?: AbortSignal): Promise<boolean> {
    if (!this.bootstrap) {
      return false;
    }

    try {
      const payload = await this.requestLivePayload(this.bootstrap.initialContinuation, signal);
      if (!payload) {
        return false;
      }

      await this.handleLivePayload(payload, true, signal); // isInitialSeed: apply time-based filtering
      return true;
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw error;
      }

      log.warn('chat.live.init-failed', { error: String(error) });
      return false;
    }
  }

  private recordMessageCount(count: number): void {
    const next = recordDensitySample(
      this.densityRing,
      this.densityRingWrite,
      this.densityRingFilled,
      count
    );
    this.densityRingWrite = next.write;
    this.densityRingFilled = next.filled;
  }

  private getLimits(): { minPollIntervalMs: number; maxPollIntervalMs: number } {
    const s = this.getSettings();
    return { minPollIntervalMs: s.minPollIntervalMs, maxPollIntervalMs: s.maxPollIntervalMs };
  }

  private calculateAdaptiveDelay(timeoutMs: number): number {
    const settings = this.getSettings();
    return calculateAdaptiveDelay(
      timeoutMs,
      settings.livePollFallbackMs,
      this.consecutiveErrors,
      this.burstRateProvider?.(),
      this.densityRing,
      this.densityRingFilled,
      this.getLimits()
    );
  }

  private async runLiveLoop(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      throwIfAborted(signal);

      await this.waitWhilePaused(signal);

      const playback = this.getPlaybackSnapshot();
      if (playback?.paused) {
        await this.pollWhilePaused(this.getSettings().livePollFallbackMs, 250, signal);
        continue;
      }

      const timeoutMs = this.liveContinuation?.timeoutMs ?? this.getSettings().livePollFallbackMs;
      const delayMs = this.calculateAdaptiveDelay(timeoutMs);

      // Extreme density: skip sleep entirely (chained polling).
      // When delayMs is 0, the next fetch fires immediately after the
      // previous response is processed, achieving sub-200ms effective
      // poll intervals during high-activity bursts.
      if (delayMs > 0) {
        await sleep(delayMs, signal);
      }

      throwIfAborted(signal);

      // Re-check pause state after sleep — the tab may have been hidden
      // during the delay. Without this guard, the next fetch+emitBatch
      // would deliver messages while the renderer is paused.
      await this.waitWhilePaused(signal);

      const continuation = this.liveContinuation;
      if (!continuation) {
        await this.refreshLiveContinuation(signal);
        continue;
      }

      try {
        const payload = await this.requestLivePayload(continuation, signal);
        if (!payload) {
          await this.refreshLiveContinuation(signal);
          continue;
        }

        await this.handleLivePayload(payload, false, signal);
      } catch (error: unknown) {
        if (isAbortError(error)) {
          throw error;
        }

        this.consecutiveErrors += 1;

        // ── Circuit breaker: stop the poll loop after consecutive failures ──
        // The watchdog (RuntimeManager) will detect the stopped loop via
        // observerAlive/recentlyActive and trigger a managed restart.
        if (this.consecutiveErrors >= this.getSettings().livePollFailureLimit) {
          log.error(
            `Live poll failed ${this.consecutiveErrors} times consecutively; ` +
              'circuit breaker tripped — stopping poll loop for watchdog restart'
          );
          throw new Error(
            `Live poll consecutive failure limit (${this.getSettings().livePollFailureLimit}) reached`
          );
        }

        // ── Error type discrimination with structured diagnostics ──
        if (error instanceof YoutubeInnertubeRequestError) {
          log.warn('Live poll request failed:', {
            status: error.status,
            message: error.message,
          });
        } else if (error instanceof TypeError) {
          // Network-level failure (fetch() throws TypeError in browsers)
          log.warn('Live poll network error:', {
            name: error.name,
            message: error.message,
          });
        } else if (error instanceof SyntaxError) {
          // JSON parse failure — API response format may have changed
          log.warn('Live poll JSON parse error (possible API change):', {
            name: error.name,
            message: error.message,
          });
        } else {
          // Catch-all for unexpected error types
          const errName = error instanceof Error ? error.name : typeof error;
          const errMsg = error instanceof Error ? error.message : String(error);
          log.warn('Live poll request failed:', {
            name: errName,
            message: errMsg,
          });
        }

        // ── Conditional bootstrap refresh ──
        // Only refresh bootstrap on parse errors (API format changed)
        // or periodically with exponential backoff during sustained outages.
        // Network errors (TypeError) should NOT trigger bootstrap refresh —
        // just wait and retry; the network may recover on its own.
        const isParseError = error instanceof SyntaxError;
        const refreshInterval = Math.min(
          LIVE_BOOTSTRAP_REFRESH_MAX,
          LIVE_BOOTSTRAP_REFRESH_BASE *
            2 ** Math.floor((this.consecutiveErrors - 1) / LIVE_BOOTSTRAP_REFRESH_BASE)
        );
        const needsPeriodicRefresh =
          this.consecutiveErrors > 0 && this.consecutiveErrors % refreshInterval === 0;

        const isNetworkError = error instanceof TypeError;
        if (isParseError || (needsPeriodicRefresh && !isNetworkError)) {
          await this.refreshLiveContinuation(signal);
        }
      }
    }
  }

  private async requestLivePayload(
    continuation: InnertubeContinuationData,
    signal?: AbortSignal
  ): Promise<LiveChatPayload | null> {
    // Wrap with a 20 s timeout so hung Innertube API calls don't stall the
    // poll loop indefinitely. Merge with the caller's abort signal so either
    // timeout or external abort (dispose, restart) cancels the request.
    const timeoutSignal = AbortSignal.timeout(LIVE_POLL_TIMEOUT_MS);
    const mergedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    try {
      return await this.requestPayload(fetchLiveChat, continuation, mergedSignal);
    } catch (error: unknown) {
      if (isAbortError(error) && timeoutSignal.aborted && !signal?.aborted) {
        log.warn('chat.live.poll-timeout', { timeoutMs: LIVE_POLL_TIMEOUT_MS });
      }
      throw error;
    }
  }

  private async handleLivePayload(
    payload: LiveChatPayload,
    isInitialSeed: boolean = false,
    signal?: AbortSignal
  ): Promise<void> {
    const events = extractChatEvents(
      payload.actions,
      this.getSettings,
      undefined,
      this.isKnownReplacementTarget
    );

    if (events.length > 0) {
      let messages: ChatMessage[];

      if (isInitialSeed) {
        const playback = this.getPlaybackSnapshot();
        const offsetMs = playback?.offsetMs ?? 0;
        const cutoffMs = Math.max(0, offsetMs - LIVE_SEED_CUTOFF_MS);

        const filtered = events.filter((e) => {
          if (e.message.kind === 'superchat' || e.message.kind === 'membership') return true;
          if (e.offsetMs === undefined) return true;
          if (e.offsetMs < cutoffMs) return false;
          return e.offsetMs <= offsetMs + LIVE_SEED_CUTOFF_MS;
        });

        messages = filtered.map((e) => e.message);

        if (filtered.length < events.length) {
          log.debug(
            `Initial seed filtered: ${events.length} → ${filtered.length} (playback at ${Math.round(offsetMs / 1000)}s)`
          );
        }
      } else {
        messages = events.map((e) => e.message);
      }

      if (messages.length > 0) {
        this.emitBatch(messages, isInitialSeed);
        this.recordMessageCount(messages.length);
      }
    }

    this.consecutiveErrors = 0;
    const nextContinuation = extractNextLiveContinuation(payload.continuations);
    if (!nextContinuation) {
      // Continuation token missing — API format may have changed.
      // Refresh bootstrap immediately instead of waiting for the next poll to fail.
      log.warn('chat.live.missing-continuation');
      await this.refreshLiveContinuation(signal);
      // refreshLiveContinuation updates this.liveContinuation internally
    } else {
      this.liveContinuation = nextContinuation;
    }
  }

  private async refreshLiveContinuation(signal?: AbortSignal): Promise<void> {
    const bootstrap = await this.refreshBootstrap(signal);
    if (bootstrap) {
      this.liveContinuation = bootstrap.initialContinuation ?? null;
    }
  }
}
