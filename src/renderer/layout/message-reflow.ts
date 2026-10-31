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
import {
  getRowContentOffset,
  getRowSlotCount,
  rowsNeedVerticalClearance,
} from '@renderer/layout/row-geometry';

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

/**
 * Keep future entry deadlines. For visible geometry changes, anchor the current
 * drawn X and preserve expiry by adjusting the affine velocity. A deliberate
 * motion-policy change may instead establish one deadline at the new velocity.
 */
export function reflowMotionPlan(
  previous: MessageMotionPlan,
  next: MessageMotionPlan,
  now: number,
  exitPaddingPx: number,
  reason: 'geometry' | 'policy' = 'geometry'
): MessageMotionPlan {
  // A reflow can run between expiration and the next cleanup frame.
  if (previous.endTime <= now) return previous;

  const policyChanged =
    reason === 'policy' &&
    (previous.mode !== next.mode ||
      previous.isScrolling ||
      previous.durationMs !== next.durationMs);
  const previousPadding = previous.isScrolling
    ? previous.travelDistancePx -
      (previous.mode === 'scroll'
        ? previous.startX + previous.messageWidthPx
        : previous.screenWidthPx - previous.startX)
    : exitPaddingPx;
  if (
    !policyChanged &&
    previous.mode === next.mode &&
    previous.screenWidthPx === next.screenWidthPx &&
    previous.messageWidthPx === next.messageWidthPx &&
    Math.abs(previousPadding - exitPaddingPx) < 1e-6
  ) {
    return previous;
  }

  const plan = (startTime: number, startX: number, duration: number): MessageMotionPlan =>
    motionPlanFromMessage(
      {
        startTime,
        pausedDuration: 0,
        startX,
        width: next.messageWidthPx,
        duration,
      },
      next.mode,
      next.screenWidthPx,
      exitPaddingPx
    );

  if (previous.viewportEntryTime > now) {
    const startTime = previous.viewportEntryTime - (next.viewportEntryTime - next.startTime);
    const duration = policyChanged ? next.durationMs : previous.endTime - startTime;
    return duration > 0 ? plan(startTime, next.startX, duration) : previous;
  }

  if (!next.isScrolling) {
    return policyChanged
      ? plan(now, next.startX, next.durationMs)
      : plan(previous.startTime, next.startX, previous.durationMs);
  }

  const currentX = messageXAtTime(previous, now);
  const sameDirection = previous.mode === next.mode;
  const startX = sameDirection
    ? next.mode === 'scroll'
      ? Math.max(next.startX, currentX)
      : Math.min(next.startX, currentX)
    : currentX;
  const remainingDistance =
    next.mode === 'scroll'
      ? currentX + next.messageWidthPx + exitPaddingPx
      : next.screenWidthPx - currentX + exitPaddingPx;
  const totalDistance =
    next.mode === 'scroll'
      ? startX + next.messageWidthPx + exitPaddingPx
      : next.screenWidthPx - startX + exitPaddingPx;
  const remainingTime = previous.endTime - now;
  const velocity = policyChanged ? next.actualVelocityPxPerMs : remainingDistance / remainingTime;
  if (remainingDistance <= 0 || totalDistance <= 0 || velocity <= 0) return previous;
  const elapsedFromStart = Math.abs(startX - currentX) / velocity;
  return plan(now - elapsedFromStart, startX, totalDistance / velocity);
}

