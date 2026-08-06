// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, it, expect, vi } from 'vitest';
import type { ChatMessage } from '@app-types';
import {
  clearTextMeasurementCaches,
  getFontString,
  measureBoundingBoxWidth,
  measureTextWidth,
} from '@renderer/text-measure';
import { DEFAULT_FONT_FAMILY, rendererLayout } from '@util/design-tokens';

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
  it('clears cached space widths when measurement caches are cleared', () => {
    const measureText = vi.fn(() => ({
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 0,
      width: 5,
    }));
    const context = { measureText } as unknown as CanvasRenderingContext2D;
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context);
    const font = '16px sans-serif';

    clearTextMeasurementCaches();
    expect(measureTextWidth(' ', font)).toBe(5);

    measureText.mockReturnValue({
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 0,
      width: 9,
    });
    clearTextMeasurementCaches();

    expect(measureTextWidth(' ', font)).toBe(9);
    expect(measureText).toHaveBeenCalledTimes(2);

    getContext.mockRestore();
  });

  it('returns and caches a finite width when Canvas omits ink bounds', async () => {
    const measureText = vi.fn(() => ({ width: 42 }) as TextMetrics);
    const context = { measureText } as unknown as CanvasRenderingContext2D;
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context);

    try {
      vi.resetModules();
      const isolatedTextMeasure = await import('@renderer/text-measure');
      isolatedTextMeasure.clearTextMeasurementCaches();

      expect(isolatedTextMeasure.measureTextWidth('hello', '16px sans-serif')).toBe(42);
      expect(isolatedTextMeasure.measureTextWidth('hello', '16px sans-serif')).toBe(42);
      expect(measureText).toHaveBeenCalledTimes(1);
    } finally {
      getContext.mockRestore();
      vi.resetModules();
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
    const context = { measureText } as unknown as CanvasRenderingContext2D;
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context);
    const message = {
      text: 'hello',
      content: [{ type: 'text', content: 'hello' }],
      kind: 'text',
      timestamp: Date.now(),
      authorType: 'normal',
    } satisfies ChatMessage;

    try {
      vi.resetModules();
      const [{ estimateMessageDimensions }, isolatedTextMeasure] = await Promise.all([
        import('@renderer/shared'),
        import('@renderer/text-measure'),
      ]);
      isolatedTextMeasure.clearTextMeasurementCaches();

      const first = estimateMessageDimensions(message, 16, false);
      const cached = estimateMessageDimensions(message, 16, false);

      expect(first).toEqual({
        width: 42 + rendererLayout.paddingH * 2,
        height: Math.ceil(16 * 1.1),
      });
      expect(cached).toEqual(first);
      expect(Object.values(first).every(Number.isFinite)).toBe(true);
      expect(measureText.mock.calls.map(([text]) => text)).toEqual(['hello', 'Mg']);
    } finally {
      getContext.mockRestore();
      vi.resetModules();
    }
  });
});
