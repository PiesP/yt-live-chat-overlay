// SPDX-License-Identifier: MIT
// @vitest-environment jsdom

import type { ChatMessage } from '@app-types';
import { ReplayBuffer } from '@chat/replay-buffer';
import { ReplayChatSource } from '@chat/source-replay';
import type { ChatBootstrapData, LiveChatPayload } from '@chat/youtube/api';
import type { InnertubeContinuationData } from '@chat/youtube/continuation';
import { DEFAULT_SETTINGS } from '@settings/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const bootstrapMocks = vi.hoisted(() => ({ refreshBootstrap: vi.fn() }));

vi.mock('@app/bootstrap-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@app/bootstrap-resolver')>()),
  refreshBootstrap: bootstrapMocks.refreshBootstrap,
}));

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

function makeMessageWithEstimatedBytes(bytes: number): ChatMessage {
  const message = makeReplayMessage('byte-boundary', 12_000);
  message.text = '';
  const calibration = new ReplayBuffer();
  calibration.insert(message, 12_000);
  const characters = (bytes - calibration.estimatedByteSize) / 2;
  if (!Number.isInteger(characters) || characters < 0)
    throw new Error('Replay byte boundary cannot be represented by this fixture');
  message.text = 'x'.repeat(characters);
  return message;
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
    bootstrapMocks.refreshBootstrap.mockReset();
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

  it('drains only reached video offsets after visibility recovery', () => {
    const internals = source as unknown as {
      replayBuffer: { insert: (message: ChatMessage, offsetMs: number) => void };
      getPlaybackSnapshot: () => { offsetMs: number; paused: boolean } | null;
    };
    const playback = vi.spyOn(internals, 'getPlaybackSnapshot');
    internals.replayBuffer.insert(makeReplayMessage('due', 10_000), 10_000);
    internals.replayBuffer.insert(makeReplayMessage('just-future', 10_001), 10_001);
    internals.replayBuffer.insert(makeReplayMessage('prefetched', 11_500), 11_500);

    playback.mockReturnValue(null);
    expect(source.drainPendingMessages()).toEqual([]);
    playback.mockReturnValue({ offsetMs: 10_000, paused: true });
    expect(source.drainPendingMessages()).toEqual([]);
    playback.mockReturnValue({ offsetMs: 10_000, paused: false });
    source.setPauseReason('visibility', true);
    expect(source.drainPendingMessages().map((message) => message.id)).toEqual(['due']);
    expect(source.drainPendingMessages()).toEqual([]);
    playback.mockReturnValue({ offsetMs: 10_001, paused: false });
    source.setPauseReason('video', true);
    expect(source.drainPendingMessages()).toEqual([]);
    source.setPauseReason('video', false);
    expect(source.drainPendingMessages().map((message) => message.id)).toEqual(['just-future']);
    source.setPauseReason('visibility', false);
    playback.mockReturnValue({ offsetMs: 11_500, paused: false });
    expect(source.drainPendingMessages().map((message) => message.id)).toEqual(['prefetched']);
  });

  it('reports late drops from an empty visibility drain without consuming future messages', () => {
    const onLateDrop = vi.fn();
    source.onLateDrop = onLateDrop;
    const internals = source as unknown as {
      replayBuffer: { insert: (message: ChatMessage, offsetMs: number) => void };
      getPlaybackSnapshot: () => { offsetMs: number; paused: boolean };
    };
    vi.spyOn(internals, 'getPlaybackSnapshot').mockReturnValue({ offsetMs: 10_000, paused: false });
    internals.replayBuffer.insert(makeReplayMessage('old', 7999), 7999);
    internals.replayBuffer.insert(makeReplayMessage('future', 10_001), 10_001);

    expect(source.drainPendingMessages()).toEqual([]);
    expect(onLateDrop).toHaveBeenCalledOnce();
    expect(onLateDrop).toHaveBeenCalledWith(1);
    expect(source.drainPendingMessages()).toEqual([]);
    expect(onLateDrop).toHaveBeenCalledTimes(1);
  });

  it('keeps display delivery running when the late-drop observer throws', () => {
    const received = vi.fn();
    source.onLateDrop = () => {
      throw new Error('observer failed');
    };
    const internals = source as unknown as {
      callback: ((messages: ChatMessage | ChatMessage[]) => void) | null;
      replayBuffer: { insert: (message: ChatMessage, offsetMs: number) => void };
      flushReplayBuffer: (playback: { offsetMs: number; paused: boolean }) => void;
    };
    internals.callback = received;
    internals.replayBuffer.insert(makeReplayMessage('old', 7999), 7999);
    internals.replayBuffer.insert(makeReplayMessage('due', 10_000), 10_000);

    expect(() => internals.flushReplayBuffer({ offsetMs: 10_000, paused: false })).not.toThrow();
    expect(received).toHaveBeenCalledOnce();
  });

  it('reports late drops when a display flush emits no messages', () => {
    const received = vi.fn();
    const onLateDrop = vi.fn();
    source.onLateDrop = onLateDrop;
    const internals = source as unknown as {
      callback: ((messages: ChatMessage | ChatMessage[]) => void) | null;
      replayBuffer: { insert: (message: ChatMessage, offsetMs: number) => void };
      flushReplayBuffer: (playback: { offsetMs: number; paused: boolean }) => void;
    };
    internals.callback = received;
    internals.replayBuffer.insert(makeReplayMessage('old', 7999), 7999);

    internals.flushReplayBuffer({ offsetMs: 10_000, paused: false });
    expect(received).not.toHaveBeenCalled();
    expect(onLateDrop).toHaveBeenCalledOnce();
    expect(onLateDrop).toHaveBeenCalledWith(1);
  });

  it('displays only due replay messages across pause, rate changes, and a delayed frame', async () => {
    vi.useFakeTimers();
    const received: string[] = [];
    let playback = { offsetMs: 10_000, paused: false };
    const internals = source as unknown as {
      callback: ((messages: ChatMessage | ChatMessage[]) => void) | null;
      replayBuffer: { insert: (message: ChatMessage, offsetMs: number) => void };
      getPlaybackSnapshot: () => { offsetMs: number; paused: boolean };
      startCooperativeLoop: () => void;
    };
    internals.callback = (messages) => {
      received.push(
        ...(Array.isArray(messages) ? messages : [messages]).flatMap((msg) =>
          msg.id ? [msg.id] : []
        )
      );
    };
    vi.spyOn(internals, 'getPlaybackSnapshot').mockImplementation(() => playback);
    internals.replayBuffer.insert(makeReplayMessage('due', 10_000), 10_000);
    internals.replayBuffer.insert(makeReplayMessage('just-future', 10_001), 10_001);
    internals.replayBuffer.insert(makeReplayMessage('prefetched', 11_500), 11_500);

    internals.startCooperativeLoop();
    await vi.advanceTimersByTimeAsync(20);
    expect(received).toEqual(['due']);

    playback = { offsetMs: 10_001, paused: true };
    await vi.advanceTimersByTimeAsync(100);
    expect(received).toEqual(['due']);

    playback = { offsetMs: 10_001, paused: false };
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toEqual(['due', 'just-future']);

    // A faster playback rate and an event-loop hitch both advance video time
    // before the next display tick. Eligibility uses that new video position.
    playback = { offsetMs: 11_500, paused: false };
    await vi.advanceTimersByTimeAsync(20);
    expect(received).toEqual(['due', 'just-future', 'prefetched']);
    source.stop();
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

  it('resumes count-limited prefetch only at the low count with time and bytes also low', () => {
    const internals = source as unknown as {
      prefetchContinuation: InnertubeContinuationData | null;
      replayBuffer: ReplayBuffer;
      shouldPrefetch: (
        now: number,
        signal: AbortSignal | undefined,
        playback: { offsetMs: number; paused: boolean }
      ) => boolean;
    };
    internals.prefetchContinuation = { continuation: 'next' };
    const eligible = () => internals.shouldPrefetch(0, undefined, { offsetMs: 0, paused: false });

    for (let index = 0; index < 2000; index++) {
      internals.replayBuffer.insert(makeReplayMessage(`high-${index}`, 12_000), 12_000);
    }
    expect(internals.replayBuffer.messageCount).toBe(2000);
    expect(eligible()).toBe(false);

    internals.replayBuffer.clear();
    internals.replayBuffer.insert(makeReplayMessage('first', 1), 1);
    internals.replayBuffer.insert(makeReplayMessage('second', 2), 2);
    for (let index = 0; index < 999; index++) {
      internals.replayBuffer.insert(makeReplayMessage(`low-${index}`, 12_000), 12_000);
    }
    expect(internals.replayBuffer.messageCount).toBe(1001);
    expect(internals.replayBuffer.aheadHorizonMs(0)).toBe(12_000);
    expect(internals.replayBuffer.estimatedByteSize).toBeLessThan(3 * 1024 * 1024);
    expect(eligible()).toBe(false);

    internals.replayBuffer.drainUpTo(1);
    expect(internals.replayBuffer.messageCount).toBe(1000);
    expect(eligible()).toBe(true);
    internals.replayBuffer.drainUpTo(2);
    expect(internals.replayBuffer.messageCount).toBe(999);
    expect(eligible()).toBe(true);
  });

  it('resumes byte-limited prefetch at the measured low byte boundary', () => {
    const internals = source as unknown as {
      prefetchContinuation: InnertubeContinuationData | null;
      replayBuffer: ReplayBuffer;
      shouldPrefetch: (
        now: number,
        signal: AbortSignal | undefined,
        playback: { offsetMs: number; paused: boolean }
      ) => boolean;
    };
    internals.prefetchContinuation = { continuation: 'next' };
    const eligible = () => internals.shouldPrefetch(0, undefined, { offsetMs: 0, paused: false });
    const high = 6 * 1024 * 1024;
    const low = 3 * 1024 * 1024;
    internals.replayBuffer.insert(makeMessageWithEstimatedBytes(high), 12_000);
    expect(internals.replayBuffer.estimatedByteSize).toBe(high);
    expect(eligible()).toBe(false);

    for (const [bytes, expected] of [
      [low + 2, false],
      [low, true],
      [low - 2, true],
    ] as const) {
      internals.replayBuffer.clear();
      internals.replayBuffer.insert(makeMessageWithEstimatedBytes(bytes), 12_000);
      expect(internals.replayBuffer.messageCount).toBe(1);
      expect(internals.replayBuffer.estimatedByteSize).toBe(bytes);
      expect(internals.replayBuffer.aheadHorizonMs(0)).toBe(12_000);
      expect(eligible()).toBe(expected);
    }
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

  it('idles an empty display loop and wakes it when delayed I/O adds replay data', async () => {
    vi.useFakeTimers();
    const received: ChatMessage[] = [];
    const internals = source as unknown as {
      callback: ((messages: ChatMessage | ChatMessage[]) => void) | null;
      replayMode: 'playerSeek' | null;
      replayPlayerSeekContinuation: InnertubeContinuationData | null;
      getPlaybackSnapshot: () => { offsetMs: number; paused: boolean };
      requestReplayPayload: () => Promise<LiveChatPayload>;
      appendReplayEvents: (
        events: Array<{ message: ChatMessage; offsetMs: number }>,
        minimumOffsetMs: number
      ) => number;
      startCooperativeLoop: () => void;
    };
    internals.callback = (messages) => {
      received.push(...(Array.isArray(messages) ? messages : [messages]));
    };
    internals.replayMode = 'playerSeek';
    internals.replayPlayerSeekContinuation = { continuation: 'seek' };
    const getPlaybackSnapshot = vi
      .spyOn(internals, 'getPlaybackSnapshot')
      .mockReturnValue({ offsetMs: 1000, paused: false });
    vi.spyOn(internals, 'requestReplayPayload').mockReturnValue(new Promise(() => {}));

    internals.startCooperativeLoop();
    await vi.advanceTimersByTimeAsync(100);

    expect(getPlaybackSnapshot.mock.calls.length).toBeLessThanOrEqual(3);
    expect(received).toEqual([]);

    internals.appendReplayEvents(
      [{ message: makeReplayMessage('newly-buffered', 1000), offsetMs: 1000 }],
      0
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(received.map((message) => message.id)).toEqual(['newly-buffered']);
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
    const requestPayload = vi
      .spyOn(internals, 'requestPayload')
      .mockImplementation((_fetchFn, _continuation, ...fetchArgs) => {
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
      });

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
      continuations: [{ liveChatReplayContinuationData: { continuation: 'stale-next' } }],
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

  it('preserves fallback high-water through an empty page before seeking backward', async () => {
    const received: ChatMessage[] = [];
    const initialContinuation = { continuation: 'initial' };
    const progressedContinuation = { continuation: 'at-thirty-minutes' };
    const internals = source as unknown as {
      callback: ((messages: ChatMessage | ChatMessage[]) => void) | null;
      bootstrap: ChatBootstrapData | null;
      replayMode: 'continuation' | null;
      replayContinuation: InnertubeContinuationData | null;
      replayFallbackLastOffsetMs: number;
      getPlaybackSnapshot: () => { offsetMs: number; paused: boolean };
      requestReplayPayload: (
        continuation: InnertubeContinuationData,
        signal?: AbortSignal
      ) => Promise<LiveChatPayload>;
      fetchNextReplayFallbackBatch: (minimumOffsetMs: number) => Promise<boolean>;
      handleSeeked: (offsetMs: number) => void;
    };
    internals.callback = (messages) => {
      received.push(...(Array.isArray(messages) ? messages : [messages]));
    };
    internals.bootstrap = {
      initialContinuation,
      isReplay: true,
    } as ChatBootstrapData;
    internals.replayMode = 'continuation';
    internals.replayContinuation = progressedContinuation;
    internals.replayFallbackLastOffsetMs = 1_800_000;
    vi.spyOn(internals, 'getPlaybackSnapshot').mockReturnValue({
      offsetMs: 300_000,
      paused: false,
    });
    const requestReplayPayload = vi
      .spyOn(internals, 'requestReplayPayload')
      .mockResolvedValueOnce({
        actions: [],
        continuations: [{ liveChatReplayContinuationData: { continuation: 'after-empty-page' } }],
      })
      .mockResolvedValueOnce({
        actions: [makeReplayAction('five-minute-message', 300_000)],
        continuations: [{ liveChatReplayContinuationData: { continuation: 'after-five-minutes' } }],
      });

    await expect(internals.fetchNextReplayFallbackBatch(0)).resolves.toBe(true);
    expect(internals.replayFallbackLastOffsetMs).toBe(1_800_000);

    internals.handleSeeked(300_000);
    await vi.waitFor(() => expect(requestReplayPayload).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(received.map((message) => message.id)).toEqual(['five-minute-message'])
    );

    expect(requestReplayPayload).toHaveBeenNthCalledWith(
      2,
      initialContinuation,
      expect.any(AbortSignal)
    );
    expect(internals.replayContinuation).toEqual({ continuation: 'after-five-minutes' });
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
      continuations: [{ liveChatReplayContinuationData: { continuation: 'stale-next' } }],
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
      continuations: [{ liveChatReplayContinuationData: { continuation: 'current-next' } }],
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
        actions: [makeReplayAction('current', 19_000)],
        continuations: [{ liveChatReplayContinuationData: { continuation: 'later' } }],
      });

    await expect(internals.initializeReplaySession()).resolves.toBe(true);

    expect(requestReplayPayload).toHaveBeenCalledTimes(2);
    expect(source.drainPendingMessages().map((message) => message.id)).toEqual(['current']);
  });

  it('rejects replay startup when its initial page has neither token mode', async () => {
    source.setInitialBootstrap({
      initialContinuation: { continuation: 'initial' },
      isReplay: true,
    } as ChatBootstrapData);
    const internals = source as unknown as {
      requestReplayPayload: () => Promise<LiveChatPayload>;
    };
    const request = vi.spyOn(internals, 'requestReplayPayload').mockResolvedValue({
      actions: [],
      continuations: [],
    });

    await expect(source.start(vi.fn())).resolves.toBe('retryable');
    expect(request).toHaveBeenCalledOnce();
    expect(source.getHealthSnapshot().observerAlive).toBe(false);
    source.stop();
  });

  it.each([3, 12])(
    'bounds empty sequential catch-up to the effective replayBatchLimit of %i pages',
    async (limit) => {
      expect(DEFAULT_SETTINGS.replayBatchLimit).toBe(12);
      const settings =
        limit === 12 ? DEFAULT_SETTINGS : { ...DEFAULT_SETTINGS, replayBatchLimit: limit };
      source = new ReplayChatSource(() => settings);
      source.setInitialBootstrap({
        initialContinuation: { continuation: 'initial' },
        isReplay: true,
      } as ChatBootstrapData);
      const internals = source as unknown as {
        getPlaybackSnapshot: () => { offsetMs: number; paused: boolean };
        requestReplayPayload: (continuation: InnertubeContinuationData) => Promise<LiveChatPayload>;
      };
      vi.spyOn(internals, 'getPlaybackSnapshot').mockReturnValue({
        offsetMs: 20_000,
        paused: false,
      });
      const requests: string[] = [];
      vi.spyOn(internals, 'requestReplayPayload').mockImplementation(async (continuation) => {
        requests.push(continuation.continuation);
        return {
          actions: [],
          continuations: [
            { liveChatReplayContinuationData: { continuation: `page-${requests.length}` } },
          ],
        };
      });

      await expect(source.start(vi.fn())).resolves.toBe('started');
      expect(requests).toEqual([
        'initial',
        ...Array.from({ length: limit }, (_, index) => `page-${index + 1}`),
      ]);
      expect(source.drainPendingMessages()).toEqual([]);
      source.stop();
    }
  );

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

    await expect(internals.pollPlayerSeekReplay({ offsetMs: 1000, paused: false })).resolves.toBe(
      true
    );
    expect(startLoop).toHaveBeenCalledOnce();
    expect(installSeekListeners).toHaveBeenCalledOnce();
  });

  it('does not poll player-seek replay while fetch backoff is active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));

    const internals = source as unknown as {
      replayNextAllowedFetchAt: number;
      pollPlayerSeekReplay: (playback: { offsetMs: number; paused: boolean }) => Promise<boolean>;
      shouldFetchReplayAtOffset: (offsetMs: number) => boolean;
      fetchReplayPlayerSeek: (offsetMs: number) => Promise<boolean>;
    };
    internals.replayNextAllowedFetchAt = Date.now() + 5000;
    const shouldFetch = vi.spyOn(internals, 'shouldFetchReplayAtOffset').mockReturnValue(true);
    const fetchReplay = vi.spyOn(internals, 'fetchReplayPlayerSeek').mockResolvedValue(true);

    await expect(internals.pollPlayerSeekReplay({ offsetMs: 1000, paused: false })).resolves.toBe(
      false
    );
    expect(shouldFetch).not.toHaveBeenCalled();
    expect(fetchReplay).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    await expect(internals.pollPlayerSeekReplay({ offsetMs: 1000, paused: false })).resolves.toBe(
      true
    );
    expect(fetchReplay).toHaveBeenCalledOnce();
  });

  it('backs off after five player-seek failures and recovers from a rejected live bootstrap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));
    const player = document.createElement('div');
    player.id = 'movie_player';
    const video = document.createElement('video');
    player.append(video);
    document.body.append(player);
    const originalBootstrap = {
      initialContinuation: { continuation: 'old-initial' },
      isReplay: true,
    } as ChatBootstrapData;
    const validBootstrap = {
      initialContinuation: { continuation: 'new-initial' },
      isReplay: true,
    } as ChatBootstrapData;
    source.setInitialBootstrap(originalBootstrap);
    bootstrapMocks.refreshBootstrap
      .mockResolvedValueOnce({ isReplay: false } as ChatBootstrapData)
      .mockResolvedValueOnce(validBootstrap);

    const internals = source as unknown as {
      callback: ((messages: ChatMessage | ChatMessage[]) => void) | null;
      bootstrap: ChatBootstrapData | null;
      replayMode: 'playerSeek' | 'continuation' | null;
      replayPlayerSeekContinuation: InnertubeContinuationData | null;
      replayContinuation: InnertubeContinuationData | null;
      pollPlayerSeekReplay: (playback: { offsetMs: number; paused: boolean }) => Promise<boolean>;
      pollContinuationReplay: (offsetMs: number) => Promise<boolean>;
      requestReplayPayload: (continuation: InnertubeContinuationData) => Promise<LiveChatPayload>;
    };
    internals.callback = vi.fn();
    internals.replayMode = 'playerSeek';
    internals.replayPlayerSeekContinuation = { continuation: 'old-seek' };
    let requests = 0;
    const request = vi.spyOn(internals, 'requestReplayPayload').mockImplementation(async () => {
      requests++;
      if (requests <= 16) throw new Error('transient replay transport failure');
      return {
        actions: requests === 17 ? [makeReplayAction('recovered-sequential', 0)] : [],
        continuations: [
          {
            liveChatReplayContinuationData: {
              continuation: requests === 17 ? 'new-sequential' : 'next-sequential',
            },
          },
        ],
      };
    });
    const playback = { offsetMs: 1000, paused: false };

    for (let attempt = 1; attempt <= 15; attempt++) {
      if (attempt === 6 || attempt === 11) vi.setSystemTime(Date.now() + 5000);
      await expect(internals.pollPlayerSeekReplay(playback)).resolves.toBe(false);
      expect(request).toHaveBeenCalledTimes(attempt);
      if (attempt === 5 || attempt === 10) {
        expect(source.getHealthSnapshot().isInBackoff).toBe(true);
        vi.setSystemTime(Date.now() + 4999);
        await expect(internals.pollPlayerSeekReplay(playback)).resolves.toBe(false);
        expect(request).toHaveBeenCalledTimes(attempt);
        vi.setSystemTime(Date.now() - 4999);
      }
    }

    expect(bootstrapMocks.refreshBootstrap).toHaveBeenCalledOnce();
    expect(internals.bootstrap).toBe(originalBootstrap);
    expect(internals.replayMode).toBe('playerSeek');
    expect(source.getHealthSnapshot().isInBackoff).toBe(true);

    vi.setSystemTime(Date.now() + 5000);
    await expect(internals.pollPlayerSeekReplay(playback)).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(17);
    expect(bootstrapMocks.refreshBootstrap).toHaveBeenCalledTimes(2);
    expect(internals.bootstrap).toBe(validBootstrap);
    expect(internals.replayMode).toBe('continuation');
    expect(internals.replayContinuation).toEqual({ continuation: 'new-sequential' });
    expect(source.getHealthSnapshot().observerAlive).toBe(true);

    await expect(internals.pollContinuationReplay(1000)).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(18);
    expect(internals.replayContinuation).toEqual({ continuation: 'next-sequential' });

    const onSeek = vi.fn();
    source.onSeek = onSeek;
    video.dispatchEvent(new Event('seeked'));
    expect(onSeek).toHaveBeenCalledOnce();
    source.stop();
  });

  it('does not apply player-seek session refresh to accumulated sequential failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));
    const internals = source as unknown as {
      replayMode: 'playerSeek' | 'continuation' | null;
      replayContinuation: InnertubeContinuationData | null;
      pollContinuationReplay: (offsetMs: number) => Promise<boolean>;
      requestReplayPayload: () => Promise<LiveChatPayload>;
    };
    internals.replayMode = 'continuation';
    internals.replayContinuation = { continuation: 'sequential' };
    const request = vi
      .spyOn(internals, 'requestReplayPayload')
      .mockRejectedValue(new Error('sequential transport failure'));

    for (let attempt = 1; attempt <= 15; attempt++) {
      if (attempt === 6 || attempt === 11) vi.setSystemTime(Date.now() + 5000);
      await expect(internals.pollContinuationReplay(1000)).resolves.toBe(false);
      expect(request).toHaveBeenCalledTimes(attempt);
    }

    expect(bootstrapMocks.refreshBootstrap).not.toHaveBeenCalled();
    expect(internals.replayMode).toBe('continuation');
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
