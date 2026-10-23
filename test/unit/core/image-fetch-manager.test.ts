// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage, OverlaySettings } from '@app-types';
import { ImageFetchManager } from '@media/image-fetch-manager';
import { DEFAULT_SETTINGS } from '@settings/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

class PendingImage {
  static readonly instances: PendingImage[] = [];

  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  crossOrigin: string | null = null;
  complete = true;
  naturalWidth = 32;
  naturalHeight = 32;
  private source = '';

  constructor() {
    PendingImage.instances.push(this);
  }

  get src(): string {
    return this.source;
  }

  set src(value: string) {
    this.source = value;
  }
}

const EMOJI_URL = 'https://yt3.ggpht.com/emoji.png';
const AUTHOR_URL = 'https://yt4.ggpht.com/author.png';
const STICKER_URL = 'https://yt3.ggpht.com/sticker.png';

function message(emojiUrl = EMOJI_URL): ChatMessage {
  return {
    text: ':emoji:',
    content: [
      {
        type: 'emoji',
        emoji: { url: emojiUrl, alt: ':emoji:' },
      },
    ],
    kind: 'text',
    timestamp: 1,
    authorType: 'normal',
    authorPhotoUrl: AUTHOR_URL,
  };
}

describe('ImageFetchManager terminal lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    PendingImage.instances.length = 0;
    vi.stubGlobal('Image', PendingImage);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('releases every in-flight tracking collection during destruction', () => {
    const manager = new ImageFetchManager();
    manager.updateConfig(DEFAULT_SETTINGS as OverlaySettings, null);
    manager.prefetchImages(message());
    manager.failedEmojiFetches.set('https://yt3.ggpht.com/failed.png', Date.now());

    expect(manager.emojiFetching).toContain(EMOJI_URL);
    expect(manager.imageLoading).not.toContain(AUTHOR_URL);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const pendingImage = PendingImage.instances[0];
    if (!pendingImage) throw new Error('Expected a pending emoji image');

    manager.loadImage(STICKER_URL, manager.stickerCache);
    const cachedImage = PendingImage.instances.at(-1);
    if (!cachedImage?.onload) throw new Error('Expected a pending sticker image');
    cachedImage.onload();
    expect(manager.stickerCache.has(STICKER_URL)).toBe(true);

    manager.destroy();

    expect(manager.emojiFetching.size).toBe(0);
    expect(manager.emojiFetchingStarted.size).toBe(0);
    expect(manager.failedEmojiFetches.size).toBe(0);
    expect(manager.imageLoading.size).toBe(0);
    expect(manager.emojiCache.size).toBe(0);
    expect(manager.authorPhotoCache.size).toBe(0);
    expect(manager.stickerCache.size).toBe(0);
    expect(pendingImage.src).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not restart timers or image requests after destruction', () => {
    const manager = new ImageFetchManager();
    manager.destroy();

    manager.updateConfig(DEFAULT_SETTINGS as OverlaySettings, null);
    manager.prefetchImages(message());
    manager.loadImage(AUTHOR_URL, manager.authorPhotoCache);

    expect(PendingImage.instances).toHaveLength(0);
    expect(manager.emojiFetching.size).toBe(0);
    expect(manager.imageLoading.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares one global in-flight cap across emoji, author, and sticker loads', () => {
    const manager = new ImageFetchManager();
    manager.updateConfig({ ...DEFAULT_SETTINGS, emojiFetchLimit: 3 } as OverlaySettings, null);

    for (let index = 0; index < 10; index++) {
      manager.prefetchImages({
        ...message(),
        content: [],
        author: `author ${index}`,
        kind: 'superchat',
        authorPhotoUrl: `https://yt3.ggpht.com/author-${index}.png`,
        superChat: {
          amount: '$1',
          tier: 'blue',
          sticker: {
            alt: 'sticker',
            url: `https://yt3.ggpht.com/sticker-${index}.png`,
          },
        },
      });
    }

    expect(PendingImage.instances).toHaveLength(3);
    expect(manager.imageLoading.size).toBe(3);
    manager.destroy();
  });

  it('loads only author photos visible under the renderer card policy', () => {
    const manager = new ImageFetchManager();
    manager.updateConfig(DEFAULT_SETTINGS as OverlaySettings, null);

    manager.prefetchImages({ ...message(), author: 'hidden normal' });
    expect(manager.imageLoading).not.toContain(AUTHOR_URL);
    expect(PendingImage.instances).toHaveLength(1);
    PendingImage.instances[0]?.onload?.();

    manager.prefetchImages({
      ...message(),
      id: 'visible-superchat',
      author: 'paid author',
      kind: 'superchat',
      content: [],
      superChat: { amount: '$5', tier: 'blue' },
    });

    expect(manager.imageLoading).toContain(AUTHOR_URL);
    expect(PendingImage.instances).toHaveLength(2);
    expect(PendingImage.instances[1]?.src).toBe(AUTHOR_URL);
    manager.destroy();
  });

  it('does not create main-thread image work while the Worker owns rendering', () => {
    const manager = new ImageFetchManager();
    manager.updateConfig(DEFAULT_SETTINGS as OverlaySettings, {} as Worker);

    manager.prefetchImages({
      ...message(),
      author: 'paid author',
      kind: 'superchat',
      superChat: { amount: '$5', tier: 'blue', sticker: { url: STICKER_URL, alt: 'sticker' } },
    });
    manager.loadImage(AUTHOR_URL, manager.authorPhotoCache);

    expect(PendingImage.instances).toHaveLength(0);
    expect(manager.emojiFetching.size).toBe(0);
    expect(manager.imageLoading.size).toBe(0);
    manager.destroy();
  });

  it('follows hidden-shown-hidden author policy for regular and SuperChat cards', () => {
    const manager = new ImageFetchManager();
    const regularUrl = 'https://yt3.ggpht.com/regular-toggle.png';
    const paidUrl = 'https://yt3.ggpht.com/paid-toggle.png';
    const regular = { ...message(), content: [], author: 'regular', authorPhotoUrl: regularUrl };
    const paid: ChatMessage = {
      ...message(),
      content: [],
      author: 'paid',
      authorPhotoUrl: paidUrl,
      kind: 'superchat',
      superChat: { amount: '$5', tier: 'blue' },
    };

    manager.updateConfig(
      {
        ...DEFAULT_SETTINGS,
        showAuthor: { ...DEFAULT_SETTINGS.showAuthor, normal: false, superChat: false },
      } as OverlaySettings,
      null
    );
    manager.prefetchImages(regular);
    manager.prefetchImages(paid);
    expect(PendingImage.instances).toHaveLength(0);

    manager.updateConfig(
      {
        ...DEFAULT_SETTINGS,
        showAuthor: { ...DEFAULT_SETTINGS.showAuthor, normal: true, superChat: true },
      } as OverlaySettings,
      null
    );
    manager.prefetchImages(regular);
    manager.prefetchImages(paid);
    expect(PendingImage.instances.map((image) => image.src)).toEqual([regularUrl, paidUrl]);

    manager.updateConfig(
      {
        ...DEFAULT_SETTINGS,
        showAuthor: { ...DEFAULT_SETTINGS.showAuthor, normal: false, superChat: false },
      } as OverlaySettings,
      null
    );
    manager.prefetchImages({ ...regular, authorPhotoUrl: `${regularUrl}?hidden-again` });
    manager.prefetchImages({ ...paid, authorPhotoUrl: `${paidUrl}?hidden-again` });
    expect(PendingImage.instances).toHaveLength(2);
    manager.destroy();
  });

  it('keeps cleanup paused across config updates and restarts it once on resume', () => {
    const manager = new ImageFetchManager();
    manager.updateConfig(DEFAULT_SETTINGS as OverlaySettings, null);
    expect(vi.getTimerCount()).toBe(1);

    manager.pause();
    expect(vi.getTimerCount()).toBe(0);

    manager.updateConfig(
      { ...DEFAULT_SETTINGS, failedEmojiRetryMins: 10 } as OverlaySettings,
      null
    );
    expect(vi.getTimerCount()).toBe(0);

    manager.resume();
    manager.resume();
    expect(vi.getTimerCount()).toBe(1);

    manager.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retires an emoji only on the first five-second sweep after its strict timeout', () => {
    const manager = new ImageFetchManager();
    manager.updateConfig(
      { ...DEFAULT_SETTINGS, emojiFetchTimeoutMs: 10_000, emojiFetchLimit: 1 } as OverlaySettings,
      null
    );
    const ready = vi.fn();
    manager.setOnImageReady(ready);
    manager.prefetchImages(message());
    const stalled = PendingImage.instances[0];
    if (!stalled) throw new Error('Expected a stalled emoji image');

    vi.advanceTimersByTime(9_999);
    expect(manager.emojiFetching.has(EMOJI_URL)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(manager.emojiFetching.has(EMOJI_URL)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(manager.emojiFetching.has(EMOJI_URL)).toBe(true);
    manager.prefetchImages(message('https://yt3.ggpht.com/blocked-by-stall.png'));
    expect(PendingImage.instances).toHaveLength(1);

    vi.advanceTimersByTime(4_999);
    expect(manager.emojiFetching.has(EMOJI_URL)).toBe(false);
    expect(manager.emojiFetchingStarted.has(EMOJI_URL)).toBe(false);
    expect(stalled.src).toBe('');
    expect(stalled.onload).toBeNull();
    expect(stalled.onerror).toBeNull();
    expect(ready).not.toHaveBeenCalled();

    manager.prefetchImages(message());
    const restored = PendingImage.instances[1];
    if (!restored) throw new Error('Expected restored emoji request');
    restored.onload?.();
    expect(manager.emojiCache.get(EMOJI_URL)).toBe(restored);
    expect(ready).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledWith(EMOJI_URL, 'emoji');
    manager.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires author and sticker loads on their own exact deadlines and frees the shared cap', () => {
    const manager = new ImageFetchManager();
    manager.updateConfig(
      { ...DEFAULT_SETTINGS, emojiFetchTimeoutMs: 10_000, emojiFetchLimit: 2 } as OverlaySettings,
      null
    );
    manager.loadImage(AUTHOR_URL, manager.authorPhotoCache);
    const author = PendingImage.instances[0];
    if (!author) throw new Error('Expected pending author image');
    vi.advanceTimersByTime(5_000);
    manager.loadImage(STICKER_URL, manager.stickerCache);
    const sticker = PendingImage.instances[1];
    if (!sticker) throw new Error('Expected pending sticker image');
    expect(manager.imageLoading.size).toBe(2);
    manager.prefetchImages(message());
    expect(PendingImage.instances).toHaveLength(2);

    vi.advanceTimersByTime(4_999);
    expect(author.src).toBe(AUTHOR_URL);
    expect(sticker.src).toBe(STICKER_URL);
    vi.advanceTimersByTime(1);
    expect(author.src).toBe('');
    expect(author.onload).toBeNull();
    expect(author.onerror).toBeNull();
    expect(manager.imageLoading.has(AUTHOR_URL)).toBe(false);
    expect(manager.imageLoading.has(STICKER_URL)).toBe(true);
    expect(vi.getTimerCount()).toBe(2); // Sticker timeout plus emoji sweep.

    manager.prefetchImages(message());
    const emoji = PendingImage.instances[2];
    if (!emoji) throw new Error('Expected emoji after author slot retirement');
    emoji.onload?.();
    expect(manager.emojiCache.get(EMOJI_URL)).toBe(emoji);
    vi.advanceTimersByTime(4_999);
    expect(sticker.src).toBe(STICKER_URL);
    vi.advanceTimersByTime(1);
    expect(sticker.src).toBe('');
    expect(sticker.onload).toBeNull();
    expect(sticker.onerror).toBeNull();
    expect(manager.imageLoading.size).toBe(0);
    expect(manager.failedEmojiFetches.size).toBe(0);

    manager.loadImage(AUTHOR_URL, manager.authorPhotoCache);
    manager.loadImage(STICKER_URL, manager.stickerCache);
    const restoredAuthor = PendingImage.instances[3];
    const restoredSticker = PendingImage.instances[4];
    if (!restoredAuthor || !restoredSticker) throw new Error('Expected restored paid assets');
    restoredAuthor.onload?.();
    restoredSticker.onload?.();
    expect(manager.authorPhotoCache.get(AUTHOR_URL)).toBe(restoredAuthor);
    expect(manager.stickerCache.get(STICKER_URL)).toBe(restoredSticker);
    manager.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains emoji failure through the retry cutoff and accepts it just after a config change', () => {
    const manager = new ImageFetchManager();
    manager.updateConfig({ ...DEFAULT_SETTINGS, failedEmojiRetryMins: 2 } as OverlaySettings, null);
    manager.prefetchImages(message());
    const failed = PendingImage.instances[0];
    if (!failed) throw new Error('Expected emoji request to fail');
    failed.onerror?.();
    expect(manager.failedEmojiFetches.has(EMOJI_URL)).toBe(true);
    expect(manager.emojiFetching.size).toBe(0);

    vi.advanceTimersByTime(59_999);
    manager.updateConfig({ ...DEFAULT_SETTINGS, failedEmojiRetryMins: 1 } as OverlaySettings, null);
    manager.cleanupStaleEmojiFetching();
    expect(manager.failedEmojiFetches.has(EMOJI_URL)).toBe(true);
    manager.prefetchImages(message());
    expect(PendingImage.instances).toHaveLength(1);

    vi.advanceTimersByTime(1);
    manager.cleanupStaleEmojiFetching();
    expect(manager.failedEmojiFetches.has(EMOJI_URL)).toBe(true);
    vi.advanceTimersByTime(1);
    manager.cleanupStaleEmojiFetching();
    expect(manager.failedEmojiFetches.has(EMOJI_URL)).toBe(false);

    manager.prefetchImages(message());
    const restored = PendingImage.instances[1];
    if (!restored) throw new Error('Expected emoji retry after TTL');
    restored.onload?.();
    expect(manager.emojiCache.get(EMOJI_URL)).toBe(restored);
    manager.destroy();
  });

  it('evicts the least recently used 250 entries on the 501st emoji failure', () => {
    const manager = new ImageFetchManager();
    manager.updateConfig(DEFAULT_SETTINGS as OverlaySettings, null);
    const urlAt = (index: number) => `https://yt3.ggpht.com/failed-${index}.png`;
    for (let index = 0; index < 500; index++) {
      manager.prefetchImages(message(urlAt(index)));
      PendingImage.instances[index]?.onerror?.();
    }
    expect(manager.failedEmojiFetches.size).toBe(500);
    manager.prefetchImages(message(urlAt(0))); // A failed lookup refreshes LRU recency.
    expect(PendingImage.instances).toHaveLength(500);

    manager.prefetchImages(message(urlAt(500)));
    PendingImage.instances[500]?.onerror?.();
    expect(manager.failedEmojiFetches.size).toBe(251);
    expect(manager.failedEmojiFetches.has(urlAt(0))).toBe(true);
    expect(manager.failedEmojiFetches.has(urlAt(1))).toBe(false);
    expect(manager.failedEmojiFetches.has(urlAt(250))).toBe(false);
    expect(manager.failedEmojiFetches.has(urlAt(251))).toBe(true);
    expect(manager.failedEmojiFetches.has(urlAt(500))).toBe(true);

    manager.prefetchImages(message(urlAt(1)));
    const restored = PendingImage.instances[501];
    if (!restored) throw new Error('Expected retry for evicted failed URL');
    restored.onload?.();
    expect(manager.emojiCache.get(urlAt(1))).toBe(restored);
    manager.destroy();
  });

  it('keeps emoji sweep paused while independent author timeout runs, then resumes once', () => {
    const manager = new ImageFetchManager();
    manager.updateConfig(
      { ...DEFAULT_SETTINGS, emojiFetchTimeoutMs: 10_000 } as OverlaySettings,
      null
    );
    manager.prefetchImages(message());
    manager.loadImage(AUTHOR_URL, manager.authorPhotoCache);
    const emoji = PendingImage.instances[0];
    const author = PendingImage.instances[1];
    if (!emoji || !author) throw new Error('Expected both pending image types');
    expect(vi.getTimerCount()).toBe(2);

    manager.pause();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10_001);
    expect(author.src).toBe('');
    expect(manager.imageLoading.size).toBe(0);
    expect(emoji.src).toBe(EMOJI_URL);
    expect(manager.emojiFetching.has(EMOJI_URL)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    manager.resume();
    manager.resume();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(4_999);
    expect(manager.emojiFetching.has(EMOJI_URL)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(emoji.src).toBe('');
    expect(manager.emojiFetching.has(EMOJI_URL)).toBe(false);
    manager.prefetchImages(message());
    PendingImage.instances[2]?.onload?.();
    expect(manager.emojiCache.has(EMOJI_URL)).toBe(true);
    manager.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores saved late load/error callbacks after destruction and a fresh manager recovers', () => {
    const retired = new ImageFetchManager();
    retired.updateConfig(DEFAULT_SETTINGS as OverlaySettings, null);
    const retiredReady = vi.fn();
    retired.setOnImageReady(retiredReady);
    retired.prefetchImages(message());
    retired.loadImage(AUTHOR_URL, retired.authorPhotoCache);
    const oldEmoji = PendingImage.instances[0];
    const oldAuthor = PendingImage.instances[1];
    if (!oldEmoji || !oldAuthor) throw new Error('Expected retiring image requests');
    const lateEmojiLoad = oldEmoji.onload;
    const lateEmojiError = oldEmoji.onerror;
    const lateAuthorLoad = oldAuthor.onload;
    const lateAuthorError = oldAuthor.onerror;

    retired.destroy();
    lateEmojiLoad?.();
    lateEmojiError?.();
    lateAuthorLoad?.();
    lateAuthorError?.();
    expect(retiredReady).not.toHaveBeenCalled();
    expect(retired.emojiCache.size).toBe(0);
    expect(retired.authorPhotoCache.size).toBe(0);
    expect(retired.failedEmojiFetches.size).toBe(0);
    expect(retired.emojiFetching.size).toBe(0);
    expect(retired.imageLoading.size).toBe(0);
    expect(oldEmoji.src).toBe('');
    expect(oldAuthor.src).toBe('');

    const fresh = new ImageFetchManager();
    fresh.updateConfig(DEFAULT_SETTINGS as OverlaySettings, null);
    const freshReady = vi.fn();
    fresh.setOnImageReady(freshReady);
    fresh.prefetchImages(message());
    fresh.loadImage(AUTHOR_URL, fresh.authorPhotoCache);
    const newEmoji = PendingImage.instances[2];
    const newAuthor = PendingImage.instances[3];
    if (!newEmoji || !newAuthor) throw new Error('Expected fresh image requests');
    newEmoji.onload?.();
    newAuthor.onload?.();
    expect(fresh.emojiCache.get(EMOJI_URL)).toBe(newEmoji);
    expect(fresh.authorPhotoCache.get(AUTHOR_URL)).toBe(newAuthor);
    expect(freshReady).toHaveBeenCalledOnce();
    expect(freshReady).toHaveBeenCalledWith(EMOJI_URL, 'emoji');
    fresh.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caches a standard 512px sticker and its URL at the minimum configured budget', () => {
    const manager = new ImageFetchManager();
    manager.updateConfig({ ...DEFAULT_SETTINGS, stickerCacheMb: 1 } as OverlaySettings, null);

    manager.loadImage(STICKER_URL, manager.stickerCache);
    const image = PendingImage.instances[0];
    if (!image) throw new Error('Expected pending sticker image');
    image.naturalWidth = 512;
    image.naturalHeight = 512;
    image.onload?.();

    expect(manager.stickerCache.has(STICKER_URL)).toBe(true);
    manager.loadImage(STICKER_URL, manager.stickerCache);
    expect(PendingImage.instances).toHaveLength(1);
    manager.destroy();
  });

  it('does not repeatedly fetch emoji that cannot fit the emoji cache', () => {
    const manager = new ImageFetchManager();
    manager.updateConfig({ ...DEFAULT_SETTINGS, emojiCacheMb: 1 } as OverlaySettings, null);
    const emojiMessage = message();
    delete emojiMessage.authorPhotoUrl;

    manager.prefetchImages(emojiMessage);
    const image = PendingImage.instances[0];
    if (!image) throw new Error('Expected pending emoji image');
    image.naturalWidth = 1000;
    image.naturalHeight = 1000;
    image.onload?.();
    manager.prefetchImages(emojiMessage);

    expect(PendingImage.instances).toHaveLength(1);
    manager.destroy();
  });

  it('scopes uncacheable URLs to the cache that rejected them', () => {
    const manager = new ImageFetchManager();
    manager.updateConfig(
      { ...DEFAULT_SETTINGS, photoCacheMb: 10, stickerCacheMb: 1 } as OverlaySettings,
      null
    );

    manager.loadImage(STICKER_URL, manager.stickerCache);
    const sticker = PendingImage.instances[0];
    if (!sticker) throw new Error('Expected pending sticker image');
    sticker.naturalWidth = 600;
    sticker.naturalHeight = 600;
    sticker.onload?.();

    manager.loadImage(STICKER_URL, manager.authorPhotoCache);
    const authorPhoto = PendingImage.instances[1];
    if (!authorPhoto) throw new Error('Expected pending author image');
    authorPhoto.naturalWidth = 600;
    authorPhoto.naturalHeight = 600;
    authorPhoto.onload?.();

    expect(manager.authorPhotoCache.has(STICKER_URL)).toBe(true);
    manager.destroy();
  });

  it('retries a rejected image after its cache capacity changes', () => {
    const manager = new ImageFetchManager();
    manager.updateConfig({ ...DEFAULT_SETTINGS, stickerCacheMb: 1 } as OverlaySettings, null);

    manager.loadImage(STICKER_URL, manager.stickerCache);
    const first = PendingImage.instances[0];
    if (!first) throw new Error('Expected pending sticker image');
    first.naturalWidth = 600;
    first.naturalHeight = 600;
    first.onload?.();

    manager.updateConfig({ ...DEFAULT_SETTINGS, stickerCacheMb: 2 } as OverlaySettings, null);
    manager.loadImage(STICKER_URL, manager.stickerCache);
    const second = PendingImage.instances[1];
    if (!second) throw new Error('Expected retried sticker image');
    second.naturalWidth = 600;
    second.naturalHeight = 600;
    second.onload?.();

    expect(manager.stickerCache.has(STICKER_URL)).toBe(true);
    manager.destroy();
  });

  it('releases cache references without clearing retained HTMLImageElement sources', () => {
    const manager = new ImageFetchManager();
    manager.updateConfig({ ...DEFAULT_SETTINGS, stickerCacheMb: 2 } as OverlaySettings, null);
    manager.loadImage(STICKER_URL, manager.stickerCache);
    const image = PendingImage.instances[0];
    if (!image) throw new Error('Expected pending sticker image');
    image.naturalWidth = 600;
    image.naturalHeight = 600;
    image.onload?.();

    manager.updateConfig({ ...DEFAULT_SETTINGS, stickerCacheMb: 1 } as OverlaySettings, null);
    expect(manager.stickerCache.has(STICKER_URL)).toBe(false);
    manager.destroy();

    expect(manager.stickerCache.size).toBe(0);
    expect(image.src).toBe(STICKER_URL);
  });
});
