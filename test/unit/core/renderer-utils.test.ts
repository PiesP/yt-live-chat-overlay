import { describe, it, expect } from 'vitest';
import { computeScrollDuration } from '@util/design-tokens';

// ── computeScrollDuration ────────────────────────────────────────

describe('computeScrollDuration', () => {
  it('returns minimum duration for NaN totalDistance', () => {
    const result = computeScrollDuration(NaN, 250, 3000, 15000, 100);
    expect(result).toBe(3000);
  });

  it('returns minimum duration for NaN velocity', () => {
    const result = computeScrollDuration(2000, NaN, 3000, 15000, 100);
    expect(result).toBe(3000);
  });

  it('returns minimum duration for zero velocity', () => {
    const result = computeScrollDuration(2000, 0, 3000, 15000, 100);
    expect(result).toBe(3000);
  });

  it('returns minimum duration for negative velocity', () => {
    const result = computeScrollDuration(2000, -50, 3000, 15000, 100);
    expect(result).toBe(3000);
  });

  it('clamps to minimum duration for short distances', () => {
    // Short distance: (100 / 250) * 1000 = 400ms, less than min 3000
    const result = computeScrollDuration(200, 250, 3000, 15000, 100);
    // velocityFloor = max(3000, (100/250)*1000=400) = 3000
    expect(result).toBe(3000);
  });

  it('clamps to maximum duration for very long distances', () => {
    // Very long distance: (50000 / 250) * 1000 = 200000ms
    const result = computeScrollDuration(50000, 250, 3000, 15000, 100);
    // velocityFloor = max(3000, 400) = 3000
    // Math.min(15000, 200000) = 15000
    expect(result).toBe(15000);
  });

  it('computes normal scroll duration within bounds', () => {
    // totalDistance = 2000px, velocity = 250px/s
    // velocityFloor = max(3000, (100/250)*1000=400) = 3000
    // duration = (2000/250)*1000 = 8000ms
    // max(3000, min(15000, 8000)) = 8000
    const result = computeScrollDuration(2000, 250, 3000, 15000, 100);
    expect(result).toBe(8000);
  });

  it('velocity-aware floor kicks in when exitPadding/velocity is large', () => {
    // Large exit padding relative to velocity
    // velocityFloor = max(3000, (400/100)*1000=4000) = 4000
    // raw duration = (500/100)*1000 = 5000
    // max(4000, min(15000, 5000)) = max(4000, 5000) = 5000
    const result = computeScrollDuration(500, 100, 3000, 15000, 400);
    expect(result).toBe(5000);
  });
});
