// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * ByteLimitedCache — a Map wrapper that keeps total estimated byte usage
 * under a configurable limit by FIFO-evicting the oldest entries.
 *
 * Useful for image and canvas bitmap caches where the number of entries
 * is a poor proxy for actual memory pressure (a 200×200 canvas vs a
 * 2000×2000 canvas both count as 1 entry).
 */

export class ByteLimitedCache<V> {
  readonly map = new Map<string, V>();
  private totalBytes = 0;

  constructor(
    readonly maxBytes: number,
    private estimateSize: (value: V) => number,
    private onEvict?: (value: V) => void
  ) {}

  get(key: string): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      // LRU touch: move key to end of insertion order (Map is ordered)
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: string, value: V): void {
    // Evict oldest entries until under maxBytes
    const bytes = this.estimateSize(value);
    while (this.totalBytes + bytes > this.maxBytes && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        const oldestVal = this.map.get(oldestKey);
        if (oldestVal !== undefined) this.onEvict?.(oldestVal);
        this.delete(oldestKey);
      }
    }
    // Re-check after eviction — if value itself exceeds maxBytes, don't cache
    if (this.totalBytes + bytes > this.maxBytes && this.map.size === 0) {
      return; // single item too large for cache
    }
    this.map.set(key, value);
    this.totalBytes += bytes;
  }

  delete(key: string): boolean {
    const val = this.map.get(key);
    if (val === undefined) return false;
    this.totalBytes -= this.estimateSize(val);
    this.onEvict?.(val);
    return this.map.delete(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  clear(): void {
    if (this.onEvict) {
      for (const val of this.map.values()) this.onEvict(val);
    }
    this.map.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    return this.map.size;
  }

  /** LRU touch: move key to end of insertion order (Map is ordered). */
  touch(key: string): void {
    const val = this.map.get(key);
    if (val !== undefined) {
      this.map.delete(key);
      this.map.set(key, val);
    }
  }
}
