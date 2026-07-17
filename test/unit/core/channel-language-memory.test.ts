// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, it, expect } from 'vitest';
import { ChannelLanguageMemory } from '@translation/channel-memory';

describe('ChannelLanguageMemory.keyFromUrl', () => {
  describe('watch video URLs', () => {
    it('extracts video ID from standard /watch?v= URL', () => {
      expect(ChannelLanguageMemory.keyFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
        'dQw4w9WgXcQ',
      );
    });

    it('extracts v param from /watch URL with multiple query params', () => {
      expect(
        ChannelLanguageMemory.keyFromUrl(
          'https://www.youtube.com/watch?v=abc123&t=30&list=PLxyz',
        ),
      ).toBe('abc123');
    });

    it('returns null for /watch URL without v param', () => {
      expect(
        ChannelLanguageMemory.keyFromUrl('https://www.youtube.com/watch?t=30'),
      ).toBeNull();
    });
  });

  describe('channel handle URLs', () => {
    it('extracts @handle from /@handle URL', () => {
      expect(
        ChannelLanguageMemory.keyFromUrl('https://www.youtube.com/@SomeChannel'),
      ).toBe('@SomeChannel');
    });

    it('extracts @handle from /@handle/videos (with path segments)', () => {
      expect(
        ChannelLanguageMemory.keyFromUrl('https://www.youtube.com/@SomeChannel/videos'),
      ).toBe('@SomeChannel');
    });
  });

  describe('channel ID URLs', () => {
    it('extracts channel ID from /channel/UC... URL', () => {
      expect(
        ChannelLanguageMemory.keyFromUrl(
          'https://www.youtube.com/channel/UCXuqSBlHAE6Xw-yeJA0Tunw',
        ),
      ).toBe('UCXuqSBlHAE6Xw-yeJA0Tunw');
    });
  });

  describe('youtube.com without www', () => {
    it('still extracts key from youtube.com (no www)', () => {
      expect(ChannelLanguageMemory.keyFromUrl('https://youtube.com/watch?v=test123')).toBe(
        'test123',
      );
    });

    it('still extracts @handle from youtube.com (no www)', () => {
      expect(ChannelLanguageMemory.keyFromUrl('https://youtube.com/@Handle')).toBe('@Handle');
    });
  });

  describe('non-YouTube URLs', () => {
    it('returns null for non-YouTube domain', () => {
      expect(
        ChannelLanguageMemory.keyFromUrl('https://example.com/watch?v=abc'),
      ).toBeNull();
    });

    it('returns null for youtube-like subdomain', () => {
      expect(
        ChannelLanguageMemory.keyFromUrl('https://fake.youtube.com/watch?v=abc'),
      ).toBeNull();
    });
  });

  describe('unrecognized YouTube paths', () => {
    it('returns null for /results path', () => {
      expect(
        ChannelLanguageMemory.keyFromUrl('https://www.youtube.com/results?search_query=test'),
      ).toBeNull();
    });

    it('returns null for root path', () => {
      expect(ChannelLanguageMemory.keyFromUrl('https://www.youtube.com/')).toBeNull();
    });
  });

  describe('invalid URLs', () => {
    it('returns null for malformed URL string', () => {
      expect(ChannelLanguageMemory.keyFromUrl('not a url at all')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(ChannelLanguageMemory.keyFromUrl('')).toBeNull();
    });
  });
});
