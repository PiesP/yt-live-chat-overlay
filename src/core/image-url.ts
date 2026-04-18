const ALLOWED_IMAGE_HOSTS = [
  'yt3.ggpht.com',
  'yt4.ggpht.com',
  'www.gstatic.com',
  'lh3.googleusercontent.com',
];

const isAllowedHostname = (hostname: string): boolean => {
  const normalizedHostname = hostname.toLowerCase();
  return ALLOWED_IMAGE_HOSTS.some(
    (host) => normalizedHostname === host || normalizedHostname.endsWith(`.${host}`)
  );
};

const parseAllowedImageUrl = (url: string): URL | null => {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const normalizedUrl = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
    const parsed = new URL(normalizedUrl);

    if (!isAllowedHostname(parsed.hostname)) {
      return null;
    }

    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:';
    }

    return parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Normalize trusted chat asset URLs into absolute HTTPS URLs.
 */
export const normalizeYouTubeImageUrl = (url: string): string | null =>
  parseAllowedImageUrl(url)?.toString() ?? null;

/**
 * Validate image URL for chat assets (author photos / emoji / stickers).
 * Only allows trusted YouTube/Google CDN domains over HTTPS.
 */
export const isAllowedYouTubeImageUrl = (url: string): boolean =>
  normalizeYouTubeImageUrl(url) !== null;
