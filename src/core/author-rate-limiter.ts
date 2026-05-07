import type { BurstLevel } from '@app-types';
import { createLogger } from '@core/logging';

const log = createLogger('[AuthorRateLimiter]');

/** Default rate limit: max N messages per window */
const DEFAULT_WINDOW_MS = 5_000;
const DEFAULT_MAX_PER_WINDOW = 5;
/** Priority threshold: messages with priority >= this are never rate-limited */
const PRIORITY_EXEMPT_THRESHOLD = 100;
/** Max entries in the author map to prevent memory leak */
const MAX_AUTHOR_ENTRIES = 1_000;
/** How often to prune stale entries (ms) */
const PRUNE_INTERVAL_MS = 10_000;

/** Burst-level-based limit overrides */
const BURST_LIMITS: Record<BurstLevel, number | null> = {
  normal: null, // No limit during normal traffic
  elevated: null, // No limit during elevated traffic
  high: 3, // Max 3 per window during high burst
  extreme: 2, // Max 2 per window during extreme burst
};

export class PerAuthorRateLimiter {
  private authorTimestamps: Map<string, number[]> = new Map();
  private windowMs: number = DEFAULT_WINDOW_MS;
  private maxPerWindow: number = DEFAULT_MAX_PER_WINDOW;
  private enabled: boolean = true;
  private burstEnabled: boolean = true;
  private lastPruneTime: number = performance.now();
  private getBurstLevel: () => BurstLevel;

  constructor(getBurstLevel: () => BurstLevel) {
    this.getBurstLevel = getBurstLevel;
  }

  /**
   * Check if a message from this author should be allowed.
   * @param authorId - Unique author identifier
   * @param priority - Message priority (SuperChat=200, Membership=100, Normal=0)
   * @returns true if allowed, false if rate-limited
   */
  allow(authorId: string, priority: number): boolean {
    if (!this.enabled) return true;

    // High-priority messages (SuperChat, Membership) are never rate-limited
    if (priority >= PRIORITY_EXEMPT_THRESHOLD) return true;

    // Get current burst-adjusted limit
    const limit = this.getEffectiveLimit();
    if (limit === null) return true; // No limit active

    const now = performance.now();
    let timestamps = this.authorTimestamps.get(authorId);

    // Prune old timestamps outside the window
    if (timestamps) {
      const cutoff = now - this.windowMs;
      timestamps = timestamps.filter((t) => t > cutoff);
      if (timestamps.length >= limit) {
        log.debug(
          `Rate limited author: ${authorId} (${timestamps.length}/${limit} in ${this.windowMs}ms)`
        );
        return false;
      }
    } else {
      timestamps = [];
    }

    // Add current timestamp
    timestamps.push(now);
    this.authorTimestamps.set(authorId, timestamps);

    // Manage map size - evict LRU if over limit
    if (this.authorTimestamps.size > MAX_AUTHOR_ENTRIES) {
      this.pruneStaleEntries();
    }

    // Periodic prune
    if (now - this.lastPruneTime > PRUNE_INTERVAL_MS) {
      this.pruneStaleEntries();
      this.lastPruneTime = now;
    }

    return true;
  }

  /** Get the effective rate limit considering burst level */
  private getEffectiveLimit(): number | null {
    if (!this.burstEnabled) return this.maxPerWindow;

    const burstLevel = this.getBurstLevel();
    const burstLimit = BURST_LIMITS[burstLevel];

    if (burstLimit !== null) return burstLimit;
    return this.maxPerWindow;
  }

  /** Remove stale entries (empty timestamp arrays) to bound memory */
  private pruneStaleEntries(): void {
    const cutoff = performance.now() - this.windowMs;
    for (const [authorId, timestamps] of this.authorTimestamps) {
      const valid = timestamps.filter((t) => t > cutoff);
      if (valid.length === 0) {
        this.authorTimestamps.delete(authorId);
      } else {
        this.authorTimestamps.set(authorId, valid);
      }
    }
  }

  /** Update configuration at runtime */
  updateConfig(config: {
    enabled?: boolean;
    windowMs?: number;
    maxPerWindow?: number;
    burstEnabled?: boolean;
  }): void {
    if (config.enabled !== undefined) this.enabled = config.enabled;
    if (config.windowMs !== undefined) this.windowMs = config.windowMs;
    if (config.maxPerWindow !== undefined) this.maxPerWindow = config.maxPerWindow;
    if (config.burstEnabled !== undefined) this.burstEnabled = config.burstEnabled;
  }

  /** Number of tracked authors (for debugging) */
  size(): number {
    return this.authorTimestamps.size;
  }

  /** Clean up all resources */
  destroy(): void {
    this.authorTimestamps.clear();
  }
}
