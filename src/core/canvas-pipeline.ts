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

import type { CanvasMessage } from '@core/renderer-constants';

/** Ratio of expired slots above which compaction allocates a fresh array via slice(). */
export const COMPACTION_THRESHOLD_RATIO = 0.5;

/**
 * Deterministic PRNG (LCG) for stagger delay computation.
 * Replaces Math.random() to avoid per-frame Math.random() calls in burst
 * scenarios where dozens of messages are enqueued simultaneously.
 * Seed is derived from wall-clock time at module load, so each page
 * gets a different sequence without calling Math.random() in the hot path.
 *
 * Period: 2^32 ≈ 4.3 billion (full 32-bit LCG).
 * Distribution: uniform [0, 1).
 */
let prngSeed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
export function fastRandom(): number {
  // LCG parameters from Numerical Recipes (a=1664525, c=1013904223)
  prngSeed = (Math.imul(1664525, prngSeed) + 1013904223) >>> 0;
  return prngSeed / 0xffffffff;
}

/**
 * Remove expired messages in-place, simultaneously maintaining the
 * lane-indexed map incrementally during compaction.
 * Returns the new logical length and whether any messages were removed.
 */
export function cleanupExpiredMessages(
  messages: CanvasMessage[],
  now: number,
  activeMessagesByLane: Map<number, CanvasMessage[]>,
  expiredScratch: CanvasMessage[],
  onExpire?: (msg: CanvasMessage) => void
): { newLength: number; anyRemoved: boolean; newMessages?: CanvasMessage[] } {
  const oldLength = messages.length;
  let writeIdx = 0;
  let anyRemoved = false;
  expiredScratch.length = 0;

  // Single pass: compact messages + detect expirations.
  for (let i = 0; i < oldLength; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const elapsed = now - msg.startTime - msg.pausedDuration;
    if (elapsed < msg.duration) {
      messages[writeIdx] = msg;
      writeIdx++;
    } else {
      anyRemoved = true;
      expiredScratch.push(msg);
      onExpire?.(msg);
    }
  }

  // Remove only expired messages from the lane map — incremental instead of
  // full clear+rebuild. For screen with 100 active messages where 1 expires,
  // this is O(1) lane operations instead of O(100) rebuild.
  if (anyRemoved) {
    for (const msg of expiredScratch) {
      const slotCount = msg.slotCount ?? 1;
      for (let slot = 0; slot < slotCount; slot++) {
        const lane = msg.laneIndex + slot;
        const list = activeMessagesByLane.get(lane);
        if (list) {
          const idx = list.indexOf(msg);
          if (idx !== -1) {
            list[idx] = list[list.length - 1]!;
            list.pop();
          }
          if (list.length === 0) activeMessagesByLane.delete(lane);
        }
      }
    }
  }
  // Array compaction threshold: when more than half of the array slots are
  // expired, allocate a fresh array via slice() instead of nulling the tail.
  // This avoids keeping garbage-filled tail slots in the array, at the cost
  // of one allocation, which is worthwhile when the majority is garbage.
  if (writeIdx < oldLength * COMPACTION_THRESHOLD_RATIO) {
    return { newMessages: messages.slice(0, writeIdx), newLength: writeIdx, anyRemoved };
  }
  // Otherwise, truncate the array to remove stale references (no allocation of a new array).
  messages.length = writeIdx;
  return { newLength: writeIdx, anyRemoved };
}

/** Accumulate paused duration across all active messages. */
export function applyPausedDurationToMessages(messages: CanvasMessage[], pausedMs: number): void {
  for (const msg of messages) {
    msg.pausedDuration += pausedMs;
  }
}
