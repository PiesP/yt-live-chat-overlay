// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, it, expect } from 'vitest';
import {
  calculateAdaptiveDelay,
  computeBurstAdjustedMs,
  computeDensityAdjustedMs,
  computeErrorBackoffMs,
  DENSITY_HIGH_THRESHOLD,
  DENSITY_WINDOW_SIZE,
  EXTREME_DENSITY_THRESHOLD,
  recordDensitySample,
  type DensityConfig,
} from '@chat/live-poll-math';

const TEST_LIMITS: DensityConfig = {
  minPollIntervalMs: 200,
  maxPollIntervalMs: 5000,
};

// ═══════════════════════════════════════════════════════════════════════════
// recordDensitySample
// ═══════════════════════════════════════════════════════════════════════════

describe('recordDensitySample', () => {
  it('records first sample at write position 0', () => {
    const ring = new Uint16Array(DENSITY_WINDOW_SIZE);
    const result = recordDensitySample(ring, 0, 0, 42);
    expect(result.write).toBe(1);
    expect(result.filled).toBe(1);
    expect(ring[0]).toBe(42);
  });

  it('fills up the ring and wraps around', () => {
    const ring = new Uint16Array(DENSITY_WINDOW_SIZE);
    let write = 0;
    let filled = 0;

    for (let i = 0; i < DENSITY_WINDOW_SIZE; i++) {
      ({ write, filled } = recordDensitySample(ring, write, filled, i * 10));
    }
    expect(filled).toBe(DENSITY_WINDOW_SIZE);
    expect(write).toBe(0); // wrapped around

    // Next write overwrites oldest
    ({ write, filled } = recordDensitySample(ring, write, filled, 99));
    expect(filled).toBe(DENSITY_WINDOW_SIZE);
    expect(write).toBe(1);
    expect(ring[0]).toBe(99);
  });

  it('caps filled at window size', () => {
    const ring = new Uint16Array(DENSITY_WINDOW_SIZE);
    // Simulate already full state
    let result = recordDensitySample(ring, 2, DENSITY_WINDOW_SIZE, 1);
    expect(result.filled).toBe(DENSITY_WINDOW_SIZE);
  });

  it('does not mutate filled beyond window size', () => {
    const ring = new Uint16Array(DENSITY_WINDOW_SIZE);
    for (let i = 0; i < 100; i++) {
      const r = recordDensitySample(ring, i % DENSITY_WINDOW_SIZE, Math.min(i, DENSITY_WINDOW_SIZE), 1);
      expect(r.filled).toBeLessThanOrEqual(DENSITY_WINDOW_SIZE);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// computeErrorBackoffMs
// ═══════════════════════════════════════════════════════════════════════════

describe('computeErrorBackoffMs', () => {
  it('returns null when no errors', () => {
    expect(computeErrorBackoffMs(2000, 0, TEST_LIMITS)).toBeNull();
  });

  it('returns backoff for 1 consecutive error', () => {
    const result = computeErrorBackoffMs(2000, 1, TEST_LIMITS);
    // delayed = 2000 * 2^1 = 4000
    expect(result).toBe(4000);
  });

  it('returns backoff for 2 consecutive errors', () => {
    const result = computeErrorBackoffMs(2000, 2, TEST_LIMITS);
    // delayed = 2000 * 2^2 = 8000 → clamped to maxPollIntervalMs(5000)
    expect(result).toBe(5000);
  });

  it('clamps to maxPollIntervalMs', () => {
    const result = computeErrorBackoffMs(2000, 5, TEST_LIMITS);
    // delayed = 2000 * 2^5 = 64000 → clamped to 5000
    expect(result).toBe(5000);
  });

  it('clamps to minPollIntervalMs', () => {
    const result = computeErrorBackoffMs(10, 1, TEST_LIMITS);
    // delayed = 10 * 2^1 = 20 → clamped to min(200)
    expect(result).toBe(200);
  });

  it('handles very small fallback with consecutive errors', () => {
    const result = computeErrorBackoffMs(1, 3, TEST_LIMITS);
    // delayed = 1 * 2^3 = 8 → clamped to min(200)
    expect(result).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// computeBurstAdjustedMs
// ═══════════════════════════════════════════════════════════════════════════

describe('computeBurstAdjustedMs', () => {
  it('returns null when EMA rate is undefined', () => {
    expect(computeBurstAdjustedMs(2000, undefined, TEST_LIMITS)).toBeNull();
  });

  it('returns 0 for extreme density', () => {
    expect(computeBurstAdjustedMs(2000, EXTREME_DENSITY_THRESHOLD, TEST_LIMITS)).toBe(0);
    expect(computeBurstAdjustedMs(2000, 100, TEST_LIMITS)).toBe(0);
  });

  it('returns reduced delay for high density', () => {
    const result = computeBurstAdjustedMs(2000, DENSITY_HIGH_THRESHOLD, TEST_LIMITS);
    // clampedFallback = min(5000, 2000) = 2000
    // result = max(200, round(2000 * 0.3)) = max(200, 600) = 600
    expect(result).toBe(600);
  });

  it('returns reduced delay above high threshold', () => {
    const result = computeBurstAdjustedMs(2000, 15, TEST_LIMITS);
    // 15 >= 10 (HIGH): round(2000 * 0.3) = 600
    expect(result).toBe(600);
  });

  it('returns null when rate is between low and high', () => {
    const result = computeBurstAdjustedMs(2000, 5, TEST_LIMITS);
    // 5 >= 1 (LOW) but 5 < 10 (HIGH) and 5 < 30 (EXTREME) → null
    expect(result).toBeNull();
  });

  it('clamps reduced delay to minPollIntervalMs', () => {
    const result = computeBurstAdjustedMs(100, DENSITY_HIGH_THRESHOLD, TEST_LIMITS);
    // min(5000, 100) = 100, round(100 * 0.3) = 30, max(200, 30) = 200
    expect(result).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// computeDensityAdjustedMs
// ═══════════════════════════════════════════════════════════════════════════

describe('computeDensityAdjustedMs', () => {
  it('returns clamped fallback when not enough samples (< 2)', () => {
    const ring = new Uint16Array(DENSITY_WINDOW_SIZE);
    ring[0] = 50;
    const result = computeDensityAdjustedMs(2000, ring, 1, TEST_LIMITS);
    // fallback = min(5000, 2000) = 2000, max(200, 2000) = 2000
    expect(result).toBe(2000);
  });

  it('returns 0 for extreme average density', () => {
    const ring = new Uint16Array(DENSITY_WINDOW_SIZE);
    ring[0] = 40;
    ring[1] = 40;
    ring[2] = 40;
    const result = computeDensityAdjustedMs(2000, ring, 3, TEST_LIMITS);
    // avg = 120/3 = 40 >= 30 → return 0
    expect(result).toBe(0);
  });

  it('reduces delay for high average density', () => {
    const ring = new Uint16Array(DENSITY_WINDOW_SIZE);
    ring[0] = 12;
    ring[1] = 12;
    ring[2] = 12;
    const result = computeDensityAdjustedMs(2000, ring, 3, TEST_LIMITS);
    // avg = 12 >= 10 (HIGH): base = 2000, round(2000 * 0.3) = 600
    // result = max(200, min(5000, 600)) = 600
    expect(result).toBe(600);
  });

  it('increases delay for low average density', () => {
    const ring = new Uint16Array(DENSITY_WINDOW_SIZE);
    ring[0] = 0;
    ring[1] = 0;
    ring[2] = 0;
    const result = computeDensityAdjustedMs(2000, ring, 3, TEST_LIMITS);
    // avg = 0 <= 1 (LOW): base = 2000, round(2000 * 1.2) = 2400
    // result = max(200, min(5000, 2400)) = 2400
    expect(result).toBe(2400);
  });

  it('returns unchanged delay for normal density', () => {
    const ring = new Uint16Array(DENSITY_WINDOW_SIZE);
    ring[0] = 3;
    ring[1] = 4;
    ring[2] = 5;
    const result = computeDensityAdjustedMs(2000, ring, 3, TEST_LIMITS);
    // avg = 4, 1 < 4 < 10: no adjustment → base = 2000
    expect(result).toBe(2000);
  });

  it('handles full ring with normal density', () => {
    const ring = new Uint16Array(DENSITY_WINDOW_SIZE);
    for (let i = 0; i < DENSITY_WINDOW_SIZE; i++) {
      ring[i] = 5;
    }
    const result = computeDensityAdjustedMs(2000, ring, DENSITY_WINDOW_SIZE, TEST_LIMITS);
    expect(result).toBe(2000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// calculateAdaptiveDelay
// ═══════════════════════════════════════════════════════════════════════════

describe('calculateAdaptiveDelay', () => {
  it('uses timeoutMs as fallback when > 0', () => {
    const ring = new Uint16Array(DENSITY_WINDOW_SIZE);
    ring[0] = 5; ring[1] = 5;
    // no errors, no EMA, normal density → timeoutMs(3000) used as fallback
    const result = calculateAdaptiveDelay(3000, 2000, 0, undefined, ring, 2, TEST_LIMITS);
    // fallback = timeoutMs=3000 (timeoutMs > 0 takes priority over livePollFallbackMs)
    expect(result).toBe(3000);
  });

  it('uses livePollFallbackMs when timeoutMs is 0', () => {
    const ring = new Uint16Array(DENSITY_WINDOW_SIZE);
    ring[0] = 5; ring[1] = 5;
    const result = calculateAdaptiveDelay(0, 2000, 0, undefined, ring, 2, TEST_LIMITS);
    expect(result).toBe(2000); // fallback = livePollFallbackMs=2000, density adjusted
  });

  it('error backoff takes priority over burst and density', () => {
    const ring = new Uint16Array(DENSITY_WINDOW_SIZE);
    ring[0] = 40; ring[1] = 40; // extreme density → would return 0
    // But error backoff should take priority
    const result = calculateAdaptiveDelay(2000, 2000, 3, undefined, ring, 2, TEST_LIMITS);
    // delayed = 2000 * 2^3 = 16000 → clamped to 5000
    expect(result).toBe(5000);
  });

  it('burst reactivity takes priority over density adaptation', () => {
    const ring = new Uint16Array(DENSITY_WINDOW_SIZE);
    ring[0] = 5; ring[1] = 5; // normal density → 2000
    // EMA rate at high → burst takes priority
    const result = calculateAdaptiveDelay(2000, 2000, 0, DENSITY_HIGH_THRESHOLD, ring, 2, TEST_LIMITS);
    expect(result).toBe(600); // burst adjusted (not density adjusted)
  });

  it('falls through to density adaptation when no errors or burst', () => {
    const ring = new Uint16Array(DENSITY_WINDOW_SIZE);
    ring[0] = 2; ring[1] = 3;
    const result = calculateAdaptiveDelay(2000, 2000, 0, undefined, ring, 2, TEST_LIMITS);
    // avg = 2.5: normal density → base unchanged
    expect(result).toBe(2000);
  });

  it('returns 0 when extreme burst is active', () => {
    const ring = new Uint16Array(DENSITY_WINDOW_SIZE);
    ring[0] = 5; ring[1] = 5;
    const result = calculateAdaptiveDelay(2000, 2000, 0, EXTREME_DENSITY_THRESHOLD, ring, 2, TEST_LIMITS);
    expect(result).toBe(0);
  });

  it('handles negative timeoutMs (uses livePollFallbackMs)', () => {
    const ring = new Uint16Array(DENSITY_WINDOW_SIZE);
    ring[0] = 5; ring[1] = 5;
    const result = calculateAdaptiveDelay(-1, 2000, 0, undefined, ring, 2, TEST_LIMITS);
    expect(result).toBe(2000);
  });
});
