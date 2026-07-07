// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { OutlineSettings, OverlaySettings } from '@app-types';
import { DEFAULT_FONT_FAMILY, colors as designColors, rendererLayout } from '@core/design-tokens';

const DEFAULT_SHOW_AUTHOR = {
  normal: false,
  member: false,
  moderator: true,
  owner: true,
  verified: false,
  superChat: true,
} as const satisfies OverlaySettings['showAuthor'];

const DEFAULT_COLORS = {
  normal: designColors.authorNormal,
  member: designColors.authorMember,
  moderator: designColors.authorModerator,
  owner: designColors.authorOwner,
  verified: designColors.authorVerified,
} as const satisfies OverlaySettings['colors'];

const DEFAULT_OUTLINE = {
  enabled: true,
  widthPx: 2,
  opacity: 0.7,
} as const satisfies OutlineSettings;

export const DEFAULT_SETTINGS = {
  enabled: true,
  danmakuMode: 'scroll',
  speedPxPerSec: 250,
  fontSize: 32,
  opacity: 1,
  superChatOpacity: 0.75,
  safeTop: 0,
  safeBottom: 0.12,
  maxConcurrentMessages: 300,
  allowShortTextMessages: false,
  minTextLength: 1,
  logLevel: 'warn',
  showAuthor: DEFAULT_SHOW_AUTHOR,
  colors: DEFAULT_COLORS,
  outline: DEFAULT_OUTLINE,
  laneSpacing: 0,
  showDebugOverlay: false,
  ignoreReducedMotion: false,
  authorRateLimit: 'normal',
  backlogMaxRate: 20,
  backlogSpeedMultiplier: 2,
  backlogMode: 'playback',
  backlogRecentMinutes: 1,
  backlogOpacityMultiplier: 0.75,
  depthLayersEnabled: true,
  depthNearSpeedMul: 1.4,
  depthFarSpeedMul: 0.8,
  depthFarOpacityMul: 0.75,
  modOwnerDurationMultiplier: 1.5,
  showSuperChatAmount: true,
  fontWeight: 'bold',
  fontFamily: DEFAULT_FONT_FAMILY,
  preserveUserColor: true,
  superChatMaxBodyLines: 5,
  membershipMaxBodyLines: 3,
  fadeDurationMs: 500,
  minPollIntervalMs: 50,
  maxPollIntervalMs: 2000,
  language: 'auto',
  translationEnabled: false,
  translationService: 'auto',
  translationSource: 'auto',
  translationTarget: 'auto',
  translationMode: 'dual',
  exitPaddingPx: 100,
  scrollDurationMinMs: 5000,
  scrollDurationMaxMs: 30000,
  topBottomDurationMs: 4000,
  queueMaxSize: 200,
  backgroundQueueMax: 50,
  maxMessageAgeMs: 60000,
  headwayGapRatio: rendererLayout.headwayGapRatio,
  emojiCacheMb: 3,
  photoCacheMb: 2,
  stickerCacheMb: 1,
  textCacheMb: 4,
  translationBatchSize: 5,
  emojiFetchLimit: 6,
  failedEmojiRetryMins: 5,
  burstSampleWindow: 10,
  burstElevatedThreshold: 5,
  burstHighThreshold: 15,
  burstExtremeThreshold: 30,
  backlogInjectionMax: 20,
  backlogDensityRampMs: 2500,
  livePollFallbackMs: 1500,
  livePollFailureLimit: 10,
  speedBoostThreshold: 5,
  backlogPauseThreshold: 0.8,
  backlogResumeThreshold: 0.4,
  activityTimeoutMs: 30000,

  // ── Stagger / Tuning ──
  staggerMaxDelayMs: 200,
  staggerMediumDelayMs: 80,
  emojiFetchTimeoutMs: 30000,
  backlogDensityRampMaxMs: 4000,
  backlogInjectionRateMin: 4,
  speedBoostMax: 0.05,
  speedBoostDenom: 15,
  backlogToggleCooldownMs: 2000,
  replayPrefetchPages: 200,
  replayBatchLimit: 12,
} as const satisfies Readonly<OverlaySettings>;

export const STORAGE_KEY = 'yt-live-chat-overlay-settings';

// ── Settings migration chain ───────────────────────────────────────────────

type MigrationFn = (settings: Record<string, unknown>) => Record<string, unknown>;

/**
 * Ordered migration map: version N → N+1.
 * Each function receives a shallow-cloned settings object for the source version
 * and must return a settings object at version N+1 with `_version` set.
 *
 * To add a new migration (e.g. v1 → v2):
 *   1. Add a new entry: `1: (s) => ({ ...s, newField: defaultValue, _version: 2 })`
 *   2. Bump SETTINGS_VERSION to match the new target version.
 */
const MIGRATIONS: Readonly<Record<number, MigrationFn>> = {
  // v0 → v1: initial version stamp (no schema changes)
  0: (s: Record<string, unknown>): Record<string, unknown> => ({ ...s, _version: 1 }),
};

/** Current settings schema version. Must match the highest key in MIGRATIONS + 1. */
export const SETTINGS_VERSION = 1;

/**
 * Apply all pending migrations to raw stored settings.
 * Chains through MIGRATIONS from the stored version up to SETTINGS_VERSION.
 * Each step receives the output of the previous step.
 */
export function migrateSettings(raw: Record<string, unknown>): Record<string, unknown> {
  let version = (raw._version as number) ?? 0;

  // Copy so we don't mutate the argument
  let migrated: Record<string, unknown> = { ...raw };

  while (version < SETTINGS_VERSION) {
    const fn = MIGRATIONS[version];
    if (!fn) {
      // Gap in migration chain — stamp version and stop
      migrated = { ...migrated, _version: SETTINGS_VERSION };
      break;
    }
    migrated = fn(migrated);
    version = migrated._version as number;
  }

  return migrated;
}
