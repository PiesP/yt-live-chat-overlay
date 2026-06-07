/**
 * Simple LRU Map with a max-size cap.
 * When size exceeds maxSize, the least-recently-used entry is evicted.
 * Getting a value promotes it to most-recently-used.
 */
export class LruMap<K, V> extends Map<K, V> {
  constructor(private readonly maxSize: number) {
    super();
  }

  override set(key: K, value: V): this {
    if (this.has(key)) {
      this.delete(key); // Re-insert to mark as most-recently-used
    } else if (this.size >= this.maxSize) {
      // Evict least-recently-used (first key in insertion order)
      const oldest = this.keys().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }
    return super.set(key, value);
  }

  override get(key: K): V | undefined {
    const value = super.get(key);
    if (value !== undefined) {
      // Re-insert to mark as most-recently-used
      this.delete(key);
      super.set(key, value);
    }
    return value;
  }
}
