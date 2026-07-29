// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage, OverlaySettings } from '@app-types';
import { EMOJI_CACHE_MAX_ENTRIES, getStickerCacheBytes } from '@media/cache-limits';
import { isAllowedImageUrl } from '@media/image-url-validation';
import { ResizableByteLimitedCache } from '@util/byte-limited-cache';
import { clearSafeInterval } from '@util/dom';
import { createLogger } from '@util/logging';

/** Maximum number of failed emoji fetch entries before eviction triggers. */
const FAILED_EMOJI_FETCH_CAP = 500;
/** Number of entries to evict when the cap is exceeded. */
const FAILED_EMOJI_FETCH_EVICT_COUNT = 250;

/**
 * ImageFetchManager — handles all image/emoji/sticker loading and caching.
 *
 * Extracted from CanvasRenderer to separate the image loading concern from
 * the render loop and message lifecycle. Manages three byte-limited caches
 * (emoji, author photo, sticker), tracks in-flight fetches with deduplication,
 * handles failed fetch retry windows, and optionally pre-converts loaded
 * images to ImageBitmaps for off-main-thread worker transfer.
 */
export class ImageFetchManager {
  private static readonly log = createLogger('ImageFetchManager');
  /** Emoji image cache (byte-limited LRU). */
  emojiCache: ResizableByteLimitedCache<HTMLImageElement>;
  /** Author photo cache (byte-limited LRU). */
  authorPhotoCache: ResizableByteLimitedCache<HTMLImageElement>;
  /** Sticker image cache (byte-limited LRU). */
  stickerCache: ResizableByteLimitedCache<HTMLImageElement>;

  /** Set of emoji URLs currently being fetched. */
  readonly emojiFetching = new Set<string>();
  /** Map of emoji URL → performance.now() when fetch started. */
  readonly emojiFetchingStarted = new Map<string, number>();
  /** Map of URL → timestamp for failed emoji fetches, with TTL-based eviction. */
  readonly failedEmojiFetches = new Map<string, number>();
  /** In-flight image load guard to prevent duplicate Image objects. */
  readonly imageLoading = new Set<string>();
  /** URLs whose decoded images cannot fit a specific configured cache. */
  private readonly uncacheableImageUrlsByCache = new Map<
    ResizableByteLimitedCache<HTMLImageElement>,
    Set<string>
  >();
  /** In-flight Image objects for teardown neutering. */
  private readonly inFlightImages = new Set<HTMLImageElement>();
  /** Timeout handles for author/sticker image loads. */
  private readonly imageLoadTimeouts = new Map<HTMLImageElement, ReturnType<typeof setTimeout>>();
  /** Maps emoji URLs to in-flight Image objects for timeout cleanup. */
  private readonly emojiUrlToImage = new Map<string, HTMLImageElement>();

  /** Generation counter per URL — prevents stale createImageBitmap results
   * from overwriting newer bitmaps when the same URL is loaded concurrently. */
  private readonly bitmapGeneration = new Map<string, number>();

  /**
   * Pre-converted ImageBitmaps for transfer to the render worker.
   * Created asynchronously when HTMLImageElements finish loading.
   * Transferred via postMessage transfer list to avoid duplicate fetch+decode
   * in the worker. Entries are removed on transfer (bitmap is detached).
   * Byte-limited to prevent unbounded growth during long sessions with many
   * unique emoji/sticker URLs.
   */
  readonly workerBitmapCache = new ResizableByteLimitedCache<ImageBitmap>(
    10_000_000, // 10 MB — enough for ~500 emoji at 200×200 RGBA
    (bitmap) => bitmap.width * bitmap.height * 4,
    (bitmap) => bitmap.close()
  );

  private emojiCleanupIntervalId: ReturnType<typeof setInterval> | null = null;
  private isEmojiCleanupPaused = false;
  private isDestroyed = false;
  private emojiFetchLimit = 10;
  private failedEmojiRetryMins = 5;
  private emojiFetchTimeoutMs = 10_000;
  private useWorkerMode = false;
  private renderWorker: Worker | null = null;
  private onImageReadyCallback?: (url: string, cacheKey: string) => void;

  constructor() {
    // Initialize caches with 0 MB — will be properly configured via updateConfig
    this.emojiCache = new ResizableByteLimitedCache<HTMLImageElement>(
      0,
      (img) => img.naturalWidth * img.naturalHeight * 4,
      undefined,
      EMOJI_CACHE_MAX_ENTRIES
    );
    this.authorPhotoCache = new ResizableByteLimitedCache<HTMLImageElement>(
      0,
      (img) => img.naturalWidth * img.naturalHeight * 4
    );
    this.stickerCache = new ResizableByteLimitedCache<HTMLImageElement>(
      0,
      (img) => img.naturalWidth * img.naturalHeight * 4
    );
  }

