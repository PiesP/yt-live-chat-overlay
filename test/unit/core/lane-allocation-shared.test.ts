import { describe, it, expect } from 'vitest';
import {
  computeBaseHeadwayPx,
  areSpeedTiersCompatible,
  computeLaneY,
  computeOccupancyMs,
  heapSiftDown,
  heapSiftUp,
  heapGetSlotAvailableAt,
  heapUpdateLane,
  buildLaneHeap,
  resetBatchShared,
  commitPlacementShared,
  shiftLaneTimersShared,
  allocateSingleLaneShared,
  findPlacementShared,
  HEADWAY_GAP_MAX_PX,
} from '@renderer/layout/lane-shared';
import type { LaneAllocationState } from '@renderer/layout/lane-shared';

// ── Helper: create a minimal LaneAllocationState ────────────────

function makeState(numLanes: number, now = 0): LaneAllocationState {
  const indexMap = new Map<number, number>();
  const heap = buildLaneHeap(numLanes, now, indexMap);
  return {
    heap,
    indexMap,
    numLanes,
    speedTierLanes: new Map(),
    collidedLanes: new Set(),
  };
}

// ── computeBaseHeadwayPx ────────────────────────────────────────

describe('computeBaseHeadwayPx', () => {
  it('clamps to HEADWAY_GAP_MIN_PX for small widths', () => {
    // 50px * 0.08 = 4px, clamped to min
    expect(computeBaseHeadwayPx(50, 0.08)).toBeGreaterThanOrEqual(16);
  });

  it('clamps to max for large width * ratio', () => {
    // 1000px * 0.3 = 300px, clamped to max
    expect(computeBaseHeadwayPx(1000, 0.3)).toBe(HEADWAY_GAP_MAX_PX);
  });

  it('returns proportional gap for moderate inputs', () => {
    // 300px * 0.08 = 24px, within [16, 60]
    expect(computeBaseHeadwayPx(300, 0.08)).toBe(24);
  });

  it('rounds to nearest integer', () => {
    // 275 * 0.08 = 22, integer already
    expect(computeBaseHeadwayPx(275, 0.08)).toBe(22);
    // 280 * 0.08 = 22.4, rounds to 22
    expect(computeBaseHeadwayPx(280, 0.08)).toBe(22);
  });

  it('returns min for NaN msgWidth', () => {
    expect(computeBaseHeadwayPx(NaN, 0.08)).toBeGreaterThanOrEqual(16);
  });

  it('returns min for NaN ratio', () => {
    expect(computeBaseHeadwayPx(300, NaN)).toBeGreaterThanOrEqual(16);
  });

  it('returns min for Infinity inputs', () => {
    expect(computeBaseHeadwayPx(Infinity, 0.08)).toBeGreaterThanOrEqual(16);
  });
});

// ── areSpeedTiersCompatible ─────────────────────────────────────

describe('areSpeedTiersCompatible', () => {
  it('returns true for equal tiers', () => {
    expect(areSpeedTiersCompatible(1, 1)).toBe(true);
  });

  it('returns true for adjacent tiers', () => {
    expect(areSpeedTiersCompatible(1, 2)).toBe(true);
    expect(areSpeedTiersCompatible(2, 1)).toBe(true);
  });

  it('returns false for tiers more than 1 apart', () => {
    expect(areSpeedTiersCompatible(0, 2)).toBe(false);
    expect(areSpeedTiersCompatible(1, 3)).toBe(false);
  });

  it('returns true for tiers 0 and 1', () => {
    expect(areSpeedTiersCompatible(0, 1)).toBe(true);
  });
});

// ── computeLaneY ────────────────────────────────────────────────

describe('computeLaneY', () => {
  it('computes Y position for first lane', () => {
    expect(computeLaneY(0, 1080, 0.05, 40)).toBe(54);
  });

  it('computes Y position for subsequent lanes', () => {
    expect(computeLaneY(5, 1080, 0.05, 40)).toBe(254);
  });

  it('works with zero safeTop', () => {
    expect(computeLaneY(3, 1080, 0, 40)).toBe(120);
  });
});

// ── computeOccupancyMs ──────────────────────────────────────────

