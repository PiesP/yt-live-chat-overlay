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
  readonly laneHeightPaddingScale: number;
  readonly laneHeightPaddingMin: number;
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
      totalMessages: 0,
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
    const now = performance.now();
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
        // Immediate dispatch: prefer lane(s) with fewer total messages
        if (
          bestStartIndex === -1 ||
          candidateTotalMsgs < bestTotalMsgs ||
          (candidateTotalMsgs === bestTotalMsgs && blockReadyTime < bestReadyTime)
        ) {
          bestStartIndex = startIndex;
          bestReadyTime = blockReadyTime;
        }
        continue; // Keep scanning for an even less-loaded candidate
      }

      // Fallback: prefer earliest ready time, break ties by load
      if (
        blockReadyTime < bestReadyTime ||
        (blockReadyTime === bestReadyTime && candidateTotalMsgs < bestTotalMsgs)
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
    const end = Math.min(placement.lane.index + placement.laneSpan, this.lanes.length);
    for (let index = placement.lane.index; index < end; index++) {
      const laneState = this.lanes[index];
      if (!laneState) continue;
      laneState.lastItemStartTime = startTime;
      laneState.lastItemEndTime = endTime;
      laneState.lastItemWidthPx = textWidth;
      laneState.lastItemHeightPx = messageHeight;
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
