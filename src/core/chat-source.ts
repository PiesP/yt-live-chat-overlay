/**
 * Fetches YouTube live chat directly from youtubei endpoints without depending
 * on the visible chat panel DOM.
 *
 * Provides a class hierarchy:
 * - ChatSource (abstract base) — shared bootstrap, parser, settings, health tracking
 * - LiveChatSource — live polling loop, live continuation logic
 * - ReplayChatSource — replay polling loop, playerSeek + continuation logic
 */

import type { ChatMessage, OverlaySettings } from '@app-types';
import { type ChatEvent, extractChatEvents } from '@core/chat-message-parser';
import {
  combineAbortSignals,
  findElementMatch,
  isAbortError,
  sleep,
  throwIfAborted,
  VIDEO_SELECTORS,
} from '@core/dom';
import { createLogger } from '@core/logging';
import { MessageIdRegistry } from '@core/message-id-registry';
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

const BOOTSTRAP_ATTEMPTS = 8;
/** Max retries for unavailable bootstrap (SPA navigation timing). */
const BOOTSTRAP_MAX_UNAVAILABLE_RETRIES = 4;
const BOOTSTRAP_RETRY_BASE_DELAY_MS = 800;
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
const MAX_TRACKED_REPLAY_KEYS = 10000;

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

/**
 * Accepts either a single message (for individual emission like replay)
 * or an array of messages (for batch emission like live polling).
 */
export type MessageCallback = (
  messages: ChatMessage | ChatMessage[],
  isInitialSeed?: boolean
) => void;
export type ChatSourceStartStatus = 'started' | 'retryable' | 'unavailable';

// ====================================================================
// Abstract base: shared bootstrap, parser, settings, health tracking
// ====================================================================

export abstract class ChatSource {
  protected readonly getSettings: () => Readonly<OverlaySettings>;
  protected callback: MessageCallback | null = null;
  private pollController: AbortController | null = null;
  private pollLoopAlive = false;
  private pollGeneration = 0;
  private lastActivityTime = 0;
  protected bootstrap: ChatBootstrapData | null = null;
  private readonly recentMessages: ChatMessage[] = [];

  constructor(getSettings: () => Readonly<OverlaySettings>) {
    this.getSettings = getSettings;
  }

  // ---- Public API (used by RuntimeSession) ----

