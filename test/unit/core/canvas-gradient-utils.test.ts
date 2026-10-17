// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { LruMap } from '@piesp/browser-core/util';
import { type GradientContext, getCachedGradient } from '@renderer/canvas/gradient-utils';
import { GRADIENT_CACHE_MAX } from '@renderer/constants';
import { beforeEach, describe, expect, it } from 'vite-plus/test';

// ── Mock CanvasGradient ──────────────────────────────────────────────

interface ColorStop {
  offset: number;
  color: string;
}

class MockCanvasGradient {
  stops: ColorStop[] = [];
  addColorStop(offset: number, color: string): void {
    this.stops.push({ offset, color });
  }
}

// ── Mock GradientContext ─────────────────────────────────────────────

function createMockCtx(): GradientContext & { createdGradients: MockCanvasGradient[] } {
  const createdGradients: MockCanvasGradient[] = [];
  return {
    createdGradients,
    createLinearGradient(_x0: number, _y0: number, _x1: number, _y1: number): CanvasGradient {
      const grad = new MockCanvasGradient();
      createdGradients.push(grad);
      return grad as unknown as CanvasGradient;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// getCachedGradient
// ═══════════════════════════════════════════════════════════════════════════

describe('getCachedGradient', () => {
  let cache: LruMap<string, CanvasGradient>;
  let ctx: GradientContext & { createdGradients: MockCanvasGradient[] };

  beforeEach(() => {
    cache = new LruMap(GRADIENT_CACHE_MAX);
    ctx = createMockCtx();
  });

  describe('gradient creation', () => {
    it('creates a gradient with correct color stops', () => {
      const grad = getCachedGradient(ctx, cache, 'rgb(255,0,0)', 100, 0.5, 0.3, 0.1);
      expect(grad).toBeDefined();
      expect(ctx.createdGradients).toHaveLength(1);
      const stops = ctx.createdGradients[0]!.stops;
      expect(stops).toHaveLength(3);
      expect(stops[0]).toEqual({ offset: 0, color: 'rgba(255, 0, 0, 0.5)' });
      expect(stops[1]).toEqual({ offset: 0.48, color: 'rgba(255, 0, 0, 0.3)' });
      expect(stops[2]).toEqual({ offset: 1, color: 'rgba(255, 0, 0, 0.1)' });
    });
  });

  describe('caching', () => {
    it('returns the same gradient for identical key', () => {
      const g1 = getCachedGradient(ctx, cache, 'rgb(255,0,0)', 100, 0.5, 0.3, 0.1);
      const g2 = getCachedGradient(ctx, cache, 'rgb(255,0,0)', 100, 0.5, 0.3, 0.1);
      expect(g1).toBe(g2);
      // Only one gradient created
      expect(ctx.createdGradients).toHaveLength(1);
    });

    it('returns different gradients for different baseColor', () => {
      const g1 = getCachedGradient(ctx, cache, 'rgb(255,0,0)', 100, 0.5, 0.3, 0.1);
      const g2 = getCachedGradient(ctx, cache, 'rgb(0,255,0)', 100, 0.5, 0.3, 0.1);
      expect(g1).not.toBe(g2);
    });

    it('returns different gradients for different height', () => {
      const g1 = getCachedGradient(ctx, cache, 'rgb(255,0,0)', 100, 0.5, 0.3, 0.1);
      const g2 = getCachedGradient(ctx, cache, 'rgb(255,0,0)', 200, 0.5, 0.3, 0.1);
      expect(g1).not.toBe(g2);
    });

    it('returns different gradients for different alpha values', () => {
      const g1 = getCachedGradient(ctx, cache, 'rgb(255,0,0)', 100, 0.5, 0.3, 0.1);
      const g2 = getCachedGradient(ctx, cache, 'rgb(255,0,0)', 100, 0.9, 0.3, 0.1);
      expect(g1).not.toBe(g2);
    });

    it('does not reuse gradients from another rendering context after reset', () => {
      const first = getCachedGradient(ctx, cache, 'rgb(255,0,0)', 100, 0.5, 0.3, 0.1);
      cache.clear();
      const nextCtx = createMockCtx();
      const second = getCachedGradient(nextCtx, cache, 'rgb(255,0,0)', 100, 0.5, 0.3, 0.1);
      expect(second).not.toBe(first);
      expect(nextCtx.createdGradients).toHaveLength(1);
    });
  });

  describe('LRU eviction', () => {
    it('evicts oldest entry when cache exceeds GRADIENT_CACHE_MAX', () => {
      // Fill cache to capacity
      for (let i = 0; i < GRADIENT_CACHE_MAX; i++) {
        getCachedGradient(ctx, cache, `rgb(${i},0,0)`, 100, 0.5, 0.3, 0.1);
      }
      expect(cache.size).toBe(GRADIENT_CACHE_MAX);

      const oldestKey = 'rgb(0,0,0)|100|0.5|0.3|0.1';
      expect(cache.has(oldestKey)).toBe(true);

      // Add one more — should evict oldest
      getCachedGradient(ctx, cache, 'rgb(999,0,0)', 100, 0.5, 0.3, 0.1);

      expect(cache.size).toBe(GRADIENT_CACHE_MAX);
      expect(cache.has(oldestKey)).toBe(false);
    });

    it('promotes a reused gradient before the capacity boundary', () => {
      const first = getCachedGradient(ctx, cache, 'rgb(0,0,0)', 100, 0.5, 0.3, 0.1);
      for (let i = 1; i < GRADIENT_CACHE_MAX; i++) {
        getCachedGradient(ctx, cache, `rgb(${i},0,0)`, 100, 0.5, 0.3, 0.1);
      }

      expect(getCachedGradient(ctx, cache, 'rgb(0,0,0)', 100, 0.5, 0.3, 0.1)).toBe(first);
      getCachedGradient(ctx, cache, 'rgb(999,0,0)', 100, 0.5, 0.3, 0.1);

      expect(cache.size).toBe(GRADIENT_CACHE_MAX);
      expect(cache.has('rgb(0,0,0)|100|0.5|0.3|0.1')).toBe(true);
      expect(cache.has('rgb(1,0,0)|100|0.5|0.3|0.1')).toBe(false);
    });

    it('does not evict when under capacity', () => {
      for (let i = 0; i < GRADIENT_CACHE_MAX - 1; i++) {
        getCachedGradient(ctx, cache, `rgb(${i},0,0)`, 100, 0.5, 0.3, 0.1);
      }
      expect(cache.size).toBe(GRADIENT_CACHE_MAX - 1);
    });
  });
});
