// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Shared lane allocation primitives — pure functions usable by both main-thread
 * LaneAllocator and the Web Worker renderer (renderer-worker.ts).
 *
 * All functions are stateless (no `this`, no DOM, no side effects beyond
 * parameter mutation). This eliminates the ~190-line duplication of lane
 * allocation logic between the two contexts.
 */

import { LANE_COOLDOWN_MIN_MS, SAFETY_MARGIN_RATIO, SPEED_TIER } from '@renderer/constants';

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
 * @param entryOffsetPx  Distance beyond the viewport edge at activation
 */
export function computeOccupancyMs(
  durationMs: number,
  exitPaddingPx: number,
  headwayGapRatio: number,
  msgWidthPx?: number,
  screenWidth?: number,
  entryOffsetPx = 0
): number {
  const safeDuration = Math.max(0, durationMs);
  // Top/bottom mode: full duration + safety cooldown
  if (msgWidthPx === undefined || screenWidth === undefined) {
    const safetyMargin = Math.round(safeDuration * SAFETY_MARGIN_RATIO);
    return safeDuration + Math.max(LANE_COOLDOWN_MIN_MS, safetyMargin);
  }

  // Scrolling mode: precision exit-time
  const safeEntryOffset = Number.isFinite(entryOffsetPx) ? Math.max(0, entryOffsetPx) : 0;
  const totalDistance = screenWidth + msgWidthPx + exitPaddingPx + safeEntryOffset;
  if (totalDistance <= 0) return safeDuration;
  const headwayPx = computeBaseHeadwayPx(msgWidthPx, headwayGapRatio);
  const rightEdgePassFraction = (safeEntryOffset + msgWidthPx + headwayPx) / totalDistance;
  return Math.round(rightEdgePassFraction * safeDuration);
}

// ── 4-ary min-heap operations (parameterized — no `this`) ──────────────────

/** Heap entry: [laneIndex, availableAtMs]. */
export type HeapEntry = [number, number];

/**
 * Mutable lane-allocation state bundle.
 * Passed to shared functions so they can operate on both
 * the main-thread LaneAllocator and the worker's local state.
 */
export interface LaneAllocationState {
  heap: HeapEntry[];
  indexMap: Map<number, number>;
  numLanes: number;
  speedTierLanes: Map<number, { tier: number; until: number }>;
  collidedLanes: Set<number>;
}

/**
 * Vertical placement policy for a newly visible comment.
 *
 * - spread: distribute scrolling comments across every available lane.
 * - top: anchor fixed comments at the top and grow downward.
 * - bottom: anchor fixed comments at the bottom and grow upward.
 */
export type LaneSelectionStrategy = 'spread' | 'top' | 'bottom';

function laneAtOffset(offset: number, maxLane: number, strategy: LaneSelectionStrategy): number {
  return strategy === 'bottom' ? maxLane - offset : offset;
}

