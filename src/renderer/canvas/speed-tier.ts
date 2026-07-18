// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Pure functions for speed-tier classification and headway computation.
 *
 * Extracted from CanvasRenderer to enable deterministic unit testing
 * without DOM, canvas, or class-instantiation dependencies.
 */

import type { ChatMessage } from '@app-types';
import { hashStringForTier, SPEED_TIER, TIER_NEAR_THRESHOLD } from '@renderer/constants';

// ── Speed tier classification ─────────────────────────────────────────────

export interface SpeedTierConfig {
  depthLayersEnabled: boolean;
  danmakuMode: string;
}

/**
 * Compute the speed tier for a message based on settings and message properties.
 * Speed tiers: 0=Far, 1=Mid, 2=Near, 3=Backlog.
 *
 * @param message — The chat message to classify
 * @param config  — Subset of OverlaySettings relevant to tier determination
 * @returns SPEED_TIER value (0-3)
 */
export function getSpeedTier(message: ChatMessage, config: SpeedTierConfig): number {
  if (message.isBacklog) return SPEED_TIER.BACKLOG;
  if (!config.depthLayersEnabled) return SPEED_TIER.MID;
  const mode = config.danmakuMode;
  if (mode !== 'scroll' && mode !== 'reverse') return SPEED_TIER.MID;
  // SuperChat/Membership → Near tier
  if (message.kind === 'superchat' || message.kind === 'membership') return SPEED_TIER.NEAR;
  // Regular messages: deterministic assignment via message id hash
  const hash = hashStringForTier(message.id ?? String(message.timestamp));
  return hash < TIER_NEAR_THRESHOLD ? SPEED_TIER.NEAR : SPEED_TIER.FAR;
}

// ── Headway computation ────────────────────────────────────────────────────

/**
 * Compute headway (minimum gap) in pixels between an active message
 * and a new message attempting to enter the same lane.
 *
 * @param activeWidth          — Width (px) of the active message already in the lane
 * @param activeSpeedTier      — Speed tier of the active message
 * @param newSpeedTier         — Speed tier of the new message
 * @param headwayGapRatio       — Gap ratio from settings (0-1)
 * @param backlogSpeedMultiplier — Multiplier applied when active message is in BACKLOG tier
 * @returns Minimum headway in whole pixels
 */
export function computeHeadwayPx(
  activeWidth: number,
  activeSpeedTier: number,
  newSpeedTier: number,
  headwayGapRatio: number,
  backlogSpeedMultiplier: number
): number {
  const base = Math.round(activeWidth * headwayGapRatio);
  if (activeSpeedTier === SPEED_TIER.BACKLOG && newSpeedTier > activeSpeedTier) {
    return Math.round(base * backlogSpeedMultiplier);
  }
  return base;
}
