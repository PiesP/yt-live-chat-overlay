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

  describe('live video URLs', () => {
    it('extracts video ID from /live/ URL', () => {
      expect(
        ChannelLanguageMemory.keyFromUrl('https://www.youtube.com/live/liveVideo123'),
      ).toBe('liveVideo123');
    });

    it('returns null for /live URL without a video ID', () => {
      expect(ChannelLanguageMemory.keyFromUrl('https://www.youtube.com/live')).toBeNull();
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
    it('returns null for youtube.com apex (not supported)', () => {
      expect(ChannelLanguageMemory.keyFromUrl('https://youtube.com/watch?v=test123')).toBeNull();
    });

    it('returns null for @handle from youtube.com apex (not supported)', () => {
      expect(ChannelLanguageMemory.keyFromUrl('https://youtube.com/@Handle')).toBeNull();
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

// ── Helpers for DOM tests ──────────────────────────────────────────────────
function createDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('ChannelLanguageMemory.keyFromDocument', () => {
  describe('meta itemprop="channelId"', () => {
    it('extracts channel ID from meta tag', () => {
      const doc = createDoc(
        '<html><head><meta itemprop="channelId" content="UCXuqSBlHAE6Xw-yeJA0Tunw"></head></html>',
      );
      expect(ChannelLanguageMemory.keyFromDocument(doc)).toBe(
        'UCXuqSBlHAE6Xw-yeJA0Tunw',
      );
    });

    it('returns null when meta tag has empty content', () => {
      const doc = createDoc(
        '<html><head><meta itemprop="channelId" content=""></head></html>',
      );
      expect(ChannelLanguageMemory.keyFromDocument(doc)).toBeNull();
    });

    it('returns null when meta tag is absent', () => {
      const doc = createDoc('<html><head></head></html>');
      expect(ChannelLanguageMemory.keyFromDocument(doc)).toBeNull();
    });
  });

  describe('owner link fallback', () => {
    it('extracts @handle from #owner link', () => {
      const doc = createDoc(
        '<html><body><div id="owner"><ytd-channel-name><a href="/@SomeChannel">SomeChannel</a></ytd-channel-name></div></body></html>',
      );
      expect(ChannelLanguageMemory.keyFromDocument(doc)).toBe('@SomeChannel');
    });

    it('extracts channel ID from #owner /channel/UC... link', () => {
      const doc = createDoc(
        '<html><body><div id="owner"><ytd-channel-name><a href="/channel/UC1234567890">Channel</a></ytd-channel-name></div></body></html>',
      );
      expect(ChannelLanguageMemory.keyFromDocument(doc)).toBe('UC1234567890');
    });

    it('returns null when owner link has no href', () => {
      const doc = createDoc(
        '<html><body><div id="owner"><ytd-channel-name><a>No href</a></ytd-channel-name></div></body></html>',
      );
      expect(ChannelLanguageMemory.keyFromDocument(doc)).toBeNull();
    });

    it('returns null when owner element is absent', () => {
      const doc = createDoc('<html><body></body></html>');
      expect(ChannelLanguageMemory.keyFromDocument(doc)).toBeNull();
    });
  });

  describe('meta tag takes priority over owner link', () => {
    it('uses meta tag channel ID when both are present', () => {
      const doc = createDoc(
        '<html><head><meta itemprop="channelId" content="UC-meta"></head>' +
          '<body><div id="owner"><ytd-channel-name><a href="/@OwnerHandle">Owner</a></ytd-channel-name></div></body></html>',
      );
      expect(ChannelLanguageMemory.keyFromDocument(doc)).toBe('UC-meta');
    });
  });
});

describe('ChannelLanguageMemory.resolveKey', () => {
  describe('watch pages with DOM', () => {
    it('returns channel ID from DOM instead of video ID', () => {
      const doc = createDoc(
        '<html><head><meta itemprop="channelId" content="UC-channel"></head></html>',
      );
      expect(
        ChannelLanguageMemory.resolveKey(
          'https://www.youtube.com/watch?v=video123',
          doc,
        ),
      ).toBe('UC-channel');
    });

    it('returns owner @handle from DOM instead of video ID', () => {
      const doc = createDoc(
        '<html><body><div id="owner"><ytd-channel-name><a href="/@Channel">Channel</a></ytd-channel-name></div></body></html>',
      );
      expect(
        ChannelLanguageMemory.resolveKey(
          'https://www.youtube.com/watch?v=video123',
          doc,
        ),
      ).toBe('@Channel');
    });
  });

  describe('live pages with DOM', () => {
    it('returns channel ID from DOM instead of video ID', () => {
      const doc = createDoc(
        '<html><head><meta itemprop="channelId" content="UC-live-channel"></head></html>',
      );
      expect(
        ChannelLanguageMemory.resolveKey(
          'https://www.youtube.com/live/live-video123',
          doc,
        ),
      ).toBe('UC-live-channel');
    });
  });

  describe('watch pages without DOM', () => {
    it('falls back to video ID when no document is provided', () => {
      expect(
        ChannelLanguageMemory.resolveKey(
          'https://www.youtube.com/watch?v=video123',
        ),
      ).toBe('video123');
    });

    it('falls back to video ID when DOM has no channel data', () => {
      const doc = createDoc('<html><head></head></html>');
      expect(
        ChannelLanguageMemory.resolveKey(
          'https://www.youtube.com/watch?v=video123',
          doc,
        ),
      ).toBe('video123');
    });
  });

  describe('non-watch YouTube pages', () => {
    it('returns @handle from URL for channel page (no DOM needed)', () => {
      expect(
        ChannelLanguageMemory.resolveKey(
          'https://www.youtube.com/@SomeChannel',
        ),
      ).toBe('@SomeChannel');
    });

    it('returns channel ID from URL for /channel/UC... page', () => {
      expect(
        ChannelLanguageMemory.resolveKey(
          'https://www.youtube.com/channel/UC1234567890',
        ),
      ).toBe('UC1234567890');
    });

    it('ignores DOM on channel pages (uses URL key)', () => {
      const doc = createDoc(
        '<html><head><meta itemprop="channelId" content="UC-dom"></head></html>',
      );
      expect(
        ChannelLanguageMemory.resolveKey(
          'https://www.youtube.com/@SomeChannel',
          doc,
        ),
      ).toBe('@SomeChannel');
    });
  });

  describe('non-YouTube URLs', () => {
    it('returns null for non-YouTube URL', () => {
      expect(
        ChannelLanguageMemory.resolveKey('https://example.com/watch?v=abc'),
      ).toBeNull();
    });
  });

  describe('watch URL without v parameter', () => {
    it('returns null when URL has no key', () => {
      expect(
        ChannelLanguageMemory.resolveKey('https://www.youtube.com/watch?t=30'),
      ).toBeNull();
    });
  });
});

describe('ChannelLanguageMemory LRU behavior', () => {
  it('refreshes recency when an entry is read', () => {
    const memory = new ChannelLanguageMemory();

    for (let index = 0; index < 20; index++) {
      memory.set(`channel-${index}`, 'en');
    }

    expect(memory.get('channel-0')).toBe('en');
    memory.set('channel-20', 'ja');

    expect(memory.get('channel-0')).toBe('en');
    expect(memory.get('channel-1')).toBeUndefined();
  });
});
