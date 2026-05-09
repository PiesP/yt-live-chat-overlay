import type { BurstLevel, LaneState, OverlayDimensions } from '@app-types';

export interface LanePlacement {
  lane: LaneState;
  laneSpan: number;
  waitMs: number;
}

interface LaneAllocatorOptions {
  readonly getFontSize: () => number;
  readonly getEffectiveSpeedPxPerSec: () => number;
  readonly globalStaggerMs: number;
  readonly safeDistanceScale: number;
  readonly safeDistanceMin: number;
  readonly laneHeightPaddingScale: number;
  readonly laneHeightPaddingMin: number;
}

/** Burst-level-based speed multiplier for adaptive scrolling. */
const BURST_SPEED_MULTIPLIER: Record<BurstLevel, number> = {
  normal: 1.0,
  elevated: 1.1,
  high: 1.2,
  extreme: 1.35,
};

export class LaneAllocator {
  private lanes: LaneState[] = [];
  private nextLaneIndex = 0;
  private burstLevel: BurstLevel = 'normal';

  constructor(private readonly options: LaneAllocatorOptions) {}

  setBurstLevel(level: BurstLevel): void {
    this.burstLevel = level;
  }

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

  findPlacement(messageHeight: number, dimensions: OverlayDimensions): LanePlacement | null {
    const now = Date.now();
    const requiredLanes = this.calculateRequiredLanes(messageHeight, dimensions.laneHeight);
    if (requiredLanes > this.lanes.length) {
      return null;
    }

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
        blockReadyTime = Math.max(
          blockReadyTime,
          this.calculateLaneReadyTime(lane, now, dimensions.width)
        );
      }

      if (!allValid || !Number.isFinite(blockReadyTime)) {
        continue;
      }

      if (blockReadyTime <= now + 16) {
        bestStartIndex = startIndex;
        bestReadyTime = blockReadyTime;
        break;
      }

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

    this.nextLaneIndex = (bestStartIndex + 1) % (maxStartIndex + 1);

    const waitMs = Math.max(0, Math.ceil(bestReadyTime - now));

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

  private calculateLaneReadyTime(lane: LaneState, now: number, playerWidth: number): number {
    if (lane.lastItemStartTime <= 0) {
      return now;
    }

    const speed = this.options.getEffectiveSpeedPxPerSec();
    const fontSize = this.options.getFontSize();

    // Adaptive speed: scale effective speed by burst level so that
    // high-traffic periods scroll faster, improving throughput while
    // the per-author rate limiter keeps individual authors in check.
    const burstMultiplier = BURST_SPEED_MULTIPLIER[this.burstLevel];
    const effectiveSpeed = speed * burstMultiplier;

    // Width-proportional safe distance: wider comments need more gap.
    // When comment width approaches screen width, the gap grows so the
    // trailing comment clears the screen before the next one enters.
    // This mirrors the danmaku2ass thresholdTime approach:
    //   threshold = startTime - duration * (1 - screenWidth / (commentWidth + screenWidth))
    const commentWidth = lane.lastItemWidthPx;
    const widthRatio = commentWidth / Math.max(1, commentWidth + playerWidth);
    const baseSafeDistance = Math.max(
      fontSize * this.options.safeDistanceScale,
      this.options.safeDistanceMin
    );
    const speedFactor = Math.max(0.5, Math.min(2.0, 100 / effectiveSpeed));
    // Scale the safe distance proportionally to comment width relative to screen.
    // Narrow comments → smaller gap, wide comments → larger gap.
    const widthProportionalDistance = baseSafeDistance * (1 + widthRatio);
    const minSafeDistance = widthProportionalDistance * speedFactor;
    const requiredGapPx = commentWidth + minSafeDistance;
    const safeTimeGap = (requiredGapPx / effectiveSpeed) * 1000;
    const horizontalReadyTime = lane.lastItemStartTime + safeTimeGap;

    const traverseTimeMs = (playerWidth / effectiveSpeed) * 1000;
    const dynamicClearMs = Math.max(traverseTimeMs * 0.05, 200);
    const verticalReadyTime = lane.lastItemStartTime + dynamicClearMs;

    const laneStaggerTime = lane.lastItemStartTime + this.options.globalStaggerMs;

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
