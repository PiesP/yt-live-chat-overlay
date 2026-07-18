/**
 * Tests for url-pattern.ts — YouTube URL pattern matching.
 */

import { describe, it, expect } from 'vitest';
import { isYouTubeWatch, isYouTubeLive } from '@chat/youtube/url-pattern';

describe('isYouTubeWatch', () => {
  it('returns true for youtube.com/watch', () => {
    expect(isYouTubeWatch('https://www.youtube.com/watch?v=abc123')).toBe(true);
  });

  it('returns true for youtube.com/watch with query params', () => {
    expect(isYouTubeWatch('https://www.youtube.com/watch?v=abc&t=10s')).toBe(true);
  });

  it('returns false for youtube.com/live', () => {
    expect(isYouTubeLive('https://www.youtube.com/live/some-channel')).toBe(true);
    expect(isYouTubeWatch('https://www.youtube.com/live/some-channel')).toBe(false);
  });

  it('returns false for other domains', () => {
    expect(isYouTubeWatch('https://example.com/watch?v=abc')).toBe(false);
  });

  it('returns false for youtube.com other paths', () => {
    expect(isYouTubeWatch('https://www.youtube.com/results')).toBe(false);
    expect(isYouTubeWatch('https://www.youtube.com/feed/trending')).toBe(false);
  });

  it('returns false for invalid URLs', () => {
    expect(isYouTubeWatch('not a url')).toBe(false);
    expect(isYouTubeWatch('')).toBe(false);
  });

  it('returns false for www.youtube.com with no path', () => {
    expect(isYouTubeWatch('https://www.youtube.com')).toBe(false);
  });
});

describe('isYouTubeLive', () => {
  it('returns true for youtube.com/live/channel', () => {
    expect(isYouTubeLive('https://www.youtube.com/live/some-channel')).toBe(true);
  });

  it('returns true for youtube.com/live with trailing segments', () => {
    expect(isYouTubeLive('https://www.youtube.com/live/channel-name/test')).toBe(true);
  });

  it('returns false for youtube.com/watch', () => {
    expect(isYouTubeLive('https://www.youtube.com/watch?v=abc')).toBe(false);
  });

  it('returns false for youtube.com/live with no channel', () => {
    expect(isYouTubeLive('https://www.youtube.com/live/')).toBe(true);
  });

  it('returns false for other domains', () => {
    expect(isYouTubeLive('https://example.com/live/channel')).toBe(false);
  });

  it('returns false for youtube.com other paths', () => {
    expect(isYouTubeLive('https://www.youtube.com/results')).toBe(false);
  });

  it('returns false for invalid URLs', () => {
    expect(isYouTubeLive('not a url')).toBe(false);
  });
});
