// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * LiveChatSource — live polling loop with adaptive delay and density-aware seeding.
 *
 * Extracted from chat-source.ts to separate live and replay chat concerns.
 */

import type { ChatMessage } from '@app-types';
import { extractChatEvents } from '@core/chat-message-parser';
import type { ChatHealthSnapshot } from '@core/chat-source-base';
import { ChatSource } from '@core/chat-source-base';
import {
  fetchLiveChat,
  type LiveChatPayload,
  YoutubeInnertubeRequestError,
} from '@core/youtubei-chat';
import {
  extractNextLiveContinuation,
  type InnertubeContinuationData,
} from '@core/youtubei-continuation';
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

export class LiveChatSource extends ChatSource {
  private liveContinuation: InnertubeContinuationData | null = null;
  protected consecutiveErrors = 0;
  private static readonly DENSITY_WINDOW_SIZE = 5;
  /** Fixed-size circular buffer for moving-window density tracking. */
  private readonly densityRing = new Uint16Array(5);
  private densityRingWrite = 0;
  private densityRingFilled = 0;
  private static readonly DENSITY_HIGH_THRESHOLD = 10;
  private static readonly DENSITY_LOW_THRESHOLD = 1;
  /** When avg messages per poll exceeds this, skip sleep entirely (chained polling). */
  private static readonly EXTREME_DENSITY_THRESHOLD = 30;

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

      await this.handleLivePayload(payload, true); // isInitialSeed: apply time-based filtering
      return true;
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw error;
      }

      log.warn('Failed to initialize live chat session:', error);
      return false;
    }
  }

  private recordMessageCount(count: number): void {
    this.densityRing[this.densityRingWrite] = count;
    this.densityRingWrite = (this.densityRingWrite + 1) % LiveChatSource.DENSITY_WINDOW_SIZE;
    if (this.densityRingFilled < LiveChatSource.DENSITY_WINDOW_SIZE) {
      this.densityRingFilled++;
    }
  }

  /**
   * Exponential backoff when consecutive errors have occurred.
   * Returns `null` if no errors are active.
   */
  private computeErrorBackoffMs(fallbackMs: number): number | null {
    if (this.consecutiveErrors === 0) return null;

    const settings = this.getSettings();
    const delayed = fallbackMs * 2 ** this.consecutiveErrors;
    return Math.min(settings.maxPollIntervalMs, Math.max(settings.minPollIntervalMs, delayed));
  }

  /**
   * Sub-poll-interval burst reactivity via EMA rate.
   * Returns `null` if the EMA provider is not wired or the rate is below any threshold.
   */
  private computeBurstAdjustedMs(fallbackMs: number): number | null {
    const emaRate = this.burstRateProvider?.();
    if (emaRate === undefined) return null;

    const settings = this.getSettings();
    if (emaRate >= LiveChatSource.EXTREME_DENSITY_THRESHOLD) return 0;
    if (emaRate >= LiveChatSource.DENSITY_HIGH_THRESHOLD) {
      return Math.max(
        settings.minPollIntervalMs,
        Math.round(Math.min(settings.maxPollIntervalMs, fallbackMs) * 0.3)
      );
    }
    return null;
  }

  /**
   * Moving-window density adaptation using circular buffer.
   */
  private computeDensityAdjustedMs(fallbackMs: number): number {
    const settings = this.getSettings();

    if (this.densityRingFilled < 2) {
      // Not enough data points — return clamped fallback as-is.
      return Math.max(settings.minPollIntervalMs, Math.min(settings.maxPollIntervalMs, fallbackMs));
    }

    // Iterate only filled elements — no Array.reduce required
    let sum = 0;
    for (let i = 0; i < this.densityRingFilled; i++) {
      sum += this.densityRing[i]!;
    }
    const avgCount = sum / this.densityRingFilled;

    // Extreme density: skip sleep entirely (chained polling).
    if (avgCount >= LiveChatSource.EXTREME_DENSITY_THRESHOLD) return 0;

    // Base adaptive delay within bounds
    let base = Math.max(
      settings.minPollIntervalMs,
      Math.min(settings.maxPollIntervalMs, fallbackMs)
    );

    if (avgCount >= LiveChatSource.DENSITY_HIGH_THRESHOLD) {
      base = Math.max(settings.minPollIntervalMs, Math.round(base * 0.3));
    }
    if (avgCount <= LiveChatSource.DENSITY_LOW_THRESHOLD) {
      base = Math.min(settings.maxPollIntervalMs, Math.round(base * 1.2));
    }

    return Math.max(settings.minPollIntervalMs, Math.min(settings.maxPollIntervalMs, base));
  }

  private calculateAdaptiveDelay(timeoutMs: number): number {
    const settings = this.getSettings();
    const fallback = timeoutMs > 0 ? timeoutMs : settings.livePollFallbackMs;

    // 1. Error exponential backoff — takes priority when recovering
    const errorBackoff = this.computeErrorBackoffMs(fallback);
    if (errorBackoff !== null) return errorBackoff;

    // 2. Burst detection via EMA rate — sub-poll-interval reactivity
    const burstAdjusted = this.computeBurstAdjustedMs(fallback);
    if (burstAdjusted !== null) return burstAdjusted;

    // 3. Moving-window density adaptation — full history consideration
    return this.computeDensityAdjustedMs(fallback);
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

        await this.handleLivePayload(payload);
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

  private requestLivePayload(
    continuation: InnertubeContinuationData,
    signal?: AbortSignal
  ): Promise<LiveChatPayload | null> {
    return this.requestPayload(fetchLiveChat, continuation, signal);
  }

  private async handleLivePayload(
    payload: LiveChatPayload,
    isInitialSeed: boolean = false
  ): Promise<void> {
    const events = extractChatEvents(payload.actions, this.getSettings);

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
      log.warn('Live continuation token missing from payload — refreshing bootstrap');
      await this.refreshLiveContinuation();
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
