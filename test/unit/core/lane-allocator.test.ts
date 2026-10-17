import type { OverlayDimensions } from '@app-types';
import { SPEED_TIER } from '@renderer/constants';
import {
  LaneAllocator,
  type LaneAllocatorOptions,
  type LaneAllocatorSnapshot,
} from '@renderer/layout/lane-allocator';
import {
  commitPlacementShared,
  computeOccupancyMs,
  findPlacementShared,
  type LaneAllocationState,
  type LaneSelectionStrategy,
} from '@renderer/layout/lane-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// ── Helpers ───────────────────────────────────────────────────────────────

const defaultOptions: LaneAllocatorOptions = {
  safeTop: 0.05,
  safeBottom: 0.05,
  fontSize: 16,
  fontWeight: 'normal',
  fontFamily: 'sans-serif',
  laneSpacing: 4,
  headwayGapRatio: 0.08,
  exitPaddingPx: 100,
  scrollDurationMaxMs: 15000,
  laneDensityFactor: 1.0,
};

const defaultDimensions: OverlayDimensions = {
  width: 1920,
  height: 1080,
};

function stateFromSnapshot(snapshot: LaneAllocatorSnapshot): LaneAllocationState {
  return {
    heap: structuredClone(snapshot.heap),
    indexMap: new Map(
      Object.entries(snapshot.indexMap).map(([lane, index]) => [Number(lane), index])
    ),
    numLanes: snapshot.laneCount,
    speedTierLanes: new Map(
      Object.entries(snapshot.speedTierLanes).map(([lane, entry]) => [Number(lane), { ...entry }])
    ),
    collidedLanes: new Set(),
  };
}

let now = 1000;
let allocator: LaneAllocator;

