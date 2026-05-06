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

    // ── Load-balanced weighted-random lane selection ─────────────────────
    // Spread messages across lanes by picking from top candidates with
    // decreasing probability.  Upper lanes are still preferred, but lower
    // lanes get a fair share, eliminating the staircase effect.

    const sortedPool = [...pool].sort((a, b) => a.startIndex - b.startIndex);
    const shortlistCount = Math.min(3, sortedPool.length);
    const shortlist = sortedPool.slice(0, shortlistCount);

    // Weights: [0.5, 0.3, 0.2] for top 3 candidates
    const weights = [0.5, 0.3, 0.2];
    const totalWeight = weights.slice(0, shortlistCount).reduce((a, b) => a + b, 0);
    let random = Math.random() * totalWeight;
    let chosen = shortlist[0];

    for (let i = 0; i < shortlist.length; i++) {
      random -= weights[i]!;
      if (random <= 0) {
        chosen = shortlist[i];
        break;
      }
    }

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
      // Also shift endTime to keep lane state consistent with real time.
      // Without this, after resume the allocator may think a lane is free
      // while the previous message's animation is still visible, causing overlaps.
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

    // ── Dynamic safe distance ────────────────────────────────────────
    // Scale safe distance with speed: low speed → wider gap, high speed → tighter.
    // This prevents overlapping when messages move slowly.
    const baseSafeDistance = Math.max(
      fontSize * this.options.safeDistanceScale,
      this.options.safeDistanceMin
    );
    const speedFactor = Math.max(0.5, Math.min(2.0, 100 / speed));
    const minSafeDistance = baseSafeDistance * speedFactor;
    const requiredGapPx = lane.lastItemWidthPx + minSafeDistance;
    const safeTimeGap = (requiredGapPx / speed) * 1000;
    const horizontalReadyTime = lane.lastItemStartTime + safeTimeGap;

    // ── Dynamic vertical clear time ──────────────────────────────────
    // Base on message travel time instead of fixed 20-80ms cap.
    // At low speed (50px/s on 1920px screen): traverse ~960ms, 5% = 48ms, min 200ms
    // At high speed (200px/s on 1920px screen): traverse ~240ms, 5% = 12ms, min 200ms
    const traverseTimeMs = (window.innerWidth / speed) * 1000;
    const dynamicClearMs = Math.max(traverseTimeMs * 0.05, 200);
    const verticalReadyTime = lane.lastItemStartTime + dynamicClearMs;

    const laneStaggerTime = lane.lastItemStartTime + this.options.globalStaggerMs;

    // Absolute animation end time guard: the lane is never ready before the
    // previous message's animation has finished playing.
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
