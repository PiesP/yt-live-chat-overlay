// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * ChatSession owns shared bootstrap, cancellation, pause and delivery state.
 * Live and replay drivers receive a stable set of operations, never its mutable state.
 */

import type { ChatMessage, OverlaySettings, Pauseable } from '@app-types';
import { logBootstrapFailure, refreshBootstrap, resolveBootstrap } from '@app/bootstrap-resolver';
import {
  type ChatBootstrapData,
  getLiveChatPayload,
  type LiveChatPayload,
} from '@chat/youtube/api';
import type { InnertubeContinuationData } from '@chat/youtube/continuation';
import { sleep } from '@piesp/browser-core/async';
import { isAbortError } from '@piesp/browser-core/error';
import { findElementMatch, VIDEO_SELECTORS } from '@util/dom';
import { createLogger } from '@util/logging';
import { createMessageIdRegistry } from '@util/message-id-registry';

const log = createLogger('ChatSource');

// activityTimeoutMs — read from this.getSettings()

interface ChatHealthSnapshotOptions {
  activeTimeoutMs?: number;
}

export interface ChatHealthSnapshot {
  observerAlive: boolean;
  recentlyActive: boolean;
  /** True when the chat source is intentionally backing off from fetches (not a crash). */
  isInBackoff: boolean;
  /** Number of consecutive poll errors (0 = healthy). LiveChatSource tracks this. */
  consecutiveErrors: number;
}

export class LiveChatProtocolError extends Error {
  override readonly name = 'LiveChatProtocolError';
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
export type ChatSourceStartStatus = 'started' | 'retryable' | 'unavailable' | 'waiting';

// ── Inline helpers (formerly separate modules) ─────────────────────

const RECENT_MESSAGE_BUFFER_SIZE = 100;

class MessageBuffer {
  private readonly messages: ChatMessage[] = [];

  push(message: ChatMessage): void {
    this.messages.push(message);
    const overflow = this.messages.length - RECENT_MESSAGE_BUFFER_SIZE;
    if (overflow > 0) {
      this.messages.splice(0, overflow);
    }
  }

  getLatest(limit: number): ChatMessage[] {
    if (limit <= 0) return [];
    return this.messages.slice(-limit);
  }

  clear(): void {
    this.messages.length = 0;
  }
}

const pollLoopLog = createLogger('PollLoop');

class PollLoopManager {
  private generation = 0;
  private alive = false;

  launch(runner: (signal?: AbortSignal) => Promise<void>, signal?: AbortSignal): void {
    const generation = ++this.generation;
    this.alive = true;

    void (async () => {
      try {
        await runner(signal);
      } catch (error: unknown) {
        if (!isAbortError(error)) {
          pollLoopLog.warn('Polling loop stopped unexpectedly:', error);
        }
      } finally {
        if (generation === this.generation) {
          this.alive = false;
        }
      }
    })();
  }

  stop(): void {
    this.generation += 1;
    this.alive = false;
  }

