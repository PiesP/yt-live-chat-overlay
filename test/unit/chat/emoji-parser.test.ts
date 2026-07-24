// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { describe, expect, it } from 'vitest';
import { extractBestThumbnail } from '@chat/emoji-parser';

const YT_THUMB = 'https://yt3.ggpht.com/emoji/abc123';
const YT_THUMB2 = 'https://yt3.ggpht.com/emoji/def456';

describe('emoji-parser', () => {
  describe('extractBestThumbnail', () => {
    it('returns null for null input', () => {
      expect(extractBestThumbnail(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(extractBestThumbnail(undefined)).toBeNull();
    });

    it('returns null for non-object input', () => {
      expect(extractBestThumbnail('string')).toBeNull();
      expect(extractBestThumbnail(123)).toBeNull();
    });

    it('returns null for object without thumbnails or sources', () => {
      expect(extractBestThumbnail({})).toBeNull();
    });

    it('returns null for empty thumbnails array', () => {
      expect(extractBestThumbnail({ thumbnails: [] })).toBeNull();
    });

    it('extracts best thumbnail from thumbnails array', () => {
      const result = extractBestThumbnail({
        thumbnails: [
          { url: YT_THUMB + '=w24-h24', width: 24, height: 24 },
          { url: YT_THUMB2 + '=w64-h64', width: 64, height: 64 },
        ],
      });
      expect(result).not.toBeNull();
      expect(result?.width).toBe(64);
    });

    it('extracts from sources array as fallback', () => {
      const result = extractBestThumbnail({
        sources: [
          { url: YT_THUMB + '=w48-h48', width: 48, height: 48 },
        ],
      });
      expect(result).not.toBeNull();
    });

    it('skips items with invalid URLs', () => {
      const result = extractBestThumbnail({
        thumbnails: [
          { url: 'invalid-scheme', width: 48 },
        ],
      });
      expect(result).toBeNull();
    });

    it('returns highest-width thumbnail', () => {
      const result = extractBestThumbnail({
        thumbnails: [
          { url: YT_THUMB + '=w48-h48', width: 48 },
          { url: YT_THUMB2 + '=w96-h96', width: 96 },
          { url: YT_THUMB + '=w24-h24', width: 24 },
        ],
      });
      expect(result?.url).toContain('=w96');
    });

    it('returns null when no URLs are valid', () => {
      const result = extractBestThumbnail({
        thumbnails: [{ width: 48, height: 48 }],
      });
      expect(result).toBeNull();
    });
  });
});