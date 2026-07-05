// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { FontWeight, OverlayDimensions } from '@app-types';
import { rendererLayout } from '@core/design-tokens';
import {
  buildLaneHeap,
  computeLaneY,
  computeOccupancyMs,
  findPlacementShared,
  heapSiftDown,
  heapUpdateLane,
} from '@core/lane-allocation-shared';
import { createLogger } from '@core/logging';
import { SPEED_TIER } from '@core/renderer-constants';
import { getFontString, measureTextHeight } from '@core/text-measure';

const log = createLogger('LaneAllocator');

export interface LanePlacement {
  laneIndex: number;
  waitMs: number;
  laneY: number;
  /** Number of lane slots this message occupies (1 for regular, 2+ for superchat/membership) */
  slotCount: number;
  /**
   * Vertical centering offset within the allocated lane block (px).
   * Tall messages (with author, multi-line cards) are centered in their
   * multi-slot block to distribute empty space evenly above and below.
   * Single-slot messages return 0 (close to the lane top, no visible gap).
   */
  verticalOffset: number;
}

export interface LaneAllocatorOptions {
  safeTop: number;
  safeBottom: number;
  fontSize: number;
  fontWeight: FontWeight;
  fontFamily: string;
  laneSpacing: number;
  headwayGapRatio: number;
  exitPaddingPx: number;
  scrollDurationMaxMs: number;
  maxMessageAgeMs: number;
}

/**
 * Serializable snapshot of LaneAllocator's internal state.
 * Enables cross-thread transfer (e.g. main → Worker) and
 * deterministic unit testing of allocation logic.
 */
export interface LaneAllocatorSnapshot {
  heap: [number, number][];
  /** laneIndex → heapIndex, serialized as a plain object for JSON transfer. */
  indexMap: Record<number, number>;
  laneHeight: number;
  laneCount: number;
  /** laneIndex → { tier, until }, serialized as a plain object. */
  speedTierLanes: Record<number, { tier: number; until: number }>;
}

/**
 * Top-first lane scheduler with tiered-speed lane allocation.
 *
 * Fills lanes from the top of the screen down using a three-phase strategy
 * that naturally groups messages with similar speeds together:
 *
 *   1. Phase 1 (zero-wait, speed-filtered): return the first lane with
 *      waitMs === 0 that also passes the speed-tier compatibility check.
 *      Messages skip lanes with incompatible speed-tier content.
 *      During a burst this distributes across all lanes: msg1 → lane 0,
 *      msg2 → lane 1, ..., msgN → lane N-1.
 *
 *   2. Phase 2 (speed-matched): when all lanes are busy, prefer lanes
 *      that already have same-tier content. Messages cluster with their
 *      own tier. This produces natural visual zones without hard-coded
 *      partitions.
 *
 *   3. Phase 3 (fastest-free): when no speed-matched lane is available,
 *      return the topmost busy lane (shortest wait) for all message types.
 *      Speed-isolated headway scaling in checkPlacement() prevents visual
 *      overtaking when a fast message shares a lane with a slower one.
 *
 * Supports:
 *   - Precision exit-time occupancy for multi-message lane sharing
 *   - Adaptive headway gap (8% of msg width, 16-60px clamp)
 *   - Velocity-aware durationMin (via computeScrollDuration)
 */
export class LaneAllocator {
  /** 4-ary min-heap of [laneIndex, availableAtMs] pairs, sorted by availableAtMs */
  private heap: [number, number][] = [];
  /** Reverse map: laneIndex → heap index for O(1) lookup and update */
  private indexMap: Map<number, number> = new Map();
  private laneHeight = 0;
  private numLanes = 0;
  /** Cached utilization value, recomputed in resetBatch for O(1) reads. */
  private cachedUtilization = 0;
  /** Number of lanes currently occupied (availableAt > now). Maintained incrementally. */
  private occupiedCount = 0;

