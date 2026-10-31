// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage } from '@app-types';
import { renderRegularMessage } from '@renderer/canvas/shared';
import { getRegularCardInsets } from '@renderer/layout/card-layout';
import { estimateMessageDimensions, estimateTranslatedMessageDimensions } from '@renderer/shared';
import {
  clearTextMeasurementCaches,
  getFontString,
  measureBoundingBoxWidth,
  measureTextWidth,
} from '@renderer/text-measure';
import { DEFAULT_FONT_FAMILY } from '@util/design-tokens';
import { describe, expect, it, vi } from 'vite-plus/test';

describe('getFontString', () => {
  const defaultFamily = DEFAULT_FONT_FAMILY;

  it('builds CSS font string with bold weight', () => {
    const result = getFontString(16, 'bold');
    expect(result).toBe(`bold 16px ${defaultFamily}`);
  });

  it('builds CSS font string with normal weight (maps to 400)', () => {
    const result = getFontString(14, 'normal');
    expect(result).toBe(`400 14px ${defaultFamily}`);
  });

  it('accepts a custom font family', () => {
    const result = getFontString(20, 'bold', 'Arial');
    expect(result).toBe('bold 20px Arial');
  });

  it('uses DEFAULT_FONT_FAMILY when no family is provided', () => {
    const result = getFontString(12, 'bold');
    expect(result).toBe(`bold 12px ${defaultFamily}`);
  });

  it('defaults weight to bold when no weight is provided', () => {
    const result = getFontString(18);
    expect(result).toBe(`bold 18px ${defaultFamily}`);
  });

  it('handles fractional pixel size', () => {
    const result = getFontString(13.5, 'normal');
    expect(result).toBe(`400 13.5px ${defaultFamily}`);
  });

  it('builds string with spaces between weight, size, and family', () => {
    const result = getFontString(24, 'bold', '"Inter", sans-serif');
    expect(result).toBe('bold 24px "Inter", sans-serif');
  });
});

// ── measureBoundingBoxWidth ──────────────────────────────────────────

describe('measureBoundingBoxWidth', () => {
  it('reserves the wider advance width when it exceeds the ink bounding box', () => {
    const m = {
      actualBoundingBoxLeft: 2,
      actualBoundingBoxRight: 48,
      width: 55,
    };
    expect(measureBoundingBoxWidth(m)).toBe(55);
  });

  it('reserves wider glyph ink when it exceeds the advance width', () => {
    const m = {
      actualBoundingBoxLeft: 4,
      actualBoundingBoxRight: 56,
      width: 55,
    };
    expect(measureBoundingBoxWidth(m)).toBe(60);
  });

  it('uses bounding box when left is negative', () => {
    const m = {
      actualBoundingBoxLeft: -2,
      actualBoundingBoxRight: 48,
      width: 55,
    };
    expect(measureBoundingBoxWidth(m)).toBe(55);
  });

  it('uses bounding box when right is negative', () => {
    const m = {
      actualBoundingBoxLeft: 2,
      actualBoundingBoxRight: -1,
      width: 55,
    };
    expect(measureBoundingBoxWidth(m)).toBe(55);
  });

  it('falls back to width when bounding box sum is zero', () => {
    const m = {
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 0,
      width: 55,
    };
    // 0 + 0 = 0 → fallback to Math.ceil(55) = 55
    expect(measureBoundingBoxWidth(m)).toBe(55);
  });

  it('falls back to width when bounding box sum is negative (should not happen)', () => {
    const m = {
      actualBoundingBoxLeft: -10,
      actualBoundingBoxRight: 9,
      width: 55,
    };
    expect(measureBoundingBoxWidth(m)).toBe(55);
  });

  it('ceils the width fallback', () => {
    const m = {
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 0,
      width: 12.3,
    };
    expect(measureBoundingBoxWidth(m)).toBe(13);
  });

  it('ceils the bounding box value', () => {
    const m = {
      actualBoundingBoxLeft: 1.2,
      actualBoundingBoxRight: 3.8,
      width: 10,
    };
    expect(measureBoundingBoxWidth(m)).toBe(10);
  });

  it('handles large TextMetrics values', () => {
    const m = {
      actualBoundingBoxLeft: 123,
      actualBoundingBoxRight: 456,
      width: 600,
    };
    expect(measureBoundingBoxWidth(m)).toBe(600);
  });

  it.each([
    ['missing', { width: 42 }],
    [
      'NaN',
      {
        actualBoundingBoxLeft: Number.NaN,
        actualBoundingBoxRight: 40,
        width: 42,
      },
    ],
    [
      'infinite',
      {
        actualBoundingBoxLeft: 2,
        actualBoundingBoxRight: Number.POSITIVE_INFINITY,
        width: 42,
      },
    ],
  ])('falls back to the finite advance width when ink bounds are %s', (_label, metrics) => {
    expect(measureBoundingBoxWidth(metrics as TextMetrics)).toBe(42);
  });
});

