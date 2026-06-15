// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { FontWeight, OverlayDimensions } from '@app-types';
import { rendererLayout } from '@core/design-tokens';
import {
  areSpeedTiersCompatible,
  buildLaneHeap,
  computeLaneY,
  computeOccupancyMs,
  heapGetSlotAvailableAt,
  heapSiftDown,
  heapUpdateLane,
} from '@core/lane-allocation-shared';
import { createLogger } from '@core/logging';
import { EPSILON, SPEED_TIER } from '@core/renderer-constants';
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
  private laneIndexToHeapIndex: Map<number, number> = new Map();
  private laneHeight = 0;
  private laneCount = 0;
  /** Cached utilization value, recomputed in resetBatch for O(1) reads. */
  private cachedUtilization = 0;

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

  /**
   * Epsilon-greedy selection probability (0-1).
   * 5% chance to skip the strict topmost zero-wait lane and pick the
   * next one below. Prevents all traffic from consolidating on lane 0
   * when the incoming message rate is low.
   */
  private static readonly EPSILON = EPSILON;

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
    this.laneIndexToHeapIndex = new Map();
    this.collidedLanes.clear();
    this.speedTierLanes.clear();
    this.cachedUtilization = 0;
    if (!dimensions) {
      this.laneHeight = 0;
      this.laneCount = 0;
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
    this.laneCount = Math.max(1, Math.floor(usableHeight / this.laneHeight));

    log.debug('Reset', { lanes: this.laneCount, height: Math.round(this.laneHeight) });

    // Uniform initialization: all lanes start at the same available time.
    const now = performance.now();
    this.heap = buildLaneHeap(this.laneCount, now, this.laneIndexToHeapIndex);
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  getLaneCount(): number {
    return this.laneCount;
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
    const totalLanes = this.laneCount;
    if (totalLanes <= 0) return null;

    const slotCount = Math.max(1, Math.ceil(messageHeight / this.laneHeight));

    const result = this.allocateMultiSlot(now, 0, totalLanes, slotCount, speedTier);
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

  /**
   * Called at the start of each drainQueue batch. Clears per-frame collision
   * tracking so lanes can be retried on the next frame.
   */
  resetBatch(): void {
    // Heap integrity guard: heap length must match index map size.
    // A mismatch indicates a corrupted laneIndexToHeapIndex mapping
    // (duplicate or missing lane entries).
    if (this.heap.length !== this.laneIndexToHeapIndex.size) {
      log.warn(
        `Heap integrity violation: heap.length=${this.heap.length} != ` +
          `laneIndexToHeapIndex.size=${this.laneIndexToHeapIndex.size}. Rebuilding index map.`
      );
      // Rebuild laneIndexToHeapIndex from scratch to restore consistency
      this.laneIndexToHeapIndex.clear();
      for (let i = 0; i < this.heap.length; i++) {
        const entry = this.heap[i];
        if (entry) this.laneIndexToHeapIndex.set(entry[0], i);
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
    // Recompute cached utilization for O(1) getUtilization().
    let occupied = 0;
    for (const [, availableAt] of this.heap) {
      if (availableAt > now) occupied++;
    }
    this.cachedUtilization = this.heap.length > 0 ? occupied / this.heap.length : 0;
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
   * Allocate a single lane with three-phase speed-tier scanning.
   *
   * Phase 1 — zero-wait with tier compatibility filter.
   * Phase 2 — same-tier busy lane (shortest wait first).
   * Phase 3 — fastest-free lane (all message types).
   *
   * Collided lanes (from markCollision feedback) are excluded from all phases.
   */
  private allocateSingleLane(
    now: number,
    laneStart: number,
    laneEnd: number,
    speedTier: number
  ): { laneIndex: number; waitMs: number } | null {
    if (this.heap.length === 0) return null;

    const maxWaitMs = this.options.scrollDurationMaxMs;
    let firstBusy: { laneIndex: number; waitMs: number } | null = null;
    let speedMatched: { laneIndex: number; waitMs: number } | null = null;
    // Pre-collect zero-wait compatible lanes for O(n) epsilon-greedy:
    // instead of nested scanning on epsilon skip, we collect candidates
    // in a single pass and pick from the set when the random gate fires.
    let zeroWaitCandidates: number[] | null = null;

    // ── Phase 1: zero-wait lane with tier compatibility filter ──
    for (let i = laneStart; i < laneEnd; i++) {
      if (this.collidedLanes.has(i)) continue;

      // Speed-tier compatibility check
      const active = this.speedTierLanes.get(i);
      if (active && active.until > now) {
        if (!areSpeedTiersCompatible(speedTier, active.tier)) continue;
      }

      const avail = this.getSlotAvailableAt(i);
      if (avail === undefined) continue;
      const wait = Math.max(0, Math.ceil(avail - now));
      if (wait > 0) {
        // Track for phases 2-3
        if (!firstBusy) firstBusy = { laneIndex: i, waitMs: wait };
        // Track same-tier candidate for phase 2
        if (!speedMatched || wait < speedMatched.waitMs) {
          const hasSameTier =
            active !== undefined && active.until > now && active.tier === speedTier;
          if (hasSameTier) speedMatched = { laneIndex: i, waitMs: wait };
        }
        continue;
      }
      // Found a zero-wait compatible lane.
      // Epsilon-greedy: 5% chance to skip for visual variety.
      // Pre-build a set of zero-wait lanes on first epsilon hit so
      // subsequent "is there an alternate?" checks are O(1) lookups
      // instead of O(n) nested scans.
      if (Math.random() < LaneAllocator.EPSILON) {
        if (!zeroWaitCandidates) {
          // Lazy one-time collection of all remaining zero-wait lanes.
          zeroWaitCandidates = [];
          for (let j = i + 1; j < laneEnd; j++) {
            if (this.collidedLanes.has(j)) continue;
            const activeJ = this.speedTierLanes.get(j);
            if (activeJ && activeJ.until > now) {
              if (!areSpeedTiersCompatible(speedTier, activeJ.tier)) continue;
            }
            const availJ = this.getSlotAvailableAt(j);
            if (availJ === undefined) continue;
            const waitJ = Math.max(0, Math.ceil(availJ - now));
            if (waitJ === 0) zeroWaitCandidates.push(j);
          }
        }
        // Only skip if there is at least one alternate zero-wait lane ahead.
        if (zeroWaitCandidates.length > 0) continue;
      }
      return { laneIndex: i, waitMs: 0 };
    }

    // ── Phase 2: same-tier busy lane ──
    if (speedMatched && speedMatched.waitMs <= maxWaitMs) return speedMatched;

    // ── Phase 3: fastest-free lane (real-time only; backlog returns null) ──
    if (firstBusy && firstBusy.waitMs <= maxWaitMs && speedTier !== SPEED_TIER.BACKLOG)
      return firstBusy;
    return null;
  }

  /**
   * Allocate a contiguous block of `slotCount` lanes for tall messages
   * (superchat, membership). Uses a 3-phase strategy:
   *
   * Phase 1 — zero-wait block: all slots free and tier-compatible.
   * Phase 2 — busy block within maxWaitMs: all slots tier-compatible.
   * Phase 3 — fallback to single-lane allocator.
   *
   * Single-slot messages are forwarded to allocateSingleLane.
   */
  private allocateMultiSlot(
    now: number,
    laneStart: number,
    laneEnd: number,
    slotCount: number,
    speedTier: number
  ): { laneIndex: number; waitMs: number } | null {
    if (this.heap.length === 0) return null;
    if (slotCount <= 1) {
      return this.allocateSingleLane(now, laneStart, laneEnd, speedTier);
    }

    const maxWaitMs = this.options.scrollDurationMaxMs;
    const maxStartLane = laneEnd - slotCount;
    if (maxStartLane < laneStart) return null;

    // Helper: check tier compatibility for a single slot
    const isTierCompatible = (slotIdx: number): boolean => {
      const active = this.speedTierLanes.get(slotIdx);
      if (!active || active.until <= now) return true;
      return areSpeedTiersCompatible(speedTier, active.tier);
    };

    // Phase 1: scan for a block where ALL slots have waitMs === 0 and
    // are tier-compatible.
    for (let startIdx = laneStart; startIdx <= maxStartLane; startIdx++) {
      let allZeroWait = true;
      let blockMaxWait = 0;
      for (let s = 0; s < slotCount; s++) {
        const slotIdx = startIdx + s;
        if (this.collidedLanes.has(slotIdx)) {
          allZeroWait = false;
          break;
        }
        if (!isTierCompatible(slotIdx)) {
          allZeroWait = false;
          break;
        }
        const slotAvail = this.getSlotAvailableAt(slotIdx);
        if (slotAvail === undefined) {
          allZeroWait = false;
          break;
        }
        const slotWait = Math.max(0, Math.ceil(slotAvail - now));
        if (slotWait > 0) allZeroWait = false;
        if (slotWait > maxWaitMs) {
          allZeroWait = false;
          break;
        }
        blockMaxWait = Math.max(blockMaxWait, slotWait);
      }
      if (allZeroWait) return { laneIndex: startIdx, waitMs: blockMaxWait };
    }

    // Phase 2: scan for a contiguous block where ALL slots are busy but
    // within maxWaitMs and pass tier-compatibility. Pick the block with
    // the shortest maximum wait.
    let bestBlock: { laneIndex: number; waitMs: number } | null = null;
    for (let startIdx = laneStart; startIdx <= maxStartLane; startIdx++) {
      let allCompatible = true;
      let blockMaxWait = 0;
      for (let s = 0; s < slotCount; s++) {
        const slotIdx = startIdx + s;
        if (this.collidedLanes.has(slotIdx)) {
          allCompatible = false;
          break;
        }
        if (!isTierCompatible(slotIdx)) {
          allCompatible = false;
          break;
        }
        const slotAvail = this.getSlotAvailableAt(slotIdx);
        if (slotAvail === undefined) {
          allCompatible = false;
          break;
        }
        const slotWait = Math.max(0, Math.ceil(slotAvail - now));
        if (slotWait > maxWaitMs) {
          allCompatible = false;
          break;
        }
        blockMaxWait = Math.max(blockMaxWait, slotWait);
      }
      if (allCompatible && blockMaxWait <= maxWaitMs) {
        if (!bestBlock || blockMaxWait < bestBlock.waitMs) {
          bestBlock = { laneIndex: startIdx, waitMs: blockMaxWait };
        }
      }
    }
    if (bestBlock) return bestBlock;

    // Phase 3: fall back to single-lane allocator.
    return this.allocateSingleLane(now, laneStart, laneEnd, speedTier);
  }

  /** Get the available-at time for a lane by its index. */
  private getSlotAvailableAt(laneIndex: number): number | undefined {
    return heapGetSlotAvailableAt(this.heap, this.laneIndexToHeapIndex, laneIndex);
  }

  /** Update a lane's available time in the heap. */
  private updateLane(laneIndex: number, newAvailableAt: number): void {
    heapUpdateLane(this.heap, this.laneIndexToHeapIndex, laneIndex, newAvailableAt);
  }

  /** Shift all lane timers and speed-tier tracking by a fixed offset. */
  shiftAll(offsetMs: number): void {
    const capped = Math.min(offsetMs, this.options.maxMessageAgeMs);
    if (capped <= 0) return;

    // Shift lane occupancy timers (4-ary min-heap) and speed-tier tracking
    if (this.heap.length > 0) {
      for (let i = 0; i < this.heap.length; i++) {
        const entry = this.heap[i];
        if (entry) entry[1] += capped;
      }
      // Rebuild heap invariant after bulk update (4-ary)
      for (let i = Math.floor((this.heap.length - 2) / 4); i >= 0; i--) {
        this.siftDown(i);
      }
    }
    for (const [idx, entry] of this.speedTierLanes) {
      this.speedTierLanes.set(idx, { tier: entry.tier, until: entry.until + capped });
    }
  }

  // ── 4-ary min-heap operations ──────────────────────────────────────

  private siftDown(startIdx: number): void {
    heapSiftDown(this.heap, this.laneIndexToHeapIndex, startIdx);
  }
}
