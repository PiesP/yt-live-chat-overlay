import { describe, it, expect } from 'vitest';
import {
  extractBestThumbnail,
  createImageAsset,
  getEmojiVisibleFallbackText,
  parseEmoji,
} from '@chat/emoji-parser';

// ── extractBestThumbnail ─────────────────────────────────────────────

describe('extractBestThumbnail', () => {
  it('returns null for non-record input', () => {
    expect(extractBestThumbnail('string')).toBeNull();
    expect(extractBestThumbnail(null)).toBeNull();
    expect(extractBestThumbnail(undefined)).toBeNull();
    expect(extractBestThumbnail(42)).toBeNull();
  });

  it('returns null for empty thumbnails', () => {
    expect(extractBestThumbnail({ thumbnails: [] })).toBeNull();
  });

  it('extracts the widest thumbnail', () => {
    const result = extractBestThumbnail({
      thumbnails: [
        { url: 'https://ytimg.com/small.png', width: 48, height: 48 },
        { url: 'https://ytimg.com/large.png', width: 128, height: 128 },
        { url: 'https://ytimg.com/medium.png', width: 88, height: 88 },
      ],
    });
    expect(result?.url).toBe('https://ytimg.com/large.png');
    expect(result?.width).toBe(128);
    expect(result?.height).toBe(128);
  });

  it('sets candidateUrl when multiple thumbnails exist', () => {
    const result = extractBestThumbnail({
      thumbnails: [
        { url: 'https://ytimg.com/large.png', width: 128 },
        { url: 'https://ytimg.com/small.png', width: 48 },
      ],
    });
    expect(result?.url).toBe('https://ytimg.com/large.png');
    expect(result?.candidateUrl).toBe('https://ytimg.com/small.png');
  });

  it('does not set candidateUrl for single thumbnail', () => {
    const result = extractBestThumbnail({
      thumbnails: [{ url: 'https://ytimg.com/only.png', width: 88 }],
    });
    expect(result?.candidateUrl).toBeUndefined();
  });

  it('normalizes protocol-relative URLs', () => {
    const result = extractBestThumbnail({
      thumbnails: [{ url: '//ytimg.com/image.png', width: 88 }],
    });
    expect(result?.url).toBe('https://ytimg.com/image.png');
  });

  it('upgrades http to https', () => {
    const result = extractBestThumbnail({
      thumbnails: [{ url: 'http://ytimg.com/image.png', width: 88 }],
    });
    expect(result?.url).toBe('https://ytimg.com/image.png');
  });

  it('rejects non-YouTube image hosts', () => {
    expect(
      extractBestThumbnail({
        thumbnails: [{ url: 'https://evil.com/steal.png', width: 88 }],
      })
    ).toBeNull();
  });

  it('rejects invalid URLs', () => {
    expect(
      extractBestThumbnail({
        thumbnails: [{ url: 'not-a-url', width: 88 }],
      })
    ).toBeNull();
  });

  it('deduplicates URLs', () => {
    const result = extractBestThumbnail({
      thumbnails: [
        { url: 'https://ytimg.com/same.png', width: 128 },
        { url: 'https://ytimg.com/same.png', width: 48 },
      ],
    });
    expect(result?.url).toBe('https://ytimg.com/same.png');
    // Only one unique URL, so no candidateUrl
    expect(result?.candidateUrl).toBeUndefined();
  });

  it('uses sources array when thumbnails is absent', () => {
    const result = extractBestThumbnail({
      sources: [{ url: 'https://ytimg.com/from-sources.png', width: 88 }],
    });
    expect(result?.url).toBe('https://ytimg.com/from-sources.png');
  });

  it('skips non-record items in thumbnails', () => {
    const result = extractBestThumbnail({
      thumbnails: ['string', 42, null, { url: 'https://ytimg.com/valid.png', width: 88 }],
    });
    expect(result?.url).toBe('https://ytimg.com/valid.png');
  });

  it('handles thumbnails without width/height', () => {
    const result = extractBestThumbnail({
      thumbnails: [{ url: 'https://ytimg.com/no-size.png' }],
    });
    expect(result?.url).toBe('https://ytimg.com/no-size.png');
    expect(result?.width).toBeUndefined();
  });
});

// ── createImageAsset ─────────────────────────────────────────────────

