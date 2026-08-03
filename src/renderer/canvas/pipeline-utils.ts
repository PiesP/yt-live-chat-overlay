// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Pipeline utilities extracted from canvas-renderer.ts.
 *
 * Contains standalone functions for message lifecycle management:
 * expired message cleanup, paused-duration accounting, the LCG-based
 * fast random number generator (stagger delay), and the compaction
 * threshold constant.
 */

/** Ratio of expired slots above which compaction allocates a fresh array via slice(). */
export const COMPACTION_THRESHOLD_RATIO = 0.5;

/** Minimal state required to index one active message across occupied lanes. */
export interface LaneIndexedMessage {
  laneIndex: number;
  laneArrayIndices: number[];
}

/** Register a message in every occupied lane and remember its swap-pop indices. */
export function addMessageToLaneIndex<T extends LaneIndexedMessage>(
  lanes: Map<number, T[]>,
  message: T,
  slotCount: number
): void {
  message.laneArrayIndices.length = slotCount;
  for (let slot = 0; slot < slotCount; slot++) {
    const lane = message.laneIndex + slot;
    let laneMessages = lanes.get(lane);
    if (!laneMessages) {
      laneMessages = [];
      lanes.set(lane, laneMessages);
    }
    message.laneArrayIndices[slot] = laneMessages.length;
    laneMessages.push(message);
  }
}

/** Remove a message from occupied lanes in O(slotCount) via indexed swap-pop. */
export function removeMessageFromLaneIndex<T extends LaneIndexedMessage>(
  lanes: Map<number, T[]>,
  message: T,
  slotCount: number
): void {
  for (let slot = 0; slot < slotCount; slot++) {
    const lane = message.laneIndex + slot;
    const laneMessages = lanes.get(lane);
    if (!laneMessages || laneMessages.length === 0) continue;

    const index = message.laneArrayIndices[slot];
    if (index === undefined || index < 0 || index >= laneMessages.length) continue;

    const lastMessage = laneMessages[laneMessages.length - 1]!;
    if (lastMessage !== message) {
      laneMessages[index] = lastMessage;
      const swappedSlot = lane - lastMessage.laneIndex;
      if (swappedSlot >= 0 && swappedSlot < lastMessage.laneArrayIndices.length) {
        lastMessage.laneArrayIndices[swappedSlot] = index;
      }
    }
    laneMessages.pop();
    if (laneMessages.length === 0) lanes.delete(lane);
  }
}

/**
 * Create a deterministic PRNG (LCG) for stagger delay computation.
 * Replaces Math.random() to avoid per-frame Math.random() calls in burst
 * scenarios where dozens of messages are enqueued simultaneously.
 *
 * When no seed is provided, derives seed from wall-clock time at module load,
 * so each page gets a different sequence without calling Math.random().
 *
 * Period: 2^32 ≈ 4.3 billion (full 32-bit LCG).
 * Distribution: uniform [0, 1).
 *
 * @param seed Optional explicit seed for deterministic sequences (testing).
 * @returns A function that returns a pseudo-random number in [0, 1).
 */
export function createFastRandom(seed?: number): () => number {
  let s = seed != null ? seed : Date.now() ^ ((Math.random() * 0xffffffff) >>> 0);
  return () => {
    // LCG parameters from Numerical Recipes (a=1664525, c=1013904223)
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Default PRNG instance seeded at module load time. */
export const fastRandom = createFastRandom();