  /**
   * Set of lane indices that collided with an active message in the current
   * batch. Updated via markCollision() from renderer-canvas.ts checkPlacement.
   * Cleared on resetBatch(). When a lane is in this set, allocateSingleLane
   * skips it and tries the next lane down, avoiding repeated collisions on
   * the same lane within a single frame.
   */
  private collidedLanes: Set<number> = new Set();

  /**
   * Per-lane active speed tier tracking: laneIndex → { tier, until }.
   * Replaces the old realTimeLanesUntil / backlogLanesUntil dual-map.
   * Two tiers are speed-compatible when within 1 tier of each other
   * (e.g. Mid and Near can share, but Far and Backlog cannot).
   * Stale entries (until < now) are cleared on each resetBatch().
   */
  private speedTierLanes: Map<number, { tier: number; until: number }> = new Map();

  constructor(private readonly options: LaneAllocatorOptions) {}

  /** Update safe-zone ratios without rebuilding lane state. */
  updateSafeZone(safeTop: number, safeBottom: number): void {
    this.options.safeTop = safeTop;
    this.options.safeBottom = safeBottom;
  }

  /** Update font metrics — caller must call `reset()` afterwards to apply. */
  updateFontMetrics(
    fontSize: number,
    fontWeight: FontWeight,
    fontFamily: string,
    laneSpacing: number
  ): void {
    this.options.fontSize = fontSize;
    this.options.fontWeight = fontWeight;
    this.options.fontFamily = fontFamily;
    this.options.laneSpacing = laneSpacing;
  }

