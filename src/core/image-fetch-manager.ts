// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage, OverlaySettings } from '@app-types';
import { ByteLimitedCache } from '@core/byte-limited-cache';
import { clearSafeInterval } from '@core/dom';

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
  /** Emoji image cache (byte-limited LRU). */
  emojiCache: ByteLimitedCache<HTMLImageElement>;
  /** Author photo cache (byte-limited LRU). */
  authorPhotoCache: ByteLimitedCache<HTMLImageElement>;
  /** Sticker image cache (byte-limited LRU). */
  stickerCache: ByteLimitedCache<HTMLImageElement>;

  /** Set of emoji URLs currently being fetched. */
  readonly emojiFetching = new Set<string>();
  /** Map of emoji URL → performance.now() when fetch started. */
  readonly emojiFetchingStarted = new Map<string, number>();
  /** Map of URL → timestamp for failed emoji fetches, with TTL-based eviction. */
  readonly failedEmojiFetches = new Map<string, number>();
  /** In-flight image load guard to prevent duplicate Image objects. */
  readonly imageLoading = new Set<string>();
  /** In-flight Image objects for teardown neutering. */
  private readonly inFlightImages = new Set<HTMLImageElement>();

  /** Generation counter per URL — prevents stale createImageBitmap results
   * from overwriting newer bitmaps when the same URL is loaded concurrently. */
  private readonly bitmapGeneration = new Map<string, number>();

  /**
   * Pre-converted ImageBitmaps for transfer to the render worker.
   * Created asynchronously when HTMLImageElements finish loading.
   * Transferred via postMessage transfer list to avoid duplicate fetch+decode
   * in the worker. Entries are removed on transfer (bitmap is detached).
   */
  readonly workerBitmapCache = new Map<string, ImageBitmap>();

  private emojiCleanupIntervalId: ReturnType<typeof setInterval> | null = null;
  private emojiFetchLimit = 10;
  private failedEmojiRetryMins = 5;
  private emojiFetchTimeoutMs = 10_000;
  private useWorkerMode = false;
  private renderWorker: Worker | null = null;
  private onImageReadyCallback?: (url: string, cacheKey: string) => void;

  constructor() {
    // Initialize caches with 0 MB — will be properly configured via updateConfig
    this.emojiCache = new ByteLimitedCache<HTMLImageElement>(
      0,
      (img) => img.naturalWidth * img.naturalHeight * 4
    );
    this.authorPhotoCache = new ByteLimitedCache<HTMLImageElement>(
      0,
      (img) => img.naturalWidth * img.naturalHeight * 4
    );
    this.stickerCache = new ByteLimitedCache<HTMLImageElement>(
      0,
      (img) => img.naturalWidth * img.naturalHeight * 4
    );
  }

  /**
   * Configure or reconfigure the image fetch manager with new settings.
   * Resizes caches, updates fetch limits, and starts/stops the cleanup interval.
   */
  updateConfig(settings: OverlaySettings, worker: Worker | null): void {
    this.emojiFetchLimit = settings.emojiFetchLimit;
    this.failedEmojiRetryMins = settings.failedEmojiRetryMins;
    this.emojiFetchTimeoutMs = settings.emojiFetchTimeoutMs;
    this.renderWorker = worker;
    this.useWorkerMode = worker !== null;

    // Resize caches in-place instead of recreating + copying all entries.
    this.emojiCache.resize(settings.emojiCacheMb * 1_000_000);
    this.authorPhotoCache.resize(settings.photoCacheMb * 1_000_000);
    this.stickerCache.resize(settings.stickerCacheMb * 1_000_000);

    // Start cleanup interval if not already running
    if (this.emojiCleanupIntervalId === null) {
      this.emojiCleanupIntervalId = setInterval(() => {
        this.cleanupStaleEmojiFetching();
      }, 5_000);
    }
  }

  /** Register a callback for when an image finishes loading (triggers rAF restart). */
  setOnImageReady(cb: (url: string, cacheKey: string) => void): void {
    this.onImageReadyCallback = cb;
  }

  // ── Image loading ─────────────────────────────────────────────────────

  /** Load an image and store it in the given ByteLimitedCache on success. */
  loadImage(url: string, cache: ByteLimitedCache<HTMLImageElement>): void {
    if (cache.has(url)) return;
    if (this.imageLoading.has(url)) return;
    this.imageLoading.add(url);
    const img = new Image();
    this.inFlightImages.add(img);
    img.crossOrigin = 'anonymous';
    img.src = url;
    img.onload = () => {
      this.inFlightImages.delete(img);
      this.imageLoading.delete(url);
      cache.set(url, img);
      this.preConvertForWorker(url, img);
    };
    img.onerror = () => {
      this.inFlightImages.delete(img);
      this.imageLoading.delete(url);
    };
  }

  /**
   * Pre-convert a loaded HTMLImageElement to ImageBitmap for worker transfer.
   * On success, stores in workerBitmapCache. On failure, silently skips —
   * worker will fetch and decode independently.
   */
  private preConvertForWorker(url: string, img: HTMLImageElement): void {
    if (!this.useWorkerMode || !this.renderWorker) return;
    if (!img.complete || img.naturalWidth === 0) return;
    const generation = (this.bitmapGeneration.get(url) ?? 0) + 1;
    this.bitmapGeneration.set(url, generation);
    createImageBitmap(img)
      .then((bitmap) => {
        // Discard if a newer createImageBitmap for the same URL has been issued.
        if (generation !== this.bitmapGeneration.get(url)) {
          bitmap.close();
          return;
        }
        const old = this.workerBitmapCache.get(url);
        if (old) old.close();
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
    // Clean up stale emoji fetches once per message, before the per-emoji loop.
    // The 5-second setInterval handles periodic cleanup; this provides an
    // immediate sweep before new fetches start without redundant per-emoji calls.
    this.cleanupStaleEmojiFetching();

    for (const seg of message.content) {
      if (seg.type !== 'emoji') continue;
      if (this.emojiFetching.has(seg.emoji.url)) continue;
      if (this.emojiCache.has(seg.emoji.url)) continue;
      if (this.failedEmojiFetches.has(seg.emoji.url)) continue;
      if (this.emojiFetching.size >= this.emojiFetchLimit) continue;
      this.emojiFetching.add(seg.emoji.url);
      this.emojiFetchingStarted.set(seg.emoji.url, performance.now());
      const url = seg.emoji.url;
      const img = new Image();
      this.inFlightImages.add(img);
      img.crossOrigin = 'anonymous';
      img.src = url;
      img.onload = () => {
        this.inFlightImages.delete(img);
        this.emojiFetching.delete(url);
        this.emojiFetchingStarted.delete(url);
        this.emojiCache.set(url, img);
        this.preConvertForWorker(url, img);

        // Notify CanvasRenderer to restart the render loop so the emoji
        // appears within ~1 frame instead of waiting for the next natural rAF tick.
        this.onImageReadyCallback?.(url, 'emoji');
      };
      img.onerror = () => {
        this.inFlightImages.delete(img);
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
   * Remove stale entries from emojiFetching that never resolved.
   * If an image fetch hasn't completed within the configured timeout, the fetch
   * likely failed silently (e.g. CORS block), so evict it to unblock
   * future retries.
   */
  cleanupStaleEmojiFetching(): void {
    const now = performance.now();
    for (const [url, startedAt] of this.emojiFetchingStarted) {
      if (now - startedAt > this.emojiFetchTimeoutMs) {
        this.emojiFetching.delete(url);
        this.emojiFetchingStarted.delete(url);
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

  /** Clean up interval, in-flight images, and worker bitmaps. Caches are cleared by the caller. */
  destroy(): void {
    this.emojiCleanupIntervalId = clearSafeInterval(this.emojiCleanupIntervalId);

    // Neuter in-flight Image objects so callbacks don't fire after teardown.
    for (const img of this.inFlightImages) {
      img.onload = null;
      img.onerror = null;
      img.src = '';
    }
    this.inFlightImages.clear();

    for (const bitmap of this.workerBitmapCache.values()) {
      bitmap.close();
    }
    this.workerBitmapCache.clear();
    this.bitmapGeneration.clear();

    // Null references to prevent late callbacks from accessing destroyed subsystems.
    this.renderWorker = null;
    this.useWorkerMode = false;
    delete this.onImageReadyCallback;
  }
}
