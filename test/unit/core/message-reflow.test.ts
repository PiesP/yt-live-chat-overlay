// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { reconcileMessagePlacements, reflowMotionPlan } from '@renderer/layout/message-reflow';
import { computeMessageMotionPlan, motionPlansCollide } from '@renderer/layout/message-schedule';
import { getRowGridHeight, getRowSlotCount } from '@renderer/layout/row-geometry';

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
  it('keeps configured clearance between mixed-height fixed messages after density reflow', () => {
    const motion = computeMessageMotionPlan({ ...input, mode: 'top' });
    const gap = 8;
    const result = reconcileMessagePlacements([
      { message: 'tall', laneIndex: 0, height: 46, motion },
      { message: 'ordinary', laneIndex: 4, height: 44, motion },
    ], {
      ...options,
      now: 1000,
      laneCount: 12,
      laneHeight: getRowGridHeight(44, gap, 0.5),
      laneSpacing: gap,
      viewportHeight: 156,
    });
    expect(result.dropped).toEqual([]);
    const [tall, ordinary] = result.placements;
    expect(tall && ordinary).toBeDefined();
    if (!tall || !ordinary) return;
    expect(ordinary.y - (tall.y + tall.height)).toBeGreaterThanOrEqual(gap);
    expect(tall.laneIndex).toBe(0);
    expect(ordinary.laneIndex).toBe(5);
    expect([tall.slotCount, ordinary.slotCount]).toEqual([5, 4]);
  });

  it.each([0, 1, 8, 20])('keeps gap %i across density, rounding, and above/below neighbors', (gap) => {
    const motion = computeMessageMotionPlan({ ...input, mode: 'top' });
    for (const density of [1, 0.75, 0.5]) {
      const laneHeight = getRowGridHeight(44, gap, density);
      for (const [firstHeight, secondHeight] of [[44, 44], [46, 44], [44, 46], [54, 44]] as const) {
        for (const placeAbove of [false, true]) {
          const firstLane = placeAbove ? 5 : 0;
          const secondLane = placeAbove ? 0 : 4;
          const result = reconcileMessagePlacements([
            { message: 'first', laneIndex: firstLane, height: firstHeight, motion },
            { message: 'second', laneIndex: secondLane, height: secondHeight, motion },
          ], {
            ...options, now: 1000, laneCount: 24, laneHeight, laneSpacing: gap,
            viewportHeight: 24 * laneHeight,
          });
          expect(result.dropped).toEqual([]);
          const [first, second] = result.placements;
          expect(first?.laneIndex).toBe(firstLane);
          if (!first || !second) continue;
          const clearance = first.y < second.y
            ? second.y - (first.y + first.height)
            : first.y - (second.y + second.height);
          expect(clearance, `gap=${gap} density=${density} heights=${firstHeight}/${secondHeight} above=${placeAbove}`).toBeGreaterThanOrEqual(gap);
        }
      }
    }
  });

  it.each([0, 1, 8, 20])('keeps exactly one gap %i between ordinary adjacent rows', (gap) => {
    const motion = computeMessageMotionPlan({ ...input, mode: 'top' });
    for (const density of [1, 0.75, 0.5]) {
      const laneHeight = getRowGridHeight(44, gap, density);
      const slots = getRowSlotCount(44, laneHeight, gap);
      const result = reconcileMessagePlacements([
        { message: 'first', laneIndex: 0, height: 44, motion },
        { message: 'second', laneIndex: slots, height: 44, motion },
      ], {
        ...options, now: 1000, laneCount: 12, laneHeight, laneSpacing: gap,
        viewportHeight: 12 * laneHeight,
      });
      expect(result.dropped).toEqual([]);
      const [first, second] = result.placements;
      expect(second?.laneIndex).toBe(slots);
      expect(second && first && second.y - (first.y + first.height)).toBeCloseTo(gap);
    }
  });

  it('preserves a legal alternative and reports capacity only when none fits', () => {
    const motion = computeMessageMotionPlan({ ...input, mode: 'top' });
    const candidates = [
      { message: 'retained', laneIndex: 0, height: 46, motion },
      { message: 'displaced', laneIndex: 4, height: 44, motion },
    ];
    const geometry = {
      ...options, now: 1000, laneHeight: 13, laneSpacing: 8,
      viewportHeight: 156,
    };
    const legal = reconcileMessagePlacements(candidates, { ...geometry, laneCount: 12 });
    expect(legal.dropped).toEqual([]);
    expect(legal.placements.map(({ message, laneIndex, slotCount }) => ({ message, laneIndex, slotCount }))).toEqual([
      { message: 'retained', laneIndex: 0, slotCount: 5 },
      { message: 'displaced', laneIndex: 5, slotCount: 4 },
    ]);
    const impossible = reconcileMessagePlacements(candidates, { ...geometry, laneCount: 8 });
    expect(impossible.placements.map(({ message }) => message)).toEqual(['retained']);
    expect(impossible.dropped).toEqual([{ message: 'displaced', reason: 'reflow_capacity' }]);
  });

  it('retains same-row sharing when fixed lifetimes do not overlap', () => {
    const first = computeMessageMotionPlan({ ...input, mode: 'top' });
    const future = computeMessageMotionPlan({ ...input, mode: 'top', placementWaitMs: 6000 });
    const result = reconcileMessagePlacements([
      { message: 'past', laneIndex: 0, height: 46, motion: first },
      { message: 'future', laneIndex: 0, height: 44, motion: future },
    ], { ...options, laneCount: 5, laneHeight: 13, laneSpacing: 8, now: 1000 });
    expect(result.dropped).toEqual([]);
    expect(result.placements.map(({ laneIndex }) => laneIndex)).toEqual([0, 0]);
    expect(result.placements[1]?.motion.startTime).toBe(6000);
  });

  it.each(['scroll', 'reverse'] as const)('keeps positive clearance in %s while sharing a row for separated motion', (mode) => {
    const simultaneous = computeMessageMotionPlan({ ...input, mode, velocityPxPerSec: 200 });
    const following = computeMessageMotionPlan({
      ...input, mode, placementWaitMs: 1000, velocityPxPerSec: 200,
    });
    const geometry = {
      ...options, mode, laneCount: 12, laneHeight: 13, laneSpacing: 8,
      viewportHeight: 156, now: 1000,
    };
    const colliding = reconcileMessagePlacements([
      { message: 'first', laneIndex: 0, height: 46, motion: simultaneous },
      { message: 'second', laneIndex: 4, height: 44, motion: simultaneous },
    ], geometry);
    expect(colliding.dropped).toEqual([]);
    const [first, second] = colliding.placements;
    expect(second && first && second.y - (first.y + first.height)).toBeGreaterThanOrEqual(8);
    const separated = reconcileMessagePlacements([
      { message: 'first', laneIndex: 0, height: 46, motion: simultaneous },
      { message: 'following', laneIndex: 0, height: 44, motion: following },
    ], { ...geometry, laneCount: 5 });
    expect(separated.dropped).toEqual([]);
    expect(separated.placements.map(({ laneIndex }) => laneIndex)).toEqual([0, 0]);
  });

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
