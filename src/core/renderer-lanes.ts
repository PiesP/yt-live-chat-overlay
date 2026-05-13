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
  /** Binary min-heap of [laneIndex, availableAtMs] pairs, sorted by availableAtMs */
  private heap: [number, number][] = [];
  private laneHeight = 0;
  private laneCount = 0;

  constructor(private readonly options: LaneAllocatorOptions) {}

  reset(dimensions: OverlayDimensions | null): void {
    this.heap = [];
    if (!dimensions) {
      this.laneHeight = 0;
      this.laneCount = 0;
      return;
    }
    this.laneHeight = dimensions.laneHeight + this.options.laneSpacing;
    this.laneCount = dimensions.laneCount;
    for (let i = 0; i < dimensions.laneCount; i++) {
      this.heap.push([i, 0]);
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
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private calculateRequiredLanes(messageHeight: number, totalLanes: number): number {
    if (this.laneHeight <= 0 || totalLanes <= 0) return 0;
    return Math.max(1, Math.min(totalLanes, Math.ceil(messageHeight / this.laneHeight)));
  }

  /** Allocate a single lane using the min-heap. */
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

    return { laneIndex, waitMs };
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

  /** Find a lane entry by its index in the heap (linear scan). */
  private findLaneEntry(laneIndex: number): [number, number] | undefined {
    return this.heap.find(([idx]) => idx === laneIndex);
  }

  /** Update a lane's available time in the heap. */
  private updateLane(laneIndex: number, newAvailableAt: number): void {
    const idx = this.heap.findIndex(([i]) => i === laneIndex);
    if (idx < 0) return;
    this.heap[idx] = [laneIndex, newAvailableAt];
    this.siftDown(idx);
    this.siftUp(idx);
  }

  // ── Binary min-heap operations ──────────────────────────────────────

  private siftDown(startIdx: number): void {
    const size = this.heap.length;
    let idx = startIdx;
    while (true) {
      let smallest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      const leftEntry = left < size ? this.heap[left] : undefined;
      const rightEntry = right < size ? this.heap[right] : undefined;
      const smallestEntry = this.heap[smallest];
      if (!smallestEntry) break;
      if (leftEntry && leftEntry[1] < smallestEntry[1]) smallest = left;
      const smallestAfterLeft = this.heap[smallest];
      if (smallestAfterLeft && rightEntry && rightEntry[1] < smallestAfterLeft[1]) smallest = right;
      if (smallest === idx) break;
      const current = this.heap[idx];
      const smallestEntrySwap = this.heap[smallest];
      if (!current || !smallestEntrySwap) break;
      this.heap[idx] = smallestEntrySwap;
      this.heap[smallest] = current;
      idx = smallest;
    }
  }

  private siftUp(startIdx: number): void {
    let idx = startIdx;
    while (idx > 0) {
      const parent = Math.floor((idx - 1) / 2);
      const parentEntry = this.heap[parent];
      const currentEntry = this.heap[idx];
      if (!parentEntry || !currentEntry) break;
      if (parentEntry[1] <= currentEntry[1]) break;
      this.heap[parent] = currentEntry;
      this.heap[idx] = parentEntry;
      idx = parent;
    }
  }
}
