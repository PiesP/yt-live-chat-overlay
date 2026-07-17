import { describe, it, expect } from 'vitest';

// ── Lane density factor math ──────────────────────────────────────────

describe('lane density factor', () => {
  it('at 1.0 produces normal lane count', () => {
    // 1080p with 10% safe zones → usableHeight = 864
    // laneHeight ≈ 38 → numLanes ≈ 22
    const rawLaneHeight = 38;
    const effectiveLaneHeight = Math.max(1, Math.round(rawLaneHeight * 1.0));
    const usableHeight = 864;
    const numLanes = Math.floor(usableHeight / effectiveLaneHeight);
    expect(numLanes).toBe(22);
  });

  it('at 0.5 doubles lane count', () => {
    const rawLaneHeight = 38;
    const effectiveLaneHeight = Math.max(1, Math.round(rawLaneHeight * 0.5));
    const usableHeight = 864;
    const numLanes = Math.floor(usableHeight / effectiveLaneHeight);
    expect(numLanes).toBe(45); // 864 / 19 = 45
  });

  it('at 0.75 produces ~1.33× lane count (transitional step)', () => {
    const rawLaneHeight = 38;
    const effectiveLaneHeight = Math.max(1, Math.round(rawLaneHeight * 0.75));
    const usableHeight = 864;
    const numLanes = Math.floor(usableHeight / effectiveLaneHeight);
    expect(numLanes).toBe(29); // 864 / 29 = 29.8 → 29
  });

  it('effective height never drops below 1px with extreme factor', () => {
    const rawLaneHeight = 3;
    const effective = Math.max(1, Math.round(rawLaneHeight * 0.5));
    expect(effective).toBeGreaterThanOrEqual(1);
    expect(effective).toBe(2); // 3 * 0.5 = 1.5 → round → 2
  });

  it('at 0.5 a short message fits in 1 slot', () => {
    // Short message height < effectiveLaneHeight
    const rawLaneHeight = 38;
    const effectiveLaneHeight = Math.max(1, Math.round(rawLaneHeight * 0.5));
    const shortMsgHeight = 18;
    const slotCount = Math.ceil(shortMsgHeight / effectiveLaneHeight);
    expect(slotCount).toBe(1); // 18/19 < 1 → 1
  });

  it('at 0.5 a normal message needs 2 slots', () => {
    const rawLaneHeight = 38;
    const effectiveLaneHeight = Math.max(1, Math.round(rawLaneHeight * 0.5));
    const normalMsgHeight = 36;
    const slotCount = Math.ceil(normalMsgHeight / effectiveLaneHeight);
    expect(slotCount).toBe(2); // 36/19 = 1.89 → 2
  });

  it('at 0.5 multi-slot message still allocates correctly', () => {
    const rawLaneHeight = 38;
    const effectiveLaneHeight = Math.max(1, Math.round(rawLaneHeight * 0.5));
    const superchatHeight = 90;
    const slotCount = Math.ceil(superchatHeight / effectiveLaneHeight);
    expect(slotCount).toBe(5); // 90/19 = 4.74 → 5
  });

  it('lane Y spacing at 0.5 is half the normal spacing', () => {
    const rawLaneHeight = 38;
    const normalLaneHeight = Math.max(1, Math.round(rawLaneHeight * 1.0));
    const halfLaneHeight = Math.max(1, Math.round(rawLaneHeight * 0.5));

    const normalY = (laneIndex: number) => 100 + laneIndex * normalLaneHeight;
    const halfY = (laneIndex: number) => 100 + laneIndex * halfLaneHeight;

    // Same physical position at 2× lane index
    expect(halfY(2)).toBe(normalY(1)); // lane 2 half-cell = lane 1 full-cell
    expect(halfY(4)).toBe(normalY(2)); // lane 4 half-cell = lane 2 full-cell
  });
});