  /**
   * Configure or reconfigure the image fetch manager with new settings.
   * Resizes caches, updates fetch limits, and starts/stops the cleanup interval.
   */
  updateConfig(settings: OverlaySettings, worker: Worker | null): void {
    if (this.isDestroyed) return;

    const wasWorkerMode = this.useWorkerMode;
    this.emojiFetchLimit = settings.emojiFetchLimit;
    this.failedEmojiRetryMins = settings.failedEmojiRetryMins;
    this.emojiFetchTimeoutMs = settings.emojiFetchTimeoutMs;
    this.renderWorker = worker;
    this.useWorkerMode = worker !== null;

    // A renderer fallback can happen while an image conversion promise is
    // still settling. Detach the old Worker path immediately and release any
    // converted bitmaps that no longer have a consumer.
    if (wasWorkerMode && !this.useWorkerMode) {
      this.workerBitmapCache.clear();
      this.bitmapGeneration.clear();
    }

    // Resize caches in-place instead of recreating + copying all entries.
    this.resizeImageCache(this.emojiCache, settings.emojiCacheMb * 1_000_000);
    this.resizeImageCache(this.authorPhotoCache, settings.photoCacheMb * 1_000_000);
    this.resizeImageCache(this.stickerCache, getStickerCacheBytes(settings.stickerCacheMb));

    // Start cleanup interval only if not already running.
    // Re-creating the interval on every updateConfig() causes unnecessary
    // timer churn — the 5s tick only reads current instance properties.
    if (this.emojiCleanupIntervalId === null) {
      this.emojiCleanupIntervalId = setInterval(() => {
        if (this.isDestroyed) return;
        this.cleanupStaleEmojiFetching();
      }, 5_000);
    }
  }

  /** Register a callback for when an image finishes loading (triggers rAF restart). */
  setOnImageReady(cb: (url: string, cacheKey: string) => void): void {
    if (this.isDestroyed) return;
    this.onImageReadyCallback = cb;
  }

  // ── Image loading ─────────────────────────────────────────────────────

  /** Load an image and store it in the given resizable cache on success.
   *  URLs are validated against the YouTube CDN whitelist. */
  loadImage(url: string, cache: ResizableByteLimitedCache<HTMLImageElement>): void {
    if (this.isDestroyed) return;
    if (cache.has(url)) return;
    if (this.imageLoading.has(url)) return;
    if (this.isImageUncacheable(url, cache)) return;
    if (!isAllowedImageUrl(url)) {
      ImageFetchManager.log.debug('media.image.blocked', { reason: 'not-in-cdn-whitelist', url });
      return;
    }
    this.imageLoading.add(url);
    const img = new Image();
    this.inFlightImages.add(img);
    const clearLoadTimeout = (): void => {
      const timeout = this.imageLoadTimeouts.get(img);
      if (timeout !== undefined) clearTimeout(timeout);
      this.imageLoadTimeouts.delete(img);
    };
    img.crossOrigin = 'anonymous';
    // Assign onload/onerror BEFORE setting src to avoid a race where
    // a cached image fires the load event synchronously before the
    // handler is attached.
    img.onload = () => {
      clearLoadTimeout();
      this.imageLoading.delete(url);
      this.inFlightImages.delete(img);
      if (this.isDestroyed) return;
      if (!cache.set(url, img)) {
        this.recordUncacheableImage(url, cache);
        return;
      }
      this.preConvertForWorker(url, img);
    };
    img.onerror = () => {
      clearLoadTimeout();
      this.imageLoading.delete(url);
      this.inFlightImages.delete(img);
      if (this.isDestroyed) return;
    };
    this.imageLoadTimeouts.set(
      img,
      setTimeout(() => {
        this.imageLoadTimeouts.delete(img);
        img.onload = null;
        img.onerror = null;
        img.src = '';
        this.imageLoading.delete(url);
        this.inFlightImages.delete(img);
      }, this.emojiFetchTimeoutMs)
    );
    img.src = url;
  }

  private resizeImageCache(
    cache: ResizableByteLimitedCache<HTMLImageElement>,
    maxBytes: number
  ): void {
    if (cache.maxBytes !== maxBytes) {
      this.uncacheableImageUrlsByCache.delete(cache);
    }
    cache.resize(maxBytes);
  }

  private isImageUncacheable(
    url: string,
    cache: ResizableByteLimitedCache<HTMLImageElement>
  ): boolean {
    return this.uncacheableImageUrlsByCache.get(cache)?.has(url) ?? false;
  }

