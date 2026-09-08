// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { ReplayChatSource } from '@chat/source-replay';
import type { ChatMessage } from '@app-types';
import type { InnertubeContinuationData } from '@chat/youtube/continuation';
import type { ChatBootstrapData, LiveChatPayload } from '@chat/youtube/api';
import { DEFAULT_SETTINGS } from '@settings/schema';

function makeReplayMessage(id: string, offsetMs: number): ChatMessage {
  return {
    id,
    text: id,
    content: [{ type: 'text', content: id }],
    kind: 'text',
    authorType: 'normal',
    timestamp: offsetMs,
    videoOffsetMs: offsetMs,
  };
}

function makeReplayAction(id: string, offsetMs: number): unknown {
  return {
    replayChatItemAction: {
      videoOffsetTimeMsec: offsetMs,
      actions: [
        {
          addChatItemAction: {
            item: {
              liveChatTextMessageRenderer: {
                id,
                authorName: { simpleText: 'Viewer' },
                message: { runs: [{ text: id }] },
              },
            },
          },
        },
      ],
    },
  };
}

/**
 * Tests for ReplayChatSource seek+prefetch behavior.
 *
 * Regression guards for the Phase 3 fix: startPrefetch should only be
 * called when the seek fetch succeeds. The cooperative loop (lines 185-254)
 * already guards prefetch seeding behind mainPollSucceeded (line 202-204).
 * These tests verify the basic lifecycle and health snapshot contract.
 */

