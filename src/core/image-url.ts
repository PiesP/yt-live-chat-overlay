const ALLOWED_IMAGE_HOSTS = new Set([
  'yt3.ggpht.com',
  'yt4.ggpht.com',
  'www.gstatic.com',
  'lh3.googleusercontent.com',
]);

const ALLOWED_IMAGE_PROTOCOLS = new Set(['https:']);

const isAllowedHostname = (hostname: string): boolean => {
  const normalizedHostname = hostname.toLowerCase();

  for (const allowedHost of ALLOWED_IMAGE_HOSTS) {
    if (normalizedHostname === allowedHost || normalizedHostname.endsWith(`.${allowedHost}`)) {
      return true;
    }
  }

  return false;
};

/**
 * Validate image URL for chat assets (author photos / emoji / stickers).
 * Only allows trusted YouTube/Google CDN domains.
 */
export const isAllowedYouTubeImageUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);

    if (!ALLOWED_IMAGE_PROTOCOLS.has(parsed.protocol)) {
      return false;
    }

    return isAllowedHostname(parsed.hostname);
  } catch {
    return false;
  }
};
