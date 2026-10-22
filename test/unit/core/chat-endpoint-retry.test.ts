// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// @vitest-environment jsdom

import { fetchLiveChat, fetchReplayChat, type ChatBootstrapData } from '@chat/youtube/api';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const bootstrap: ChatBootstrapData = {
  videoId: 'video-id',
  isReplay: false,
  clientContext: { clientName: 'WEB' },
  clientNameHeader: '1',
  ytcfg: {},
  initialContinuation: { continuation: 'first' },
};

const payload = { continuationContents: { liveChatContinuation: { actions: [] } } };
const goodResponse = (): Response => new Response(JSON.stringify(payload));
const requestCases = [
  {
    name: 'live',
    path: '/youtubei/v1/live_chat/get_live_chat',
    request: (signal?: AbortSignal): Promise<unknown> =>
      fetchLiveChat(bootstrap, bootstrap.initialContinuation, signal),
  },
  {
    name: 'replay',
    path: '/youtubei/v1/live_chat/get_live_chat_replay',
    request: (signal?: AbortSignal): Promise<unknown> =>
      fetchReplayChat(bootstrap, bootstrap.initialContinuation, 1_234, signal),
  },
] as const;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(requestCases)('$name chat endpoint retry', ({ path, request }) => {
  it.each([401, 403, 500])('does not retry HTTP %i', async (status) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response('', { status }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(request()).rejects.toMatchObject({
      name: 'YoutubeInnertubeRequestError',
      status,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(path);
  });

  it.each([429, 503, 504, 'TypeError'] as const)(
    'retries %s only at 1, 2, and 4 seconds',
    async (failure) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const starts: number[] = [];
      const fetchMock = vi.fn(async (_input: RequestInfo | URL) => {
        starts.push(Date.now());
        if (failure === 'TypeError') throw new TypeError('Network failure');
        return new Response('', { status: failure });
      });
      vi.stubGlobal('fetch', fetchMock);

      const pending = request();
      await vi.advanceTimersByTimeAsync(999);
      expect(starts).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1);
      expect(starts).toEqual([0, 1_000]);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(starts).toEqual([0, 1_000]);
      await vi.advanceTimersByTimeAsync(1);
      expect(starts).toEqual([0, 1_000, 3_000]);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(starts).toEqual([0, 1_000, 3_000]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).rejects.toMatchObject(
        failure === 'TypeError'
          ? { name: 'TypeError', message: 'Network failure' }
          : { name: 'YoutubeInnertubeRequestError', status: failure }
      );
      expect(starts).toEqual([0, 1_000, 3_000, 7_000]);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(path);
    }
  );

  it('does not call fetch for a pre-aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(goodResponse);
    vi.stubGlobal('fetch', fetchMock);

    await expect(request(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates cancellation during a request and lets the next request succeed', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      attempts += 1;
      if (attempts > 1) return Promise.resolve(goodResponse());
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = request(controller.signal);
    expect(fetchMock).toHaveBeenCalledOnce();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(request()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { elapsed: 0, attempts: 1 },
    { elapsed: 1_000, attempts: 2 },
    { elapsed: 3_000, attempts: 3 },
  ])('cancels during backoff after $attempts attempts', async ({ elapsed, attempts }) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = request(controller.signal);
    await vi.advanceTimersByTimeAsync(elapsed);
    expect(fetchMock).toHaveBeenCalledTimes(attempts);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(attempts);

    fetchMock.mockImplementation(async () => goodResponse());
    await expect(request()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(attempts + 1);
  });

  it('does not retry malformed JSON and recovers on a later request', async () => {
    const fetchMock = vi.fn(async () => new Response('{malformed'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(request()).rejects.toBeInstanceOf(SyntaxError);
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockImplementation(async () => goodResponse());
    await expect(request()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
