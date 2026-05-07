import type { LaneState, OverlayDimensions } from '@app-types';

export interface LanePlacement {
  lane: LaneState;
  laneSpan: number;
  waitMs: number;
}

/** Threshold (ms) above which lane waiting is considered "congested". */
const LANE_CONGESTION_THRESHOLD_MS = 100;

interface LaneAllocatorOptions {
  readonly getFontSize: () => number;
  readonly getEffectiveSpeedPxPerSec: () => number;
  readonly globalStaggerMs: number;
  readonly safeDistanceScale: number;
  readonly safeDistanceMin: number;
  readonly verticalClearTimeMin: number;
  readonly verticalClearTimeMax: number;
  readonly laneHeightPaddingScale: number;
  readonly laneHeightPaddingMin: number;
}

export class LaneAllocator {
  private lanes: LaneState[] = [];
  private nextLaneIndex = 0;

  constructor(private readonly options: LaneAllocatorOptions) {}

  reset(dimensions: OverlayDimensions | null): void {
    if (!dimensions) {
      this.lanes = [];
      return;
    }

    this.lanes = Array.from({ length: dimensions.laneCount }, (_, index) => ({
      index,
      lastItemStartTime: 0,
      lastItemEndTime: 0,
      lastItemWidthPx: 0,
      lastItemHeightPx: 0,
    }));
    this.nextLaneIndex = 0;
  }

  isEmpty(): boolean {
    return this.lanes.length === 0;
  }

  getLaneCount(): number {
    return this.lanes.length;
  }

  /**
   * Find placement for a message with the given height.
   *
   * @param messageHeight  Estimated pixel height of the message.
   * @param dimensions     Current overlay dimensions.
   * @param forceOverwriteMs  Optional threshold (ms). When provided and the
   *   best placement's wait time equals or exceeds this value, the wait is
   *   clamped to zero so the caller can render immediately by overwriting
   *   the lane's existing occupant.  The old CSS animation continues
   *   independently — only the lane allocator's tracking is reset.
   */
  findPlacement(
    messageHeight: number,
    dimensions: OverlayDimensions,
    forceOverwriteMs?: number
  ): LanePlacement | null {
    const now = Date.now();
    const requiredLanes = this.calculateRequiredLanes(messageHeight, dimensions.laneHeight);
    if (requiredLanes > this.lanes.length) {
      return null;
    }

    // ── Round-robin lane scan ────────────────────────────────────────────
    // Start from nextLaneIndex and scan forward.  If a block is ready now
    // (or with minimal wait), assign it immediately.  Otherwise track the
    // block with the earliest ready time and return it as deferred.

    const maxStartIndex = this.lanes.length - requiredLanes;
    let bestStartIndex = -1;
    let bestReadyTime = Number.POSITIVE_INFINITY;

    for (let scanOffset = 0; scanOffset <= maxStartIndex; scanOffset++) {
      const startIndex = (this.nextLaneIndex + scanOffset) % (maxStartIndex + 1);

      let blockReadyTime = now;
      let allValid = true;

      for (let offset = 0; offset < requiredLanes; offset++) {
        const lane = this.lanes[startIndex + offset];
        if (!lane) {
          allValid = false;
          break;
        }
        blockReadyTime = Math.max(blockReadyTime, this.calculateLaneReadyTime(lane, now));
      }

      if (!allValid || !Number.isFinite(blockReadyTime)) {
        continue;
      }

      // Found a block that's ready now — use it immediately.
      if (blockReadyTime <= now + 16) {
        bestStartIndex = startIndex;
        bestReadyTime = blockReadyTime;
        break;
      }

      // Track the block with the earliest ready time.
      if (blockReadyTime < bestReadyTime) {
        bestReadyTime = blockReadyTime;
        bestStartIndex = startIndex;
      }
    }

    if (bestStartIndex === -1 || !Number.isFinite(bestReadyTime)) {
      return null;
    }

    const chosenLane = this.lanes[bestStartIndex];
    if (!chosenLane) {
      return null;
    }

    // Advance round-robin pointer to the lane after this block so the next
    // message starts scanning from a different position.
    this.nextLaneIndex = (bestStartIndex + 1) % (maxStartIndex + 1);

    const waitMs = Math.max(0, Math.ceil(bestReadyTime - now));

    // ── Force-overwrite fast path ────────────────────────────────────────
    // When the queue is congested (forceOverwriteMs set and wait exceeds
    // threshold), return the placement with waitMs=0 so the caller renders
    // immediately.  This overwrites the lane's occupant in the allocator's
    // tracking state — the old CSS animation keeps running independently.
    if (
      forceOverwriteMs !== undefined &&
      waitMs >= Math.max(forceOverwriteMs, LANE_CONGESTION_THRESHOLD_MS)
    ) {
      return {
        lane: chosenLane,
        laneSpan: requiredLanes,
        waitMs: 0,
      };
    }

    return {
      lane: chosenLane,
      laneSpan: requiredLanes,
      waitMs,
    };
  }