  private recordUncacheableImage(
    url: string,
    cache: ResizableByteLimitedCache<HTMLImageElement>
  ): void {
    let urls = this.uncacheableImageUrlsByCache.get(cache);
    if (!urls) {
      urls = new Set<string>();
      this.uncacheableImageUrlsByCache.set(cache, urls);
    }
    urls.add(url);
    if (urls.size <= EMOJI_CACHE_MAX_ENTRIES) return;
    const oldest = urls.values().next().value;
    if (oldest !== undefined) urls.delete(oldest);
  }

  /**
   * Pre-convert a loaded HTMLImageElement to ImageBitmap for worker transfer.
   * On success, stores in workerBitmapCache. On failure, silently skips —
   * worker will fetch and decode independently.
   *
   * NOTE: createImageBitmap is used instead of WebCodecs ImageDecoder API.
   * WebCodecs would offer more control (e.g. decode-only-without-render,
   * color space handling) but is not used here because:
   *   - createImageBitmap is universally supported (including Firefox 121+)
   *     while WebCodecs ImageDecoder has spotty support in workers.
   *   - The current pipeline fetches PNG/JPG blobs from YouTube CDN;
   *     createImageBitmap handles these formats efficiently.
   *   - Future consideration: if we need AVIF/WebP-sequential-decode or
   *     frame-by-frame control, ImageDecoder would be the upgrade path.
   */
  private preConvertForWorker(url: string, img: HTMLImageElement): void {
    if (!this.useWorkerMode || !this.renderWorker) return;
    if (!img.complete || img.naturalWidth === 0) return;
    const generation = (this.bitmapGeneration.get(url) ?? 0) + 1;
    this.bitmapGeneration.set(url, generation);
    createImageBitmap(img)
      .then((bitmap) => {
        if (this.isDestroyed || !this.useWorkerMode || !this.renderWorker) {
          bitmap.close();
          return;
        }
        // Discard if a newer createImageBitmap for the same URL has been issued.
        if (generation !== this.bitmapGeneration.get(url)) {
          bitmap.close();
          return;
        }
        this.workerBitmapCache.set(url, bitmap);
      })
      .catch(() => {
        // On failure, clear the generation so a retry doesn't appear stale.
        if (generation === this.bitmapGeneration.get(url)) {
          this.bitmapGeneration.delete(url);
        }
      });
  }

  /**
   * Pre-fetch all images referenced by a chat message:
   * emoji, author photo, and sticker (SuperChat).
   */
  prefetchImages(message: ChatMessage): void {
    if (this.isDestroyed) return;

    for (const seg of message.content) {
      if (seg.type !== 'emoji') continue;
      const emojiUrl = seg.emoji.url;
      if (!isAllowedImageUrl(emojiUrl)) {
        ImageFetchManager.log.debug('media.image.emoji-blocked', {
          reason: 'not-in-cdn-whitelist',
          url: emojiUrl,
        });
        continue;
      }
      if (this.emojiFetching.has(emojiUrl)) continue;
      if (this.emojiCache.has(emojiUrl)) continue;
      if (this.isImageUncacheable(emojiUrl, this.emojiCache)) continue;
      if (this.isEmojiFetchFailed(emojiUrl)) continue;
      if (this.emojiFetching.size >= this.emojiFetchLimit) continue;
      this.emojiFetching.add(emojiUrl);
      this.emojiFetchingStarted.set(emojiUrl, performance.now());
      const url = emojiUrl;
      const img = new Image();
      this.inFlightImages.add(img);
      this.emojiUrlToImage.set(url, img);
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (this.isDestroyed) return;
        this.inFlightImages.delete(img);
        this.emojiUrlToImage.delete(url);
        this.emojiFetching.delete(url);
        this.emojiFetchingStarted.delete(url);
        if (!this.emojiCache.set(url, img)) {
          this.recordUncacheableImage(url, this.emojiCache);
          return;
        }
        this.preConvertForWorker(url, img);

        // Notify CanvasRenderer to restart the render loop so the emoji
        // appears within ~1 frame instead of waiting for the next natural rAF tick.
        this.onImageReadyCallback?.(url, 'emoji');
      };
      img.onerror = () => {
        if (this.isDestroyed) return;
        this.inFlightImages.delete(img);
        this.emojiUrlToImage.delete(url);
        this.emojiFetching.delete(url);
        this.emojiFetchingStarted.delete(url);
        this.failedEmojiFetches.set(url, Date.now());
        // Cap the failed fetches map to prevent unbounded memory growth.
        if (this.failedEmojiFetches.size > FAILED_EMOJI_FETCH_CAP) {
          let evicted = 0;
          for (const key of this.failedEmojiFetches.keys()) {
            this.failedEmojiFetches.delete(key);
            if (++evicted >= FAILED_EMOJI_FETCH_EVICT_COUNT) break;
          }
        }
      };
      img.src = url;
    }