  async start(callback: MessageCallback, signal?: AbortSignal): Promise<ChatSourceStartStatus> {
    this.pollController?.abort();
    this.pollGeneration += 1;

    this.pollController = new AbortController();
    this.callback = callback;
    this.resetSessionState();

    const combinedSignal = combineAbortSignals(signal, this.pollController.signal);

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

  // ---- Static factory ----

  /**
   * Create the correct ChatSource subclass (LiveChatSource or ReplayChatSource)
   * by performing a lightweight bootstrap check.
   *
   * The bootstrap result is not cached — start() will re-resolve internally.
   * This is a one-time per-session cost and the response is small.
   */
  static async create(
    getSettings: () => Readonly<OverlaySettings>,
    signal?: AbortSignal
  ): Promise<ChatSource> {
    const result = await bootstrapChatSession(signal);
    if (result.status === 'ready' && result.data?.isReplay) {
      return new ReplayChatSource(getSettings);
    }
    return new LiveChatSource(getSettings);
  }

  // ---- Protected helpers (for subclass use) ----

  protected isObserverAlive(): boolean {
    return (
      this.pollLoopAlive &&
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

  protected rememberMessage(message: ChatMessage): void {
    this.recentMessages.push(message);

    const overflow = this.recentMessages.length - RECENT_MESSAGE_BUFFER_SIZE;
    if (overflow > 0) {
      this.recentMessages.splice(0, overflow);
    }
  }

  /**
   * Emit a single message — used by replay flush which delivers one-at-a-time.
   */
  protected emitMessage(message: ChatMessage): void {
    if (!this.callback) {
      return;
    }

    this.rememberMessage(message);
    this.callback(message);
  }

  /**
   * Batch-emit messages in a single callback invocation.
   * All messages are remembered individually, then delivered as an array
   * to reduce per-message function-call overhead under high throughput.
   *
   * @param messages - Messages to emit.
   * @param isInitialSeed - True when this batch is the initial seed (backlog)
   *   from seedCurrentSession, so the runtime session can route to the backlog
   *   controller for throttled injection.
   */
  protected emitBatch(messages: ChatMessage[], isInitialSeed: boolean): void {
    if (!this.callback || messages.length === 0) {
      return;
    }

    for (const message of messages) {
      this.rememberMessage(message);
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
    if (!this.bootstrap) {
      return null;
    }

    const response = await fetchFn(this.bootstrap, continuation, ...fetchArgs);
    const payload = getLiveChatPayload(response);
    if (!payload) {
      log.warn('Failed to parse live chat payload from response');
      return null;
    }

    this.markActivity();
    return payload;
  }

  protected async resolveBootstrap(signal?: AbortSignal): Promise<ChatBootstrapResolution> {
    let lastRetryReason = 'Chat bootstrap did not become available';
    let unavailableRetries = 0;

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
        // SPA navigation: YouTube may not have updated window globals yet.
        // Retry with exponential backoff before giving up.
        unavailableRetries++;
        if (unavailableRetries > BOOTSTRAP_MAX_UNAVAILABLE_RETRIES) {
          return {
            status: 'unavailable',
            reason: result.reason,
          };
        }

        lastRetryReason = result.reason;
        log.debug(
          `Bootstrap unavailable (retry ${unavailableRetries}/${BOOTSTRAP_MAX_UNAVAILABLE_RETRIES}): ${result.reason}`
        );
      } else {
        lastRetryReason = result.reason;
      }

      // Exponential backoff: 800ms, 1600ms, 3200ms, 6400ms...
      if (attempt < BOOTSTRAP_ATTEMPTS) {
        const backoffDelay = BOOTSTRAP_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        await sleep(Math.min(backoffDelay, 8000), signal);
      }
    }

    return {
      status: 'retryable',
      reason: lastRetryReason,
    };
  }

  protected logBootstrapFailure(
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

  protected async refreshBootstrap(signal?: AbortSignal): Promise<boolean> {
    const resolution = await this.resolveBootstrap(signal);

    if (resolution.status !== 'ready' || !resolution.bootstrap) {
      log.warn('Failed to refresh chat bootstrap:', resolution.reason);
      return false;
    }

    this.bootstrap = resolution.bootstrap;
    return true;
  }

  protected launchPollLoop(
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

  protected resetSessionState(): void {
    this.bootstrap = null;
    this.lastActivityTime = 0;
    this.recentMessages.length = 0;
  }

  // ---- Abstract hooks for subclass specialisation ----

  /**
   * Seed the session by fetching the first batch of messages.
   * Subclass must check this.bootstrap (already resolved) and initialise
   * its own continuation tracking.
   */
  protected abstract seedCurrentSession(signal?: AbortSignal): Promise<boolean>;

  /**
   * Launch the mode-specific polling loop (live or replay).
   * Subclass must call this.launchPollLoop() with its loop runner.
   */
  protected abstract launchCurrentPollLoop(signal?: AbortSignal): void;

  // ---- Private ----

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
}

// ====================================================================
// Live chat source — live polling loop, live continuation
// ====================================================================

export class LiveChatSource extends ChatSource {
  private liveContinuation: InnertubeContinuationData | null = null;
  private lastActionsCount = 0;
  private consecutiveErrors = 0;
  private readonly liveDedupRegistry = new MessageIdRegistry(MAX_TRACKED_REPLAY_KEYS);

  protected seedCurrentSession(signal?: AbortSignal): Promise<boolean> {
    return this.initializeLiveSession(signal);
  }

  protected launchCurrentPollLoop(signal?: AbortSignal): void {
    this.launchPollLoop(signal, (loopSignal) => this.runLiveLoop(loopSignal));
  }

  protected resetSessionState(): void {
    super.resetSessionState();
    this.liveContinuation = null;
    this.lastActionsCount = 0;
    this.consecutiveErrors = 0;
    this.liveDedupRegistry.clear();
  }

  // ---- Live-specific ----

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

  private calculateAdaptiveDelay(timeoutMs: number): number {
    const baseDelay = timeoutMs > 0 ? timeoutMs : LIVE_POLL_FALLBACK_DELAY_MS;

    if (this.consecutiveErrors > 0) {
      // Error backoff: baseDelay * 2^errors (max 10000ms)
      return Math.min(10_000, baseDelay * 2 ** this.consecutiveErrors);
    }

    let delay: number;

    if (this.lastActionsCount >= 10) {
      delay = baseDelay * 0.5; // High activity — poll more frequently
    } else if (this.lastActionsCount >= 3) {
      delay = baseDelay * 0.75; // Moderate activity — slightly faster
    } else {
      delay = baseDelay; // Low or no activity — default interval
    }

    // Hard limits: 2000ms – 5000ms
    return Math.max(2000, Math.min(5000, delay));
  }

  private async runLiveLoop(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      // Skip polling while tab is hidden — saves bandwidth and prevents
      // stale messages from accumulating in the renderer queue.
      while (document.hidden && !signal?.aborted) {
        await sleep(LIVE_POLL_FALLBACK_DELAY_MS, signal);
      }
      throwIfAborted(signal);

      const timeoutMs = this.liveContinuation?.timeoutMs ?? LIVE_POLL_FALLBACK_DELAY_MS;
      const delayMs = this.calculateAdaptiveDelay(timeoutMs);
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
        // For initial seed, filter out messages that are far behind the
        // current playback position. This prevents flooding the screen with
        // old chat when joining a live stream mid-way or seeking in a VOD.
        const playback = this.getPlaybackSnapshot();
        const offsetMs = playback?.offsetMs ?? 0;
        // Keep messages within 60 seconds of current playback, or all if
        // playback position is near the start.
        const cutoffMs = Math.max(0, offsetMs - 60_000);

        const filtered = events.filter((e) => {
          // Always keep SuperChat and Membership regardless of timing
          if (e.message.kind === 'superchat' || e.message.kind === 'membership') return true;
          // For live chat without offset info, keep all (real-time only)
          if (e.offsetMs === undefined) return true;
          // Keep messages near current playback position
          return e.offsetMs >= cutoffMs;
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

      // Deduplicate by message ID — YouTube continuation can return
      // the same actions across consecutive polls.
      const deduped = messages.filter((msg) => {
        if (!msg.id) return true;
        if (this.liveDedupRegistry.has(msg.id)) return false;
        this.liveDedupRegistry.mark(msg.id);
        return true;
      });

      if (deduped.length > 0) {
        this.emitBatch(deduped, isInitialSeed);
      }
    }

    this.lastActionsCount = payload.actions.length;
    this.consecutiveErrors = 0;
    this.liveContinuation = extractNextLiveContinuation(payload.continuations);
  }

  private async refreshLiveContinuation(signal?: AbortSignal): Promise<void> {
    const refreshed = await this.refreshBootstrap(signal);
    if (refreshed) {
      this.liveContinuation = this.bootstrap?.initialContinuation ?? null;
    }
  }
}

// ====================================================================
// Replay chat source — replay polling loop, playerSeek + continuation
// ====================================================================

export class ReplayChatSource extends ChatSource {
  private static readonly MAX_REPLAY_BATCHES = 12;

  private replayMode: ReplayMode | null = null;
  private replayPlayerSeekContinuation: InnertubeContinuationData | null = null;
  private replayContinuation: InnertubeContinuationData | null = null;
  private replayFallbackLastOffsetMs = -1;
  private lastReplayRequestedOffsetMs = -REPLAY_FETCH_MIN_DELTA_MS;
  private replayConsecutiveFailures = 0;
  private replayNextAllowedFetchAt = 0;
  private readonly replayKeyRegistry = new MessageIdRegistry(MAX_TRACKED_REPLAY_KEYS);
  private replayBuffer: ReplayBufferedMessage[] = [];

  protected seedCurrentSession(signal?: AbortSignal): Promise<boolean> {
    return this.initializeReplaySession(signal);
  }

  protected launchCurrentPollLoop(signal?: AbortSignal): void {
    this.launchPollLoop(signal, (loopSignal) => this.runReplayLoop(loopSignal));
  }

  protected resetSessionState(): void {
    super.resetSessionState();
    this.resetReplayState();
  }

  // ---- Replay-specific ----

  private resetReplayState(): void {
    this.replayMode = null;
    this.replayPlayerSeekContinuation = null;
    this.replayContinuation = null;
    this.replayFallbackLastOffsetMs = -1;
    this.lastReplayRequestedOffsetMs = -REPLAY_FETCH_MIN_DELTA_MS;
    this.replayConsecutiveFailures = 0;
    this.replayNextAllowedFetchAt = 0;
    this.replayBuffer = [];
    this.replayKeyRegistry.clear();
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
        extractChatEvents(initialPayload.actions, this.getSettings),
        minimumOffsetMs
      );
      // Catch up fallback replay buffer to current position
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

  private async reinitializeReplaySession(signal?: AbortSignal): Promise<boolean> {
    const refreshed = await this.refreshBootstrap(signal);
    if (!refreshed || !this.bootstrap?.isReplay) {
      return false;
    }

    return this.initializeReplaySession(signal);
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

  private async requestReplayPayload(
    continuation: InnertubeContinuationData,
    signal?: AbortSignal,
    playerOffsetMs?: number
  ): Promise<LiveChatPayload | null> {
    return this.requestPayload(fetchReplayChat, continuation, playerOffsetMs, signal);
  }

  private makeReplayKey(message: ChatMessage, offsetMs: number): string {
    return message.id ?? `${message.kind}:${offsetMs}:${message.author ?? ''}:${message.text}`;
  }

  private trimReplayBuffer(): void {
    if (this.replayBuffer.length <= MAX_BUFFERED_REPLAY_MESSAGES) {
      return;
    }

    const overflow = this.replayBuffer.length - MAX_BUFFERED_REPLAY_MESSAGES;
    if (overflow > 0) {
      this.replayBuffer.splice(0, overflow);
    }
  }

  private bufferReplayEvents(events: ChatEvent[], minimumOffsetMs = 0): number {
    let highestOffsetMs = this.replayFallbackLastOffsetMs;

    for (const event of events) {
      if (event.offsetMs === undefined) {
        continue;
      }

      highestOffsetMs = Math.max(highestOffsetMs, event.offsetMs);
      if (event.offsetMs < minimumOffsetMs) {
        continue;
      }

      const key = this.makeReplayKey(event.message, event.offsetMs);
      if (this.replayKeyRegistry.has(key)) {
        continue;
      }

      this.replayKeyRegistry.mark(key);
      this.insertBufferedEvent(key, event.message, event.offsetMs);
    }

    this.trimReplayBuffer();
    return highestOffsetMs;
  }

  /**
   * Insert a single event into the replay buffer using binary search,
   * avoiding a full sort of the buffer on every batch of incoming events.
   */
  private insertBufferedEvent(key: string, message: ChatMessage, offsetMs: number): void {
    let low = 0;
    let high = this.replayBuffer.length;

    while (low < high) {
      const mid = (low + high) >>> 1;
      const midItem = this.replayBuffer[mid];
      if (!midItem) {
        break;
      }

      if (midItem.offsetMs <= offsetMs) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    this.replayBuffer.splice(low, 0, { key, message, offsetMs });
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
      this.replayKeyRegistry.mark(next.key);
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

  private shouldFetchReplayAtOffset(currentOffsetMs: number): boolean {
    if (this.replayMode !== 'playerSeek' || !this.replayPlayerSeekContinuation) {
      return false;
    }

    if (this.replayBuffer.length === 0) {
      return true;
    }

    return currentOffsetMs - this.lastReplayRequestedOffsetMs >= REPLAY_FETCH_MIN_DELTA_MS;
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
      batches < ReplayChatSource.MAX_REPLAY_BATCHES
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