describe('createImageAsset', () => {
  it('returns null when no thumbnail found', () => {
    expect(createImageAsset({}, 'alt')).toBeNull();
  });

  it('creates asset with url and alt', () => {
    const result = createImageAsset(
      { thumbnails: [{ url: 'https://ytimg.com/e.png', width: 48 }] },
      'emoji-alt'
    );
    expect(result).toEqual({
      url: 'https://ytimg.com/e.png',
      alt: 'emoji-alt',
      width: 48,
    });
  });

  it('includes candidateUrl when available', () => {
    const result = createImageAsset(
      {
        thumbnails: [
          { url: 'https://ytimg.com/large.png', width: 128 },
          { url: 'https://ytimg.com/small.png', width: 48 },
        ],
      },
      'alt'
    );
    expect(result?.candidateUrl).toBe('https://ytimg.com/small.png');
  });

  it('includes fallbackText when provided', () => {
    const result = createImageAsset(
      { thumbnails: [{ url: 'https://ytimg.com/e.png', width: 48 }] },
      'alt',
      ':smile:'
    );
    expect(result?.fallbackText).toBe(':smile:');
  });

  it('omits fallbackText when empty string', () => {
    const result = createImageAsset(
      { thumbnails: [{ url: 'https://ytimg.com/e.png', width: 48 }] },
      'alt',
      ''
    );
    expect(result?.fallbackText).toBeUndefined();
  });

  it('includes width and height', () => {
    const result = createImageAsset(
      { thumbnails: [{ url: 'https://ytimg.com/e.png', width: 64, height: 64 }] },
      'alt'
    );
    expect(result?.width).toBe(64);
    expect(result?.height).toBe(64);
  });
});

// ── getEmojiVisibleFallbackText ──────────────────────────────────────

describe('getEmojiVisibleFallbackText', () => {
  it('returns accessibility label when all shortcuts are aliases', () => {
    const emoji = {
      shortcuts: [':smile:', 'smile'],
      image: { accessibility: { accessibilityData: { label: 'smiling face' } } },
    };
    // :smile: is an alias, 'smile' is not → returned as non-alias shortcut
    expect(getEmojiVisibleFallbackText(emoji)).toBe('smile');
  });

  it('returns first shortcut when it is not an alias', () => {
    const emoji = {
      shortcuts: ['smile'],
      image: { accessibility: { accessibilityData: { label: 'smiling face' } } },
    };
    expect(getEmojiVisibleFallbackText(emoji)).toBe('smile');
  });

  it('falls through to accessibility label when only alias shortcuts exist', () => {
    const emoji = {
      shortcuts: [':smile:'],
      image: { accessibility: { accessibilityData: { label: 'smiling face' } } },
    };
    expect(getEmojiVisibleFallbackText(emoji)).toBe('smiling face');
  });

  it('falls through to top-level accessibility label when only alias shortcuts exist', () => {
    const emoji = {
      shortcuts: [':smile:'],
      accessibility: { accessibilityData: { label: 'top-level label' } },
    };
    expect(getEmojiVisibleFallbackText(emoji)).toBe('top-level label');
  });

  it('returns empty string when only alias shortcuts and no accessibility', () => {
    const emoji = { shortcuts: [':smile:'] };
    expect(getEmojiVisibleFallbackText(emoji)).toBe('');
  });

  it('returns empty string for empty shortcuts', () => {
    const emoji = { shortcuts: [] };
    expect(getEmojiVisibleFallbackText(emoji)).toBe('');
  });

  it('skips accessibility label that is itself an alias', () => {
    const emoji = {
      shortcuts: [':smile:'],
      image: { accessibility: { accessibilityData: { label: ':smile:' } } },
    };
    expect(getEmojiVisibleFallbackText(emoji)).toBe('');
  });
});

// ── parseEmoji ───────────────────────────────────────────────────────

describe('parseEmoji', () => {
  it('returns null when no image thumbnail', () => {
    expect(parseEmoji({})).toBeNull();
  });

  it('parses emoji with image and accessibility', () => {
    const emoji = {
      image: {
        thumbnails: [{ url: 'https://ytimg.com/emoji.png', width: 48 }],
        accessibility: { accessibilityData: { label: 'grinning face' } },
      },
      shortcuts: ['😀'],
    };
    const result = parseEmoji(emoji);
    expect(result).not.toBeNull();
    expect(result?.url).toBe('https://ytimg.com/emoji.png');
    // getEmojiAltText returns shortcuts[0] = '😀'
    expect(result?.alt).toBe('😀');
  });

  it('includes fallbackText from non-alias shortcut', () => {
    const emoji = {
      image: {
        thumbnails: [{ url: 'https://ytimg.com/emoji.png', width: 48 }],
      },
      shortcuts: ['grin'],
    };
    const result = parseEmoji(emoji);
    expect(result?.fallbackText).toBe('grin');
  });
});
