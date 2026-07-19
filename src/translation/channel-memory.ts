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
import { isYouTubeWatch } from '@chat/youtube/url-pattern';

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
      if (u.hostname !== 'www.youtube.com') {
        return null;
      }
      // Live stream or regular video: /watch?v=VIDEO_ID
      if (isYouTubeWatch(url)) {
        return u.searchParams.get('v');
      }
      // Live video page: /live/VIDEO_ID
      const segments = u.pathname.split('/').filter(Boolean);
      if (segments[0] === 'live' && segments[1]) return segments[1];

      // Channel page: /@handle or /channel/UC...
      if (segments[0]?.startsWith('@')) return segments[0];
      if (segments[0] === 'channel' && segments[1]) return segments[1];
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Extract a stable channel identifier from the page DOM.
   *
   * For watch pages, the URL only contains the video ID — not the channel.
   * This method reads channel metadata from the page to return a per-channel key
   * (e.g. `@handle` or `UC…` channel ID) so that different streams from the same
   * channel share language memory.
   *
   * @returns Channel key (`@handle` or `UC…`), or null if not found.
   */
  static keyFromDocument(doc: Document): string | null {
    // 1. <meta itemprop="channelId" content="UC..."> — most reliable
    const metaChannelId = doc.querySelector<HTMLMetaElement>('meta[itemprop="channelId"]');
    if (metaChannelId?.content) {
      return metaChannelId.content;
    }

    // 2. #owner ytd-channel-name a → /@handle or /channel/UC...
    const ownerLink = doc.querySelector<HTMLAnchorElement>('#owner ytd-channel-name a');
    if (ownerLink) {
      const path = ownerLink.getAttribute('href');
      if (path) {
        return ChannelLanguageMemory.keyFromUrl(`https://www.youtube.com${path}`);
      }
    }

    return null;
  }

  /**
   * Resolve the best channel key for a YouTube page.
   *
   * Watch pages (`/watch?v=…`) use DOM-based channel ID when available,
   * falling back to the video ID from the URL. Channel pages (`/@handle`,
   * `/channel/UC…`) use the URL-based key directly.
   *
   * @returns Channel/video key, or null for non-YouTube pages.
   */
  static resolveKey(url: string, doc?: Document): string | null {
    const urlKey = ChannelLanguageMemory.keyFromUrl(url);
    if (!urlKey) return null;

    // Watch pages: prefer channel ID from DOM so same-channel streams share memory
    if (doc && url.includes('/watch')) {
      const channelKey = ChannelLanguageMemory.keyFromDocument(doc);
      if (channelKey) return channelKey;
    }

    return urlKey;
  }

  /** Get the cached language for a channel key, or undefined if not cached. */
  get(key: string): TranslationLanguage | undefined {
    const language = this.map.get(key);
    if (language === undefined) return undefined;

    // LRU: move a read entry to the most recently used position.
    this.map.delete(key);
    this.map.set(key, language);
    return language;
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
