const ALLOWED_IMAGE_DOMAINS = [
  'yt3.ggpht.com',
  'yt4.ggpht.com',
  'www.gstatic.com',
  'lh3.googleusercontent.com',
] as const;

/**
 * Validate image URL for chat assets (author photos / emoji / stickers).
 * Only allows trusted YouTube/Google CDN domains.
 */
export const isAllowedYouTubeImageUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return ALLOWED_IMAGE_DOMAINS.some((domain) => parsed.hostname.includes(domain));
  } catch {
    return false;
  }
};
