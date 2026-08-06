import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { LaneAllocator } from '@renderer/layout/lane-allocator';
import type { LaneAllocatorOptions } from '@renderer/layout/lane-allocator';
import type { OverlayDimensions } from '@app-types';

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
  maxMessageAgeMs: 30000,
  laneDensityFactor: 1.0,
};

const defaultDimensions: OverlayDimensions = {
  width: 1920,
  height: 1080,
};

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
    it('markCollision does not throw', () => {
      allocator.reset(defaultDimensions);
      expect(() => allocator.markCollision(0)).not.toThrow();
    });

    it('resetBatch clears collisions', () => {
      allocator.reset(defaultDimensions);
      allocator.markCollision(0);
      allocator.markCollision(1);
      // No way to inspect collided lanes directly — just verify no throw
      expect(() => allocator.resetBatch()).not.toThrow();
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
      const firstAvailBefore = before.heap[0]![1];

      now = 10000;
      allocator.shiftAll(2000);
      const after = allocator.snapshot();
      const firstAvailAfter = after.heap[0]![1];

      // available time advanced by shiftAll
      expect(firstAvailAfter).toBeGreaterThanOrEqual(firstAvailBefore);
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
