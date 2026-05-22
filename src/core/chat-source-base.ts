/**
 * ChatSource abstract base — shared bootstrap, parser, settings, health tracking.
 *
 * Extracted from chat-source.ts to break the circular dependency between
 * the base class and its concrete implementations (LiveChatSource, ReplayChatSource).
 */

import type { ChatMessage, OverlaySettings } from '@app-types';
import { BootstrapResolver } from '@core/bootstrap-resolver';
import { findElementMatch, isAbortError, VIDEO_SELECTORS } from '@core/dom';
import { createLogger } from '@core/logging';
import { MessageBuffer } from '@core/message-buffer';
import { PollLoopManager } from '@core/poll-loop-manager';
import {
  type ChatBootstrapData,
  getLiveChatPayload,
  type InnertubeContinuationData,
  type LiveChatPayload,
} from '@core/youtubei-chat';

const log = createLogger('ChatSource');

const DEFAULT_ACTIVITY_TIMEOUT_MS = 30_000;

interface ChatHealthSnapshotOptions {
  activeTimeoutMs?: number;
}

export interface ChatHealthSnapshot {
  observerAlive: boolean;
  recentlyActive: boolean;
}

export interface PlaybackSnapshot {
  offsetMs: number;
  paused: boolean;
}

/**
 * Accepts either a single message (for individual emission like replay)
 * or an array of messages (for batch emission like live polling).
 */
type MessageCallback = (messages: ChatMessage | ChatMessage[], isInitialSeed?: boolean) => void;
export type ChatSourceStartStatus = 'started' | 'retryable' | 'unavailable';

export abstract class ChatSource {
  protected readonly getSettings: () => Readonly<OverlaySettings>;
  protected callback: MessageCallback | null = null;
  private pollController: AbortController | null = null;
  private readonly pollLoopManager = new PollLoopManager();
  protected chatPaused = false;
  private lastActivityTime = 0;
  protected bootstrap: ChatBootstrapData | null = null;
  private readonly messageBuffer = new MessageBuffer();
  protected readonly bootstrapResolver = new BootstrapResolver();

  private static readonly PAUSE_POLL_INTERVAL_MS = 250;

  constructor(getSettings: () => Readonly<OverlaySettings>) {
    this.getSettings = getSettings;
  }

  async start(callback: MessageCallback, signal?: AbortSignal): Promise<ChatSourceStartStatus> {
    this.pollController?.abort();
    this.pollLoopManager.stop();

    this.pollController = new AbortController();
    this.callback = callback;
    this.resetSessionState();

    const combinedSignal = signal ?? this.pollController.signal;

    try {
      return await this.bootstrapAndLaunchPolling(combinedSignal);
    } catch (error) {
      if (isAbortError(error)) return 'retryable';
      throw error;
    }
  }

  stop(): void {
    this.pollController?.abort();
    this.pollController = null;

    this.pollLoopManager.stop();
    this.callback = null;
    this.resetSessionState();

    log.debug('Chat monitoring stopped');
  }

  isActive(timeoutMs = DEFAULT_ACTIVITY_TIMEOUT_MS): boolean {
    return Date.now() - this.lastActivityTime < Math.max(0, timeoutMs);
  }

  getHealthSnapshot(options: ChatHealthSnapshotOptions = {}): ChatHealthSnapshot {
    const activeTimeoutMs = options.activeTimeoutMs ?? DEFAULT_ACTIVITY_TIMEOUT_MS;

    return {
      observerAlive: this.isObserverAlive(),
      recentlyActive: this.isActive(activeTimeoutMs),
    };
  }

  getLatestMessages(limit: number): ChatMessage[] {
    return this.messageBuffer.getLatest(limit);
  }

  protected isObserverAlive(): boolean {
    return (
      this.pollLoopManager.isAlive() &&
      this.pollController !== null &&
      !this.pollController.signal.aborted &&
      this.callback !== null
    );
  }

