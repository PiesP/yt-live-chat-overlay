/**
 * LiveChatSource — live polling loop with adaptive delay and density-aware seeding.
 *
 * Extracted from chat-source.ts to separate live and replay chat concerns.
 */

import type { ChatMessage } from '@app-types';
import { extractChatEvents } from '@core/chat-message-parser';
import { ChatSource } from '@core/chat-source-base';
import { isAbortError, sleep, throwIfAborted } from '@core/dom';
import { createLogger } from '@core/logging';
import { SpreadEmitter } from '@core/spread-emitter';
import {
  extractNextLiveContinuation,
  fetchLiveChat,
  type InnertubeContinuationData,
  type LiveChatPayload,
  YoutubeInnertubeRequestError,
} from '@core/youtubei-chat';

const log = createLogger('LiveChatSource');

const LIVE_POLL_FALLBACK_DELAY_MS = 1500;
const LIVE_SEED_CUTOFF_MS = 60_000;

export class LiveChatSource extends ChatSource {
  private liveContinuation: InnertubeContinuationData | null = null;
  private consecutiveErrors = 0;
  private readonly recentMessageCounts: number[] = [];
  private static readonly DENSITY_WINDOW_SIZE = 5;
  private static readonly DENSITY_HIGH_THRESHOLD = 10;
  private static readonly DENSITY_LOW_THRESHOLD = 1;
  /** When avg messages per poll exceeds this, skip sleep entirely (chained polling). */
  private static readonly EXTREME_DENSITY_THRESHOLD = 30;

  private spreadEmitter: SpreadEmitter | null = null;

  protected seedCurrentSession(signal?: AbortSignal): Promise<boolean> {
    return this.initializeLiveSession(signal);
  }

  protected launchCurrentPollLoop(signal?: AbortSignal): void {
    this.launchPollLoop(signal, (loopSignal) => this.runLiveLoop(loopSignal));
  }

