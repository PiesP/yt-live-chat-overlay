// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Match complete YouTube URLs in browsers and supported Node toolchains. */
function youtubePath(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'www.youtube.com') return null;
    return parsed.pathname;
  } catch {
    return null;
  }
}

export function isYouTubeWatch(url: string): boolean {
  return youtubePath(url) === '/watch';
}

export function isYouTubeLive(url: string): boolean {
  return youtubePath(url)?.startsWith('/live/') === true;
}
