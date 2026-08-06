import { describe, expect, it } from 'vitest';
import {
  computeAdaptiveStaggerLimit,
  computeMessageMotionPlan,
} from '@renderer/layout/message-schedule';

const baseInput = {
  mode: 'scroll' as const,
  now: 1_000,
  batchIndex: 0,
  previousStaggerDelayMs: 0,
  queueDepth: 1,
  staggerSample: 1,
  maxStaggerDelayMs: 200,
  mediumStaggerDelayMs: 100,
  placementWaitMs: 0,
  screenWidth: 1_000,
  messageWidth: 200,
  velocityPxPerSec: 200,
  scrollDurationMinMs: 0,
  scrollDurationMaxMs: 20_000,
  exitPaddingPx: 100,
  topBottomDurationMs: 4_000,
  durationMultiplier: 1,
};

describe('computeAdaptiveStaggerLimit', () => {
  it('compacts the timing window continuously as queue pressure grows', () => {
    expect(computeAdaptiveStaggerLimit(0, 200, 100)).toBe(200);
    expect(computeAdaptiveStaggerLimit(15, 200, 100)).toBe(150);
    expect(computeAdaptiveStaggerLimit(30, 200, 100)).toBe(100);
    expect(computeAdaptiveStaggerLimit(40, 200, 100)).toBe(50);
    expect(computeAdaptiveStaggerLimit(50, 200, 100)).toBe(0);
    expect(computeAdaptiveStaggerLimit(500, 200, 100)).toBe(0);
  });
});

describe('computeMessageMotionPlan', () => {
  it('keeps the first committed message immediate', () => {
    expect(computeMessageMotionPlan(baseInput)).toMatchObject({
      staggerDelayMs: 0,
      startTime: 1_000,
    });
  });

  it('uses cumulative exponential gaps so batch order cannot reverse', () => {
    const second = computeMessageMotionPlan({
      ...baseInput,
      batchIndex: 1,
      previousStaggerDelayMs: 0,
      staggerSample: 2,
    });
    const third = computeMessageMotionPlan({
      ...baseInput,
      batchIndex: 2,
      previousStaggerDelayMs: second.staggerDelayMs,
      staggerSample: 0.1,
    });

    expect(second.staggerDelayMs).toBe(50);
    expect(third.staggerDelayMs).toBe(53);
    expect(third.startTime).toBeGreaterThan(second.startTime);
  });

  it('caps cumulative delay at the adaptive queue window', () => {
    const plan = computeMessageMotionPlan({
      ...baseInput,
      batchIndex: 3,
      queueDepth: 40,
      previousStaggerDelayMs: 45,
      staggerSample: 10,
    });

    expect(plan.staggerLimitMs).toBe(50);
    expect(plan.staggerDelayMs).toBe(50);
  });

  it('shares constant-velocity entry geometry for both scrolling directions', () => {
    const scroll = computeMessageMotionPlan({ ...baseInput, batchIndex: 2 });
    const reverse = computeMessageMotionPlan({ ...baseInput, mode: 'reverse', batchIndex: 2 });

    expect(scroll).toMatchObject({
      horizontalStaggerPx: 80,
      startX: 1_080,
      travelDistancePx: 1_380,
      durationMs: 6_900,
    });
    expect(reverse).toMatchObject({
      horizontalStaggerPx: 80,
      startX: -280,
      travelDistancePx: 1_380,
      durationMs: 6_900,
    });
  });

  it('applies the same temporal policy and safe centering to fixed modes', () => {
    const top = computeMessageMotionPlan({
      ...baseInput,
      mode: 'top',
      batchIndex: 1,
      placementWaitMs: 25,
    });
    const bottom = computeMessageMotionPlan({
      ...baseInput,
      mode: 'bottom',
      batchIndex: 1,
      placementWaitMs: 25,
    });
    const oversized = computeMessageMotionPlan({
      ...baseInput,
      mode: 'bottom',
      messageWidth: 1_200,
    });

    expect(top).toMatchObject({ startX: 400, durationMs: 4_000 });
    expect(bottom).toMatchObject({
      startX: 400,
      staggerDelayMs: top.staggerDelayMs,
      startTime: top.startTime,
      durationMs: 4_000,
    });
    expect(oversized.startX).toBe(0);
  });
});