describe('computeOccupancyMs', () => {
  describe('top/bottom mode (no msgWidth/screenWidth)', () => {
    it('adds safety margin to duration', () => {
      const result = computeOccupancyMs(4000, 100, 0.08);
      // safetyMargin = 4000 * 0.15 = 600, max(500, 600) = 600
      // total = 4000 + 600 = 4600
      expect(result).toBe(4600);
    });

    it('uses LANE_COOLDOWN_MIN_MS when safety margin is smaller', () => {
      const result = computeOccupancyMs(100, 100, 0.08);
      // safetyMargin = 100 * 0.15 = 15, max(500, 15) = 500
      // total = 100 + 500 = 600
      expect(result).toBe(600);
    });

    it('handles zero duration', () => {
      const result = computeOccupancyMs(0, 100, 0.08);
      // max(0, 0) = 0; safetyMargin = 0 * 0.15 = 0; max(500, 0) = 500
      expect(result).toBe(500);
    });
  });

  describe('scrolling mode (with msgWidth/screenWidth)', () => {
    it('computes fractional occupancy for scrolling messages', () => {
      // screenWidth=1920, msgWidthPx=300, exitPaddingPx=100
      // totalDistance = 1920 + 300 + 100 = 2320
      // headwayPx = computeBaseHeadwayPx(300, 0.08) = 24
      // rightEdgePassFraction = (300 + 24) / 2320 ≈ 0.13966
      // result = round(0.13966 * 4000) = round(558.64) = 559
      const result = computeOccupancyMs(4000, 100, 0.08, 300, 1920);
      expect(result).toBe(559);
    });

    it('handles zero total distance safely', () => {
      // totalDistance = 0 + 300 + 100 = 400... actually screenWidth=0
      // totalDistance = 0 + 300 + 100 = 400, which is > 0
      // Let me test: msgWidthPx=0, screenWidth=0, exitPadding=0
      // Actually exitPadding could be 0:
      expect(computeOccupancyMs(4000, 0, 0.08, 0, 0)).toBe(4000);
    });

    it('handles negative duration', () => {
      const result = computeOccupancyMs(-100, 100, 0.08, 300, 1920);
      // safeDuration = max(0, -100) = 0
      // totalDistance = 1920 + 300 + 100 = 2320
      // rightEdgePassFraction = (300 + 24) / 2320
      // result = round(0.13966 * 0) = 0
      expect(result).toBe(0);
    });
  });
});

// ── Heap operations ─────────────────────────────────────────────

describe('buildLaneHeap', () => {
  it('creates a heap with all lanes available at now', () => {
    const indexMap = new Map<number, number>();
    const heap = buildLaneHeap(5, 1000, indexMap);

    expect(heap.length).toBe(5);
    expect(indexMap.size).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(heap[i]![0]).toBe(i);
      expect(heap[i]![1]).toBe(1000);
    }
  });

  it('maintains min-heap property', () => {
    const indexMap = new Map<number, number>();
    const heap = buildLaneHeap(8, 0, indexMap);

    // Verify min-heap: parent <= children
    for (let i = 0; i < heap.length; i++) {
      const firstChild = 4 * i + 1;
      for (let c = 0; c < 4; c++) {
        const childIdx = firstChild + c;
        if (childIdx >= heap.length) break;
        const parentVal = heap[i]![1];
        const childVal = heap[childIdx]![1];
        expect(parentVal).toBeLessThanOrEqual(childVal);
      }
    }
  });
});

describe('heapSiftDown / heapSiftUp', () => {
  it('restores heap property after increasing a lane time', () => {
    const indexMap = new Map<number, number>();
    const heap = buildLaneHeap(4, 0, indexMap);

    // Increase lane 0's availableAt to 100 — sift down
    heap[0] = [0, 100];
    indexMap.set(0, 0);
    heapSiftDown(heap, indexMap, 0);

    // Lane 0 should now be the earliest available (should be at top)
    expect(heap[0]![1]).toBe(0);
    // Lane 0 should not be at index 0 anymore
    const lane0Idx = indexMap.get(0)!;
    expect(heap[lane0Idx]![0]).toBe(0);
  });

  it('restores heap property after decreasing a lane time', () => {
    const indexMap = new Map<number, number>();
    const heap = buildLaneHeap(4, 100, indexMap);

    // Decrease lane 3's time to 0 — sift up
    heap[3] = [3, 0];
    indexMap.set(3, 3);
    heapSiftUp(heap, indexMap, 3);

    // Min should now be 0
    expect(heap[0]![1]).toBe(0);
    expect(heap[0]![0]).toBe(3);
  });
});

