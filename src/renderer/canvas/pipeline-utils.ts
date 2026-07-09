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

/** Reset the PRNG seed for test isolation. */
export function resetPrngSeed(): void {
  prngSeed = 0;
}

export function fastRandom(): number {
  // LCG parameters from Numerical Recipes (a=1664525, c=1013904223)
  prngSeed = (Math.imul(1664525, prngSeed) + 1013904223) >>> 0;
  return prngSeed / 0xffffffff;
}
