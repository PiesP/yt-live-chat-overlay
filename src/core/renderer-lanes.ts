import type { DanmakuMode, LaneState, OverlayDimensions } from '@app-types';

export interface LanePlacement {
  lane: LaneState;
  laneSpan: number;
  waitMs: number;
  laneY: number;
}

interface LaneAllocatorOptions {
  readonly getFontSize: () => number;
  readonly getEffectiveSpeedPxPerSec: () => number;
  readonly getDanmakuMode: () => DanmakuMode;
  readonly globalStaggerMs: number;
  readonly safeDistanceScale: number;
  readonly safeDistanceMin: number;
  readonly safeTop: number;
  readonly laneSpacing: number;
}

/**
 * Threshold (ms) for treating a lane placement as "immediate".
 * Kept tight to prevent same-lane comments from being placed so close
 * together that minor timing jitter causes visual overlap.
 */
const IMMEDIATE_PLACEMENT_THRESHOLD_MS = 16;

/**
 * Speed safety factor for segment-based lane clearance.
 *
 * Under the constant-duration model, all comments cross the screen in the
 * same baseDuration regardless of text width. This means WIDER comments
 * move FASTER (they cover more pixels in the same time). When a wide (fast)
 * comment follows a narrow (slow) one on the same lane, its left edge
 * catches up to the leading comment's right edge, causing visual overlap.
 *
 * This factor adds a width-proportional safety buffer to the segment
 * clearance time, ensuring the following comment never catches up.
 * 0.3 = 30% of the leading comment's text width added as extra clearance.
 */
const SPEED_SAFETY_FACTOR = 0.3;

/**
 * Multi-lane message speed penalty factor.
 * Multi-lane messages (superchat/membership cards) span 2+ lanes and move
 * faster due to their larger width. This extra factor adds additional
 * safety margin when a multi-lane message is on the lane.
 * 0.5 = 50% of text width added for multi-lane messages.
 */
const MULTI_LANE_SAFETY_FACTOR = 0.5;

/**
 * Tracks a single active comment's horizontal presence on a lane.
 * Used for 2D collision detection — instead of blocking a lane entirely
 * until the comment's animation ends, we track its real-time horizontal
 * position and only prevent overlap when segments intersect.
 *
 * A scrolling comment travels from right to left (or left to right in
 * reverse mode) across the full player width. The right edge must clear
 * the entry point of any new comment before the new one can start, AND
 * the speed differential must not cause the following comment to catch up.
 */
interface ActiveSegment {
  startTime: number;
  endTime: number;
  /** Total visual distance traveled: entryOffset + screenWidth + textWidth + exitPadding */
  totalDistance: number;
  /** Entry offset (per-lane stagger) that shifts the comment right at start */
  entryOffset: number;
  /** Rendered text width of the comment */
  textWidth: number;
  /** Number of lanes this segment occupies (1 for regular, 2+ for superchat/cards) */
  laneSpan: number;
}

export class LaneAllocator {
  private lanes: LaneState[] = [];
  private laneHeight = 0;
  /** Per-lane array of active horizontal segments for 2D collision detection */
  private laneSegments: ActiveSegment[][] = [];

  constructor(private readonly options: LaneAllocatorOptions) {}

