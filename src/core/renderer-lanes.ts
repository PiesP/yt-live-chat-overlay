import type { LaneState, OverlayDimensions } from '@app-types';

export interface LanePlacement {
  lane: LaneState;
  laneSpan: number;
  waitMs: number;
  laneY: number;
}

interface LaneAllocatorOptions {
  readonly getFontSize: () => number;
  readonly getEffectiveSpeedPxPerSec: () => number;
  readonly globalStaggerMs: number;
  readonly safeDistanceScale: number;
  readonly safeDistanceMin: number;
  readonly safeTop: number;
  readonly laneSpacing: number;
}

/**
 * Threshold (ms) for treating a lane placement as "immediate".
 * When the expected wait time is within this threshold of 'now', we
 * consider the slot available rather than deferring, even if there's
 * minor overlap with the preceding message's animation tail.
 */
const IMMEDIATE_PLACEMENT_THRESHOLD_MS = 48;

export class LaneAllocator {
  private lanes: LaneState[] = [];
  private laneHeight = 0;

  constructor(private readonly options: LaneAllocatorOptions) {}

  reset(dimensions: OverlayDimensions | null): void {
    if (!dimensions) {
      this.lanes = [];
      this.laneHeight = 0;
      return;
    }

    this.laneHeight = dimensions.laneHeight + this.options.laneSpacing;

    this.lanes = Array.from({ length: dimensions.laneCount }, (_, index) => ({
      index,
      lastItemStartTime: 0,
      lastItemEndTime: 0,
      lastItemWidthPx: 0,
      totalMessages: 0,
    }));
  }

  isEmpty(): boolean {
    return this.lanes.length === 0;
  }

  getLaneCount(): number {
    return this.lanes.length;
  }

  getLaneHeight(): number {
    return this.laneHeight;
  }

  /**
   * Return the Y pixel position for a lane block, accounting for safeTop.
   * This is the single source of truth for vertical message placement.
   */
  getLaneY(laneIndex: number): number {
    return this.options.safeTop + laneIndex * this.laneHeight;
  }

