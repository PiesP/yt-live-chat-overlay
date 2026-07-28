// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Map-compatible LRU cache used by renderer APIs that require a real `Map`.
 *
 * browser-core's `LruMap` intentionally exposes a smaller map-like surface;
 * this overlay implementation extends `Map` so it can be passed directly to
 * canvas rendering helpers that accept `Map<K, V>`.
 */
export class MapCompatibleLruMap<K, V> extends Map<K, V> {
  constructor(private readonly maxSize: number) {
    super();
    if (!Number.isSafeInteger(maxSize) || maxSize < 1) {
      throw new RangeError('maxSize must be a positive safe integer');
    }
  }

  override set(key: K, value: V): this {
    if (this.has(key)) {
      this.delete(key);
    } else if (this.size >= this.maxSize) {
      const oldest = this.keys().next();
      if (!oldest.done) this.delete(oldest.value);
    }
    return super.set(key, value);
  }

  override get(key: K): V | undefined {
    if (!this.has(key)) return undefined;

    const value = super.get(key) as V;
    this.delete(key);
    super.set(key, value);
    return value;
  }
}