  commitPlacement(
    placement: LanePlacement,
    textWidth: number,
    messageHeight: number,
    startTime: number,
    endTime: number
  ): void {
    for (
      let index = placement.lane.index;
      index < placement.lane.index + placement.laneSpan && index < this.lanes.length;
      index++
    ) {
      const laneState = this.lanes[index];
      if (!laneState) {
        continue;
      }

      laneState.lastItemStartTime = startTime;
      laneState.lastItemEndTime = endTime;
      laneState.lastItemWidthPx = textWidth;
      laneState.lastItemHeightPx = messageHeight;
    }
  }

  shiftTimeline(deltaMs: number): void {
    if (deltaMs <= 0) {
      return;
    }

    // Internal safety cap: prevents lanes from being pushed into the far
    // future after long pauses (e.g. tab hidden 30+ min).
    const clampedMs = Math.min(deltaMs, 60_000);

    for (const lane of this.lanes) {
      if (lane.lastItemStartTime > 0) {
        lane.lastItemStartTime += clampedMs;
      }
      if (lane.lastItemEndTime > 0) {
        lane.lastItemEndTime += clampedMs;
      }
    }
  }

  private calculateRequiredLanes(messageHeight: number, laneHeight: number): number {
    const paddingPx = Math.max(
      this.options.laneHeightPaddingMin,
      this.options.getFontSize() * this.options.laneHeightPaddingScale
    );
    return Math.max(1, Math.ceil((messageHeight + paddingPx) / laneHeight));
  }

  private calculateLaneReadyTime(lane: LaneState, now: number): number {
    if (lane.lastItemStartTime <= 0) {
      return now;
    }

    const speed = this.options.getEffectiveSpeedPxPerSec();
    const fontSize = this.options.getFontSize();

    // Dynamic safe distance: scale with speed so slow messages get more gap.
    const baseSafeDistance = Math.max(
      fontSize * this.options.safeDistanceScale,
      this.options.safeDistanceMin
    );
    const speedFactor = Math.max(0.5, Math.min(2.0, 100 / speed));
    const minSafeDistance = baseSafeDistance * speedFactor;
    const requiredGapPx = lane.lastItemWidthPx + minSafeDistance;
    const safeTimeGap = (requiredGapPx / speed) * 1000;
    const horizontalReadyTime = lane.lastItemStartTime + safeTimeGap;

    // Dynamic vertical clear time: base on message travel time.
    const traverseTimeMs = (window.innerWidth / speed) * 1000;
    const dynamicClearMs = Math.max(traverseTimeMs * 0.05, 200);
    const verticalReadyTime = lane.lastItemStartTime + dynamicClearMs;

    const laneStaggerTime = lane.lastItemStartTime + this.options.globalStaggerMs;

    // Absolute animation end time guard.
    const animationEndGuard = lane.lastItemEndTime;

    return Math.max(
      now,
      horizontalReadyTime,
      verticalReadyTime,
      laneStaggerTime,
      animationEndGuard
    );
  }
}
