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
import { computeBaseHeadwayPx } from '@renderer/layout/lane-shared';
import type { MessageMotionPlan, MessageMotionPlanInput } from '@renderer/layout/motion-types';
import { computeScrollDuration } from '@util/design-tokens';

export type { MessageMotionPlan, MessageMotionPlanInput } from '@renderer/layout/motion-types';

/** Resolve the visual mode before choosing a lane or reserving its lifetime. */
export function resolveEffectiveMotionMode(
  mode: DanmakuMode,
  reducedMotion: boolean,
  ignoreReducedMotion: boolean
): DanmakuMode {
  return reducedMotion && !ignoreReducedMotion && (mode === 'scroll' || mode === 'reverse')
    ? 'top'
    : mode;
}

function motionGeometry(
  mode: DanmakuMode,
  startTime: number,
  startX: number,
  messageWidthPx: number,
  screenWidthPx: number,
  durationMs: number,
  exitPaddingPx: number
): Pick<
  MessageMotionPlan,
  'travelDistancePx' | 'actualVelocityPxPerMs' | 'viewportEntryTime' | 'visibleExitTime' | 'endTime'
> {
  const isScrolling = mode === 'scroll' || mode === 'reverse';
  const travelDistancePx = isScrolling
    ? mode === 'scroll'
      ? startX + messageWidthPx + exitPaddingPx
      : screenWidthPx - startX + exitPaddingPx
    : 0;
  const actualVelocityPxPerMs = isScrolling && durationMs > 0 ? travelDistancePx / durationMs : 0;
  const entryOffsetPx = isScrolling
    ? mode === 'scroll'
      ? Math.max(0, startX - screenWidthPx)
      : Math.max(0, -startX - messageWidthPx)
    : 0;
  const viewportEntryTime =
    startTime + (actualVelocityPxPerMs > 0 ? entryOffsetPx / actualVelocityPxPerMs : 0);
  const visibleDistancePx = isScrolling
    ? mode === 'scroll'
      ? startX + messageWidthPx
      : screenWidthPx - startX
    : 0;
  const endTime = startTime + durationMs;
  const visibleExitTime =
    isScrolling && actualVelocityPxPerMs > 0
      ? Math.min(endTime, startTime + visibleDistancePx / actualVelocityPxPerMs)
      : endTime;
  return { travelDistancePx, actualVelocityPxPerMs, viewportEntryTime, visibleExitTime, endTime };
}

/** Reconstruct the exact drawn motion from an active message's committed fields. */
export function motionPlanFromMessage(
  message: {
    startTime: number;
    pausedDuration: number;
    startX: number;
    width: number;
    duration: number;
  },
  mode: DanmakuMode,
  screenWidthPx: number,
  exitPaddingPx: number
): MessageMotionPlan {
  const startTime = message.startTime + message.pausedDuration;
  const geometry = motionGeometry(
    mode,
    startTime,
    message.startX,
    message.width,
    screenWidthPx,
    message.duration,
    exitPaddingPx
  );
  return {
    mode,
    isScrolling: mode === 'scroll' || mode === 'reverse',
    horizontalStaggerPx:
      mode === 'scroll'
        ? Math.max(0, message.startX - screenWidthPx)
        : mode === 'reverse'
          ? Math.max(0, -message.startX - message.width)
          : 0,
    staggerLimitMs: 0,
    staggerDelayMs: 0,
    startTime,
    startX:
      mode === 'top' || mode === 'bottom'
        ? Math.max(0, Math.floor((screenWidthPx - message.width) / 2))
        : message.startX,
    durationMs: message.duration,
    screenWidthPx,
    messageWidthPx: message.width,
    ...geometry,
  };
}

/** Canvas and Worker use this position expression for the committed motion. */
export function messageXAtElapsed(
  mode: DanmakuMode,
  startX: number,
  messageWidthPx: number,
  screenWidthPx: number,
  exitPaddingPx: number,
  elapsedMs: number,
  durationMs: number
): number {
  if (mode === 'top' || mode === 'bottom') {
    return Math.max(0, Math.floor((screenWidthPx - messageWidthPx) / 2));
  }
  if (durationMs <= 0) return startX;
  const progress = Math.min(1, Math.max(0, elapsedMs / durationMs));
  const distance =
    mode === 'scroll'
      ? startX + messageWidthPx + exitPaddingPx
      : screenWidthPx - startX + exitPaddingPx;
  return startX + (mode === 'scroll' ? -1 : 1) * progress * distance;
}

export function messageXAtTime(plan: MessageMotionPlan, now: number): number {
  if (!plan.isScrolling) return plan.startX;
  const elapsed = Math.min(plan.durationMs, Math.max(0, now - plan.startTime));
  return plan.startX + (plan.mode === 'scroll' ? -1 : 1) * elapsed * plan.actualVelocityPxPerMs;
}

