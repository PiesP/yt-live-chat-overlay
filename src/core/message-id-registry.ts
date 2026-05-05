/**
 * A Set-based FIFO eviction registry for tracking message IDs.
 * Preserves insertion order and evicts the oldest entries when the
 * configured maximum size is exceeded.
 */
export class MessageIdRegistry {
  private readonly ids = new Set<string>();

  constructor(private readonly maxSize: number) {}

  has(id: string): boolean {
    return this.ids.has(id);
  }

  mark(id: string): void {
    this.ids.add(id);
    if (this.ids.size <= this.maxSize) {
      return;
    }

    // Evict oldest entries when the registry overflows. Set preserves
    // insertion order, so iterating yields entries in FIFO sequence.
    const iterator = this.ids.values();
    const excess = this.ids.size - this.maxSize;
    for (let index = 0; index < excess; index++) {
      const next = iterator.next();
      if (next.done || next.value === undefined) {
        break;
      }

      this.ids.delete(next.value);
    }
  }

  clear(): void {
    this.ids.clear();
  }
}