  isAlive(): boolean {
    return this.alive;
  }
}

/** Shared request/delivery operations borrowed by the actual protocol drivers. */
export interface ChatProtocolOperations {
  readonly getSettings: () => Readonly<OverlaySettings>;
  getBootstrap(): ChatBootstrapData | null;
  getPlaybackSnapshot(): PlaybackSnapshot | null;
  refreshBootstrap(
    signal?: AbortSignal,
    accept?: (data: ChatBootstrapData) => boolean
  ): Promise<ChatBootstrapData | null>;
  emitBatch(messages: ChatMessage[], isInitialSeed: boolean, signal?: AbortSignal): void;
  requestPayload<TCallArgs extends unknown[]>(
    fetchFn: (
      bootstrap: ChatBootstrapData,
      continuation: InnertubeContinuationData,
      ...args: TCallArgs
    ) => Promise<unknown>,
    continuation: InnertubeContinuationData,
    ...fetchArgs: TCallArgs
  ): Promise<LiveChatPayload | null>;
  readonly isKnownReplacementTarget: (id: string) => boolean;
}

export interface LiveChatSessionOperations extends ChatProtocolOperations {
  pollWhilePaused(timeoutMs: number, pollIntervalMs?: number, signal?: AbortSignal): Promise<void>;
  waitWhilePaused(signal?: AbortSignal): Promise<void>;
}

export interface ReplayChatSessionOperations extends ChatProtocolOperations {
  readonly paused: boolean;
  readonly canDeliver: boolean;
  isVisibilityOnlyPause(): boolean;
  markActivity(): void;
  requestReplaySeek(): void;
}

interface ChatDriverLifecycle {
  reset(): void;
  seed(signal?: AbortSignal): Promise<boolean>;
}

export interface PollingChatSessionDriver extends ChatDriverLifecycle {
  readonly scheduling: 'poll-loop';
  run(signal?: AbortSignal): Promise<void>;
}

export interface ScheduledChatSessionDriver extends ChatDriverLifecycle {
  readonly scheduling: 'independent';
  launch(signal?: AbortSignal): void;
  isObserverAlive(): boolean;
}

export type ChatSessionDriver = PollingChatSessionDriver | ScheduledChatSessionDriver;

export class ChatSession implements Pauseable {
  readonly getSettings: () => Readonly<OverlaySettings>;
  private callback: MessageCallback | null = null;
  private pollController: AbortController | null = null;
  private readonly pollLoopManager = new PollLoopManager();
  /**
   * Set of active pause reasons. When non-empty, the chat source is paused.
   * Keys: 'visibility' (tab hidden), 'video' (user pause, buffering, PiP).
   * Multiple components can independently add/remove reasons without
   * overwriting each other — the source resumes only when ALL are removed.
   */
  private pauseReasons = new Set<string>();

  /** Whether any pause reason is currently active. */
  get paused(): boolean {
    return this.pauseReasons.size > 0;
  }
  private pauseAbortController: AbortController | null = null;
  private lastActivityTime = 0;
  private bootstrap: ChatBootstrapData | null = null;
  private bootstrapPreseeded = false;
  private readonly messageBuffer = new MessageBuffer();
  private deliveryGeneration = 0;

  private static readonly SEEN_IDS_MAX = 5000;

  /**
   * Message IDs already delivered this session (deduplicates fetch-interceptor
   * and poll-loop messages — both capture the same YouTube API responses).
   * Capped at SEEN_IDS_MAX to prevent unbounded growth during long sessions.
   */
  private readonly seenMessageIds = createMessageIdRegistry(ChatSession.SEEN_IDS_MAX);

  /** Attest replacement targets already accepted by this source session. */
  readonly isKnownReplacementTarget = (id: string): boolean => this.seenMessageIds.has(id);

  private readonly driver: ChatSessionDriver;
  constructor(
    getSettings: () => Readonly<OverlaySettings>,
    createDriver: (session: ChatSession) => ChatSessionDriver
  ) {
    this.getSettings = getSettings;
    this.driver = createDriver(this);
  }

  getBootstrap(): ChatBootstrapData | null {
    return this.bootstrap;
  }

  get canDeliver(): boolean {
    return this.callback !== null;
  }

  /** The session owns delivery invalidation; replay can request only a seek transition. */
  requestReplaySeek(): void {
    this.resetMessageDeliveryState();
  }

  /**
   * Pre-seed bootstrap data from a prior resolution (e.g. factory call).
   * When set, bootstrapAndLaunchPolling skips the resolver's own bootstrap
   * fetch, eliminating a duplicate ~200KB watch page HTTP request.
   */
  setInitialBootstrap(data: ChatBootstrapData): void {
    this.bootstrap = data;
    this.bootstrapPreseeded = true;
  }