beforeEach(() => {
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  allocator = new LaneAllocator({ ...defaultOptions });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Construction & basic state ─────────────────────────────────────────

describe('LaneAllocator', () => {
  describe('constructor', () => {
    it('creates an empty allocator (no lanes yet)', () => {
      expect(allocator.isEmpty()).toBe(true);
      expect(allocator.getLaneCount()).toBe(0);
      expect(allocator.getUtilization()).toBe(0);
      expect(allocator.getLaneHeight()).toBe(0);
    });
  });

  // ── reset ─────────────────────────────────────────────────────────────

  describe('reset', () => {
    it('builds lanes from dimensions', () => {
      allocator.reset(defaultDimensions);
      expect(allocator.isEmpty()).toBe(false);
      expect(allocator.getLaneCount()).toBeGreaterThan(0);
      expect(allocator.getLaneHeight()).toBeGreaterThan(0);
      expect(allocator.getUtilization()).toBe(0); // all lanes available at now
    });

    it('resets to empty when dimensions is null', () => {
      allocator.reset(defaultDimensions);
      expect(allocator.isEmpty()).toBe(false);
      allocator.reset(null);
      expect(allocator.isEmpty()).toBe(true);
      expect(allocator.getLaneCount()).toBe(0);
      expect(allocator.getLaneHeight()).toBe(0);
    });

    it('calculates lane count based on safe zone', () => {
      const tight = new LaneAllocator({ ...defaultOptions, safeTop: 0.15, safeBottom: 0.15 });
      tight.reset(defaultDimensions); // 1080 * (1-0.3) = 756px usable
      const lanesTight = tight.getLaneCount();

      const loose = new LaneAllocator({ ...defaultOptions, safeTop: 0.01, safeBottom: 0.01 });
      loose.reset(defaultDimensions); // 1080 * (1-0.02) = 1058.4px usable
      const lanesLoose = loose.getLaneCount();

      expect(lanesLoose).toBeGreaterThan(lanesTight);
    });

    it('calculates lane height with density factor', () => {
      const full = new LaneAllocator({ ...defaultOptions, laneDensityFactor: 1.0 });
      full.reset(defaultDimensions);
      const fullHeight = full.getLaneHeight();

      const half = new LaneAllocator({ ...defaultOptions, laneDensityFactor: 0.5 });
      half.reset(defaultDimensions);
      const halfHeight = half.getLaneHeight();

      expect(halfHeight).toBeLessThanOrEqual(fullHeight);
    });

    it('uses laneSpacing as the direct gap between regular comment rows', () => {
      const adjacent = new LaneAllocator({ ...defaultOptions, laneSpacing: 0 });
      adjacent.reset(defaultDimensions);

      const spaced = new LaneAllocator({ ...defaultOptions, laneSpacing: 6 });
      spaced.reset(defaultDimensions);

      expect(spaced.getLaneHeight()).toBe(adjacent.getLaneHeight() + 6);
    });

    it('handles zero height gracefully', () => {
      const tiny = new LaneAllocator(defaultOptions);
      tiny.reset({ width: 1, height: 1 });
      expect(tiny.getLaneCount()).toBeGreaterThanOrEqual(1);
    });
  });

  // ── getLaneY ──────────────────────────────────────────────────────────

  describe('getLaneY', () => {
    it('returns Y position for a given lane index', () => {
      allocator.reset(defaultDimensions);
      const y0 = allocator.getLaneY(0, 1080);
      const y1 = allocator.getLaneY(1, 1080);
      // Second lane should be below first
      expect(y1).toBeGreaterThan(y0);
    });
  });

  // ── isEmpty / getLaneCount / getLaneHeight ─────────────────────────────

  describe('isEmpty / getLaneCount / getLaneHeight', () => {
    it('reports empty before reset', () => {
      expect(allocator.isEmpty()).toBe(true);
      expect(allocator.getLaneCount()).toBe(0);
    });

    it('reports non-empty after reset', () => {
      allocator.reset(defaultDimensions);
      expect(allocator.isEmpty()).toBe(false);
      expect(allocator.getLaneCount()).toBeGreaterThan(0);
    });
  });

  // ── snapshot / restore ─────────────────────────────────────────────────

  describe('snapshot / restore', () => {
    it('produces a snapshot with expected fields', () => {
      allocator.reset(defaultDimensions);
      const snap = allocator.snapshot();
      expect(snap.laneCount).toBe(allocator.getLaneCount());
      expect(snap.laneHeight).toBe(allocator.getLaneHeight());
      expect(snap.heap.length).toBe(snap.laneCount);
      expect(Object.keys(snap.indexMap).length).toBe(snap.laneCount);
      expect(Object.keys(snap.speedTierLanes).length).toBe(0); // no placements yet
    });

    it('restores state from a snapshot', () => {
      allocator.reset(defaultDimensions);
      const originalLaneCount = allocator.getLaneCount();
      const originalHeight = allocator.getLaneHeight();

      const snap = allocator.snapshot();
      // Create a fresh allocator and restore
      const restored = new LaneAllocator(defaultOptions);
      restored.restore(snap);

      expect(restored.getLaneCount()).toBe(originalLaneCount);
      expect(restored.getLaneHeight()).toBe(originalHeight);
      expect(restored.isEmpty()).toBe(false);
      expect(restored.getUtilization()).toBe(0);
    });

    it('snapshot handles empty allocator', () => {
      const snap = allocator.snapshot();
      expect(snap.laneCount).toBe(0);
      expect(snap.laneHeight).toBe(0);
      expect(snap.heap).toEqual([]);
      expect(snap.indexMap).toEqual({});
    });

    it('keeps snapshots and restored allocators independent of later changes', () => {
      allocator.reset(defaultDimensions, now);
      const saved = allocator.snapshot();
      const restored = new LaneAllocator({ ...defaultOptions });
      restored.restore(saved);
      const placement = allocator.findPlacement(10, defaultDimensions, SPEED_TIER.MID, now, 'top');
      expect(placement).not.toBeNull();
      if (!placement) return;
      allocator.commitPlacement(placement, now, 4000, undefined, undefined, SPEED_TIER.MID);

      expect(saved.speedTierLanes).toEqual({});
      expect(restored.snapshot()).toEqual(saved);
      expect(allocator.snapshot()).not.toEqual(saved);
      const firstEntry = saved.heap[0];
      if (firstEntry) firstEntry[1] = 99_000;
      saved.speedTierLanes[0] = { tier: SPEED_TIER.FAR, until: 99_000 };
      expect(restored.snapshot().heap).not.toEqual(saved.heap);
      expect(restored.snapshot().speedTierLanes).toEqual({});
    });

    it('restores synchronized allocation state and rebuilds a missing reverse index', () => {
      allocator.reset(defaultDimensions, now);
      const first = allocator.findPlacement(10, defaultDimensions, SPEED_TIER.FAR, now, 'top');
      expect(first).not.toBeNull();
      if (!first) return;
      allocator.commitPlacement(first, now, 4000, undefined, undefined, SPEED_TIER.FAR);
      const saved = allocator.snapshot();
      delete saved.indexMap[first.laneIndex];

      const restored = new LaneAllocator({ ...defaultOptions });
      restored.restore(saved);
      restored.markCollision(first.laneIndex);
      restored.resetBatch(now + 1);
      const recovered = restored.snapshot();
      expect(Object.keys(recovered.indexMap)).toHaveLength(recovered.laneCount);
      for (const [heapIndex, [lane]] of recovered.heap.entries()) {
        expect(recovered.indexMap[lane]).toBe(heapIndex);
      }
      expect(recovered.speedTierLanes[first.laneIndex]).toEqual(
        allocator.snapshot().speedTierLanes[first.laneIndex]
      );
      expect(
        restored.findPlacement(10, defaultDimensions, SPEED_TIER.FAR, now + 1, 'top')
      ).not.toBeNull();
      restored.reset(defaultDimensions, now + 10_000);
      expect(restored.snapshot().speedTierLanes).toEqual({});
      expect(restored.getUtilization(now + 10_000)).toBe(0);
    });
  });

  describe('shared allocation parity', () => {
    it('matches shared state through tiered, multi-slot, and excluded placements', () => {
      allocator.reset(defaultDimensions, now);
      const laneHeight = allocator.getLaneHeight();
      const shared = stateFromSnapshot(allocator.snapshot());
      const cases: {
        height: number;
        tier: number;
        strategy: LaneSelectionStrategy;
        excluded?: number;
      }[] = [
        { height: laneHeight - defaultOptions.laneSpacing, tier: SPEED_TIER.FAR, strategy: 'top' },
        {
          height: laneHeight * 2 - defaultOptions.laneSpacing,
          tier: SPEED_TIER.MID,
          strategy: 'bottom',
        },
        {
          height: laneHeight - defaultOptions.laneSpacing,
          tier: SPEED_TIER.FAR,
          strategy: 'top',
          excluded: 0,
        },
      ];

      for (const scenario of cases) {
        if (scenario.excluded !== undefined) {
          allocator.markCollision(scenario.excluded);
          shared.collidedLanes.add(scenario.excluded);
        }
        const placement = allocator.findPlacement(
          scenario.height,
          defaultDimensions,
          scenario.tier,
          now,
          scenario.strategy,
          () => 0
        );
        const expected = findPlacementShared(
          shared,
          now,
          scenario.height,
          laneHeight,
          defaultOptions.scrollDurationMaxMs,
          scenario.tier,
          () => 0,
          scenario.strategy,
          false,
          defaultOptions.laneSpacing
        );
        expect(placement && { laneIndex: placement.laneIndex, waitMs: placement.waitMs }).toEqual(
          expected
        );
        expect(placement).not.toBeNull();
        if (!placement) continue;
        allocator.commitPlacement(placement, now, 4000, undefined, undefined, scenario.tier);
        commitPlacementShared(
          shared,
          placement.laneIndex,
          placement.slotCount,
          now,
          computeOccupancyMs(4000, defaultOptions.exitPaddingPx, defaultOptions.headwayGapRatio),
          4000,
          scenario.tier
        );
        const snapshot = allocator.snapshot();
        expect(snapshot.heap).toEqual(shared.heap);
        expect(
          new Map(Object.entries(snapshot.indexMap).map(([lane, index]) => [Number(lane), index]))
        ).toEqual(shared.indexMap);
        expect(
          new Map(
            Object.entries(snapshot.speedTierLanes).map(([lane, entry]) => [Number(lane), entry])
          )
        ).toEqual(shared.speedTierLanes);
      }
    });
  });

  // ── updateSafeZone / updateFontMetrics / updateLaneDensityFactor ────────

  describe('updateSafeZone / updateFontMetrics / updateLaneDensityFactor', () => {
    it('updateSafeZone changes safe zone without side effects until reset', () => {
      allocator.reset(defaultDimensions);
      const lanesBefore = allocator.getLaneCount();
      allocator.updateSafeZone(0.2, 0.2);
      // No change until reset
      expect(allocator.getLaneCount()).toBe(lanesBefore);
      allocator.reset(defaultDimensions);
      // Now fewer lanes due to smaller usable area
      expect(allocator.getLaneCount()).toBeLessThanOrEqual(lanesBefore);
    });
  });

  // ── markCollision / resetBatch ──────────────────────────────────────────

  describe('markCollision / resetBatch', () => {
    it('keeps retry exclusions local to each incoming candidate', () => {
      allocator.reset(defaultDimensions);
      allocator.markCollision(0);
      expect(allocator.findPlacement(10, defaultDimensions, 1, now, 'top')?.laneIndex).toBe(1);
      allocator.clearCandidateExclusions();
      expect(allocator.findPlacement(10, defaultDimensions, 1, now, 'top')?.laneIndex).toBe(0);
    });

    it('markCollision does not throw', () => {
      allocator.reset(defaultDimensions);
      expect(() => allocator.markCollision(0)).not.toThrow();
    });

    it('resetBatch clears collisions', () => {
      allocator.reset(defaultDimensions);
      allocator.markCollision(0);
      allocator.markCollision(1);
      expect(allocator.findPlacement(10, defaultDimensions, 1, now, 'top')?.laneIndex).toBe(2);
      allocator.resetBatch(now);
      expect(allocator.findPlacement(10, defaultDimensions, 1, now, 'top')?.laneIndex).toBe(0);
    });

    it('resetBatch on empty allocator does not throw', () => {
      expect(() => allocator.resetBatch()).not.toThrow();
    });
  });

  // ── shiftAll ────────────────────────────────────────────────────────────

  describe('shiftAll', () => {
    it('does nothing with zero offset', () => {
      allocator.reset(defaultDimensions);
      const snap = allocator.snapshot();
      allocator.shiftAll(0);
      expect(allocator.snapshot().heap).toEqual(snap.heap);
    });

    it('shiftAll with positive offset does not throw on empty allocator', () => {
      expect(() => allocator.shiftAll(1000)).not.toThrow();
    });

    it('shiftAll advances lane timers', () => {
      allocator.reset(defaultDimensions);
      // commit a placement to set some lanes busy
      now = 5000;
      allocator.commitPlacement(
        { laneIndex: 0, waitMs: 0, laneY: 0, slotCount: 1, verticalOffset: 0 },
        now,
        5000,
        300,
        1920,
        1
      );
      const before = allocator.snapshot();
      const availableBefore = new Map(before.heap);

      now = 10000;
      allocator.shiftAll(2000);
      const after = allocator.snapshot();
      for (const [lane, availableAt] of after.heap) {
        const previous = availableBefore.get(lane);
        expect(previous).toBeDefined();
        if (previous !== undefined) expect(availableAt).toBe(previous + 2000);
      }
      const priorTier = before.speedTierLanes[0];
      expect(priorTier).toBeDefined();
      if (priorTier) expect(after.speedTierLanes[0]?.until).toBe(priorTier.until + 2000);
    });
  });

  // ── getUtilization ──────────────────────────────────────────────────────

  describe('getUtilization', () => {
    it('returns 0 for empty allocator', () => {
      expect(allocator.getUtilization()).toBe(0);
    });

    it('returns 0 for freshly reset allocator (all lanes idle)', () => {
      allocator.reset(defaultDimensions);
      expect(allocator.getUtilization()).toBe(0);
    });

    it('observes expired lane timers without requiring resetBatch', () => {
      allocator.reset(defaultDimensions);
      allocator.commitPlacement(
        { laneIndex: 0, waitMs: 0, laneY: 0, slotCount: 1, verticalOffset: 0 },
        1_000,
        4_000,
        undefined,
        undefined,
        1
      );

      expect(allocator.getUtilization(1_001)).toBeGreaterThan(0);
      expect(allocator.getUtilization(6_000)).toBe(0);
    });
  });
});
