// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatHealthSnapshot } from '@chat/source-base';

const LONG_IDLE_RESTART_MS = 60_000;
const ABSOLUTE_MAX_IDLE_RESTART_MS = 30 * 60 * 1000;
const DIMENSIONS_NULL_GRACE_MS = 5_000;
const RESTART_BACKOFF_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;

export const MAX_WATCHDOG_RESTARTS = RESTART_BACKOFF_DELAYS_MS.length;
export const RESTART_WINDOW_MS = 5 * 60 * 1000;

export type HealthFailureReason =
  | 'chat-source-stopped'
  | 'chat-source-stale'
  | 'overlay-not-renderable'
  | 'very-long-idle';

export interface RuntimeHealthPolicyInput {
  idleDurationMs: number;
  renderable: boolean;
  chat: ChatHealthSnapshot | null;
  runtimeActive: boolean;
  videoPaused: boolean;
  chatInBackoff: boolean;
  dimensionsNullSince: number | null;
  now: number;
}

export function classifyRuntimeHealthFailure(
  input: RuntimeHealthPolicyInput
): HealthFailureReason | null {
  const {
    idleDurationMs,
    renderable,
    chat,
    runtimeActive,
    videoPaused,
    chatInBackoff,
    dimensionsNullSince,
    now,
  } = input;

  let reason: HealthFailureReason | null = null;
  if (idleDurationMs >= ABSOLUTE_MAX_IDLE_RESTART_MS) {
    reason = 'very-long-idle';
  } else if (!videoPaused && !chatInBackoff) {
    if (!renderable) {
      reason = 'overlay-not-renderable';
    } else if (idleDurationMs >= LONG_IDLE_RESTART_MS) {
      reason = 'chat-source-stale';
    } else if (runtimeActive && chat && (!chat.observerAlive || !chat.recentlyActive)) {
      reason = chat.observerAlive ? 'chat-source-stale' : 'chat-source-stopped';
    }
  }

  if (
    reason === 'overlay-not-renderable' &&
    dimensionsNullSince !== null &&
    now - dimensionsNullSince < DIMENSIONS_NULL_GRACE_MS
  ) {
    return null;
  }

  return reason;
}

export function getWatchdogRestartDelay(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_WATCHDOG_RESTARTS) {
    return null;
  }
  const index = Math.min(attempt - 1, RESTART_BACKOFF_DELAYS_MS.length - 1);
  return RESTART_BACKOFF_DELAYS_MS[index]!;
}
