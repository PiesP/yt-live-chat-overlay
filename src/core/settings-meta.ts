// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { AuthorType, OverlaySettings } from '@app-types';

/**
 * Root setting metadata: defines type, category, and visual-change flag.
 * Drives the normalizeSettings() loop — single source of truth for type routing.
 *
 * INTENTIONAL DUPLICATION: This map enumerates every root OverlaySettings key
 * with UI metadata (type, visual flag, displayScale, displayPrecision). While
 * the field *names* overlap with OverlaySettings, this object is the SSOT for
 * the rendering/UI layer — it controls:
 *   - Which settings trigger a full renderer reset (visual: true)
 *   - How numeric values map between internal range and user-facing display
 *     (e.g. opacity 0.5-1.0 internally → 50-100% in the UI)
 *   - Whether integer rounding is applied before or after display scaling
 *
 * Deriving this from OverlaySettings alone is not feasible because TypeScript
 * types carry no runtime metadata about display semantics. A Proxy or decorator
 * approach would add runtime complexity for negligible ergonomic gain. The
 * `satisfies Record<RootScalarSettingKey, SettingMeta>` constraint at the bottom
 * guarantees exhaustiveness at compile time — adding a new setting without an
 * entry here is a type error.
 */
export type SettingMeta = {
  type: 'boolean' | 'number' | 'string';
  visual: boolean;
  /** Display scale factor for UI (e.g. 100 for percentages, 1 for raw values). Only meaningful for 'number'. */
  displayScale?: number;
  /** Number of fractional digits to show in UI and control rounding behavior.
   *  When 0, integer rounding is applied to the display value before scaling.
   *  When > 0, fractional input is preserved (and formatted with toFixed). */
  displayPrecision?: number;
};

type RootScalarSettingKey = Exclude<keyof OverlaySettings, 'showAuthor' | 'colors' | 'outline'>;

export type { RootScalarSettingKey };

export const AUTHOR_COLOR_KEYS = [
  'normal',
  'member',
  'moderator',
  'owner',
  'verified',
] as const satisfies readonly AuthorType[];

const SHOW_AUTHOR_KEYS = [...AUTHOR_COLOR_KEYS, 'superChat'] as const satisfies ReadonlyArray<
  keyof OverlaySettings['showAuthor']
>;

