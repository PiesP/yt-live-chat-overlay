// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage, OverlaySettings } from '@app-types';
import { ImageFetchManager } from '@media/image-fetch-manager';
import { DEFAULT_SETTINGS } from '@settings/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function message(): ChatMessage {
  return {
    text: ':emoji:',
    content: [
      {
        type: 'emoji',
        emoji: { url: EMOJI_URL, alt: ':emoji:' },
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
      ...message(), content: [], author: 'paid', authorPhotoUrl: paidUrl,
      kind: 'superchat', superChat: { amount: '$5', tier: 'blue' },
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

});
