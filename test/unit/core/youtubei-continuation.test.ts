import { describe, it, expect } from 'vitest';
import {
  extractInitialChatContinuation,
  extractNextLiveContinuation,
  extractReplayContinuation,
  extractPlayerSeekContinuation,
} from '@chat/youtube/continuation';

// ── helpers ──────────────────────────────────────────────────────────

const makeContinuation = (key: string, token: string) => ({
  [key]: { continuation: token },
});

// ── extractInitialChatContinuation ───────────────────────────────────

describe('extractInitialChatContinuation', () => {
  it('extracts from reloadContinuationData', () => {
    const renderer = {
      continuations: [makeContinuation('reloadContinuationData', 'token123')],
    };
    const result = extractInitialChatContinuation(renderer);
    expect(result).toEqual({ continuation: 'token123' });
  });

  it('extracts from invalidationContinuationData', () => {
    const renderer = {
      continuations: [makeContinuation('invalidationContinuationData', 'inv-token')],
    };
    expect(extractInitialChatContinuation(renderer)).toEqual({ continuation: 'inv-token' });
  });

  it('extracts from timedContinuationData', () => {
    const renderer = {
      continuations: [makeContinuation('timedContinuationData', 'timed-token')],
    };
    expect(extractInitialChatContinuation(renderer)).toEqual({ continuation: 'timed-token' });
  });

  it('extracts from liveChatReplayContinuationData', () => {
    const renderer = {
      continuations: [makeContinuation('liveChatReplayContinuationData', 'replay-token')],
    };
    expect(extractInitialChatContinuation(renderer)).toEqual({ continuation: 'replay-token' });
  });

  it('extracts from playerSeekContinuationData', () => {
    const renderer = {
      continuations: [makeContinuation('playerSeekContinuationData', 'seek-token')],
    };
    expect(extractInitialChatContinuation(renderer)).toEqual({ continuation: 'seek-token' });
  });

  it('picks the first matching continuation across items', () => {
    // pickContinuation iterates items in order, then keys in priority order.
    // First item has timedContinuationData → returns it immediately.
    const renderer = {
      continuations: [
        makeContinuation('timedContinuationData', 'timed'),
        makeContinuation('reloadContinuationData', 'reload'),
      ],
    };
    expect(extractInitialChatContinuation(renderer)).toEqual({ continuation: 'timed' });
  });

  it('picks reload from second item when first has no matching keys', () => {
    const renderer = {
      continuations: [
        { unknownKey: { continuation: 'skip' } },
        makeContinuation('reloadContinuationData', 'reload'),
      ],
    };
    expect(extractInitialChatContinuation(renderer)).toEqual({ continuation: 'reload' });
  });

  it('returns null when continuations is not an array', () => {
    expect(extractInitialChatContinuation({ continuations: 'not-array' })).toBeNull();
  });

  it('returns null when continuations is empty', () => {
    expect(extractInitialChatContinuation({ continuations: [] })).toBeNull();
  });

  it('returns null when no known continuation keys exist', () => {
    const renderer = {
      continuations: [{ unknownKey: { continuation: 'token' } }],
    };
    expect(extractInitialChatContinuation(renderer)).toBeNull();
  });

  it('returns null when continuation value is empty string', () => {
    const renderer = {
      continuations: [{ reloadContinuationData: { continuation: '' } }],
    };
    expect(extractInitialChatContinuation(renderer)).toBeNull();
  });

  it('includes clickTrackingParams when present', () => {
    const renderer = {
      continuations: [
        {
          reloadContinuationData: {
            continuation: 'token',
            clickTrackingParams: 'ct-params',
          },
        },
      ],
    };
    expect(extractInitialChatContinuation(renderer)).toEqual({
      continuation: 'token',
      clickTrackingParams: 'ct-params',
    });
  });

  it('includes timeoutMs when present', () => {
    const renderer = {
      continuations: [
        {
          reloadContinuationData: {
            continuation: 'token',
            timeoutMs: 5000,
          },
        },
      ],
    };
    expect(extractInitialChatContinuation(renderer)).toEqual({
      continuation: 'token',
      timeoutMs: 5000,
    });
  });

  it('skips non-record items in continuations array', () => {
    const renderer = {
      continuations: ['string-item', 42, null, makeContinuation('reloadContinuationData', 'token')],
    };
    expect(extractInitialChatContinuation(renderer)).toEqual({ continuation: 'token' });
  });
});

// ── extractNextLiveContinuation ──────────────────────────────────────

describe('extractNextLiveContinuation', () => {
  it('extracts from timedContinuationData', () => {
    const result = extractNextLiveContinuation([
      makeContinuation('timedContinuationData', 'next-token'),
    ]);
    expect(result).toEqual({ continuation: 'next-token' });
  });

  it('picks the first matching continuation across items', () => {
    const result = extractNextLiveContinuation([
      makeContinuation('timedContinuationData', 'timed'),
      makeContinuation('invalidationContinuationData', 'invalidation'),
    ]);
    expect(result).toEqual({ continuation: 'timed' });
  });

  it('picks invalidation from second item when first has no matching keys', () => {
    const result = extractNextLiveContinuation([
      { unknownKey: { continuation: 'skip' } },
      makeContinuation('invalidationContinuationData', 'invalidation'),
    ]);
    expect(result).toEqual({ continuation: 'invalidation' });
  });

  it('returns null for non-array input', () => {
    expect(extractNextLiveContinuation('not-array' as unknown as unknown[])).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(extractNextLiveContinuation([])).toBeNull();
  });
});

// ── extractReplayContinuation ────────────────────────────────────────

describe('extractReplayContinuation', () => {
  it('extracts from liveChatReplayContinuationData', () => {
    const result = extractReplayContinuation([
      makeContinuation('liveChatReplayContinuationData', 'replay-token'),
    ]);
    expect(result).toEqual({ continuation: 'replay-token' });
  });

  it('returns null when only other continuation types exist', () => {
    const result = extractReplayContinuation([
      makeContinuation('timedContinuationData', 'timed'),
    ]);
    expect(result).toBeNull();
  });
});

// ── extractPlayerSeekContinuation ────────────────────────────────────

describe('extractPlayerSeekContinuation', () => {
  it('extracts from playerSeekContinuationData', () => {
    const result = extractPlayerSeekContinuation([
      makeContinuation('playerSeekContinuationData', 'seek-token'),
    ]);
    expect(result).toEqual({ continuation: 'seek-token' });
  });

  it('returns null when only other continuation types exist', () => {
    const result = extractPlayerSeekContinuation([
      makeContinuation('timedContinuationData', 'timed'),
    ]);
    expect(result).toBeNull();
  });
});