describe('text measurement caches', () => {
  it('keeps direction-sensitive ink measurements in separate cache entries', () => {
    const measureText = vi
      .spyOn(CanvasRenderingContext2D.prototype, 'measureText')
      .mockImplementation(function (this: CanvasRenderingContext2D) {
        return {
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: this.direction === 'rtl' ? 20 : 10,
          width: 10,
        } as TextMetrics;
      });
    try {
      clearTextMeasurementCaches();
      expect(measureTextWidth('مرحبا — ', '16px sans-serif', 'ltr')).toBe(10);
      expect(measureTextWidth('مرحبا — ', '16px sans-serif', 'rtl')).toBe(20);
      expect(measureTextWidth('مرحبا — ', '16px sans-serif', 'ltr')).toBe(10);
      expect(measureTextWidth('مرحبا — ', '16px sans-serif', 'rtl')).toBe(20);
      expect(measureText).toHaveBeenCalledTimes(2);
      const context = measureText.mock.contexts[0] as CanvasRenderingContext2D;
      expect(context.direction).toBe('inherit');
      expect(context.textAlign).toBe('start');
    } finally {
      measureText.mockRestore();
      clearTextMeasurementCaches();
    }
  });

  it('clears cached space widths when measurement caches are cleared', () => {
    const measureText = vi.fn(
      () =>
        ({
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: 0,
          width: 5,
        }) as TextMetrics
    );
    const measureTextSpy = vi
      .spyOn(CanvasRenderingContext2D.prototype, 'measureText')
      .mockImplementation(measureText);
    const font = '16px sans-serif';

    clearTextMeasurementCaches();
    expect(measureTextWidth(' ', font)).toBe(5);

    measureText.mockReturnValue({
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 0,
      width: 9,
    } as TextMetrics);
    clearTextMeasurementCaches();

    expect(measureTextWidth(' ', font)).toBe(9);
    expect(measureText).toHaveBeenCalledTimes(2);

    measureTextSpy.mockRestore();
  });

  it('returns and caches a finite width when Canvas omits ink bounds', async () => {
    const measureText = vi.fn(() => ({ width: 42 }) as TextMetrics);
    const measureTextSpy = vi
      .spyOn(CanvasRenderingContext2D.prototype, 'measureText')
      .mockImplementation(measureText);

    try {
      clearTextMeasurementCaches();

      expect(measureTextWidth('hello', '16px sans-serif')).toBe(42);
      expect(measureTextWidth('hello', '16px sans-serif')).toBe(42);
      expect(measureText).toHaveBeenCalledTimes(1);
    } finally {
      measureTextSpy.mockRestore();
      clearTextMeasurementCaches();
    }
  });

  it('keeps renderer dimensions finite and cached when Canvas ink bounds are invalid', async () => {
    const measureText = vi.fn((text: string) => {
      if (text === 'Mg') {
        return {
          width: 20,
          actualBoundingBoxAscent: 0,
          actualBoundingBoxDescent: 0,
        } as TextMetrics;
      }
      return {
        width: 42,
        actualBoundingBoxLeft: Number.NaN,
        actualBoundingBoxRight: Number.POSITIVE_INFINITY,
      } as TextMetrics;
    });
    const measureTextSpy = vi
      .spyOn(CanvasRenderingContext2D.prototype, 'measureText')
      .mockImplementation(measureText);
    const message = {
      text: 'hello',
      content: [{ type: 'text', content: 'hello' }],
      kind: 'text',
      timestamp: Date.now(),
      authorType: 'normal',
    } satisfies ChatMessage;

    try {
      const { estimateMessageDimensions } = await import('@renderer/shared');
      clearTextMeasurementCaches();

      const first = estimateMessageDimensions(message, 16, false);
      const cached = estimateMessageDimensions(message, 16, false);
      const insets = getRegularCardInsets(16, 0, false, false);

      expect(first).toEqual({
        width: 42 + insets.horizontal * 2,
        height: Math.ceil(16 * 1.4) + insets.vertical * 2,
      });
      expect(cached).toEqual(first);
      expect(Object.values(first).every(Number.isFinite)).toBe(true);
      expect(measureText.mock.calls.map(([text]) => text)).toEqual(['hello', 'Mg国한Ágj', 'hello']);
    } finally {
      measureTextSpy.mockRestore();
      clearTextMeasurementCaches();
    }
  });
});

