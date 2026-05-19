import type { DanmakuMode, LaneState, OverlayDimensions } from '@app-types';
import { rendererLayout } from '@core/design-tokens';

export interface LanePlacement {
  lane: LaneState;
  laneSpan: number;
  waitMs: number;
  laneY: number;
}

interface LaneAllocatorOptions {
  readonly getEffectiveSpeedPxPerSec: () => number;
  readonly getDanmakuMode: () => DanmakuMode;
  readonly safeTop: number;
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
  /** Binary min-heap of [laneIndex, availableAtMs] pairs, sorted by availableAtMs */
  private heap: [number, number][] = [];
  /** Reverse map: laneIndex → heap index for O(1) lookup and update */
  private laneIndexToHeapIndex: Map<number, number> = new Map();
  /** Per-lane message count for weighted selection */
  private laneMessageCounts: number[] = [];
  private laneHeight = 0;
  private laneCount = 0;

  constructor(private readonly options: LaneAllocatorOptions) {}

  reset(dimensions: OverlayDimensions | null): void {
    this.heap = [];
    this.laneIndexToHeapIndex = new Map();
    this.laneMessageCounts = [];
    if (!dimensions) {
      this.laneHeight = 0;
      this.laneCount = 0;
      return;
    }
    this.laneHeight = dimensions.laneHeight;
    this.laneCount = dimensions.laneCount;
    for (let i = 0; i < dimensions.laneCount; i++) {
      this.heap.push([i, 0]);
      this.laneIndexToHeapIndex.set(i, i);
      this.laneMessageCounts.push(0);
    }
    // Build min-heap
    for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) {
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

  getLaneY(laneIndex: number): number {
    return this.options.safeTop + laneIndex * this.laneHeight;
  }

  findPlacement(messageHeight: number, dimensions: OverlayDimensions): LanePlacement | null {
    const now = performance.now();
    const requiredLanes = this.calculateRequiredLanes(messageHeight, dimensions.laneCount);
    if (requiredLanes === 0) return null;

    const mode = this.options.getDanmakuMode();
    const isScrolling = mode === 'scroll' || mode === 'reverse';

    let laneIndex: number;
    let waitMs: number;

    if (requiredLanes === 1) {
      // ── Single-lane: O(log n) min-heap ──────────────────────────────
      const result = this.allocateSingleLane(now, isScrolling);
      if (!result) return null;
      laneIndex = result.laneIndex;
      waitMs = result.waitMs;
    } else {
      // ── Multi-lane (superchat, membership): linear block scan ──────
      const result = this.allocateBlock(requiredLanes, now, isScrolling);
      if (!result) return null;
      laneIndex = result.startIndex;
      waitMs = result.waitMs;
    }

    const lane: LaneState = {
      index: laneIndex,
      lastItemStartTime: now,
      lastItemEndTime: 0,
      lastItemWidthPx: 0,
      totalMessages: 0,
    };

    return {
      lane,
      laneSpan: requiredLanes,
      waitMs,
      laneY: this.getLaneY(laneIndex),
    };
  }

  /**
   * Commit the placement — update the lane's available time for the
   * next message.
   */
  commitPlacement(placement: LanePlacement, textWidth: number, startTime: number): void {
    const mode = this.options.getDanmakuMode();
    const isScrolling = mode === 'scroll' || mode === 'reverse';
    const velocity = this.options.getEffectiveSpeedPxPerSec();

    const occupancyMs = isScrolling
      ? ((textWidth + rendererLayout.dliosSafetyGap) / velocity) * 1000
      : rendererLayout.topBottomDurationMs;

    const nextAvailable = startTime + occupancyMs;
    const end = Math.min(placement.lane.index + placement.laneSpan, this.laneCount);

    for (let i = placement.lane.index; i < end; i++) {
      this.updateLane(i, nextAvailable);
      const count = this.laneMessageCounts[i];
      if (count !== undefined) {
        this.laneMessageCounts[i] = count + 1;
      }
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private calculateRequiredLanes(messageHeight: number, totalLanes: number): number {
    if (this.laneHeight <= 0 || totalLanes <= 0) return 0;
    return Math.max(1, Math.min(totalLanes, Math.ceil(messageHeight / this.laneHeight)));
  }

  /**
   * Allocate a single lane using the min-heap.
   * When the best lane is available now, use message-count weighting
   * to spread messages evenly across lanes.
   */
  private allocateSingleLane(
    now: number,
    isScrolling: boolean
  ): { laneIndex: number; waitMs: number } | null {
    if (this.heap.length === 0) return null;

    const top = this.heap[0];
    if (!top) return null;
    const [laneIndex, availableAt] = top;
    const waitMs = Math.max(0, Math.ceil(availableAt - now));

    // Overload policy: if the best lane isn't available within a reasonable
    // window, drop the message rather than letting it queue up.
    const maxWaitMs = isScrolling ? rendererLayout.durationMax : rendererLayout.topBottomDurationMs;
    if (waitMs > maxWaitMs) return null;

    // When the top lane is available now, check nearby candidates for
    // better load balance. This prevents clustering on the same lane.
    if (waitMs === 0) {
      const best = this.findBestAvailableLane(now, maxWaitMs);
      if (best) return best;
    }

    return { laneIndex, waitMs };
  }

  /**
   * Among lanes that are available within the grace window, pick the one
   * with the fewest total messages for visual balance.
   */
  private findBestAvailableLane(
    now: number,
    maxWaitMs: number
  ): { laneIndex: number; waitMs: number } | null {
    let bestLane = -1;
    let bestWait = maxWaitMs + 1;
    let bestCount = Infinity;

    for (let i = 0; i < this.heap.length; i++) {
      const entry = this.heap[i];
      if (!entry) continue;
      const [idx, avail] = entry;
      const wait = Math.max(0, Math.ceil(avail - now));
      if (wait > maxWaitMs) continue;

      const count = this.laneMessageCounts[idx] ?? 0;
      // Prefer: lower wait, then lower message count as tiebreaker
      if (wait < bestWait || (wait === bestWait && count < bestCount)) {
        bestWait = wait;
        bestCount = count;
        bestLane = idx;
        if (wait === 0 && count === 0) break; // can't do better
      }
    }

    if (bestLane === -1) return null;
    return { laneIndex: bestLane, waitMs: bestWait };
  }

  /** Allocate a contiguous block of lanes for multi-lane messages. */
  private allocateBlock(
    required: number,
    now: number,
    isScrolling: boolean
  ): { startIndex: number; waitMs: number } | null {
    const maxStartIndex = this.laneCount - required;
    if (maxStartIndex < 0) return null;

    let bestStart = -1;
    let bestWait = Infinity;

    for (let start = 0; start <= maxStartIndex; start++) {
      let maxAvail = 0;
      let allFound = true;

      for (let i = start; i < start + required; i++) {
        const entry = this.findLaneEntry(i);
        if (!entry) {
          allFound = false;
          break;
        }
        if (entry[1] > maxAvail) maxAvail = entry[1];
      }

      if (!allFound) continue;

      const wait = Math.max(0, Math.ceil(maxAvail - now));
      if (wait < bestWait) {
        bestWait = wait;
        bestStart = start;
      }
    }

    if (bestStart === -1) return null;

    const maxWaitMs = isScrolling ? rendererLayout.durationMax : rendererLayout.topBottomDurationMs;
    if (bestWait > maxWaitMs) return null;

    return { startIndex: bestStart, waitMs: bestWait };
  }

  /** Find a lane entry by its index in the heap (O(1) via reverse map). */
  private findLaneEntry(laneIndex: number): [number, number] | undefined {
    const heapIdx = this.laneIndexToHeapIndex.get(laneIndex);
    if (heapIdx === undefined) return undefined;
    return this.heap[heapIdx];
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
    // Rebuild heap invariant after bulk update
    for (let i = Math.floor((this.heap.length - 1) / 4); i >= 0; i--) {
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
