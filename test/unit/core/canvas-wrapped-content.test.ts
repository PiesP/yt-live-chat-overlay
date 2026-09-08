// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/text-measure', () => ({
  getFontString: (fontSize: number): string => `bold ${fontSize}px sans-serif`,
  measureTextHeight: (): number => 20,
  measureTextWidth: (text: string): number => (text === 'i' ? 4 : text.length * 10),
}));

import { renderWrappedContentSegments } from '@renderer/canvas/shared';
import type { AnyCanvasContext, TextBitmapCache } from '@renderer/canvas/shared';

function createContext(): CanvasRenderingContext2D {
  return {
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
  it('keeps separately measured CJK word gaps inside the wrapped line width', () => {
    const ctx = createContext();
    const measureText = (text: string): number => {
      const widths: Readonly<Record<string, number>> = {
        ' ': 4,
        '…': 10,
        '후원': 20,
        '카드의': 30,
        ' 카드의': 42,
        '긴': 10,
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
    expect(fillText.mock.invocationCallOrder[1]).toBeLessThan(drawImage.mock.invocationCallOrder[0]!);
    expect(drawImage.mock.invocationCallOrder[0]).toBeLessThan(fillText.mock.invocationCallOrder[2]!);
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
    expect(fillText.mock.invocationCallOrder[0]).toBeLessThan(drawImage.mock.invocationCallOrder[0]!);
    expect(drawImage.mock.invocationCallOrder[0]).toBeLessThan(fillText.mock.invocationCallOrder[1]!);
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
