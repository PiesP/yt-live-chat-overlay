// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type {
  AuthorRateLimitPreset,
  AuthorType,
  BacklogMode,
  DanmakuMode,
  FontWeight,
  LanguageSetting,
  LogLevel,
  OutlineSettings,
  OverlaySettings,
  TranslationMode,
  TranslationService,
  TranslationSource,
  TranslationTarget,
} from '@app-types';
import { DEFAULT_FONT_FAMILY, colors as designColors, rendererLayout } from '@core/design-tokens';

export const isLogLevel = (value: unknown): value is LogLevel =>
  LOG_LEVEL_VALUES.includes(value as LogLevel);

type RootScalarSettingKey = Exclude<keyof OverlaySettings, 'showAuthor' | 'colors' | 'outline'>;
type OutlineSettingKey = keyof OutlineSettings;

export type { OutlineSettingKey, RootNumericSettingKey, RootScalarSettingKey };

const VALID_BACKLOG_MODES = [
  'playback',
  'recent',
  'full',
  'none',
] as const satisfies readonly BacklogMode[];
const VALID_DANMAKU_MODES = [
  'scroll',
  'reverse',
  'top',
  'bottom',
] as const satisfies readonly DanmakuMode[];

const AUTHOR_RATE_LIMIT_VALUES = [
  'off',
  'normal',
  'strict',
] as const satisfies readonly AuthorRateLimitPreset[];
const LANGUAGE_VALUES = [
  'auto',
  'en',
  'ko',
  'ja',
  'es',
  'zh',
] as const satisfies readonly LanguageSetting[];
const TRANSLATION_SERVICE_VALUES = ['auto', 'off'] as const satisfies readonly TranslationService[];
const TRANSLATION_TARGET_VALUES = [
  'auto',
  'en',
  'ko',
  'ja',
  'es',
  'zh',
] as const satisfies readonly TranslationTarget[];
const TRANSLATION_SOURCE_VALUES = [
  'auto',
  'en',
  'ko',
  'ja',
  'es',
  'zh',
] as const satisfies readonly TranslationSource[];
const TRANSLATION_MODE_VALUES = ['dual', 'replace'] as const satisfies readonly TranslationMode[];
const FONT_WEIGHT_VALUES = ['normal', 'bold'] as const satisfies readonly FontWeight[];
const LOG_LEVEL_VALUES = ['warn', 'info', 'debug'] as const satisfies readonly LogLevel[];

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

type RootNumericSettingKey = Exclude<
  RootScalarSettingKey,
  'enabled' | 'allowShortTextMessages' | 'logLevel' | 'showDebugOverlay' | 'authorRateLimit'
>;

/** Root setting metadata: defines type, category, and visual-change flag.
 *  Drives the normalizeSettings() loop — single source of truth for type routing. */
