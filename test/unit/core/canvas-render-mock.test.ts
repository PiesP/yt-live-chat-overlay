// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Tests for Canvas 2D rendering functions in canvas/shared.ts.
 *
 * Uses mocked CanvasRenderingContext2D to test draw operations
 * without requiring a real browser canvas.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// Mock Canvas context
// ═══════════════════════════════════════════════════════════════════════════

interface MockContextState {
  fillStyle: string;
  strokeStyle: string;
  font: string;
  textBaseline: string;
  globalAlpha: number;
  lineWidth: number;
  filter: string;
  textAlign: string;
  ops: string[];
  measuredTexts: string[];
  filledTexts: string[];
  strokedTexts: string[];
  roundRectCalled: boolean;
  imagesDrawn: number;
}

function createMockContext(): { ctx: CanvasRenderingContext2D; state: MockContextState } {
  const state: MockContextState = {
    fillStyle: '#000',
    strokeStyle: '#000',
    font: '10px sans-serif',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    lineWidth: 1,
    filter: 'none',
    textAlign: 'left',
    ops: [],
    measuredTexts: [],
    filledTexts: [],
    strokedTexts: [],
    roundRectCalled: false,
    imagesDrawn: 0,
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
    get filter() { return state.filter; },
    set filter(v: string) { state.filter = v; state.ops.push('filter'); },
    get textAlign() { return state.textAlign; },
    set textAlign(v: string) { state.textAlign = v; state.ops.push('textAlign'); },

    measureText: vi.fn((text: string) => {
      state.measuredTexts.push(text);
      const fontSize = parseFloat(state.font) || 10;
      return { width: text.length * fontSize * 0.6 } as TextMetrics;
    }),

    fillText: vi.fn((text: string, _x: number, _y: number, _maxWidth?: number) => {
      state.filledTexts.push(text);
      state.ops.push('fillText');
    }),

    strokeText: vi.fn((text: string, _x: number, _y: number, _maxWidth?: number) => {
      state.strokedTexts.push(text);
      state.ops.push('strokeText');
    }),

    roundRect: vi.fn((_x: number, _y: number, _w: number, _h: number, _r: number) => {
      state.roundRectCalled = true;
      state.ops.push('roundRect');
    }),

    save: vi.fn(() => { state.ops.push('save'); }),
    restore: vi.fn(() => { state.ops.push('restore'); }),
    beginPath: vi.fn(() => { state.ops.push('beginPath'); }),
    closePath: vi.fn(() => { state.ops.push('closePath'); }),
    moveTo: vi.fn(() => {}),
    lineTo: vi.fn(() => {}),
    arcTo: vi.fn(() => {}),
    arc: vi.fn(() => {}),
    fill: vi.fn(() => { state.ops.push('fill'); }),
    stroke: vi.fn(() => { state.ops.push('stroke'); }),
    clip: vi.fn(() => {}),
    translate: vi.fn(() => {}),
    scale: vi.fn(() => {}),
    rotate: vi.fn(() => {}),
    setTransform: vi.fn(() => {}),
    drawImage: vi.fn(() => { state.imagesDrawn++; state.ops.push('drawImage'); }),
    createLinearGradient: vi.fn(() => {
      const grad = { addColorStop: vi.fn() };
      return grad as unknown as CanvasGradient;
    }),
    createRadialGradient: vi.fn(() => {
      const grad = { addColorStop: vi.fn() };
      return grad as unknown as CanvasGradient;
    }),
    clearRect: vi.fn(() => {}),
    fillRect: vi.fn(() => {}),
    strokeRect: vi.fn(() => {}),
  } as unknown as CanvasRenderingContext2D;

  return { ctx, state };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Canvas rendering functions (mocked context)', () => {
  let mockCtx: CanvasRenderingContext2D;
  let state: MockContextState;

  beforeEach(() => {
    ({ ctx: mockCtx, state } = createMockContext());
  });

  describe('clipTextToWidth', () => {
    it('returns empty string for empty text', async () => {
      const { clipTextToWidth } = await import('@renderer/canvas/shared');
      expect(clipTextToWidth('', 100, mockCtx)).toBe('');
    });

    it('returns original text when it fits within maxWidth', async () => {
      const { clipTextToWidth } = await import('@renderer/canvas/shared');
      expect(clipTextToWidth('hi', 100, mockCtx)).toBe('hi');
    });

    it('truncates long text that exceeds maxWidth', async () => {
      const { clipTextToWidth } = await import('@renderer/canvas/shared');
      const result = clipTextToWidth('this is a very long text', 20, mockCtx);
      expect(result.length).toBeLessThan('this is a very long text'.length);
      expect(result).toContain('…');
    });

    it('returns empty string for maxWidth <= 0', async () => {
      const { clipTextToWidth } = await import('@renderer/canvas/shared');
      expect(clipTextToWidth('hello', 0, mockCtx)).toBe('');
      expect(clipTextToWidth('hello', -1, mockCtx)).toBe('');
    });
  });

  describe('buildWrappedLines', () => {
    it('returns empty lines for empty segments', async () => {
      const { buildWrappedLines, toSharedContentSegments } = await import('@renderer/canvas/shared');
      const result = buildWrappedLines(
        toSharedContentSegments([]),
        200,
        16,
        (t: string) => mockCtx.measureText(t).width,
      );
      expect(result.lines).toEqual([]);
      expect(result.maxLineWidth).toBe(0);
    });

    it('wraps text segments within maxWidth', async () => {
      const { buildWrappedLines, toSharedContentSegments } = await import('@renderer/canvas/shared');
      const segments = toSharedContentSegments([
        { type: 'text', content: 'hello world test' },
      ]);
      const result = buildWrappedLines(segments, 200, 16, (t: string) => mockCtx.measureText(t).width);
      expect(result.lines.length).toBeGreaterThan(0);
    });

    it('fits short text in a single line', async () => {
      const { buildWrappedLines, toSharedContentSegments } = await import('@renderer/canvas/shared');
      const segments = toSharedContentSegments([
        { type: 'text', content: 'hi' },
      ]);
      const result = buildWrappedLines(segments, 500, 16, (t: string) => mockCtx.measureText(t).width);
      expect(result.lines.length).toBe(1);
    });
  });

  describe('drawRoundRect', () => {
    it('calls beginPath and roundRect (native path)', async () => {
      const { drawRoundRect } = await import('@renderer/canvas/shared');
      drawRoundRect(mockCtx, 0, 0, 100, 50, 8);
      expect(state.ops).toContain('beginPath');
      // Uses native roundRect when available on the mock (roundRect function exists)
      expect(state.roundRectCalled).toBe(true);
    });

    it('accepts valid parameters without throwing', async () => {
      const { drawRoundRect } = await import('@renderer/canvas/shared');
      expect(() => drawRoundRect(mockCtx, 10, 20, 200, 100, 12)).not.toThrow();
    });
  });

  describe('strokeTextOutline', () => {
    it('calls strokeText for text outline', async () => {
      const { strokeTextOutline } = await import('@renderer/canvas/shared');
      // Signature: (ctx, text, x, y, textColor, outlineWidthPx, outlineOpacity)
      strokeTextOutline(mockCtx, 'test', 10, 20, '#ffffff', 2, 0.7);
      // Should call strokeText
      expect(state.ops).toContain('strokeText');
    });

    it('no-ops when outlineWidthPx is 0', async () => {
      const { strokeTextOutline } = await import('@renderer/canvas/shared');
      strokeTextOutline(mockCtx, 'test', 10, 20, '#ffffff', 0, 0.7);
      // Should not call strokeText
      expect(state.ops).not.toContain('strokeText');
    });
  });

  describe('getDisplayText', () => {
    it('filters text-only segments', async () => {
      const { getDisplayText } = await import('@renderer/canvas/shared');
      expect(getDisplayText([{ type: 'text', content: 'a' }, { type: 'text', content: 'b' }])).toBe('ab');
      expect(getDisplayText([{ type: 'emoji' }])).toBe('');
      expect(getDisplayText([])).toBe('');
    });
  });
});
