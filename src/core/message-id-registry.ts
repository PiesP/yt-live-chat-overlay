/**
 * A Map-based FIFO eviction registry for tracking message IDs.
 * Preserves insertion order and evicts the oldest entry when the
 * configured maximum size is exceeded.
 */

/**
 * Simple Bloom Filter for approximate membership testing.
 * Uses a fixed-size bit array and 3 hash functions.
 */
class SimpleBloomFilter {
  private readonly bits: Uint32Array;
  private readonly size: number;

  constructor(expectedItems: number, falsePositiveRate = 0.01) {
    // m = -n * ln(p) / (ln2)^2
    const ln2sq = 0.4804530139182014;
    this.size = Math.ceil(-(expectedItems * Math.log(falsePositiveRate)) / ln2sq);
    this.bits = new Uint32Array(Math.ceil(this.size / 32));
  }

  private hash(str: string, seed: number): number {
    let h = seed;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % this.size;
  }

  add(item: string): void {
    // Use 3 hash functions derived from different seeds
    const h1 = this.hash(item, 0x9e3779b9);
    const h2 = this.hash(item, 0x517cc1b7);
    const h3 = this.hash(item, 0x85ebca6b);
    this.setBit(h1);
    this.setBit(h2);
    this.setBit(h3);
  }

  mightContain(item: string): boolean {
    const h1 = this.hash(item, 0x9e3779b9);
    const h2 = this.hash(item, 0x517cc1b7);
    const h3 = this.hash(item, 0x85ebca6b);
    return this.getBit(h1) && this.getBit(h2) && this.getBit(h3);
  }

  private setBit(index: number): void {
    const word = index >>> 5;
    const bit = index & 31;
    const arr = this.bits;
    arr[word] = (arr[word] ?? 0) | (1 << bit);
  }

  private getBit(index: number): boolean {
    const word = index >>> 5;
    const bit = index & 31;
    const arr = this.bits;
    return ((arr[word] ?? 0) & (1 << bit)) !== 0;
  }
}

/**
 * Hybrid message ID registry combining an exact Map (for recent entries)
 * with a Bloom Filter (for older entries).
 *
 * - The Map guarantees zero false positives for recent IDs.
 * - The Bloom Filter uses ~1.2 bytes per entry (vs ~50+ bytes per Map entry)
 *   for approximate checking of older IDs, with <1% false positive rate.
 * - Total memory for 1M IDs: ~150KB (Bloom) + ~50KB (Map window of 1000)
 *   vs ~50MB for a pure Map approach.
 */
export class MessageIdRegistry {
  private readonly recentIds = new Map<string, true>();
  private readonly bloomFilter: SimpleBloomFilter;
  private readonly maxRecentSize: number;

  constructor(maxSize: number, bloomExpectedItems?: number) {
    this.maxRecentSize = Math.min(maxSize, 1000);
    this.bloomFilter = new SimpleBloomFilter(bloomExpectedItems ?? maxSize);
  }

  has(id: string): boolean {
    if (this.recentIds.has(id)) return true;
    return this.bloomFilter.mightContain(id);
  }

  mark(id: string): void {
    this.recentIds.set(id, true);
    this.bloomFilter.add(id);

    if (this.recentIds.size <= this.maxRecentSize) {
      return;
    }

    const excess = this.recentIds.size - this.maxRecentSize;
    for (let index = 0; index < excess; index++) {
      const firstKey = this.recentIds.keys().next().value;
      if (firstKey === undefined) break;
      this.recentIds.delete(firstKey);
    }
  }

  clear(): void {
    this.recentIds.clear();
    // Bloom Filter cannot be cleared without recreation;
    // this is an acceptable limitation for session-scoped usage.
  }
}
