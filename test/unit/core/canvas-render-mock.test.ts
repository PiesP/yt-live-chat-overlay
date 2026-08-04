// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Tests for Canvas 2D rendering functions in canvas/shared.ts.
 *
 * Uses mocked CanvasRenderingContext2D to test draw operations
 * without requiring a real browser canvas.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  buildWrappedLines,
  clipTextToWidth,
  drawRoundRect,
  renderSegment,
  renderRegularMessageBackground,
  strokeTextOutline,
} from '@renderer/canvas/shared';
import type { AnyCanvasContext, TextBitmapCache } from '@renderer/canvas/shared';

// ═══════════════════════════════════════════════════════════════════
// Mock Canvas context (mirrors test/setup.ts pattern)
// ═══════════════════════════════════════════════════════════════════

interface MockContextState {
  fillStyle: string;
  strokeStyle: string;
  font: string;
  textBaseline: string;
  globalAlpha: number;
  lineWidth: number;
  ops: string[];
  measuredTexts: string[];
  filledTexts: string[];
  strokedTexts: string[];
  roundRectCalled: boolean;
  beginPathCalled: boolean;
  closePathCalled: boolean;
  moveToCalled: boolean;
  lineToCalled: boolean;
  arcToCalled: boolean;
}

function createMockContext(
  measureTextImpl?: (text: string, state: MockContextState) => TextMetrics
): { ctx: AnyCanvasContext; state: MockContextState } {
  const state: MockContextState = {
    fillStyle: '#000',
    strokeStyle: '#000',
    font: '10px sans-serif',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    lineWidth: 1,
    ops: [],
    measuredTexts: [],
    filledTexts: [],
    strokedTexts: [],
    roundRectCalled: false,
    beginPathCalled: false,
    closePathCalled: false,
    moveToCalled: false,
    lineToCalled: false,
    arcToCalled: false,
  };

  const ctx = {
    get fillStyle() { return state.fillStyle; },
    set fillStyle(v: string | CanvasGradient | CanvasPattern) { state.fillStyle = String(v); state.ops.push('fillStyle'); },
    get strokeStyle() { return state.strokeStyle; },
    set strokeStyle(v: string | CanvasGradient | CanvasPattern) { state.strokeStyle = String(v); state.ops.push('strokeStyle'); },
    get font() { return state.font; },
    set font(v: string) { state.font = v; state.ops.push('font'); },
    get textBaseline() { return state.textBaseline; },
    set textBaseline(v: string) { state.textBaseline = v; state.ops.push('textBaseline'); },
    get globalAlpha() { return state.globalAlpha; },
    set globalAlpha(v: number) { state.globalAlpha = v; state.ops.push('globalAlpha'); },
    get lineWidth() { return state.lineWidth; },
    set lineWidth(v: number) { state.lineWidth = v; state.ops.push('lineWidth'); },

    measureText: vi.fn((text: string) => {
      state.measuredTexts.push(text);
      if (measureTextImpl) return measureTextImpl(text, state);
      const fontSize = parseFloat(state.font) || 10;
      return { width: text.length * fontSize * 0.6 } as TextMetrics;
    }),

    fillText: vi.fn((_text, _x, _y, _maxWidth?) => { state.filledTexts.push('text'); state.ops.push('fillText'); }),
    strokeText: vi.fn((_text, _x, _y, _maxWidth?) => { state.strokedTexts.push('text'); state.ops.push('strokeText'); }),
    drawImage: vi.fn(() => { state.ops.push('drawImage'); }),
    getTransform: vi.fn(() => ({ a: 1 })),
    roundRect: vi.fn(() => { state.roundRectCalled = true; state.ops.push('roundRect'); }),
    beginPath: vi.fn(() => { state.beginPathCalled = true; state.ops.push('beginPath'); }),
    closePath: vi.fn(() => { state.closePathCalled = true; state.ops.push('closePath'); }),
    moveTo: vi.fn((_x, _y) => { state.moveToCalled = true; state.ops.push('moveTo'); }),
    lineTo: vi.fn((_x, _y) => { state.lineToCalled = true; state.ops.push('lineTo'); }),
    arcTo: vi.fn((_x1, _y1, _x2, _y2, _r) => { state.arcToCalled = true; state.ops.push('arcTo'); }),
    save: vi.fn(() => { state.ops.push('save'); }),
    restore: vi.fn(() => { state.ops.push('restore'); }),
    fill: vi.fn(() => { state.ops.push('fill'); }),
    stroke: vi.fn(() => { state.ops.push('stroke'); }),
  } as unknown as AnyCanvasContext;

  return { ctx, state };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ═══════════════════════════════════════════════════════════════════
// renderSegment bitmap cache
// ═══════════════════════════════════════════════════════════════════

describe('renderSegment bitmap cache', () => {
  it('measures Latin text with the same top baseline used to draw the bitmap', () => {
    const measuredBaselines: string[] = [];
    const { ctx } = createMockContext((_text, state) => {
      measuredBaselines.push(state.textBaseline);
      return {
        width: 80,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: 80,
        actualBoundingBoxAscent: state.textBaseline === 'top' ? -2 : 18,
        actualBoundingBoxDescent: state.textBaseline === 'top' ? 22 : 0,
      } as TextMetrics;
    });

    class MockOffscreenCanvas {
      readonly context = {
        scale: vi.fn(),
        strokeText: vi.fn(),
        fillText: vi.fn(),
      };

      constructor(
        readonly width: number,
        readonly height: number
      ) {}

      getContext(): OffscreenCanvasRenderingContext2D {
        return this.context as unknown as OffscreenCanvasRenderingContext2D;
      }
    }

    vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);
    const bitmaps = new Map<string, CanvasImageSource>();
    const cache: TextBitmapCache = {
      get: (key) => bitmaps.get(key),
      set: (key, value) => {
        bitmaps.set(key, value);
      },
    };

    renderSegment(ctx, 'HELLO', 0, 0, '#ffffff', 32, 2, 0.7, cache, () =>
      'bold 32px sans-serif'
    );

    expect(measuredBaselines).toEqual(['top']);
    const bitmap = [...bitmaps.values()][0] as unknown as MockOffscreenCanvas;
    expect(bitmap.height).toBe(26);
  });
});

