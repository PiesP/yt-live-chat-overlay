/**
 * Chat Source
 *
 * Fetches YouTube live chat directly from youtubei endpoints without
 * depending on the visible chat panel DOM.
 */

import type {
  ChatMessage,
  ContentSegment,
  EmojiInfo,
  OverlaySettings,
  SuperChatInfo,
} from '@app-types';
import { parseRgbColor } from '@core/design-tokens';
import { findElementMatch, sleep, throwIfAborted, VIDEO_SELECTORS } from '@core/dom';
import { isAllowedYouTubeImageUrl } from '@core/image-url';
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
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_RETRY_DELAY_MS = 1000;
const DEFAULT_ACTIVITY_TIMEOUT_MS = 30000;
const LIVE_POLL_FALLBACK_DELAY_MS = 4000;
const REPLAY_LOOP_DELAY_MS = 250;
const REPLAY_FETCH_MIN_DELTA_MS = 1000;
const REPLAY_EMIT_TOLERANCE_MS = 300;
const REPLAY_PREFETCH_WINDOW_MS = 5000;
const REPLAY_FALLBACK_CATCHUP_BATCH_LIMIT = 12;
const REPLAY_BUFFER_REFILL_THRESHOLD = 24;
const MAX_BUFFERED_REPLAY_MESSAGES = 300;
const MAX_TRACKED_REPLAY_KEYS = 2000;

type JsonObject = Record<string, unknown>;
type ReplayMode = 'playerSeek' | 'continuation';
type ChatMessageKind = ChatMessage['kind'];

interface ParsedMessageBody {
  text: string;
  content: ContentSegment[];
}

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

interface ChatEvent {
  message: ChatMessage;
  offsetMs?: number;
}

interface ReplayBufferedMessage {
  key: string;
  message: ChatMessage;
  offsetMs: number;
}

interface SupportedRenderer {
  kind: ChatMessageKind;
  renderer: JsonObject;
}

export type MessageCallback = (message: ChatMessage) => void;
export type ChatSourceStartStatus = 'started' | 'retryable' | 'unavailable';

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null;

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const getNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
};

const getBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const asRecord = (value: unknown): JsonObject | null => (isRecord(value) ? value : null);

export class ChatSource {
  private callback: MessageCallback | null = null;
  /** Signals full shutdown to bootstrap/poll work. */
  private lifecycleController: AbortController | null = null;
  /** Signals replacement of the active poll loop during reconnects. */
  private pollController: AbortController | null = null;
  private reconnectInProgress = false;
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
  private readonly recentMessages: ChatMessage[] = [];
  private readonly replaySeenKeys = new Set<string>();
  private readonly replayPendingKeys = new Set<string>();
  private replayBuffer: ReplayBufferedMessage[] = [];

  constructor(private readonly getSettings: (() => Readonly<OverlaySettings>) | null = null) {}

  private createActiveSignal(external?: AbortSignal): AbortSignal | undefined {
    const signals = [
      external,
      this.lifecycleController?.signal,
      this.pollController?.signal,
    ].filter((candidate): candidate is AbortSignal => Boolean(candidate));

    if (signals.length === 0) {
      return undefined;
    }

    if (signals.length === 1) {
      return signals[0];
    }

    return AbortSignal.any(signals);
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

  private launchPollLoop(
    signal: AbortSignal | undefined,
    runner: (loopSignal: AbortSignal | undefined) => Promise<void>
  ): void {
    const generation = ++this.pollGeneration;
    this.pollLoopAlive = true;

    void Promise.resolve()
      .then(() => runner(signal))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
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

  private async resolveBootstrap(options: {
    attempts: number;
    intervalMs: number;
    signal?: AbortSignal;
  }): Promise<ChatBootstrapResolution> {
    const { attempts, intervalMs, signal } = options;
    let lastRetryReason = 'Chat bootstrap did not become available';

    for (let attempt = 1; attempt <= attempts; attempt++) {
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

      if (attempt < attempts) {
        await sleep(intervalMs, signal);
      }
    }

    return {
      status: 'retryable',
      reason: lastRetryReason,
    };
  }

  private logBootstrapFailure(
    context: 'start' | 'reconnect',
    resolution: Exclude<ChatBootstrapResolution, { status: 'ready' }>,
    attempts: number
  ): void {
    const suffix = context === 'reconnect' ? ' (reconnect)' : '';

    if (resolution.status === 'retryable') {
      log.warn(
        `Chat bootstrap was retryable after ${attempts} attempts${suffix}: ${resolution.reason}`
      );
      return;
    }

    log.warn(`Chat source is unavailable${suffix}:`, resolution.reason);
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
    const resolution = await this.resolveBootstrap({
      attempts: 1,
      intervalMs: 0,
      ...(signal ? { signal } : {}),
    });

    if (resolution.status !== 'ready' || !resolution.bootstrap) {
      log.warn('Failed to refresh chat bootstrap:', resolution.reason);
      return false;
    }

    this.bootstrap = resolution.bootstrap;
    return true;
  }

  private handleLivePayload(payload: LiveChatPayload): void {
    const events = this.extractChatEvents(payload.actions);
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
      if (error instanceof DOMException && error.name === 'AbortError') {
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
        return false;
      }

      const nextPlayerSeekContinuation = extractPlayerSeekContinuation(payload.continuations);
      this.bufferReplayEvents(
        this.extractChatEvents(payload.actions),
        Math.max(0, offsetMs - REPLAY_PREFETCH_WINDOW_MS)
      );
      this.replayPlayerSeekContinuation = nextPlayerSeekContinuation;
      this.lastReplayRequestedOffsetMs = offsetMs;

      return nextPlayerSeekContinuation !== null || payload.actions.length > 0;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }

      log.warn('Replay playerSeek request failed:', error);
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
        return false;
      }

      const events = this.extractChatEvents(payload.actions);
      this.replayFallbackLastOffsetMs = this.bufferReplayEvents(events, minimumOffsetMs);
      this.replayContinuation = extractReplayContinuation(payload.continuations);

      return this.replayContinuation !== null || events.length > 0;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }

