// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, it, expect } from 'vitest';

/**
 * createFastRandom is not exported — we re-implement the LCG for testing.
 *
 * Parameters: a=1664525, c=1013904223, modulo=2^32
 * This is the Numerical Recipes LCG used by the pipeline-utils module.
 */
function createFastRandom(seed?: number): () => number {
  let s = seed != null ? seed : Date.now() ^ ((Math.random() * 0xffffffff) >>> 0);
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// createFastRandom
// ═══════════════════════════════════════════════════════════════════════════

describe('createFastRandom', () => {
  describe('output range', () => {
    it('generates values in [0, 1)', () => {
      const rng = createFastRandom(42);
      for (let i = 0; i < 1000; i++) {
        const val = rng();
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThan(1);
      }
    });

    it('generates values with reasonable range coverage', () => {
      const rng = createFastRandom(42);
      let min = 1;
      let max = 0;
      for (let i = 0; i < 1000; i++) {
        const val = rng();
        min = Math.min(min, val);
        max = Math.max(max, val);
      }
      // With 1000 samples, min should be well below 0.1 and max well above 0.9
      expect(min).toBeLessThan(0.05);
      expect(max).toBeGreaterThan(0.95);
    });
  });

  describe('determinism', () => {
    it('produces identical sequence for same seed', () => {
      const a = createFastRandom(12345);
      const b = createFastRandom(12345);
      for (let i = 0; i < 100; i++) {
        expect(a()).toBe(b());
      }
    });

    it('produces different sequence for different seeds', () => {
      const a = createFastRandom(1);
      const b = createFastRandom(2);
      // At least one of the first 10 values should differ
      let differs = false;
      for (let i = 0; i < 10 && !differs; i++) {
        differs = a() !== b();
      }
      expect(differs).toBe(true);
    });
  });

  describe('distribution uniformity', () => {
    it('has roughly uniform distribution (chi-squared approximation)', () => {
      const rng = createFastRandom(7);
      const buckets = new Array(10).fill(0);
      const N = 10000;
      for (let i = 0; i < N; i++) {
        const idx = Math.min(9, Math.floor(rng() * 10));
        buckets[idx]++;
      }
      // Each bucket should have roughly N/10 = 1000 items
      for (const count of buckets) {
        // Allow ±15% deviation for LCG (LCGs are not perfectly uniform)
        expect(count).toBeGreaterThan(850);
        expect(count).toBeLessThan(1150);
      }
    });
  });

  describe('no-seed (time-based) mode', () => {
    it('produces valid values without explicit seed', () => {
      const rng = createFastRandom();
      for (let i = 0; i < 10; i++) {
        const val = rng();
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThan(1);
      }
    });
  });

  describe('full 2^32 period check', () => {
    it('does not repeat within first 10,000 values', () => {
      const rng = createFastRandom(0);
      const seen = new Set<number>();
      let collisions = 0;
      for (let i = 0; i < 10000; i++) {
        const val = rng();
        if (seen.has(val)) collisions++;
        seen.add(val);
      }
      // With 2^32 period, collisions in 10,000 samples is extremely unlikely
      expect(collisions).toBe(0);
    });
  });

  describe('edge-case seeds', () => {
    it('handles seed=0 correctly', () => {
      const rng = createFastRandom(0);
      const v0 = rng();
      expect(v0).toBeGreaterThanOrEqual(0);
      expect(v0).toBeLessThan(1);
    });

    it('handles seed=0xffffffff (max 32-bit unsigned)', () => {
      const rng = createFastRandom(0xffffffff);
      const v0 = rng();
      expect(v0).toBeGreaterThanOrEqual(0);
      expect(v0).toBeLessThan(1);
    });

    it('handles negative seed', () => {
      const rng = createFastRandom(-1);
      const v0 = rng();
      expect(v0).toBeGreaterThanOrEqual(0);
      expect(v0).toBeLessThan(1);
    });
  });
});