  findPlacement(messageHeight: number, dimensions: OverlayDimensions): LanePlacement | null {
    const now = performance.now();
    const requiredLanes = this.calculateRequiredLanes(messageHeight);
    if (requiredLanes > this.lanes.length) {
      return null;
    }

    const maxStartIndex = this.lanes.length - requiredLanes;
    let bestStartIndex = -1;
    let bestReadyTime = Number.POSITIVE_INFINITY;

    // Top-down scan: always start from lane 0 (top of screen)
    // so the upper portion of the overlay gets filled first.
    for (let startIndex = 0; startIndex <= maxStartIndex; startIndex++) {
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

      // For single-lane messages, also check adjacent lanes but only for
      // horizontal overlap (not vertical). Adjacent-lane comments that have
      // already scrolled past the midpoint of the screen are safe to share
      // vertical space with, since CSS overflow:hidden clips them.
      if (requiredLanes === 1 && blockReadyTime > now + IMMEDIATE_PLACEMENT_THRESHOLD_MS) {
        const relaxedTime = this.calculateRelaxedReadyTime(startIndex, now, dimensions.width);
        if (relaxedTime <= now + IMMEDIATE_PLACEMENT_THRESHOLD_MS) {
          blockReadyTime = relaxedTime;
        }
      }

      const candidateTotalMsgs = this.getTotalMessages(startIndex, requiredLanes);
      const bestTotalMsgs =
        bestStartIndex >= 0 ? this.getTotalMessages(bestStartIndex, requiredLanes) : Infinity;

      if (blockReadyTime <= now + IMMEDIATE_PLACEMENT_THRESHOLD_MS) {
        // Immediate dispatch: prefer lane(s) with fewer total messages,
        // then top-most (lower index) to keep the upper area filled.
        if (
          bestStartIndex === -1 ||
          candidateTotalMsgs < bestTotalMsgs ||
          (candidateTotalMsgs === bestTotalMsgs &&
            (blockReadyTime < bestReadyTime || startIndex < bestStartIndex))
        ) {
          bestStartIndex = startIndex;
          bestReadyTime = blockReadyTime;
        }
        continue; // Keep scanning for an even less-loaded candidate
      }

      // Fallback: prefer earliest ready time, break ties by load, then top-most
      if (
        blockReadyTime < bestReadyTime ||
        (blockReadyTime === bestReadyTime && candidateTotalMsgs < bestTotalMsgs) ||
        (blockReadyTime === bestReadyTime &&
          candidateTotalMsgs === bestTotalMsgs &&
          startIndex < bestStartIndex)
      ) {
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

    const waitMs = Math.max(0, Math.ceil(bestReadyTime - now));

    return {
      lane: chosenLane,
      laneSpan: requiredLanes,
      waitMs,
      laneY: this.getLaneY(bestStartIndex),
    };
  }

  commitPlacement(
    placement: LanePlacement,
    textWidth: number,
    startTime: number,
    endTime: number
  ): void {
    const end = Math.min(placement.lane.index + placement.laneSpan, this.lanes.length);
    for (let index = placement.lane.index; index < end; index++) {
      const laneState = this.lanes[index];
      if (!laneState) continue;
      laneState.lastItemStartTime = startTime;
      laneState.lastItemEndTime = endTime;
      laneState.lastItemWidthPx = textWidth;
      laneState.totalMessages++;
    }
  }

  /** Sum of totalMessages across a contiguous block of lanes. */
  private getTotalMessages(startIndex: number, span: number): number {
    let total = 0;
    for (let i = startIndex; i < startIndex + span && i < this.lanes.length; i++) {
      total += this.lanes[i]?.totalMessages ?? 0;
    }
    return total;
  }

  /**
   * For single-lane messages, calculate a relaxed ready time that allows
   * vertical overlap with adjacent lanes when their comments have already
   * scrolled past the screen midpoint. CSS overflow:hidden clips them, so
   * only horizontal overlap matters.
   */
  private calculateRelaxedReadyTime(laneIndex: number, now: number, playerWidth: number): number {
    const speed = this.options.getEffectiveSpeedPxPerSec();
    let relaxedTime = now;

    for (const delta of [-1, 0, 1]) {
      const idx = laneIndex + delta;
      if (idx < 0 || idx >= this.lanes.length) continue;
      const lane = this.lanes[idx];
      if (!lane || lane.lastItemStartTime <= 0) continue;

      if (delta === 0) {
        // Target lane: full collision check
        relaxedTime = Math.max(relaxedTime, this.calculateLaneReadyTime(lane, now, playerWidth));
      } else {
        // Adjacent lane: only check horizontal overlap.
        // If the adjacent comment has scrolled past the midpoint, it is
        // already clipping and safe to share vertical space with.
        const halfScreenTime = (playerWidth / 2 / speed) * 1000;
        const midpointReadyTime = lane.lastItemStartTime + halfScreenTime;
        if (midpointReadyTime > now) {
          // Adjacent comment hasn't passed midpoint yet — use stagger only
          const staggerTime = lane.lastItemStartTime + this.options.globalStaggerMs;
          relaxedTime = Math.max(relaxedTime, staggerTime);
        }
        // If past midpoint, adjacent lane imposes no constraint (overflow:hidden)
      }
    }

    return relaxedTime;
  }

  private calculateRequiredLanes(messageHeight: number): number {
    if (this.laneHeight <= 0) return 1;
    return Math.max(1, Math.ceil(messageHeight / this.laneHeight));
  }

  private calculateLaneReadyTime(lane: LaneState, now: number, playerWidth: number): number {
    if (lane.lastItemStartTime <= 0) {
      return now;
    }

    const speed = this.options.getEffectiveSpeedPxPerSec();
    const fontSize = this.options.getFontSize();

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
    // Scale the safe distance proportionally to comment width relative to screen.
    const speedFactor = Math.max(0.5, Math.min(2.0, 100 / speed));
    const widthProportionalDistance = baseSafeDistance * (1 + widthRatio);
    const minSafeDistance = widthProportionalDistance * speedFactor;
    const requiredGapPx = commentWidth + minSafeDistance;
    const safeTimeGap = (requiredGapPx / speed) * 1000;
    const horizontalReadyTime = lane.lastItemStartTime + safeTimeGap;

    const traverseTimeMs = (playerWidth / speed) * 1000;
    const dynamicClearMs = Math.max(traverseTimeMs * 0.05, 100);
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