/** Affine separation needs checking only at the common visible interval's endpoints. */
export function motionPlansCollide(
  a: MessageMotionPlan,
  b: MessageMotionPlan,
  headwayGapRatio: number,
  fromTime = -Infinity
): boolean {
  const first = Math.max(a.viewportEntryTime, b.viewportEntryTime, fromTime);
  const last = Math.min(a.visibleExitTime, b.visibleExitTime);
  if (first >= last) return false;
  const gap = Math.max(
    computeBaseHeadwayPx(a.messageWidthPx, headwayGapRatio),
    computeBaseHeadwayPx(b.messageWidthPx, headwayGapRatio)
  );
  const ax = messageXAtTime(a, first);
  const bx = messageXAtTime(b, first);
  const axLast = messageXAtTime(a, last);
  const bxLast = messageXAtTime(b, last);
  const aBeforeB = ax + a.messageWidthPx + gap <= bx && axLast + a.messageWidthPx + gap <= bxLast;
  const bBeforeA = bx + b.messageWidthPx + gap <= ax && bxLast + b.messageWidthPx + gap <= axLast;
  return !aBeforeB && !bBeforeA;
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
  const medium = Number.isFinite(mediumDelayMs) ? Math.max(0, Math.min(maximum, mediumDelayMs)) : 0;

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
 * Optional entry effects share one bounded window: temporal delay consumes it
 * first, then horizontal offset uses the remainder at the actual velocity.
 * The caller retains the last committed geometric entry per source/priority/
 * tier group across drains. We preserve that order when its entry still fits
 * in this window. A long lane wait can be overtaken so it cannot block free
 * lanes in the same or another group. Replay bypasses optional entry effects.
 */
export function computeMessageMotionPlan(input: MessageMotionPlanInput): MessageMotionPlan {
  const isScrolling = input.mode === 'scroll' || input.mode === 'reverse';
  const rawSequence = input.entrySequence ?? input.batchIndex;
  const batchIndex = Number.isFinite(rawSequence) ? Math.max(0, Math.floor(rawSequence)) : 0;
  const staggerLimitMs = input.isReplay
    ? 0
    : computeAdaptiveStaggerLimit(
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
  const exitPaddingPx = Number.isFinite(input.exitPaddingPx) ? Math.max(0, input.exitPaddingPx) : 0;
  const durationMultiplier = Number.isFinite(input.durationMultiplier)
    ? Math.max(0, input.durationMultiplier)
    : 1;
  const baselineTravelDistancePx = screenWidth + messageWidth + exitPaddingPx;
  const baselineDurationMs = isScrolling
    ? computeScrollDuration(
        baselineTravelDistancePx,
        input.velocityPxPerSec,
        input.scrollDurationMinMs,
        input.scrollDurationMaxMs,
        exitPaddingPx
      ) * durationMultiplier
    : 0;
  // Adding offset cannot reduce travelDistance / finalDuration under the
  // duration clamps, so the zero-offset velocity conservatively bounds entry.
  const baselineVelocityPxPerMs =
    baselineDurationMs > 0 ? baselineTravelDistancePx / baselineDurationMs : 0;
  const remainingEntryBudgetMs = Math.max(0, staggerLimitMs - staggerDelayMs);
  const desiredHorizontalOffsetPx = Math.min(
    HORIZONTAL_STAGGER_MAX,
    batchIndex * HORIZONTAL_STAGGER_PER_STEP
  );
  const horizontalStaggerPx =
    isScrolling && baselineVelocityPxPerMs > 0
      ? Math.min(
          desiredHorizontalOffsetPx,
          Math.floor(remainingEntryBudgetMs * baselineVelocityPxPerMs)
        )
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
  const durationMs = baseDurationMs * durationMultiplier;
  const placementWaitMs = Number.isFinite(input.placementWaitMs)
    ? Math.max(0, input.placementWaitMs)
    : 0;
  let startTime = input.now + placementWaitMs + staggerDelayMs;
  let geometry = motionGeometry(
    input.mode,
    startTime,
    startX,
    messageWidth,
    screenWidth,
    durationMs,
    exitPaddingPx
  );
  const previousEntry = input.previousViewportEntryTime;
  if (staggerLimitMs > 0 && previousEntry !== undefined && Number.isFinite(previousEntry)) {
    const entryFloor = Math.min(previousEntry, input.now + placementWaitMs + staggerLimitMs);
    const entryDelayMs = Math.max(0, entryFloor - geometry.viewportEntryTime);
    if (entryDelayMs > 0) {
      startTime += entryDelayMs;
      geometry = motionGeometry(
        input.mode,
        startTime,
        startX,
        messageWidth,
        screenWidth,
        durationMs,
        exitPaddingPx
      );
    }
  }

  return {
    mode: input.mode,
    isScrolling,
    horizontalStaggerPx,
    staggerLimitMs,
    staggerDelayMs,
    startTime,
    startX,
    durationMs,
    screenWidthPx: screenWidth,
    messageWidthPx: messageWidth,
    ...geometry,
  };
}
