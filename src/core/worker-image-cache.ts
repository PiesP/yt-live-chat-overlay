/**
 * LRU image cache for OffscreenCanvas worker rendering.
 * Fetches images via fetch() + createImageBitmap() with concurrency control.
 */
export class WorkerImageCache {
  private cache = new Map<string, ImageBitmap>();
  private fetching = new Set<string>();
  private maxConcurrent = 6;
  private timeoutMs = 30_000;
  private maxEntries = 500;

  /** Get a cached ImageBitmap, or null if not available. */
  get(url: string): ImageBitmap | null {
    return this.cache.get(url) ?? null;
  }

  /** Start fetching an image if not already cached/fetching. Fire-and-forget. */
  async prefetch(url: string): Promise<void> {
    if (this.cache.has(url) || this.fetching.has(url)) return;
    this.fetching.add(url);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) return;
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      this.evictIfNeeded();
      this.cache.set(url, bitmap);
    } catch {
      // Network errors, aborts, decode failures — silently skip
    } finally {
      this.fetching.delete(url);
    }
  }

  /** Batch prefetch with concurrency limit. Fire-and-forget. */
  async prefetchAll(urls: string[]): Promise<void> {
    const toFetch = urls.filter((u) => !this.cache.has(u) && !this.fetching.has(u));
    if (toFetch.length === 0) return;
    for (let i = 0; i < toFetch.length; i += this.maxConcurrent) {
      const chunk = toFetch.slice(i, i + this.maxConcurrent);
      await Promise.all(chunk.map((u) => this.prefetch(u)));
    }
  }

  /** Check if URL is cached or in-flight. */
  has(url: string): boolean {
    return this.cache.has(url) || this.fetching.has(url);
  }

  /** Clear cache and close all bitmaps. */
  clear(): void {
    for (const bitmap of this.cache.values()) bitmap.close();
    this.cache.clear();
    this.fetching.clear();
  }

  /** Number of cached entries. */
  get size(): number {
    return this.cache.size;
  }

  private evictIfNeeded(): void {
    if (this.cache.size >= this.maxEntries) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) {
        this.cache.get(first)?.close();
        this.cache.delete(first);
      }
    }
  }
}
