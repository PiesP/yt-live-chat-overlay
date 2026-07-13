// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { AuthorRateLimitPreset, AuthorType, BurstLevel } from '@app-types';
import { createLogger } from '@util/logging';

const log = createLogger('AuthorRateLimiter');

/** Default rate limit: max N messages per window */
const DEFAULT_WINDOW_MS = 5_000;
const DEFAULT_MAX_PER_WINDOW = 5;
/** Priority threshold: messages with priority >= this are never rate-limited */
const PRIORITY_EXEMPT_THRESHOLD = 100;
/** How often to prune stale entries (ms) */
const PRUNE_INTERVAL_MS = 10_000;

/** Burst-level-based limit overrides */
const BURST_LIMITS: Record<BurstLevel, number | null> = {
  normal: null,
  elevated: null,
  high: 3,
  extreme: 2,
};

export class PerAuthorRateLimiter {
  private authorTimestamps: Map<string, number[]> = new Map();
  private windowMs: number = DEFAULT_WINDOW_MS;
  private maxPerWindow: number = DEFAULT_MAX_PER_WINDOW;
  private enabled: boolean = true;
  private lastPruneTime: number;
  private readonly getBurstLevel: () => BurstLevel;
  private readonly now: () => number;

  constructor(getBurstLevel: () => BurstLevel, now?: () => number) {
    this.getBurstLevel = getBurstLevel;
    this.now = now ?? (() => Date.now());
    this.lastPruneTime = this.now();
  }

  allow(authorId: string, priority: number, authorType?: AuthorType): boolean {
    if (!this.enabled) return true;

    // Moderators and owners are exempt from rate limiting
    if (authorType === 'moderator' || authorType === 'owner') return true;

    if (priority >= PRIORITY_EXEMPT_THRESHOLD) return true;

    const limit = this.getEffectiveLimit();
    if (limit === null) return true;

    const now = this.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.authorTimestamps.get(authorId);

    if (timestamps) {
      // Binary search for first timestamp > cutoff (timestamps are sorted ascending)
      let lo = 0,
        hi = timestamps.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((timestamps[mid] ?? 0) <= cutoff) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) {
        timestamps.splice(0, lo);
      }
      if (timestamps.length >= limit) {
        this.authorTimestamps.set(authorId, timestamps);
        log.debug('media.rate-limiter.limited', { authorId });
        return false;
      }
    } else {
      timestamps = [];
    }

    timestamps.push(now);
    this.authorTimestamps.set(authorId, timestamps);

    this.pruneStaleEntries(now);

    return true;
  }

  private getEffectiveLimit(): number | null {
    const burstLevel = this.getBurstLevel();
    const burstLimit = BURST_LIMITS[burstLevel];

    if (burstLimit !== null) return burstLimit;
    return this.maxPerWindow;
  }

  private pruneStaleEntries(now: number = Date.now()): void {
    if (now - this.lastPruneTime < PRUNE_INTERVAL_MS) return;
    this.lastPruneTime = now;

    const cutoff = now - this.windowMs;
    for (const [authorId, timestamps] of this.authorTimestamps) {
      // Binary search for first timestamp > cutoff (timestamps are sorted ascending)
      let lo = 0,
        hi = timestamps.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((timestamps[mid] ?? 0) <= cutoff) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) timestamps.splice(0, lo);
      if (timestamps.length === 0) {
        this.authorTimestamps.delete(authorId);
      }
      // else: timestamps already updated in-place, no need to set() again
    }

    // Hard cap: prevent unbounded growth under extreme chat density
    // (e.g. 500+ active authors). Evict oldest entries first.
    // Use headroom-based pruning to avoid O(n log n) sort on every message:
    // only evict when size exceeds MAX_ENTRIES * PRUNE_TRIGGER_RATIO, prune down to MAX_ENTRIES * PRUNE_TARGET_RATIO.
    const maxEntries = 500;
    const PRUNE_TRIGGER_RATIO = 1.25;
    const PRUNE_TARGET_RATIO = 0.75;
    if (this.authorTimestamps.size > maxEntries * PRUNE_TRIGGER_RATIO) {
      const target = Math.floor(maxEntries * PRUNE_TARGET_RATIO);
      // Linear scan to find oldest entries (avoid O(n log n) sort on every message)
      const entries = [...this.authorTimestamps.entries()];
      entries.sort((a, b) => (a[1][0] ?? 0) - (b[1][0] ?? 0));
      const toRemove = entries.slice(0, Math.max(0, entries.length - target));
      for (const [authorId] of toRemove) {
        this.authorTimestamps.delete(authorId);
      }
    }
  }

  updateConfig(config: { preset: AuthorRateLimitPreset }): void {
    if (config.preset === 'off') {
      this.enabled = false;
      this.authorTimestamps.clear();
    } else if (config.preset === 'normal') {
      this.enabled = true;
      this.windowMs = DEFAULT_WINDOW_MS;
      this.maxPerWindow = DEFAULT_MAX_PER_WINDOW;
    } else if (config.preset === 'strict') {
      this.enabled = true;
      this.windowMs = DEFAULT_WINDOW_MS;
      this.maxPerWindow = 2;
    }
  }

  size(): number {
    return this.authorTimestamps.size;
  }

  destroy(): void {
    this.authorTimestamps.clear();
  }
}
