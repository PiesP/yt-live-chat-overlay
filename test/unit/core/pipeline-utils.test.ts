// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, it, expect } from 'vitest';
import {
  addMessageToLaneIndex,
  createFastRandom,
  fastRandom,
  COMPACTION_THRESHOLD_RATIO,
  removeMessageFromLaneIndex,
} from '@renderer/canvas/pipeline-utils';

// ═══════════════════════════════════════════════════════════════════════════
// createFastRandom
// ═══════════════════════════════════════════════════════════════════════════

describe('createFastRandom', () => {
  it('returns a function that produces numbers in [0, 1)', () => {
    const rng = createFastRandom(42);
    for (let i = 0; i < 100; i++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('produces deterministic sequence with same seed', () => {
    const rng1 = createFastRandom(12345);
    const rng2 = createFastRandom(12345);
    for (let i = 0; i < 20; i++) {
      expect(rng1()).toBe(rng2());
    }
  });

  it('matches the documented LCG transition for an explicit zero seed', () => {
    const rng = createFastRandom(0);

    expect(rng()).toBe(1013904223 / 0xffffffff);
  });

  it('produces different sequences with different seeds', () => {
    const rng1 = createFastRandom(1);
    const rng2 = createFastRandom(2);
    const seq1 = Array.from({ length: 10 }, () => rng1());
    const seq2 = Array.from({ length: 10 }, () => rng2());
    expect(seq1).not.toEqual(seq2);
  });

  it('produces approximately uniform distribution', () => {
    const rng = createFastRandom(99);
    const samples = Array.from({ length: 1000 }, () => rng());
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    // Mean should be ~0.5 for uniform [0,1)
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// fastRandom (module-level instance)
// ═══════════════════════════════════════════════════════════════════════════

describe('fastRandom', () => {
  it('module-level instance produces values in [0, 1)', () => {
    for (let i = 0; i < 50; i++) {
      const v = fastRandom();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPACTION_THRESHOLD_RATIO
// ═══════════════════════════════════════════════════════════════════════════

describe('COMPACTION_THRESHOLD_RATIO', () => {
  it('is a number between 0 and 1', () => {
    expect(COMPACTION_THRESHOLD_RATIO).toBeGreaterThan(0);
    expect(COMPACTION_THRESHOLD_RATIO).toBeLessThan(1);
  });

  it('is exactly 0.5', () => {
    expect(COMPACTION_THRESHOLD_RATIO).toBe(0.5);
  });
});

describe('lane index maintenance', () => {
  it('removes an expired multi-lane message with swap-pop and updates the moved indices', () => {
    const lanes = new Map<number, LaneMessage[]>();
    const expired = { laneIndex: 2, laneArrayIndices: [] };
    const retained = { laneIndex: 2, laneArrayIndices: [] };

    addMessageToLaneIndex(lanes, expired, 2);
    addMessageToLaneIndex(lanes, retained, 2);
    removeMessageFromLaneIndex(lanes, expired, 2);

    expect(lanes.get(2)).toEqual([retained]);
    expect(lanes.get(3)).toEqual([retained]);
    expect(retained.laneArrayIndices).toEqual([0, 0]);
  });

  it('deletes lanes after their final indexed message expires', () => {
    const lanes = new Map<number, LaneMessage[]>();
    const message = { laneIndex: 4, laneArrayIndices: [] };
    addMessageToLaneIndex(lanes, message, 1);

    removeMessageFromLaneIndex(lanes, message, 1);

    expect(lanes.has(4)).toBe(false);
  });

  it('does not touch the lane immediately after the occupied slot range', () => {
    const lanes = new Map<number, LaneMessage[]>();
    const expired: LaneMessage = { laneIndex: 2, laneArrayIndices: [] };
    const adjacent: LaneMessage = { laneIndex: 3, laneArrayIndices: [] };
    addMessageToLaneIndex(lanes, expired, 1);
    addMessageToLaneIndex(lanes, adjacent, 1);
    expired.laneArrayIndices[1] = 0;

    removeMessageFromLaneIndex(lanes, expired, 1);

    expect(lanes.get(3)).toEqual([adjacent]);
  });

  it('ignores missing lanes and stale lane-array indices', () => {
    const retained: LaneMessage = { laneIndex: 1, laneArrayIndices: [] };

    expect(() =>
      removeMessageFromLaneIndex(
        new Map(),
        { laneIndex: 1, laneArrayIndices: [0] },
        1
      )
    ).not.toThrow();

    for (const index of [-1, 1]) {
      const lanes = new Map<number, LaneMessage[]>([[1, [retained]]]);
      removeMessageFromLaneIndex(lanes, { laneIndex: 1, laneArrayIndices: [index] }, 1);
      expect(lanes.get(1)).toEqual([retained]);
    }

    const lanes = new Map<number, LaneMessage[]>([[1, [retained]]]);
    const missingIndex: LaneMessage = { laneIndex: 1, laneArrayIndices: [] };
    missingIndex.laneArrayIndices.length = 1;
    removeMessageFromLaneIndex(lanes, missingIndex, 1);
    expect(lanes.get(1)).toEqual([retained]);
  });

  it('does not write swap metadata outside the moved message slot range', () => {
    const expired: LaneMessage = { laneIndex: 2, laneArrayIndices: [0] };
    const retained: LaneMessage = { laneIndex: 10, laneArrayIndices: [] };
    const lanes = new Map<number, LaneMessage[]>([[2, [expired, retained]]]);

    removeMessageFromLaneIndex(lanes, expired, 1);

    expect(lanes.get(2)).toEqual([retained]);
    expect(Object.keys(retained.laneArrayIndices)).toEqual([]);
  });
});

interface LaneMessage {
  laneIndex: number;
  laneArrayIndices: number[];
}
