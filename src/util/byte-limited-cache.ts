// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * ResizableByteLimitedCache — an overlay-owned cache that keeps total estimated byte usage
 * under a configurable limit by evicting the least recently used entries.
 *
 * Useful for image and canvas bitmap caches where the number of entries
 * is a poor proxy for actual memory pressure (a 200×200 canvas vs a
 * 2000×2000 canvas both count as 1 entry).
 *
 * This intentionally differs from browser-core's fixed-size ByteLimitedCache:
 * limits can be changed at runtime, and manual delete/clear invokes the
 * value-only eviction callback so canvas and bitmap resources are released.
 */
export class ResizableByteLimitedCache<V> {
  private readonly map = new Map<string, V>();
  private totalBytes = 0;
  private _maxBytes: number;

  constructor(
    maxBytes: number,
    private estimateSize: (value: V) => number,
    private onEvict?: (value: V) => void,
    private readonly maxEntries = Number.POSITIVE_INFINITY
  ) {
    if (
      maxEntries !== Number.POSITIVE_INFINITY &&
      (!Number.isInteger(maxEntries) || maxEntries < 0)
    ) {
      throw new RangeError('maxEntries must be a non-negative integer');
    }
    this._maxBytes = maxBytes;
  }

  get maxBytes(): number {
    return this._maxBytes;
  }

  /**
   * Change the byte limit without recreating the cache.
   * If the new limit is smaller, oldest entries are evicted until within bounds.
   */
  resize(newMaxBytes: number): void {
    this._maxBytes = newMaxBytes;
    while (this.totalBytes > this._maxBytes && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.delete(oldestKey);
      }
    }
  }

  get(key: string): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      // Move key to end of insertion order (LRU — Map is ordered)
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: string, value: V): boolean {
    const bytes = this.estimateSize(value);

    // Subtract previous entry's bytes before overwrite to prevent ghost
    // byte accumulation. Without this, repeated set() on the same key
    // inflates totalBytes beyond the actual sum, causing premature eviction.
    const existing = this.map.get(key);
    if (existing !== undefined) {
      this.totalBytes -= this.estimateSize(existing);
      this.map.delete(key); // re-insert below to refresh insertion order
      this.onEvict?.(existing);
    }

    // Evict oldest entries until under maxBytes
    while (
      (this.totalBytes + bytes > this._maxBytes || this.map.size >= this.maxEntries) &&
      this.map.size > 0
    ) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.delete(oldestKey);
      }
    }
    // Re-check after eviction — if value itself exceeds maxBytes, don't cache
    if (this.totalBytes + bytes > this._maxBytes || this.maxEntries < 1) {
      this.onEvict?.(value);
      return false; // single item too large for cache
    }
    this.map.set(key, value);
    this.totalBytes += bytes;
    return true;
  }

  delete(key: string): boolean {
    const val = this.map.get(key);
    if (val === undefined) return false;
    this.map.delete(key);
    this.totalBytes -= this.estimateSize(val);
    this.onEvict?.(val);
    return true;
  }

  /** Remove an entry without eviction cleanup when ownership transfers to another subsystem. */
  take(key: string): V | undefined {
    const val = this.map.get(key);
    if (val === undefined) return undefined;
    this.totalBytes -= this.estimateSize(val);
    this.map.delete(key);
    return val;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  clear(): void {
    const values = this.onEvict ? [...this.map.values()] : [];
    this.map.clear();
    this.totalBytes = 0;
    for (const val of values) this.onEvict?.(val);
  }

  get size(): number {
    return this.map.size;
  }

  /** LRU touch: move key to end of insertion order (Map is ordered). */
  touch(key: string): void {
    this.get(key);
  }
}
