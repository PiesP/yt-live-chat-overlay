// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Shared image URL validation for YouTube CDN resources.
 *
 * Centralizes the host-based allowlist used by both ImageFetchManager
 * (network fetch guard) and ChatEmojiParser (URL normalization).
 */

/** Hostname suffixes considered valid YouTube CDN origins. */
export const ALLOWED_IMAGE_HOST_SUFFIXES = [
  'ggpht.com',
  'googleusercontent.com',
  'gstatic.com',
  'ytimg.com',
] as const;

/** Exact origins allowed for image fetch (more restrictive). */
export const ALLOWED_IMAGE_ORIGINS = [
  'https://yt3.ggpht.com',
  'https://yt4.ggpht.com',
] as const;

/** Check whether a hostname ends with one of the allowed suffixes. */
export function isAllowedImageHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return ALLOWED_IMAGE_HOST_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`)
  );
}

/** Validate that a URL string originates from an allowed YouTube CDN origin. */
export function isAllowedImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      ALLOWED_IMAGE_ORIGINS.some(
        (origin) =>
          parsed.origin === origin || parsed.origin === origin.replace('https://', 'https://i.')
      )
    );
  } catch {
    return false;
  }
}

/**
 * Normalize a YouTube image URL: ensure https, validate host, return canonical URL.
 * Returns null if the URL is not from an allowed host.
 */
export function normalizeYouTubeImageUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;

  try {
    const normalizedUrl = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
    const parsed = new URL(normalizedUrl);

    if (!isAllowedImageHostname(parsed.hostname)) return null;

    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:';
    }

    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
