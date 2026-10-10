// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasRenderingContext2D, createCanvas } from 'canvas';
import type { ChatMessage } from '@app-types';
import { renderRegularMessage, renderSegment, type AnyCanvasContext, type TextBitmapCache } from '@renderer/canvas/shared';
import { LaneAllocator } from '@renderer/layout/lane-allocator';
import { estimateMessageDimensions } from '@renderer/shared';
import { clearTextMeasurementCaches, getFontString, measureTextTopBounds } from '@renderer/text-measure';

const message = (text: string): ChatMessage => ({ text, content: [{ type: 'text', content: text }], kind: 'text', authorType: 'normal', timestamp: 0 });
const fontSize = 32;
const family = 'sans-serif';
const dimensions = { width: 800, height: 1080 };
const noImages = { get: (): null => null };
const noBitmap: TextBitmapCache = { maxBytes: 0, get: () => undefined, set: () => false };

function estimate(text: string, outline: number, background = '#00000000') {
  return estimateMessageDimensions(message(text), fontSize, false, 'bold', family, undefined, undefined, '0px', outline, undefined, undefined, background);
}
function allocator(gap: number, density: number, outline: number) {
  const result = new LaneAllocator({ safeTop: 0, safeBottom: 0, fontSize, fontWeight: 'bold', fontFamily: family, laneSpacing: gap, outlineWidthPx: outline, headwayGapRatio: 0.08, exitPaddingPx: 100, scrollDurationMaxMs: 30000, laneDensityFactor: density });
  result.reset(dimensions, 0);
  return result;
}
function paint(ctx: AnyCanvasContext, text: string, y: number, outline: number, background = '#00000000') {
  const measured = estimate(text, outline, background);
  renderRegularMessage(ctx, message(text), 10, y, { showAuthor: false, fontSize, fontWeight: 'bold', fontFamily: family, color: '#ffffff', outlineWidthPx: outline, outlineOpacity: 1, backgroundColor: background, messageWidth: measured.width, messageHeight: measured.height }, noBitmap, noImages, () => false, noImages, () => false, (size) => getFontString(size, 'bold', family), () => 0);
  return measured;
}
function inkBounds(canvas: ReturnType<typeof createCanvas>): [number, number] {
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let top = canvas.height;
  let bottom = -1;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (pixels[(y * canvas.width + x) * 4 + 3]) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
    }
  }
  return [top, bottom];
}
beforeEach(() => clearTextMeasurementCaches());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); clearTextMeasurementCaches(); });