  protected resetSessionState(): void {
    super.resetSessionState();
    this.liveContinuation = null;
    this.consecutiveErrors = 0;
    this.spreadEmitter?.destroy();
    this.spreadEmitter = null;
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

      this.handleLivePayload(payload);
      return true;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      log.warn('Failed to initialize live chat session:', error);
      return false;
    }
  }

  private recordMessageCount(count: number): void {
    this.recentMessageCounts.push(count);
    if (this.recentMessageCounts.length > LiveChatSource.DENSITY_WINDOW_SIZE) {
      this.recentMessageCounts.shift();
    }
  }

  private calculateAdaptiveDelay(timeoutMs: number): number {
    const settings = this.getSettings();

    if (this.consecutiveErrors > 0) {
      const delayed =
        (timeoutMs > 0 ? timeoutMs : LIVE_POLL_FALLBACK_DELAY_MS) * 2 ** this.consecutiveErrors;
      return Math.min(settings.maxPollIntervalMs, Math.max(settings.minPollIntervalMs, delayed));
    }

    // Extreme density: skip sleep entirely (chained polling).
    // The next request fires immediately after the previous one completes.
    if (this.recentMessageCounts.length >= 2) {
      const avgCount =
        this.recentMessageCounts.reduce((a, b) => a + b, 0) / this.recentMessageCounts.length;
      if (avgCount >= LiveChatSource.EXTREME_DENSITY_THRESHOLD) {
        return 0;
      }
    }

    // Base adaptive delay within bounds
    let base = Math.max(
      settings.minPollIntervalMs,
      Math.min(settings.maxPollIntervalMs, timeoutMs > 0 ? timeoutMs : LIVE_POLL_FALLBACK_DELAY_MS)
    );

    if (this.recentMessageCounts.length < 2) return base;

    const avgCount =
      this.recentMessageCounts.reduce((a, b) => a + b, 0) / this.recentMessageCounts.length;

    if (avgCount >= LiveChatSource.DENSITY_HIGH_THRESHOLD) {
      base = Math.max(settings.minPollIntervalMs, Math.round(base * 0.3));
    }
    if (avgCount <= LiveChatSource.DENSITY_LOW_THRESHOLD) {
      base = Math.min(settings.maxPollIntervalMs, Math.round(base * 1.2));
    }

    return Math.max(settings.minPollIntervalMs, Math.min(settings.maxPollIntervalMs, base));
  }

  private async runLiveLoop(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      throwIfAborted(signal);

      await this.waitWhilePaused();

      const playback = this.getPlaybackSnapshot();
      if (playback?.paused) {
        this.spreadEmitter?.pause();
        await sleep(LIVE_POLL_FALLBACK_DELAY_MS, signal);
        continue;
      }

      const timeoutMs = this.liveContinuation?.timeoutMs ?? LIVE_POLL_FALLBACK_DELAY_MS;
      const delayMs = this.calculateAdaptiveDelay(timeoutMs);

      // Sync spread emitter with current poll interval
      this.ensureSpreadEmitter();
      const spreadInterval = this.calculateSpreadInterval(
        Math.max(delayMs, LIVE_POLL_FALLBACK_DELAY_MS)
      );
      this.spreadEmitter?.setSpreadInterval(spreadInterval);
      this.spreadEmitter?.resume();

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

        this.handleLivePayload(payload, true);
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }

        this.consecutiveErrors += 1;

        if (error instanceof YoutubeInnertubeRequestError) {
          log.warn('Live poll request failed:', {
            status: error.status,
            message: error.message,
          });
        } else {
          log.warn('Live poll request failed:', error);
        }

        await this.refreshLiveContinuation(signal);
      }
    }
  }

  private async requestLivePayload(
    continuation: InnertubeContinuationData,
    signal?: AbortSignal
  ): Promise<LiveChatPayload | null> {
    return this.requestPayload(fetchLiveChat, continuation, signal);
  }

  private handleLivePayload(payload: LiveChatPayload, isInitialSeed: boolean = false): void {
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
            `Initial seed filtered: ${events.length} → ${filtered.length} ` +
              `(playback at ${Math.round(offsetMs / 1000)}s)`
          );
        }
      } else {
        messages = events.map((e) => e.message);
      }

      if (messages.length > 0) {
        this.emitMessages(messages, isInitialSeed);
        this.recordMessageCount(messages.length);
      }

      this.consecutiveErrors = 0;
    }

    this.liveContinuation = extractNextLiveContinuation(payload.continuations);
  }

  private async refreshLiveContinuation(signal?: AbortSignal): Promise<void> {
    const bootstrap = await this.bootstrapResolver.refresh(signal);
    if (bootstrap) {
      this.bootstrap = bootstrap;
      this.liveContinuation = this.bootstrap?.initialContinuation ?? null;
    }
  }

  /**
   * Emit messages — priority messages go directly to the callback,
   * normal messages are routed through the spread emitter when enabled.
   */
  private emitMessages(messages: ChatMessage[], isInitialSeed: boolean): void {
    if (isInitialSeed) {
      // Initial seed is handled by BacklogInjectionController in RuntimeSession
      this.emitBatch(messages, isInitialSeed);
      return;
    }

    const settings = this.getSettings();
    if (!settings.spreadEnabled) {
      this.emitBatch(messages, false);
      return;
    }

    this.ensureSpreadEmitter();
    this.spreadEmitter?.enqueue(messages);
  }

  /**
   * Lazily create the spread emitter on first use.
   */
  private ensureSpreadEmitter(): void {
    if (this.spreadEmitter) return;
    this.spreadEmitter = new SpreadEmitter(
      (msg) => {
        this.emitMessage(msg);
      },
      () => this.getSettings().spreadFactor
    );
  }

  private calculateSpreadInterval(pollDelayMs: number): number {
    // Use the previous poll's message count as an estimate for the next batch
    const avgCount =
      this.recentMessageCounts.length > 0
        ? this.recentMessageCounts.reduce((a, b) => a + b, 0) / this.recentMessageCounts.length
        : 1;

    if (avgCount <= 1) return pollDelayMs;
    return Math.max(50, Math.round(pollDelayMs / avgCount));
  }
}