  reset(dimensions: OverlayDimensions | null): void {
    this.heap = [];
    this.indexMap = new Map();
    this.collidedLanes.clear();
    this.speedTierLanes.clear();
    this.cachedUtilization = 0;
    this.occupiedCount = 0;
    this.utilizationRecountCounter = 0;
    if (!dimensions) {
      this.laneHeight = 0;
      this.numLanes = 0;
      return;
    }

    // Formula: laneHeight = textHeight + paddingV*2 + laneSpacing
    const totalPaddingV = rendererLayout.paddingV * 2;
    const font = getFontString(
      this.options.fontSize,
      this.options.fontWeight,
      this.options.fontFamily
    );
    const textHeight = measureTextHeight(font, this.options.fontSize);

    this.laneHeight = Math.max(1, textHeight + totalPaddingV + this.options.laneSpacing);

    const usableHeight = dimensions.height * (1 - this.options.safeTop - this.options.safeBottom);
    this.numLanes = Math.max(1, Math.floor(usableHeight / this.laneHeight));

    log.debug('Reset', { lanes: this.numLanes, height: Math.round(this.laneHeight) });

    // Uniform initialization: all lanes start at the same available time.
    const now = performance.now();
    this.heap = buildLaneHeap(this.numLanes, now, this.indexMap);
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /**
   * Export current allocator state as a serializable snapshot.
   * Transient/derived state (collidedLanes, utilization counters) is
   * excluded — they are reset on the next frame via resetBatch().
   */
  snapshot(): LaneAllocatorSnapshot {
    const indexMap: Record<number, number> = {};
    this.indexMap.forEach((v, k) => {
      indexMap[k] = v;
    });
    const speedTierMap: Record<number, { tier: number; until: number }> = {};
    this.speedTierLanes.forEach((v, k) => {
      speedTierMap[k] = { tier: v.tier, until: v.until };
    });
    return {
      heap: structuredClone(this.heap),
      indexMap,
      laneHeight: this.laneHeight,
      laneCount: this.numLanes,
      speedTierLanes: speedTierMap,
    };
  }

  /**
   * Restore allocator state from a previously captured snapshot.
   * Resets all transient state — call before the next frame's drainQueue.
   */
  restore(snapshot: LaneAllocatorSnapshot): void {
    this.heap = structuredClone(snapshot.heap);
    this.indexMap = new Map(Object.entries(snapshot.indexMap).map(([k, v]) => [Number(k), v]));
    this.laneHeight = snapshot.laneHeight;
    this.numLanes = snapshot.laneCount;
    this.speedTierLanes = new Map(
      Object.entries(snapshot.speedTierLanes).map(([k, v]) => [
        Number(k),
        { tier: v.tier, until: v.until },
      ])
    );
    this.collidedLanes.clear();
    this.cachedUtilization = 0;
    this.occupiedCount = 0;
    this.utilizationRecountCounter = 0;
  }

  getLaneCount(): number {
    return this.numLanes;
  }

  /** Get current lane utilization ratio (0-1): occupied lanes / total lanes. O(1) cached value. */
  getUtilization(): number {
    if (this.heap.length === 0) return 0;
    return this.cachedUtilization;
  }

  getLaneHeight(): number {
    return this.laneHeight;
  }

  getLaneY(laneIndex: number, viewportHeight: number): number {
    return computeLaneY(laneIndex, viewportHeight, this.options.safeTop, this.laneHeight);
  }

  findPlacement(
    messageHeight: number,
    dimensions: OverlayDimensions,
    speedTier: number = SPEED_TIER.MID
  ): LanePlacement | null {
    const now = performance.now();
    const totalLanes = this.numLanes;
    if (totalLanes <= 0) return null;

    const slotCount = Math.max(1, Math.ceil(messageHeight / this.laneHeight));

    // Delegate to shared pure function via LaneAllocationState cast.
    const state = this as unknown as import('@core/lane-allocation-shared').LaneAllocationState;
    const result = findPlacementShared(
      state,
      now,
      messageHeight,
      this.laneHeight,
      this.options.scrollDurationMaxMs,
      speedTier
    );
    if (!result) return null;

    return {
      laneIndex: result.laneIndex,
      waitMs: result.waitMs,
      laneY: this.getLaneY(result.laneIndex, dimensions.height),
      slotCount,
      verticalOffset: Math.floor((slotCount * this.laneHeight - messageHeight) / 2),
    };
  }

  /**
   * Commit the placement — update the lane's available time for the
   * next message. For multi-slot messages, all occupied lanes are updated.
   *
   * For scrolling mode, uses precision exit-time:
   *   occupancyMs = rightEdgePassMs
   *
   * For top/bottom mode, msgWidth/screenWidth are omitted and the old
   * duration + cooldown model applies.
   */
  commitPlacement(
    placement: LanePlacement,
    startTime: number,
    durationMs: number,
    msgWidth?: number,
    screenWidth?: number,
    speedTier: number = SPEED_TIER.MID
  ): void {
    const occupancyMs = this.computeOccupancyMs(durationMs, msgWidth, screenWidth);
    const nextAvailable = startTime + occupancyMs;
    const startIdx = placement.laneIndex;

    // Track speed-tier visibility per lane so subsequent allocations
    // can group messages by speed tier. Uses durationMs (full on-screen
    // time) rather than occupancyMs to prevent cross-tier overtaking.
    const until = startTime + durationMs;
    for (let offset = 0; offset < placement.slotCount; offset++) {
      const slotIdx = startIdx + offset;
      this.speedTierLanes.set(slotIdx, { tier: speedTier, until });
    }

    // Update all slots occupied by this message with the SAME available time.
    for (let offset = 0; offset < placement.slotCount; offset++) {
      const slotIdx = startIdx + offset;
      this.updateLane(slotIdx, nextAvailable);
    }
  }

  // ── Batch control ─────────────────────────────────────────────────────

  /** Frames until next utilization recount — amortizes the O(n) scan. */
  private utilizationRecountCounter = 0;
  /** Recount interval — recompute utilization every N frames. */
  // C3: Reduced from 10 to 3 frames. A stale 100% utilization for 10 frames
  // (167ms) could keep anti-block active after lanes free up, causing backlog
  // messages to be permanently stuck (they skip Phase 3). 3 frames (~50ms)
  // is enough amortization without risking backlog deadlock.
  private static readonly UTILIZATION_RECOUNT_INTERVAL = 3;

  /**
   * Called at the start of each drainQueue batch. Clears per-frame collision
   * tracking so lanes can be retried on the next frame.
   */
  resetBatch(): void {
    // Heap integrity guard: heap length must match index map size.
    // A mismatch indicates a corrupted laneIndexToHeapIndex mapping
    // (duplicate or missing lane entries).
    if (this.heap.length !== this.indexMap.size) {
      log.warn(
        `Heap integrity violation: heap.length=${this.heap.length} != ` +
          `laneIndexToHeapIndex.size=${this.indexMap.size}. Rebuilding index map.`
      );
      // Rebuild laneIndexToHeapIndex from scratch to restore consistency
      this.indexMap.clear();
      for (let i = 0; i < this.heap.length; i++) {
        const entry = this.heap[i];
        if (entry) this.indexMap.set(entry[0], i);
      }
      // Re-heapify to restore min-heap invariant (corrupted heap may remain
      // after index map rebuild — the heap array itself could be out of order).
      for (let i = Math.floor((this.heap.length - 2) / 4); i >= 0; i--) {
        this.siftDown(i);
      }
    }

    // Prune expired speed-tier entries and clear collision set.
    const now = performance.now();
    for (const [laneIdx, entry] of this.speedTierLanes) {
      if (entry.until <= now) this.speedTierLanes.delete(laneIdx);
    }
    this.collidedLanes.clear();

    // Amortized utilization recount: scan the heap every N frames instead of
    // every frame. Between recounts, the cached value is slightly stale but
    // the anti-block gate uses a gradual probabilistic threshold, so a ~5-frame
    // staleness is visually indistinguishable.
    this.utilizationRecountCounter++;
    if (this.utilizationRecountCounter >= LaneAllocator.UTILIZATION_RECOUNT_INTERVAL) {
      this.utilizationRecountCounter = 0;
      let occupied = 0;
      for (const [, availableAt] of this.heap) {
        if (availableAt > now) occupied++;
      }
      this.occupiedCount = occupied;
    }
    this.cachedUtilization = this.heap.length > 0 ? this.occupiedCount / this.heap.length : 0;
  }

  /**
   * Mark a lane as having collided with an active message in this batch.
   * Subsequent findPlacement() calls in the same batch skip this lane,
   * falling through to the next available lane below.
   */
  markCollision(laneIndex: number): void {
    this.collidedLanes.add(laneIndex);
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Compute the effective time this message occupies its lane.
   *
   * For scrolling mode: precision exit-time with adaptive headway gap.
   * For top/bottom mode: full duration + safety cooldown.
   */
  private computeOccupancyMs(
    durationMs: number,
    msgWidthPx?: number,
    screenWidth?: number
  ): number {
    return computeOccupancyMs(
      durationMs,
      this.options.exitPaddingPx,
      this.options.headwayGapRatio,
      msgWidthPx,
      screenWidth
    );
  }

  /**
   * Allocate a contiguous block of `slotCount` lanes for tall messages
   * (superchat, membership). Uses a 3-phase strategy:
   *

  /** Get the available-at time for a lane by its index. */

  /** Update a lane's available time in the heap. */
  private updateLane(laneIndex: number, newAvailableAt: number): void {
    heapUpdateLane(this.heap, this.indexMap, laneIndex, newAvailableAt);
  }

  /** Shift all lane timers and speed-tier tracking by a fixed offset. */
  shiftAll(offsetMs: number): void {
    if (offsetMs <= 0) return;

    // Shift lane occupancy timers (4-ary min-heap) and speed-tier tracking
    if (this.heap.length > 0) {
      for (let i = 0; i < this.heap.length; i++) {
        const entry = this.heap[i];
        if (entry) entry[1] += offsetMs;
      }
      // Rebuild heap invariant after bulk update (4-ary)
      for (let i = Math.floor((this.heap.length - 2) / 4); i >= 0; i--) {
        this.siftDown(i);
      }
    }
    for (const [idx, entry] of this.speedTierLanes) {
      this.speedTierLanes.set(idx, { tier: entry.tier, until: entry.until + offsetMs });
    }
  }

  // ── 4-ary min-heap operations ──────────────────────────────────────

  private siftDown(startIdx: number): void {
    heapSiftDown(this.heap, this.indexMap, startIdx);
  }
}
