// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { DanmakuMode } from '@app-types';
import { computeLaneY } from '@renderer/layout/lane-shared';
import {
  type MessageMotionPlan,
  messageXAtTime,
  motionPlanFromMessage,
  motionPlansCollide,
} from '@renderer/layout/message-schedule';

const MAX_REFLOW_LANE_ATTEMPTS = 128;

/** Reconstruct paused time while retaining the prior viewport and measured geometry. */
export function previousMotionPlan(
  message: {
    motion?: MessageMotionPlan;
    startTime: number;
    pausedDuration: number;
    startX: number;
    width: number;
    duration: number;
  },
  mode: DanmakuMode,
  screenWidth: number,
  exitPadding: number
): MessageMotionPlan {
  const saved = message.motion;
  if (!saved) return motionPlanFromMessage(message, mode, screenWidth, exitPadding);
  const shift = message.startTime + message.pausedDuration - saved.startTime;
  return {
    ...saved,
    startTime: saved.startTime + shift,
    viewportEntryTime: saved.viewportEntryTime + shift,
    visibleExitTime: saved.visibleExitTime + shift,
    endTime: saved.endTime + shift,
  };
}

/** Preserve a future entry deadline, or elapsed progress for an already-started message. */
export function reflowMotionPlan(
  previous: MessageMotionPlan,
  next: MessageMotionPlan,
  now: number,
  exitPaddingPx: number
): MessageMotionPlan {
  const elapsed = now - previous.startTime;
  const startTime =
    elapsed < 0
      ? Math.max(
          previous.startTime,
          previous.viewportEntryTime - (next.viewportEntryTime - next.startTime)
        )
      : now - Math.min(1, elapsed / Math.max(1, previous.durationMs)) * next.durationMs;
  return motionPlanFromMessage(
    {
      startTime,
      pausedDuration: 0,
      startX: next.startX,
      width: next.messageWidthPx,
      duration: next.durationMs,
    },
    next.mode,
    next.screenWidthPx,
    exitPaddingPx
  );
}

export interface ReflowCandidate<T> {
  message: T;
  laneIndex: number;
  height: number;
  motion: MessageMotionPlan;
}

export interface ReflowPlacement<T> extends ReflowCandidate<T> {
  slotCount: number;
  y: number;
}

/**
 * Keep legal lane blocks first, then search alternatives for displaced messages.
 * Capacity losses are explicit: oversized geometry or no collision-free block.
 * Every accepted timeline is checked against earlier accepted reservations.
 */
export function reconcileMessagePlacements<T>(
  candidates: readonly ReflowCandidate<T>[],
  options: {
    laneCount: number;
    laneHeight: number;
    viewportHeight: number;
    safeTop: number;
    mode: DanmakuMode;
    headwayGapRatio: number;
    now: number;
  }
): {
  placements: ReflowPlacement<T>[];
  dropped: Array<{ message: T; reason: 'oversized' | 'reflow_capacity' }>;
} {
  const placements: ReflowPlacement<T>[] = [];
  const dropped: Array<{ message: T; reason: 'oversized' | 'reflow_capacity' }> = [];
  const displaced: ReflowCandidate<T>[] = [];
  const tryLane = (
    candidate: ReflowCandidate<T>,
    laneIndex: number,
    slotCount: number
  ): boolean => {
    if (laneIndex < 0 || laneIndex + slotCount > options.laneCount) return false;
    const y =
      computeLaneY(laneIndex, options.viewportHeight, options.safeTop, options.laneHeight) +
      Math.floor((slotCount * options.laneHeight - candidate.height) / 2);
    for (const other of placements) {
      if (other.y + other.height <= y || other.y >= y + candidate.height) continue;
      if (
        motionPlansCollide(candidate.motion, other.motion, options.headwayGapRatio, options.now)
      ) {
        return false;
      }
    }
    placements.push({ ...candidate, laneIndex, slotCount, y });
    return true;
  };
  for (const candidate of candidates) {
    const slotCount = Math.max(1, Math.ceil(candidate.height / options.laneHeight));
    if (slotCount > options.laneCount) {
      dropped.push({ message: candidate.message, reason: 'oversized' });
    } else if (!tryLane(candidate, candidate.laneIndex, slotCount)) {
      displaced.push(candidate);
    }
  }
  for (const candidate of displaced) {
    const slotCount = Math.max(1, Math.ceil(candidate.height / options.laneHeight));
    const maxLane = options.laneCount - slotCount;
    let placed = false;
    // Sample across the full safe zone if an unusually tall viewport exceeds
    // the attempt budget. Keep synchronous resize/translation work bounded.
    const attempts = Math.min(maxLane + 1, MAX_REFLOW_LANE_ATTEMPTS);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const offset = attempts > 1 ? Math.round((attempt * maxLane) / (attempts - 1)) : 0;
      const lane = options.mode === 'bottom' ? maxLane - offset : offset;
      if (tryLane(candidate, lane, slotCount)) {
        placed = true;
        break;
      }
    }
    if (!placed) dropped.push({ message: candidate.message, reason: 'reflow_capacity' });
  }
  return { placements, dropped };
}

/** Apply a reconciled plan without losing the accumulated pause offset. */
export function applyReflowMotion(
  message: {
    startTime: number;
    pausedDuration: number;
    startX: number;
    duration: number;
    invDuration: number;
    x: number;
  },
  motion: MessageMotionPlan,
  now: number
): void {
  message.startTime = motion.startTime - message.pausedDuration;
  message.startX = motion.startX;
  message.duration = motion.durationMs;
  message.invDuration = 1 / Math.max(1, motion.durationMs);
  message.x = messageXAtTime(motion, now);
}
