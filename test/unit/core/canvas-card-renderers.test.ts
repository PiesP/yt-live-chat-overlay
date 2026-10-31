// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage } from '@app-types';
import { LruMap } from '@piesp/browser-core/util';
import { drawLeftRoundedRect, renderPaidCard } from '@renderer/canvas/card-renderers';
import { SUPERCHAT_CARD_CONFIG } from '@renderer/card-config';
import { GRADIENT_CACHE_MAX } from '@renderer/constants';
import { preparePaidCardPlan } from '@renderer/layout/paid-card-plan';
import { DEFAULT_SETTINGS } from '@settings/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Mock Canvas ──────────────────────────────────────────────────────

interface PathOp {
  name: string;
  args: unknown[];
}

function createMockCtx(): { ctx: CanvasRenderingContext2D; ops: PathOp[] } {
  const ops: PathOp[] = [];

  const ctx = {
    beginPath: vi.fn(() => {
      ops.push({ name: 'beginPath', args: [] });
    }),
    closePath: vi.fn(() => {
      ops.push({ name: 'closePath', args: [] });
    }),
    moveTo: vi.fn((x: number, y: number) => {
      ops.push({ name: 'moveTo', args: [x, y] });
    }),
    lineTo: vi.fn((x: number, y: number) => {
      ops.push({ name: 'lineTo', args: [x, y] });
    }),
    arcTo: vi.fn((x1: number, y1: number, x2: number, y2: number, r: number) => {
      ops.push({ name: 'arcTo', args: [x1, y1, x2, y2, r] });
    }),
    save: vi.fn(() => {}),
    restore: vi.fn(() => {}),
    fill: vi.fn(() => {}),
    stroke: vi.fn(() => {}),
    strokeText: vi.fn(() => {}),
    fillText: vi.fn(() => {}),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;

  return { ctx, ops };
}

// ═══════════════════════════════════════════════════════════════════════════
// drawLeftRoundedRect
// ═══════════════════════════════════════════════════════════════════════════

describe('drawLeftRoundedRect', () => {
  let ctx: CanvasRenderingContext2D;
  let ops: PathOp[];

  beforeEach(() => {
    const m = createMockCtx();
    ctx = m.ctx;
    ops = m.ops;
  });

  it('starts with beginPath and ends with closePath', () => {
    drawLeftRoundedRect(ctx, 10, 20, 100, 50, 8);
    expect(ops[0]!.name).toBe('beginPath');
    expect(ops[ops.length - 1]!.name).toBe('closePath');
  });

  it('draws moveTo at (x + r, y) — top edge start', () => {
    drawLeftRoundedRect(ctx, 10, 20, 100, 50, 8);
    expect(ops[1]).toEqual({ name: 'moveTo', args: [18, 20] });
  });

  it('draws sharp right side with two lineTo calls', () => {
    drawLeftRoundedRect(ctx, 10, 20, 100, 50, 8);
    // After moveTo: lineTo right-top, lineTo right-bottom
    expect(ops[2]).toEqual({ name: 'lineTo', args: [110, 20] });
    expect(ops[3]).toEqual({ name: 'lineTo', args: [110, 70] });
  });

  it('draws lineTo back to bottom-left curve start', () => {
    drawLeftRoundedRect(ctx, 10, 20, 100, 50, 8);
    // After right side: lineTo(x + r, y + h)
    expect(ops[4]).toEqual({ name: 'lineTo', args: [18, 70] });
  });

  it('draws bottom-left curve with arcTo', () => {
    drawLeftRoundedRect(ctx, 10, 20, 100, 50, 8);
    // arcTo(x, y+h, x, y+h-r, r) = arcTo(10, 70, 10, 62, 8)
    expect(ops[5]).toEqual({ name: 'arcTo', args: [10, 70, 10, 62, 8] });
  });

  it('draws left edge lineTo up to top-left curve', () => {
    drawLeftRoundedRect(ctx, 10, 20, 100, 50, 8);
    // lineTo(x, y + r) = lineTo(10, 28)
    expect(ops[6]).toEqual({ name: 'lineTo', args: [10, 28] });
  });

  it('draws top-left curve with arcTo', () => {
    drawLeftRoundedRect(ctx, 10, 20, 100, 50, 8);
    // arcTo(x, y, x+r, y, r) = arcTo(10, 20, 18, 20, 8)
    expect(ops[7]).toEqual({ name: 'arcTo', args: [10, 20, 18, 20, 8] });
  });

  it('has correct number of ops (beginPath + 7 draws + closePath = 9)', () => {
    drawLeftRoundedRect(ctx, 10, 20, 100, 50, 8);
    // beginPath + moveTo + lineTo×3 + arcTo×2 + lineTo + closePath = 9
    expect(ops).toHaveLength(9);
  });

  it('handles zero radius (degenerate to sharp corners)', () => {
    drawLeftRoundedRect(ctx, 0, 0, 100, 50, 0);
    // moveTo(x+r, y) = (0,0), arcTo with r=0 still called
    expect(ops[1]!.args).toEqual([0, 0]);
    expect(ops[5]!.args).toEqual([0, 50, 0, 50, 0]);
    expect(ops[7]!.args).toEqual([0, 0, 0, 0, 0]);
  });

  it('handles different origin offsets', () => {
    const m = createMockCtx();
    drawLeftRoundedRect(m.ctx, 50, 100, 200, 80, 12);
    // moveTo(x+r, y) = (62, 100)
    expect(m.ops[1]).toEqual({ name: 'moveTo', args: [62, 100] });
    // lineTo right-bottom = (250, 180)
    expect(m.ops[3]).toEqual({ name: 'lineTo', args: [250, 180] });
  });
});

describe('bounded amount rendering', () => {
  it('passes a contained text width to Canvas without altering the localized amount', () => {
    const amount = 'X'.repeat(22);
    const fillText = vi.fn();
    const gradient = { addColorStop: vi.fn() } as unknown as CanvasGradient;
    const ctx = {
      font: 'bold 24px sans-serif',
      direction: 'ltr',
      textAlign: 'left',
      textBaseline: 'top',
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      createLinearGradient: vi.fn(() => gradient),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arcTo: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      strokeText: vi.fn(),
      fillText,
      measureText: vi.fn((text: string) => ({
        width: text === amount ? 220 : text.length * 10,
        actualBoundingBoxAscent: 10,
        actualBoundingBoxDescent: 3,
      })),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
    } as unknown as CanvasRenderingContext2D;
    const msg: ChatMessage = {
      kind: 'superchat',
      authorType: 'normal',
      timestamp: 0,
      text: '',
      content: [],
      superChat: { tier: 'blue', amount },
    };
    const cache = { get: (): undefined => undefined, set: (): boolean => false };
    renderPaidCard(
      ctx,
      msg,
      240,
      80,
      0,
      0,
      0,
      SUPERCHAT_CARD_CONFIG,
      DEFAULT_SETTINGS,
      cache as never,
      cache as never,
      cache as never,
      cache as never,
      () => 'bold 24px sans-serif',
      new Map()
    );
    expect(fillText).toHaveBeenCalledWith(amount, 36, expect.any(Number), 168);
  });
});

describe('Super Chat sticker image ownership', () => {
  const message: ChatMessage = {
    kind: 'superchat',
    authorType: 'normal',
    timestamp: 0,
    text: '',
    content: [],
    superChat: {
      tier: 'blue',
      amount: '',
      sticker: { url: 'https://example.test/cat.png', alt: '猫ステッカー' },
    },
  };
  const plan = preparePaidCardPlan({
    kind: 'superchat',
    width: 240,
    fontSize: 24,
    fontWeight: 'bold',
    fontFamily: 'sans-serif',
    paddingH: 24,
    paddingV: 20,
    showAuthor: false,
    showAmount: false,
    content: [],
    maxBodyLines: 3,
    outlineWidthPx: 0,
    wide: true,
    sticker: true,
    measure: (value) => value.length * 8,
  });

  function paint(image?: { complete: boolean; naturalWidth: number; naturalHeight: number }) {
    const fillText = vi.fn();
    const drawImage = vi.fn();
    const gradient = { addColorStop: vi.fn() } as unknown as CanvasGradient;
    const ctx = {
      font: 'bold 24px sans-serif',
      direction: 'ltr',
      textAlign: 'left',
      textBaseline: 'top',
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      createLinearGradient: vi.fn(() => gradient),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arcTo: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      strokeText: vi.fn(),
      fillText,
      drawImage,
      measureText: vi.fn((value: string) => ({
        width: Array.from(value).length * 8,
        actualBoundingBoxAscent: 10,
        actualBoundingBoxDescent: 3,
      })),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
    } as unknown as CanvasRenderingContext2D;
    const noCache = { get: (): undefined => undefined, set: (): boolean => false };
    renderPaidCard(
      ctx,
      message,
      plan.width,
      plan.height,
      0,
      0,
      0,
      SUPERCHAT_CARD_CONFIG,
      DEFAULT_SETTINGS,
      noCache as never,
      noCache as never,
      { get: () => image } as never,
      noCache as never,
      () => 'bold 24px sans-serif',
      new Map()
    );
    return { fillText, drawImage };
  }

  it('uses the reserved sticker row for pending and failed images without a body gap', () => {
    expect(plan.bodyY).toBeUndefined();
    expect(plan.stickerY).toBe(20);
    expect(plan.height).toBe(20 + plan.stickerSize + 20);
    for (const image of [undefined, { complete: true, naturalWidth: 0, naturalHeight: 0 }]) {
      const painted = paint(image);
      expect(painted.drawImage).not.toHaveBeenCalled();
      expect(painted.fillText.mock.calls.map(([value]) => value).join('')).toContain(
        '猫ステッカー'
      );
    }
  });

  it('aspect-fits a loaded non-square bitmap instead of drawing the fallback', () => {
    const painted = paint({ complete: true, naturalWidth: 80, naturalHeight: 40 });
    expect(painted.fillText).not.toHaveBeenCalled();
    expect(painted.drawImage).toHaveBeenCalledOnce();
    const call = painted.drawImage.mock.calls[0];
    expect(call?.[3]).toBe(plan.stickerSize);
    expect(call?.[4]).toBe(plan.stickerSize / 2);
  });
});

describe('renderPaidCard canvas state', () => {
  it('restores the caller font after rendering an amount badge', () => {
    class MockOffscreenCanvas {
      constructor(
        readonly width: number,
        readonly height: number
      ) {}
    }
    vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);
    const fontStack: string[] = [];
    let font = 'italic 12px serif';
    const gradient = { addColorStop: vi.fn() } as unknown as CanvasGradient;
    const ctx = {
      get font() {
        return font;
      },
      set font(value: string) {
        font = value;
      },
      save: vi.fn(() => fontStack.push(font)),
      restore: vi.fn(() => {
        font = fontStack.pop() ?? font;
      }),
      createLinearGradient: vi.fn(() => gradient),
      translate: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arcTo: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      strokeText: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn(() => ({
        width: 36,
        actualBoundingBoxAscent: 10,
        actualBoundingBoxDescent: 3,
      })),
      getTransform: vi.fn(() => ({ a: 1 })),
      drawImage: vi.fn(),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      textBaseline: 'alphabetic',
    } as unknown as CanvasRenderingContext2D;
    const message: ChatMessage = {
      text: '',
      content: [],
      kind: 'superchat',
      timestamp: Date.now(),
      authorType: 'normal',
      superChat: { amount: '$5.00', tier: 'blue' },
    };
    const cachedBitmap = new MockOffscreenCanvas(1, 1);
    const cache = {
      get: vi.fn(() => cachedBitmap),
      set: vi.fn(),
    };

    renderPaidCard(
      ctx,
      message,
      180,
      56,
      0,
      0,
      0,
      SUPERCHAT_CARD_CONFIG,
      DEFAULT_SETTINGS,
      cache as never,
      cache as never,
      cache as never,
      cache as never,
      () => 'bold 32px sans-serif',
      new LruMap<string, CanvasGradient>(GRADIENT_CACHE_MAX)
    );

    expect(ctx.font).toBe('italic 12px serif');
  });
});
