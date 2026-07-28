// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { describe, expect, it } from 'vitest';
import {
  stripControlCharacters,
  normalizeInlineText,
  truncateForKind,
  hasEmojiContent,
  AUTHOR_TYPE_PRIORITY,
  EMOJI_ALIAS_PATTERN,
} from '@chat/message-helpers';

describe('message-helpers', () => {
  describe('stripControlCharacters', () => {
    it('removes ASCII control characters (U+0000-U+001F)', () => {
      expect(stripControlCharacters('hello\x00world')).toBe('helloworld');
    });

    it('removes C1 control characters (U+007F-U+009F)', () => {
      expect(stripControlCharacters('hello\x7fworld')).toBe('helloworld');
    });

    it('preserves normal text', () => {
      expect(stripControlCharacters('hello world')).toBe('hello world');
    });

    it('handles empty string', () => {
      expect(stripControlCharacters('')).toBe('');
    });

    it('does not strip Unicode text', () => {
      expect(stripControlCharacters('привет')).toBe('привет');
    });
  });

  describe('normalizeInlineText', () => {
    it('collapses multiple spaces', () => {
      expect(normalizeInlineText('hello   world')).toBe('hello world');
    });

    it('trims leading and trailing whitespace', () => {
      expect(normalizeInlineText('  hello  ')).toBe('hello');
    });

    it('strips trailing ellipsis', () => {
      expect(normalizeInlineText('hello…')).toBe('hello');
    });

    it('strips control characters before normalizing', () => {
      expect(normalizeInlineText('  hello\x00  ')).toBe('hello');
    });
  });

  describe('hasEmojiContent', () => {
    it('detects text segments with emoji content', () => {
      expect(hasEmojiContent([{ type: 'text', content: 'hello 😀' }])).toBe(true);
    });

    it('returns false for text-only segments without emoji', () => {
      expect(hasEmojiContent([{ type: 'text', content: 'hello' }])).toBe(false);
    });

    it('returns false for empty segments', () => {
      expect(hasEmojiContent([])).toBe(false);
    });
  });

  describe('truncateForKind', () => {
    it('truncates long text to MAX_MESSAGE_TEXT_LENGTH', () => {
      const longText = 'a'.repeat(100);
      const result = truncateForKind(longText, 'text');
      expect(result.length).toBeLessThanOrEqual(80);
    });

    it('does not truncate short text', () => {
      const shortText = 'hello';
      expect(truncateForKind(shortText, 'text')).toBe('hello');
    });
  });

  describe('AUTHOR_TYPE_PRIORITY', () => {
    it('assigns higher priority to owner than normal', () => {
      expect(AUTHOR_TYPE_PRIORITY.owner).toBeGreaterThan(AUTHOR_TYPE_PRIORITY.normal);
    });

    it('assigns higher priority to moderator than member', () => {
      expect(AUTHOR_TYPE_PRIORITY.moderator).toBeGreaterThan(AUTHOR_TYPE_PRIORITY.member);
    });

    it('all priority values are numbers', () => {
      Object.values(AUTHOR_TYPE_PRIORITY).forEach((val) => {
        expect(typeof val).toBe('number');
      });
    });
  });

  describe('EMOJI_ALIAS_PATTERN', () => {
    it('matches valid emoji aliases like :smile:', () => {
      expect(EMOJI_ALIAS_PATTERN.test(':smile:')).toBe(true);
    });

    it('does not match empty or single-colon strings', () => {
      expect(EMOJI_ALIAS_PATTERN.test(':')).toBe(false);
      expect(EMOJI_ALIAS_PATTERN.test('')).toBe(false);
    });
  });
});