type SettingMeta = {
  type: 'boolean' | 'number' | 'string';
  visual: boolean;
  /** Display scale factor for UI (e.g. 100 for percentages, 1 for raw values). Only meaningful for 'number'. */
  displayScale?: number;
  /** Number of fractional digits to show in UI and control rounding behavior.
   *  When 0, integer rounding is applied to the display value before scaling.
   *  When > 0, fractional input is preserved (and formatted with toFixed). */
  displayPrecision?: number;
};
const ROOT_SETTING_META = {
  enabled: { type: 'boolean', visual: false },
  enableWebGL2: { type: 'boolean', visual: true },
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

const OUTLINE_SETTING_KEYS = [
  'enabled',
  'widthPx',
  'opacity',
] as const satisfies readonly OutlineSettingKey[];

export const OUTLINE_NUMERIC_KEYS = ['widthPx', 'opacity'] as const satisfies ReadonlyArray<
  Exclude<OutlineSettingKey, 'enabled'>
>;

// ── Limits ──────────────────────────────────────────────────────────────────────

type NumericSettingLimit = Readonly<{ min: number; max: number; step: number }>;

type SettingsLimitKey =
  | 'speedPxPerSec'
  | 'fontSize'
  | 'opacity'
  | 'superChatOpacity'
  | 'safeTop'
  | 'safeBottom'
  | 'maxConcurrentMessages'
  | 'minTextLength'
  | 'outlineWidthPx'
  | 'outlineOpacity'
  | 'laneSpacing'
  | 'backlogMaxRate'
  | 'backlogSpeedMultiplier'
  | 'backlogRecentMinutes'
  | 'backlogOpacityMultiplier'
  | 'depthNearSpeedMul'
  | 'depthFarSpeedMul'
  | 'depthFarOpacityMul'
  | 'superChatMaxBodyLines'
  | 'membershipMaxBodyLines'
  | 'fadeDurationMs'
  | 'minPollIntervalMs'
  | 'maxPollIntervalMs'
  | 'modOwnerDurationMultiplier'
  | 'exitPaddingPx'
  | 'scrollDurationMinMs'
  | 'scrollDurationMaxMs'
  | 'topBottomDurationMs'
  | 'queueMaxSize'
  | 'backgroundQueueMax'
  | 'maxMessageAgeMs'
  | 'headwayGapRatio'
  | 'emojiCacheMb'
  | 'photoCacheMb'
  | 'stickerCacheMb'
  | 'textCacheMb'
  | 'translationBatchSize'
  | 'emojiFetchLimit'
  | 'failedEmojiRetryMins'
  | 'burstSampleWindow'
  | 'burstElevatedThreshold'
  | 'burstHighThreshold'
  | 'burstExtremeThreshold'
  | 'backlogInjectionMax'
  | 'backlogDensityRampMs'
  | 'livePollFallbackMs'
  | 'livePollFailureLimit'
  | 'speedBoostThreshold'
  | 'backlogPauseThreshold'
  | 'backlogResumeThreshold'
  | 'activityTimeoutMs'
  | 'staggerMaxDelayMs'
  | 'staggerMediumDelayMs'
  | 'emojiFetchTimeoutMs'
  | 'backlogDensityRampMaxMs'
  | 'backlogInjectionRateMin'
  | 'speedBoostMax'
  | 'speedBoostDenom'
  | 'backlogToggleCooldownMs'
  | 'replayPrefetchPages'
  | 'replayBatchLimit';

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
  superChatMaxBodyLines: { min: 2, max: 10, step: 1 },
  membershipMaxBodyLines: { min: 1, max: 5, step: 1 },
  fadeDurationMs: { min: 0, max: 1000, step: 50 }, // 0 = no fade, up to 1s
  minPollIntervalMs: { min: 50, max: 5000, step: 50 }, // 50ms minimum polling
  maxPollIntervalMs: { min: 1000, max: 30000, step: 1000 }, // 1s to 30s maximum
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
} as const satisfies Record<SettingsLimitKey, NumericSettingLimit>;

export const STORAGE_KEY = 'yt-live-chat-overlay-settings';
export const SETTINGS_VERSION = 1;

/** Version-aware migration. Stamps version if absent; preserves existing version for chained migration support. */
export const migrateSettings = (raw: Record<string, unknown>): Record<string, unknown> => {
  const version = (raw._version as number) ?? 0;
  return { ...raw, _version: Math.max(version, 1) };
};

// ── Defaults ────────────────────────────────────────────────────────────────────

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
  enableWebGL2: false,
  danmakuMode: 'scroll',
  speedPxPerSec: 250,
  fontSize: 32,
  opacity: 1,
  superChatOpacity: 0.75,
  safeTop: 0,
  safeBottom: 0.12,
  maxConcurrentMessages: 300,
  allowShortTextMessages: false,
  minTextLength: 3,
  logLevel: 'warn',
  showAuthor: DEFAULT_SHOW_AUTHOR,
  colors: DEFAULT_COLORS,
  outline: DEFAULT_OUTLINE,
  laneSpacing: 0,
  showDebugOverlay: false,
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

// ── Color validation ────────────────────────────────────────────────────────────

/**
 * Matches hex color strings: #RGB, #RRGGBB, #RGBA, #RRGGBBAA.
 */
export const isColorValue = (value: unknown): value is string =>
  typeof value === 'string' && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6,8})$/i.test(value);

export const clampNumber = (
  value: unknown,
  fallback: number,
  limits: Readonly<{ min: number; max: number }>
): number => {
  const numericValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, numericValue));
};

export const cloneSettings = (settings: Readonly<OverlaySettings>): OverlaySettings => ({
  ...settings,
  showAuthor: { ...settings.showAuthor },
  colors: { ...settings.colors },
  outline: { ...settings.outline },
});

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

export const resolveLimits = (key: string): NumericSettingLimit => {
  const direct = SETTINGS_LIMITS[key as keyof typeof SETTINGS_LIMITS];
  if (direct) return direct;
  // Outline keys use separate limit entries to avoid clashing with root keys
  const outlineKey = OUTLINE_LIMIT_KEYS[key];
  if (outlineKey) return SETTINGS_LIMITS[outlineKey];
  throw new Error(`Unknown setting key: ${key}`);
};

/** Resolve limits for an outline sub-key, checking OUTLINE_LIMIT_KEYS first
 *  to avoid collisions with same-named root keys (e.g. 'opacity'). */
export const resolveOutlineLimits = (key: string): NumericSettingLimit => {
  const outlineKey = OUTLINE_LIMIT_KEYS[key];
  if (outlineKey) return SETTINGS_LIMITS[outlineKey];
  throw new Error(`Unknown outline setting key: ${key}`);
};

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