      log.warn('Replay continuation request failed:', error);
      return false;
    }
  }

  private async catchUpFallbackReplay(
    currentOffsetMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    const minimumOffsetMs = Math.max(0, currentOffsetMs - REPLAY_PREFETCH_WINDOW_MS);
    let batchesFetched = 0;

    while (
      this.replayContinuation &&
      this.replayFallbackLastOffsetMs < minimumOffsetMs &&
      batchesFetched < REPLAY_FALLBACK_CATCHUP_BATCH_LIMIT
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
        this.extractChatEvents(initialPayload.actions),
        minimumOffsetMs
      );
      await this.catchUpFallbackReplay(currentOffsetMs, signal);
      this.flushReplayBuffer(currentOffsetMs);
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
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
        const refreshed = await this.refreshBootstrap(signal);
        if (refreshed) {
          this.liveContinuation = this.bootstrap?.initialContinuation ?? null;
        }
        continue;
      }

      try {
        const payload = await this.requestLivePayload(continuation, signal);
        if (!payload) {
          const refreshed = await this.refreshBootstrap(signal);
          if (refreshed) {
            this.liveContinuation = this.bootstrap?.initialContinuation ?? null;
          }
          continue;
        }

        this.handleLivePayload(payload);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error;
        }

        if (error instanceof YoutubeInnertubeRequestError) {
          log.warn('Live poll request failed:', { status: error.status, message: error.message });
        } else {
          log.warn('Live poll request failed:', error);
        }

        const refreshed = await this.refreshBootstrap(signal);
        if (refreshed) {
          this.liveContinuation = this.bootstrap?.initialContinuation ?? null;
        }
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
        if (!playback.paused && this.shouldFetchReplayAtOffset(currentOffsetMs)) {
          const fetched = await this.fetchReplayPlayerSeek(currentOffsetMs, signal);
          this.flushReplayBuffer(currentOffsetMs);

          if (!fetched) {
            const reinitialized = await this.reinitializeReplaySession(signal);
            if (!reinitialized) {
              await sleep(RECONNECT_RETRY_DELAY_MS, signal);
              continue;
            }
          }
        }
      } else if (this.replayMode === 'continuation' && !playback.paused) {
        await this.catchUpFallbackReplay(currentOffsetMs, signal);
        const minimumOffsetMs = Math.max(0, currentOffsetMs - REPLAY_PREFETCH_WINDOW_MS);
        const needsMoreMessages =
          this.replayContinuation !== null &&
          (this.replayBuffer.length < REPLAY_BUFFER_REFILL_THRESHOLD ||
            this.replayFallbackLastOffsetMs < currentOffsetMs + REPLAY_PREFETCH_WINDOW_MS);

        if (needsMoreMessages) {
          await this.fetchNextReplayFallbackBatch(minimumOffsetMs, signal);
        }

        this.flushReplayBuffer(currentOffsetMs);
      }

      await sleep(REPLAY_LOOP_DELAY_MS, signal);
    }
  }

  private extractChatEvents(actions: readonly unknown[]): ChatEvent[] {
    const events: ChatEvent[] = [];

    for (const action of actions) {
      if (!isRecord(action)) {
        continue;
      }

      const replayAction = asRecord(action.replayChatItemAction);
      if (replayAction) {
        const offsetMs = getNumber(replayAction.videoOffsetTimeMsec);
        const nestedActions = Array.isArray(replayAction.actions) ? replayAction.actions : [];
        for (const nestedAction of nestedActions) {
          const event = this.extractChatEventFromAction(nestedAction, offsetMs);
          if (event) {
            events.push(event);
          }
        }
        continue;
      }

      const event = this.extractChatEventFromAction(action, undefined);
      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  private extractChatEventFromAction(action: unknown, offsetMs?: number): ChatEvent | null {
    if (!isRecord(action)) {
      return null;
    }

    const item = this.extractActionItem(action);
    if (!item) {
      return null;
    }

    const supportedRenderer = this.extractSupportedRenderer(item);
    if (!supportedRenderer) {
      return null;
    }

    const message = this.parseRendererMessage(supportedRenderer.renderer, supportedRenderer.kind);
    if (!message) {
      return null;
    }

    return offsetMs === undefined ? { message } : { message, offsetMs };
  }

  private extractActionItem(action: JsonObject): JsonObject | null {
    const addChatItemAction = asRecord(action.addChatItemAction);
    if (addChatItemAction) {
      const item = asRecord(addChatItemAction.item);
      if (item) {
        return item;
      }
    }

    const replaceChatItemAction = asRecord(action.replaceChatItemAction);
    if (replaceChatItemAction) {
      const item = asRecord(replaceChatItemAction.item);
      if (item) {
        return item;
      }
    }

    return null;
  }

  private extractSupportedRenderer(item: JsonObject): SupportedRenderer | null {
    const textRenderer = asRecord(item.liveChatTextMessageRenderer);
    if (textRenderer) {
      return { kind: 'text', renderer: textRenderer };
    }

    const paidMessageRenderer = asRecord(item.liveChatPaidMessageRenderer);
    if (paidMessageRenderer) {
      return { kind: 'superchat', renderer: paidMessageRenderer };
    }

    const membershipRenderer = asRecord(item.liveChatMembershipItemRenderer);
    if (membershipRenderer) {
      return { kind: 'membership', renderer: membershipRenderer };
    }

    return null;
  }

  private parseRendererMessage(renderer: JsonObject, kind: ChatMessageKind): ChatMessage | null {
    const author = this.extractDisplayText(renderer.authorName);
    if (!author) {
      return null;
    }

    const authorType = this.extractAuthorType(renderer.authorBadges);
    const parsedBody = this.extractRendererBody(renderer, kind, authorType);
    if (!parsedBody) {
      return null;
    }

    const message: ChatMessage = {
      text: parsedBody.text,
      kind,
      timestamp: Date.now(),
    };

    const id = getString(renderer.id);
    if (id) {
      message.id = id;
    }

    if (parsedBody.content.length > 0) {
      message.content = parsedBody.content;
    }

    message.author = author;
    message.authorType = authorType;

    const authorPhotoUrl = this.extractThumbnailUrl(renderer.authorPhoto);
    if (authorPhotoUrl) {
      message.authorPhotoUrl = authorPhotoUrl;
    }

    if (kind === 'superchat') {
      const superChatInfo = this.parseSuperChatInfo(renderer);
      if (superChatInfo) {
        message.superChat = superChatInfo;
      }
    }

    return message;
  }

  private extractRendererBody(
    renderer: JsonObject,
    kind: ChatMessageKind,
    authorType: NonNullable<ChatMessage['authorType']>
  ): ParsedMessageBody | null {
    const messageData = renderer.message;
    const parsedBody =
      kind === 'membership' && !isRecord(messageData)
        ? { text: '', content: [] }
        : this.parseMessageContent(messageData);

    if (kind === 'text' && !this.isSubstantialText(parsedBody.text, authorType)) {
      return null;
    }

    return parsedBody;
  }

  private extractDisplayText(value: unknown): string | undefined {
    if (!isRecord(value)) {
      return undefined;
    }

    const simpleText = getString(value.simpleText);
    if (simpleText) {
      return simpleText.trim() || undefined;
    }

    const runs = Array.isArray(value.runs) ? value.runs : [];
    const text = runs
      .map((run) => {
        if (!isRecord(run)) {
          return '';
        }

        const runText = getString(run.text);
        if (runText) {
          return runText;
        }

        const emoji = asRecord(run.emoji);
        return emoji ? this.getEmojiAlt(emoji) : '';
      })
      .join('')
      .trim();

    return text || undefined;
  }

  private parseMessageContent(value: unknown): ParsedMessageBody {
    if (!isRecord(value)) {
      return { text: '', content: [] };
    }

    const simpleText = getString(value.simpleText);
    if (simpleText) {
      return {
        text: this.normalizeText(simpleText),
        content: [{ type: 'text', content: simpleText }],
      };
    }

    const runs = Array.isArray(value.runs) ? value.runs : [];
    const segments: ContentSegment[] = [];
    let plainText = '';

    for (const run of runs) {
      if (!isRecord(run)) {
        continue;
      }

      const runText = getString(run.text);
      if (runText !== undefined) {
        if (runText.length > 0) {
          segments.push({ type: 'text', content: runText });
          plainText += runText;
        }
        continue;
      }

      const emojiData = asRecord(run.emoji);
      if (!emojiData) {
        continue;
      }

      const emoji = this.parseEmoji(emojiData);
      if (emoji) {
        segments.push({ type: 'emoji', emoji });
        plainText += emoji.alt || '[emoji]';
        continue;
      }

      plainText += this.getEmojiAlt(emojiData) || '[emoji]';
    }

    return {
      text: this.normalizeText(plainText),
      content: segments,
    };
  }

  private getEmojiAlt(emojiData: JsonObject): string {
    const shortcuts = Array.isArray(emojiData.shortcuts)
      ? emojiData.shortcuts.filter((shortcut): shortcut is string => typeof shortcut === 'string')
      : [];

    return shortcuts[0] ?? getString(emojiData.emojiId) ?? '';
  }

  private parseEmoji(emojiData: JsonObject): EmojiInfo | null {
    const image = asRecord(emojiData.image);
    const thumbnail = image ? this.extractBestThumbnail(image) : null;
    if (!thumbnail) {
      return null;
    }

    const emojiInfo: EmojiInfo = {
      type: this.detectEmojiType(emojiData),
      url: thumbnail.url,
      alt: this.getEmojiAlt(emojiData),
    };

    if (thumbnail.width !== undefined) {
      emojiInfo.width = thumbnail.width;
    }

    if (thumbnail.height !== undefined) {
      emojiInfo.height = thumbnail.height;
    }

    const id = getString(emojiData.emojiId);
    if (id) {
      emojiInfo.id = id;
    }

    return emojiInfo;
  }

  private detectEmojiType(emojiData: JsonObject): EmojiInfo['type'] {
    const searchTerms = Array.isArray(emojiData.searchTerms)
      ? emojiData.searchTerms
          .filter((term): term is string => typeof term === 'string')
          .map((term) => term.toLowerCase())
      : [];

    if (searchTerms.some((term) => term.includes('member'))) {
      return 'member';
    }

    return getBoolean(emojiData.isCustomEmoji) ? 'custom' : 'standard';
  }

  private extractBestThumbnail(
    value: unknown
  ): { url: string; width?: number; height?: number } | null {
    if (!isRecord(value)) {
      return null;
    }

    const thumbnails = Array.isArray(value.thumbnails)
      ? value.thumbnails
      : Array.isArray(value.sources)
        ? value.sources
        : [];

    let bestThumbnail: { url: string; width?: number; height?: number } | null = null;
    let bestWidth = -1;

    for (const candidate of thumbnails) {
      if (!isRecord(candidate)) {
        continue;
      }

      const url = getString(candidate.url);
      if (!url || !isAllowedYouTubeImageUrl(url)) {
        continue;
      }

      const width = getNumber(candidate.width);
      if ((width ?? 0) < bestWidth) {
        continue;
      }

      bestWidth = width ?? 0;
      const nextThumbnail: { url: string; width?: number; height?: number } = { url };
      if (width !== undefined) {
        nextThumbnail.width = width;
      }

      const height = getNumber(candidate.height);
      if (height !== undefined) {
        nextThumbnail.height = height;
      }

      bestThumbnail = nextThumbnail;
    }

    return bestThumbnail;
  }

  private extractThumbnailUrl(value: unknown): string | undefined {
    return this.extractBestThumbnail(value)?.url;
  }

  private extractAuthorType(value: unknown): NonNullable<ChatMessage['authorType']> {
    if (!Array.isArray(value)) {
      return 'normal';
    }

    for (const badgeEntry of value) {
      if (!isRecord(badgeEntry)) {
        continue;
      }

      const badge =
        asRecord(badgeEntry.liveChatAuthorBadgeRenderer) ??
        asRecord(badgeEntry.metadataBadgeRenderer) ??
        badgeEntry;
      const iconType =
        getString(asRecord(badge.icon)?.iconType)?.toLowerCase() ??
        getString(badge.style)?.toLowerCase() ??
        '';
      const label = [
        getString(badge.tooltip),
        getString(asRecord(asRecord(badge.accessibility)?.accessibilityData)?.label),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      if (iconType.includes('owner') || label.includes('owner')) {
        return 'owner';
      }

      if (iconType.includes('moderator') || label.includes('moderator') || label.includes('mod')) {
        return 'moderator';
      }

      if (iconType.includes('member') || label.includes('member') || label.includes('membership')) {
        return 'member';
      }

      if (iconType.includes('verified') || label.includes('verified')) {
        return 'verified';
      }
    }

    return 'normal';
  }

  private normalizeText(text: string): string {
    let normalized = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
    normalized = normalized.replace(/\s+/g, ' ').trim();

    if (normalized.length > 80) {
      normalized = `${normalized.substring(0, 77)}...`;
    }

    return normalized;
  }

  private isSubstantialText(
    text: string,
    authorType: NonNullable<ChatMessage['authorType']>
  ): boolean {
    const settings = this.getSettings?.();
    if (settings?.allowShortTextMessages) {
      return true;
    }

    if (authorType === 'moderator' || authorType === 'owner' || authorType === 'member') {
      return true;
    }

    const stripped = text
      .replace(/\[.*?\]/g, '')
      .replace(/:[-\w]+:/g, '')
      .trim();

    const minLength = Math.max(1, settings?.minTextLength ?? 3);
    return stripped.length >= minLength;
  }

  private colorIntToCss(value: unknown): string | undefined {
    const intValue = getNumber(value);
    if (intValue === undefined) {
      return undefined;
    }

    const argb = intValue >>> 0;
    const alpha = ((argb >>> 24) & 0xff) / 255;
    const red = (argb >>> 16) & 0xff;
    const green = (argb >>> 8) & 0xff;
    const blue = argb & 0xff;

    if (alpha >= 0.999) {
      return `rgb(${red}, ${green}, ${blue})`;
    }

    return `rgba(${red}, ${green}, ${blue}, ${Number(alpha.toFixed(3))})`;
  }

  private parseSuperChatInfo(renderer: JsonObject): SuperChatInfo | null {
    const amount = this.extractDisplayText(renderer.purchaseAmountText);
    if (!amount) {
      log.warn('Super Chat renderer did not include purchaseAmountText');
      return null;
    }

    const backgroundColor = this.colorIntToCss(renderer.bodyBackgroundColor);
    const headerBackgroundColor = this.colorIntToCss(renderer.headerBackgroundColor);
    const sourceColor = headerBackgroundColor || backgroundColor;
    const tier = this.determineSuperChatTier(sourceColor);

    const superChatInfo: SuperChatInfo = {
      amount,
      tier,
    };

    const currency = amount.match(/[A-Z]{3}/)?.[0];
    if (currency) {
      superChatInfo.currency = currency;
    }

    if (backgroundColor) {
      superChatInfo.backgroundColor = backgroundColor;
    }

    if (headerBackgroundColor) {
      superChatInfo.headerBackgroundColor = headerBackgroundColor;
    }

    const stickerUrl = this.extractThumbnailUrl(renderer.headerOverlayImage);
    if (stickerUrl) {
      superChatInfo.stickerUrl = stickerUrl;
    }

    return superChatInfo;
  }

  private determineSuperChatTier(backgroundColor: string | undefined): SuperChatInfo['tier'] {
    const rgb = backgroundColor ? parseRgbColor(backgroundColor) : null;
    if (!rgb) return 'blue';

    const { r, g, b } = rgb;

    if (r > 200 && g < 100 && b < 100) return 'red';
    if (r > 200 && g < 100 && b > 80) return 'magenta';
    if (r > 200 && g > 100 && g < 150 && b < 50) return 'orange';
    if (r > 200 && g > 180 && b < 100) return 'yellow';
    if (r < 100 && g > 200 && b > 150) return 'green';
    if (r < 100 && g > 150 && b > 200) return 'cyan';
    return 'blue';
  }

  /**
   * Start monitoring chat
   */
  async start(callback: MessageCallback, signal?: AbortSignal): Promise<ChatSourceStartStatus> {
    this.lifecycleController?.abort();
    this.pollController?.abort();

    this.lifecycleController = new AbortController();
    this.pollController = new AbortController();
    this.callback = callback;
    this.reconnectInProgress = false;
    this.resetSessionState();

    const combinedSignal = this.createActiveSignal(signal);

    try {
      const bootstrapResolution = await this.resolveBootstrap({
        attempts: BOOTSTRAP_ATTEMPTS,
        intervalMs: BOOTSTRAP_RETRY_DELAY_MS,
        ...(combinedSignal ? { signal: combinedSignal } : {}),
      });

      if (bootstrapResolution.status !== 'ready' || !bootstrapResolution.bootstrap) {
        this.logBootstrapFailure('start', bootstrapResolution, BOOTSTRAP_ATTEMPTS);
        return bootstrapResolution.status === 'unavailable' ? 'unavailable' : 'retryable';
      }

      this.bootstrap = bootstrapResolution.bootstrap;

      const seeded = this.bootstrap.isReplay
        ? await this.initializeReplaySession(combinedSignal)
        : await this.initializeLiveSession(combinedSignal);
      if (!seeded) {
        return 'retryable';
      }

      this.launchPollLoop(
        combinedSignal,
        this.bootstrap.isReplay ? this.runReplayLoop.bind(this) : this.runLiveLoop.bind(this)
      );

      log.info(
        `Chat monitoring started successfully via youtubei (${this.bootstrap.isReplay ? 'replay' : 'live'})`
      );
      return 'started';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError' && this.isLifecycleAbort()) {
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

  /**
   * Check if chat polling is active recently.
   */
  isActive(timeoutMs = DEFAULT_ACTIVITY_TIMEOUT_MS): boolean {
    const now = Date.now();
    return now - this.lastActivityTime < Math.max(0, timeoutMs);
  }

  getHealthSnapshot(options: ChatHealthSnapshotOptions = {}): ChatHealthSnapshot {
    const activeTimeoutMs = options.activeTimeoutMs ?? DEFAULT_ACTIVITY_TIMEOUT_MS;

    return {
      observerAlive: this.isObserverAlive(),
      recentlyActive: this.isActive(activeTimeoutMs),
    };
  }

  /**
   * Compatibility shim for the existing watchdog contract.
   * In the fetch-based source, "observer alive" means the poll loop is active.
   */
  isObserverAlive(): boolean {
    return (
      this.pollLoopAlive &&
      this.pollController !== null &&
      !this.pollController.signal.aborted &&
      this.callback !== null
    );
  }

  /**
   * Re-bootstrap youtubei polling and clear buffered replay state.
   */
  async reconnect(signal?: AbortSignal): Promise<boolean> {
    if (!this.callback || this.reconnectInProgress || this.isLifecycleAbort()) return false;

    this.reconnectInProgress = true;
    this.pollController?.abort();
    this.pollController = new AbortController();
    this.pollLoopAlive = false;
    this.resetSessionState();

    const combinedSignal = this.createActiveSignal(signal);

    try {
      log.info('Reconnecting youtubei chat polling...');

      const bootstrapResolution = await this.resolveBootstrap({
        attempts: RECONNECT_ATTEMPTS,
        intervalMs: RECONNECT_RETRY_DELAY_MS,
        ...(combinedSignal ? { signal: combinedSignal } : {}),
      });

      if (bootstrapResolution.status !== 'ready' || !bootstrapResolution.bootstrap) {
        this.logBootstrapFailure('reconnect', bootstrapResolution, RECONNECT_ATTEMPTS);
        return false;
      }

      this.bootstrap = bootstrapResolution.bootstrap;

      const seeded = this.bootstrap.isReplay
        ? await this.initializeReplaySession(combinedSignal)
        : await this.initializeLiveSession(combinedSignal);
      if (!seeded) {
        return false;
      }

      this.launchPollLoop(
        combinedSignal,
        this.bootstrap.isReplay ? this.runReplayLoop.bind(this) : this.runLiveLoop.bind(this)
      );

      log.info('youtubei chat polling reconnected');
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError' && this.isLifecycleAbort()) {
        return false;
      }

      throw error;
    } finally {
      this.reconnectInProgress = false;
    }
  }

  getLatestMessages(limit: number): ChatMessage[] {
    if (limit <= 0) return [];
    return this.recentMessages.slice(-limit);
  }
}
