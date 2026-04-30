const ALLOWED_IMAGE_HOST_SUFFIXES = [
  'ggpht.com',
  'googleusercontent.com',
  'gstatic.com',
  'ytimg.com',
];

const isAllowedHostname = (hostname: string): boolean => {
  const normalizedHostname = hostname.toLowerCase();
  return ALLOWED_IMAGE_HOST_SUFFIXES.some(
    (suffix) => normalizedHostname === suffix || normalizedHostname.endsWith(`.${suffix}`)
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