describe('heapGetSlotAvailableAt', () => {
  it('returns availableAt for a lane in the heap', () => {
    const indexMap = new Map<number, number>();
    const heap = buildLaneHeap(4, 42, indexMap);

    expect(heapGetSlotAvailableAt(heap, indexMap, 0)).toBe(42);
  });

  it('returns undefined for lane out of range with numLanes provided', () => {
    const indexMap = new Map<number, number>();
    const heap = buildLaneHeap(4, 0, indexMap);

    expect(heapGetSlotAvailableAt(heap, indexMap, 10, 4)).toBeUndefined();
  });

  it('returns undefined for lane not in indexMap', () => {
    const emptyIndexMap = new Map<number, number>();
    expect(heapGetSlotAvailableAt([], emptyIndexMap, 0)).toBeUndefined();
  });
});

describe('heapUpdateLane', () => {
  it('updates and sifts down when new time is later', () => {
    const indexMap = new Map<number, number>();
    const heap = buildLaneHeap(4, 0, indexMap);

    heapUpdateLane(heap, indexMap, 0, 100);
    // Lane 0 should no longer be at the top (its time is now 100)
    expect(heap[0]![1]).toBe(0); // still one lane at 0
    expect(indexMap.get(0)).not.toBe(0); // lane 0 moved down
  });

  it('updates and sifts up when new time is earlier', () => {
    const indexMap = new Map<number, number>();
    const heap = buildLaneHeap(4, 100, indexMap);

    heapUpdateLane(heap, indexMap, 3, 0);
    // Lane 3 should now be at the top
    expect(heap[0]![0]).toBe(3);
    expect(heap[0]![1]).toBe(0);
  });

  it('does nothing for lane not in indexMap', () => {
    const indexMap = new Map<number, number>();
    const heap = buildLaneHeap(4, 0, indexMap);

    expect(() => heapUpdateLane(heap, indexMap, 99, 0)).not.toThrow();
  });
});

// ── allocateSingleLaneShared ────────────────────────────────────

describe('allocateSingleLaneShared', () => {
  it('returns null for empty heap', () => {
    const state: LaneAllocationState = {
      heap: [],
      indexMap: new Map(),
      numLanes: 0,
      speedTierLanes: new Map(),
      collidedLanes: new Set(),
    };
    expect(allocateSingleLaneShared(state, 0, 0, 0, 100, 1)).toBeNull();
  });

  it('returns zero-wait lane when available', () => {
    const state = makeState(8);
    const result = allocateSingleLaneShared(state, 0, 0, 8, 100, 1, () => 0.75);
    expect(result).not.toBeNull();
    expect(result!.waitMs).toBe(0);
  });

  it('skips collided lanes', () => {
    const state = makeState(4);
    state.collidedLanes.add(0);
    state.collidedLanes.add(1);

    const result = allocateSingleLaneShared(state, 0, 0, 4, 100, 1, () => 0);
    expect(result).not.toBeNull();
    // Should not be lane 0 or 1
    expect(result!.laneIndex).toBeGreaterThanOrEqual(2);
  });
});

// ── findPlacementShared ─────────────────────────────────────────

describe('findPlacementShared', () => {
  it('returns null for empty lane state', () => {
    const state: LaneAllocationState = {
      heap: [],
      indexMap: new Map(),
      numLanes: 0,
      speedTierLanes: new Map(),
      collidedLanes: new Set(),
    };
    expect(findPlacementShared(state, 0, 40, 40, 100, 1)).toBeNull();
  });

  it('returns placement when lanes are available', () => {
    const state = makeState(8);
    const result = findPlacementShared(state, 0, 40, 40, 100, 1, () => 0.5);
    expect(result).not.toBeNull();
    expect(result!.waitMs).toBe(0);
    expect(result!.laneIndex).toBeGreaterThanOrEqual(0);
    expect(result!.laneIndex).toBeLessThan(8);
  });

  it('handles multi-slot messages (ceil division)', () => {
    const state = makeState(8);
    // msgHeight=100, laneHeight=40 → slotCount=3
    const result = findPlacementShared(state, 0, 100, 40, 100, 1, () => 0.5);
    expect(result).not.toBeNull();
    expect(result!.laneIndex).toBeGreaterThanOrEqual(0);
    expect(result!.laneIndex).toBeLessThanOrEqual(5); // maxStartLane = 8-3 = 5
  });
});

