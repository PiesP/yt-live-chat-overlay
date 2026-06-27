// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Per-channel language memory.
 *
 * Remembers the detected primary language for each YouTube channel URL
 * so that returning to the same channel skips Language Detector calls.
 * Memory is bounded (max 20 entries, LRU eviction) and session-only.
 */

import type { TranslationLanguage } from '@app-types';
import { isYouTubeWatch } from '@core/youtube-url-pattern';

const MAX_ENTRIES = 20;

export class ChannelLanguageMemory {
  private readonly map = new Map<string, TranslationLanguage>();

  /**
   * Extract a stable channel key from a YouTube URL.
   *
   * - Live stream / watch page: returns video ID (e.g. 'v=dQw4w9WgXcQ')
   * - Channel page: returns @handle or channel/UC... ID
   * - Returns null for non-YouTube pages or unrecognized formats.
   */
  static keyFromUrl(url: string): string | null {
    try {
      const u = new URL(url);
      if (u.hostname !== 'www.youtube.com' && u.hostname !== 'youtube.com') {
        return null;
      }
      // Live stream or regular video: /watch?v=VIDEO_ID
      if (isYouTubeWatch(url)) {
        return u.searchParams.get('v');
      }
      // Channel page: /@handle or /channel/UC...
      const segments = u.pathname.split('/').filter(Boolean);
      if (segments[0]?.startsWith('@')) return segments[0];
      if (segments[0] === 'channel' && segments[1]) return segments[1];
      return null;
    } catch {
      return null;
    }
  }

  /** Get the cached language for a channel key, or undefined if not cached. */
  get(key: string): TranslationLanguage | undefined {
    return this.map.get(key);
  }

  /**
   * Store a language for a channel key.
   * If the map exceeds MAX_ENTRIES, evicts the least-recently-used entry.
   */
  set(key: string, lang: TranslationLanguage): void {
    // LRU: delete and re-insert to move to end (most recently used position)
    this.map.delete(key);
    if (this.map.size >= MAX_ENTRIES) {
      const first = this.map.keys().next().value;
      if (first) this.map.delete(first);
    }
    this.map.set(key, lang);
  }

  /** Clear all cached entries. */
  clear(): void {
    this.map.clear();
  }

  /** Number of cached entries. */
  get size(): number {
    return this.map.size;
  }
}