describe('complete ordinary row geometry', () => {
  it('fits the original 32px controlled text counterexample in one compact row', () => {
    vi.spyOn(CanvasRenderingContext2D.prototype, 'measureText').mockReturnValue({ width: 150, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 32 } as TextMetrics);
    const measured = estimate('コメント', 0);
    const lanes = allocator(0, 1, 0);
    const placement = lanes.findPlacement(measured.height, dimensions, undefined, 0, 'top');
    expect(measured.height).toBe(34);
    expect(lanes.getLaneHeight()).toBe(34);
    expect(placement?.slotCount).toBe(1);
    const canvas = createCanvas(800, 200);
    const ctx = canvas.getContext('2d');
    const drawn = vi.spyOn(ctx, 'fillText');
    paint(ctx as unknown as AnyCanvasContext, 'コメント', placement?.laneY ?? -100, 0);
    expect(drawn).toHaveBeenCalledWith('コメント', 22, 1);
  });

  it.each([1, 0.75, 0.5])('has nondecreasing actual adjacent pitch over every supported gap at density %s', (density) => {
    for (const outline of [0, 2, 6]) {
      let previousPitch = 0;
      for (let gap = 0; gap <= 20; gap++) {
        const text = '日本語のコメント';
        const measured = estimate(text, outline);
        const lanes = allocator(gap, density, outline);
        const first = lanes.findPlacement(measured.height, dimensions, undefined, 0, 'top');
        expect(first).not.toBeNull();
        if (!first) throw new Error('first row missing');
        lanes.commitPlacement(first, 0, 5000);
        const second = lanes.findPlacement(measured.height, dimensions, undefined, 0, 'top');
        if (!second) throw new Error('second row missing');
        const y1 = first.laneY + first.verticalOffset;
        const y2 = second.laneY + second.verticalOffset;
        expect(y2 - y1).toBeCloseTo(measured.height + gap, 6);
        expect(y2 - y1).toBeGreaterThanOrEqual(previousPitch);
        expect(first.slotCount).toBe(density === 1 ? 1 : density === 0.75 ? 2 : 4);
        expect(first.verticalOffset).toBe(0);
        const canvas = createCanvas(800, 200);
        const ctx = canvas.getContext('2d');
        const drawn = vi.spyOn(ctx, 'fillText');
        paint(ctx as unknown as AnyCanvasContext, text, y1, outline);
        paint(ctx as unknown as AnyCanvasContext, text, y2, outline);
        const starts = drawn.mock.calls.map((call) => call[2]);
        expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeCloseTo(y2 - y1, 6);
        previousPitch = y2 - y1;
      }
    }
  });

  it.each(['日本語のコメント', '한국어 댓글', 'Latin gj Á', 'a\u0301\u0308\u030d\u0302\u0304\u0305', '👩🏽‍🚀'])('contains actual %s ink and outlines', (text) => {
    for (const outline of [0, 2, 6]) {
      const canvas = createCanvas(800, 200);
      const y = 20;
      const measured = paint(canvas.getContext('2d') as unknown as AnyCanvasContext, text, y, outline);
      const [top, bottom] = inkBounds(canvas);
      expect(bottom).toBeGreaterThan(top);
      expect(top).toBeGreaterThanOrEqual(y);
      expect(bottom).toBeLessThan(y + measured.height);
    }
  });

  it('keeps visible card padding and measures tall emoji/author content separately', () => {
    const plain = estimate('コメント', 0);
    expect(estimate('コメント', 0, '#00000040').height).toBeGreaterThan(plain.height);
    const withPhoto = { ...message('コメント'), author: '漢字 이름 Á', authorPhotoUrl: 'https://yt3.ggpht.com/test' };
    const authored = estimateMessageDimensions(withPhoto, 32, true, 'bold', family);
    expect(authored.height).toBeGreaterThan(plain.height);
    expect(allocator(0, 1, 0).findPlacement(authored.height, dimensions)?.slotCount).toBeGreaterThan(1);
  });

  it('keeps a ready emoji inside a row with tall combining text', () => {
    const canvas = createCanvas(800, 250);
    const emoji = createCanvas(40, 40);
    emoji.getContext('2d').fillRect(0, 0, 40, 40);
    const text = 'a\u0301\u0308\u030d\u0302\u0304\u0305';
    const mixed: ChatMessage = { ...message(text), content: [
      { type: 'text', content: text },
      { type: 'emoji', emoji: { url: 'https://yt3.ggpht.com/emoji', alt: '🙂', fallbackText: '🙂' } },
    ] };
    const measured = estimateMessageDimensions(mixed, 32, false, 'bold', family);
    const ctx = canvas.getContext('2d');
    const imageDraw = vi.spyOn(ctx, 'drawImage');
    const emojiCache = { get: () => emoji as unknown as CanvasImageSource };
    renderRegularMessage(ctx as unknown as AnyCanvasContext, mixed, 10, 20,
      { showAuthor: false, fontSize: 32, fontWeight: 'bold', fontFamily: family, color: '#ffffff',
        outlineWidthPx: 0, outlineOpacity: 0, backgroundColor: '#00000000', messageWidth: measured.width, messageHeight: measured.height },
      noBitmap, emojiCache, () => true, noImages, () => false,
      (size) => getFontString(size, 'bold', family), (text) => ctx.measureText(text).width);
    const emojiDraw = imageDraw.mock.calls.find(([source]) => source === emoji);
    expect(emojiDraw).toBeDefined();
    expect(emojiDraw?.[3]).toBeGreaterThan(0);
    expect(emojiDraw?.[4]).toBeGreaterThan(0);
    const [top, bottom] = inkBounds(canvas);
    expect(top).toBeGreaterThanOrEqual(20);
    expect(bottom).toBeLessThan(20 + measured.height);
  });

  it.each([14, 50].flatMap((size) => [false, true].map((missingMetrics) => ({ size, missingMetrics }))))('estimates, reserves and draws $size px with fallback family and missing metrics=$missingMetrics', ({ size, missingMetrics }) => {
    if (missingMetrics) {
      const original = CanvasRenderingContext2D.prototype.measureText;
      vi.spyOn(CanvasRenderingContext2D.prototype, 'measureText').mockImplementation(function (this: CanvasRenderingContext2D, text: string) {
        const measured = original.call(this, text);
        return { ...measured, width: measured.width, actualBoundingBoxAscent: Number.NaN, actualBoundingBoxDescent: Number.NaN };
      });
    }
    const content = message('日本語 한글 Latin gj');
    const fallbackFamily = 'MissingAcceptanceFont, sans-serif';
    const measured = estimateMessageDimensions(content, size, false, 'bold', fallbackFamily, undefined, undefined, '0px', 8);
    const lanes = new LaneAllocator({ safeTop: 0, safeBottom: 0, fontSize: size, fontWeight: 'bold', fontFamily: fallbackFamily, laneSpacing: 0, outlineWidthPx: 8, headwayGapRatio: 0.08, exitPaddingPx: 100, scrollDurationMaxMs: 30000, laneDensityFactor: 1 });
    lanes.reset(dimensions, 0);
    const placement = lanes.findPlacement(measured.height, dimensions, undefined, 0, 'top');
    if (!placement) throw new Error('boundary font placement missing');
    const canvas = createCanvas(800, 250);
    renderRegularMessage(canvas.getContext('2d') as unknown as AnyCanvasContext, content, 10, placement.laneY + placement.verticalOffset,
      { showAuthor: false, fontSize: size, fontWeight: 'bold', fontFamily: fallbackFamily, color: '#ffffff', outlineWidthPx: 8, outlineOpacity: 1, backgroundColor: '#00000000', messageWidth: measured.width, messageHeight: measured.height },
      noBitmap, noImages, () => false, noImages, () => false,
      (value) => getFontString(value, 'bold', fallbackFamily), () => 0);
    const [top, bottom] = inkBounds(canvas);
    expect(top).toBeGreaterThanOrEqual(placement.laneY + placement.verticalOffset);
    expect(bottom).toBeLessThan(placement.laneY + placement.verticalOffset + measured.height);
  });

  it('caches actual top-origin measurements and restores caller Canvas state', () => {
    const ctx = createCanvas(100, 100).getContext('2d');
    ctx.font = '12px serif'; ctx.textBaseline = 'alphabetic';
    const measure = vi.spyOn(ctx, 'measureText');
    const first = measureTextTopBounds('bold 32px sans-serif', 32, 'a\u0301\u0308\u030d', ctx as unknown as AnyCanvasContext);
    expect(first.above + first.below).toBeGreaterThan(0);
    expect(measureTextTopBounds('bold 32px sans-serif', 32, 'a\u0301\u0308\u030d', ctx as unknown as AnyCanvasContext)).toEqual(first);
    expect(measure).toHaveBeenCalledOnce();
    expect(ctx.font).toBe('12px serif'); expect(ctx.textBaseline).toBe('alphabetic');
  });

  it('uses a finite safe fallback when actual text metrics are absent', () => {
    const ctx = createCanvas(100, 100).getContext('2d');
    vi.spyOn(ctx, 'measureText').mockReturnValue({ width: 100, actualBoundingBoxAscent: Number.NaN, actualBoundingBoxDescent: Number.NaN } as TextMetrics);
    expect(measureTextTopBounds('bold 32px sans-serif', 32, 'fallback', ctx as unknown as AnyCanvasContext)).toEqual({ above: 0, below: 45 });
  });

  it('keeps cached outlined combining-mark pixels identical to direct drawing', () => {
    class NodeOffscreenCanvas {
      constructor(width: number, height: number) { return createCanvas(width, height); }
    }
    vi.stubGlobal('OffscreenCanvas', NodeOffscreenCanvas);
    const bitmaps = new Map<string, CanvasImageSource>();
    const cache: TextBitmapCache = { get: (key) => bitmaps.get(key), set: (key, value) => { bitmaps.set(key, value); return true; } };
    const text = 'a\u0301\u0308\u030d\u0302\u0304\u0305';
    const cached = createCanvas(400, 200); const direct = createCanvas(400, 200);
    for (const [canvas, storage] of [[cached, cache], [direct, noBitmap]] as const) {
      renderSegment(canvas.getContext('2d') as unknown as AnyCanvasContext, text, 20, 40, '#ffffff', 32, 2, 1, storage, (size) => getFontString(size, 'bold', family));
    }
    expect(inkBounds(cached)).toEqual(inkBounds(direct));
    expect(Buffer.from(cached.getContext('2d').getImageData(0, 0, 400, 200).data)).toEqual(Buffer.from(direct.getContext('2d').getImageData(0, 0, 400, 200).data));
  });
});
