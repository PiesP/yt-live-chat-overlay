import type { DanmakuMode, LaneState, OverlayDimensions } from '@app-types';
import { rendererLayout } from '@core/design-tokens';
import { measureTextHeight } from '@core/text-measure';

export interface LanePlacement {
  lane: LaneState;
  waitMs: number;
  laneY: number;
}

interface LaneAllocatorOptions {
  readonly getEffectiveSpeedPxPerSec: () => number;
  readonly getDanmakuMode: () => DanmakuMode;
  readonly safeTop: number;
  readonly safeBottom: number;
  readonly fontSize: number;
  readonly fontWeight: 'normal' | 'bold';
  readonly fontFamily: string;
  readonly laneSpacing: number;
}

/**
 * DLIOS constant-velocity lane scheduler.
 *
 * Core algorithm (from DLIOS / ByteDance TikTok paper):
 *
 *   1. Constant-velocity lemma — all comments in the same lane move at
 *      the same velocity `v`. Therefore a later-starting comment can
 *      NEVER overtake an earlier one (zero rear-end collision).
 *
 *   2. Available-time launch rule — each lane tracks the earliest time
 *      it becomes available for the next message:
 *
 *        t_available(k) = t_start + (w + g) / v
 *
 *      where w = text width, g = safety gap, v = constant velocity.
 *
 *   3. Min-heap selection — the lane with the minimum t_available is
 *      selected in O(log n) time.
 *
 * This completely eliminates the need for segment tracking, entry-offset
 * estimation, and speed-safety heuristics used in earlier implementations.
 */
export class LaneAllocator {
  /** 4-ary min-heap of [laneIndex, availableAtMs] pairs, sorted by availableAtMs */
  private heap: [number, number][] = [];
  /** Reverse map: laneIndex → heap index for O(1) lookup and update */
  private laneIndexToHeapIndex: Map<number, number> = new Map();
  /** Per-lane message count for weighted selection */
  private laneMessageCounts: number[] = [];
  /** Per-lane last commit timestamp for spatial density calculation */
  private laneLastUsedAt: number[] = [];
  private laneHeight = 0;
  private laneCount = 0;

  /**
   * When backlog partitioning is active, backlog messages are restricted
   * to lanes [0, backlogLaneEnd) and real-time messages use
   * [backlogLaneEnd, laneCount). This prevents visual overlap during
   * the initial backlog injection phase.
   * -1 means partitioning is disabled (all lanes shared).
   */
  private backlogLaneEnd = -1;

  constructor(private readonly options: LaneAllocatorOptions) {}