    if (message.authorPhotoUrl) {
      this.loadImage(message.authorPhotoUrl, this.authorPhotoCache);
    }

    const stickerUrl = message.superChat?.sticker?.url;
    if (stickerUrl) {
      this.loadImage(stickerUrl, this.stickerCache);
    }
  }

  /**
   * Check whether a URL is in the failed-fetch cache, refreshing its
   * position on access so eviction targets the least-recently-seen entries
   * (true LRU) rather than the oldest-inserted ones (FIFO).
   */
  private isEmojiFetchFailed(url: string): boolean {
    const ts = this.failedEmojiFetches.get(url);
    if (ts === undefined) return false;
    // Re-insert to move this entry to the end of the Map's insertion order,
    // marking it as most-recently-seen for LRU eviction.
    this.failedEmojiFetches.delete(url);
    this.failedEmojiFetches.set(url, ts);
    return true;
  }

  /**
   * Remove stale entries from emojiFetching that never resolved.
   * If an image fetch hasn't completed within the configured timeout, the fetch
   * likely failed silently (e.g. CORS block), so evict it to unblock
   * future retries.
   */
  cleanupStaleEmojiFetching(): void {
    if (this.isDestroyed) return;

    const now = performance.now();
    for (const [url, startedAt] of this.emojiFetchingStarted) {
      if (now - startedAt > this.emojiFetchTimeoutMs) {
        this.emojiFetching.delete(url);
        this.emojiFetchingStarted.delete(url);
        // Release the stalled Image to prevent resource leak.
        const img = this.emojiUrlToImage.get(url);
        if (img) {
          img.onload = null;
          img.onerror = null;
          img.src = '';
          this.inFlightImages.delete(img);
          this.emojiUrlToImage.delete(url);
        }
      }
    }

    // Evict failed entries older than TTL so permanently broken URLs are not retried forever.
    if (this.failedEmojiFetches.size > 0) {
      const cutoff = Date.now() - this.failedEmojiRetryMins * 60_000;
      for (const [url, failedAt] of this.failedEmojiFetches) {
        if (failedAt < cutoff) {
          this.failedEmojiFetches.delete(url);
        }
      }
    }
  }

  /**
   * Pause the emoji cleanup interval when the tab becomes hidden.
   * Prevents unnecessary setInterval execution during background idle.
   */
  pause(): void {
    if (this.isEmojiCleanupPaused) return;
    this.isEmojiCleanupPaused = true;
    this.emojiCleanupIntervalId = clearSafeInterval(this.emojiCleanupIntervalId);
  }

  /**
   * Resume the emoji cleanup interval when the tab becomes visible.
   * Only restarts if it was running before pause() was called.
   */
  resume(): void {
    if (!this.isEmojiCleanupPaused) return;
    this.isEmojiCleanupPaused = false;
    if (this.isDestroyed) return;
    if (this.emojiCleanupIntervalId === null) {
      this.emojiCleanupIntervalId = setInterval(() => {
        if (this.isDestroyed || this.isEmojiCleanupPaused) return;
        this.cleanupStaleEmojiFetching();
      }, 5_000);
    }
  }

  /** Permanently stop image work and release timers, in-flight images, and caches. */
  destroy(): void {
    this.isDestroyed = true;
    this.emojiCleanupIntervalId = clearSafeInterval(this.emojiCleanupIntervalId);

    // Neuter in-flight Image objects so callbacks don't fire after teardown.
    for (const img of this.inFlightImages) {
      const timeout = this.imageLoadTimeouts.get(img);
      if (timeout !== undefined) clearTimeout(timeout);
      img.onload = null;
      img.onerror = null;
      img.src = '';
    }
    this.imageLoadTimeouts.clear();
    this.inFlightImages.clear();
    this.emojiUrlToImage.clear();
    this.emojiFetching.clear();
    this.emojiFetchingStarted.clear();
    this.failedEmojiFetches.clear();
    this.imageLoading.clear();
    this.uncacheableImageUrlsByCache.clear();

    // ResizableByteLimitedCache.clear() calls onEvict (bitmap.close()) for each entry.
    this.workerBitmapCache.clear();
    this.bitmapGeneration.clear();

    // Clear image caches to release cached ImageBitmap/HTMLImageElement references.
    this.emojiCache.clear();
    this.authorPhotoCache.clear();
    this.stickerCache.clear();

    // Null references to prevent late callbacks from accessing destroyed subsystems.
    this.renderWorker = null;
    this.useWorkerMode = false;
    delete this.onImageReadyCallback;
  }
}
