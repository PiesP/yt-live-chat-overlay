// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { DanmakuMode } from '@app-types';
import {
  HORIZONTAL_STAGGER_MAX,
  HORIZONTAL_STAGGER_PER_STEP,
  STAGGER_EXP_SCALE,
  STAGGER_QUEUE_HIGH,
  STAGGER_QUEUE_MED,
} from '@renderer/constants';
import { computeScrollDuration } from '@util/design-tokens';

export interface MessageMotionPlanInput {
  mode: DanmakuMode;
  now: number;
  batchIndex: number;
  previousStaggerDelayMs: number;
  queueDepth: number;
  /** Positive exponential-distribution sample, normally read from the shared LUT. */
  staggerSample: number;
  maxStaggerDelayMs: number;
  mediumStaggerDelayMs: number;
  placementWaitMs: number;
  screenWidth: number;
  messageWidth: number;
  velocityPxPerSec: number;
  scrollDurationMinMs: number;
  scrollDurationMaxMs: number;
  exitPaddingPx: number;
  topBottomDurationMs: number;
  durationMultiplier: number;
}

export interface MessageMotionPlan {
  isScrolling: boolean;
  horizontalStaggerPx: number;
  staggerLimitMs: number;
  staggerDelayMs: number;
  startTime: number;
  startX: number;
  travelDistancePx: number;
  durationMs: number;
}

/**
 * Continuously compact the available stagger window as the queue fills.
 * This preserves the user-facing max/medium endpoints while avoiding abrupt
 * timing changes when queue depth crosses 30 or 50 messages.
 */
export function computeAdaptiveStaggerLimit(
  queueDepth: number,
  maxDelayMs: number,
  mediumDelayMs: number
): number {
  const depth = Number.isFinite(queueDepth) ? Math.max(0, queueDepth) : STAGGER_QUEUE_HIGH;
  const maximum = Number.isFinite(maxDelayMs) ? Math.max(0, maxDelayMs) : 0;
  const medium = Number.isFinite(mediumDelayMs)
    ? Math.max(0, Math.min(maximum, mediumDelayMs))
    : 0;

  if (depth >= STAGGER_QUEUE_HIGH) return 0;
  if (depth <= STAGGER_QUEUE_MED) {
    const pressure = depth / STAGGER_QUEUE_MED;
    return Math.round(maximum + (medium - maximum) * pressure);
  }

  const pressure = (depth - STAGGER_QUEUE_MED) / (STAGGER_QUEUE_HIGH - STAGGER_QUEUE_MED);
  return Math.round(medium * (1 - pressure));
}

/**
 * Compute all activation-time motion values from one pure policy shared by
 * the main-thread and Worker renderers.
 *
 * Temporal gaps are cumulative exponential samples. Unlike independent
 * `batchIndex * sample` delays, the cursor can never move backward, so later
 * comments cannot overtake earlier comments before either one is visible.
 */
export function computeMessageMotionPlan(input: MessageMotionPlanInput): MessageMotionPlan {
  const isScrolling = input.mode === 'scroll' || input.mode === 'reverse';
  const batchIndex = Math.max(0, Math.floor(input.batchIndex));
  const horizontalStaggerPx = isScrolling
    ? Math.min(HORIZONTAL_STAGGER_MAX, batchIndex * HORIZONTAL_STAGGER_PER_STEP)
    : 0;
  const staggerLimitMs = computeAdaptiveStaggerLimit(
    input.queueDepth,
    input.maxStaggerDelayMs,
    input.mediumStaggerDelayMs
  );

  let staggerDelayMs = 0;
  if (batchIndex > 0 && staggerLimitMs > 0) {
    const previous = Number.isFinite(input.previousStaggerDelayMs)
      ? Math.max(0, input.previousStaggerDelayMs)
      : 0;
    const sample = Number.isFinite(input.staggerSample) ? Math.max(0, input.staggerSample) : 0;
    const nextGap = Math.max(1, Math.round(STAGGER_EXP_SCALE * sample));
    staggerDelayMs = Math.min(staggerLimitMs, previous + nextGap);
  }

  const screenWidth = Number.isFinite(input.screenWidth) ? Math.max(0, input.screenWidth) : 0;
  const messageWidth = Number.isFinite(input.messageWidth) ? Math.max(0, input.messageWidth) : 0;
  const exitPaddingPx = Number.isFinite(input.exitPaddingPx)
    ? Math.max(0, input.exitPaddingPx)
    : 0;

  let startX: number;
  if (input.mode === 'scroll') {
    startX = screenWidth + horizontalStaggerPx;
  } else if (input.mode === 'reverse') {
    startX = -(messageWidth + horizontalStaggerPx);
  } else {
    startX = Math.max(0, Math.floor((screenWidth - messageWidth) / 2));
  }

  const travelDistancePx = isScrolling
    ? screenWidth + messageWidth + exitPaddingPx + horizontalStaggerPx
    : 0;
  const baseDurationMs = isScrolling
    ? computeScrollDuration(
        travelDistancePx,
        input.velocityPxPerSec,
        input.scrollDurationMinMs,
        input.scrollDurationMaxMs,
        exitPaddingPx
      )
    : input.topBottomDurationMs;
  const durationMultiplier = Number.isFinite(input.durationMultiplier)
    ? Math.max(0, input.durationMultiplier)
    : 1;
  const durationMs = baseDurationMs * durationMultiplier;
  const placementWaitMs = Number.isFinite(input.placementWaitMs)
    ? Math.max(0, input.placementWaitMs)
    : 0;

  return {
    isScrolling,
    horizontalStaggerPx,
    staggerLimitMs,
    staggerDelayMs,
    startTime: input.now + placementWaitMs + staggerDelayMs,
    startX,
    travelDistancePx,
    durationMs,
  };
}
