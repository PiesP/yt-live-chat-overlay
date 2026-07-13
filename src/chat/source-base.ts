// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * ChatSource abstract base — shared bootstrap, parser, settings, health tracking.
 *
 * Extracted from chat-source.ts to break the circular dependency between
 * the base class and its concrete implementations (LiveChatSource, ReplayChatSource).
 */

import { logBootstrapFailure, refreshBootstrap, resolveBootstrap } from '@app/bootstrap-resolver';
import type { ChatMessage, OverlaySettings, Pauseable } from '@app-types';
import type { ChatBootstrapData, LiveChatPayload } from '@chat/youtube/api';
import { getLiveChatPayload } from '@chat/youtube/api';
import type { InnertubeContinuationData } from '@chat/youtube/continuation';
import { findElementMatch, isAbortError, sleep, VIDEO_SELECTORS } from '@util/dom';
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

export abstract class ChatSource implements Pauseable {
  protected readonly getSettings: () => Readonly<OverlaySettings>;
  protected callback: MessageCallback | null = null;
  private pollController: AbortController | null = null;
  private readonly pollLoopManager = new PollLoopManager();
  protected chatPaused = false;
  private pauseAbortController: AbortController | null = null;
  private lastActivityTime = 0;
  protected bootstrap: ChatBootstrapData | null = null;
  private readonly messageBuffer = new MessageBuffer();

  /**
   * Optional provider for the current burst EMA rate (msg/s).
   * When set, LiveChatSource uses it for sub-poll-interval burst reactivity.
   * Wired by RuntimeSession from the renderer's BurstDetector.
   */
  burstRateProvider?: () => number;

  private static readonly SEEN_IDS_MAX = 5000;

  /**
   * Message IDs already delivered this session (deduplicates fetch-interceptor
   * and poll-loop messages — both capture the same YouTube API responses).
   * Capped at SEEN_IDS_MAX to prevent unbounded growth during long sessions.
   */
  private readonly seenMessageIds = createMessageIdRegistry(ChatSource.SEEN_IDS_MAX);

  private static readonly PAUSE_POLL_INTERVAL_MS = 250;

  constructor(getSettings: () => Readonly<OverlaySettings>) {
    this.getSettings = getSettings;
  }

  /**
   * Pre-seed bootstrap data from a prior resolution (e.g. factory call).
   * When set, bootstrapAndLaunchPolling skips the resolver's own bootstrap
   * fetch, eliminating a duplicate ~200KB watch page HTTP request.
   */
  setInitialBootstrap(data: ChatBootstrapData): void {
    this.bootstrap = data;
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
    } catch (error: unknown) {
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

    log.debug('chat.source.monitoring-stopped');
  }

  isActive(timeoutMs = this.getSettings().activityTimeoutMs): boolean {
    return Date.now() - this.lastActivityTime < Math.max(0, timeoutMs);
  }

