import { describe, it, expect } from 'vitest';
import {
  isAllowedImageHostname,
  isAllowedImageUrl,
  normalizeYouTubeImageUrl,
  ALLOWED_IMAGE_HOST_SUFFIXES,
  ALLOWED_IMAGE_ORIGINS,
} from '@media/image-url-validation';

// ── Constants ─────────────────────────────────────────────────────────────

describe('ALLOWED_IMAGE_HOST_SUFFIXES', () => {
  it('contains expected CDN hosts', () => {
    expect(ALLOWED_IMAGE_HOST_SUFFIXES).toContain('ggpht.com');
    expect(ALLOWED_IMAGE_HOST_SUFFIXES).toContain('googleusercontent.com');
    expect(ALLOWED_IMAGE_HOST_SUFFIXES).toContain('gstatic.com');
    expect(ALLOWED_IMAGE_HOST_SUFFIXES).toContain('ytimg.com');
  });
});

describe('ALLOWED_IMAGE_ORIGINS', () => {
  it('contains expected YouTube CDN origins', () => {
    expect(ALLOWED_IMAGE_ORIGINS).toContain('https://yt3.ggpht.com');
    expect(ALLOWED_IMAGE_ORIGINS).toContain('https://yt4.ggpht.com');
  });
});

// ── isAllowedImageHostname ─────────────────────────────────────────────────

describe('isAllowedImageHostname', () => {
  it('returns true for exact ggpht.com', () => {
    expect(isAllowedImageHostname('ggpht.com')).toBe(true);
  });

  it('returns true for subdomain of allowed host', () => {
    expect(isAllowedImageHostname('yt3.ggpht.com')).toBe(true);
    expect(isAllowedImageHostname('i.ytimg.com')).toBe(true);
  });

  it('returns true for gstatic.com', () => {
    expect(isAllowedImageHostname('gstatic.com')).toBe(true);
    expect(isAllowedImageHostname('www.gstatic.com')).toBe(true);
  });

  it('returns true for googleusercontent.com', () => {
    expect(isAllowedImageHostname('googleusercontent.com')).toBe(true);
    expect(isAllowedImageHostname('lh3.googleusercontent.com')).toBe(true);
  });

  it('returns false for non-allowed hosts', () => {
    expect(isAllowedImageHostname('example.com')).toBe(false);
    expect(isAllowedImageHostname('evil.com')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isAllowedImageHostname('YT3.GGPHT.COM')).toBe(true);
    expect(isAllowedImageHostname('I.YTIMG.COM')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(isAllowedImageHostname('')).toBe(false);
  });

  it('returns false for partial suffix matches', () => {
    // endsWith('.ggpht.com') - not ggpht.com itself, but fakeggpht.com shouldn't match
    expect(isAllowedImageHostname('fakeggpht.com')).toBe(false);
  });
});

// ── isAllowedImageUrl ─────────────────────────────────────────────────────

describe('isAllowedImageUrl', () => {
  it('returns true for valid yt3.ggpht.com HTTPS URL', () => {
    expect(isAllowedImageUrl('https://yt3.ggpht.com/photo.jpg')).toBe(true);
  });

  it('returns true for valid yt4.ggpht.com HTTPS URL', () => {
    expect(isAllowedImageUrl('https://yt4.ggpht.com/photo.jpg')).toBe(true);
  });

  it('returns false for non-HTTPS URL', () => {
    expect(isAllowedImageUrl('http://yt3.ggpht.com/photo.jpg')).toBe(false);
  });

  it('returns false for non-allowed origin', () => {
    expect(isAllowedImageUrl('https://example.com/image.png')).toBe(false);
  });

  it('returns false for invalid URL string', () => {
    expect(isAllowedImageUrl('not-a-url')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isAllowedImageUrl('')).toBe(false);
  });

  it('handles URLs with query parameters', () => {
    expect(isAllowedImageUrl('https://yt3.ggpht.com/photo.jpg?w=100&h=100')).toBe(true);
  });
});

// ── normalizeYouTubeImageUrl ──────────────────────────────────────────────

describe('normalizeYouTubeImageUrl', () => {
  it('normalizes protocol-relative URL', () => {
    expect(normalizeYouTubeImageUrl('//yt3.ggpht.com/photo.jpg')).toBe(
      'https://yt3.ggpht.com/photo.jpg'
    );
  });

  it('upgrades http to https', () => {
    expect(normalizeYouTubeImageUrl('http://yt3.ggpht.com/photo.jpg')).toBe(
      'https://yt3.ggpht.com/photo.jpg'
    );
  });

  it('returns the URL as-is for valid HTTPS URL', () => {
    expect(normalizeYouTubeImageUrl('https://yt3.ggpht.com/photo.jpg')).toBe(
      'https://yt3.ggpht.com/photo.jpg'
    );
  });

  it('returns null for non-allowed host', () => {
    expect(normalizeYouTubeImageUrl('https://example.com/image.png')).toBeNull();
  });

  it('returns null for invalid URL', () => {
    expect(normalizeYouTubeImageUrl('not a url!')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizeYouTubeImageUrl('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(normalizeYouTubeImageUrl('   ')).toBeNull();
  });

  it('trims whitespace from URL', () => {
    expect(normalizeYouTubeImageUrl('  https://yt3.ggpht.com/photo.jpg  ')).toBe(
      'https://yt3.ggpht.com/photo.jpg'
    );
  });

  it('normalizes i.ytimg.com URLs (allowed hostname suffix)', () => {
    const result = normalizeYouTubeImageUrl('https://i.ytimg.com/vi/abc/maxresdefault.jpg');
    expect(result).toBe('https://i.ytimg.com/vi/abc/maxresdefault.jpg');
  });

  it('preserves path and query in the URL', () => {
    const result = normalizeYouTubeImageUrl('https://yt3.ggpht.com/photo.jpg?w=640&h=480');
    expect(result).toBe('https://yt3.ggpht.com/photo.jpg?w=640&h=480');
  });
});