describe('fixed comment width geometry', () => {
  it('fits a long author and wrapped body inside a narrow viewport', () => {
    clearTextMeasurementCaches();
    const body = '한글 English 👨‍👩‍👧‍👦 مرحبا 123 '.repeat(10);
    const message = {
      text: body,
      content: [{ type: 'text', content: body }],
      kind: 'text',
      timestamp: 0,
      authorType: 'normal',
      author: 'Long author 👩‍💻 '.repeat(10),
    } satisfies ChatMessage;
    const font = getFontString(32, 'bold', DEFAULT_FONT_FAMILY);
    const fixed = estimateMessageDimensions(
      message,
      32,
      true,
      'bold',
      DEFAULT_FONT_FAMILY,
      undefined,
      undefined,
      '0px',
      0,
      320,
      undefined,
      '#00000000',
      'top'
    );
    const scrolling = estimateMessageDimensions(message, 32, true);
    const dual = estimateTranslatedMessageDimensions(
      message,
      '번역 translated '.repeat(12),
      'dual',
      {
        fontSize: 32,
        showAuthor: true,
        availableWidth: 320,
        mode: 'top',
      }
    );
    expect(fixed.width).toBeLessThanOrEqual(320);
    expect(scrolling.width).toBeGreaterThan(320);
    expect(dual.width).toBeLessThanOrEqual(320);
    expect(dual.height).toBeGreaterThan(fixed.height);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    expect(ctx).not.toBeNull();
    if (!ctx) return;
    const drawn: Array<{ x: number; y: number; width: number }> = [];
    const originalFill = ctx.fillText.bind(ctx);
    vi.spyOn(ctx, 'fillText').mockImplementation((text, x, y) => {
      drawn.push({ x, y, width: ctx.measureText(text).width });
      originalFill(text, x, y);
    });
    renderRegularMessage(
      ctx,
      message,
      0,
      0,
      {
        showAuthor: true,
        fontSize: 32,
        fontWeight: 'bold',
        fontFamily: DEFAULT_FONT_FAMILY,
        color: '#fff',
        outlineWidthPx: 0,
        outlineOpacity: 0,
        backgroundColor: '#00000000',
        messageWidth: fixed.width,
        messageHeight: fixed.height,
        mode: 'top',
      },
      { maxBytes: 0, get: () => undefined, set: () => false },
      { get: () => undefined },
      () => false,
      { get: () => undefined },
      () => false,
      (size) => getFontString(size, 'bold', DEFAULT_FONT_FAMILY),
      (text, direction) => measureTextWidth(text, font, direction)
    );
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.every(({ x, width }) => x >= 0 && x + width <= fixed.width + 1)).toBe(true);
    expect(drawn.every(({ y }) => y <= fixed.height)).toBe(true);
    expect(drawn.some(({ width }) => width > 0)).toBe(true);
  });
});