  getHealthSnapshot(options: ChatHealthSnapshotOptions = {}): ChatHealthSnapshot {
    const activeTimeoutMs = options.activeTimeoutMs ?? this.getSettings().activityTimeoutMs;

    return {
      observerAlive: this.isObserverAlive(),
      recentlyActive: this.isActive(activeTimeoutMs),
      isInBackoff: false,
      consecutiveErrors: 0,
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

  /**
   * Poll at short intervals until playback is no longer paused or timeout elapses.
   * Used by the live poll loop to handle brief pauses without restarting the session.
   */
  protected async pollWhilePaused(
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
  protected async refreshBootstrap(signal?: AbortSignal): Promise<ChatBootstrapData | null> {
    const result = await refreshBootstrap(signal);
    if (!result) return null;
    this.bootstrap = result;
    return result;
  }

  protected emitMessage(message: ChatMessage): void {
    if (!this.callback) return;
    const deduped = this.filterNewMessages([message]);
    if (deduped.length === 0) return;
    const [msg] = deduped;
    if (!msg) return;
    this.messageBuffer.push(msg);
    this.callback(msg);
  }

  protected emitBatch(messages: ChatMessage[], isInitialSeed: boolean): void {
    if (!this.callback || messages.length === 0) return;
    const deduped = this.filterNewMessages(messages);
    if (deduped.length === 0) return;
    for (const message of deduped) {
      this.messageBuffer.push(message);
    }
    this.callback(deduped, isInitialSeed);
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

    // Mark activity BEFORE the fetch so the health watchdog doesn't
    // penalize transient network failures — the source IS actively
    // trying, even if the current request failed.
    this.markActivity();

    const response = await fetchFn(this.bootstrap, continuation, ...fetchArgs);
    const payload = getLiveChatPayload(response);
    if (!payload) {
      log.warn('chat.source.parse-failed');
      return null;
    }

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
    this.seenMessageIds.clear();
  }

  setPaused(paused: boolean): void {
    this.chatPaused = paused;
    if (paused) {
      // Create a fresh controller for the upcoming pause period.
      // The old one is already aborted (or never created).
      this.pauseAbortController = new AbortController();
    } else {
      // Wake any sleeping waitWhilePaused() by aborting the pause signal.
      this.pauseAbortController?.abort();
      this.pauseAbortController = null;
      this.markActivity();
    }
  }

  protected async waitWhilePaused(sessionSignal?: AbortSignal): Promise<void> {
    while (this.chatPaused) {
      if (sessionSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (this.pauseAbortController?.signal.aborted) return;
      // Sleep briefly; abort of pauseAbortController (via setPaused(false))
      // will interrupt via the combined abort check above on next iteration.
      // Use a short sleep so we don't miss the abort by more than 250ms.
      await sleep(ChatSource.PAUSE_POLL_INTERVAL_MS, sessionSignal);
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

    // ── Defensive recovery from stuck chatPaused ──
    // If chatPaused is true but the tab is visible and the video is playing,
    // the pause state has likely drifted due to interleaved visibility and
    // video-pause event ordering. Force-unpause to recover message delivery.
    // Without this, the fetch interceptor and DOM watcher would silently
    // drop all messages while YouTube's own chat panel continues to update.
    if (this.chatPaused && document.visibilityState !== 'hidden') {
      const playback = this.getPlaybackSnapshot();
      if (playback && !playback.paused) {
        log.warn(
          'chatPaused state drift detected — tab visible + video playing but chatPaused=true. ' +
            'Force-unpausing to recover message delivery.'
        );
        // Abort any pending pause listeners before force-unpausing,
        // otherwise the orphaned pauseAbortController signal lingers.
        this.pauseAbortController?.abort();
        // Bypass setPaused() to avoid creating a new abort controller we don't need.
        this.chatPaused = false;
      }
    }

    if (this.chatPaused) return;
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
      // H4: For messages without an id, use a content-based hash as fallback key.
      // This prevents duplicate display when the fetch interceptor and poll loop
      // both process the same API response for id-less messages.
      const dedupKey = msg.id ?? this.computeContentHash(msg);
      if (this.seenMessageIds.has(dedupKey)) continue;
      this.seenMessageIds.mark(dedupKey);
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

  protected abstract seedCurrentSession(signal?: AbortSignal): Promise<boolean>;
  protected abstract launchCurrentPollLoop(signal?: AbortSignal): void;

  private async bootstrapAndLaunchPolling(signal?: AbortSignal): Promise<ChatSourceStartStatus> {
    // Skip resolver when bootstrap was pre-seeded by factory call
    if (!this.bootstrap) {
      const bootstrapResolution = await resolveBootstrap(signal);

      if (bootstrapResolution.status !== 'ready') {
        logBootstrapFailure(bootstrapResolution);
        if (bootstrapResolution.status === 'waiting') return 'waiting';
        return bootstrapResolution.status === 'unavailable' ? 'unavailable' : 'retryable';
      }

      this.bootstrap = bootstrapResolution.data;
    }

    const seeded = await this.seedCurrentSession(signal);
    if (!seeded) {
      return 'retryable';
    }

    this.launchCurrentPollLoop(signal);

    log.debug('chat.source.replay-poll-started');

    return 'started';
  }
}