// ── Normalization ───────────────────────────────────────────────────────────────

const STRING_VALIDATORS: Partial<Record<RootScalarSettingKey, (v: string) => boolean>> = {
  backlogMode: (v) => VALID_BACKLOG_MODES.includes(v as (typeof VALID_BACKLOG_MODES)[number]),
  danmakuMode: (v) => VALID_DANMAKU_MODES.includes(v as (typeof VALID_DANMAKU_MODES)[number]),
  logLevel: (v) => isLogLevel(v),
  fontWeight: (v) => FONT_WEIGHT_VALUES.includes(v as FontWeight),
  fontFamily: (_v) => true,
  authorRateLimit: (v) => AUTHOR_RATE_LIMIT_VALUES.includes(v as AuthorRateLimitPreset),
  language: (v) => LANGUAGE_VALUES.includes(v as LanguageSetting),
  translationService: (v) => TRANSLATION_SERVICE_VALUES.includes(v as TranslationService),
  translationTarget: (v) => TRANSLATION_TARGET_VALUES.includes(v as TranslationTarget),
  translationMode: (v) => TRANSLATION_MODE_VALUES.includes(v as TranslationMode),
  translationSource: (v) => TRANSLATION_SOURCE_VALUES.includes(v as TranslationSource),
};

const normalizeSettings = (settings: Readonly<OverlaySettings>): OverlaySettings => {
  const d = DEFAULT_SETTINGS;
  // Start from defaults, then overlay valid values from the input
  const out = cloneSettings(DEFAULT_SETTINGS);

  const pickBool = (v: unknown, fallback: boolean): boolean =>
    typeof v === 'boolean' ? v : fallback;

  // Root scalar settings: type-routed via ROOT_SETTING_META.
  // Write into a mutable copy since OverlaySettings has no index signature.
  const cast = out as unknown as Record<string, unknown>;
  const defaults = d as unknown as Record<string, unknown>;
  for (const key of Object.keys(ROOT_SETTING_META) as RootScalarSettingKey[]) {
    const meta = ROOT_SETTING_META[key];
    const raw = settings[key];
    if (meta.type === 'boolean') {
      cast[key] = typeof raw === 'boolean' ? raw : defaults[key];
    } else if (meta.type === 'number') {
      cast[key] = clampNumber(raw, defaults[key] as number, resolveLimits(key));
    } else {
      const validator = STRING_VALIDATORS[key];
      cast[key] = typeof raw === 'string' && validator?.(raw) ? raw : defaults[key];
    }
  }

  for (const key of SHOW_AUTHOR_KEYS) {
    out.showAuthor[key] = pickBool(settings.showAuthor[key], d.showAuthor[key]);
  }

  for (const key of AUTHOR_COLOR_KEYS) {
    out.colors[key] = isColorValue(settings.colors[key]) ? settings.colors[key] : d.colors[key];
  }

  out.outline.enabled = pickBool(settings.outline.enabled, d.outline.enabled);
  for (const key of OUTLINE_NUMERIC_KEYS) {
    out.outline[key] = clampNumber(settings.outline[key], d.outline[key], resolveLimits(key));
  }

  return out;
};

export const applySettingsPatch = (
  base: Readonly<OverlaySettings>,
  partial: Partial<OverlaySettings>
): OverlaySettings => {
  const merged: OverlaySettings = {
    ...base,
    ...partial,
    showAuthor: { ...base.showAuthor, ...partial.showAuthor },
    colors: { ...base.colors, ...partial.colors },
    outline: { ...base.outline, ...partial.outline },
  };
  return normalizeSettings(merged);
};

export const normalizeStoredSettings = (
  stored: Record<string, unknown> | null | undefined
): OverlaySettings => {
  if (!stored) return cloneSettings(DEFAULT_SETTINGS);
  const migrated = migrateSettings(stored);
  return applySettingsPatch(cloneSettings(DEFAULT_SETTINGS), migrated as Partial<OverlaySettings>);
};

export const shouldResetRendererForSettingsChange = (
  previous: Readonly<OverlaySettings>,
  next: Readonly<OverlaySettings>
): boolean => {
  if (VISUAL_ROOT_KEYS.some((key) => previous[key] !== next[key])) return true;
  if (SHOW_AUTHOR_KEYS.some((key) => previous.showAuthor[key] !== next.showAuthor[key]))
    return true;
  if (AUTHOR_COLOR_KEYS.some((key) => previous.colors[key] !== next.colors[key])) return true;
  return OUTLINE_SETTING_KEYS.some((key) => previous.outline[key] !== next.outline[key]);
};
