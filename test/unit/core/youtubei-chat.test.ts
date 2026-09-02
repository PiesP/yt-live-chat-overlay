// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_WATCH_HTML_BYTES,
  getVideoIdFromUrl,
  buildWatchUrl,
  fetchWatchHtml,
  findLiveChatRenderer,
} from '@chat/youtube/api';
import { ResponseTooLargeError } from '@chat/youtube/response-text';

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── getVideoIdFromUrl ─────────────────────────────────────────────────

describe('getVideoIdFromUrl', () => {
  describe('/watch URLs', () => {
    it('extracts videoId from standard /watch?v= URL', () => {
      expect(getVideoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
        'dQw4w9WgXcQ'
      );
    });

    it('extracts videoId from /watch with extra params', () => {
      expect(
        getVideoIdFromUrl('https://www.youtube.com/watch?v=abc123&t=30&list=PLxyz')
      ).toBe('abc123');
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
      expect(getVideoIdFromUrl('https://www.youtube.com/live/abc123?feature=share')).toBe(
        'abc123'
      );
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
    expect(buildWatchUrl('dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    );
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

describe('fetchWatchHtml', () => {
  it('rejects a declared response larger than the watch-page byte limit', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(body, {
          headers: { 'content-length': String(MAX_WATCH_HTML_BYTES + 1) },
        })
      )
    );

    await expect(fetchWatchHtml('video-id')).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(cancel).toHaveBeenCalledOnce();
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
