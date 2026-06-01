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

export const HEADWAY_GAP_MIN_PX = 16;

export const HEADWAY_GAP_MAX_PX = 60;

// ── Pure computation functions ─────────────────────────────────────────────

/** Compute minimum headway gap (px) between consecutive messages. */
export function computeBaseHeadwayPx(msgWidth: number, headwayGapRatio: number): number {
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
  // Top/bottom mode: full duration + safety cooldown
  if (msgWidthPx === undefined || screenWidth === undefined) {
    const safetyMargin = Math.round(durationMs * SAFETY_MARGIN_RATIO);
    return durationMs + Math.max(LANE_COOLDOWN_MIN_MS, safetyMargin);
  }

  // Scrolling mode: precision exit-time
  const totalDistance = screenWidth + msgWidthPx + exitPaddingPx;
  const headwayPx = computeBaseHeadwayPx(msgWidthPx, headwayGapRatio);
  const rightEdgePassFraction = (msgWidthPx + headwayPx) / totalDistance;
  return Math.round(rightEdgePassFraction * durationMs);
}
