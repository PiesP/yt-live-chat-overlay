// SPDX-License-Identifier: MIT

import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vite-plus/test';

import {
  assessPublicImage,
  assessPublicResize,
  installPublicImageDrawProbe,
  isPublicImageUrl,
  readSurvivingPublicImageDraws,
  selectPublicSeekTarget,
} from '../../../validation/windows/live-rendering.ts';

describe('shared public-media seek calculation', () => {
  it.each([
    { name: 'forward motion', range: { currentTime: 10, start: 0, end: 100 }, expected: 13 },
    {
      name: 'near-end backward fallback',
      range: { currentTime: 99, start: 0, end: 100 },
      expected: 96,
    },
    {
      name: 'backward preference',
      range: { currentTime: 97, start: 0, end: 100 },
      preferBackward: true,
      expected: 94,
    },
    { name: 'near-end forward', range: { currentTime: 97, start: 0, end: 100 }, expected: 99 },
    {
      name: 'backward preference at start falls forward',
      range: { currentTime: 1.5, start: 0, end: 100 },
      preferBackward: true,
      expected: 4.5,
    },
    { name: 'short window', range: { currentTime: 10, start: 8, end: 11 }, expected: null },
    {
      name: 'non-finite current time',
      range: { currentTime: NaN, start: 0, end: 100 },
      expected: null,
    },
    {
      name: 'non-finite boundary',
      range: { currentTime: 10, start: 0, end: Infinity },
      expected: null,
    },
    { name: 'no valid target', range: { currentTime: 30, start: 30, end: 32 }, expected: null },
  ])('handles $name', ({ range, preferBackward, expected }) => {
    expect(
      selectPublicSeekTarget(range, preferBackward === undefined ? {} : { preferBackward })
    ).toBe(expected);
  });
});