describe('ReplayChatSource', () => {
  let source: ReplayChatSource;

  beforeEach(() => {
    source = new ReplayChatSource(() => DEFAULT_SETTINGS);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('constructs without error', () => {
    expect(source).toBeInstanceOf(ReplayChatSource);
  });

  it('accepts custom settings getter', () => {
    const custom = { ...DEFAULT_SETTINGS, replayPrefetchPages: 10 };
    const s = new ReplayChatSource(() => custom);
    expect(s).toBeInstanceOf(ReplayChatSource);
  });

  it('getHealthSnapshot returns expected shape', () => {
    const health = source.getHealthSnapshot();
    expect(health).toBeDefined();
    expect(typeof health.observerAlive).toBe('boolean');
    expect(typeof health.recentlyActive).toBe('boolean');
    expect(health).toHaveProperty('observerAlive');
    expect(health).toHaveProperty('recentlyActive');
  });

  it('getHealthSnapshot with activeTimeoutMs option', () => {
    const health = source.getHealthSnapshot({ activeTimeoutMs: 1000 });
    expect(health).toBeDefined();
    expect(typeof health.recentlyActive).toBe('boolean');
  });

  it('isActive returns boolean', () => {
    expect(typeof source.isActive()).toBe('boolean');
  });

  it('isActive with custom timeout', () => {
    expect(typeof source.isActive(5000)).toBe('boolean');
  });

  it('drainPendingMessages returns empty array when not started', () => {
    const pending = source.drainPendingMessages();
    expect(Array.isArray(pending)).toBe(true);
    expect(pending).toEqual([]);
  });

  it('throttles continuation prefetches independently of fast render ticks', () => {
    const internals = source as unknown as {
      prefetchContinuation: InnertubeContinuationData | null;
      prefetchPagesFetched: number;
      prefetchBackoffUntil: number;
      prefetchNextAllowedAt: number;
      shouldPrefetch: (now: number, signal?: AbortSignal) => boolean;
    };
    internals.prefetchContinuation = { continuation: 'next' };
    internals.prefetchPagesFetched = 0;
    internals.prefetchBackoffUntil = 0;
    internals.prefetchNextAllowedAt = 1250;

    expect(internals.shouldPrefetch(1249)).toBe(false);
    expect(internals.shouldPrefetch(1250)).toBe(true);
  });

  it('uses high and low time watermarks before resuming replay prefetch', () => {
    const internals = source as unknown as {
      prefetchContinuation: InnertubeContinuationData | null;
      replayBuffer: {
        clear: () => void;
        insert: (message: ChatMessage, offsetMs: number) => void;
      };
      shouldPrefetch: (
        now: number,
        signal: AbortSignal | undefined,
        playback: { offsetMs: number; paused: boolean }
      ) => boolean;
    };
    internals.prefetchContinuation = { continuation: 'next' };
    internals.replayBuffer.insert(makeReplayMessage('far', 30_000), 30_000);

    expect(internals.shouldPrefetch(0, undefined, { offsetMs: 0, paused: false })).toBe(false);

    internals.replayBuffer.clear();
    internals.replayBuffer.insert(makeReplayMessage('middle', 20_000), 20_000);
    expect(internals.shouldPrefetch(0, undefined, { offsetMs: 0, paused: false })).toBe(false);

    internals.replayBuffer.clear();
    internals.replayBuffer.insert(makeReplayMessage('near', 12_000), 12_000);
    expect(internals.shouldPrefetch(0, undefined, { offsetMs: 0, paused: false })).toBe(true);
  });

  it('bounds replay prefetch by message count and estimated bytes', () => {
    const internals = source as unknown as {
      prefetchContinuation: InnertubeContinuationData | null;
      replayBuffer: {
        clear: () => void;
        insert: (message: ChatMessage, offsetMs: number) => void;
      };
      shouldPrefetch: (
        now: number,
        signal: AbortSignal | undefined,
        playback: { offsetMs: number; paused: boolean }
      ) => boolean;
    };
    internals.prefetchContinuation = { continuation: 'next' };
    for (let index = 0; index < 2000; index++) {
      internals.replayBuffer.insert(makeReplayMessage(`count-${index}`, 1000), 1000);
    }
    expect(internals.shouldPrefetch(0, undefined, { offsetMs: 0, paused: false })).toBe(false);

    internals.replayBuffer.clear();
    const large = makeReplayMessage('large', 1000);
    large.text = 'x'.repeat(1_600_000);
    large.content = [{ type: 'text', content: large.text }];
    internals.replayBuffer.insert(large, 1000);
    expect(internals.shouldPrefetch(0, undefined, { offsetMs: 0, paused: false })).toBe(false);
  });

  it('keeps mandatory player polling eligible after optional prefetch reaches its page cap', async () => {
    const internals = source as unknown as {
      replayMode: 'playerSeek' | null;
      prefetchContinuation: InnertubeContinuationData | null;
      prefetchPagesFetched: number;
      cooperativeLoopGeneration: number;
      getPlaybackSnapshot: () => { offsetMs: number; paused: boolean };
      pollPlayerSeekReplay: () => Promise<boolean>;
      runNetworkCycle: (generation: number) => Promise<void>;
    };
    internals.replayMode = 'playerSeek';
    internals.prefetchContinuation = { continuation: 'next' };
    internals.prefetchPagesFetched = DEFAULT_SETTINGS.replayPrefetchPages;
    vi.spyOn(internals, 'getPlaybackSnapshot').mockReturnValue({
      offsetMs: 5000,
      paused: false,
    });
    const poll = vi.spyOn(internals, 'pollPlayerSeekReplay').mockResolvedValue(true);

    await internals.runNetworkCycle(internals.cooperativeLoopGeneration);

    expect(poll).toHaveBeenCalledOnce();
  });

  it('keeps flushing buffered messages while a replay request is delayed', async () => {
    vi.useFakeTimers();
    const received: ChatMessage[] = [];
    const internals = source as unknown as {
      callback: ((messages: ChatMessage | ChatMessage[]) => void) | null;
      replayMode: 'playerSeek' | null;
      replayPlayerSeekContinuation: InnertubeContinuationData | null;
      replayBuffer: {
        insert: (message: ChatMessage, offsetMs: number) => void;
      };
      getPlaybackSnapshot: () => { offsetMs: number; paused: boolean };
      requestReplayPayload: () => Promise<LiveChatPayload>;
      startCooperativeLoop: () => void;
    };
    internals.callback = (messages) => {
      received.push(...(Array.isArray(messages) ? messages : [messages]));
    };
    internals.replayMode = 'playerSeek';
    internals.replayPlayerSeekContinuation = { continuation: 'seek' };
    vi.spyOn(internals, 'getPlaybackSnapshot').mockReturnValue({
      offsetMs: 1000,
      paused: false,
    });
    vi.spyOn(internals, 'requestReplayPayload').mockReturnValue(new Promise(() => {}));
    for (let index = 0; index < 10; index++) {
      internals.replayBuffer.insert(makeReplayMessage(`buffered-${index}`, 1000), 1000);
    }

    internals.startCooperativeLoop();
    await vi.advanceTimersByTimeAsync(20);

    expect(received.map((message) => message.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `buffered-${index}`)
    );
    source.stop();
  });

  it('does not begin another replay request after playback pauses during delayed I/O', async () => {
    vi.useFakeTimers();
    let resolveRequest!: (payload: LiveChatPayload) => void;
    let playback = { offsetMs: 1000, paused: false };
    const internals = source as unknown as {
      callback: (() => void) | null;
      replayMode: 'playerSeek' | null;
      replayPlayerSeekContinuation: InnertubeContinuationData | null;
      getPlaybackSnapshot: () => { offsetMs: number; paused: boolean };
      requestReplayPayload: () => Promise<LiveChatPayload | null>;
      startCooperativeLoop: () => void;
    };
    internals.callback = () => {};
    internals.replayMode = 'playerSeek';
    internals.replayPlayerSeekContinuation = { continuation: 'seek' };
    vi.spyOn(internals, 'getPlaybackSnapshot').mockImplementation(() => playback);
    const requestReplayPayload = vi
      .spyOn(internals, 'requestReplayPayload')
      .mockImplementationOnce(
        () =>
          new Promise<LiveChatPayload>((resolve) => {
            resolveRequest = resolve;
          })
      )
      .mockResolvedValue(null);

    internals.startCooperativeLoop();
    await vi.advanceTimersByTimeAsync(0);
    expect(requestReplayPayload).toHaveBeenCalledOnce();

    playback = { offsetMs: 1000, paused: true };
    source.setPauseReason('video', true);
    resolveRequest({
      actions: [],
      continuations: [{ playerSeekContinuationData: { continuation: 'prefetch' } }],
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(requestReplayPayload).toHaveBeenCalledOnce();
    source.stop();
  });

  it('serializes a seek request behind replay I/O already in flight', async () => {
    vi.useFakeTimers();
    const requestSignals: AbortSignal[] = [];
    let resolveSeekRequest!: (payload: LiveChatPayload) => void;
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const internals = source as unknown as {
      callback: (() => void) | null;
      replayMode: 'playerSeek' | null;
      replayPlayerSeekContinuation: InnertubeContinuationData | null;
      getPlaybackSnapshot: () => { offsetMs: number; paused: boolean };
      requestPayload: (...args: unknown[]) => Promise<LiveChatPayload>;
      handleSeeked: (offsetMs: number) => void;
      startCooperativeLoop: () => void;
    };
    internals.callback = () => {};
    internals.replayMode = 'playerSeek';
    internals.replayPlayerSeekContinuation = { continuation: 'seek' };
    vi.spyOn(internals, 'getPlaybackSnapshot').mockReturnValue({
      offsetMs: 1000,
      paused: false,
    });
    const requestPayload = vi.spyOn(internals, 'requestPayload').mockImplementation(
      (_fetchFn, _continuation, ...fetchArgs) => {
        const signal = fetchArgs.at(-1) as AbortSignal;
        requestSignals.push(signal);
        return new Promise<LiveChatPayload>((resolve, reject) => {
          activeRequests += 1;
          maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
          signal.addEventListener(
            'abort',
            () => {
              activeRequests -= 1;
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true }
          );
          if (requestSignals.length === 2) {
            resolveSeekRequest = (payload) => {
              activeRequests -= 1;
              resolve(payload);
            };
          }
        });
      }
    );

    internals.startCooperativeLoop();
    await vi.advanceTimersByTimeAsync(0);
    internals.handleSeeked(5000);
    await vi.waitFor(() => expect(requestPayload).toHaveBeenCalledTimes(2));

    expect(maximumActiveRequests).toBe(1);
    expect(requestSignals[0]?.aborted).toBe(true);
    expect(requestSignals[1]?.aborted).toBe(false);
    resolveSeekRequest({ actions: [], continuations: [] });
    source.stop();
  });

  it('invalidates in-flight prefetch work when prefetch state resets', () => {
    const internals = source as unknown as {
      prefetchGeneration: number;
      stopPrefetch: () => void;
      isPrefetchGenerationCurrent: (generation: number) => boolean;
    };
    const generation = internals.prefetchGeneration;

    internals.stopPrefetch();

    expect(internals.isPrefetchGenerationCurrent(generation)).toBe(false);
  });

  it('starts a new delivery epoch when playback seeks', () => {
    const received: string[] = [];
    const onSeek = vi.fn();
    const internals = source as unknown as {
      callback: ((messages: Array<{ id?: string }>) => void) | null;
      handleSeeked: (offsetMs: number) => void;
      onSeek?: () => void;
    };
    internals.callback = (messages) => {
      received.push(...messages.flatMap((message) => (message.id ? [message.id] : [])));
    };
    internals.onSeek = onSeek;

    source.injectExternalMessages([
      {
        id: 'same-message',
        text: 'before seek',
        content: [{ type: 'text', content: 'before seek' }],
        kind: 'text',
        authorType: 'normal',
        timestamp: 1,
      },
    ]);
    source.injectExternalMessages([
      {
        id: 'same-message',
        text: 'duplicate',
        content: [{ type: 'text', content: 'duplicate' }],
        kind: 'text',
        authorType: 'normal',
        timestamp: 2,
      },
    ]);
    internals.handleSeeked(0);
    source.injectExternalMessages([
      {
        id: 'same-message',
        text: 'after seek',
        content: [{ type: 'text', content: 'after seek' }],
        kind: 'text',
        authorType: 'normal',
        timestamp: 3,
      },
    ]);

    expect(onSeek).toHaveBeenCalledOnce();
    expect(received).toEqual(['same-message', 'same-message']);
  });

  it('discards an ordinary player-seek response invalidated by a later seek', async () => {
    let resolvePayload!: (payload: LiveChatPayload) => void;
    const pendingPayload = new Promise<LiveChatPayload>((resolve) => {
      resolvePayload = resolve;
    });
    const continuation = { continuation: 'current' };
    const internals = source as unknown as {
      replayMode: 'playerSeek' | null;
      replayPlayerSeekContinuation: InnertubeContinuationData | null;
      lastReplayRequestedOffsetMs: number;
      seekGeneration: number;
      requestReplayPayload: () => Promise<LiveChatPayload>;
      fetchReplayPlayerSeek: (offsetMs: number) => Promise<boolean>;
    };
    internals.replayMode = 'playerSeek';
    internals.replayPlayerSeekContinuation = continuation;
    vi.spyOn(internals, 'requestReplayPayload').mockReturnValue(pendingPayload);

    const request = internals.fetchReplayPlayerSeek(1000);
    internals.seekGeneration += 1;
    resolvePayload({ actions: [], continuations: [] });

    await expect(request).resolves.toBe(false);
    expect(internals.replayPlayerSeekContinuation).toBe(continuation);
    expect(internals.lastReplayRequestedOffsetMs).toBe(-1000);
  });

  it('discards a continuation response invalidated by a later seek', async () => {
    const pendingResolvers: Array<(payload: LiveChatPayload) => void> = [];
    const currentContinuation = { continuation: 'current' };
    const internals = source as unknown as {
      callback: (() => void) | null;
      replayMode: 'continuation' | null;
      replayContinuation: InnertubeContinuationData | null;
      replayFallbackLastOffsetMs: number;
      replayConsecutiveFailures: number;
      replayTotalFailuresSinceSuccess: number;
      replayNextAllowedFetchAt: number;
      requestReplayPayload: () => Promise<LiveChatPayload>;
      handleSeeked: (offsetMs: number) => void;
    };
    internals.callback = () => {};
    internals.replayMode = 'continuation';
    internals.replayContinuation = currentContinuation;
    internals.replayConsecutiveFailures = 2;
    internals.replayTotalFailuresSinceSuccess = 3;
    internals.replayNextAllowedFetchAt = 1234;
    vi.spyOn(internals, 'requestReplayPayload').mockImplementation(
      () =>
        new Promise<LiveChatPayload>((resolve) => {
          pendingResolvers.push(resolve);
        })
    );

    internals.handleSeeked(10_000);
    await vi.waitFor(() => expect(pendingResolvers).toHaveLength(1));
    internals.handleSeeked(20_000);
    await vi.waitFor(() => expect(pendingResolvers).toHaveLength(2));
    internals.replayConsecutiveFailures = 4;
    internals.replayTotalFailuresSinceSuccess = 8;
    internals.replayNextAllowedFetchAt = 5678;

    pendingResolvers[0]?.({
      actions: [
        {
          replayChatItemAction: {
            videoOffsetTimeMsec: 10_000,
            actions: [
              {
                addChatItemAction: {
                  item: {
                    liveChatTextMessageRenderer: {
                      id: 'stale-message',
                      authorName: { simpleText: 'Viewer' },
                      message: { runs: [{ text: 'stale' }] },
                    },
                  },
                },
              },
            ],
          },
        },
      ],
      continuations: [
        { liveChatReplayContinuationData: { continuation: 'stale-next' } },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(internals.replayContinuation).toBe(currentContinuation);
    expect(internals.replayFallbackLastOffsetMs).toBe(-1);
    expect(internals.replayConsecutiveFailures).toBe(4);
    expect(internals.replayTotalFailuresSinceSuccess).toBe(8);
    expect(internals.replayNextAllowedFetchAt).toBe(5678);
    expect(source.drainPendingMessages()).toEqual([]);
  });

  it('discards an initialization response invalidated by a newer session', async () => {
    const pendingResolvers: Array<(payload: LiveChatPayload) => void> = [];
    const internals = source as unknown as {
      bootstrap: ChatBootstrapData | null;
      replayMode: 'continuation' | 'playerSeek' | null;
      replayContinuation: InnertubeContinuationData | null;
      replayFallbackLastOffsetMs: number;
      requestReplayPayload: () => Promise<LiveChatPayload>;
      initializeReplaySession: () => Promise<boolean>;
    };
    internals.bootstrap = {
      initialContinuation: { continuation: 'initial' },
      isReplay: true,
    } as ChatBootstrapData;
    vi.spyOn(internals, 'requestReplayPayload').mockImplementation(
      () =>
        new Promise<LiveChatPayload>((resolve) => {
          pendingResolvers.push(resolve);
        })
    );

    const staleInitialization = internals.initializeReplaySession();
    await vi.waitFor(() => expect(pendingResolvers).toHaveLength(1));
    const currentInitialization = internals.initializeReplaySession();
    await vi.waitFor(() => expect(pendingResolvers).toHaveLength(2));

    pendingResolvers[0]?.({
      actions: [
        {
          replayChatItemAction: {
            videoOffsetTimeMsec: 0,
            actions: [
              {
                addChatItemAction: {
                  item: {
                    liveChatTextMessageRenderer: {
                      id: 'stale-initialization-message',
                      authorName: { simpleText: 'Viewer' },
                      message: { runs: [{ text: 'stale' }] },
                    },
                  },
                },
              },
            ],
          },
        },
      ],
      continuations: [
        { liveChatReplayContinuationData: { continuation: 'stale-next' } },
      ],
    });

    await expect(staleInitialization).resolves.toBe(false);
    expect(internals.replayMode).toBeNull();
    expect(internals.replayContinuation).toBeNull();
    expect(internals.replayFallbackLastOffsetMs).toBe(-1);

    pendingResolvers[1]?.({
      actions: [
        {
          replayChatItemAction: {
            videoOffsetTimeMsec: 0,
            actions: [
              {
                addChatItemAction: {
                  item: {
                    liveChatTextMessageRenderer: {
                      id: 'current-initialization-message',
                      authorName: { simpleText: 'Viewer' },
                      message: { runs: [{ text: 'current' }] },
                    },
                  },
                },
              },
            ],
          },
        },
      ],
      continuations: [
        { liveChatReplayContinuationData: { continuation: 'current-next' } },
      ],
    });

    await expect(currentInitialization).resolves.toBe(true);
    expect(internals.replayMode).toBe('continuation');
    expect(internals.replayContinuation).toEqual({ continuation: 'current-next' });
  });

  it('follows initial continuations until the buffer reaches current playback', async () => {
    const internals = source as unknown as {
      bootstrap: ChatBootstrapData | null;
      getPlaybackSnapshot: () => { offsetMs: number; paused: boolean };
      requestReplayPayload: () => Promise<LiveChatPayload>;
      initializeReplaySession: () => Promise<boolean>;
    };
    internals.bootstrap = {
      initialContinuation: { continuation: 'initial' },
      isReplay: true,
    } as ChatBootstrapData;
    vi.spyOn(internals, 'getPlaybackSnapshot').mockReturnValue({
      offsetMs: 20_000,
      paused: false,
    });
    const requestReplayPayload = vi
      .spyOn(internals, 'requestReplayPayload')
      .mockResolvedValueOnce({
        actions: [makeReplayAction('old', 0)],
        continuations: [{ liveChatReplayContinuationData: { continuation: 'next' } }],
      })
      .mockResolvedValueOnce({
        actions: [makeReplayAction('current', 16_000)],
        continuations: [{ liveChatReplayContinuationData: { continuation: 'later' } }],
      });

    await expect(internals.initializeReplaySession()).resolves.toBe(true);

    expect(requestReplayPayload).toHaveBeenCalledTimes(2);
    expect(source.drainPendingMessages().map((message) => message.id)).toEqual(['current']);
  });

  it('does not refetch an empty player-seek buffer until playback advances', () => {
    const internals = source as unknown as {
      replayMode: 'playerSeek' | null;
      replayPlayerSeekContinuation: InnertubeContinuationData | null;
      lastReplayRequestedOffsetMs: number;
      shouldFetchReplayAtOffset: (offsetMs: number) => boolean;
    };
    internals.replayMode = 'playerSeek';
    internals.replayPlayerSeekContinuation = { continuation: 'next' };
    internals.lastReplayRequestedOffsetMs = 1000;

    expect(internals.shouldFetchReplayAtOffset(1000)).toBe(false);
    expect(internals.shouldFetchReplayAtOffset(1999)).toBe(false);
    expect(internals.shouldFetchReplayAtOffset(2000)).toBe(true);
  });

  it('restarts the cooperative loop after successful replay-session recovery', async () => {
    const internals = source as unknown as {
      pollPlayerSeekReplay: (
        playback: { offsetMs: number; paused: boolean },
        signal?: AbortSignal
      ) => Promise<boolean>;
      shouldFetchReplayAtOffset: (offsetMs: number) => boolean;
      fetchReplayPlayerSeek: (offsetMs: number, signal?: AbortSignal) => Promise<boolean>;
      needsReplaySessionRecovery: () => boolean;
      refreshBootstrap: (
        signal?: AbortSignal,
        accept?: (candidate: ChatBootstrapData) => boolean
      ) => Promise<ChatBootstrapData | null>;
      initializeReplaySession: (signal?: AbortSignal) => Promise<boolean>;
      startCooperativeLoop: (signal?: AbortSignal) => void;
      installSeekListeners: (signal?: AbortSignal) => void;
    };
    vi.spyOn(internals, 'shouldFetchReplayAtOffset').mockReturnValue(true);
    vi.spyOn(internals, 'fetchReplayPlayerSeek').mockResolvedValue(false);
    vi.spyOn(internals, 'needsReplaySessionRecovery').mockReturnValue(true);
    vi.spyOn(internals, 'refreshBootstrap').mockResolvedValue({
      isReplay: true,
    } as ChatBootstrapData);
    vi.spyOn(internals, 'initializeReplaySession').mockResolvedValue(true);
    const startLoop = vi.spyOn(internals, 'startCooperativeLoop').mockImplementation(() => {});
    const installSeekListeners = vi
      .spyOn(internals, 'installSeekListeners')
      .mockImplementation(() => {});

    await expect(
      internals.pollPlayerSeekReplay({ offsetMs: 1000, paused: false })
    ).resolves.toBe(true);
    expect(startLoop).toHaveBeenCalledOnce();
    expect(installSeekListeners).toHaveBeenCalledOnce();
  });

  it('does not poll player-seek replay while fetch backoff is active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));

    const internals = source as unknown as {
      replayNextAllowedFetchAt: number;
      pollPlayerSeekReplay: (playback: {
        offsetMs: number;
        paused: boolean;
      }) => Promise<boolean>;
      shouldFetchReplayAtOffset: (offsetMs: number) => boolean;
      fetchReplayPlayerSeek: (offsetMs: number) => Promise<boolean>;
    };
    internals.replayNextAllowedFetchAt = Date.now() + 5000;
    const shouldFetch = vi
      .spyOn(internals, 'shouldFetchReplayAtOffset')
      .mockReturnValue(true);
    const fetchReplay = vi.spyOn(internals, 'fetchReplayPlayerSeek').mockResolvedValue(true);

    await expect(
      internals.pollPlayerSeekReplay({ offsetMs: 1000, paused: false })
    ).resolves.toBe(false);
    expect(shouldFetch).not.toHaveBeenCalled();
    expect(fetchReplay).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    await expect(
      internals.pollPlayerSeekReplay({ offsetMs: 1000, paused: false })
    ).resolves.toBe(true);
    expect(fetchReplay).toHaveBeenCalledOnce();
  });

  it('stop() is idempotent', () => {
    expect(() => source.stop()).not.toThrow();
    expect(() => source.stop()).not.toThrow();
  });

  it('releases seek listener and signal references when the loop stops', () => {
    const cleanup = vi.fn();
    const signal = new AbortController().signal;
    const internals = source as unknown as {
      seekListenerCleanup: (() => void) | null;
      seekSignal: AbortSignal | null;
      stopCooperativeLoop: () => void;
    };
    internals.seekListenerCleanup = cleanup;
    internals.seekSignal = signal;

    internals.stopCooperativeLoop();
    internals.stopCooperativeLoop();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(internals.seekListenerCleanup).toBeNull();
    expect(internals.seekSignal).toBeNull();
  });

  it('clears a prior seek listener when no replacement video exists', () => {
    const cleanup = vi.fn();
    const signal = new AbortController().signal;
    const internals = source as unknown as {
      seekListenerCleanup: (() => void) | null;
      seekSignal: AbortSignal | null;
      installSeekListeners: (signal?: AbortSignal) => void;
    };
    internals.seekListenerCleanup = cleanup;
    internals.seekSignal = signal;

    internals.installSeekListeners(signal);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(internals.seekListenerCleanup).toBeNull();
    expect(internals.seekSignal).toBeNull();
  });

  it('rebinds the seek listener when YouTube replaces the video element', async () => {
    vi.useFakeTimers();
    const player = document.createElement('div');
    player.id = 'movie_player';
    const initialVideo = document.createElement('video');
    player.append(initialVideo);
    document.body.append(player);

    const onSeek = vi.fn();
    const internals = source as unknown as {
      callback: (() => void) | null;
      onSeek?: () => void;
      launchCurrentPollLoop: (signal?: AbortSignal) => void;
    };
    internals.callback = () => {};
    internals.onSeek = onSeek;
    internals.launchCurrentPollLoop();

    const replacementVideo = document.createElement('video');
    initialVideo.replaceWith(replacementVideo);
    await vi.advanceTimersByTimeAsync(1000);

    replacementVideo.dispatchEvent(new Event('seeked'));
    expect(onSeek).toHaveBeenCalledOnce();

    initialVideo.dispatchEvent(new Event('seeked'));
    expect(onSeek).toHaveBeenCalledOnce();
    source.stop();
  });

  it('aborts a hung replay request after the fetch timeout', async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal);

    const internals = source as unknown as {
      requestReplayPayload: (
        continuation: InnertubeContinuationData,
        signal?: AbortSignal
      ) => Promise<unknown>;
      requestPayload: (...args: unknown[]) => Promise<unknown>;
    };
    const requestPayload = vi
      .spyOn(internals, 'requestPayload')
      .mockImplementation((_fetchFn, _continuation, ...fetchArgs) => {
        const signal = fetchArgs.at(-1) as AbortSignal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        });
      });
    const request = internals.requestReplayPayload({ continuation: 'test' });

    expect(timeoutSpy).toHaveBeenCalledWith(20_000);
    expect(requestPayload).toHaveBeenCalledTimes(1);
    timeoutController.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
});
