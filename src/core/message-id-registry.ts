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
    // Re-insert to move to end of insertion order (LRU touch) so that
    // duplicate marks don't create stale "oldest" entries.
    this.ids.delete(id);
    this.ids.set(id, true);

    // FIFO evict the single oldest entry when over capacity.
    // Amortized O(1) per mark() — no bulk deletion spikes.
    while (this.ids.size > this.maxSize) {
      const oldest = this.ids.keys().next().value;
      if (oldest !== undefined) {
        this.ids.delete(oldest);
      }
    }
  }

  /** Clear all registered message IDs. */
  clear(): void {
    this.ids.clear();
  }
}