function selectCandidate(
  candidates: readonly number[],
  strategy: LaneSelectionStrategy,
  random: () => number
): number | undefined {
  if (candidates.length === 0) return undefined;
  if (strategy !== 'spread') return candidates[0];
  const rawIndex = Math.floor(random() * candidates.length);
  const index = Math.max(0, Math.min(candidates.length - 1, rawIndex));
  return candidates[index];
}

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
export function heapSiftUp(
  heap: HeapEntry[],
  indexMap: Map<number, number>,
  startIdx: number
): void {
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

// ── Shared lane lifecycle operations ───────────────────────────────────────

/**
 * Build a fresh 4-ary min-heap with `numLanes` lanes, all available at `now`.
 * Returns the heap array and populates the index map.
 */
export function buildLaneHeap(
  numLanes: number,
  now: number,
  indexMap: Map<number, number>
): HeapEntry[] {
  const heap: HeapEntry[] = [];
  indexMap.clear();
  for (let i = 0; i < numLanes; i++) {
    heap.push([i, now]);
    indexMap.set(i, i);
  }
  // Build 4-ary min-heap: sift down from last non-leaf
  for (let i = Math.floor((heap.length - 2) / 4); i >= 0; i--) {
    heapSiftDown(heap, indexMap, i);
  }
  return heap;
}

/**
 * Prune expired speed-tier entries and clear collision set.
 * Call at the start of each batch.
 */
export function resetBatchShared(state: LaneAllocationState, now: number): void {
  for (const [k, v] of state.speedTierLanes) {
    if (v.until <= now) state.speedTierLanes.delete(k);
  }
  state.collidedLanes.clear();
}

/**
 * Commit a placement: update speed-tier tracking and heap occupancy.
 * For multi-slot messages, all occupied lanes are updated.
 */
export function commitPlacementShared(
  state: LaneAllocationState,
  laneIndex: number,
  slotCount: number,
  startTime: number,
  occupancyMs: number,
  durationMs: number,
  speedTier: number
): void {
  const nextAvailable = startTime + occupancyMs;
  const until = startTime + durationMs;

  for (let s = 0; s < slotCount; s++) {
    const idx = laneIndex + s;
    state.speedTierLanes.set(idx, { tier: speedTier, until });
    heapUpdateLane(state.heap, state.indexMap, idx, nextAvailable);
  }
}

/**
 * Shift all lane timers and speed-tier tracking by a fixed offset (pause/resume).
 */
export function shiftLaneTimersShared(state: LaneAllocationState, ms: number): void {
  for (let i = 0; i < state.heap.length; i++) {
    const entry = state.heap[i];
    if (entry) entry[1] += ms;
  }
  for (const [key, entry] of state.speedTierLanes) {
    state.speedTierLanes.set(key, { tier: entry.tier, until: entry.until + ms });
  }
}

/**
 * Find a lane placement for a message using the three-phase speed-tier strategy.
 * Shared between main-thread LaneAllocator and Web Worker renderer.
 *
 * @param state     Mutable lane allocation state
 * @param now       Current time (performance.now())
 * @param msgHeight Message height in px
 * @param laneHeight Height of a single lane in px
 * @param maxWaitMs Maximum acceptable wait time (ms)
 * @param speedTier Speed tier of the incoming message
 * @returns lane index and waitMs, or null if no placement found
 */
export function findPlacementShared(
  state: LaneAllocationState,
  now: number,
  msgHeight: number,
  laneHeight: number,
  maxWaitMs: number,
  speedTier: number,
  random: () => number = Math.random,
  strategy: LaneSelectionStrategy = 'spread'
): { laneIndex: number; waitMs: number } | null {
  if (state.heap.length === 0) return null;
  const slotCount = Math.max(1, Math.ceil(msgHeight / laneHeight));
  const numLanes = state.numLanes;
  if (numLanes <= 0) return null;

  if (slotCount <= 1) {
    return allocateSingleLaneShared(
      state,
      now,
      0,
      numLanes,
      maxWaitMs,
      speedTier,
      random,
      strategy
    );
  }

  // Multi-slot: scan for contiguous block
  const maxStartLane = numLanes - slotCount;
  if (maxStartLane < 0) return null;

  const isTierCompatible = (slotIdx: number): boolean => {
    const active = state.speedTierLanes.get(slotIdx);
    if (!active || active.until <= now) return true;
    return areSpeedTiersCompatible(speedTier, active.tier);
  };

  // Phase 1: zero-wait block. Scrolling comments sample uniformly from all
  // available blocks; fixed comments use the edge matching their mode.
  const zeroWaitBlocks: number[] = [];
  for (let offset = 0; offset <= maxStartLane; offset++) {
    const startIdx = laneAtOffset(offset, maxStartLane, strategy);
    let allZeroWait = true;
    for (let s = 0; s < slotCount; s++) {
      const slotIdx = startIdx + s;
      if (state.collidedLanes.has(slotIdx)) {
        allZeroWait = false;
        break;
      }
      if (!isTierCompatible(slotIdx)) {
        allZeroWait = false;
        break;
      }
      const avail = heapGetSlotAvailableAt(state.heap, state.indexMap, slotIdx, numLanes);
      if (avail === undefined) {
        allZeroWait = false;
        break;
      }
      const wait = Math.max(0, Math.ceil(avail - now));
      if (wait > 0) allZeroWait = false;
      if (wait > maxWaitMs) {
        allZeroWait = false;
        break;
      }
    }
    if (allZeroWait) {
      zeroWaitBlocks.push(startIdx);
      if (strategy !== 'spread') break;
    }
  }
  const zeroWaitLane = selectCandidate(zeroWaitBlocks, strategy, random);
  if (zeroWaitLane !== undefined) {
    return { laneIndex: zeroWaitLane, waitMs: 0 };
  }

  // Phase 2: busy block within maxWaitMs
  let bestBlock: { laneIndex: number; waitMs: number } | null = null;
  for (let offset = 0; offset <= maxStartLane; offset++) {
    const startIdx = laneAtOffset(offset, maxStartLane, strategy);
    let allCompatible = true;
    let blockMaxWait = 0;
    for (let s = 0; s < slotCount; s++) {
      const slotIdx = startIdx + s;
      if (state.collidedLanes.has(slotIdx)) {
        allCompatible = false;
        break;
      }
      if (!isTierCompatible(slotIdx)) {
        allCompatible = false;
        break;
      }
      const avail = heapGetSlotAvailableAt(state.heap, state.indexMap, slotIdx, numLanes);
      if (avail === undefined) {
        allCompatible = false;
        break;
      }
      const wait = Math.max(0, Math.ceil(avail - now));
      if (wait > maxWaitMs) {
        allCompatible = false;
        break;
      }
      blockMaxWait = Math.max(blockMaxWait, wait);
    }
    if (allCompatible && blockMaxWait <= maxWaitMs) {
      if (!bestBlock || blockMaxWait < bestBlock.waitMs) {
        bestBlock = { laneIndex: startIdx, waitMs: blockMaxWait };
      }
    }
  }
  if (bestBlock) return bestBlock;

  // Phase 3: fallback — any contiguous block within maxWaitMs (speed-tier agnostic)
  // For multi-slot messages, scan for consecutive compatible lanes instead of
  // falling through to allocateSingleLaneShared which returns only 1 lane.
  // Without this, SuperChat/Membership messages needing 2-3 lanes get placed
  // on a single lane, causing visual overlap.
  if (slotCount > 1) {
    let bestBlock: { laneIndex: number; waitMs: number } | null = null;
    for (let offset = 0; offset <= maxStartLane; offset++) {
      const startIdx = laneAtOffset(offset, maxStartLane, strategy);
      let blockMaxWait = 0;
      let allAvailable = true;
      for (let s = 0; s < slotCount; s++) {
        const slotIdx = startIdx + s;
        if (state.collidedLanes.has(slotIdx)) {
          allAvailable = false;
          break;
        }
        const avail = heapGetSlotAvailableAt(state.heap, state.indexMap, slotIdx, numLanes);
        if (avail === undefined) {
          allAvailable = false;
          break;
        }
        const wait = Math.max(0, Math.ceil(avail - now));
        if (wait > maxWaitMs) {
          allAvailable = false;
          break;
        }
        blockMaxWait = Math.max(blockMaxWait, wait);
      }
      if (allAvailable) {
        if (!bestBlock || blockMaxWait < bestBlock.waitMs) {
          bestBlock = { laneIndex: startIdx, waitMs: blockMaxWait };
        }
      }
    }
    if (bestBlock) return bestBlock;
    return null;
  }

  // Single-slot fallback
  return allocateSingleLaneShared(
    state,
    now,
    0,
    numLanes,
    maxWaitMs,
    speedTier,
    random,
    strategy
  );
}

/**
 * Allocate a single lane with three-phase speed-tier scanning.
 * Pure function operating on LaneAllocationState — no `this`.
 */
export function allocateSingleLaneShared(
  state: LaneAllocationState,
  now: number,
  laneStart: number,
  laneEnd: number,
  maxWaitMs: number,
  speedTier: number,
  random: () => number = Math.random,
  strategy: LaneSelectionStrategy = 'spread'
): { laneIndex: number; waitMs: number } | null {
  if (state.heap.length === 0) return null;

  let fastestBusy: { laneIndex: number; waitMs: number } | null = null;
  let speedMatched: { laneIndex: number; waitMs: number } | null = null;
  const zeroWaitCandidates: number[] = [];

  const maxOffset = laneEnd - laneStart - 1;
  for (let offset = 0; offset <= maxOffset; offset++) {
    const i = laneStart + laneAtOffset(offset, maxOffset, strategy);
    if (state.collidedLanes.has(i)) continue;

    const active = state.speedTierLanes.get(i);
    if (active && active.until > now) {
      if (!areSpeedTiersCompatible(speedTier, active.tier)) continue;
    }

    const avail = heapGetSlotAvailableAt(state.heap, state.indexMap, i, state.numLanes);
    if (avail === undefined) continue;
    const wait = Math.max(0, Math.ceil(avail - now));
    if (wait > 0) {
      if (!fastestBusy || wait < fastestBusy.waitMs) {
        fastestBusy = { laneIndex: i, waitMs: wait };
      }
      if (!speedMatched || wait < speedMatched.waitMs) {
        const hasSameTier = active !== undefined && active.until > now && active.tier === speedTier;
        if (hasSameTier) speedMatched = { laneIndex: i, waitMs: wait };
      }
      continue;
    }

    // Scrolling comments use the entire safe zone instead of only the first
    // four lanes. Fixed comments stop at their nearest edge lane.
    zeroWaitCandidates.push(i);
    if (strategy !== 'spread') break;
  }

  const zeroWaitLane = selectCandidate(zeroWaitCandidates, strategy, random);
  if (zeroWaitLane !== undefined) {
    return { laneIndex: zeroWaitLane, waitMs: 0 };
  }

  if (speedMatched && speedMatched.waitMs <= maxWaitMs) return speedMatched;
  if (fastestBusy && fastestBusy.waitMs <= maxWaitMs && speedTier !== SPEED_TIER.BACKLOG)
    return fastestBusy;
  return null;
}
