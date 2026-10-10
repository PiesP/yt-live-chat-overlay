// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { DanmakuMode } from '@app-types';

export interface MessageMotionPlanInput {
  mode: DanmakuMode;
  now: number;
  batchIndex: number;
  /** Bounded per-group sequence, independent of the current drain partition. */
  entrySequence?: number | undefined;
  previousStaggerDelayMs: number;
  /** Last committed geometric entry in this source/priority/tier group. */
  previousViewportEntryTime?: number | undefined;
  /** Replay source time takes precedence over optional visual staggering. */
  isReplay?: boolean;
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
  mode: DanmakuMode;
  isScrolling: boolean;
  horizontalStaggerPx: number;
  staggerLimitMs: number;
  staggerDelayMs: number;
  startTime: number;
  startX: number;
  travelDistancePx: number;
  durationMs: number;
  screenWidthPx: number;
  messageWidthPx: number;
  actualVelocityPxPerMs: number;
  /** Geometry crossing the viewport edge, independent of opacity or fade. */
  viewportEntryTime: number;
  visibleExitTime: number;
  endTime: number;
}