  async start(callback: MessageCallback, signal?: AbortSignal): Promise<ChatSourceStartStatus> {
    this.retire();

    const initialBootstrap = this.bootstrapPreseeded ? this.bootstrap : null;
    this.bootstrapPreseeded = false;
    const pollController = new AbortController();
    this.pollController = pollController;
    this.callback = callback;
    this.resetSessionState();
    // Factory-provided bootstrap is consumed once, after the old driver retires.
    this.bootstrap = initialBootstrap;

    const combinedSignal = signal
      ? AbortSignal.any([pollController.signal, signal])
      : pollController.signal;

    try {
      return await this.bootstrapAndLaunchPolling(combinedSignal);
    } catch (error: unknown) {
      if (isAbortError(error)) return 'retryable';
      throw error;
    }
  }

  stop(): void {
    this.retire();
    this.resetSessionState();
    log.debug('chat.source.monitoring-stopped');
  }

  private retire(): void {
    this.pollController?.abort();
    this.pollController = null;
    this.pollLoopManager.stop();
    this.callback = null;
    this.driver.reset();
  }

  isActive(timeoutMs = this.getSettings().activityTimeoutMs): boolean {
    return Date.now() - this.lastActivityTime < Math.max(0, timeoutMs);
  }

  getHealthSnapshot(options: ChatHealthSnapshotOptions = {}): ChatHealthSnapshot {
    const activeTimeoutMs = options.activeTimeoutMs ?? this.getSettings().activityTimeoutMs;

    return {
      observerAlive:
        this.driver.scheduling === 'independent'
          ? this.driver.isObserverAlive()
          : this.isObserverAlive(),
      recentlyActive: this.isActive(activeTimeoutMs),
      isInBackoff: false,
      consecutiveErrors: 0,
    };
  }

  getLatestMessages(limit: number): ChatMessage[] {
    return this.messageBuffer.getLatest(limit);
  }

  private isObserverAlive(): boolean {
    return (
      this.pollLoopManager.isAlive() &&
      this.pollController !== null &&
      !this.pollController.signal.aborted &&
      this.callback !== null
    );
  }

  getPlaybackSnapshot(): PlaybackSnapshot | null {
    const match = findElementMatch<HTMLVideoElement>(VIDEO_SELECTORS);
    if (!match) return null;
    const { element: video } = match;
    if (!Number.isFinite(video.currentTime)) return null;
    return {
      offsetMs: Math.max(0, Math.floor(video.currentTime * 1000)),
      paused: video.paused,
    };
  }

  markActivity(): void {
    this.lastActivityTime = Date.now();
  }