  reset(dimensions: OverlayDimensions | null): void {
    this.heap = [];
    this.laneIndexToHeapIndex = new Map();
    this.laneMessageCounts = [];
    this.laneLastUsedAt = [];
    this.backlogLaneEnd = -1;
    if (!dimensions) {
      this.laneHeight = 0;
      this.laneCount = 0;
      return;
    }

    // Compute lane height from actual font metrics, not a hardcoded multiplier.
    // This ensures laneHeight == measureTextHeight + paddingV + laneSpacing,
    // which is exactly the same formula used by estimateMessageDimensions().
    // Result: msgHeight <= laneHeight always holds at laneSpacing >= 0,
    // and the 1-slot/2-slot transition happens at a predictable laneSpacing.
    // Use paddingV * 2 (top + bottom) for lane height, matching the total
    // vertical padding applied by estimateMessageDimensions.
    const totalPaddingV = rendererLayout.paddingV * 2;
    const font = `${this.options.fontWeight === 'bold' ? 'bold' : '400'} ${this.options.fontSize}px ${this.options.fontFamily}`;
    const textHeight = measureTextHeight(font, this.options.fontSize);
    this.laneHeight = Math.max(1, textHeight + totalPaddingV + this.options.laneSpacing);

    const usableHeight = dimensions.height * (1 - this.options.safeTop - this.options.safeBottom);
    this.laneCount = Math.max(1, Math.floor(usableHeight / this.laneHeight));

    // Stagger initial lane availability so the first messages don't all
    // start at exactly the same time. Each lane gets a small offset
    // proportional to its index (max ~100ms spread across all lanes).
    const now = performance.now();
    const staggerMs = Math.min(100, Math.max(10, 200 / this.laneCount));
    for (let i = 0; i < this.laneCount; i++) {
      this.heap.push([i, now + i * staggerMs]);
      this.laneIndexToHeapIndex.set(i, i);
      this.laneMessageCounts.push(0);
      this.laneLastUsedAt.push(0);
    }
    // Build min-heap (4-ary): start from last non-leaf node
    for (let i = Math.floor((this.heap.length - 2) / 4); i >= 0; i--) {
      this.siftDown(i);
    }
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  getLaneCount(): number {
    return this.laneCount;
  }

  /** Get current lane utilization ratio (0-1): occupied lanes / total lanes */
  getUtilization(): number {
    if (this.heap.length === 0) return 0;
    const now = performance.now();
    let occupied = 0;
    for (const [, availableAt] of this.heap) {
      if (availableAt > now) occupied++;
    }
    return occupied / this.heap.length;
  }

  getLaneHeight(): number {
    return this.laneHeight;
  }

  getLaneY(laneIndex: number, viewportHeight: number): number {
    return viewportHeight * this.options.safeTop + laneIndex * this.laneHeight;
  }

  findPlacement(
    _messageHeight: number,
    _dimensions: OverlayDimensions,
    isBacklog = false
  ): LanePlacement | null {
    const now = performance.now();
    const totalLanes = this.laneCount;

    // Determine the effective lane range based on partition state.
    let laneStart = 0;
    let laneEnd = totalLanes;
    if (this.backlogLaneEnd > 0) {
      if (isBacklog) {
        laneEnd = this.backlogLaneEnd;
      } else {
        laneStart = this.backlogLaneEnd;
      }
    }
    const effectiveLaneCount = laneEnd - laneStart;
    if (effectiveLaneCount <= 0) return null;

    // Messages always occupy exactly 1 lane slot.
    // Negative laneSpacing reduces laneHeight below msgHeight, causing
    // adjacent-lane overlap — this is the intended "negative = overlap" behavior.
    // The 2-slot allocation path has been removed because it caused sudden
    // visible gaps when laneHeight dropped below msgHeight.
    const mode = this.options.getDanmakuMode();
    const isScrolling = mode === 'scroll' || mode === 'reverse';

    const result = this.allocateSingleLane(now, isScrolling, laneStart, laneEnd);
    if (!result) return null;

    const lane: LaneState = {
      index: result.laneIndex,
      lastItemStartTime: now,
      lastItemEndTime: 0,
      lastItemWidthPx: 0,
      totalMessages: 0,
    };

    return {
      lane,
      waitMs: result.waitMs,
      laneY: this.getLaneY(result.laneIndex, _dimensions.height),
    };
  }

  /**
   * Commit the placement — update the lane's available time for the
   * next message.
   *
   * @param speedMultiplier - Multiplier applied to the effective velocity
   *   when computing lane occupancy. Backlog messages use a higher speed
   *   (e.g. 2x) and thus free up lanes sooner, preventing unnecessary
   *   collisions with real-time messages.
   */
  commitPlacement(
    placement: LanePlacement,
    textWidth: number,
    startTime: number,
    speedMultiplier = 1
  ): void {
    const mode = this.options.getDanmakuMode();
    const isScrolling = mode === 'scroll' || mode === 'reverse';
    const velocity = this.options.getEffectiveSpeedPxPerSec();

    const effectiveVelocity = velocity * speedMultiplier;
    const occupancyMs = isScrolling
      ? ((textWidth + rendererLayout.dliosSafetyGap) / effectiveVelocity) * 1000
      : rendererLayout.topBottomDurationMs;

    const nextAvailable = startTime + occupancyMs;
    this.updateLane(placement.lane.index, nextAvailable);
    const count = this.laneMessageCounts[placement.lane.index];
    if (count !== undefined) {
      this.laneMessageCounts[placement.lane.index] = count + 1;
    }
    this.laneLastUsedAt[placement.lane.index] = startTime;
  }

  // ── Partition control ────────────────────────────────────────────────

  /**
   * Enable or disable backlog lane partitioning.
   * When active, backlog messages use lanes [0, partitionEnd) and
   * real-time messages use [partitionEnd, laneCount).
   * @param active - true to enable partitioning
   * @param partitionEnd - exclusive end index for the backlog partition
   */
  setBacklogPartition(active: boolean, partitionEnd: number): void {
    if (active) {
      this.backlogLaneEnd = Math.max(1, Math.min(partitionEnd, this.laneCount - 1));
    } else {
      this.backlogLaneEnd = -1;
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Spatial density at a lane: weighted sum of recent usage in nearby lanes.
   * Lanes used within the last 10 seconds contribute to density, with
   * closer lanes weighted higher. This prevents vertical clustering by
   * preferring lanes that have been idle or are far from recently used lanes.
   */
  private spatialDensity(laneIndex: number, now: number): number {
    let density = 0;
    const DECAY_WINDOW_MS = 10_000;
    for (let offset = -2; offset <= 2; offset++) {
      const idx = laneIndex + offset;
      if (idx < 0 || idx >= this.laneCount) continue;
      const lastUsed = this.laneLastUsedAt[idx] ?? 0;
      if (lastUsed === 0) continue;
      const age = now - lastUsed;
      if (age >= DECAY_WINDOW_MS) continue;
      const proximityWeight = 1 / (1 + Math.abs(offset));
      const recency = 1 - age / DECAY_WINDOW_MS;
      density += proximityWeight * recency;
    }
    return density;
  }

  /**
   * Composite lane score: lower is better.
   * Combines wait time, spatial density, and message count to produce
   * a balanced lane selection that avoids vertical clustering and
   * diagonal patterns.
   */
  private laneScore(laneIndex: number, waitMs: number, now: number): number {
    const density = this.spatialDensity(laneIndex, now);
    const count = this.laneMessageCounts[laneIndex] ?? 0;
    // waitMs is primary (DLIOS invariant), density secondary, count tertiary
    return waitMs * 10 + density * 3000 + count * 50;
  }

  /**
   * Allocate a single lane using spatial-density-aware selection.
   * Replaces the old two-phase (best-wait + best-count) approach with
   * a single unified score that considers:
   *   1. Wait time (DLIOS available-time invariant)
   *   2. Spatial density (prevents vertical clustering)
   *   3. Message count (load balancing tiebreaker)
   */
  private allocateSingleLane(
    now: number,
    isScrolling: boolean,
    laneStart: number,
    laneEnd: number
  ): { laneIndex: number; waitMs: number } | null {
    if (this.heap.length === 0) return null;

    const maxWaitMs = isScrolling ? rendererLayout.durationMax : rendererLayout.topBottomDurationMs;

    let bestLane = -1;
    let bestWait = Infinity;
    let bestScore = Infinity;

    for (let i = 0; i < this.heap.length; i++) {
      const entry = this.heap[i];
      if (!entry) continue;
      const [idx, avail] = entry;
      if (idx < laneStart || idx >= laneEnd) continue;
      const wait = Math.max(0, Math.ceil(avail - now));
      if (wait > maxWaitMs) continue;

      const score = this.laneScore(idx, wait, now);
      if (score < bestScore) {
        bestScore = score;
        bestWait = wait;
        bestLane = idx;
      }
    }

    if (bestLane === -1) return null;
    return { laneIndex: bestLane, waitMs: bestWait };
  }

  /** Update a lane's available time in the heap. */
  private updateLane(laneIndex: number, newAvailableAt: number): void {
    const idx = this.laneIndexToHeapIndex.get(laneIndex);
    if (idx === undefined) return;
    const entry = this.heap[idx];
    if (!entry) return;
    const old = entry[1];
    this.heap[idx] = [laneIndex, newAvailableAt];
    if (newAvailableAt > old) {
      this.siftDown(idx);
    } else if (newAvailableAt < old) {
      this.siftUp(idx);
    }
  }

  /** Shift all lane available times by a fixed offset (e.g., pause duration). */
  shiftAll(offsetMs: number): void {
    if (offsetMs <= 0 || this.heap.length === 0) return;
    for (let i = 0; i < this.heap.length; i++) {
      const entry = this.heap[i];
      if (entry) {
        this.heap[i] = [entry[0], entry[1] + offsetMs];
      }
    }
    // Rebuild heap invariant after bulk update (4-ary)
    for (let i = Math.floor((this.heap.length - 2) / 4); i >= 0; i--) {
      this.siftDown(i);
    }
  }

  // ── 4-ary min-heap operations ──────────────────────────────────────
  // 4-ary heap: children of node i are at 4i+1..4i+4, parent at (i-1)/4.
  // Sift-down does up to 4 comparisons per level but traverses ~half the
  // levels of a binary heap. Net win for cache locality and total comparisons.

  private siftDown(startIdx: number): void {
    const size = this.heap.length;
    let idx = startIdx;
    while (true) {
      let smallest = idx;
      const firstChild = 4 * idx + 1;

      // Check up to 4 children
      for (let c = 0; c < 4; c++) {
        const childIdx = firstChild + c;
        if (childIdx >= size) break;
        const childEntry = this.heap[childIdx];
        const smallestEntry = this.heap[smallest];
        if (childEntry && smallestEntry && childEntry[1] < smallestEntry[1]) {
          smallest = childIdx;
        }
      }

      if (smallest === idx) break;
      const current = this.heap[idx];
      const smallestEntrySwap = this.heap[smallest];
      if (!current || !smallestEntrySwap) break;
      this.heap[idx] = smallestEntrySwap;
      this.heap[smallest] = current;
      this.laneIndexToHeapIndex.set(current[0], smallest);
      this.laneIndexToHeapIndex.set(smallestEntrySwap[0], idx);
      idx = smallest;
    }
  }

  private siftUp(startIdx: number): void {
    let idx = startIdx;
    while (idx > 0) {
      const parent = Math.floor((idx - 1) / 4);
      const parentEntry = this.heap[parent];
      const currentEntry = this.heap[idx];
      if (!parentEntry || !currentEntry) break;
      if (parentEntry[1] <= currentEntry[1]) break;
      this.heap[parent] = currentEntry;
      this.heap[idx] = parentEntry;
      this.laneIndexToHeapIndex.set(parentEntry[0], idx);
      this.laneIndexToHeapIndex.set(currentEntry[0], parent);
      idx = parent;
    }
  }
}
