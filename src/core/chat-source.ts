/**
 * Fetches YouTube live chat directly from youtubei endpoints without depending
 * on the visible chat panel DOM.
 */

import type { ChatMessage, OverlaySettings } from '@app-types';
import { type ChatEvent, ChatMessageParser } from '@core/chat-message-parser';
import {
  combineAbortSignals,
  findElementMatch,
  isAbortError,
  sleep,
  throwIfAborted,
  VIDEO_SELECTORS,
} from '@core/dom';
import { createLogger } from '@core/logging';
import {
  bootstrapChatSession,
  type ChatBootstrapData,
  type ChatBootstrapResult,
  extractNextLiveContinuation,
  extractPlayerSeekContinuation,
  extractReplayContinuation,
  fetchLiveChat,
  fetchReplayChat,
  getLiveChatPayload,
  type InnertubeContinuationData,
  type LiveChatPayload,
  YoutubeInnertubeRequestError,
} from '@core/youtubei-chat';

const log = createLogger('ChatSource');

const BOOTSTRAP_ATTEMPTS = 4;
const BOOTSTRAP_RETRY_DELAY_MS = 1000;
const RECENT_MESSAGE_BUFFER_SIZE = 100;
const RECONNECT_RETRY_DELAY_MS = 1000;
const DEFAULT_ACTIVITY_TIMEOUT_MS = 30_000;
const LIVE_POLL_FALLBACK_DELAY_MS = 4000;
const REPLAY_LOOP_DELAY_MS = 250;
const REPLAY_FETCH_MIN_DELTA_MS = 1000;
const REPLAY_EMIT_TOLERANCE_MS = 300;
const REPLAY_CONSECUTIVE_FAILURE_LIMIT = 5;
const REPLAY_FAILURE_BACKOFF_MS = 5000;
const REPLAY_PREFETCH_WINDOW_MS = 5000;
const MAX_BUFFERED_REPLAY_MESSAGES = 300;
const MAX_TRACKED_REPLAY_KEYS = 2000;

type ReplayMode = 'playerSeek' | 'continuation';

interface ChatHealthSnapshotOptions {
  activeTimeoutMs?: number;
}

export interface ChatHealthSnapshot {
  observerAlive: boolean;
  recentlyActive: boolean;
}

interface ChatBootstrapResolution {
  status: ChatBootstrapResult['status'];
  bootstrap?: ChatBootstrapData;
  reason: string;
}

interface PlaybackSnapshot {
  offsetMs: number;
  paused: boolean;
}

interface ReplayBufferedMessage {
  key: string;
  message: ChatMessage;
  offsetMs: number;
}

export type MessageCallback = (message: ChatMessage) => void;
export type ChatSourceStartStatus = 'started' | 'retryable' | 'unavailable';

export class ChatSource {
  private readonly parser: ChatMessageParser;
  private callback: MessageCallback | null = null;
  private lifecycleController: AbortController | null = null;
  private pollController: AbortController | null = null;
  private pollLoopAlive = false;
  private pollGeneration = 0;
  private lastActivityTime = 0;
  private bootstrap: ChatBootstrapData | null = null;
  private liveContinuation: InnertubeContinuationData | null = null;
  private replayMode: ReplayMode | null = null;
  private replayPlayerSeekContinuation: InnertubeContinuationData | null = null;
  private replayContinuation: InnertubeContinuationData | null = null;
  private replayFallbackLastOffsetMs = -1;
  private lastReplayRequestedOffsetMs = -REPLAY_FETCH_MIN_DELTA_MS;
  private replayConsecutiveFailures = 0;
  private replayNextAllowedFetchAt = 0;
  private readonly recentMessages: ChatMessage[] = [];
  private readonly replaySeenKeys = new Set<string>();
  private readonly replayPendingKeys = new Set<string>();
  private replayBuffer: ReplayBufferedMessage[] = [];

  constructor(getSettings: (() => Readonly<OverlaySettings>) | null = null) {
    this.parser = new ChatMessageParser(getSettings);
  }

  async start(callback: MessageCallback, signal?: AbortSignal): Promise<ChatSourceStartStatus> {
    this.lifecycleController?.abort();
    this.pollController?.abort();
    this.pollGeneration += 1;

    this.lifecycleController = new AbortController();
    this.pollController = new AbortController();
    this.callback = callback;
    this.resetSessionState();

    const combinedSignal = combineAbortSignals(
      signal,
      this.lifecycleController.signal,
      this.pollController.signal
    );

    try {
      return await this.bootstrapAndLaunchPolling(combinedSignal);
    } catch (error) {
      if (isAbortError(error) && this.isLifecycleAbort()) {
        return 'retryable';
      }

      throw error;
    }
  }

