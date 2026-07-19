// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, it, expect, vi } from 'vitest';
import {
  clearTextMeasurementCaches,
  getFontString,
  measureBoundingBoxWidth,
  measureTextWidth,
} from '@renderer/text-measure';
import { DEFAULT_FONT_FAMILY } from '@util/design-tokens';

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
  it('uses bounding box when it is positive', () => {
    const m = {
      actualBoundingBoxLeft: 2,
      actualBoundingBoxRight: 48,
      width: 55,
    };
    // 2 + 48 = 50, ceil → 50
    expect(measureBoundingBoxWidth(m)).toBe(50);
  });

  it('uses bounding box when left is negative', () => {
    const m = {
      actualBoundingBoxLeft: -2,
      actualBoundingBoxRight: 48,
      width: 55,
    };
    // |−2| + 48 = 50, ceil → 50
    expect(measureBoundingBoxWidth(m)).toBe(50);
  });

  it('uses bounding box when right is negative', () => {
    const m = {
      actualBoundingBoxLeft: 2,
      actualBoundingBoxRight: -1,
      width: 55,
    };
    // 2 + |−1| = 3, ceil → 3
    expect(measureBoundingBoxWidth(m)).toBe(3);
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
    // |−10| + 9 = 19, ceil → 19 (positive, uses bb)
    expect(measureBoundingBoxWidth(m)).toBe(19);
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
    // 1.2 + 3.8 = 5.0, ceil → 5
    expect(measureBoundingBoxWidth(m)).toBe(5);
  });

  it('handles large TextMetrics values', () => {
    const m = {
      actualBoundingBoxLeft: 123,
      actualBoundingBoxRight: 456,
      width: 600,
    };
    expect(measureBoundingBoxWidth(m)).toBe(579);
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
});
