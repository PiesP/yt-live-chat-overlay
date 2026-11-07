// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * LiveChatDriver owns live continuation, failure recovery and adaptive polling.
 * LiveChatSource is the runtime port backed by a composed ChatSession.
 */

import type { ChatMessage, OverlaySettings } from '@app-types';
import {
  calculateAdaptiveDelay,
  DENSITY_WINDOW_SIZE,
  recordDensitySample,
} from '@chat/live-poll-math';
import { extractChatEvents } from '@chat/message-parser';
import {
  ChatSession,
  type LiveChatSessionOperations,
  type PollingChatSessionDriver,
  type ChatHealthSnapshot,
  type ChatSourceStartStatus,
  LiveChatProtocolError,
} from '@chat/source-base';
import type { LiveChatPort } from '@chat/source-contracts';
import type { ChatBootstrapData } from '@chat/youtube/api';
import {
  fetchLiveChat,
  type LiveChatPayload,
  YoutubeInnertubeRequestError,
} from '@chat/youtube/api';
import {
  extractNextLiveContinuation,
  type InnertubeContinuationData,
} from '@chat/youtube/continuation';
import { sleep } from '@piesp/browser-core/async';
import { isAbortError, throwIfAborted } from '@piesp/browser-core/error';
import { createLogger } from '@util/logging';

const log = createLogger('LiveChatSource');

// livePollFallbackMs — read from this.session.getSettings()
const LIVE_SEED_CUTOFF_MS = 60_000;
// livePollFailureLimit — read from this.session.getSettings()
/** Base interval for periodic bootstrap refresh during sustained errors. */
const LIVE_BOOTSTRAP_REFRESH_BASE = 5;
/** Maximum multiplier for bootstrap refresh interval. */
const LIVE_BOOTSTRAP_REFRESH_MAX = 50;

/** Maximum poll request timeout (ms) — prevents hung API calls from
 *  stalling the live-chat poll loop indefinitely. */
const LIVE_POLL_TIMEOUT_MS = 20_000;

class LiveChatDriver implements PollingChatSessionDriver {
  readonly scheduling = 'poll-loop' as const;
  constructor(
    private readonly session: LiveChatSessionOperations,
    private readonly getBurstRate: () => number | undefined
  ) {}
  private liveContinuation: InnertubeContinuationData | null = null;
  private consecutiveErrors = 0;
  /** Fixed-size circular buffer for moving-window density tracking. */
  private readonly densityRing = new Uint16Array(DENSITY_WINDOW_SIZE);
  private densityRingWrite = 0;
  private densityRingFilled = 0;
  /** Whether the latest successful payload contained parsed chat events. */
  private lastSuccessfulPayloadHadEvents = false;

  seed(signal?: AbortSignal): Promise<boolean> {
    return this.initializeLiveSession(signal);
  }

  run(signal?: AbortSignal): Promise<void> {
    return this.runLiveLoop(signal);
  }

  getConsecutiveErrors(): number {
    return this.consecutiveErrors;
  }

  reset(): void {
    this.liveContinuation = null;
    this.consecutiveErrors = 0;
    this.densityRing.fill(0);
    this.densityRingWrite = 0;
    this.densityRingFilled = 0;
    this.lastSuccessfulPayloadHadEvents = false;
  }

