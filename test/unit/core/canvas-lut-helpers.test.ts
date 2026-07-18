// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, it, expect } from 'vitest';
import { fastSin, computePulseAlpha } from '@renderer/canvas/lut-helpers';

// ═══════════════════════════════════════════════════════════════════════════
// fastSin
// ═══════════════════════════════════════════════════════════════════════════

describe('fastSin', () => {
  describe('output range', () => {
    it('returns values in [-1, 1]', () => {
      // Sample many points across the period
      for (let ms = 0; ms < 2000; ms += 50) {
        const val = fastSin(ms);
        expect(val).toBeGreaterThanOrEqual(-1);
        expect(val).toBeLessThanOrEqual(1);
      }
    });

    it('returns approximately 0 at t=0', () => {
      expect(fastSin(0)).toBeCloseTo(0, 1);
    });

    it('returns approximately 1 at quarter-cycle (t=500ms)', () => {
      expect(fastSin(500)).toBeCloseTo(1, 1);
    });

    it('returns approximately 0 at half-cycle (t=1000ms)', () => {
      expect(fastSin(1000)).toBeCloseTo(0, 1);
    });

    it('returns approximately -1 at three-quarter-cycle (t=1500ms)', () => {
      expect(fastSin(1500)).toBeCloseTo(-1, 1);
    });
  });

  describe('periodicity', () => {
    it('returns same value for t and t+2000', () => {
      for (const ms of [0, 100, 500, 750, 1200, 1800]) {
        expect(fastSin(ms)).toBe(fastSin(ms + 2000));
      }
    });

    it('returns same value for t and t+4000 (two cycles)', () => {
      for (const ms of [0, 100, 500]) {
        expect(fastSin(ms)).toBe(fastSin(ms + 4000));
      }
    });
  });

  describe('negative elapsed', () => {
    it('handles negative values (wraps correctly)', () => {
      // -500ms should be equivalent to 1500ms
      expect(fastSin(-500)).toBe(fastSin(1500));
    });
  });

  describe('large elapsed', () => {
    it('handles very large values without overflow', () => {
      expect(fastSin(1_000_000)).toBeGreaterThanOrEqual(-1);
      expect(fastSin(1_000_000)).toBeLessThanOrEqual(1);
    });
  });

  describe('accuracy vs Math.sin', () => {
    it('approximates Math.sin within tolerance', () => {
      // LUT with 256 entries has ~0.025 max error
      // Use loose tolerance since LUT is quantized
      for (let ms = 0; ms < 2000; ms += 100) {
        const lut = fastSin(ms);
        const real = Math.sin((ms / 2000) * 2 * Math.PI);
        expect(Math.abs(lut - real)).toBeLessThan(0.1);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// computePulseAlpha
// ═══════════════════════════════════════════════════════════════════════════

describe('computePulseAlpha', () => {
  it('returns baseAlpha at t=0 (sin(0)=0)', () => {
    expect(computePulseAlpha(0, 0.5, 0.3)).toBeCloseTo(0.5, 2);
  });

  it('returns baseAlpha + amplitude at peak (t=500ms, sin≈1)', () => {
    expect(computePulseAlpha(500, 0.5, 0.3)).toBeCloseTo(0.8, 1);
  });

  it('returns baseAlpha at zero-crossing (t=1000ms, sin≈0)', () => {
    expect(computePulseAlpha(1000, 0.5, 0.3)).toBeCloseTo(0.5, 2);
  });

  it('returns baseAlpha - amplitude at trough (t=1500ms, sin≈-1)', () => {
    expect(computePulseAlpha(1500, 0.5, 0.3)).toBeCloseTo(0.2, 1);
  });

  it('returns baseAlpha when amplitude is 0', () => {
    expect(computePulseAlpha(1234, 0.7, 0)).toBeCloseTo(0.7, 2);
  });

  it('returns 0 when baseAlpha=0 and amplitude=0', () => {
    expect(computePulseAlpha(999, 0, 0)).toBe(0);
  });

  it('can exceed 1.0 (caller should clamp)', () => {
    // baseAlpha=0.9 + amplitude=0.3 * sin≈1 = 1.2
    expect(computePulseAlpha(500, 0.9, 0.3)).toBeGreaterThan(1);
  });
});
