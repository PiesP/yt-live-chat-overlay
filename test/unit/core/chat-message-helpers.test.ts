import { describe, it, expect } from 'vitest';
import {
  stripControlCharacters,
  normalizeInlineText,
  truncateForKind,
  hasEmojiContent,
  getTranslatableText,
  colorIntToCss,
  determineSuperChatTier,
  extractUserColor,
  extractAccessibilityLabel,
  AUTHOR_TYPE_PRIORITY,
} from '@chat/message-helpers';

// ── stripControlCharacters ────────────────────────────────────────────

describe('stripControlCharacters', () => {
  it('strips ASCII control characters (U+0000–U+001F)', () => {
    expect(stripControlCharacters('hello\x00world')).toBe('helloworld');
    expect(stripControlCharacters('a\x01b\x02c')).toBe('abc');
    expect(stripControlCharacters('tab\there')).toBe('tabhere');
    expect(stripControlCharacters('newline\nhere')).toBe('newlinehere');
  });

  it('strips DEL and C1 control characters (U+007F–U+009F)', () => {
    expect(stripControlCharacters('hello\x7Fworld')).toBe('helloworld');
    expect(stripControlCharacters('a\x80b\x9Fc')).toBe('abc');
  });

  it('preserves normal text', () => {
    expect(stripControlCharacters('hello world')).toBe('hello world');
    expect(stripControlCharacters('안녕하세요')).toBe('안녕하세요');
    expect(stripControlCharacters('🎉 emoji')).toBe('🎉 emoji');
  });

  it('handles empty string', () => {
    expect(stripControlCharacters('')).toBe('');
  });

  it('handles string of only control characters', () => {
    expect(stripControlCharacters('\x00\x01\x02')).toBe('');
  });
});

// ── normalizeInlineText ───────────────────────────────────────────────

