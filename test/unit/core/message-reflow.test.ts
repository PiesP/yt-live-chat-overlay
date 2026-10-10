// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { reconcileMessagePlacements, reflowMotionPlan } from '@renderer/layout/message-reflow';
import { computeMessageMotionPlan, motionPlansCollide } from '@renderer/layout/message-schedule';

const input = {
  mode: 'top' as const, now: 0, batchIndex: 0, previousStaggerDelayMs: 0,
  queueDepth: 0, staggerSample: 0, maxStaggerDelayMs: 0, mediumStaggerDelayMs: 0,
  placementWaitMs: 0, screenWidth: 640, messageWidth: 100, velocityPxPerSec: 350,
  scrollDurationMinMs: 5000, scrollDurationMaxMs: 30000, exitPaddingPx: 100,
  topBottomDurationMs: 5000, durationMultiplier: 1,
};
const options = {
  laneCount: 6, laneHeight: 20, viewportHeight: 120, safeTop: 0,
  mode: 'top' as const, headwayGapRatio: 0.08, now: 100,
};

describe('collision-aware message reflow', () => {
  it('finds the only free lane in a tall viewport before reporting capacity loss', () => {
    const motion = computeMessageMotionPlan(input);
    const candidates = Array.from({ length: 129 }, (_, laneIndex) => ({
      message: `retained-${laneIndex}`, laneIndex, height: 20, motion,
    })).filter((entry) => entry.laneIndex !== 64);
    candidates.push({ message: 'displaced', laneIndex: 129, height: 20, motion });
    const result = reconcileMessagePlacements(candidates, { ...options, laneCount: 129, viewportHeight: 2580 });
    expect(result.dropped).toEqual([]);
    expect(result.placements.find((p) => p.message === 'displaced')?.laneIndex).toBe(64);
  });
  it('moves two clipped fixed lanes into distinct legal blocks without changing future starts', () => {
    const future = computeMessageMotionPlan({ ...input, placementWaitMs: 1000 });
    const result = reconcileMessagePlacements([
      { message: 'eight', laneIndex: 8, height: 20, motion: future },
      { message: 'nine', laneIndex: 9, height: 20, motion: future },
    ], options);
    expect(result.dropped).toEqual([]);
    expect(result.placements.map((p) => p.laneIndex)).toEqual([0, 1]);
    expect(result.placements.map((p) => p.motion.startTime)).toEqual([1000, 1000]);
  });

  it('retains legal placements before searching for displaced messages', () => {
    const motion = computeMessageMotionPlan(input);
    const result = reconcileMessagePlacements([
      { message: 'displaced', laneIndex: 8, height: 20, motion },
      { message: 'retained', laneIndex: 0, height: 20, motion },
    ], options);
    expect(result.placements.find((p) => p.message === 'retained')?.laneIndex).toBe(0);
    expect(result.placements.find((p) => p.message === 'displaced')?.laneIndex).toBe(1);
  });

  it('reports capacity conflicts and oversized geometry instead of drawing overlaps', () => {
    const motion = computeMessageMotionPlan(input);
    const result = reconcileMessagePlacements([
      { message: 'retained', laneIndex: 0, height: 20, motion },
      { message: 'conflict', laneIndex: 1, height: 20, motion },
      { message: 'too-tall', laneIndex: 0, height: 21, motion },
    ], { ...options, laneCount: 1, viewportHeight: 20 });
    expect(result.placements.map((p) => p.message)).toEqual(['retained']);
    expect(result.dropped).toEqual([
      { message: 'too-tall', reason: 'oversized' },
      { message: 'conflict', reason: 'reflow_capacity' },
    ]);
  });

  it('checks all future multi-slot reservations across safe-zone and density changes', () => {
    const future = computeMessageMotionPlan({ ...input, placementWaitMs: 1000 });
    const result = reconcileMessagePlacements([
      { message: 'paid', laneIndex: 0, height: 39, motion: future },
      { message: 'translation', laneIndex: 3, height: 29, motion: future },
    ], { ...options, laneCount: 8, laneHeight: 10, safeTop: 0.1 });
    expect(result.placements).toHaveLength(2);
    const [first, second] = result.placements;
    expect(first && second && (first.y + first.height <= second.y || second.y + second.height <= first.y)).toBe(true);
    expect(result.placements.every((p) => p.y >= 12 && p.motion.startTime === 1000)).toBe(true);
  });

  it.each(['scroll', 'reverse'] as const)('preserves future geometric entry through %s resize', (mode) => {
    const previous = computeMessageMotionPlan({ ...input, mode, placementWaitMs: 1000, batchIndex: 5 });
    const next = computeMessageMotionPlan({ ...input, mode, screenWidth: 960 });
    const reconciled = reflowMotionPlan(previous, next, 100, 100);
    expect(reconciled.startTime).toBeGreaterThanOrEqual(previous.startTime);
    expect(reconciled.viewportEntryTime).toBeCloseTo(previous.viewportEntryTime);
  });

  it.each(['scroll', 'reverse'] as const)('preserves %s entry after motion starts outside the viewport', (mode) => {
    const previous = computeMessageMotionPlan({
      ...input, mode, batchIndex: 5, maxStaggerDelayMs: 1200,
      mediumStaggerDelayMs: 1200, staggerSample: 1,
    });
    const now = previous.startTime + 1;
    expect(previous.viewportEntryTime).toBeGreaterThan(now);
    const next = computeMessageMotionPlan({ ...input, mode, now, screenWidth: 960 });
    const reconciled = reflowMotionPlan(previous, next, now, 100);
    expect(reconciled.viewportEntryTime).toBeCloseTo(previous.viewportEntryTime);
    expect(reconciled.startTime).toBeGreaterThan(now);
  });

  it('retains safe same-lane scrolling sharing instead of reserving full lifetimes', () => {
    const leading = computeMessageMotionPlan({ ...input, mode: 'scroll', velocityPxPerSec: 200 });
    const following = computeMessageMotionPlan({ ...input, mode: 'scroll', placementWaitMs: 1000, velocityPxPerSec: 200 });
    expect(motionPlansCollide(leading, following, 0.08, 100)).toBe(false);
    const result = reconcileMessagePlacements([
      { message: 'lead', laneIndex: 0, height: 20, motion: leading },
      { message: 'follow', laneIndex: 0, height: 20, motion: following },
    ], { ...options, laneCount: 1 });
    expect(result.dropped).toEqual([]);
    expect(result.placements.map((p) => p.laneIndex)).toEqual([0, 0]);
  });
});
