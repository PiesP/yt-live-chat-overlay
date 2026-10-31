// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('@renderer/text-measure', () => ({
  getFontString: (fontSize: number): string => `bold ${fontSize}px sans-serif`,
  measureTextHeight: (): number => 20,
  measureTextTopBounds: (
    _font: string,
    _size: number,
    text?: string
  ): { above: number; below: number } =>
    text === 'Á한' ? { above: 7, below: 37 } : { above: 0, below: 20 },
  measureTextWidth: (text: string): number => (text === 'i' ? 4 : text.length * 10),
}));

import {
  type AnyCanvasContext,
  prepareWrappedContent,
  renderWrappedContentSegments,
  type TextBitmapCache,
} from '@renderer/canvas/shared';
import { SUPERCHAT_CARD_CONFIG } from '@renderer/card-config';
import { estimateMessageDimensions } from '@renderer/shared';
import { rendererLayout } from '@util/design-tokens';

function createContext(): CanvasRenderingContext2D {
  return {
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    drawImage: vi.fn(),
    fillText: vi.fn(),
    getTransform: vi.fn(() => ({ a: 1 })),
    measureText: vi.fn((text: string) => ({ width: text.length * 10 }) as TextMetrics),
    restore: vi.fn(),
    save: vi.fn(),
    strokeText: vi.fn(),
    fillStyle: '',
    font: '',
    textBaseline: 'alphabetic',
    textRendering: 'auto',
  } as unknown as CanvasRenderingContext2D;
}