export interface ReflowCandidate<T> {
  message: T;
  laneIndex: number;
  /** Last actually drawn vertical position in logical pixels. */
  preferredY?: number;
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
    laneSpacing?: number;
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
  const occupants = new Map<number, ReflowPlacement<T>[]>();
  const scratch = new Set<ReflowPlacement<T>>();
  const dropped: Array<{ message: T; reason: 'oversized' | 'reflow_capacity' }> = [];
  const preferredLane = (candidate: ReflowCandidate<T>, slotCount: number): number => {
    const maxLane = options.laneCount - slotCount;
    if (!Number.isFinite(candidate.preferredY) || options.laneHeight <= 0) {
      return candidate.laneIndex;
    }
    const origin = options.viewportHeight * options.safeTop;
    const offset = getRowContentOffset(candidate.height, options.laneHeight, options.laneSpacing);
    return Math.max(
      0,
      Math.min(
        maxLane,
        Math.round(((candidate.preferredY ?? 0) - origin - offset) / options.laneHeight)
      )
    );
  };
  const tryLane = (
    candidate: ReflowCandidate<T>,
    laneIndex: number,
    slotCount: number
  ): boolean => {
    if (laneIndex < 0 || laneIndex + slotCount > options.laneCount) return false;
    const y =
      computeLaneY(laneIndex, options.viewportHeight, options.safeTop, options.laneHeight) +
      getRowContentOffset(candidate.height, options.laneHeight, options.laneSpacing);
    scratch.clear();
    // Every content rectangle plus its gap fits inside its reserved slot block.
    // Thus a clearance conflict must share a slot; the adjacent lanes also
    // cover fractional-grid rounding at the block boundary.
    for (let lane = laneIndex - 1; lane <= laneIndex + slotCount; lane++) {
      for (const other of occupants.get(lane) ?? []) scratch.add(other);
    }
    for (const other of scratch) {
      if (
        !rowsNeedVerticalClearance(
          y,
          candidate.height,
          other.y,
          other.height,
          options.laneSpacing ?? 0
        )
      )
        continue;
      if (
        motionPlansCollide(candidate.motion, other.motion, options.headwayGapRatio, options.now)
      ) {
        return false;
      }
    }
    const placed = { ...candidate, laneIndex, slotCount, y };
    placements.push(placed);
    for (let offset = 0; offset < slotCount; offset++) {
      const lane = laneIndex + offset;
      let entries = occupants.get(lane);
      if (!entries) {
        entries = [];
        occupants.set(lane, entries);
      }
      entries.push(placed);
    }
    return true;
  };
  const placeGroup = (group: readonly ReflowCandidate<T>[]) => {
    const displaced: ReflowCandidate<T>[] = [];
    for (const candidate of group) {
      const slotCount = getRowSlotCount(candidate.height, options.laneHeight, options.laneSpacing);
      if (slotCount > options.laneCount) {
        dropped.push({ message: candidate.message, reason: 'oversized' });
      } else if (!tryLane(candidate, preferredLane(candidate, slotCount), slotCount)) {
        displaced.push(candidate);
      }
    }
    for (const candidate of displaced) {
      const slotCount = getRowSlotCount(candidate.height, options.laneHeight, options.laneSpacing);
      const maxLane = options.laneCount - slotCount;
      let placed = false;
      if (Number.isFinite(candidate.preferredY)) {
        const anchor = preferredLane(candidate, slotCount);
        const targetY = candidate.preferredY ?? 0;
        const baseY =
          options.viewportHeight * options.safeTop +
          getRowContentOffset(candidate.height, options.laneHeight, options.laneSpacing);
        for (let distance = 0; distance <= maxLane && !placed; distance++) {
          const lower = anchor - distance;
          const upper = anchor + distance;
          const upperFirst =
            upper <= maxLane &&
            (lower < 0 ||
              Math.abs(baseY + upper * options.laneHeight - targetY) <
                Math.abs(baseY + lower * options.laneHeight - targetY));
          const first = upperFirst ? upper : lower;
          const second = upperFirst ? lower : upper;
          if (first >= 0 && first <= maxLane) placed = tryLane(candidate, first, slotCount);
          if (!placed && second !== first && second >= 0 && second <= maxLane) {
            placed = tryLane(candidate, second, slotCount);
          }
        }
      } else {
        // Legacy candidates without a physical anchor keep the mode-specific
        // scan order. Every legal block remains checked before a capacity drop.
        for (let offset = 0; offset <= maxLane; offset++) {
          const lane = options.mode === 'bottom' ? maxLane - offset : offset;
          if (tryLane(candidate, lane, slotCount)) {
            placed = true;
            break;
          }
        }
      }
      if (!placed) dropped.push({ message: candidate.message, reason: 'reflow_capacity' });
    }
  };
  // Give already on-screen messages their legal lanes and alternatives before
  // reserving space for entries outside the viewport. Each group stays ordered.
  const visible = candidates.filter(
    ({ motion }) => motion.viewportEntryTime <= options.now && motion.visibleExitTime > options.now
  );
  const notVisible = candidates.filter(
    ({ motion }) => motion.viewportEntryTime > options.now || motion.visibleExitTime <= options.now
  );
  placeGroup(visible);
  placeGroup(notVisible);
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
