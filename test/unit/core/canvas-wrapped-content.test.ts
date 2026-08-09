// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/text-measure', () => ({
  getFontString: (fontSize: number): string => `bold ${fontSize}px sans-serif`,
  measureTextHeight: (): number => 20,
  measureTextWidth: (text: string): number => text.length * 10,
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
});