  protected getPlaybackSnapshot(): PlaybackSnapshot | null {
    const match = findElementMatch<HTMLVideoElement>(VIDEO_SELECTORS);
    if (!match) return null;
    const { element: video } = match;
    if (!Number.isFinite(video.currentTime)) return null;
    return {
      offsetMs: Math.max(0, Math.floor(video.currentTime * 1000)),
      paused: video.paused,
    };
  }

  protected markActivity(): void {
    this.lastActivityTime = Date.now();
  }

  protected emitMessage(message: ChatMessage): void {
    if (!this.callback) return;
    this.messageBuffer.push(message);
    this.callback(message);
  }

  protected emitBatch(messages: ChatMessage[], isInitialSeed: boolean): void {
    if (!this.callback || messages.length === 0) return;
    for (const message of messages) {
      this.messageBuffer.push(message);
    }
    this.callback(messages, isInitialSeed);
  }

  protected async requestPayload<TCallArgs extends unknown[]>(
    fetchFn: (
      bootstrap: ChatBootstrapData,
      continuation: InnertubeContinuationData,
      ...args: TCallArgs
    ) => Promise<unknown>,
    continuation: InnertubeContinuationData,
    ...fetchArgs: TCallArgs
  ): Promise<LiveChatPayload | null> {
    if (!this.bootstrap) return null;

    const response = await fetchFn(this.bootstrap, continuation, ...fetchArgs);
    const payload = getLiveChatPayload(response);
    if (!payload) {
      log.warn('Failed to parse live chat payload from response');
      return null;
    }

    this.markActivity();
    return payload;
  }

  protected launchPollLoop(
    signal: AbortSignal | undefined,
    runner: (loopSignal: AbortSignal | undefined) => Promise<void>
  ): void {
    this.pollLoopManager.launch(runner, signal);
  }

  protected resetSessionState(): void {
    this.bootstrap = null;
    this.lastActivityTime = 0;
    this.messageBuffer.clear();
  }

  setPaused(paused: boolean): void {
    this.chatPaused = paused;
  }

  protected waitWhilePaused(): Promise<void> {
    if (!this.chatPaused) return Promise.resolve();
    return new Promise((resolve) => {
      const check = (): void => {
        if (!this.chatPaused) {
          resolve();
          return;
        }
        setTimeout(check, ChatSource.PAUSE_POLL_INTERVAL_MS);
      };
      check();
    });
  }

  /**
   * Inject messages obtained from an external source (e.g. fetch interceptor
   * that eavesdrops on YouTube's own chat requests).  Messages bypass the
   * normal poll loop and are delivered through the standard callback path
   * so they flow through dedup, spread emission, and the renderer.
   */
  injectExternalMessages(messages: ChatMessage[]): void {
    if (!this.callback || messages.length === 0) return;
    for (const message of messages) {
      this.messageBuffer.push(message);
    }
    this.callback(messages, false);
  }

  protected abstract seedCurrentSession(signal?: AbortSignal): Promise<boolean>;
  protected abstract launchCurrentPollLoop(signal?: AbortSignal): void;

  private async bootstrapAndLaunchPolling(signal?: AbortSignal): Promise<ChatSourceStartStatus> {
    const bootstrapResolution = await this.bootstrapResolver.resolve(signal);

    if (bootstrapResolution.status !== 'ready' || !bootstrapResolution.bootstrap) {
      this.bootstrapResolver.logFailure(bootstrapResolution);
      return bootstrapResolution.status === 'unavailable' ? 'unavailable' : 'retryable';
    }

    this.bootstrap = bootstrapResolution.bootstrap;

    const seeded = await this.seedCurrentSession(signal);
    if (!seeded) {
      return 'retryable';
    }

    this.launchCurrentPollLoop(signal);

    log.info(
      `Chat monitoring started successfully via youtubei (${this.bootstrap.isReplay ? 'replay' : 'live'})`
    );

    return 'started';
  }
}
