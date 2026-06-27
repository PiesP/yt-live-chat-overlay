// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * YouTube URL pattern matching with URLPattern API and regex fallback.
 *
 * URLPattern is available in Chrome 120+, Firefox 132+, Safari 18.4+.
 * For older browsers (userscript environments), falls back to URL parsing.
 */

declare const URLPattern: {
  prototype: { test(url: string): boolean };
  new (options: { hostname?: string; pathname?: string }): { test(url: string): boolean };
};

const hasURLPattern = typeof URLPattern !== 'undefined';

const watchPattern = hasURLPattern
  ? new URLPattern({ hostname: '(www.)?youtube.com', pathname: '/watch' })
  : null;

const livePattern = hasURLPattern
  ? new URLPattern({ hostname: '(www.)?youtube.com', pathname: '/live/*' })
  : null;

export function isYouTubeWatch(url: string): boolean {
  if (watchPattern) return watchPattern.test(url);
  try {
    const u = new URL(url);
    return u.hostname.endsWith('youtube.com') && u.pathname === '/watch';
  } catch {
    return false;
  }
}

export function isYouTubeLive(url: string): boolean {
  if (livePattern) return livePattern.test(url);
  try {
    const u = new URL(url);
    return u.hostname.endsWith('youtube.com') && u.pathname.startsWith('/live/');
  } catch {
    return false;
  }
}
