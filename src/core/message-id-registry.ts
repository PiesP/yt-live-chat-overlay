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

    const excess = this.ids.size - this.maxSize;
    for (let i = 0; i < excess; i++) {
      const firstKey = this.ids.keys().next().value;
      if (firstKey === undefined) break;
      this.ids.delete(firstKey);
    }
  }

  /** Remove all registered message IDs. */
  clear(): void {
    this.ids.clear();
  }
}
