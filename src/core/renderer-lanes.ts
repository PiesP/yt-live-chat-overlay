import type { LaneState, OverlayDimensions } from '@app-types';

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
  readonly verticalClearTimeMin: number;
  readonly verticalClearTimeMax: number;
  readonly laneHeightPaddingScale: number;
  readonly laneHeightPaddingMin: number;
}

/** Random-noise range for top-weighted lane selection — larger = more spread across lanes. */
const LANE_NOISE_RANGE = 4;

export class LaneAllocator {
  private lanes: LaneState[] = [];

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
  }

  isEmpty(): boolean {
    return this.lanes.length === 0;
  }

  findPlacement(messageHeight: number, dimensions: OverlayDimensions): LanePlacement | null {
    const now = Date.now();
    const requiredLanes = this.calculateRequiredLanes(messageHeight, dimensions.laneHeight);
    if (requiredLanes > this.lanes.length) {
      return null;
    }

    interface BlockCandidate {
      startIndex: number;
      readyTime: number;
    }

    const candidates: BlockCandidate[] = [];
    let minReadyTime = Number.POSITIVE_INFINITY;

    for (let index = 0; index <= this.lanes.length - requiredLanes; index++) {
      let blockReadyTime = now;

      for (let offset = 0; offset < requiredLanes; offset++) {
        const lane = this.lanes[index + offset];
        if (!lane) {
          blockReadyTime = Number.POSITIVE_INFINITY;
          break;
        }

        blockReadyTime = Math.max(blockReadyTime, this.calculateLaneReadyTime(lane, now));
      }

      if (!Number.isFinite(blockReadyTime)) {
        continue;
      }

      candidates.push({ startIndex: index, readyTime: blockReadyTime });
      minReadyTime = Math.min(minReadyTime, blockReadyTime);
    }

    if (candidates.length === 0 || !Number.isFinite(minReadyTime)) {
      return null;
    }

    const readyNow = candidates.filter((candidate) => candidate.readyTime <= now + 16);
    const pool =
      readyNow.length > 0
        ? readyNow
        : candidates.filter((candidate) => candidate.readyTime === minReadyTime);

    // ── Top-weighted lane selection with noise ──────────────────────────
    // Prefer upper lanes (lower startIndex) so messages fill from the top of
    // the screen, but add random jitter so adjacent messages don't pile up on
    // the exact same lane every time.

    let bestScore = Number.POSITIVE_INFINITY;
    let bestCandidate: BlockCandidate | null = null;

    for (const candidate of pool) {
      const score = candidate.startIndex + Math.random() * LANE_NOISE_RANGE;
      if (score < bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    const chosen = bestCandidate ?? candidates[0];
    if (!chosen) {
      return null;
    }

    const chosenLane = this.lanes[chosen.startIndex];
    if (!chosenLane) {
      return null;
    }

    const scheduledTime = chosen.readyTime;

    return {
      lane: chosenLane,
      laneSpan: requiredLanes,
      waitMs: Math.max(0, Math.ceil(scheduledTime - now)),
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
    // future after long pauses (e.g. tab hidden 30+ min). Callers should
    // also cap their input, but this ensures correctness either way.
    const clampedMs = Math.min(deltaMs, 60_000);

    for (const lane of this.lanes) {
      if (lane.lastItemStartTime > 0) {
        lane.lastItemStartTime += clampedMs;
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

    const baseSafeDistance = this.options.getFontSize() * this.options.safeDistanceScale;
    const minSafeDistance = Math.max(baseSafeDistance, this.options.safeDistanceMin);
    const requiredGapPx = lane.lastItemWidthPx + minSafeDistance;
    const safeTimeGap = (requiredGapPx / this.options.getEffectiveSpeedPxPerSec()) * 1000;
    const horizontalReadyTime = lane.lastItemStartTime + safeTimeGap;
    const verticalClearTime = Math.min(
      this.options.verticalClearTimeMax,
      Math.max(this.options.verticalClearTimeMin, lane.lastItemHeightPx * 4)
    );
    const verticalReadyTime = lane.lastItemStartTime + verticalClearTime;

    const laneStaggerTime = lane.lastItemStartTime + this.options.globalStaggerMs;

    // Absolute animation end time guard: the lane is never ready before the
    // previous message's animation has finished playing.  This prevents
    // overlaps that horizontal/vertical estimates miss (e.g. entry-offset
    // jitter stretching the actual travel duration).
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
