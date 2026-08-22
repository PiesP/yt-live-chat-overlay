import { describe, it, expect } from 'vitest';
import {
  countCodePoints,
  extractActionItem,
  extractSupportedRenderer,
  extractAuthorType,
  classifyAuthorBadge,
  getVisibleContentLength,
  isSubstantialMessage,
  extractChatEvents,
} from '@chat/message-parser';
import type { ParsedMessageBody } from '@chat/message-parser';
import type { ContentSegment, OverlaySettings } from '@app-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeBody = (overrides: Partial<ParsedMessageBody> = {}): ParsedMessageBody => ({
  text: '',
  content: [],
  visibleLength: 0,
  ...overrides,
});

const makeEmojiSegment = (): ContentSegment => ({
  type: 'emoji',
  emoji: { url: 'https://example.com/emoji.png', alt: 'emoji' },
});

const mkSettings = (overrides: Partial<OverlaySettings> = {}): OverlaySettings =>
  ({
    allowShortTextMessages: false,
    minTextLength: 3,
    ...overrides,
  }) as unknown as OverlaySettings;

// ---------------------------------------------------------------------------
// countCodePoints
// ---------------------------------------------------------------------------

describe('countCodePoints', () => {
  it('returns 0 for empty string', () => {
    expect(countCodePoints('')).toBe(0);
  });

  it('counts ASCII characters', () => {
    expect(countCodePoints('hello')).toBe(5);
  });

  it('counts Korean Hangul syllables (each = 1 grapheme)', () => {
    expect(countCodePoints('안녕하세요')).toBe(5);
  });

  it('counts Japanese characters', () => {
    expect(countCodePoints('こんにちは')).toBe(5);
  });

  it('counts emoji as single code points', () => {
    expect(countCodePoints('😀🎉')).toBe(2);
  });

  it('counts mixed ASCII + emoji', () => {
    expect(countCodePoints('hi😀')).toBe(3);
  });

  it('counts a single space', () => {
    expect(countCodePoints(' ')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// extractActionItem
// ---------------------------------------------------------------------------

describe('extractActionItem', () => {
  it('extracts item from addChatItemAction', () => {
    const item = { id: 1 };
    const action = {
      addChatItemAction: { item },
    };
    expect(extractActionItem(action)).toEqual({ item, actionType: 'add' });
  });

  it('extracts item from replaceChatItemAction', () => {
    const item = { id: 2 };
    const action = {
      replaceChatItemAction: { item },
    };
    expect(extractActionItem(action)).toEqual({ item, actionType: 'replace' });
  });

  it('returns null when addChatItemAction has no item', () => {
    const action = {
      addChatItemAction: {},
    };
    expect(extractActionItem(action)).toBeNull();
  });

  it('returns null when addChatItemAction item is null', () => {
    const action = {
      addChatItemAction: { item: null },
    };
    expect(extractActionItem(action)).toBeNull();
  });

  it('returns null for action with neither addChatItemAction nor replaceChatItemAction', () => {
    const action = { someOtherKey: {} };
    expect(extractActionItem(action)).toBeNull();
  });

  it('returns null for null action', () => {
    expect(extractActionItem(null as unknown as Record<string, unknown>)).toBeNull();
  });

  it('returns null for undefined action', () => {
    expect(extractActionItem(undefined as unknown as Record<string, unknown>)).toBeNull();
  });

  it('returns null for non-object action (string)', () => {
    expect(extractActionItem('hello' as unknown as Record<string, unknown>)).toBeNull();
  });

  it('returns null for non-object action (number)', () => {
    expect(extractActionItem(42 as unknown as Record<string, unknown>)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractSupportedRenderer
// ---------------------------------------------------------------------------

describe('extractSupportedRenderer', () => {
  it('recognizes liveChatTextMessageRenderer', () => {
    const renderer = { message: {}, authorName: {} };
    const item = { liveChatTextMessageRenderer: renderer };
    const result = extractSupportedRenderer(item);
    expect(result).toEqual({ kind: 'text', renderer });
  });

  it('recognizes liveChatPaidMessageRenderer as superchat', () => {
    const renderer = { purchaseAmountText: {} };
    const item = { liveChatPaidMessageRenderer: renderer };
    const result = extractSupportedRenderer(item);
    expect(result).toEqual({ kind: 'superchat', renderer });
  });

  it('recognizes liveChatPaidStickerRenderer as superchat', () => {
    const renderer = {};
    const item = { liveChatPaidStickerRenderer: renderer };
    const result = extractSupportedRenderer(item);
    expect(result).toEqual({ kind: 'superchat', renderer });
  });

  it('recognizes liveChatMembershipItemRenderer', () => {
    const renderer = { message: {} };
    const item = { liveChatMembershipItemRenderer: renderer };
    const result = extractSupportedRenderer(item);
    expect(result).toEqual({ kind: 'membership', renderer });
  });

  it('returns null for unknown renderer type', () => {
    const item = { unknownRenderer: {} };
    expect(extractSupportedRenderer(item)).toBeNull();
  });

  it('returns null for empty object', () => {
    expect(extractSupportedRenderer({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractAuthorType
// ---------------------------------------------------------------------------

describe('extractAuthorType', () => {
  it('returns normal for empty array', () => {
    expect(extractAuthorType([])).toBe('normal');
  });

  it('returns normal for non-array input', () => {
    expect(extractAuthorType('string')).toBe('normal');
    expect(extractAuthorType(42)).toBe('normal');
    expect(extractAuthorType(null)).toBe('normal');
    expect(extractAuthorType({})).toBe('normal');
  });

  it('returns normal for unknown badge', () => {
    expect(extractAuthorType([{ unknownBadge: {} }])).toBe('normal');
  });

  it('returns owner for owner badge', () => {
    expect(
      extractAuthorType([
        {
          liveChatAuthorBadgeRenderer: {
            icon: { iconType: 'OWNER' },
          },
        },
      ]),
    ).toBe('owner');
  });

  it('returns moderator for moderator badge', () => {
    expect(
      extractAuthorType([
        {
          liveChatAuthorBadgeRenderer: {
            icon: { iconType: 'MODERATOR' },
          },
        },
      ]),
    ).toBe('moderator');
  });

  it('returns member for member badge', () => {
    expect(
      extractAuthorType([
        {
          liveChatAuthorBadgeRenderer: {
            icon: { iconType: 'SPONSOR' },
          },
        },
      ]),
    ).toBe('member');
  });

  it('returns verified for verified badge', () => {
    expect(
      extractAuthorType([
        {
          liveChatAuthorBadgeRenderer: {
            style: 'VERIFIED',
          },
        },
      ]),
    ).toBe('verified');
  });

  it('returns owner when owner + moderator badges present (highest priority)', () => {
    expect(
      extractAuthorType([
        {
          liveChatAuthorBadgeRenderer: {
            icon: { iconType: 'MODERATOR' },
          },
        },
        {
          liveChatAuthorBadgeRenderer: {
            icon: { iconType: 'OWNER' },
          },
        },
      ]),
    ).toBe('owner');
  });

  it('returns moderator when moderator + member badges present', () => {
    expect(
      extractAuthorType([
        {
          liveChatAuthorBadgeRenderer: {
            icon: { iconType: 'SPONSOR' },
          },
        },
        {
          liveChatAuthorBadgeRenderer: {
            icon: { iconType: 'MODERATOR' },
          },
        },
      ]),
    ).toBe('moderator');
  });
});

// ---------------------------------------------------------------------------
// classifyAuthorBadge
// ---------------------------------------------------------------------------

describe('classifyAuthorBadge', () => {
  it('returns owner for OWNER iconType', () => {
    expect(
      classifyAuthorBadge({
        liveChatAuthorBadgeRenderer: {
          icon: { iconType: 'OWNER' },
        },
      }),
    ).toBe('owner');
  });

  it('returns moderator for MODERATOR iconType via metadataBadgeRenderer', () => {
    expect(
      classifyAuthorBadge({
        metadataBadgeRenderer: {
          icon: { iconType: 'MODERATOR' },
        },
      }),
    ).toBe('moderator');
  });

  it('returns member for SPONSOR iconType', () => {
    expect(
      classifyAuthorBadge({
        liveChatAuthorBadgeRenderer: {
          icon: { iconType: 'SPONSOR' },
        },
      }),
    ).toBe('member');
  });

  it('returns member for MEMBERS_ONLY style', () => {
    expect(
      classifyAuthorBadge({
        liveChatAuthorBadgeRenderer: {
          style: 'MEMBERS_ONLY',
        },
      }),
    ).toBe('member');
  });

  it('returns member for badge with customThumbnail', () => {
    expect(
      classifyAuthorBadge({
        liveChatAuthorBadgeRenderer: {
          customThumbnail: { thumbnails: [] },
        },
      }),
    ).toBe('member');
  });

  it('returns verified for VERIFIED style', () => {
    expect(
      classifyAuthorBadge({
        liveChatAuthorBadgeRenderer: {
          style: 'VERIFIED',
        },
      }),
    ).toBe('verified');
  });

  it('returns normal for unknown badge', () => {
    expect(
      classifyAuthorBadge({
        unknownRenderer: {},
      }),
    ).toBe('normal');
  });

  it('returns normal for non-object input', () => {
    expect(classifyAuthorBadge('hello')).toBe('normal');
    expect(classifyAuthorBadge(42)).toBe('normal');
  });

  it('returns normal for null', () => {
    expect(classifyAuthorBadge(null)).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// getVisibleContentLength
// ---------------------------------------------------------------------------

describe('getVisibleContentLength', () => {
  it('returns 0 for empty array', () => {
    expect(getVisibleContentLength([])).toBe(0);
  });

  it('counts single text segment characters', () => {
    expect(getVisibleContentLength([{ type: 'text', content: 'hello' }])).toBe(5);
  });

  it('counts single emoji segment as 1', () => {
    expect(getVisibleContentLength([makeEmojiSegment()])).toBe(1);
  });

  it('counts mixed text + emoji segments', () => {
    const segments: ContentSegment[] = [
      { type: 'text', content: 'hi' },
      makeEmojiSegment(),
    ];
    expect(getVisibleContentLength(segments)).toBe(3); // 2 + 1
  });

  it('strips whitespace from text segments', () => {
    expect(getVisibleContentLength([{ type: 'text', content: '  a  b  ' }])).toBe(2); // a, b
  });

  it('strips control characters from text segments', () => {
    // \x01 is a control character, should be stripped
    expect(getVisibleContentLength([{ type: 'text', content: 'a\x01b' }])).toBe(2);
  });

  it('counts multiple text and emoji segments', () => {
    const segments: ContentSegment[] = [
      { type: 'text', content: 'hello' },
      makeEmojiSegment(),
      { type: 'text', content: 'world' },
    ];
    expect(getVisibleContentLength(segments)).toBe(11); // 5 + 1 + 5
  });
});

// ---------------------------------------------------------------------------
// isSubstantialMessage
// ---------------------------------------------------------------------------

describe('isSubstantialMessage', () => {
  const settings = mkSettings();

  it('returns true when allowShortTextMessages is true (always substantial)', () => {
    const s = mkSettings({ allowShortTextMessages: true });
    expect(isSubstantialMessage(makeBody(), 'normal', s)).toBe(true);
  });

  it('returns true for moderator authorType regardless of content', () => {
    expect(isSubstantialMessage(makeBody(), 'moderator', settings)).toBe(true);
  });

  it('returns true for owner authorType regardless of content', () => {
    expect(isSubstantialMessage(makeBody(), 'owner', settings)).toBe(true);
  });

  it('returns true for member authorType regardless of content', () => {
    expect(isSubstantialMessage(makeBody(), 'member', settings)).toBe(true);
  });

  it('returns true when body has emoji content', () => {
    const body = makeBody({ content: [makeEmojiSegment()] });
    expect(isSubstantialMessage(body, 'normal', settings)).toBe(true);
  });

  it('returns true when text matches EMOJI_TEXT_PATTERN', () => {
    const body = makeBody({ text: '😀' });
    expect(isSubstantialMessage(body, 'normal', settings)).toBe(true);
  });

  it('returns true when visibleLength >= minTextLength', () => {
    const body = makeBody({ visibleLength: 3 });
    expect(isSubstantialMessage(body, 'normal', settings)).toBe(true);
  });

  it('returns false when visibleLength < minTextLength', () => {
    const body = makeBody({ visibleLength: 2 });
    expect(isSubstantialMessage(body, 'normal', settings)).toBe(false);
  });

  it('returns false for empty body with normal author', () => {
    expect(isSubstantialMessage(makeBody(), 'normal', settings)).toBe(false);
  });

  it('returns false for verified author with short text', () => {
    // verified is not a privileged type
    const body = makeBody({ visibleLength: 2 });
    expect(isSubstantialMessage(body, 'verified', settings)).toBe(false);
  });

  it('uses Math.max(1, settings.minTextLength) so minLength is at least 1', () => {
    const s = mkSettings({ minTextLength: 0 });
    const body = makeBody({ visibleLength: 1 });
    expect(isSubstantialMessage(body, 'normal', s)).toBe(true);
  });

  it('returns false for empty body with minTextLength=0 and visibleLength=0', () => {
    const s = mkSettings({ minTextLength: 0 });
    expect(isSubstantialMessage(makeBody({ visibleLength: 0 }), 'normal', s)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractChatEvents message-boundary normalization
// ---------------------------------------------------------------------------

describe('extractChatEvents message-boundary normalization', () => {
  const parseRenderer = (rendererKey: string, renderer: Record<string, unknown>) =>
    extractChatEvents(
      [
        {
          addChatItemAction: {
            item: { [rendererKey]: renderer },
          },
        },
      ],
      () => mkSettings({ allowShortTextMessages: true })
    )[0]?.message;

  it('normalizes and truncates long regular simpleText in both text and rich content', () => {
    const message = parseRenderer('liveChatTextMessageRenderer', {
      id: 'long-simple',
      authorName: { simpleText: 'Viewer' },
      message: { simpleText: `  ${'a'.repeat(90)}  ` },
    });

    const expected = `${'a'.repeat(79)}\u2026`;
    expect(message).toMatchObject({
      text: expected,
      content: [{ type: 'text', content: expected }],
      kind: 'text',
    });
    expect(getVisibleContentLength(message?.content ?? [])).toBe(80);
  });

  it('keeps mixed text and emoji segments within the same regular-message boundary', () => {
    const message = parseRenderer('liveChatTextMessageRenderer', {
      id: 'long-rich',
      authorName: { simpleText: 'Viewer' },
      message: {
        runs: [
          { text: 'a'.repeat(70) },
          {
            emoji: {
              shortcuts: [':wave:', '👋'],
              image: {
                thumbnails: [{ url: 'https://yt3.ggpht.com/wave.png' }],
              },
            },
          },
          { text: 'b'.repeat(20) },
        ],
      },
    });

    expect(message?.text).toBe(`${'a'.repeat(70)}👋${'b'.repeat(8)}\u2026`);
    expect(message?.content).toEqual([
      { type: 'text', content: 'a'.repeat(70) },
      {
        type: 'emoji',
        emoji: expect.objectContaining({
          alt: ':wave:',
          fallbackText: '👋',
          url: 'https://yt3.ggpht.com/wave.png',
        }),
      },
      { type: 'text', content: `${'b'.repeat(8)}\u2026` },
    ]);
    expect(getVisibleContentLength(message?.content ?? [])).toBe(80);
  });

  it.each([
    {
      label: 'Super Chat',
      rendererKey: 'liveChatPaidMessageRenderer',
      renderer: {
        id: 'paid-long',
        authorName: { simpleText: 'Supporter' },
        purchaseAmountText: { simpleText: '$5.00' },
        message: { simpleText: 'p'.repeat(120) },
      },
      kind: 'superchat',
    },
    {
      label: 'membership',
      rendererKey: 'liveChatMembershipItemRenderer',
      renderer: {
        id: 'member-long',
        authorName: { simpleText: 'Member' },
        message: { simpleText: 'm'.repeat(120) },
      },
      kind: 'membership',
    },
  ])('preserves the full normalized $label body for paid-card wrapping', ({ rendererKey, renderer, kind }) => {
    const message = parseRenderer(rendererKey, renderer);
    const expected = kind === 'superchat' ? 'p'.repeat(120) : 'm'.repeat(120);

    expect(message).toMatchObject({
      text: expected,
      content: [{ type: 'text', content: expected }],
      kind,
    });
  });
});

describe('extractChatEvents hostile batch bounds', () => {
  const settings = (queueMaxSize: number): OverlaySettings =>
    mkSettings({ allowShortTextMessages: true, queueMaxSize });
  const textAction = (id: string, actionType: 'add' | 'replace' = 'add') => ({
    [`${actionType}ChatItemAction`]: {
      item: {
        liveChatTextMessageRenderer: {
          id,
          authorName: { simpleText: 'Viewer' },
          message: { simpleText: `message-${id}` },
        },
      },
    },
  });
  const paidAction = (id: string, kind: 'superchat' | 'membership') => ({
    addChatItemAction: {
      item:
        kind === 'superchat'
          ? {
              liveChatPaidMessageRenderer: {
                id,
                authorName: { simpleText: 'Supporter' },
                purchaseAmountText: { simpleText: '$5.00' },
                message: { simpleText: 'paid' },
              },
            }
          : {
              liveChatMembershipItemRenderer: {
                id,
                authorName: { simpleText: 'Member' },
                message: { simpleText: 'member' },
              },
            },
    },
  });

  it('caps top-level ordinary actions without capacity scans', () => {
    let stats: import('@chat/message-parser').ChatEventExtractionStats | undefined;
    const events = extractChatEvents(
      Array.from({ length: 2000 }, (_, index) => textAction(`ordinary-${index}`)),
      () => settings(10_000),
      (value) => {
        stats = value;
      }
    );

    expect(events).toHaveLength(1000);
    expect(stats).toMatchObject({ capacity: 1000, ordinaryScanSteps: 0 });
  });

  it('caps all-priority actions without repeated ordinary scans', () => {
    let stats: import('@chat/message-parser').ChatEventExtractionStats | undefined;
    const events = extractChatEvents(
      Array.from({ length: 500 }, (_, index) => paidAction(`paid-${index}`, 'superchat')),
      () => settings(20),
      (value) => {
        stats = value;
      }
    );

    expect(events).toHaveLength(20);
    expect(stats).toMatchObject({ capacityDrops: 60, ordinaryScanSteps: 0 });
  });

  it('counts invalid and nested actions against the traversal budget', () => {
    let invalidStats: import('@chat/message-parser').ChatEventExtractionStats | undefined;
    expect(
      extractChatEvents(Array.from({ length: 1000 }), () => settings(5), (value) => {
        invalidStats = value;
      })
    ).toEqual([]);
    expect(invalidStats).toMatchObject({ traversedActions: 20, budgetExhausted: true });

    let nestedStats: import('@chat/message-parser').ChatEventExtractionStats | undefined;
    const nested = {
      replayChatItemAction: {
        videoOffsetTimeMsec: '1000',
        actions: Array.from({ length: 1000 }, (_, index) => textAction(`nested-${index}`)),
      },
    };
    const events = extractChatEvents([nested], () => settings(5), (value) => {
      nestedStats = value;
    });
    expect(events).toHaveLength(5);
    expect(nestedStats).toMatchObject({ traversedActions: 20, budgetExhausted: true });
  });

  it('updates same-ID replacements and prioritizes protected events at capacity', () => {
    let stats: import('@chat/message-parser').ChatEventExtractionStats | undefined;
    const events = extractChatEvents(
      [
        textAction('a'),
        textAction('b'),
        textAction('c'),
        textAction('b', 'replace'),
        paidAction('paid', 'superchat'),
        paidAction('member', 'membership'),
        textAction('unseen', 'replace'),
      ],
      () => settings(3),
      (value) => {
        stats = value;
      }
    );

    expect(events.map((event) => [event.message.id, event.message.actionType])).toEqual([
      ['paid', 'add'],
      ['b', 'replace'],
      ['member', 'add'],
    ]);
    expect(stats?.ordinaryScanSteps).toBeLessThanOrEqual(3);
  });

  it('does not let a fresh replacement flood evict admitted ordinary events', () => {
    const events = extractChatEvents(
      [
        textAction('a'),
        textAction('b'),
        textAction('c'),
        ...Array.from({ length: 100 }, (_, index) => textAction(`fresh-${index}`, 'replace')),
      ],
      () => settings(3)
    );

    expect(events.map((event) => event.message.id)).toEqual(['a', 'b', 'c']);
  });

  it('allows an optional known-target attestation to protect a replacement', () => {
    const isKnownTarget = (id: string): boolean => id === 'known';
    const events = extractChatEvents(
      [textAction('a'), textAction('b'), textAction('c'), textAction('known', 'replace')],
      () => settings(3),
      undefined,
      isKnownTarget
    );

    expect(events.map((event) => [event.message.id, event.message.actionType])).toEqual([
      ['known', 'replace'],
      ['b', 'add'],
      ['c', 'add'],
    ]);
  });
});