// ═══════════════════════════════════════════════════════════════════
// drawRoundRect
// ═══════════════════════════════════════════════════════════════════

describe('drawRoundRect', () => {
  it('calls beginPath + roundRect on native path', () => {
    // Our mock has roundRect as a function — hasRoundRect returns true
    const { ctx, state } = createMockContext();
    drawRoundRect(ctx, 10, 20, 100, 50, 8);
    expect(state.beginPathCalled).toBe(true);
    expect(state.roundRectCalled).toBe(true);
  });

  it('does not call closePath when native roundRect is used', () => {
    // Native roundRect path does not call closePath
    const { ctx, state } = createMockContext();
    drawRoundRect(ctx, 10, 20, 100, 50, 8);
    expect(state.closePathCalled).toBe(false);
  });

  it('calls arcTo fallback when roundRect is not available', () => {
    // Create a context WITHOUT roundRect to test arcTo fallback
    const { ctx: ctxNoRoundRect, state } = createMockContext();
    // Override roundRect to undefined to trigger arcTo fallback
    delete (ctxNoRoundRect as unknown as Record<string, unknown>).roundRect;
    drawRoundRect(ctxNoRoundRect, 10, 20, 100, 50, 8);
    expect(state.beginPathCalled).toBe(true);
    expect(state.arcToCalled).toBe(true);
    expect(state.moveToCalled).toBe(true);
    expect(state.lineToCalled).toBe(true);
    expect(state.closePathCalled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// renderRegularMessageBackground
// ═══════════════════════════════════════════════════════════════════

describe('renderRegularMessageBackground', () => {
  it('fills one rounded rectangle using the existing message bounds', () => {
    const { ctx, state } = createMockContext();

    renderRegularMessageBackground(ctx, 10, 20, 100, 50, '#1B3A6F59');

    expect(state.fillStyle).toBe('#1B3A6F59');
    expect(state.ops).toEqual(['fillStyle', 'beginPath', 'roundRect', 'fill']);
    expect((ctx as CanvasRenderingContext2D).roundRect).toHaveBeenCalledWith(
      10,
      20,
      100,
      50,
      6
    );
    expect(state.globalAlpha).toBe(1);
  });

  it('skips fully transparent backgrounds', () => {
    const { ctx, state } = createMockContext();

    renderRegularMessageBackground(ctx, 10, 20, 100, 50, '#00000000');

    expect(state.ops).toEqual([]);
  });

  it('skips invalid message bounds', () => {
    const { ctx, state } = createMockContext();

    renderRegularMessageBackground(ctx, 10, 20, 0, 50, '#6B4F0059');

    expect(state.ops).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// strokeTextOutline
// ═══════════════════════════════════════════════════════════════════

describe('strokeTextOutline', () => {
  it('skips stroke when outlineWidthPx is 0', () => {
    const { ctx, state } = createMockContext();
    // biome-ignore format: this is a test
    strokeTextOutline(ctx, 'test', 10, 20, '#fff', 0, 0.7);
    expect(state.ops).not.toContain('strokeText');
  });

  it('calls strokeText with correct parameters', () => {
    const { ctx, state } = createMockContext();
    // biome-ignore format: this is a test
    strokeTextOutline(ctx, 'test', 10, 20, '#ffffff', 2, 0.7);
    expect(state.ops).toContain('strokeText');
  });

  it('calls save/restore around strokeText', () => {
    const { ctx, state } = createMockContext();
    // biome-ignore format: this is a test
    strokeTextOutline(ctx, 'hello', 10, 20, '#ffffff', 2, 0.7);
    expect(state.ops).toContain('save');
    expect(state.ops).toContain('restore');
    expect(state.ops).toContain('strokeText');
  });
});

// ═══════════════════════════════════════════════════════════════════
// clipTextToWidth
// ═══════════════════════════════════════════════════════════════════

describe('clipTextToWidth', () => {
  it('returns full text when it fits within maxWidth', () => {
    const { ctx } = createMockContext();
    const result = clipTextToWidth('hello', 500, ctx);
    expect(result).toBe('hello');
  });

  it('returns empty string for empty input', () => {
    const { ctx } = createMockContext();
    const result = clipTextToWidth('', 100, ctx);
    expect(result).toBe('');
  });

  it('returns empty string for zero maxWidth', () => {
    const { ctx } = createMockContext();
    const result = clipTextToWidth('hello', 0, ctx);
    expect(result).toBe('');
  });

  it('truncates text with ellipsis when exceeding maxWidth', () => {
    const { ctx } = createMockContext();
    // Long text that exceeds the mock maxWidth
    const longText = 'this is a very long text that will not fit';
    const result = clipTextToWidth(longText, 1, ctx);
    expect(result.length).toBeLessThan(longText.length);
  });

  it('uses binary search for efficient truncation', () => {
    const { ctx, state } = createMockContext();
    clipTextToWidth('a'.repeat(100), 50, ctx);
    // measureText should be called multiple times (binary search)
    expect(state.measuredTexts.length).toBeGreaterThan(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// buildWrappedLines
// ═══════════════════════════════════════════════════════════════════

describe('buildWrappedLines', () => {
  it('returns empty lines for empty segments', () => {
    const result = buildWrappedLines([], 200, 16, () => 10);
    expect(result.lines).toHaveLength(0);
    expect(result.maxLineWidth).toBe(0);
  });

  it('places short text on a single line', () => {
    const segments = [{ type: 'text' as const, content: 'hello' }];
    const result = buildWrappedLines(segments, 200, 16, () => 50);
    expect(result.lines).toHaveLength(1);
  });

  it('splits long text across multiple lines', () => {
    const segments = [{ type: 'text' as const, content: 'a very long text that exceeds the maximum width' }];
    const result = buildWrappedLines(segments, 50, 16, () => 10);
    expect(result.lines.length).toBeGreaterThan(1);
  });

  it('respects maxWidth for each line', () => {
    const segments = [{ type: 'text' as const, content: 'word1 word2 word3 word4' }];
    const result = buildWrappedLines(segments, 60, 16, (t) => t.length * 8);
    for (const line of result.lines) {
      const lineWidth = line.reduce((sum, seg) => sum + (seg.width ?? 0), 0);
      expect(lineWidth).toBeLessThanOrEqual(60);
    }
  });
});
