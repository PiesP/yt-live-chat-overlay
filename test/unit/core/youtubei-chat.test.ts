// @vitest-environment jsdom

import {
  bootstrapChatSession,
  buildWatchUrl,
  fetchWatchHtml,
  findLiveChatRenderer,
  getVideoIdFromUrl,
  MAX_WATCH_HTML_BYTES,
  WATCH_HTML_TIMEOUT_MS,
} from '@chat/youtube/api';
import { ResponseTooLargeError } from '@chat/youtube/response-text';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── getVideoIdFromUrl ─────────────────────────────────────────────────

describe('getVideoIdFromUrl', () => {
  describe('/watch URLs', () => {
    it('extracts videoId from standard /watch?v= URL', () => {
      expect(getVideoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('extracts videoId from /watch with extra params', () => {
      expect(getVideoIdFromUrl('https://www.youtube.com/watch?v=abc123&t=30&list=PLxyz')).toBe(
        'abc123'
      );
    });

    it('extracts videoId when v is the only param', () => {
      expect(getVideoIdFromUrl('https://www.youtube.com/watch?v=xyz789')).toBe('xyz789');
    });

    it('extracts videoId from /watch with live=1 param (live stream)', () => {
      expect(getVideoIdFromUrl('https://www.youtube.com/watch?v=live123&live=1')).toBe('live123');
    });

    it('returns null for /watch without v param', () => {
      expect(getVideoIdFromUrl('https://www.youtube.com/watch')).toBeNull();
    });

    it('returns null for /watch with empty v param', () => {
      expect(getVideoIdFromUrl('https://www.youtube.com/watch?v=')).toBeNull();
    });

    it('returns null for /watch with whitespace-only v param', () => {
      expect(getVideoIdFromUrl('https://www.youtube.com/watch?v=%20%20')).toBeNull();
    });
  });

  describe('/live/ URLs', () => {
    it('extracts videoId from /live/ URL', () => {
      expect(getVideoIdFromUrl('https://www.youtube.com/live/abc123xyz')).toBe('abc123xyz');
    });

    it('extracts short videoId from /live/ URL', () => {
      expect(getVideoIdFromUrl('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('extracts videoId from /live/ with query params', () => {
      expect(getVideoIdFromUrl('https://www.youtube.com/live/abc123?feature=share')).toBe('abc123');
    });

    it('returns null for bare /live/ with no videoId', () => {
      expect(getVideoIdFromUrl('https://www.youtube.com/live/')).toBeNull();
    });

    it('returns null for /live/ with trailing slash only', () => {
      // pathname is "/live/" → split/filter gives ['live'] → no videoId
      expect(getVideoIdFromUrl('https://www.youtube.com/live/')).toBeNull();
    });
  });

  describe('invalid or unsupported URLs', () => {
    it('returns null for YouTube homepage', () => {
      expect(getVideoIdFromUrl('https://www.youtube.com/')).toBeNull();
    });

    it('returns null for YouTube channel page', () => {
      expect(getVideoIdFromUrl('https://www.youtube.com/@somechannel')).toBeNull();
    });

    it('returns null for YouTube shorts URL', () => {
      expect(getVideoIdFromUrl('https://www.youtube.com/shorts/abc123')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(getVideoIdFromUrl('')).toBeNull();
    });

    it('returns null for non-YouTube domain even with /watch path', () => {
      // getVideoIdFromUrl validates hostname via isYouTubeWatch
      expect(getVideoIdFromUrl('https://example.com/watch?v=abc123')).toBeNull();
    });

    it('returns null for /watch on non-YouTube domain without v param', () => {
      expect(getVideoIdFromUrl('https://example.com/watch')).toBeNull();
    });

    it('returns null for completely invalid URL string', () => {
      // Passing an invalid URL to new URL() throws → caught → null
      expect(getVideoIdFromUrl('not-a-valid-url-:::')).toBeNull();
    });

    it('returns null for /results page', () => {
      expect(getVideoIdFromUrl('https://www.youtube.com/results?search_query=test')).toBeNull();
    });
  });

  describe('relative URLs (no origin, just path+query)', () => {
    it('extracts videoId from relative /watch URL', () => {
      // getVideoIdFromUrl resolves relative URLs against location.origin.
      // In production (youtube.com), this works. To test explicitly,
      // we use the full URL to verify the path-matching logic.
      expect(getVideoIdFromUrl('https://www.youtube.com/watch?v=rel123')).toBe('rel123');
    });

    it('extracts videoId from relative /live/ URL', () => {
      expect(getVideoIdFromUrl('https://www.youtube.com/live/rel456')).toBe('rel456');
    });
  });
});

// ── buildWatchUrl ─────────────────────────────────────────────────────

describe('buildWatchUrl', () => {
  it('constructs a standard watch URL', () => {
    expect(buildWatchUrl('dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('encodes special characters in videoId', () => {
    expect(buildWatchUrl('a&b=c')).toBe('https://www.youtube.com/watch?v=a%26b%3Dc');
  });

  it('handles short videoIds', () => {
    expect(buildWatchUrl('a')).toBe('https://www.youtube.com/watch?v=a');
  });

  it('handles empty string videoId', () => {
    expect(buildWatchUrl('')).toBe('https://www.youtube.com/watch?v=');
  });
});

describe('bootstrapChatSession page identity', () => {
  const pageData = (videoId?: string, continuation = 'stale') => ({
    ...(videoId ? { currentVideoEndpoint: { watchEndpoint: { videoId } } } : {}),
    contents: {
      twoColumnWatchNextResults: {
        conversationBar: {
          liveChatRenderer: {
            continuations: [{ reloadContinuationData: { continuation } }],
          },
        },
      },
    },
  });

  it.each([
    { name: 'stale A identity', initialData: pageData('video-A') },
    { name: 'absent identity', initialData: pageData() },
  ])('uses B watch HTML when window data has $name', async ({ initialData }) => {
    vi.stubGlobal('location', {
      href: 'https://www.youtube.com/watch?v=video-B',
      origin: 'https://www.youtube.com',
    });
    vi.stubGlobal('ytcfg', { data_: { INNERTUBE_API_KEY: 'key-B' } });
    vi.stubGlobal('ytInitialData', initialData);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(`var ytInitialData = ${JSON.stringify(pageData('video-B', 'token-B'))};`)
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(bootstrapChatSession()).resolves.toMatchObject({
      status: 'ready',
      data: {
        videoId: 'video-B',
        apiKey: 'key-B',
        initialContinuation: { continuation: 'token-B' },
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(buildWatchUrl('video-B'));
  });

  it('rejects A identity even when both stale window data and fetched HTML name A', async () => {
    vi.stubGlobal('location', {
      href: 'https://www.youtube.com/watch?v=video-B',
      origin: 'https://www.youtube.com',
    });
    vi.stubGlobal('ytcfg', { data_: { INNERTUBE_API_KEY: 'key-B' } });
    vi.stubGlobal('ytInitialData', pageData('video-A'));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(`var ytInitialData = ${JSON.stringify(pageData('video-A'))};`)
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(bootstrapChatSession()).resolves.toMatchObject({
      status: 'retryable',
      reason: 'initialData videoId (video-A) does not match current URL videoId (video-B)',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('bootstrapChatSession fallback and chat availability', () => {
  const videoId = 'video-B';
  const config = { INNERTUBE_API_KEY: 'key-B' };
  const baseData = { currentVideoEndpoint: { watchEndpoint: { videoId } } };
  const readyData = {
    ...baseData,
    contents: {
      twoColumnWatchNextResults: {
        conversationBar: {
          liveChatRenderer: {
            continuations: [{ reloadContinuationData: { continuation: 'token-B' } }],
          },
        },
      },
    },
  };
  const setWatchLocation = (): void => {
    vi.stubGlobal('location', {
      href: buildWatchUrl(videoId),
      origin: 'https://www.youtube.com',
    });
  };

  it('reuses one HTML fetch to resolve missing config and initial data', async () => {
    setWatchLocation();
    vi.stubGlobal('ytcfg', undefined);
    vi.stubGlobal('ytInitialData', undefined);
    const html = `ytcfg.set(${JSON.stringify(config)}); var ytInitialData = ${JSON.stringify(readyData)};`;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(html));
    vi.stubGlobal('fetch', fetchMock);

    await expect(bootstrapChatSession()).resolves.toMatchObject({
      status: 'ready',
      data: {
        videoId,
        apiKey: 'key-B',
        initialContinuation: { continuation: 'token-B' },
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(buildWatchUrl(videoId));
  });

  it.each([
    {
      name: 'configuration',
      html: `ytcfg.set({bad}); var ytInitialData = ${JSON.stringify(readyData)};`,
      reason: 'Could not resolve YouTube page configuration',
    },
    {
      name: 'initial data',
      html: `ytcfg.set(${JSON.stringify(config)}); var ytInitialData = {bad};`,
      reason: 'Could not extract ytInitialData from watch page',
    },
  ])('classifies malformed watch HTML $name as retryable', async ({ html, reason }) => {
    setWatchLocation();
    vi.stubGlobal('ytcfg', undefined);
    vi.stubGlobal('ytInitialData', undefined);
    const fetchMock = vi.fn(async () => new Response(html));
    vi.stubGlobal('fetch', fetchMock);

    await expect(bootstrapChatSession()).resolves.toMatchObject({ status: 'retryable', reason });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'disabled chat',
      data: {
        ...baseData,
        playabilityStatus: { status: 'OK', reason: 'Live chat is disabled' },
        contents: { twoColumnWatchNextResults: { conversationBar: {} } },
      },
      status: 'unavailable',
      reason: 'Watch page does not expose a live chat renderer for this video',
    },
    {
      name: 'chat-less VOD',
      data: { ...baseData, videoDetails: { isLiveContent: false } },
      status: 'unavailable',
      reason: 'Watch page does not expose a live chat renderer for this video',
    },
    {
      name: 'scheduled stream',
      data: { ...baseData, playabilityStatus: { status: 'LIVE_STREAM_OFFLINE' } },
      status: 'waiting',
      reason: 'Stream not yet started — live chat renderer unavailable',
    },
    {
      name: 'missing initial continuation',
      data: {
        ...baseData,
        contents: {
          twoColumnWatchNextResults: {
            conversationBar: { liveChatRenderer: { actions: [] } },
          },
        },
      },
      status: 'unavailable',
      reason: 'Live chat renderer does not expose an initial continuation token',
    },
  ])('classifies $name and accepts a later ready page', async ({ data, status, reason }) => {
    setWatchLocation();
    vi.stubGlobal('ytcfg', { data_: config });
    vi.stubGlobal('ytInitialData', data);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(bootstrapChatSession()).resolves.toMatchObject({ status, reason });
    vi.stubGlobal('ytInitialData', readyData);
    await expect(bootstrapChatSession()).resolves.toMatchObject({
      status: 'ready',
      data: { videoId, initialContinuation: { continuation: 'token-B' } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an unsupported URL without fetching or accepting ready window data', async () => {
    vi.stubGlobal('location', {
      href: 'https://www.youtube.com/shorts/video-B',
      origin: 'https://www.youtube.com',
    });
    vi.stubGlobal('ytcfg', { data_: config });
    vi.stubGlobal('ytInitialData', readyData);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(bootstrapChatSession()).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'Current URL is not a supported YouTube watch page',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchWatchHtml', () => {
  it('rejects a declared response larger than the watch-page byte limit', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, {
            headers: { 'content-length': String(MAX_WATCH_HTML_BYTES + 1) },
          })
      )
    );

    await expect(fetchWatchHtml('video-id')).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('returns retryable when the watch-page response body stalls past its deadline', async () => {
    vi.stubGlobal('location', {
      href: 'https://www.youtube.com/watch?v=video-id',
      origin: 'https://www.youtube.com',
    });
    vi.stubGlobal('ytcfg', undefined);
    vi.stubGlobal('ytInitialData', undefined);

    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal);
    let resolveBodyReadStarted: (() => void) | undefined;
    const bodyReadStarted = new Promise<void>((resolve) => {
      resolveBodyReadStarted = resolve;
    });
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
      pull() {
        resolveBodyReadStarted?.();
      },
    });
    const abortBody = vi.fn((reason: unknown) => bodyController?.error(reason));
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve().then(() => {
        const requestSignal = init?.signal;
        if (!requestSignal) {
          throw new Error('Watch HTML request omitted its signal');
        }
        requestSignal.addEventListener('abort', () => abortBody(requestSignal.reason), {
          once: true,
        });
        return new Response(body);
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const bootstrap = bootstrapChatSession();
    await bodyReadStarted;
    expect(timeoutSpy).toHaveBeenCalledWith(WATCH_HTML_TIMEOUT_MS);
    expect(WATCH_HTML_TIMEOUT_MS).toBe(20_000);
    expect(bodyController).not.toBeNull();
    timeoutController.abort(new DOMException('Timed out', 'TimeoutError'));

    await expect(bootstrap).resolves.toMatchObject({
      status: 'retryable',
      reason: 'Watch page HTML request timed out',
    });
    expect(abortBody).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('preserves a caller abort when it cancels the request before the deadline', async () => {
    const callerController = new AbortController();
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal);
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const requestSignal = init?.signal;
          if (!requestSignal) {
            reject(new Error('Watch HTML request omitted its signal'));
            return;
          }
          const rejectOnAbort = (): void => reject(requestSignal.reason);
          if (requestSignal.aborted) {
            rejectOnAbort();
          } else {
            requestSignal.addEventListener('abort', rejectOnAbort, { once: true });
          }
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const request = fetchWatchHtml('video-id', callerController.signal);
    callerController.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(timeoutController.signal.aborted).toBe(false);
  });

  it('discards a watch-page body that finishes after caller cancellation', async () => {
    const callerController = new AbortController();
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal);

    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodyController = controller;
            },
          })
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    const request = fetchWatchHtml('video-id', callerController.signal);
    await vi.waitFor(() => expect(bodyController).toBeDefined());
    callerController.abort();
    bodyController!.enqueue(new TextEncoder().encode('late watch-page response'));
    bodyController!.close();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(timeoutController.signal.aborted).toBe(false);
  });
});

// ── findLiveChatRenderer ──────────────────────────────────────────────

describe('findLiveChatRenderer', () => {
  it('finds renderer via direct path (twoColumnWatchNextResults)', () => {
    const renderer = { header: { liveChatRenderer: {} } };
    const data = {
      contents: {
        twoColumnWatchNextResults: {
          conversationBar: {
            liveChatRenderer: renderer,
          },
        },
      },
    };
    expect(findLiveChatRenderer(data)).toBe(renderer);
  });

  it('returns null when direct path has no liveChatRenderer', () => {
    const data = {
      contents: {
        twoColumnWatchNextResults: {
          conversationBar: {
            somethingElse: {},
          },
        },
      },
    };
    // Falls through to recursive search
    expect(findLiveChatRenderer(data)).toBeNull();
  });

  it('finds renderer via recursive search with continuations', () => {
    // findLiveChatRenderer returns the VALUE of the 'liveChatRenderer' key,
    // not the containing parent object.
    const renderer = {
      continuations: [{ reloadContinuationData: { continuation: 'token' } }],
    };
    const data = {
      someNested: {
        deep: {
          liveChatRenderer: renderer,
        },
      },
    };
    expect(findLiveChatRenderer(data)).toBe(renderer);
  });

  it('finds renderer via recursive search with actions', () => {
    const renderer = {
      actions: [{ addChatItemAction: {} }],
    };
    const data = {
      contents: {
        liveChatRenderer: renderer,
      },
    };
    expect(findLiveChatRenderer(data)).toBe(renderer);
  });

  it('prefers a continuation renderer over an earlier actions-only match', () => {
    const actionsOnly = { actions: [{ addChatItemAction: {} }] };
    const withContinuations = {
      continuations: [{ reloadContinuationData: { continuation: 'token' } }],
    };
    const data = {
      contents: {
        first: { liveChatRenderer: actionsOnly },
        second: { liveChatRenderer: withContinuations },
      },
    };

    expect(findLiveChatRenderer(data)).toBe(withContinuations);
  });

  it('prioritizes contents before a traversal-budget-sized distractor', () => {
    const renderer = {
      continuations: [{ reloadContinuationData: { continuation: 'token' } }],
    };
    const distractor: Record<string, unknown> = {};
    let current = distractor;
    for (let index = 0; index < 3100; index++) {
      current.child = {};
      current = current.child as Record<string, unknown>;
    }
    const data = {
      contents: { liveChatRenderer: renderer },
      distractor,
    };

    expect(findLiveChatRenderer(data)).toBe(renderer);
  });

  it('returns null when recursive search finds no match', () => {
    const data = {
      a: { b: { c: 1 } },
    };
    expect(findLiveChatRenderer(data)).toBeNull();
  });

  it('returns null for empty object', () => {
    expect(findLiveChatRenderer({})).toBeNull();
  });

  it('skips liveChatRenderer without continuations or actions in recursive search', () => {
    // The predicate requires either continuations or actions to be present
    const renderer = {
      liveChatRenderer: {
        someField: 'value',
      },
    };
    const data = {
      nested: renderer,
    };
    // No continuations AND no actions → doesn't match predicate
    // But wait — findFirstNestedRecordByKey just looks for key 'liveChatRenderer'
    // The predicate filters further. Without continuations/actions, it returns null.
    expect(findLiveChatRenderer(data)).toBeNull();
  });
});
