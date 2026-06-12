// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Shared lane allocation primitives — pure functions usable by both main-thread
 * LaneAllocator and the Web Worker renderer (renderer-worker.ts).
 *
 * All functions are stateless (no `this`, no DOM, no side effects beyond
 * parameter mutation). This eliminates the 235-line duplication of lane
 * allocation logic between the two contexts.
 */

import { LANE_COOLDOWN_MIN_MS, SAFETY_MARGIN_RATIO } from '@core/renderer-constants';

// ── Constants ──────────────────────────────────────────────────────────────

const HEADWAY_GAP_MIN_PX = 16;

export const HEADWAY_GAP_MAX_PX = 60;

// ── Pure computation functions ─────────────────────────────────────────────

/**
 * Compute minimum headway gap (px) between consecutive messages.
 *
 * @param msgWidth        Message width in px (from text measurement)
 * @param headwayGapRatio Gap as fraction of message width (e.g. 0.08 = 8%)
 * @returns Clamped headway gap in px, always in [16, 60]
 */
export function computeBaseHeadwayPx(msgWidth: number, headwayGapRatio: number): number {
  if (!Number.isFinite(msgWidth) || !Number.isFinite(headwayGapRatio)) {
    return HEADWAY_GAP_MIN_PX;
  }
  return Math.max(
    HEADWAY_GAP_MIN_PX,
    Math.min(HEADWAY_GAP_MAX_PX, Math.round(msgWidth * headwayGapRatio))
  );
}

/** Speed tiers within 1 level of each other can share lanes. */
export function areSpeedTiersCompatible(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1;
}

/**
 * Compute Y position (px) of a lane within the viewport.
 *
 * @param laneIndex      Zero-based lane index
 * @param viewportHeight Viewport height in px
 * @param safeTop        Safe-zone top ratio (0-1)
 * @param laneHeight     Lane height in px
 */
export function computeLaneY(
  laneIndex: number,
  viewportHeight: number,
  safeTop: number,
  laneHeight: number
): number {
  return viewportHeight * safeTop + laneIndex * laneHeight;
}

/**
 * Compute the effective time a message occupies its lane.
 *
 * For scrolling mode: precision exit-time with adaptive headway gap.
 * For top/bottom mode: full duration + safety cooldown.
 *
 * @param durationMs     Message display duration (ms)
 * @param exitPaddingPx  Extra pixels past screen edge before exit
 * @param headwayGapRatio Headway gap as fraction of message width
 * @param msgWidthPx     Optional message width for scrolling mode
 * @param screenWidth    Optional screen width for scrolling mode
 */
export function computeOccupancyMs(
  durationMs: number,
  exitPaddingPx: number,
  headwayGapRatio: number,
  msgWidthPx?: number,
  screenWidth?: number
): number {
  const safeDuration = Math.max(0, durationMs);
  // Top/bottom mode: full duration + safety cooldown
  if (msgWidthPx === undefined || screenWidth === undefined) {
    const safetyMargin = Math.round(safeDuration * SAFETY_MARGIN_RATIO);
    return safeDuration + Math.max(LANE_COOLDOWN_MIN_MS, safetyMargin);
  }

  // Scrolling mode: precision exit-time
  const totalDistance = screenWidth + msgWidthPx + exitPaddingPx;
  if (totalDistance <= 0) return safeDuration;
  const headwayPx = computeBaseHeadwayPx(msgWidthPx, headwayGapRatio);
  const rightEdgePassFraction = (msgWidthPx + headwayPx) / totalDistance;
  return Math.round(rightEdgePassFraction * safeDuration);
}

// ── 4-ary min-heap operations (parameterized — no `this`) ──────────────────

/** Heap entry: [laneIndex, availableAtMs]. */
export type HeapEntry = [number, number];

/**
 * Sift a heap element downward to restore the min-heap invariant (4-ary heap).
 * Mutates `heap` and `indexMap` in place.
 */
export function heapSiftDown(
  heap: HeapEntry[],
  indexMap: Map<number, number>,
  startIdx: number
): void {
  const size = heap.length;
  let idx = startIdx;
  while (true) {
    let smallest = idx;
    const firstChild = 4 * idx + 1;

    for (let c = 0; c < 4; c++) {
      const childIdx = firstChild + c;
      if (childIdx >= size) break;
      const childEntry = heap[childIdx];
      const smallestEntry = heap[smallest];
      if (childEntry && smallestEntry && childEntry[1] < smallestEntry[1]) {
        smallest = childIdx;
      }
    }

    if (smallest === idx) break;
    const current = heap[idx];
    const smallestEntrySwap = heap[smallest];
    if (!current || !smallestEntrySwap) break;
    heap[idx] = smallestEntrySwap;
    heap[smallest] = current;
    indexMap.set(current[0], smallest);
    indexMap.set(smallestEntrySwap[0], idx);
    idx = smallest;
  }
}

/**
 * Sift a heap element upward to restore the min-heap invariant (4-ary heap).
 * Mutates `heap` and `indexMap` in place.
 */
function heapSiftUp(heap: HeapEntry[], indexMap: Map<number, number>, startIdx: number): void {
  let idx = startIdx;
  while (idx > 0) {
    const parent = Math.floor((idx - 1) / 4);
    const parentEntry = heap[parent];
    const currentEntry = heap[idx];
    if (!parentEntry || !currentEntry) break;
    if (parentEntry[1] <= currentEntry[1]) break;
    heap[parent] = currentEntry;
    heap[idx] = parentEntry;
    indexMap.set(parentEntry[0], idx);
    indexMap.set(currentEntry[0], parent);
    idx = parent;
  }
}

/**
 * Get the available-at time for a lane by its index.
 * Returns undefined if the lane is not in the heap.
 */
export function heapGetSlotAvailableAt(
  heap: HeapEntry[],
  indexMap: Map<number, number>,
  laneIndex: number,
  numLanes?: number
): number | undefined {
  if (numLanes !== undefined && (laneIndex < 0 || laneIndex >= numLanes)) {
    return undefined;
  }
  const heapIdx = indexMap.get(laneIndex);
  if (heapIdx === undefined || heapIdx >= heap.length) return undefined;
  return heap[heapIdx]?.[1];
}

/**
 * Update a lane's available time in the heap.
 * Sifts down if the new time is later, sifts up if earlier.
 */
export function heapUpdateLane(
  heap: HeapEntry[],
  indexMap: Map<number, number>,
  laneIndex: number,
  newAvailableAt: number
): void {
  const idx = indexMap.get(laneIndex);
  if (idx === undefined) return;
  const entry = heap[idx];
  if (!entry) return;
  const old = entry[1];
  heap[idx] = [laneIndex, newAvailableAt];
  if (newAvailableAt > old) {
    heapSiftDown(heap, indexMap, idx);
  } else if (newAvailableAt < old) {
    heapSiftUp(heap, indexMap, idx);
  }
}
