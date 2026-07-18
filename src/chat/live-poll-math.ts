// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Pure computation functions extracted from LiveChatSource.
 *
 * These functions implement the adaptive polling delay algorithm:
 * error backoff, burst reactivity, and density adaptation — isolated
 * from the LiveChatSource class so they can be unit-tested independently
 * of YouTube API, DOM, and AbortSignal dependencies.
 */

// ── Threshold constants (mirror LiveChatSource) ──────────────────────────

export const DENSITY_WINDOW_SIZE = 5;
export const DENSITY_HIGH_THRESHOLD = 10;
export const DENSITY_LOW_THRESHOLD = 1;
export const EXTREME_DENSITY_THRESHOLD = 30;

// ── Density ring mutation ─────────────────────────────────────────────────

/**
 * Record a message count into the circular density buffer.
 * Mutates the ring array and returns the updated write position and filled count.
 *
 * @returns {write, filled} — updated state for the caller to store.
 */
export function recordDensitySample(
  ring: Uint16Array,
  write: number,
  filled: number,
  count: number
): { write: number; filled: number } {
  ring[write] = count;
  const nextWrite = (write + 1) % DENSITY_WINDOW_SIZE;
  const nextFilled = filled < DENSITY_WINDOW_SIZE ? filled + 1 : DENSITY_WINDOW_SIZE;
  return { write: nextWrite, filled: nextFilled };
}

// ── Adaptive delay computation ────────────────────────────────────────────

export interface DensityConfig {
  minPollIntervalMs: number;
  maxPollIntervalMs: number;
}

/**
 * Exponential backoff when consecutive errors have occurred.
 * Returns `null` if no errors are active.
 */
export function computeErrorBackoffMs(
  fallbackMs: number,
  consecutiveErrors: number,
  limits: DensityConfig
): number | null {
  if (consecutiveErrors === 0) return null;

  const delayed = fallbackMs * 2 ** consecutiveErrors;
  return Math.min(limits.maxPollIntervalMs, Math.max(limits.minPollIntervalMs, delayed));
}

/**
 * Sub-poll-interval burst reactivity via EMA rate.
 * Returns `null` if the EMA rate is below any threshold.
 */
export function computeBurstAdjustedMs(
  fallbackMs: number,
  emaRate: number | undefined,
  limits: DensityConfig
): number | null {
  if (emaRate === undefined) return null;
  if (emaRate >= EXTREME_DENSITY_THRESHOLD) return 0;
  if (emaRate >= DENSITY_HIGH_THRESHOLD) {
    return Math.max(
      limits.minPollIntervalMs,
      Math.round(Math.min(limits.maxPollIntervalMs, fallbackMs) * 0.3)
    );
  }
  return null;
}

/**
 * Moving-window density adaptation using circular buffer.
 * Uses the ring's recorded message counts to compute an adaptive delay.
 */
export function computeDensityAdjustedMs(
  fallbackMs: number,
  densityRing: Uint16Array,
  densityRingFilled: number,
  limits: DensityConfig
): number {
  if (densityRingFilled < 2) {
    return Math.max(limits.minPollIntervalMs, Math.min(limits.maxPollIntervalMs, fallbackMs));
  }

  let sum = 0;
  for (let i = 0; i < densityRingFilled; i++) {
    sum += densityRing[i]!;
  }
  const avgCount = sum / densityRingFilled;

  if (avgCount >= EXTREME_DENSITY_THRESHOLD) return 0;

  let base = Math.max(limits.minPollIntervalMs, Math.min(limits.maxPollIntervalMs, fallbackMs));

  if (avgCount >= DENSITY_HIGH_THRESHOLD) {
    base = Math.max(limits.minPollIntervalMs, Math.round(base * 0.3));
  }
  if (avgCount <= DENSITY_LOW_THRESHOLD) {
    base = Math.min(limits.maxPollIntervalMs, Math.round(base * 1.2));
  }

  return Math.max(limits.minPollIntervalMs, Math.min(limits.maxPollIntervalMs, base));
}

/**
 * Compute the full adaptive delay, applying three strategies in priority order:
 * 1. Error exponential backoff (takes priority when recovering)
 * 2. Burst detection via EMA rate (sub-poll-interval reactivity)
 * 3. Moving-window density adaptation (full history consideration)
 */
export function calculateAdaptiveDelay(
  timeoutMs: number,
  livePollFallbackMs: number,
  consecutiveErrors: number,
  emaRate: number | undefined,
  densityRing: Uint16Array,
  densityRingFilled: number,
  limits: DensityConfig
): number {
  const fallback = timeoutMs > 0 ? timeoutMs : livePollFallbackMs;

  const errorBackoff = computeErrorBackoffMs(fallback, consecutiveErrors, limits);
  if (errorBackoff !== null) return errorBackoff;

  const burstAdjusted = computeBurstAdjustedMs(fallback, emaRate, limits);
  if (burstAdjusted !== null) return burstAdjusted;

  return computeDensityAdjustedMs(fallback, densityRing, densityRingFilled, limits);
}