  /**
   * Poll at short intervals until playback is no longer paused or timeout elapses.
   * Used by the live poll loop to handle brief pauses without restarting the session.
   */
  async pollWhilePaused(
    timeoutMs: number,
    pollIntervalMs = 250,
    signal?: AbortSignal
  ): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      await sleep(pollIntervalMs, signal);
      const current = this.getPlaybackSnapshot();
      if (!current?.paused) break;
    }
  }

  /**
   * Re-fetch bootstrap data from the resolver. Updates this.bootstrap on success.
   * Returns the fresh bootstrap or null on failure.
   */
  async refreshBootstrap(
    signal?: AbortSignal,
    accept: (data: ChatBootstrapData) => boolean = () => true
  ): Promise<ChatBootstrapData | null> {
    const generation = this.deliveryGeneration;
    const result = await refreshBootstrap(signal);
    if (signal?.aborted || generation !== this.deliveryGeneration || !result || !accept(result))
      return null;
    this.bootstrap = result;
    return result;
  }

  emitBatch(messages: ChatMessage[], isInitialSeed: boolean, signal?: AbortSignal): void {
    if (signal?.aborted || !this.callback || messages.length === 0) return;
    const deduped = this.filterNewMessages(messages);
    if (deduped.length === 0) return;
    for (const message of deduped) {
      this.messageBuffer.push(message);
    }
    this.callback(deduped, isInitialSeed);
  }

  async requestPayload<TCallArgs extends unknown[]>(
    fetchFn: (
      bootstrap: ChatBootstrapData,
      continuation: InnertubeContinuationData,
      ...args: TCallArgs
    ) => Promise<unknown>,
    continuation: InnertubeContinuationData,
    ...fetchArgs: TCallArgs
  ): Promise<LiveChatPayload | null> {
    if (!this.bootstrap) return null;
    const generation = this.deliveryGeneration;

    // Mark activity BEFORE the fetch so the health watchdog doesn't
    // penalize transient network failures — the source IS actively
    // trying, even if the current request failed. A structurally invalid
    // response restores the previous value below because it is not a
    // successful source activity signal.
    const previousActivityTime = this.lastActivityTime;
    this.markActivity();

    const response = await fetchFn(this.bootstrap, continuation, ...fetchArgs);
    if (generation !== this.deliveryGeneration) return null;
    const payload = getLiveChatPayload(response);
    if (!payload) {
      this.lastActivityTime = previousActivityTime;
      log.warn('chat.source.parse-failed');
      throw new LiveChatProtocolError('Live chat response is missing its continuation payload');
    }

    return payload;
  }

  private resetSessionState(): void {
    this.bootstrap = null;
    this.lastActivityTime = 0;
    this.resetMessageDeliveryState();
  }

  /** Start a fresh message-delivery epoch without discarding bootstrap state. */
  private resetMessageDeliveryState(): void {
    this.deliveryGeneration += 1;
    this.messageBuffer.clear();
    this.seenMessageIds.clear();
  }

  /**
   * Set a specific pause reason. When any reason is active, the chat source pauses.
   * When all reasons are removed, the source resumes.
   *
   * Callers should use distinct reason keys:
   * - 'visibility' — tab hidden (handleVisibility in RuntimeManager)
   * - 'video' — user pause, buffering, or PiP (VideoPauseController)
   */
  setPauseReason(reason: string, paused: boolean): void {
    if (paused) {
      const wasEmpty = this.pauseReasons.size === 0;
      this.pauseReasons.add(reason);
      if (wasEmpty) {
        // Transitioning from unpaused → paused: create a fresh wake signal.
        this.pauseAbortController = new AbortController();
      }
    } else {
      this.pauseReasons.delete(reason);
      if (this.pauseReasons.size === 0) {
        // All reasons removed — wake any sleeping waitWhilePaused().
        this.pauseAbortController?.abort();
        this.pauseAbortController = null;
        this.markActivity();
      }
    }
  }

  /** Whether visibility is the sole reason this source is currently paused. */
  isVisibilityOnlyPause(): boolean {
    return this.pauseReasons.size === 1 && this.pauseReasons.has('visibility');
  }

  /**
   * @deprecated Use setPauseReason(reason, paused) with a specific reason key.
   * Kept for backward compatibility with the Pauseable interface.
   */
  setPaused(paused: boolean): void {
    this.setPauseReason('general', paused);
  }

  async waitWhilePaused(sessionSignal?: AbortSignal): Promise<void> {
    while (this.pauseReasons.size > 0) {
      if (sessionSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const pauseSignal = this.pauseAbortController?.signal;
      if (!pauseSignal || pauseSignal.aborted) continue;
      const wakeSignal = sessionSignal
        ? AbortSignal.any([pauseSignal, sessionSignal])
        : pauseSignal;
      if (!wakeSignal.aborted) {
        await new Promise<void>((resolve) => {
          wakeSignal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      if (sessionSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
    }
  }

  /**
   * Inject messages obtained from an external source (e.g. fetch interceptor
   * that eavesdrops on YouTube's own chat requests).  Messages bypass the
   * normal poll loop and are delivered through the standard callback path
   * so they flow through dedup, spread emission, and the renderer.
   */
  injectExternalMessages(messages: ChatMessage[]): void {
    if (!this.callback || messages.length === 0) return;

    // ── Defensive recovery from stuck pause reasons ──
    // If pauseReasons is non-empty but the tab is visible and the video is playing,
    // the pause state has likely drifted due to interleaved visibility and
    // video-pause event ordering. Force-unpause to recover message delivery.
    // Without this, the fetch interceptor and DOM watcher would silently
    // drop all messages while YouTube's own chat panel continues to update.
    if (this.pauseReasons.size > 0 && document.visibilityState !== 'hidden') {
      const playback = this.getPlaybackSnapshot();
      if (playback && !playback.paused) {
        log.warn(
          'pauseReasons state drift detected — tab visible + video playing but reasons active. ' +
            'Force-clearing pause reasons to recover message delivery.'
        );
        // Abort any pending pause listeners before force-unpausing,
        // otherwise the orphaned pauseAbortController signal lingers.
        // Only clear 'general' (from deprecated setPaused path),
        // keep 'visibility', 'video' — managed by their own controllers.
        // Using clear() would also wipe the video pause reason set during
        // buffering (waiting event), allowing chat to render mid-buffer.
        this.pauseReasons.delete('general');
        if (this.pauseReasons.size === 0) {
          // General was the last reason — wake up any waitWhilePaused
          // loop and mark as active for the health watchdog.
          this.pauseAbortController?.abort();
          this.pauseAbortController = null;
          this.markActivity();
        }
      }
    }

    // YouTube may complete an already-started chat request while the video is
    // paused. Let those messages reach the renderer's bounded video-pause buffer;
    // visibility/general pauses still suppress delivery because they do not
    // have an equivalent renderer buffer.
    const isVideoOnlyPause = this.pauseReasons.size === 1 && this.pauseReasons.has('video');
    if (this.pauseReasons.size > 0 && !isVideoOnlyPause) return;
    const deduped = this.filterNewMessages(messages);
    if (deduped.length === 0) return;
    for (const message of deduped) {
      this.messageBuffer.push(message);
    }
    this.callback(deduped, false);
  }

  /** Filter out messages already seen this session, tracking new ones. */
  private filterNewMessages(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];
    for (const msg of messages) {
      // replaceChatItemAction messages carry the same ID as the original
      // message they replace (e.g. SuperChat amount update, deletion).
      // They must bypass dedup so the renderer can apply the update.
      // Only track 'add' (or untagged) messages in seenMessageIds.
      if (msg.actionType !== 'replace') {
        const dedupKey = msg.id ?? this.computeContentHash(msg);
        if (this.seenMessageIds.has(dedupKey)) continue;
        this.seenMessageIds.mark(dedupKey);
      }
      result.push(msg);
    }
    return result;
  }

  /**
   * H4: Compute a deduplication hash for messages without an id.
   * Combines author, text, and timestamp to create a unique-enough key.
   */
  private computeContentHash(msg: ChatMessage): string {
    const text = msg.text ?? '';
    const author = msg.author ?? '';
    const ts = msg.videoOffsetMs ?? msg.timestamp ?? 0;
    return `hash:${author}:${ts}:${text.slice(0, 80)}`;
  }

  private async bootstrapAndLaunchPolling(signal?: AbortSignal): Promise<ChatSourceStartStatus> {
    const generation = this.deliveryGeneration;
    // Skip resolver when bootstrap was pre-seeded by factory call
    if (!this.bootstrap) {
      const bootstrapResolution = await resolveBootstrap(signal);

      if (signal?.aborted || generation !== this.deliveryGeneration) return 'retryable';

      if (bootstrapResolution.status !== 'ready') {
        logBootstrapFailure(bootstrapResolution);
        if (bootstrapResolution.status === 'waiting') return 'waiting';
        return bootstrapResolution.status === 'unavailable' ? 'unavailable' : 'retryable';
      }

      this.bootstrap = bootstrapResolution.data;
    }

    if (signal?.aborted || generation !== this.deliveryGeneration) return 'retryable';
    const seeded = await this.driver.seed(signal);
    if (!seeded) {
      return 'retryable';
    }

    if (signal?.aborted || generation !== this.deliveryGeneration) return 'retryable';
    const driver = this.driver;
    if (driver.scheduling === 'poll-loop') {
      this.pollLoopManager.launch((loopSignal) => driver.run(loopSignal), signal);
    } else {
      driver.launch(signal);
    }

    log.debug('chat.source.poll-started');

    return 'started';
  }
}