  private async initializeLiveSession(signal?: AbortSignal): Promise<boolean> {
    const bootstrap = this.session.getBootstrap();
    if (!bootstrap) {
      return false;
    }

    try {
      const payload = await this.requestLivePayload(bootstrap.initialContinuation, signal);
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
    const s = this.session.getSettings();
    return { minPollIntervalMs: s.minPollIntervalMs, maxPollIntervalMs: s.maxPollIntervalMs };
  }

  private calculateAdaptiveDelay(timeoutMs: number): number {
    const settings = this.session.getSettings();
    const useActivitySignals = this.lastSuccessfulPayloadHadEvents;
    return calculateAdaptiveDelay(
      timeoutMs,
      settings.livePollFallbackMs,
      this.consecutiveErrors,
      useActivitySignals ? this.getBurstRate() : undefined,
      this.densityRing,
      useActivitySignals ? this.densityRingFilled : 0,
      this.getLimits()
    );
  }

  private async runLiveLoop(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      throwIfAborted(signal);

      await this.session.waitWhilePaused(signal);

      const playback = this.session.getPlaybackSnapshot();
      if (playback?.paused) {
        await this.session.pollWhilePaused(
          this.session.getSettings().livePollFallbackMs,
          250,
          signal
        );
        continue;
      }

      const timeoutMs =
        this.liveContinuation?.timeoutMs ?? this.session.getSettings().livePollFallbackMs;
      const delayMs = this.calculateAdaptiveDelay(timeoutMs);

      // Even sustained bursts yield for the configured minimum interval.
      await sleep(delayMs, signal);

      throwIfAborted(signal);

      // Re-check pause state after sleep — the tab may have been hidden
      // during the delay. Without this guard, the next fetch+emitBatch
      // would deliver messages while the renderer is paused.
      await this.session.waitWhilePaused(signal);

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
        if (this.consecutiveErrors >= this.session.getSettings().livePollFailureLimit) {
          log.error(
            `Live poll failed ${this.consecutiveErrors} times consecutively; ` +
              'circuit breaker tripped — stopping poll loop for watchdog restart'
          );
          throw new Error(
            `Live poll consecutive failure limit (${this.session.getSettings().livePollFailureLimit}) reached`
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
        // Refresh bootstrap on parse/protocol errors (API format changed)
        // or periodically with exponential backoff during sustained outages.
        // Network errors (TypeError) should NOT trigger bootstrap refresh —
        // just wait and retry; the network may recover on its own.
        const isParseError = error instanceof SyntaxError || error instanceof LiveChatProtocolError;
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
      const payload = await this.session.requestPayload(fetchLiveChat, continuation, mergedSignal);
      mergedSignal.throwIfAborted();
      return payload;
    } catch (error: unknown) {
      if (
        timeoutSignal.aborted &&
        error === timeoutSignal.reason &&
        mergedSignal.reason === timeoutSignal.reason
      ) {
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
    if (signal?.aborted) return;
    const events = extractChatEvents(
      payload.actions,
      this.session.getSettings,
      undefined,
      this.session.isKnownReplacementTarget
    );

    if (events.length > 0) {
      let messages: ChatMessage[];

      if (isInitialSeed) {
        const playback = this.session.getPlaybackSnapshot();
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
        this.session.emitBatch(messages, isInitialSeed, signal);
        if (signal?.aborted) return;
        this.recordMessageCount(messages.length);
      }
    }

    // Delivery may synchronously retire this source through the runtime callback.
    if (signal?.aborted) return;

    const nextContinuation = extractNextLiveContinuation(payload.continuations);
    if (!nextContinuation) {
      // Continuation token missing — API format may have changed.
      log.warn('chat.live.missing-continuation');
      throw new LiveChatProtocolError('Live chat response is missing its next continuation');
    }

    this.lastSuccessfulPayloadHadEvents = events.length > 0;
    this.consecutiveErrors = 0;
    this.liveContinuation = nextContinuation;
  }

  private async refreshLiveContinuation(signal?: AbortSignal): Promise<void> {
    const bootstrap = await this.session.refreshBootstrap(signal);
    if (bootstrap) {
      this.liveContinuation = bootstrap.initialContinuation ?? null;
    }
  }
}

/** Public live source port. The session owns shared state; the driver owns protocol state. */
export class LiveChatSource implements LiveChatPort {
  readonly mode = 'live' as const;
  private readonly session: ChatSession;
  private readonly driver: LiveChatDriver;
  burstRateProvider?: () => number;

  constructor(getSettings: () => Readonly<OverlaySettings>) {
    let driver: LiveChatDriver | undefined;
    this.session = new ChatSession(getSettings, (session) => {
      driver = new LiveChatDriver(session, () => this.burstRateProvider?.());
      return driver;
    });
    if (!driver) throw new Error('Live chat driver was not created');
    this.driver = driver;
  }

  setInitialBootstrap(data: ChatBootstrapData): void {
    this.session.setInitialBootstrap(data);
  }
  start(
    callback: (messages: ChatMessage | ChatMessage[], isInitialSeed?: boolean) => void,
    signal?: AbortSignal
  ): Promise<ChatSourceStartStatus> {
    return this.session.start(callback, signal);
  }
  stop(): void {
    this.session.stop();
  }
  isActive(timeoutMs?: number): boolean {
    return this.session.isActive(timeoutMs);
  }
  getLatestMessages(limit: number): ChatMessage[] {
    return this.session.getLatestMessages(limit);
  }
  getHealthSnapshot(options?: { activeTimeoutMs?: number }): ChatHealthSnapshot {
    return {
      ...this.session.getHealthSnapshot(options),
      consecutiveErrors: this.driver.getConsecutiveErrors(),
    };
  }
  setPauseReason(reason: string, paused: boolean): void {
    this.session.setPauseReason(reason, paused);
  }
  setPaused(paused: boolean): void {
    this.session.setPaused(paused);
  }
  injectExternalMessages(messages: ChatMessage[]): void {
    this.session.injectExternalMessages(messages);
  }
}
