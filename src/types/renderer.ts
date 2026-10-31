// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { BurstLevel } from './common';

/** Per-frame timing instrumentation for the render pipeline. */
export interface FrameTimings {
  renderFrameMs: number;
  drainQueueMs: number;
  collisionCheckMs: number;
  textMeasureMs: number;
  frameCount: number;
  lastFrameTimestamp: number;
}

/** Session metrics snapshot for ObservabilityReporter */
export interface SessionMetrics {
  totalReceived: number;
  totalRendered: number;
  /** Confirmed first eligible frames, distinct from allocation; a recovery timeout can undercount. */
  totalPresented: number;
  /** Main draws whose first-count ownership could not be proven after Worker recovery. */
  totalPresentationUnknown: number;
  totalDropped: number;
  dropRate: number;
  queueDepth: number;
  burstLevel: BurstLevel;
  activeMessages: number;
  laneUtilization: number;
  backlogProgress: number;
  frameTimings: FrameTimings;
}

/** Interface for objects that can be paused/resumed. */
export type Pauseable = {
  setPaused(paused: boolean): void;
};
