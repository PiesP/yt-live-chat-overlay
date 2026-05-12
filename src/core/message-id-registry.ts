/**
 * A Map-based FIFO eviction registry for tracking message IDs.
 * Preserves insertion order and evicts the oldest entry when the
 * configured maximum size is exceeded.
 */
export class MessageIdRegistry {
  private readonly ids = new Map<string, true>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  mark(id: string): void {
    this.ids.set(id, true);
    if (this.ids.size <= this.maxSize) {
      return;
    }

    // Evict the oldest entry when the registry overflows. Map preserves
    // insertion order, so the first key is the oldest entry.
    const excess = this.ids.size - this.maxSize;
    for (let index = 0; index < excess; index++) {
      const firstKey = this.ids.keys().next().value;
      if (firstKey === undefined) break;
      this.ids.delete(firstKey);
    }
  }

  clear(): void {
    this.ids.clear();
  }
}
