import type { BurstLevel } from '@app-types';
import { createLogger } from '@core/logging';

const log = createLogger('AuthorRateLimiter');

/** Default rate limit: max N messages per window */
const DEFAULT_WINDOW_MS = 5_000;
const DEFAULT_MAX_PER_WINDOW = 8;
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
  private lastPruneTime: number = Date.now();
  private readonly getBurstLevel: () => BurstLevel;

  constructor(getBurstLevel: () => BurstLevel) {
    this.getBurstLevel = getBurstLevel;
  }

  allow(authorId: string, priority: number): boolean {
    if (!this.enabled) return true;

    if (priority >= PRIORITY_EXEMPT_THRESHOLD) return true;

    const limit = this.getEffectiveLimit();
    if (limit === null) return true;

    const now = Date.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.authorTimestamps.get(authorId);

    if (timestamps) {
      timestamps = timestamps.filter((t) => t > cutoff);
      if (timestamps.length >= limit) {
        this.authorTimestamps.set(authorId, timestamps);
        log.debug(
          `Rate limited author: ${authorId} (${timestamps.length}/${limit} in ${this.windowMs}ms)`
        );
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
      const valid = timestamps.filter((t) => t > cutoff);
      if (valid.length === 0) {
        this.authorTimestamps.delete(authorId);
      } else {
        this.authorTimestamps.set(authorId, valid);
      }
    }

    // Hard cap: prevent unbounded growth under extreme chat density
    // (e.g. 500+ active authors). Evict oldest entries first.
    const maxEntries = 500;
    if (this.authorTimestamps.size > maxEntries) {
      const sorted = [...this.authorTimestamps.entries()].sort(
        (a, b) => (a[1][0] ?? 0) - (b[1][0] ?? 0)
      );
      const toRemove = sorted.slice(0, this.authorTimestamps.size - maxEntries);
      for (const [authorId] of toRemove) {
        this.authorTimestamps.delete(authorId);
      }
    }
  }

  updateConfig(config: { enabled?: boolean; windowMs?: number; maxPerWindow?: number }): void {
    if (config.enabled !== undefined) this.enabled = config.enabled;
    if (config.windowMs !== undefined) this.windowMs = config.windowMs;
    if (config.maxPerWindow !== undefined) this.maxPerWindow = config.maxPerWindow;
  }

  size(): number {
    return this.authorTimestamps.size;
  }

  destroy(): void {
    this.authorTimestamps.clear();
  }
}
