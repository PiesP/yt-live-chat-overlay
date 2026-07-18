// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { drawLeftRoundedRect } from '@renderer/canvas/card-renderers';

// ── Mock Canvas ──────────────────────────────────────────────────────

interface PathOp {
  name: string;
  args: unknown[];
}

function createMockCtx(): { ctx: CanvasRenderingContext2D; ops: PathOp[] } {
  const ops: PathOp[] = [];

  const ctx = {
    beginPath: vi.fn(() => { ops.push({ name: 'beginPath', args: [] }); }),
    closePath: vi.fn(() => { ops.push({ name: 'closePath', args: [] }); }),
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
