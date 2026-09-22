// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// @vitest-environment jsdom

import type { OverlaySettings } from '@app-types';
import { LiveChatProtocolError } from '@chat/source-base';
import { LiveChatSource } from '@chat/source-live';
import type { ChatBootstrapData, LiveChatPayload } from '@chat/youtube/api';
import type { InnertubeContinuationData } from '@chat/youtube/continuation';
import { DEFAULT_SETTINGS } from '@settings/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

type LiveSourceInternals = {
  callback: ((messages: unknown[], isInitialSeed?: boolean) => void) | null;
  bootstrap: ChatBootstrapData | null;
  consecutiveErrors: number;
  liveContinuation: InnertubeContinuationData | null;
  requestPayload: (...args: unknown[]) => Promise<LiveChatPayload | null>;
  requestLivePayload: (
    continuation: InnertubeContinuationData,
    signal?: AbortSignal
  ) => Promise<LiveChatPayload | null>;
  handleLivePayload: (
    payload: LiveChatPayload,
    isInitialSeed?: boolean
  ) => Promise<void>;
  calculateAdaptiveDelay: (timeoutMs: number) => number;
  resetSessionState: () => void;
  runLiveLoop: (signal?: AbortSignal) => Promise<void>;
  refreshLiveContinuation: (signal?: AbortSignal) => Promise<void>;
};

const makeSettings = (): OverlaySettings => ({
  ...DEFAULT_SETTINGS,
  minPollIntervalMs: 1_000,
  maxPollIntervalMs: 10_000,
  livePollFallbackMs: 2_000,
});

const makePayload = (id: string | null): LiveChatPayload => ({
  actions:
    id === null
      ? []
      : [
          {
            addChatItemAction: {
              item: {
                liveChatTextMessageRenderer: {
                  id,
                  authorName: { simpleText: 'Viewer' },
                  message: { simpleText: `message-${id}` },
                },
              },
            },
          },
        ],
  continuations: [
    {
      timedContinuationData: {
        continuation: `next-${id ?? 'empty'}`,
        timeoutMs: 2_000,
      },
    },
  ],
});

const makeBootstrap = (): ChatBootstrapData => ({
  videoId: 'video-id',
  isReplay: false,
  clientContext: {},
  clientNameHeader: 'WEB',
  ytcfg: {},
  initialContinuation: { continuation: 'initial' },
});

const internalsOf = (source: LiveChatSource): LiveSourceInternals =>
  source as unknown as LiveSourceInternals;

describe('LiveChatSource empty-response polling', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns to a bounded normal delay after a burst yields an empty response', async () => {
    vi.useFakeTimers();
    const source = new LiveChatSource(makeSettings);
    const internals = internalsOf(source);
    const controller = new AbortController();
    source.burstRateProvider = () => 30;
    internals.callback = vi.fn();
    internals.liveContinuation = { continuation: 'burst', timeoutMs: 2_000 };
    await internals.handleLivePayload(makePayload('burst-message'));

    const request = vi.spyOn(internals, 'requestLivePayload').mockImplementation(async () => {
      if (request.mock.calls.length === 3) controller.abort();
      return makePayload(null);
    });
    const loop = internals.runLiveLoop(controller.signal);

    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(request).toHaveBeenCalledTimes(2);

    controller.abort();
    await expect(loop).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps zero-delay chaining while successful burst responses remain non-empty', async () => {
    vi.useFakeTimers();
    const source = new LiveChatSource(makeSettings);
    const internals = internalsOf(source);
    const controller = new AbortController();
    source.burstRateProvider = () => 30;
    internals.callback = vi.fn();
    internals.liveContinuation = { continuation: 'burst', timeoutMs: 2_000 };
    await internals.handleLivePayload(makePayload('seed'));

    const request = vi.spyOn(internals, 'requestLivePayload').mockImplementation(async () => {
      if (request.mock.calls.length === 2) controller.abort();
      return makePayload(`burst-${request.mock.calls.length}`);
    });

    await internals.runLiveLoop(controller.signal);

    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets empty-response state for a new session and retains error backoff priority', async () => {
    const source = new LiveChatSource(makeSettings);
    const internals = internalsOf(source);
    source.burstRateProvider = () => 30;

    await internals.handleLivePayload(makePayload(null));
    internals.consecutiveErrors = 1;
    expect(internals.calculateAdaptiveDelay(2_000)).toBe(4_000);

    await internals.handleLivePayload(makePayload('active-before-reset'));
    expect(internals.calculateAdaptiveDelay(2_000)).toBe(0);

    internals.resetSessionState();
    expect(internals.calculateAdaptiveDelay(2_000)).toBe(2_000);
  });

  it('classifies a malformed response as a protocol error and preserves health state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const source = new LiveChatSource(makeSettings);
    const internals = internalsOf(source);
    internals.bootstrap = makeBootstrap();

    await expect(
      internals.requestPayload(
        async () => ({ continuationContents: {} }),
        { continuation: 'current' }
      )
    ).rejects.toMatchObject({ name: 'LiveChatProtocolError' });
    expect(source.isActive(1_000)).toBe(false);

    await expect(
      internals.requestPayload(
        async () => ({
          continuationContents: { liveChatContinuation: { actions: [], continuations: [] } },
        }),
        { continuation: 'current' }
      )
    ).resolves.toEqual({ actions: [], continuations: [] });
    expect(source.isActive(1_000)).toBe(true);
  });

  it('counts malformed poll responses and routes them through bounded recovery', async () => {
    vi.useFakeTimers();
    const source = new LiveChatSource(makeSettings);
    const internals = internalsOf(source);
    const controller = new AbortController();
    internals.callback = vi.fn();
    internals.liveContinuation = { continuation: 'malformed', timeoutMs: 0 };
    const request = vi
      .spyOn(internals, 'requestLivePayload')
      .mockRejectedValue(new LiveChatProtocolError('malformed response'));
    const refresh = vi.spyOn(internals, 'refreshLiveContinuation').mockImplementation(async () => {
      controller.abort();
    });

    const loop = internals.runLiveLoop(controller.signal);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(loop).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(internals.consecutiveErrors).toBe(1);
    expect(internals.calculateAdaptiveDelay(2_000)).toBe(4_000);
  });

  it('does not clear errors before rejecting a missing continuation', async () => {
    const source = new LiveChatSource(makeSettings);
    const internals = internalsOf(source);
    internals.consecutiveErrors = 2;

    await expect(
      internals.handleLivePayload({ actions: [], continuations: [] })
    ).rejects.toMatchObject({ name: 'LiveChatProtocolError' });
    expect(internals.consecutiveErrors).toBe(2);
  });
});
