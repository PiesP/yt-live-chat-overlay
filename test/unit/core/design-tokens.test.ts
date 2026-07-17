import { describe, expect, it } from "vitest";
import { computeScrollDuration } from "@util/design-tokens";

// ═══════════════════════════════════════════════════════════
// computeScrollDuration (5-arg signature at 0900552)
// ═══════════════════════════════════════════════════════════

describe("computeScrollDuration", () => {
  const min = 5000;
  const max = 30000;
  const exitPad = 200;

  it("returns duration proportional to distance / velocity", () => {
    // totalDistance=2000, velocity=200 → raw = (2000/200)*1000 = 10000
    // velocityFloor = max(5000, (200/200)*1000) = max(5000, 1000) = 5000
    // result = max(5000, min(30000, 10000)) = 10000
    const duration = computeScrollDuration(2000, 200, min, max, exitPad);
    expect(duration).toBe(10000);
  });

  it("clamps to durationMin for very short distances", () => {
    // totalDistance=100, velocity=200 → raw = (100/200)*1000 = 500
    // velocityFloor = max(5000, (200/200)*1000) = max(5000, 1000) = 5000
    // result = max(5000, min(30000, 500)) = 5000
    const duration = computeScrollDuration(100, 200, min, max, exitPad);
    expect(duration).toBe(5000);
  });

  it("clamps to durationMax for very long distances", () => {
    // totalDistance=10000, velocity=200 → raw = (10000/200)*1000 = 50000
    // velocityFloor = max(5000, (200/200)*1000) = 5000
    // result = max(5000, min(30000, 50000)) = 30000
    const duration = computeScrollDuration(10000, 200, min, max, exitPad);
    expect(duration).toBe(30000);
  });

  it("uses velocity-aware floor for high speed", () => {
    // velocity=500 → velocityFloor = max(5000, (200/500)*1000) = max(5000, 400) = 5000
    // totalDistance=500, velocity=500 → raw = (500/500)*1000 = 1000
    // result = max(5000, min(30000, 1000)) = 5000
    const duration = computeScrollDuration(500, 500, min, max, exitPad);
    expect(duration).toBe(5000);
  });

  it("velocityFloor wins over computed duration for small exit padding at high speed", () => {
    // exitPadding=50, velocity=1000 → velocityFloor = max(5000, (50/1000)*1000) = max(5000, 50) = 5000
    // totalDistance=2000, velocity=1000 → raw = (2000/1000)*1000 = 2000
    // result = max(5000, min(30000, 2000)) = 5000
    const duration = computeScrollDuration(2000, 1000, min, max, 50);
    expect(duration).toBe(5000);
  });
});

// NOTE: parseAnyColor, computeOutlineColor, computeSuperChatOpacities,
// computeReadableTextColor, toRgba are exported from @renderer/color-utils,
// not @util/design-tokens, at this commit (0900552).
// Tests for those functions live in color-utils.test.ts.
