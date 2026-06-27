// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Rendering pipeline utility functions.
 *
 * Pure computation functions used by the rendering pipeline (scroll duration,
 * headway, etc.). These are not design tokens — they derive runtime values
 * from configuration and message metrics.
 */

/**
 * Compute DLIOS animation duration from total travel distance and velocity.
 *
 * The minimum duration is velocity-aware so that short messages at high
 * scroll speeds are not artificially slowed down by a static floor.
 * Without this, at speedPxPerSec=500 a 3-char message's computed duration
 * (~3070ms) was clamped to the settings scrollDurationMinMs (5000ms), capping
 * the effective speed at 307px/s instead of the user-configured 500px/s.
 *
 * @param totalDistance  — screenWidth + textWidth + exitPadding
 * @param velocity       — constant scroll velocity in px/sec
 * @param durationMin    — minimum allowed duration in ms
 * @param durationMax    — maximum allowed duration in ms
 * @param exitPaddingPx  — exit padding distance in px
 * @returns Animation duration in milliseconds
 */
export function computeScrollDuration(
  totalDistance: number,
  velocity: number,
  durationMin: number,
  durationMax: number,
  exitPaddingPx: number
): number {
  // Velocity-based floor: at minimum, allow the message to travel
  // exitPadding pixels at the configured velocity, but no less than the minimum duration.
  const velocityFloor = Math.max(durationMin, (exitPaddingPx / velocity) * 1000);
  return Math.max(velocityFloor, Math.min(durationMax, (totalDistance / velocity) * 1000));
}