describe('renderWrappedContentSegments', () => {
  it('reserves every loaded image emoji row and contains the last image', () => {
    const ctx = createContext();
    const image = { width: 38, height: 38 } as CanvasImageSource;
    const bottom = renderWrappedContentSegments(
      ctx,
      [1, 2, 3].map((index) => ({ type: 'emoji', emojiUrl: `emoji://${index}` })),
      24,
      20,
      42,
      3,
      '#ffffff',
      32,
      0,
      0,
      { get: () => undefined, set: vi.fn() },
      { get: () => image },
      () => 'bold 32px sans-serif'
    );
    const draws = (ctx.drawImage as ReturnType<typeof vi.fn>).mock.calls;
    expect(draws).toHaveLength(3);
    const imageBottoms = draws.map(([, , y, , height]) => Number(y) + Number(height));
    expect(Number(draws[1]?.[2]) - Number(draws[0]?.[2])).toBeGreaterThanOrEqual(38);
    expect(Number(draws[2]?.[2]) - Number(draws[1]?.[2])).toBeGreaterThanOrEqual(38);
    expect(bottom).toBeGreaterThanOrEqual(imageBottoms.at(-1) ?? Infinity);
  });

  it('reserves failed-image fallback ink across multiline CJK and diacritics', () => {
    const ctx = createContext();
    const bottom = renderWrappedContentSegments(
      ctx,
      [1, 2, 3].map((index) => ({
        type: 'emoji',
        emojiUrl: `emoji://missing-${index}`,
        emojiFallbackText: 'Á한',
      })),
      24,
      20,
      42,
      3,
      '#ffffff',
      32,
      8,
      1,
      { maxBytes: 0, get: () => undefined, set: vi.fn() },
      { get: () => undefined },
      () => 'bold 32px sans-serif'
    );
    const draws = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([text]) => text === 'Á한'
    );
    expect(draws).toHaveLength(3);
    const tops = draws.map(([, , y]) => Number(y) - 7 - 4);
    const bottoms = draws.map(([, , y]) => Number(y) + 37 + 4);
    expect(tops[1]! - tops[0]!).toBeGreaterThanOrEqual(52);
    expect(tops[2]! - tops[1]!).toBeGreaterThanOrEqual(52);
    expect(bottom).toBeGreaterThanOrEqual(bottoms.at(-1) ?? Infinity);
    expect(ctx.drawImage).not.toHaveBeenCalled();
    const segments = [1, 2, 3].map((index) => ({
      type: 'emoji' as const,
      emojiUrl: `emoji://missing-${index}`,
      emojiFallbackText: 'Á한',
    }));
    const prepared = prepareWrappedContent(
      segments,
      42,
      3,
      'bold 32px sans-serif',
      32,
      (text) => text.length * 10,
      ctx,
      8
    );
    expect(prepared.height).toBe(bottom - 20);
    const card = estimateMessageDimensions(
      {
        text: 'Á한Á한Á한',
        content: segments.map((segment) => ({
          type: 'emoji',
          emoji: { url: segment.emojiUrl, alt: '', fallbackText: segment.emojiFallbackText },
        })),
        kind: 'superchat',
        authorType: 'normal',
        timestamp: 0,
        superChat: { amount: '', tier: 'blue' },
      },
      32,
      false,
      'bold',
      'sans-serif',
      { superchat: 3 },
      false,
      '0px',
      8,
      100
    );
    expect(card.height).toBe(
      rendererLayout.superchat.paddingV * 2 + SUPERCHAT_CARD_CONFIG.body.marginTop + prepared.height
    );
  });

  it('keeps separately measured CJK word gaps inside the wrapped line width', () => {
    const ctx = createContext();
    const measureText = (text: string): number => {
      const widths: Readonly<Record<string, number>> = {
        ' ': 4,
        '…': 10,
        후원: 20,
        카드의: 30,
        ' 카드의': 42,
        긴: 10,
        ' 긴': 18,
      };
      return widths[text] ?? text.length * 10;
    };
    const startX = 10;
    const maxWidth = 54;

    renderWrappedContentSegments(
      ctx as AnyCanvasContext,
      [{ type: 'text', content: '후원 카드의 긴' }],
      startX,
      20,
      maxWidth,
      2,
      '#ffffff',
      20,
      0,
      0,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined } as never,
      () => 'bold 20px sans-serif',
      measureText
    );

    const firstLineCalls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, , y]) => y === 20
    );
    const rightmostInk = Math.max(
      ...firstLineCalls.map(([text, x]) => Number(x) + measureText(String(text)))
    );

    expect(firstLineCalls.map(([text]) => text)).toEqual(['후원', ' ', '카드의']);
    expect(rightmostInk).toBeLessThanOrEqual(startX + maxWidth);
  });

  it('keeps the truncation ellipsis inside the final visible line width', () => {
    const ctx = createContext();
    const textBitmapCache: TextBitmapCache = {
      get: () => undefined,
      set: vi.fn(),
    };
    const startX = 10;
    const maxWidth = 50;

    renderWrappedContentSegments(
      ctx as AnyCanvasContext,
      [{ type: 'text', content: 'AAAAA BBBBB CCCCC' }],
      startX,
      20,
      maxWidth,
      2,
      '#ffffff',
      20,
      0,
      0,
      textBitmapCache,
      { get: () => undefined } as never,
      () => 'bold 20px sans-serif'
    );

    const fillText = ctx.fillText as ReturnType<typeof vi.fn>;
    const ellipsisCall = fillText.mock.calls.find(([text]) => text === '…');
    expect(ellipsisCall).toBeDefined();

    const ellipsisX = ellipsisCall?.[1] as number;
    const ellipsisWidth = 10;
    expect(ellipsisX + ellipsisWidth).toBeLessThanOrEqual(startX + maxWidth);
  });

  it('removes an atomic trailing emoji when it cannot fit before the ellipsis', () => {
    const ctx = createContext();
    const textBitmapCache: TextBitmapCache = {
      get: () => undefined,
      set: vi.fn(),
    };
    const emoji = {} as CanvasImageSource;

    renderWrappedContentSegments(
      ctx as AnyCanvasContext,
      [
        { type: 'text', content: 'A' },
        { type: 'emoji', emojiUrl: 'emoji://loaded' },
        { type: 'text', content: 'CCCCC' },
      ],
      10,
      20,
      50,
      1,
      '#ffffff',
      20,
      0,
      0,
      textBitmapCache,
      { get: () => emoji } as never,
      () => 'bold 20px sans-serif'
    );

    expect(ctx.drawImage).not.toHaveBeenCalled();
    const fillText = ctx.fillText as ReturnType<typeof vi.fn>;
    expect(fillText.mock.calls.map(([text]) => text)).toEqual(['A', '…']);
    expect(fillText.mock.calls.at(-1)?.[1]).toBe(20);
  });

  it('keeps fitting content when the ellipsis itself is wider than the line', () => {
    const ctx = createContext();
    const textBitmapCache: TextBitmapCache = {
      get: () => undefined,
      set: vi.fn(),
    };

    renderWrappedContentSegments(
      ctx as AnyCanvasContext,
      [{ type: 'text', content: 'i i' }],
      10,
      20,
      5,
      1,
      '#ffffff',
      20,
      0,
      0,
      textBitmapCache,
      { get: () => undefined } as never,
      () => 'bold 20px sans-serif'
    );

    const fillText = ctx.fillText as ReturnType<typeof vi.fn>;
    expect(fillText.mock.calls.map(([text]) => text)).toEqual(['i']);
  });

  it('keeps an embedded LTR text-object-text run ordered in a wrapped RTL line', () => {
    const ctx = createContext();
    const image = { width: 20, height: 20 } as CanvasImageSource;

    renderWrappedContentSegments(
      ctx as AnyCanvasContext,
      [
        { type: 'text', content: 'مرحبا Hello' },
        { type: 'emoji', emojiUrl: 'emoji://loaded' },
        { type: 'text', content: 'World' },
      ],
      10,
      20,
      500,
      1,
      '#ffffff',
      20,
      0,
      0,
      { get: () => undefined, set: vi.fn() },
      { get: () => image } as never,
      () => 'bold 20px sans-serif'
    );

    const fillText = ctx.fillText as ReturnType<typeof vi.fn>;
    const drawImage = ctx.drawImage as ReturnType<typeof vi.fn>;
    expect(fillText.mock.calls.map(([text]) => text)).toEqual([
      'Hello',
      ' ',
      'World',
      ' ',
      'مرحبا',
    ]);
    expect(fillText.mock.invocationCallOrder[1]).toBeLessThan(
      drawImage.mock.invocationCallOrder[0]!
    );
    expect(drawImage.mock.invocationCallOrder[0]).toBeLessThan(
      fillText.mock.invocationCallOrder[2]!
    );
  });

  it('places a wrapped inline emoji between two Arabic runs in visual order', () => {
    const ctx = createContext();
    const image = { width: 20, height: 20 } as CanvasImageSource;

    renderWrappedContentSegments(
      ctx as AnyCanvasContext,
      [
        { type: 'text', content: 'مرحبا' },
        { type: 'emoji', emojiUrl: 'emoji://loaded' },
        { type: 'text', content: 'بكم' },
      ],
      10,
      20,
      500,
      1,
      '#ffffff',
      20,
      0,
      0,
      { get: () => undefined, set: vi.fn() },
      { get: () => image } as never,
      () => 'bold 20px sans-serif'
    );

    const fillText = ctx.fillText as ReturnType<typeof vi.fn>;
    const drawImage = ctx.drawImage as ReturnType<typeof vi.fn>;
    expect(fillText.mock.calls.map(([text]) => text)).toEqual(['بكم', ' ', 'مرحبا']);
    expect(fillText.mock.invocationCallOrder[0]).toBeLessThan(
      drawImage.mock.invocationCallOrder[0]!
    );
    expect(drawImage.mock.invocationCallOrder[0]).toBeLessThan(
      fillText.mock.invocationCallOrder[1]!
    );
  });

  it('places a truncation ellipsis at the visual left of an RTL line', () => {
    const ctx = createContext();

    renderWrappedContentSegments(
      ctx as AnyCanvasContext,
      [{ type: 'text', content: 'مرحبا بكم عالم' }],
      10,
      20,
      50,
      1,
      '#ffffff',
      20,
      0,
      0,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined } as never,
      () => 'bold 20px sans-serif'
    );

    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map(([text]) => text)).toEqual(['…', 'مرحب']);
    expect(calls[0]?.[1]).toBe(10);
    expect(calls[1]?.[1]).toBe(20);
  });

  it('keeps the RTL paragraph level when a wrapped line starts with numbers and Latin text', () => {
    const ctx = createContext();

    renderWrappedContentSegments(
      ctx as AnyCanvasContext,
      [{ type: 'text', content: 'مرحبامرحبا 123 English' }],
      10,
      20,
      110,
      2,
      '#ffffff',
      20,
      0,
      0,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined } as never,
      () => 'bold 20px sans-serif'
    );

    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map(([text]) => text)).toEqual(['مرحبامرحبا', 'English', ' ', '123']);
    expect(calls.slice(1).map(([, x]) => x)).toEqual([10, 80, 90]);
  });
});
