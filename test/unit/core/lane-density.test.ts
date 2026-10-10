// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it } from 'vitest';
import { LaneAllocator } from '@renderer/layout/lane-allocator';
import { getRegularRowHeight, getRowSlotCount } from '@renderer/layout/row-geometry';

const baseOptions = { safeTop: 0, safeBottom: 0, fontSize: 32, fontWeight: 'bold' as const, fontFamily: 'sans-serif', laneSpacing: 6, outlineWidthPx: 2, headwayGapRatio: 0.08, exitPaddingPx: 100, scrollDurationMaxMs: 30000 };

describe('production density grid', () => {
  it('refines the grid without claiming extra ordinary-row capacity or wasting pitch', () => {
    const height = getRegularRowHeight(32, 'bold', 'sans-serif', 2);
    const lanes = [1, 0.75, 0.5].map((factor) => {
      const allocator = new LaneAllocator({ ...baseOptions, laneDensityFactor: factor });
      allocator.reset({ width: 1920, height: 1080 }, 0);
      return allocator;
    });
    const normal = lanes[0];
    if (!normal) throw new Error('normal grid missing');
    for (const allocator of lanes) {
      const slots = getRowSlotCount(height, allocator.getLaneHeight(), 6);
      expect(slots * allocator.getLaneHeight()).toBeCloseTo(height + 6);
      expect(Math.floor(allocator.getLaneCount() / slots)).toBe(normal.getLaneCount());
    }
    expect(lanes[1]?.getLaneHeight()).toBeCloseTo(normal.getLaneHeight() / 2);
    expect(lanes[2]?.getLaneHeight()).toBeCloseTo(normal.getLaneHeight() / 4);
  });

  it('reduces genuine tall-content rounding at finer grid densities', () => {
    const base = getRegularRowHeight(32, 'bold', 'sans-serif', 2);
    const tallHeight = base * 1.2;
    let previous = Number.POSITIVE_INFINITY;
    for (const factor of [1, 0.75, 0.5]) {
      const allocator = new LaneAllocator({ ...baseOptions, laneDensityFactor: factor });
      allocator.reset({ width: 1920, height: 1080 }, 0);
      const reserved = getRowSlotCount(tallHeight, allocator.getLaneHeight(), 6) * allocator.getLaneHeight();
      expect(reserved).toBeGreaterThanOrEqual(tallHeight + 6);
      expect(reserved).toBeLessThanOrEqual(previous);
      previous = reserved;
    }
  });

  it('bounds grid work to four subdivisions at large viewports and the minimum font', () => {
    const normal = new LaneAllocator({ ...baseOptions, fontSize: 14, laneSpacing: 0, laneDensityFactor: 1 });
    const dense = new LaneAllocator({ ...baseOptions, fontSize: 14, laneSpacing: 0, laneDensityFactor: 0.5 });
    const dimensions = { width: 7680, height: 4320 };
    normal.reset(dimensions, 0); dense.reset(dimensions, 0);
    expect(dense.getLaneCount()).toBeLessThanOrEqual(4 * normal.getLaneCount() + 3);
    expect(dense.snapshot().heap).toHaveLength(dense.getLaneCount());
  });
});
