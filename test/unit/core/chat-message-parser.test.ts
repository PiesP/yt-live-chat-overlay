import type { ContentSegment, OverlaySettings } from '@app-types';
import { getTranslatableText } from '@chat/message-helpers';
import {
  classifyAuthorBadge,
  countCodePoints,
  extractActionItem,
  extractAuthorType,
  extractChatEvents,
  extractSupportedRenderer,
  getVisibleContentLength,
  isSubstantialMessage,
  type ParsedMessageBody,
} from '@chat/message-parser';
import {
  MAX_RENDER_CONTENT_SEGMENTS,
  MAX_RENDER_FIELD_CODE_POINTS,
} from '@chat/render-resource-limits';
import { describe, expect, it, vi } from 'vite-plus/test';

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
      ])
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
      ])
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
      ])
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
      ])
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
      ])
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
      ])
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
      })
    ).toBe('owner');
  });

  it('returns moderator for MODERATOR iconType via metadataBadgeRenderer', () => {
    expect(
      classifyAuthorBadge({
        metadataBadgeRenderer: {
          icon: { iconType: 'MODERATOR' },
        },
      })
    ).toBe('moderator');
  });

  it('returns member for SPONSOR iconType', () => {
    expect(
      classifyAuthorBadge({
        liveChatAuthorBadgeRenderer: {
          icon: { iconType: 'SPONSOR' },
        },
      })
    ).toBe('member');
  });

  it('returns member for MEMBERS_ONLY style', () => {
    expect(
      classifyAuthorBadge({
        liveChatAuthorBadgeRenderer: {
          style: 'MEMBERS_ONLY',
        },
      })
    ).toBe('member');
  });

  it('returns member for badge with customThumbnail', () => {
    expect(
      classifyAuthorBadge({
        liveChatAuthorBadgeRenderer: {
          customThumbnail: { thumbnails: [] },
        },
      })
    ).toBe('member');
  });

  it('returns verified for VERIFIED style', () => {
    expect(
      classifyAuthorBadge({
        liveChatAuthorBadgeRenderer: {
          style: 'VERIFIED',
        },
      })
    ).toBe('verified');
  });

  it('returns normal for unknown badge', () => {
    expect(
      classifyAuthorBadge({
        unknownRenderer: {},
      })
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
    const segments: ContentSegment[] = [{ type: 'text', content: 'hi' }, makeEmojiSegment()];
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
    expect(message?.canonicalText).toBe('a'.repeat(90));
    expect(message?.canonicalContent).toEqual([{ type: 'text', content: 'a'.repeat(90) }]);
    if (message) expect(getTranslatableText(message)).toBe('a'.repeat(90));
  });

  it.each([
    ['combining mark', `${'A'.repeat(78)}e\u0301ZZZ`, `${'A'.repeat(78)}…`],
    ['skin tone', `${'A'.repeat(78)}👍🏽Z`, `${'A'.repeat(78)}…`],
    ['family ZWJ', `${'A'.repeat(77)}👨‍👩‍👧‍👦Z`, `${'A'.repeat(77)}…`],
    ['CJK', `${'A'.repeat(79)}界Z`, `${'A'.repeat(79)}…`],
    ['mixed direction', `${'A'.repeat(78)}שָZ`, `${'A'.repeat(78)}…`],
  ])('keeps the %s grapheme whole at the display boundary', (_label, source, display) => {
    const message = parseRenderer('liveChatTextMessageRenderer', {
      id: 'grapheme-boundary',
      authorName: { simpleText: 'Viewer' },
      message: { simpleText: source },
    });
    expect(message?.text).toBe(display);
    expect(message?.canonicalText).toBe(source);
    expect(message?.content).toEqual([{ type: 'text', content: display }]);
  });

  it('keeps a cluster that ends exactly at the code-point boundary', () => {
    const source = `${'A'.repeat(77)}👍🏽Z`;
    const message = parseRenderer('liveChatTextMessageRenderer', {
      id: 'exact-grapheme',
      authorName: { simpleText: 'Viewer' },
      message: { simpleText: source },
    });
    expect(message?.text).toBe(source);
    expect(message?.canonicalText).toBeUndefined();
  });

  it('omits an overlong text run when grapheme segmentation is unavailable', () => {
    vi.stubGlobal('Intl', { Segmenter: undefined });
    try {
      const source = `${'A'.repeat(78)}e\u0301ZZ`;
      const message = parseRenderer('liveChatTextMessageRenderer', {
        id: 'segmenter-unavailable',
        authorName: { simpleText: 'Viewer' },
        message: { simpleText: source },
      });
      expect(message?.text).toBe('…');
      expect(message?.canonicalText).toBe(source);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not retain an emoji image that cannot fit in the visible projection', () => {
    const message = parseRenderer('liveChatTextMessageRenderer', {
      id: 'rich-boundary',
      authorName: { simpleText: 'Viewer' },
      message: {
        runs: [
          { text: 'A'.repeat(78) },
          {
            emoji: {
              shortcuts: ['👨‍👩‍👧‍👦'],
              image: { thumbnails: [{ url: 'https://yt3.ggpht.com/family.png' }] },
            },
          },
          { text: 'Z' },
        ],
      },
    });
    expect(message?.text).toBe(`${'A'.repeat(78)}…`);
    expect(message?.content).toEqual([{ type: 'text', content: `${'A'.repeat(78)}…` }]);
    expect(message?.canonicalContent?.some((segment) => segment.type === 'emoji')).toBe(true);
    if (message) expect(getTranslatableText(message)).toBe(`${'A'.repeat(78)}Z`);
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
    expect(message?.canonicalText).toBe(`${'a'.repeat(70)}👋${'b'.repeat(20)}`);
    expect(message?.canonicalContent?.at(1)).toMatchObject({ type: 'emoji' });
    if (message) expect(getTranslatableText(message)).toBe(`${'a'.repeat(70)}${'b'.repeat(20)}`);
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
        message: { simpleText: 'p'.repeat(400) },
      },
      kind: 'superchat',
    },
    {
      label: 'membership',
      rendererKey: 'liveChatMembershipItemRenderer',
      renderer: {
        id: 'member-long',
        authorName: { simpleText: 'Member' },
        message: { simpleText: 'm'.repeat(400) },
      },
      kind: 'membership',
    },
  ])(
    'preserves the full normalized $label body for paid-card wrapping',
    ({ rendererKey, renderer, kind }) => {
      const message = parseRenderer(rendererKey, renderer);
      const expected = kind === 'superchat' ? 'p'.repeat(400) : 'm'.repeat(400);

      expect(message).toMatchObject({
        text: expected,
        content: [{ type: 'text', content: expected }],
        kind,
      });
    }
  );

  it('accepts the exact astral input boundary and rejects one code point above it', () => {
    let exactStats: import('@chat/message-parser').ChatEventExtractionStats | undefined;
    const exact = extractChatEvents(
      [
        {
          addChatItemAction: {
            item: {
              liveChatTextMessageRenderer: {
                id: 'exact-astral',
                message: { simpleText: '😀'.repeat(MAX_RENDER_FIELD_CODE_POINTS) },
              },
            },
          },
        },
      ],
      () => mkSettings({ allowShortTextMessages: true }),
      (stats) => {
        exactStats = stats;
      }
    );
    expect(exact).toHaveLength(1);
    expect(exactStats?.resourceDrops).toBe(0);

    let overStats: import('@chat/message-parser').ChatEventExtractionStats | undefined;
    const over = extractChatEvents(
      [
        {
          addChatItemAction: {
            item: {
              liveChatTextMessageRenderer: {
                id: 'over-astral',
                message: { simpleText: '😀'.repeat(MAX_RENDER_FIELD_CODE_POINTS + 1) },
              },
            },
          },
        },
      ],
      () => mkSettings({ allowShortTextMessages: true }),
      (stats) => {
        overStats = stats;
      }
    );
    expect(over).toEqual([]);
    expect(overStats?.resourceDrops).toBe(1);
  });

  it('accepts 512 rich runs and rejects the next run before segment allocation', () => {
    const makeAction = (runCount: number) => ({
      addChatItemAction: {
        item: {
          liveChatTextMessageRenderer: {
            id: `runs-${runCount}`,
            message: { runs: Array.from({ length: runCount }, () => ({ text: 'a' })) },
          },
        },
      },
    });

    let stats: import('@chat/message-parser').ChatEventExtractionStats | undefined;
    const events = extractChatEvents(
      [
        makeAction(MAX_RENDER_CONTENT_SEGMENTS),
        makeAction(MAX_RENDER_CONTENT_SEGMENTS + 1),
        makeAction(1),
      ],
      () => mkSettings({ allowShortTextMessages: true, queueMaxSize: 10 }),
      (value) => {
        stats = value;
      }
    );
    expect(events.map((event) => event.message.id)).toEqual([
      `runs-${MAX_RENDER_CONTENT_SEGMENTS}`,
      'runs-1',
    ]);
    expect(stats?.resourceDrops).toBe(1);
  });

  it('isolates oversized author, paid amount, and membership header from healthy neighbors', () => {
    const action = (key: string, id: string, renderer: Record<string, unknown>) => ({
      addChatItemAction: { item: { [key]: { id, ...renderer } } },
    });
    const healthy = (id: string) =>
      action('liveChatTextMessageRenderer', id, {
        authorName: { simpleText: 'Viewer' },
        message: { simpleText: 'hello' },
      });
    let stats: import('@chat/message-parser').ChatEventExtractionStats | undefined;
    const events = extractChatEvents(
      [
        healthy('before'),
        action('liveChatTextMessageRenderer', 'large-author', {
          authorName: { simpleText: 'a'.repeat(MAX_RENDER_FIELD_CODE_POINTS + 1) },
          message: { simpleText: 'hello' },
        }),
        action('liveChatPaidMessageRenderer', 'large-amount', {
          authorName: { simpleText: 'Supporter' },
          purchaseAmountText: { simpleText: 'a'.repeat(MAX_RENDER_FIELD_CODE_POINTS + 1) },
          message: { simpleText: 'thanks' },
        }),
        action('liveChatMembershipItemRenderer', 'large-header', {
          authorName: { simpleText: 'Member' },
          headerPrimaryText: { simpleText: 'a'.repeat(MAX_RENDER_FIELD_CODE_POINTS + 1) },
          message: { simpleText: 'joined' },
        }),
        healthy('after'),
      ],
      () => mkSettings({ allowShortTextMessages: true, queueMaxSize: 10 }),
      (value) => {
        stats = value;
      }
    );

    expect(events.map((event) => event.message.id)).toEqual(['before', 'after']);
    expect(stats?.resourceDrops).toBe(3);
    expect(stats?.traversedActions).toBe(5);
  });

  it('admits the combined paid-card limit and recovers after a one-point aggregate overage', () => {
    const paidAction = (id: string, bodyLength: number) => ({
      addChatItemAction: {
        item: {
          liveChatPaidMessageRenderer: {
            id,
            authorName: { simpleText: 'a'.repeat(2000) },
            purchaseAmountText: { simpleText: 'b'.repeat(1000) },
            message: { simpleText: 'c'.repeat(bodyLength) },
          },
        },
      },
    });
    let stats: import('@chat/message-parser').ChatEventExtractionStats | undefined;
    const events = extractChatEvents(
      [paidAction('exact', 1096), paidAction('over', 1097), paidAction('recovered', 1)],
      () => mkSettings({ allowShortTextMessages: true, queueMaxSize: 10 }),
      (value) => {
        stats = value;
      }
    );

    expect(events.map((event) => event.message.id)).toEqual(['exact', 'recovered']);
    expect(events[0]?.message.text).toHaveLength(1096);
    expect(stats?.resourceDrops).toBe(1);
  });

  it('isolates incomplete paid items and preserves membership fallback and healthy neighbors', () => {
    const action = (key: string, id: string, renderer: Record<string, unknown>) => ({
      addChatItemAction: { item: { [key]: { id, ...renderer } } },
    });
    const actions = [
      action('liveChatTextMessageRenderer', 'before', {
        message: { simpleText: 'hello' },
      }),
      action('unknownRenderer', 'unknown', { message: { simpleText: 'unknown' } }),
      action('liveChatPaidStickerRenderer', 'sticker-without-amount', {
        sticker: { thumbnails: [{ url: 'https://yt3.ggpht.com/sticker' }] },
      }),
      action('liveChatPaidMessageRenderer', 'paid-without-amount', {
        message: { simpleText: 'paid' },
      }),
      action('liveChatMembershipItemRenderer', 'member-fallback', {
        headerSubtext: { simpleText: 'Member for 12 months' },
      }),
      action('liveChatPaidStickerRenderer', 'sticker-without-image', {
        purchaseAmountText: { simpleText: '$5.00' },
      }),
      action('liveChatTextMessageRenderer', 'after', {
        message: { simpleText: 'world' },
      }),
    ];

    const events = extractChatEvents(actions, () =>
      mkSettings({ allowShortTextMessages: true, queueMaxSize: 10 })
    );

    expect(events.map(({ message }) => message.id)).toEqual([
      'before',
      'member-fallback',
      'sticker-without-image',
      'after',
    ]);
    expect(events[1]?.message).toMatchObject({
      kind: 'membership',
      text: 'Member for 12 months',
    });
    expect(events[2]?.message).toMatchObject({
      kind: 'superchat',
      superChat: { amount: '$5.00' },
    });
    expect(events[2]?.message.superChat?.sticker).toBeUndefined();
  });

  it('applies the short-text display filter within a mixed healthy and paid batch', () => {
    const action = (key: string, id: string, renderer: Record<string, unknown>) => ({
      addChatItemAction: { item: { [key]: { id, ...renderer } } },
    });
    const actions = [
      action('liveChatTextMessageRenderer', 'short', {
        message: { simpleText: 'ok' },
      }),
      action('liveChatPaidMessageRenderer', 'paid', {
        purchaseAmountText: { simpleText: '$5.00' },
        message: { simpleText: 'ok' },
      }),
      action('liveChatTextMessageRenderer', 'substantial', {
        message: { simpleText: 'hello' },
      }),
    ];
    const idsWithShortTextHidden = extractChatEvents(actions, () =>
      mkSettings({ allowShortTextMessages: false, minTextLength: 3, queueMaxSize: 10 })
    ).map(({ message }) => message.id);
    const idsWithShortTextShown = extractChatEvents(actions, () =>
      mkSettings({ allowShortTextMessages: true, minTextLength: 3, queueMaxSize: 10 })
    ).map(({ message }) => message.id);

    expect(idsWithShortTextHidden).toEqual(['paid', 'substantial']);
    expect(idsWithShortTextShown).toEqual(['short', 'paid', 'substantial']);
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
      extractChatEvents(
        Array.from({ length: 1000 }),
        () => settings(5),
        (value) => {
          invalidStats = value;
        }
      )
    ).toEqual([]);
    expect(invalidStats).toMatchObject({ traversedActions: 20, budgetExhausted: true });

    let nestedStats: import('@chat/message-parser').ChatEventExtractionStats | undefined;
    const nested = {
      replayChatItemAction: {
        videoOffsetTimeMsec: '1000',
        actions: Array.from({ length: 1000 }, (_, index) => textAction(`nested-${index}`)),
      },
    };
    const events = extractChatEvents(
      [nested],
      () => settings(5),
      (value) => {
        nestedStats = value;
      }
    );
    expect(events).toHaveLength(5);
    expect(nestedStats).toMatchObject({ traversedActions: 20, budgetExhausted: true });
  });

  it.each([0, Number.NaN])(
    'clamps queueMaxSize %s to one before admitting late priority',
    (queueMaxSize) => {
      let stats: import('@chat/message-parser').ChatEventExtractionStats | undefined;
      const events = extractChatEvents(
        [
          textAction('ordinary'),
          null,
          paidAction('paid', 'superchat'),
          textAction('too-late-ordinary'),
          paidAction('beyond-budget', 'membership'),
        ],
        () => settings(queueMaxSize),
        (value) => {
          stats = value;
        }
      );

      expect(events.map(({ message }) => message.id)).toEqual(['paid']);
      expect(stats).toMatchObject({
        capacity: 1,
        traversalBudget: 4,
        traversedActions: 4,
        capacityDrops: 2,
        budgetExhausted: true,
      });
    }
  );

  it('admits late priority at the exact mixed replay traversal budget while preserving a replacement', () => {
    let stats: import('@chat/message-parser').ChatEventExtractionStats | undefined;
    const events = extractChatEvents(
      [
        textAction('a'),
        textAction('b'),
        textAction('c'),
        null,
        {
          replayChatItemAction: {
            videoOffsetTimeMsec: '1000',
            actions: [
              null,
              textAction('b', 'replace'),
              textAction('d'),
              paidAction('paid', 'superchat'),
              null,
              null,
              paidAction('member', 'membership'),
              ...Array.from({ length: 1000 }, (_, index) =>
                paidAction(`late-${index}`, 'superchat')
              ),
            ],
          },
        },
      ],
      () => settings(3),
      (value) => {
        stats = value;
      }
    );

    expect(events.map(({ message }) => [message.id, message.actionType])).toEqual([
      ['paid', 'add'],
      ['b', 'replace'],
      ['member', 'add'],
    ]);
    expect(events.map(({ message }) => message.videoOffsetMs)).toEqual([1000, 1000, 1000]);
    expect(stats).toMatchObject({
      capacity: 3,
      traversalBudget: 12,
      traversedActions: 12,
      capacityDrops: 3,
      budgetExhausted: true,
    });
    expect(stats?.ordinaryScanSteps).toBeLessThanOrEqual(3);
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