describe('normalizeInlineText', () => {
  it('collapses multiple spaces into one', () => {
    expect(normalizeInlineText('hello    world')).toBe('hello world');
    expect(normalizeInlineText('a  b  c')).toBe('a b c');
  });

  it('strips trailing ellipsis (U+2026)', () => {
    expect(normalizeInlineText('hello…')).toBe('hello');
    expect(normalizeInlineText('hello………')).toBe('hello');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeInlineText('  hello  ')).toBe('hello');
    expect(normalizeInlineText('\thello\t')).toBe('hello');
  });

  it('strips control characters before other processing', () => {
    expect(normalizeInlineText('hello\x00 world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(normalizeInlineText('')).toBe('');
  });

  it('handles whitespace-only string', () => {
    expect(normalizeInlineText('   ')).toBe('');
  });
});

// ── truncateForKind ───────────────────────────────────────────────────

describe('truncateForKind', () => {
  it('truncates text kind messages longer than 80 chars', () => {
    const longText = 'a'.repeat(100);
    const result = truncateForKind(longText, 'text');
    expect(result.length).toBe(80);
    expect(result.endsWith('\u2026')).toBe(true);
  });

  it('does not truncate text kind messages shorter than 80 chars', () => {
    const shortText = 'hello world';
    expect(truncateForKind(shortText, 'text')).toBe('hello world');
  });

  it('does not truncate superchat kind messages', () => {
    const longText = 'a'.repeat(200);
    const result = truncateForKind(longText, 'superchat');
    expect(result.length).toBe(200);
  });

  it('does not truncate membership kind messages', () => {
    const longText = 'a'.repeat(200);
    const result = truncateForKind(longText, 'membership');
    expect(result.length).toBe(200);
  });

  it('normalizes but does not truncate non-text kinds', () => {
    expect(truncateForKind('  hello  ', 'superchat')).toBe('hello');
  });

  it('handles exactly 80 chars (no truncation)', () => {
    const exactText = 'a'.repeat(80);
    expect(truncateForKind(exactText, 'text')).toBe(exactText);
  });

  it('handles 81 chars (truncation)', () => {
    const overText = 'a'.repeat(81);
    const result = truncateForKind(overText, 'text');
    expect(result.length).toBe(80);
  });
});

// ── hasEmojiContent ───────────────────────────────────────────────────

describe('hasEmojiContent', () => {
  it('returns true when a segment is type emoji', () => {
    expect(
      hasEmojiContent([{ type: 'emoji' as const, emoji: { url: 'https://example.com/emoji.png', alt: '😀' } }])
    ).toBe(true);
  });

  it('returns true when a text segment contains emoji', () => {
    expect(hasEmojiContent([{ type: 'text' as const, content: 'hello 😀 world' }])).toBe(true);
  });

  it('returns false when no segments contain emoji', () => {
    expect(hasEmojiContent([{ type: 'text' as const, content: 'hello world' }])).toBe(false);
  });

  it('returns false for empty segments', () => {
    expect(hasEmojiContent([])).toBe(false);
  });

  it('returns true when only one segment has emoji among many', () => {
    expect(
      hasEmojiContent([
        { type: 'text' as const, content: 'hello' },
        { type: 'emoji' as const, emoji: { url: 'https://example.com/emoji.png', alt: '🎉' } },
        { type: 'text' as const, content: 'world' },
      ])
    ).toBe(true);
  });
});

// ── getTranslatableText ──────────────────────────────────────────────

describe('getTranslatableText', () => {
  const makeMsg = (content: Array<{ type: 'text'; content: string } | { type: 'emoji'; emoji: { url: string; alt: string } }>) =>
    ({
      id: 'test',
      text: '',
      content,
      kind: 'text' as const,
      timestamp: 0,
      author: 'tester',
      authorType: 'normal' as const,
    });

  it('joins text segments only', () => {
    const msg = makeMsg([
      { type: 'text', content: 'hello ' },
      { type: 'text', content: 'world' },
    ]);
    expect(getTranslatableText(msg)).toBe('hello world');
  });

  it('excludes emoji segments', () => {
    const msg = makeMsg([
      { type: 'text', content: 'hello ' },
      { type: 'emoji', emoji: { url: 'https://example.com/e.png', alt: '😀' } },
      { type: 'text', content: ' world' },
    ]);
    expect(getTranslatableText(msg)).toBe('hello  world');
  });

  it('returns empty string for no text segments', () => {
    const msg = makeMsg([{ type: 'emoji', emoji: { url: 'https://example.com/e.png', alt: '😀' } }]);
    expect(getTranslatableText(msg)).toBe('');
  });

  it('trims the result', () => {
    const msg = makeMsg([{ type: 'text', content: '  hello  ' }]);
    expect(getTranslatableText(msg)).toBe('hello');
  });
});

// ── colorIntToCss ────────────────────────────────────────────────────

describe('colorIntToCss', () => {
  it('converts opaque ARGB int to rgb()', () => {
    // 0xFFFF0000 = opaque red
    expect(colorIntToCss(0xffff0000)).toBe('rgb(255, 0, 0)');
  });

  it('converts semi-transparent ARGB int to rgba()', () => {
    // 0x80FF0000 = 50% transparent red
    const result = colorIntToCss(0x80ff0000);
    expect(result).toMatch(/^rgba\(255, 0, 0, 0\.502\)$/);
  });

  it('converts from string input', () => {
    expect(colorIntToCss('4294901760')).toBe('rgb(255, 0, 0)'); // 0xFFFF0000 as string
  });

  it('returns undefined for non-numeric input', () => {
    expect(colorIntToCss('hello')).toBeUndefined();
    expect(colorIntToCss(null)).toBeUndefined();
    expect(colorIntToCss(undefined)).toBeUndefined();
    expect(colorIntToCss({})).toBeUndefined();
  });

  it('returns undefined for non-finite numbers', () => {
    expect(colorIntToCss(Infinity)).toBeUndefined();
    expect(colorIntToCss(NaN)).toBeUndefined();
  });

  it('handles fully transparent (alpha=0)', () => {
    // 0x00FF0000 = fully transparent red
    const result = colorIntToCss(0x00ff0000);
    expect(result).toBe('rgba(255, 0, 0, 0)');
  });

  it('handles white (0xFFFFFFFF)', () => {
    expect(colorIntToCss(0xffffffff)).toBe('rgb(255, 255, 255)');
  });

  it('handles black (0xFF000000)', () => {
    expect(colorIntToCss(0xff000000)).toBe('rgb(0, 0, 0)');
  });
});

// ── determineSuperChatTier ────────────────────────────────────────────

describe('determineSuperChatTier', () => {
  it('returns blue for undefined background', () => {
    expect(determineSuperChatTier(undefined)).toBe('blue');
  });

  it('returns blue for unparseable color', () => {
    expect(determineSuperChatTier('not-a-color')).toBe('blue');
  });

  it('matches exact blue tier color', () => {
    // Blue tier is the default/fallback
    expect(determineSuperChatTier('#0000FF')).toBe('blue');
  });

  it('matches green tier color', () => {
    expect(determineSuperChatTier('#008000')).toBe('green');
  });

  it('matches yellow tier color', () => {
    expect(determineSuperChatTier('#FFFF00')).toBe('yellow');
  });

  it('matches orange tier color', () => {
    expect(determineSuperChatTier('#FF8C00')).toBe('orange');
  });

  it('matches magenta tier color', () => {
    expect(determineSuperChatTier('#FF00FF')).toBe('magenta');
  });

  it('matches red tier color', () => {
    expect(determineSuperChatTier('#FF0000')).toBe('red');
  });

  it('picks closest tier for in-between colors', () => {
    // A color between blue and green should pick one of them
    const result = determineSuperChatTier('#004080');
    expect(['blue', 'green']).toContain(result);
  });
});

// ── extractUserColor ─────────────────────────────────────────────────

describe('extractUserColor', () => {
  it('returns undefined for renderer without authorNameTextColor', () => {
    expect(extractUserColor({})).toBeUndefined();
  });

  it('returns undefined for near-white colors (YouTube default)', () => {
    // Near-white: rgb(250, 250, 250) — all channels > 240
    // ARGB: 0xFFFAFAFA
    expect(extractUserColor({ authorNameTextColor: 0xfffafafa })).toBeUndefined();
  });

  it('returns undefined for near-black colors', () => {
    // Near-black: rgb(10, 10, 10) — all channels < 15
    expect(extractUserColor({ authorNameTextColor: 0xff0a0a0a })).toBeUndefined();
  });

  it('returns css color for valid user colors', () => {
    // Red: 0xFFFF0000
    expect(extractUserColor({ authorNameTextColor: 0xffff0000 })).toBe('rgb(255, 0, 0)');
  });

  it('returns undefined for non-numeric authorNameTextColor', () => {
    expect(extractUserColor({ authorNameTextColor: 'invalid' })).toBeUndefined();
  });
});

// ── extractAccessibilityLabel ────────────────────────────────────────

describe('extractAccessibilityLabel', () => {
  it('extracts label from nested accessibility structure', () => {
    const data = {
      accessibility: {
        accessibilityData: {
          label: 'Hello World',
        },
      },
    };
    expect(extractAccessibilityLabel(data)).toBe('Hello World');
  });

  it('returns undefined for non-record input', () => {
    expect(extractAccessibilityLabel('string')).toBeUndefined();
    expect(extractAccessibilityLabel(null)).toBeUndefined();
    expect(extractAccessibilityLabel(undefined)).toBeUndefined();
  });

  it('returns undefined for missing accessibility key', () => {
    expect(extractAccessibilityLabel({})).toBeUndefined();
  });

  it('returns undefined for missing label', () => {
    expect(extractAccessibilityLabel({ accessibility: { accessibilityData: {} } })).toBeUndefined();
  });
});

// ── AUTHOR_TYPE_PRIORITY ─────────────────────────────────────────────

describe('AUTHOR_TYPE_PRIORITY', () => {
  it('has all author types', () => {
    expect(AUTHOR_TYPE_PRIORITY.normal).toBe(0);
    expect(AUTHOR_TYPE_PRIORITY.verified).toBe(1);
    expect(AUTHOR_TYPE_PRIORITY.member).toBe(2);
    expect(AUTHOR_TYPE_PRIORITY.moderator).toBe(3);
    expect(AUTHOR_TYPE_PRIORITY.owner).toBe(4);
  });

  it('orders types by increasing priority', () => {
    const types = Object.values(AUTHOR_TYPE_PRIORITY);
    for (let i = 1; i < types.length; i++) {
      expect(types[i]).toBeGreaterThan(types[i - 1]!);
    }
  });
});
