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
    expect(manager.imageLoading).toContain(AUTHOR_URL);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    manager.destroy();

    expect(manager.emojiFetching.size).toBe(0);
    expect(manager.emojiFetchingStarted.size).toBe(0);
    expect(manager.failedEmojiFetches.size).toBe(0);
    expect(manager.imageLoading.size).toBe(0);
    expect(manager.emojiCache.size).toBe(0);
    expect(manager.authorPhotoCache.size).toBe(0);
    expect(manager.stickerCache.size).toBe(0);
    expect(PendingImage.instances.every((image) => image.src === '')).toBe(true);
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
});
