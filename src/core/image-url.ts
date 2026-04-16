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

/**
 * Validate image URL for chat assets (author photos / emoji / stickers).
 * Only allows trusted YouTube/Google CDN domains over HTTPS.
 */
export const isAllowedYouTubeImageUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && isAllowedHostname(parsed.hostname);
  } catch {
    return false;
  }
};