describe('installed public rendering observations', () => {
  const before = {
    width: 1280,
    height: 720,
    active: 3,
    dropped: 2,
    visiblePixels: 16,
  };
  const after = { ...before, width: 1600, height: 900 };

  it('requires changed backing geometry and still-visible paused comments', () => {
    expect(assessPublicResize(before, after)).toBeNull();
    expect(assessPublicResize(null, after)).toBe('canvas-or-debug-unavailable');
    expect(assessPublicResize({ ...before, active: 0 }, after)).toBe('visible-message-unavailable');
    expect(assessPublicResize(before, { ...after, width: 1280, height: 720 })).toBe(
      'canvas-size-unchanged'
    );
    expect(assessPublicResize(before, { ...after, active: 2 })).toBe('active-message-lost');
    expect(assessPublicResize(before, { ...after, dropped: 3 })).toBeNull();
    expect(assessPublicResize(before, { ...after, visiblePixels: 0 })).toBe(
      'visible-canvas-ink-lost'
    );
    expect(assessPublicResize(before, { ...after, dropped: NaN })).toBe('canvas-or-debug-invalid');
  });

  it('accepts only a visible CDN image draw with a matching successful image response', () => {
    const draw = {
      url: 'https://yt3.ggpht.com/public-avatar=s88',
      sourceType: 'derived-canvas' as const,
      naturalWidth: 48,
      naturalHeight: 48,
      pixelAlpha: 255,
      pixelX: 24,
      pixelY: 24,
      pixelRgba: [80, 90, 100, 255] as [number, number, number, number],
    };
    const response = { url: draw.url, status: 200, contentType: 'image/webp' };
    expect(assessPublicImage([draw], [response])).toEqual({
      status: 'passed',
      draw,
      response,
    });
    expect(assessPublicImage([], [response])).toEqual({
      status: 'unverified',
      reason: 'public-image-draw-unverified',
    });
    for (const invalid of [
      { draw: { ...draw, url: 'https://yt3.ggpht.com.evil.test/avatar' }, response },
      { draw: { ...draw, pixelAlpha: 0 }, response },
      { draw: { ...draw, pixelX: -1 }, response },
      { draw: { ...draw, pixelRgba: [80, 90, 100, 0] as typeof draw.pixelRgba }, response },
    ]) {
      expect(assessPublicImage([invalid.draw], [invalid.response])).toEqual({
        status: 'unverified',
        reason: 'public-image-draw-unverified',
      });
    }
    for (const invalid of [
      { draw, response: { ...response, status: 403 } },
      { draw, response: { ...response, contentType: 'text/html' } },
      { draw, response: { ...response, url: 'https://yt3.ggpht.com/other-avatar' } },
    ]) {
      expect(assessPublicImage([invalid.draw], [invalid.response])).toEqual({
        status: 'unverified',
        reason: 'public-image-response-unverified',
      });
    }
    expect(isPublicImageUrl('http://yt3.ggpht.com/avatar')).toBe(false);
    expect(isPublicImageUrl('https://yt3.ggpht.com.evil.test/avatar')).toBe(false);
    expect(isPublicImageUrl(draw.url)).toBe(true);
  });

  it('requires changed image pixels and rejects no-op, transparent, clipped and overpainted draws', () => {
    class Image {
      currentSrc = 'https://yt3.ggpht.com/public-avatar=s88';
      src = this.currentSrc;
      naturalWidth = 48;
      naturalHeight = 48;
    }
    class Canvas {
      width = 1280;
      height = 720;
      context: Context | null = null;
      closest() {
        return {};
      }
      getContext() {
        return this.context;
      }
    }
    class OffscreenContext {
      canvas = { width: 48, height: 48 };
      drawImage(..._args: unknown[]) {}
    }
    class Context {
      canvas = new Canvas();
      mode: 'none' | 'transparent' | 'paint' = 'none';
      pixels = new Map<string, [number, number, number, number]>();
      constructor() {
        this.canvas.context = this;
      }
      drawImage(_image: unknown, x: number, y: number, width: number, height: number) {
        if (this.mode !== 'paint') return;
        const pixelX = Math.floor(x + width / 2);
        const pixelY = Math.floor(y + height / 2);
        if (pixelX >= 0 && pixelY >= 0 && pixelX < this.canvas.width && pixelY < this.canvas.height)
          this.pixels.set(`${pixelX},${pixelY}`, [80, 90, 100, 255]);
      }
      getTransform() {
        return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
      }
      getImageData(x: number, y: number) {
        return { data: this.pixels.get(`${x},${y}`) ?? [10, 20, 30, 255] };
      }
    }
    const probeWindow: Record<string, unknown> = {};
    const context = new Context();
    const realm = {
      window: probeWindow,
      WeakMap,
      HTMLImageElement: Image,
      HTMLCanvasElement: Canvas,
      OffscreenCanvasRenderingContext2D: OffscreenContext,
      CanvasRenderingContext2D: Context,
      document: { querySelector: () => context.canvas },
      Number,
      Math,
    };
    runInNewContext('(' + installPublicImageDrawProbe.toString() + ')()', realm);
    const readSurvivors = () =>
      runInNewContext('(' + readSurvivingPublicImageDraws.toString() + ')()', realm);
    const image = new Image();
    context.drawImage(image, 0, 0, 48, 48);
    expect(probeWindow.__ytPublicImageDraws).toEqual([]);
    context.mode = 'transparent';
    context.drawImage(image, 0, 0, 48, 48);
    expect(probeWindow.__ytPublicImageDraws).toEqual([]);
    context.mode = 'paint';
    context.drawImage(image, 1300, 0, 48, 48);
    expect(probeWindow.__ytPublicImageDraws).toEqual([]);
    const offscreen = new OffscreenContext();
    offscreen.drawImage(image, 0, 0, 48, 48);
    context.drawImage(offscreen.canvas, 0, 0, 48, 48);
    expect(readSurvivors()).toHaveLength(1);
    context.pixels.set('24,24', [10, 20, 30, 255]);
    expect(readSurvivors()).toHaveLength(0);
    const direct = new Image();
    direct.currentSrc = 'https://yt3.ggpht.com/direct-avatar=s88';
    context.drawImage(direct, 48, 0, 48, 48);
    expect(probeWindow.__ytPublicImageDraws).toEqual([
      {
        url: image.src,
        sourceType: 'derived-canvas',
        naturalWidth: 48,
        naturalHeight: 48,
        pixelAlpha: 255,
        pixelX: 24,
        pixelY: 24,
        pixelRgba: [80, 90, 100, 255],
      },
      {
        url: direct.currentSrc,
        sourceType: 'image',
        naturalWidth: 48,
        naturalHeight: 48,
        pixelAlpha: 255,
        pixelX: 72,
        pixelY: 24,
        pixelRgba: [80, 90, 100, 255],
      },
    ]);
    expect(readSurvivors()).toHaveLength(1);
  });
});
