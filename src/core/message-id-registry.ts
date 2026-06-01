// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * A Map-based FIFO eviction registry for tracking message IDs.
 * Preserves insertion order and evicts the oldest entry when the
 * configured maximum size is exceeded.
 *
 * Uses a single Map for exact membership — no Bloom Filter overhead.
 * At 5000 entries with string keys (~100 bytes each), memory is ~500KB,
 * well within browser limits for a session-scoped registry.
 */
export class MessageIdRegistry {
  private readonly ids = new Map<string, true>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  /** Check if a message ID has already been registered. */
  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Register a message ID, evicting oldest if at capacity. */
  mark(id: string): void {
    this.ids.set(id, true);

    if (this.ids.size <= this.maxSize) {
      return;
    }

    // Bulk evict half the entries to avoid O(n) per-insert eviction overhead.
    const toDelete = Math.ceil(this.ids.size / 2);
    let deleted = 0;
    for (const key of this.ids.keys()) {
      this.ids.delete(key);
      if (++deleted >= toDelete) break;
    }
  }

  /** Clear all registered message IDs. */
  clear(): void {
    this.ids.clear();
  }
}
