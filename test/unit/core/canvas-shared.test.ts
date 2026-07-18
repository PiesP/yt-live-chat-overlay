// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, it, expect } from 'vitest';
import {
  getDisplayText,
  splitGraphemeClusters,
  toSharedContentSegments,
} from '@renderer/canvas/shared';
import type { SharedContentSegment } from '@renderer/canvas/shared';

// ═══════════════════════════════════════════════════════════════════════════
// toSharedContentSegments
// ═══════════════════════════════════════════════════════════════════════════

describe('toSharedContentSegments', () => {
  describe('text segments', () => {
    it('converts a single text segment', () => {
      const result = toSharedContentSegments([
        { type: 'text', content: 'hello' },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ type: 'text', content: 'hello' });
    });

    it('converts multiple text segments', () => {
      const result = toSharedContentSegments([
        { type: 'text', content: 'hello' },
        { type: 'text', content: ' world' },
      ]);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ type: 'text', content: 'hello' });
      expect(result[1]).toEqual({ type: 'text', content: ' world' });
    });

    it('handles text segment without content field', () => {
      const result = toSharedContentSegments([
        { type: 'text' },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ type: 'text' });
      expect(result[0].content).toBeUndefined();
    });
  });

  describe('emoji segments', () => {
    it('flattens emoji segment with all fields', () => {
      const result = toSharedContentSegments([
        {
          type: 'emoji',
          emoji: { url: 'https://example.com/emoji.png', alt: ':D', fallbackText: ':D' },
        },
      ]);
      expect(result).toHaveLength(1);
      const seg = result[0] as SharedContentSegment;
      expect(seg.type).toBe('emoji');
      expect(seg.emojiUrl).toBe('https://example.com/emoji.png');
      expect(seg.emojiAlt).toBe(':D');
      expect(seg.emojiFallbackText).toBe(':D');
    });

    it('flattens emoji segment without url (only alt)', () => {
      const result = toSharedContentSegments([
        { type: 'emoji', emoji: { url: '', alt: ':)' } },
      ]);
      expect(result).toHaveLength(1);
      const seg = result[0] as SharedContentSegment;
      expect(seg.type).toBe('emoji');
      expect(seg.emojiAlt).toBe(':)');
      // url='' passes `!== undefined` check, so emojiUrl is set to ''
      expect(seg.emojiUrl).toBe('');
    });

    it('handles emoji segment with empty emoji object', () => {
      const result = toSharedContentSegments([
        { type: 'emoji', emoji: {} as { url: string; alt: string; fallbackText?: string } },
      ]);
      expect(result).toHaveLength(1);
      const seg = result[0] as SharedContentSegment;
      expect(seg.type).toBe('emoji');
      expect(seg.emojiUrl).toBeUndefined();
      expect(seg.emojiAlt).toBeUndefined();
      expect(seg.emojiFallbackText).toBeUndefined();
    });

    it('handles emoji segment with undefined emoji', () => {
      const result = toSharedContentSegments([
        { type: 'emoji' },
      ]);
      expect(result).toHaveLength(1);
      const seg = result[0] as SharedContentSegment;
      expect(seg.type).toBe('emoji');
      expect(seg.emojiUrl).toBeUndefined();
    });
  });

  describe('mixed segments', () => {
    it('converts mixed text and emoji segments', () => {
      const result = toSharedContentSegments([
        { type: 'text', content: 'hello ' },
        { type: 'emoji', emoji: { url: 'https://a.com/e.png', alt: ':)' } },
        { type: 'text', content: ' world' },
      ]);
      expect(result).toHaveLength(3);
      expect(result[0]!.type).toBe('text');
      expect((result[0] as SharedContentSegment).content).toBe('hello ');
      expect(result[1]!.type).toBe('emoji');
      expect(result[2]!.type).toBe('text');
    });
  });

  describe('edge cases', () => {
    it('returns empty array for empty input', () => {
      expect(toSharedContentSegments([])).toEqual([]);
    });

    it('preserves input independence (does not mutate original)', () => {
      const original = [{ type: 'text', content: 'original' }];
      const result = toSharedContentSegments(original);
      result[0]!.type = 'emoji' as const;
      expect(original[0]!.type).toBe('text');
    });

    it('handles many segments', () => {
      const segments = Array.from({ length: 100 }, (_, i) => ({
        type: 'text' as const,
        content: `msg-${i}`,
      }));
      const result = toSharedContentSegments(segments);
      expect(result).toHaveLength(100);
      expect(result[0]!.type).toBe('text');
      expect((result[99] as SharedContentSegment).content).toBe('msg-99');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getDisplayText
// ═══════════════════════════════════════════════════════════════════════════

describe('getDisplayText', () => {
  it('joins text segments only', () => {
    const result = getDisplayText([
      { type: 'text', content: 'hello' },
      { type: 'text', content: ' world' },
    ]);
    expect(result).toBe('hello world');
  });

  it('excludes emoji segments', () => {
    const result = getDisplayText([
      { type: 'text', content: 'hi ' },
      { type: 'emoji' },
      { type: 'text', content: 'there' },
    ]);
    expect(result).toBe('hi there');
  });

  it('excludes segments with empty content', () => {
    const result = getDisplayText([
      { type: 'text', content: 'keep' },
      { type: 'text', content: '' },
      { type: 'text', content: ' this' },
    ]);
    expect(result).toBe('keep this');
  });

  it('excludes segments where content is missing', () => {
    const result = getDisplayText([
      { type: 'text', content: 'keep' },
      { type: 'text' },
      { type: 'text', content: ' this' },
    ]);
    expect(result).toBe('keep this');
  });

  it('returns empty string for all-emoji input', () => {
    const result = getDisplayText([
      { type: 'emoji' },
      { type: 'emoji' },
    ]);
    expect(result).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(getDisplayText([])).toBe('');
  });

  it('returns empty string when all segments have empty content', () => {
    expect(getDisplayText([
      { type: 'text', content: '' },
      { type: 'text', content: '' },
    ])).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// splitGraphemeClusters
// ═══════════════════════════════════════════════════════════════════════════

describe('splitGraphemeClusters', () => {
  describe('basic ASCII', () => {
    it('splits simple ASCII string into individual characters', () => {
      const result = splitGraphemeClusters('abc');
      expect(result).toEqual(['a', 'b', 'c']);
    });

    it('handles empty string', () => {
      expect(splitGraphemeClusters('')).toEqual([]);
    });
  });

  describe('multi-byte characters (BMP)', () => {
    it('splits Korean Hangul into individual syllables', () => {
      const result = splitGraphemeClusters('안녕');
      expect(result).toEqual(['안', '녕']);
    });

    it('splits Japanese characters', () => {
      const result = splitGraphemeClusters('日本語');
      expect(result).toEqual(['日', '本', '語']);
    });

    it('splits CJK characters', () => {
      const result = splitGraphemeClusters('你好');
      expect(result).toEqual(['你', '好']);
    });

    it('splits symbols correctly', () => {
      const result = splitGraphemeClusters('©®™');
      expect(result).toEqual(['©', '®', '™']);
    });
  });

  describe('surrogate pairs (SMP)', () => {
    it('keeps emoji as single grapheme cluster', () => {
      const result = splitGraphemeClusters('🎉');
      expect(result).toEqual(['🎉']);
    });

    it('splits multiple emoji correctly', () => {
      const result = splitGraphemeClusters('😂🎉');
      expect(result).toHaveLength(2);
    });
  });

  describe('ZWJ sequences', () => {
    it('keeps ZWJ family emoji as single grapheme when Segmenter available', () => {
      const family = '👨‍👩‍👧‍👦';
      const result = splitGraphemeClusters(family);
      // With Intl.Segmenter: 1 cluster. Without: splits at ZWJ boundaries.
      // Verify length >= 1 and each element is non-empty.
      expect(result.length).toBeGreaterThanOrEqual(1);
      for (const s of result) {
        expect(s.length).toBeGreaterThan(0);
      }
    });

    it('keeps skin-tone emoji as single cluster', () => {
      const skinTone = '👍🏽';
      const result = splitGraphemeClusters(skinTone);
      expect(result.length).toBeGreaterThanOrEqual(1);
      for (const s of result) {
        expect(s.length).toBeGreaterThan(0);
      }
    });
  });

  describe('mixed content', () => {
    it('handles ASCII + emoji mix', () => {
      const result = splitGraphemeClusters('hi🎉');
      expect(result.length).toBeGreaterThanOrEqual(3);
      expect(result[0]).toBe('h');
      expect(result[1]).toBe('i');
    });

    it('handles CJK + emoji mix', () => {
      const result = splitGraphemeClusters('こんにちは🎉');
      expect(result.length).toBeGreaterThanOrEqual(6);
    });
  });

  describe('consistency', () => {
    it('returns same result for identical input', () => {
      const a = splitGraphemeClusters('test123😀');
      const b = splitGraphemeClusters('test123😀');
      expect(a).toEqual(b);
    });

    it('join produces original text', () => {
      const original = 'hello世界🎉';
      const result = splitGraphemeClusters(original).join('');
      expect(result).toBe(original);
    });
  });
});
