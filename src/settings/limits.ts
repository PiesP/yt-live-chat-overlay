// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { OutlineSettings, OverlaySettings } from '@app-types';

type OutlineSettingKey = keyof OutlineSettings;

export type { OutlineSettingKey };

type RootNumericSettingKey = Exclude<
  keyof OverlaySettings,
  | 'enabled'
  | 'allowShortTextMessages'
  | 'logLevel'
  | 'showDebugOverlay'
  | 'authorRateLimit'
  | 'showAuthor'
  | 'colors'
  | 'outline'
>;

export type { RootNumericSettingKey };

type NumericSettingLimit = Readonly<{ min: number; max: number; step: number }>;

const SETTINGS_LIMITS = {
  speedPxPerSec: { min: 50, max: 500, step: 10 },
  fontSize: { min: 14, max: 50, step: 2 },
  opacity: { min: 0.5, max: 1, step: 0.05 },
  superChatOpacity: { min: 0.35, max: 1, step: 0.05 },
  safeTop: { min: 0, max: 0.25, step: 0.01 },
  safeBottom: { min: 0, max: 0.5, step: 0.01 },
  maxConcurrentMessages: { min: 30, max: 300, step: 10 },
  minTextLength: { min: 1, max: 10, step: 1 },
  outlineWidthPx: { min: 0, max: 8, step: 0.5 },
  outlineOpacity: { min: 0, max: 1, step: 0.1 },
  laneSpacing: { min: 0, max: 20, step: 1 },
  backlogMaxRate: { min: 0, max: 50, step: 5 },
  backlogSpeedMultiplier: { min: 1, max: 5, step: 0.5 },
  backlogRecentMinutes: { min: 1, max: 30, step: 1 },
  backlogOpacityMultiplier: { min: 0.1, max: 1, step: 0.05 },
  depthNearSpeedMul: { min: 1, max: 2, step: 0.1 },
  depthFarSpeedMul: { min: 0.3, max: 1, step: 0.1 },
  depthFarOpacityMul: { min: 0.4, max: 1, step: 0.05 },
  motionBlurAlpha: { min: 0.01, max: 0.05, step: 0.01 },
  superChatMaxBodyLines: { min: 2, max: 10, step: 1 },
  membershipMaxBodyLines: { min: 1, max: 5, step: 1 },
  fadeDurationMs: { min: 0, max: 1000, step: 50 },
  minPollIntervalMs: { min: 50, max: 5000, step: 50 },
  maxPollIntervalMs: { min: 1000, max: 30000, step: 1000 },
  modOwnerDurationMultiplier: { min: 1, max: 3, step: 0.1 },
  exitPaddingPx: { min: 20, max: 400, step: 10 },
  scrollDurationMinMs: { min: 1000, max: 15000, step: 500 },
  scrollDurationMaxMs: { min: 5000, max: 120000, step: 5000 },
  topBottomDurationMs: { min: 1000, max: 30000, step: 500 },
  queueMaxSize: { min: 50, max: 1000, step: 10 },
  backgroundQueueMax: { min: 10, max: 500, step: 10 },
  maxMessageAgeMs: { min: 10000, max: 300000, step: 10000 },
  headwayGapRatio: { min: 0.02, max: 0.3, step: 0.01 },
  emojiCacheMb: { min: 1, max: 20, step: 1 },
  photoCacheMb: { min: 1, max: 20, step: 1 },
  stickerCacheMb: { min: 1, max: 20, step: 1 },
  textCacheMb: { min: 1, max: 20, step: 1 },
  translationBatchSize: { min: 1, max: 20, step: 1 },
  emojiFetchLimit: { min: 1, max: 20, step: 1 },
  failedEmojiRetryMins: { min: 1, max: 60, step: 1 },
  burstSampleWindow: { min: 3, max: 60, step: 1 },
  burstElevatedThreshold: { min: 2, max: 50, step: 1 },
  burstHighThreshold: { min: 5, max: 100, step: 5 },
  burstExtremeThreshold: { min: 10, max: 200, step: 5 },
  backlogInjectionMax: { min: 5, max: 100, step: 5 },
  backlogDensityRampMs: { min: 500, max: 10000, step: 500 },
  livePollFallbackMs: { min: 500, max: 30000, step: 500 },
  livePollFailureLimit: { min: 3, max: 50, step: 1 },
  speedBoostThreshold: { min: 2, max: 50, step: 1 },
  backlogPauseThreshold: { min: 0.3, max: 1, step: 0.05 },
  backlogResumeThreshold: { min: 0.1, max: 1, step: 0.05 },
  activityTimeoutMs: { min: 5000, max: 120000, step: 5000 },
  staggerMaxDelayMs: { min: 20, max: 1000, step: 20 },
  staggerMediumDelayMs: { min: 10, max: 500, step: 10 },
  emojiFetchTimeoutMs: { min: 5000, max: 120000, step: 5000 },
  backlogDensityRampMaxMs: { min: 500, max: 15000, step: 500 },
  backlogInjectionRateMin: { min: 1, max: 50, step: 1 },
  speedBoostMax: { min: 0.05, max: 1, step: 0.05 },
  speedBoostDenom: { min: 2, max: 100, step: 1 },
  backlogToggleCooldownMs: { min: 500, max: 30000, step: 500 },
  replayPrefetchPages: { min: 50, max: 1000, step: 50 },
  replayBatchLimit: { min: 3, max: 100, step: 1 },
} as const;

export const OUTLINE_NUMERIC_KEYS = ['widthPx', 'opacity'] as const satisfies ReadonlyArray<
  Exclude<OutlineSettingKey, 'enabled'>
>;

/** Maps outline sub-keys to their SETTINGS_LIMITS entries. */
const OUTLINE_LIMIT_KEYS: Record<string, keyof typeof SETTINGS_LIMITS> = {
  widthPx: 'outlineWidthPx',
  opacity: 'outlineOpacity',
} as const;

/** Display scale for outline numeric keys — consistent with root opacity settings (displayScale: 100).
 *  widthPx is already in pixels (no scaling), opacity is 0–1 internally, displayed as 0–100%. */
const OUTLINE_DISPLAY_SCALE: Record<string, number> = {
  widthPx: 1,
  opacity: 100,
} as const;

export const getOutlineDisplayScale = (key: string): number => OUTLINE_DISPLAY_SCALE[key] ?? 1;

export function resolveLimits(key: string): NumericSettingLimit {
  const direct = SETTINGS_LIMITS[key as keyof typeof SETTINGS_LIMITS];
  if (direct) return direct;
  // Outline keys use separate limit entries to avoid clashing with root keys
  const outlineKey = OUTLINE_LIMIT_KEYS[key];
  if (outlineKey) return SETTINGS_LIMITS[outlineKey];
  throw new Error(`Unknown setting key: ${key}`);
}

/** Resolve limits for an outline sub-key, checking OUTLINE_LIMIT_KEYS first
 *  to avoid collisions with same-named root keys (e.g. 'opacity'). */
export function resolveOutlineLimits(key: string): NumericSettingLimit {
  const outlineKey = OUTLINE_LIMIT_KEYS[key];
  if (outlineKey) return SETTINGS_LIMITS[outlineKey];
  throw new Error(`Unknown outline setting key: ${key}`);
}
