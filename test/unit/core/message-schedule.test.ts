import { describe, expect, it } from 'vitest';
import {
  computeAdaptiveStaggerLimit,
  computeMessageMotionPlan,
  messageXAtElapsed,
  messageXAtTime,
  motionPlanFromMessage,
  motionPlansCollide,
  resolveEffectiveMotionMode,
} from '@renderer/layout/message-schedule';
import {
  buildLaneHeap,
  commitPlacementShared,
  computeOccupancyMs,
  findPlacementShared,
} from '@renderer/layout/lane-shared';
import type { LaneAllocationState } from '@renderer/layout/lane-shared';

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

describe('committed motion and lane safety', () => {
  it.each(['scroll', 'reverse'] as const)(
    'detects a same-tier future follower catching a future predecessor in %s mode',
    (mode) => {
      const indexMap = new Map<number, number>();
      const state: LaneAllocationState = {
        heap: buildLaneHeap(2, 0, indexMap),
        indexMap,
        numLanes: 2,
        speedTierLanes: new Map(),
        collidedLanes: new Set(),
      };
      // An earlier reservation forces A to wait, while the other lane remains busy.
      commitPlacementShared(state, 0, 1, 0, 911, 911, 2);
      commitPlacementShared(state, 1, 1, 0, 2_418, 2_418, 2);
      const firstLane = findPlacementShared(state, 0, 20, 20, 30_000, 2, () => 0);
      expect(firstLane).toEqual({ laneIndex: 0, waitMs: 911 });
      const a = computeMessageMotionPlan({
        ...baseInput, mode, now: 0, screenWidth: 640, messageWidth: 100,
        batchIndex: 1, previousStaggerDelayMs: 0, staggerSample: 1,
        maxStaggerDelayMs: 200, mediumStaggerDelayMs: 100,
        placementWaitMs: firstLane!.waitMs, velocityPxPerSec: 350,
        scrollDurationMinMs: 5_000, scrollDurationMaxMs: 30_000,
      });
      const occupancy = computeOccupancyMs(a.durationMs, 100, 0.08, 100, 640, 40);
      commitPlacementShared(state, firstLane!.laneIndex, 1, a.startTime, occupancy, a.durationMs, 2);

      const secondLane = findPlacementShared(state, 0, 20, 20, 30_000, 2, () => 0);
      expect(secondLane?.laneIndex).toBe(0);
      const b = computeMessageMotionPlan({
        ...baseInput, mode, now: 0, screenWidth: 640, messageWidth: 600,
        batchIndex: 2, previousStaggerDelayMs: a.staggerDelayMs, staggerSample: 1,
        maxStaggerDelayMs: 200, mediumStaggerDelayMs: 100,
        placementWaitMs: secondLane!.waitMs, velocityPxPerSec: 350,
        scrollDurationMinMs: 5_000, scrollDurationMaxMs: 30_000,
      });
      expect(a.actualVelocityPxPerMs).toBeCloseTo(0.176);
      expect(b.actualVelocityPxPerMs).toBeCloseTo(0.284);
      expect(a.viewportEntryTime).toBeGreaterThan(0);
      expect(b.viewportEntryTime).toBeGreaterThan(0);
      expect(motionPlansCollide(a, b, 0.08, 0)).toBe(true);
      const activeA = motionPlanFromMessage({
        startTime: a.startTime, pausedDuration: 0, startX: a.startX,
        width: 100, duration: a.durationMs,
      }, mode, 640, 100);
      expect(motionPlansCollide(activeA, b, 0.08, 0)).toBe(true);
      expect(messageXAtTime(activeA, 2_000)).toBeCloseTo(messageXAtTime(a, 2_000));
    }
  );

  it('checks a visible predecessor against a future follower and preserves pause accounting', () => {
    const a = computeMessageMotionPlan({ ...baseInput, now: 0, screenWidth: 640,
      messageWidth: 100, velocityPxPerSec: 350, scrollDurationMinMs: 5_000 });
    const b = computeMessageMotionPlan({ ...baseInput, now: 1_000, screenWidth: 640,
      messageWidth: 600, velocityPxPerSec: 350, scrollDurationMinMs: 5_000 });
    expect(motionPlansCollide(a, b, 0.08, 500)).toBe(true);
    const paused = motionPlanFromMessage({ startTime: a.startTime, pausedDuration: 300,
      startX: a.startX, width: a.messageWidthPx, duration: a.durationMs },
      'scroll', 640, 100);
    expect(paused.startTime).toBe(a.startTime + 300);
    expect(paused.viewportEntryTime).toBe(a.viewportEntryTime + 300);
  });

  it('uses final duration including author multiplier in safety', () => {
    const ordinary = computeMessageMotionPlan({ ...baseInput, now: 0, screenWidth: 960,
      messageWidth: 100, velocityPxPerSec: 350, scrollDurationMinMs: 5_000 });
    const author = computeMessageMotionPlan({ ...baseInput, now: 0, screenWidth: 960,
      messageWidth: 800, velocityPxPerSec: 350, scrollDurationMinMs: 5_000,
      durationMultiplier: 1.5 });
    expect(ordinary.actualVelocityPxPerMs).toBeCloseTo(0.232);
    expect(author.actualVelocityPxPerMs).toBeCloseTo(0.35 / 1.5);
    expect(author.actualVelocityPxPerMs).toBeCloseTo(author.travelDistancePx / author.durationMs);
  });

  it('uses stationary geometry and occupancy when reduced motion is effective', () => {
    expect(resolveEffectiveMotionMode('scroll', true, false)).toBe('top');
    expect(resolveEffectiveMotionMode('reverse', true, false)).toBe('top');
    expect(resolveEffectiveMotionMode('bottom', true, false)).toBe('bottom');
    expect(resolveEffectiveMotionMode('scroll', true, true)).toBe('scroll');
    expect(resolveEffectiveMotionMode('scroll', false, false)).toBe('scroll');
    const mode = resolveEffectiveMotionMode('scroll', true, false);
    const a = computeMessageMotionPlan({ ...baseInput, mode, now: 0,
      screenWidth: 960, messageWidth: 100, topBottomDurationMs: 5_800 });
    const b = computeMessageMotionPlan({ ...baseInput, mode, now: 600,
      screenWidth: 960, messageWidth: 100, topBottomDurationMs: 5_800 });
    expect(messageXAtTime(a, 3_000)).toBe(430);
    expect(messageXAtElapsed(mode, a.startX, 100, 960, 100, 3_000, a.durationMs)).toBe(430);
    expect(motionPlansCollide(a, b, 0.08)).toBe(true);
    expect(motionPlansCollide(a, b, 0.08, 5_800)).toBe(false);
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