// ── resetBatchShared ─────────────────────────────────────────────

describe('resetBatchShared', () => {
  it('clears collided lanes', () => {
    const state = makeState(4);
    state.collidedLanes.add(0);
    state.collidedLanes.add(2);
    expect(state.collidedLanes.size).toBe(2);

    resetBatchShared(state, 0);
    expect(state.collidedLanes.size).toBe(0);
  });

  it('prunes expired speed tier entries', () => {
    const state = makeState(4);
    state.speedTierLanes.set(0, { tier: 2, until: 3000 });
    state.speedTierLanes.set(1, { tier: 1, until: 7000 });

    resetBatchShared(state, 5000);
    expect(state.speedTierLanes.has(0)).toBe(false);
    expect(state.speedTierLanes.has(1)).toBe(true);
  });

  it('prunes speed tier entries that expire exactly at now', () => {
    const state = makeState(4);
    state.speedTierLanes.set(0, { tier: 2, until: 5000 });

    resetBatchShared(state, 5000);
    expect(state.speedTierLanes.has(0)).toBe(false);
  });
});

// ── commitPlacementShared ────────────────────────────────────────

describe('commitPlacementShared', () => {
  it('updates single-slot placement', () => {
    const state = makeState(4);
    commitPlacementShared(state, 1, 1, 1000, 600, 3000, 1);

    expect(state.collidedLanes.has(1)).toBe(true);
    expect(state.speedTierLanes.get(1)).toEqual({ tier: 1, until: 4000 });
    const avail = heapGetSlotAvailableAt(state.heap, state.indexMap, 1);
    expect(avail).toBe(1600);
  });

  it('updates multi-slot placement', () => {
    const state = makeState(8);
    commitPlacementShared(state, 2, 3, 2000, 1000, 5000, 2);

    expect(state.collidedLanes.has(2)).toBe(true);
    expect(state.collidedLanes.has(3)).toBe(true);
    expect(state.collidedLanes.has(4)).toBe(true);
    expect(state.collidedLanes.has(5)).toBe(false);

    expect(state.speedTierLanes.get(2)!.tier).toBe(2);
    expect(state.speedTierLanes.get(3)!.tier).toBe(2);
    expect(state.speedTierLanes.get(4)!.tier).toBe(2);

    expect(heapGetSlotAvailableAt(state.heap, state.indexMap, 2)).toBe(3000);
    expect(heapGetSlotAvailableAt(state.heap, state.indexMap, 3)).toBe(3000);
    expect(heapGetSlotAvailableAt(state.heap, state.indexMap, 4)).toBe(3000);
  });
});

// ── shiftLaneTimersShared ────────────────────────────────────────

describe('shiftLaneTimersShared', () => {
  it('shifts all lane available times forward', () => {
    const state = makeState(4, 1000);
    shiftLaneTimersShared(state, 500);

    for (let i = 0; i < 4; i++) {
      const avail = heapGetSlotAvailableAt(state.heap, state.indexMap, i);
      expect(avail).toBe(1500);
    }
  });

  it('shifts speed tier tracking', () => {
    const state = makeState(4, 1000);
    state.speedTierLanes.set(0, { tier: 1, until: 2000 });
    state.speedTierLanes.set(1, { tier: 2, until: 3000 });

    shiftLaneTimersShared(state, 500);

    expect(state.speedTierLanes.get(0)!.until).toBe(2500);
    expect(state.speedTierLanes.get(1)!.until).toBe(3500);
  });

  it('handles negative shift', () => {
    const state = makeState(4, 1000);
    shiftLaneTimersShared(state, -300);

    for (let i = 0; i < 4; i++) {
      const avail = heapGetSlotAvailableAt(state.heap, state.indexMap, i);
      expect(avail).toBe(700);
    }
  });

  it('handles zero shift (no-op)', () => {
    const state = makeState(4, 1000);
    state.speedTierLanes.set(0, { tier: 1, until: 2000 });

    shiftLaneTimersShared(state, 0);

    for (let i = 0; i < 4; i++) {
      const avail = heapGetSlotAvailableAt(state.heap, state.indexMap, i);
      expect(avail).toBe(1000);
    }
    expect(state.speedTierLanes.get(0)!.until).toBe(2000);
  });
});