  stop(): void {
    this.lifecycleController?.abort();
    this.lifecycleController = null;

    this.pollController?.abort();
    this.pollController = null;

    this.pollGeneration += 1;
    this.pollLoopAlive = false;
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
    if (limit <= 0) return [];
    return this.recentMessages.slice(-limit);
  }

  private isObserverAlive(): boolean {
    return (
      this.pollLoopAlive &&
      this.pollController !== null &&
      !this.pollController.signal.aborted &&
      this.callback !== null
    );
  }

  private async bootstrapAndLaunchPolling(signal?: AbortSignal): Promise<ChatSourceStartStatus> {
    const bootstrapResolution = await this.resolveBootstrap(signal);

    if (bootstrapResolution.status !== 'ready' || !bootstrapResolution.bootstrap) {
      this.logBootstrapFailure(bootstrapResolution);
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

  private async seedCurrentSession(signal?: AbortSignal): Promise<boolean> {
    const bootstrap = this.bootstrap;
    if (!bootstrap) {
      return false;
    }

    return bootstrap.isReplay
      ? this.initializeReplaySession(signal)
      : this.initializeLiveSession(signal);
  }

  private launchCurrentPollLoop(signal?: AbortSignal): void {
    const bootstrap = this.bootstrap;
    if (!bootstrap) {
      return;
    }

    this.launchPollLoop(
      signal,
      bootstrap.isReplay ? this.runReplayLoop.bind(this) : this.runLiveLoop.bind(this)
    );
  }

  private launchPollLoop(
    signal: AbortSignal | undefined,
    runner: (loopSignal: AbortSignal | undefined) => Promise<void>
  ): void {
    const generation = ++this.pollGeneration;
    this.pollLoopAlive = true;

    void Promise.resolve()
      .then(() => runner(signal))
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }

        log.warn('Chat polling loop stopped unexpectedly:', error);
      })
      .finally(() => {
        if (generation === this.pollGeneration) {
          this.pollLoopAlive = false;
        }
      });
  }

  private isLifecycleAbort(): boolean {
    return this.lifecycleController?.signal.aborted ?? false;
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
    this.replaySeenKeys.clear();
    this.replayPendingKeys.clear();
  }

  private resetSessionState(): void {
    this.bootstrap = null;
    this.liveContinuation = null;
    this.lastActivityTime = 0;
    this.recentMessages.length = 0;
    this.resetReplayState();
  }

  private markActivity(): void {
    this.lastActivityTime = Date.now();
  }

  private rememberMessage(message: ChatMessage): void {
    this.recentMessages.push(message);

    const overflow = this.recentMessages.length - RECENT_MESSAGE_BUFFER_SIZE;
    if (overflow > 0) {
      this.recentMessages.splice(0, overflow);
    }
  }

  private emitMessage(message: ChatMessage): void {
    if (!this.callback) {
      return;
    }

    this.rememberMessage(message);
    this.callback(message);
  }

  private trackReplayKey(key: string): void {
    this.replaySeenKeys.add(key);
    if (this.replaySeenKeys.size <= MAX_TRACKED_REPLAY_KEYS) {
      return;
    }

    const iterator = this.replaySeenKeys.values();
    const overflow = this.replaySeenKeys.size - MAX_TRACKED_REPLAY_KEYS;
    for (let index = 0; index < overflow; index++) {
      const next = iterator.next();
      if (next.done || next.value === undefined) {
        break;
      }

      this.replaySeenKeys.delete(next.value);
    }
  }

  private async resolveBootstrap(signal?: AbortSignal): Promise<ChatBootstrapResolution> {
    let lastRetryReason = 'Chat bootstrap did not become available';

    for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt++) {
      throwIfAborted(signal);

      const result = await bootstrapChatSession(signal);
      if (result.status === 'ready') {
        return {
          status: 'ready',
          bootstrap: result.data,
          reason: 'Chat bootstrap resolved successfully',
        };
      }

      if (result.status === 'unavailable') {
        return {
          status: 'unavailable',
          reason: result.reason,
        };
      }

      lastRetryReason = result.reason;

      if (attempt < BOOTSTRAP_ATTEMPTS) {
        await sleep(BOOTSTRAP_RETRY_DELAY_MS, signal);
      }
    }

    return {
      status: 'retryable',
      reason: lastRetryReason,
    };
  }

  private logBootstrapFailure(
    resolution: Exclude<ChatBootstrapResolution, { status: 'ready' }>
  ): void {
    if (resolution.status === 'retryable') {
      log.warn(
        `Chat bootstrap was retryable after ${BOOTSTRAP_ATTEMPTS} attempts: ${resolution.reason}`
      );
      return;
    }

    log.warn('Chat source is unavailable:', resolution.reason);
  }

  private async requestLivePayload(
    continuation: InnertubeContinuationData,
    signal?: AbortSignal
  ): Promise<LiveChatPayload | null> {
    if (!this.bootstrap) {
      return null;
    }

    const response = await fetchLiveChat(this.bootstrap, continuation, signal);
    const payload = getLiveChatPayload(response);
    if (!payload) {
      log.warn('Live chat response did not contain a liveChatContinuation payload');
      return null;
    }

    this.markActivity();
    return payload;
  }

  private async requestReplayPayload(
    continuation: InnertubeContinuationData,
    signal?: AbortSignal,
    playerOffsetMs?: number
  ): Promise<LiveChatPayload | null> {
    if (!this.bootstrap) {
      return null;
    }

    const response = await fetchReplayChat(this.bootstrap, continuation, playerOffsetMs, signal);
    const payload = getLiveChatPayload(response);
    if (!payload) {
      log.warn('Replay chat response did not contain a liveChatContinuation payload');
      return null;
    }

    this.markActivity();
    return payload;
  }

  private async refreshBootstrap(signal?: AbortSignal): Promise<boolean> {
    const resolution = await this.resolveBootstrap(signal);

    if (resolution.status !== 'ready' || !resolution.bootstrap) {
      log.warn('Failed to refresh chat bootstrap:', resolution.reason);
      return false;
    }

    this.bootstrap = resolution.bootstrap;
    return true;
  }

  private async refreshLiveContinuation(signal?: AbortSignal): Promise<void> {
    const refreshed = await this.refreshBootstrap(signal);
    if (refreshed) {
      this.liveContinuation = this.bootstrap?.initialContinuation ?? null;
    }
  }

  private handleLivePayload(payload: LiveChatPayload): void {
    const events = this.parser.extractChatEvents(payload.actions);
    for (const event of events) {
      this.emitMessage(event.message);
    }

    this.liveContinuation = extractNextLiveContinuation(payload.continuations);
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

  private getPlaybackSnapshot(): PlaybackSnapshot | null {
    const match = findElementMatch<HTMLVideoElement>(VIDEO_SELECTORS);
    if (!match) {
      return null;
    }

    const { element: video } = match;
    if (!Number.isFinite(video.currentTime)) {
      return null;
    }

    return {
      offsetMs: Math.max(0, Math.floor(video.currentTime * 1000)),
      paused: video.paused,
    };
  }

  private makeReplayKey(message: ChatMessage, offsetMs: number): string {
    return message.id ?? `${message.kind}:${offsetMs}:${message.author ?? ''}:${message.text}`;
  }

  private trimReplayBuffer(): void {
    if (this.replayBuffer.length <= MAX_BUFFERED_REPLAY_MESSAGES) {
      return;
    }

    const overflow = this.replayBuffer.length - MAX_BUFFERED_REPLAY_MESSAGES;
    const removed = this.replayBuffer.splice(0, overflow);
    for (const item of removed) {
      this.replayPendingKeys.delete(item.key);
    }
  }

  private bufferReplayEvents(events: ChatEvent[], minimumOffsetMs = 0): number {
    let highestOffsetMs = this.replayFallbackLastOffsetMs;
    let inserted = false;

    for (const event of events) {
      if (event.offsetMs === undefined) {
        continue;
      }

      highestOffsetMs = Math.max(highestOffsetMs, event.offsetMs);
      if (event.offsetMs < minimumOffsetMs) {
        continue;
      }

      const key = this.makeReplayKey(event.message, event.offsetMs);
      if (this.replaySeenKeys.has(key) || this.replayPendingKeys.has(key)) {
        continue;
      }

      this.replayPendingKeys.add(key);
      this.replayBuffer.push({
        key,
        message: event.message,
        offsetMs: event.offsetMs,
      });
      inserted = true;
    }

    if (inserted) {
      this.replayBuffer.sort((left, right) => left.offsetMs - right.offsetMs);
      this.trimReplayBuffer();
    }

    return highestOffsetMs;
  }

  private flushReplayBuffer(currentOffsetMs: number): void {
    if (!this.callback || this.replayBuffer.length === 0) {
      return;
    }

    while (this.replayBuffer.length > 0) {
      const next = this.replayBuffer[0];
      if (!next) {
        break;
      }

      if (next.offsetMs > currentOffsetMs + REPLAY_EMIT_TOLERANCE_MS) {
        break;
      }

      this.replayBuffer.shift();
      this.replayPendingKeys.delete(next.key);
      this.trackReplayKey(next.key);
      this.emitMessage(next.message);
    }
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
        this.parser.extractChatEvents(payload.actions),
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

      const events = this.parser.extractChatEvents(payload.actions);
      this.replayFallbackLastOffsetMs = this.bufferReplayEvents(events, minimumOffsetMs);
      this.replayContinuation = extractReplayContinuation(payload.continuations);

      // Successful fetch — reset failure counter.
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

  /**
   * Track consecutive replay fetch failures and back off when the threshold
   * is exceeded so we don't busy-loop against a non-responsive endpoint.
   */
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

  private async catchUpFallbackReplay(
    currentOffsetMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    // Inline simpler version inside pollContinuationReplay.
    // Keep signature for initializeReplaySession to call inline.
    const minimumOffsetMs = Math.max(0, currentOffsetMs - REPLAY_PREFETCH_WINDOW_MS);
    let batchesFetched = 0;

    while (
      this.replayContinuation &&
      this.replayFallbackLastOffsetMs < minimumOffsetMs &&
      batchesFetched < 12
    ) {
      throwIfAborted(signal);

      const fetched = await this.fetchNextReplayFallbackBatch(minimumOffsetMs, signal);
      if (!fetched) {
        break;
      }

      batchesFetched += 1;
    }
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
        this.parser.extractChatEvents(initialPayload.actions),
        minimumOffsetMs
      );
      await this.catchUpFallbackReplay(currentOffsetMs, signal);
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
    const refreshed = await this.refreshBootstrap(signal);
    if (!refreshed || !this.bootstrap?.isReplay) {
      return false;
    }

    return this.initializeReplaySession(signal);
  }

  private shouldFetchReplayAtOffset(currentOffsetMs: number): boolean {
    if (!this.replayPlayerSeekContinuation) {
      return false;
    }

    if (this.replayBuffer.length === 0) {
      return true;
    }

    return currentOffsetMs - this.lastReplayRequestedOffsetMs >= REPLAY_FETCH_MIN_DELTA_MS;
  }

  private async runLiveLoop(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const delayMs = this.liveContinuation?.timeoutMs ?? LIVE_POLL_FALLBACK_DELAY_MS;
      await sleep(delayMs, signal);

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

        this.handleLivePayload(payload);
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }

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

  private async runReplayLoop(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const playback = this.getPlaybackSnapshot();
      const currentOffsetMs = playback?.offsetMs ?? 0;

      this.flushReplayBuffer(currentOffsetMs);

      if (!playback) {
        await sleep(REPLAY_LOOP_DELAY_MS, signal);
        continue;
      }

      if (this.replayMode === 'playerSeek') {
        await this.pollPlayerSeekReplay(playback, signal);
      } else if (this.replayMode === 'continuation' && !playback.paused) {
        await this.pollContinuationReplay(currentOffsetMs, signal);
      }

      await sleep(REPLAY_LOOP_DELAY_MS, signal);
    }
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
    // Skip fetching while in backoff to avoid busy-looping against a
    // non-responsive endpoint after consecutive failures.
    if (Date.now() < this.replayNextAllowedFetchAt) {
      return;
    }

    // Fetch batches until buffer catches up to current position.
    const minimumOffsetMs = Math.max(0, currentOffsetMs - REPLAY_PREFETCH_WINDOW_MS);
    let batches = 0;

    while (
      this.replayContinuation &&
      this.replayFallbackLastOffsetMs < minimumOffsetMs &&
      batches < 12
    ) {
      throwIfAborted(signal);

      const fetched = await this.fetchNextReplayFallbackBatch(minimumOffsetMs, signal);
      if (!fetched) {
        break;
      }

      batches += 1;
    }

    // Keep buffer topped up while playback advances.
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
