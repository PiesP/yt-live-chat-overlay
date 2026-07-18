// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Sine LUT helpers — pure functions for lookup-table-based trig operations.
 *
 * Extracted from CanvasRenderer and Worker renderer to eliminate duplicate
 * SIN_TABLE/SIN_LUT_SCALE index computation across 3 call sites.
 */

import { SIN_LUT_SCALE, SIN_TABLE } from '@renderer/constants';

/**
 * Fast sine approximation using a 256-entry pre-computed LUT.
 * One cycle = 2000ms (defined by SIN_LUT_SCALE).
 *
 * @param elapsedMs - Elapsed time in milliseconds
 * @returns sin approximation in [-1, 1]
 */
export function fastSin(elapsedMs: number): number {
  const idx = ((elapsedMs * SIN_LUT_SCALE) | 0) & 255;
  return SIN_TABLE[idx]!;
}

/**
 * Compute pulsating border alpha using the sine LUT.
 *
 * @param elapsedMs - Elapsed time in milliseconds
 * @param baseAlpha  - Base alpha (0-1) when sin = 0
 * @param amplitude  - Amplitude of pulsation (0-1)
 * @returns Computed alpha value (may exceed 1.0 — caller should clamp)
 */
export function computePulseAlpha(elapsedMs: number, baseAlpha: number, amplitude: number): number {
  return fastSin(elapsedMs) * amplitude + baseAlpha;
}