  reset(dimensions: OverlayDimensions | null): void {
    if (!dimensions) {
      this.lanes = [];
      this.laneHeight = 0;
      this.laneSegments = [];
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
    this.laneSegments = Array.from({ length: dimensions.laneCount }, () => []);
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

  /**
   * Estimate the entry offset a new comment would have if placed on the
   * given lane. The entry offset creates a per-lane stagger effect where
   * top lanes start closer to the visible area and bottom lanes start
   * further off-screen.
   */
  private estimateEntryOffset(laneIndex: number): number {
    const baseOffset =
      this.lanes.length > 1 ? Math.round((laneIndex / (this.lanes.length - 1)) * 200) : 100;
    // Use the midpoint of the jitter range as the estimate (jitter = 0-30)
    return baseOffset + 15;
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
          this.calculateLaneReadyTime(lane, now, dimensions.width, requiredLanes)
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
        const relaxedTime = this.calculateRelaxedReadyTime(
          startIndex,
          now,
          dimensions.width,
          requiredLanes
        );
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
    entryOffset: number,
    totalDistance: number,
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

      // Register a horizontal segment for 2D collision tracking.
      // This allows the lane to be reused while the comment is still visible
      // on screen — a new comment can start as long as existing segments'
      // right edges have moved left of the entry point (with speed safety).
      if (this.laneSegments[index]) {
        this.laneSegments[index]?.push({
          startTime,
          endTime,
          totalDistance,
          entryOffset,
          textWidth,
          laneSpan: placement.laneSpan,
        });
      }
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
  private calculateRelaxedReadyTime(
    laneIndex: number,
    now: number,
    playerWidth: number,
    requiredLanes: number
  ): number {
    const speed = this.options.getEffectiveSpeedPxPerSec();
    let relaxedTime = now;

    for (const delta of [-1, 0, 1]) {
      const idx = laneIndex + delta;
      if (idx < 0 || idx >= this.lanes.length) continue;
      const lane = this.lanes[idx];
      if (!lane || lane.lastItemStartTime <= 0) continue;

      if (delta === 0) {
        // Target lane: full collision check (pass requiredLanes for context)
        relaxedTime = Math.max(
          relaxedTime,
          this.calculateLaneReadyTime(lane, now, playerWidth, requiredLanes)
        );
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

  /** Remove segments whose animation has fully ended. */
  private cleanExpiredSegments(laneIndex: number, now: number): void {
    const segments = this.laneSegments[laneIndex];
    if (!segments) return;
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (seg && seg.endTime <= now) {
        segments.splice(i, 1);
      }
    }
  }

  /**
   * Calculate the time when a lane becomes available for a new message.
   *
   * Uses 2D horizontal segment tracking for scrolling modes. Each lane
   * tracks the real-time horizontal position of every active comment
   * (its "segment"). A new comment can start when:
   *
   * 1. All existing segments' right edges have cleared the entry point
   * 2. Add a speed safety buffer to prevent catch-up overlap
   *
   * ── Speed mismatch overlap ─────────────────────────────────────────
   * Under the constant-duration model, all comments cross the screen in
   * `baseDuration` regardless of width. A wider comment covers more
   * distance in the same time, so it moves faster:
   *
   *   speed = totalDistance / baseDuration
   *         = (entryOffset + screenWidth + textWidth + exitPadding) / baseDuration
   *
   * If a wide (fast) comment follows a narrow (slow) one without enough
   * gap, its left edge catches up to the narrow comment's right edge:
   *
   *   catchUpRate = speed_follow - speed_lead  (px/ms)
   *   catchUpDist = catchUpRate × remainingTime (px)
   *
   * The SPEED_SAFETY_FACTOR adds textWidth × 0.3 of extra clearance
   * distance, ensuring the following comment never catches up for
   * realistic speed ratios. Multi-lane messages get an additional
   * MULTI_LANE_SAFETY_FACTOR since they're significantly faster.
   *
   * ── Timeline comparison (200px text, 1920px screen, speed=250) ─────
   *   Phase 2B (60% screen):   4608ms  (no segment tracking)
   *   Phase 4B (basic seg):     993ms  (right-edge only, mid-lane)
   *   This fix (with safety):   993ms  (mid-lane, ~50% inherent buffer
   *                                     from entryOffset addition)
   *                             1073ms  (top-lane, with explicit 30% buffer)
   * ────────────────────────────────────────────────────────────────────
   *
   * For top/bottom fixed modes, comments stay in place so we use
   * the full animation end time.
   */
  private calculateLaneReadyTime(
    lane: LaneState,
    now: number,
    playerWidth: number,
    newMessageLaneSpan: number = 1
  ): number {
    if (lane.lastItemStartTime <= 0) {
      return now;
    }

    const speed = this.options.getEffectiveSpeedPxPerSec();
    const fontSize = this.options.getFontSize();

    // Width-proportional safe distance (following distance between consecutive comments)
    const commentWidth = lane.lastItemWidthPx;
    const widthRatio = commentWidth / Math.max(1, commentWidth + playerWidth);
    const baseSafeDistance = Math.max(
      fontSize * this.options.safeDistanceScale,
      this.options.safeDistanceMin
    );
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

    // ── 2D Horizontal segment tracking ─────────────────────────────────
    // For scrolling modes, check all active segments for horizontal clearance.
    const mode = this.options.getDanmakuMode();
    const isScrolling = mode === 'scroll' || mode === 'reverse';

    let horizontalClearTime: number;
    if (isScrolling) {
      this.cleanExpiredSegments(lane.index, now);
      const segments = this.laneSegments[lane.index];
      if (!segments || segments.length === 0) {
        horizontalClearTime = now;
      } else {
        horizontalClearTime = now;

        // Estimate the entry offset for a new comment on this lane
        const newEntryOffset = this.estimateEntryOffset(lane.index);

        for (const seg of segments) {
          // ── Base distance: right edge must clear new comment's entry point ──
          // For same-lane reuse, seg.entryOffset ≈ newEntryOffset, so this
          // simplifies to just seg.textWidth.
          const baseClearDist = Math.max(0, seg.entryOffset + seg.textWidth - newEntryOffset);

          // ── Speed safety buffer: prevent catch-up by a following wider comment ──
          // Under constant-duration scrolling, a wider (faster) comment catches
          // up to a narrower (slower) one. Add a width-proportional buffer.
          let speedSafetyDist = seg.textWidth * SPEED_SAFETY_FACTOR;

          // Multi-lane messages (superchat/membership) are significantly wider
          // and thus faster — add extra safety.
          if (seg.laneSpan > 1) {
            speedSafetyDist += seg.textWidth * MULTI_LANE_SAFETY_FACTOR;
          }

          // For the NEW message: if it's multi-lane (wider/faster), add extra
          // safety since it will catch up faster.
          if (newMessageLaneSpan > 1) {
            speedSafetyDist += seg.textWidth * MULTI_LANE_SAFETY_FACTOR;
          }

          const totalClearDist = Math.max(seg.textWidth * 1.2, baseClearDist + speedSafetyDist);
          const segDuration = seg.endTime - seg.startTime;
          if (segDuration <= 0) continue;

          const clearRatio = Math.min(1, totalClearDist / seg.totalDistance);
          const segClearTime = seg.startTime + clearRatio * segDuration;
          horizontalClearTime = Math.max(horizontalClearTime, segClearTime);
        }
      }
    } else {
      // Top/bottom: comments stay in place, use full end time
      horizontalClearTime = lane.lastItemEndTime;
    }

    return Math.max(
      now,
      horizontalReadyTime,
      verticalReadyTime,
      laneStaggerTime,
      horizontalClearTime
    );
  }
}