const ROOT_SETTING_META = {
  enabled: { type: 'boolean', visual: false },
  danmakuMode: { type: 'string', visual: false },
  speedPxPerSec: { type: 'number', visual: true },
  fontSize: { type: 'number', visual: true },
  opacity: { type: 'number', visual: true, displayScale: 100, displayPrecision: 0 },
  superChatOpacity: { type: 'number', visual: true, displayScale: 100, displayPrecision: 0 },
  safeTop: { type: 'number', visual: true, displayScale: 100, displayPrecision: 1 },
  safeBottom: { type: 'number', visual: true, displayScale: 100, displayPrecision: 1 },
  maxConcurrentMessages: { type: 'number', visual: true },
  allowShortTextMessages: { type: 'boolean', visual: true },
  minTextLength: { type: 'number', visual: true },
  logLevel: { type: 'string', visual: false },
  laneSpacing: { type: 'number', visual: true },
  showDebugOverlay: { type: 'boolean', visual: false },
  ignoreReducedMotion: { type: 'boolean', visual: false },
  authorRateLimit: { type: 'string', visual: false },
  backlogMaxRate: { type: 'number', visual: false },
  backlogSpeedMultiplier: { type: 'number', visual: false, displayScale: 1, displayPrecision: 1 },
  backlogMode: { type: 'string', visual: false },
  backlogRecentMinutes: { type: 'number', visual: false },
  backlogOpacityMultiplier: {
    type: 'number',
    visual: true,
    displayScale: 100,
    displayPrecision: 0,
  },
  depthLayersEnabled: { type: 'boolean', visual: true },
  depthNearSpeedMul: { type: 'number', visual: true, displayScale: 100, displayPrecision: 0 },
  depthFarSpeedMul: { type: 'number', visual: true, displayScale: 100, displayPrecision: 0 },
  depthFarOpacityMul: {
    type: 'number',
    visual: true,
    displayScale: 100,
    displayPrecision: 0,
  },
  fontWeight: { type: 'string', visual: true },
  fontFamily: { type: 'string', visual: true },
  preserveUserColor: { type: 'boolean', visual: true },
  superChatMaxBodyLines: { type: 'number', visual: true },
  membershipMaxBodyLines: { type: 'number', visual: true },
  fadeDurationMs: { type: 'number', visual: false },
  minPollIntervalMs: { type: 'number', visual: false },
  maxPollIntervalMs: { type: 'number', visual: false },
  language: { type: 'string', visual: false },
  modOwnerDurationMultiplier: {
    type: 'number',
    visual: false,
    displayScale: 1,
    displayPrecision: 1,
  },
  showSuperChatAmount: { type: 'boolean', visual: true },
  translationEnabled: { type: 'boolean', visual: false },
  translationService: { type: 'string', visual: false },
  translationSource: { type: 'string', visual: false },
  translationTarget: { type: 'string', visual: false },
  translationMode: { type: 'string', visual: true },
  exitPaddingPx: { type: 'number', visual: true },
  scrollDurationMinMs: { type: 'number', visual: false },
  scrollDurationMaxMs: { type: 'number', visual: false },
  topBottomDurationMs: { type: 'number', visual: true },
  queueMaxSize: { type: 'number', visual: false },
  backgroundQueueMax: { type: 'number', visual: false },
  maxMessageAgeMs: { type: 'number', visual: true },
  headwayGapRatio: { type: 'number', visual: true, displayScale: 100, displayPrecision: 1 },
  emojiCacheMb: { type: 'number', visual: false },
  photoCacheMb: { type: 'number', visual: false },
  stickerCacheMb: { type: 'number', visual: false },
  textCacheMb: { type: 'number', visual: false },
  translationBatchSize: { type: 'number', visual: false },
  emojiFetchLimit: { type: 'number', visual: false },
  failedEmojiRetryMins: { type: 'number', visual: false },
  burstSampleWindow: { type: 'number', visual: false },
  burstElevatedThreshold: { type: 'number', visual: false },
  burstHighThreshold: { type: 'number', visual: false },
  burstExtremeThreshold: { type: 'number', visual: false },
  backlogInjectionMax: { type: 'number', visual: false },
  backlogDensityRampMs: { type: 'number', visual: false },
  livePollFallbackMs: { type: 'number', visual: false },
  livePollFailureLimit: { type: 'number', visual: false },
  speedBoostThreshold: { type: 'number', visual: false },
  backlogPauseThreshold: { type: 'number', visual: false, displayScale: 100, displayPrecision: 0 },
  backlogResumeThreshold: { type: 'number', visual: false, displayScale: 100, displayPrecision: 0 },
  activityTimeoutMs: { type: 'number', visual: false },
  staggerMaxDelayMs: { type: 'number', visual: false },
  staggerMediumDelayMs: { type: 'number', visual: false },
  emojiFetchTimeoutMs: { type: 'number', visual: false },
  backlogDensityRampMaxMs: { type: 'number', visual: false },
  backlogInjectionRateMin: { type: 'number', visual: false },
  speedBoostMax: { type: 'number', visual: false },
  speedBoostDenom: { type: 'number', visual: false },
  backlogToggleCooldownMs: { type: 'number', visual: false },
  replayPrefetchPages: { type: 'number', visual: false },
  replayBatchLimit: { type: 'number', visual: false },
} as const satisfies Record<RootScalarSettingKey, SettingMeta>;

/**
 * Visual root keys derived from ROOT_SETTING_META — single source of truth.
 * Changes to visual settings require a full renderer reset.
 */
const VISUAL_ROOT_KEYS = Object.entries(ROOT_SETTING_META)
  .filter(([, meta]) => meta.visual)
  .map(([key]) => key as RootScalarSettingKey);

export { ROOT_SETTING_META, SHOW_AUTHOR_KEYS, VISUAL_ROOT_KEYS };

/** Get display scale/precision from ROOT_SETTING_META for a root numeric key. */
export const getRootDisplayMeta = (
  key: RootScalarSettingKey
): {
  scale: number;
  precision: number;
} => {
  const meta: SettingMeta = ROOT_SETTING_META[key];
  if (meta?.displayScale !== undefined) {
    return { scale: meta.displayScale, precision: meta.displayPrecision ?? 0 };
  }
  return { scale: 1, precision: 0 };
};
