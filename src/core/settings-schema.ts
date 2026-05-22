import {
  type AuthorType,
  isLogLevel,
  type OutlineSettings,
  type OverlaySettings,
} from '@app-types';
import { colors as designColors } from '@core/design-tokens';

type RootScalarSettingKey = Exclude<keyof OverlaySettings, 'showAuthor' | 'colors' | 'outline'>;
type OutlineSettingKey = keyof OutlineSettings;

export type { OutlineSettingKey, RootNumericSettingKey, RootScalarSettingKey };

const VALID_BACKLOG_MODES = ['playback', 'recent', 'full', 'none'] as const;
const VALID_DANMAKU_MODES = ['scroll', 'reverse', 'top', 'bottom'] as const;

export const AUTHOR_COLOR_KEYS = [
  'normal',
  'member',
  'moderator',
  'owner',
  'verified',
] as const satisfies readonly AuthorType[];

export const SHOW_AUTHOR_KEYS = [
  ...AUTHOR_COLOR_KEYS,
  'superChat',
] as const satisfies ReadonlyArray<keyof OverlaySettings['showAuthor']>;

type RootNumericSettingKey = Exclude<
  RootScalarSettingKey,
  | 'enabled'
  | 'allowShortTextMessages'
  | 'logLevel'
  | 'showDebugOverlay'
  | 'authorRateLimitEnabled'
  | 'showBacklogIndicator'
>;

/** Root setting metadata: defines type, category, and visual-change flag.
 *  Drives the normalizeSettings() loop — single source of truth for type routing. */
type SettingMeta = {
  type: 'boolean' | 'number' | 'string';
  visual: boolean;
  /** Display scale factor for UI (e.g. 100 for percentages). Only meaningful for 'number'. */
  displayScale?: number;
  /** Number of fractional digits to show in UI. Only meaningful when displayScale > 1. */
  displayPrecision?: number;
};
const ROOT_SETTING_META = {
  enabled: { type: 'boolean', visual: false },
  danmakuMode: { type: 'string', visual: false },
  speedPxPerSec: { type: 'number', visual: true },
  fontSize: { type: 'number', visual: true },
  opacity: { type: 'number', visual: true },
  superChatOpacity: { type: 'number', visual: true, displayScale: 100, displayPrecision: 0 },
  safeTop: { type: 'number', visual: true, displayScale: 100, displayPrecision: 1 },
  safeBottom: { type: 'number', visual: true, displayScale: 100, displayPrecision: 1 },
  maxConcurrentMessages: { type: 'number', visual: true },
  allowShortTextMessages: { type: 'boolean', visual: true },
  minTextLength: { type: 'number', visual: true },
  logLevel: { type: 'string', visual: false },
  laneSpacing: { type: 'number', visual: true },
  showDebugOverlay: { type: 'boolean', visual: false },
  authorRateLimitEnabled: { type: 'boolean', visual: false },
  authorRateLimitWindowMs: { type: 'number', visual: false },
  authorRateLimitMaxMessages: { type: 'number', visual: false },
  backlogMaxRate: { type: 'number', visual: false },
  backlogSpeedMultiplier: { type: 'number', visual: false },
  showBacklogIndicator: { type: 'boolean', visual: false },
  backlogMode: { type: 'string', visual: false },
  backlogRecentMinutes: { type: 'number', visual: false },
  fontWeight: { type: 'string', visual: true },
  fontFamily: { type: 'string', visual: true },
  antiBlockEnabled: { type: 'boolean', visual: false },
  antiBlockFreeRatio: { type: 'number', visual: false },
  preserveUserColor: { type: 'boolean', visual: true },
  superChatMaxBodyLines: { type: 'number', visual: true },
  membershipMaxBodyLines: { type: 'number', visual: true },
  spreadEnabled: { type: 'boolean', visual: false },
  spreadFactor: { type: 'number', visual: false },
  fadeDurationMs: { type: 'number', visual: false },
  minPollIntervalMs: { type: 'number', visual: false },
  maxPollIntervalMs: { type: 'number', visual: false },
} as const satisfies Record<RootScalarSettingKey, SettingMeta>;

/**
 * Visual root keys derived from ROOT_SETTING_META — single source of truth.
 * Changes to visual settings require a full renderer reset.
 */
export const VISUAL_ROOT_KEYS = Object.entries(ROOT_SETTING_META)
  .filter(([, meta]) => meta.visual)
  .map(([key]) => key as RootScalarSettingKey);

export const OUTLINE_SETTING_KEYS = [
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
  | 'authorRateLimitWindowMs'
  | 'authorRateLimitMaxMessages'
  | 'backlogMaxRate'
  | 'backlogSpeedMultiplier'
  | 'backlogRecentMinutes'
  | 'antiBlockFreeRatio'
  | 'superChatMaxBodyLines'
  | 'membershipMaxBodyLines'
  | 'spreadFactor'
  | 'fadeDurationMs'
  | 'minPollIntervalMs'
  | 'maxPollIntervalMs';

export const SETTINGS_LIMITS = {
  speedPxPerSec: { min: 50, max: 500, step: 10 },
  fontSize: { min: 14, max: 50, step: 2 },
  opacity: { min: 0.5, max: 1, step: 0.05 },
  superChatOpacity: { min: 0.35, max: 1, step: 0.05 },
  safeTop: { min: 0, max: 0.25, step: 0.01 },
  safeBottom: { min: 0, max: 0.5, step: 0.01 },
  maxConcurrentMessages: { min: 30, max: 100, step: 10 },
  minTextLength: { min: 1, max: 10, step: 1 },
  outlineWidthPx: { min: 0, max: 8, step: 0.5 },
  outlineOpacity: { min: 0, max: 1, step: 0.1 },
  laneSpacing: { min: 0, max: 20, step: 1 },
  authorRateLimitWindowMs: { min: 1000, max: 30000, step: 1000 },
  authorRateLimitMaxMessages: { min: 1, max: 20, step: 1 },
  backlogMaxRate: { min: 0, max: 50, step: 5 },
  backlogSpeedMultiplier: { min: 1, max: 5, step: 0.5 },
  backlogRecentMinutes: { min: 1, max: 30, step: 1 },
  antiBlockFreeRatio: { min: 0, max: 0.5, step: 0.05 },
  superChatMaxBodyLines: { min: 2, max: 10, step: 1 },
  membershipMaxBodyLines: { min: 1, max: 5, step: 1 },
  spreadFactor: { min: 0.1, max: 2, step: 0.1 }, // 0.1 = minimal spread, 2 = double spread
  fadeDurationMs: { min: 0, max: 1000, step: 50 }, // 0 = no fade, up to 1s
  minPollIntervalMs: { min: 100, max: 5000, step: 100 }, // 100ms minimum polling
  maxPollIntervalMs: { min: 1000, max: 30000, step: 1000 }, // 1s to 30s maximum
} as const satisfies Record<SettingsLimitKey, NumericSettingLimit>;

export const STORAGE_KEY = 'yt-live-chat-overlay-settings';
export const SETTINGS_VERSION = 1;

/** Placeholder for future schema migrations. Currently at version 1. */
export function migrateSettings(raw: Record<string, unknown>): Record<string, unknown> {
  return { ...raw, _version: SETTINGS_VERSION };
}

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
  opacity: 0.8,
} as const satisfies OutlineSettings;

export const DEFAULT_SETTINGS = {
  enabled: true,
  danmakuMode: 'scroll',
  speedPxPerSec: 150,
  fontSize: 32,
  opacity: 0.85,
  superChatOpacity: 0.85,
  safeTop: 0,
  safeBottom: 0.12,
  maxConcurrentMessages: 50,
  allowShortTextMessages: false,
  minTextLength: 3,
  logLevel: 'warn',
  showAuthor: DEFAULT_SHOW_AUTHOR,
  colors: DEFAULT_COLORS,
  outline: DEFAULT_OUTLINE,
  laneSpacing: 3,
  showDebugOverlay: false,
  authorRateLimitEnabled: true,
  authorRateLimitWindowMs: 5000,
  authorRateLimitMaxMessages: 5,
  backlogMaxRate: 10,
  backlogSpeedMultiplier: 2,
  showBacklogIndicator: true,
  backlogMode: 'playback',
  backlogRecentMinutes: 5,
  fontWeight: 'bold',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  antiBlockEnabled: true,
  antiBlockFreeRatio: 0.15,
  preserveUserColor: false,
  superChatMaxBodyLines: 5,
  membershipMaxBodyLines: 3,
  spreadEnabled: true,
  spreadFactor: 1.0,
  fadeDurationMs: 500,
  minPollIntervalMs: 200,
  maxPollIntervalMs: 5000,
} as const satisfies Readonly<OverlaySettings>;

// ── Color validation ────────────────────────────────────────────────────────────

/**
 * Matches hex color strings: #RGB, #RRGGBB, #RGBA, #RRGGBBAA.
 */
const isColorValue = (value: unknown): value is string =>
  typeof value === 'string' && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6,8})$/i.test(value);

const clampNumber = (
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

export const resolveLimits = (
  key: string
): Readonly<{ min: number; max: number; step: number }> => {
  const direct = SETTINGS_LIMITS[key as keyof typeof SETTINGS_LIMITS];
  if (direct) return direct;
  // Outline keys use separate limit entries to avoid clashing with root keys
  if (key === 'widthPx') return SETTINGS_LIMITS.outlineWidthPx;
  if (key === 'opacity') return SETTINGS_LIMITS.outlineOpacity;
  throw new Error(`Unknown setting key: ${key}`);
};

/** Get display scale/precision from ROOT_SETTING_META for a root numeric key. */
export function getRootDisplayMeta(key: RootScalarSettingKey): {
  scale: number;
  precision: number;
} {
  const meta: SettingMeta = ROOT_SETTING_META[key];
  if (meta?.displayScale) {
    return { scale: meta.displayScale, precision: meta.displayPrecision ?? 0 };
  }
  return { scale: 1, precision: 0 };
}

// ── Normalization ───────────────────────────────────────────────────────────────

const STRING_VALIDATORS: Partial<Record<RootScalarSettingKey, (v: string) => boolean>> = {
  backlogMode: (v) => VALID_BACKLOG_MODES.includes(v as (typeof VALID_BACKLOG_MODES)[number]),
  danmakuMode: (v) => VALID_DANMAKU_MODES.includes(v as (typeof VALID_DANMAKU_MODES)[number]),
  logLevel: (v) => isLogLevel(v),
  fontWeight: (v) => v === 'normal' || v === 'bold',
  fontFamily: (_v) => true,
};

const normalizeSettings = (settings: Readonly<OverlaySettings>): OverlaySettings => {
  const d = DEFAULT_SETTINGS;
  // Start from defaults, then overlay valid values from the input
  const n = cloneSettings(DEFAULT_SETTINGS);

  const pickBool = (v: unknown, fallback: boolean): boolean =>
    typeof v === 'boolean' ? v : fallback;

  // Root scalar settings: type-routed via ROOT_SETTING_META.
  // Write into a mutable copy since OverlaySettings has no index signature.
  const out = n as unknown as Record<string, unknown>;
  const defaults = d as unknown as Record<string, unknown>;
  for (const key of Object.keys(ROOT_SETTING_META) as RootScalarSettingKey[]) {
    const meta = ROOT_SETTING_META[key];
    const raw = settings[key];
    if (meta.type === 'boolean') {
      out[key] = typeof raw === 'boolean' ? raw : defaults[key];
    } else if (meta.type === 'number') {
      out[key] = clampNumber(raw, defaults[key] as number, resolveLimits(key));
    } else {
      const validator = STRING_VALIDATORS[key];
      out[key] = typeof raw === 'string' && validator?.(raw) ? raw : defaults[key];
    }
  }

  for (const key of SHOW_AUTHOR_KEYS) {
    n.showAuthor[key] = pickBool(settings.showAuthor[key], d.showAuthor[key]);
  }

  for (const key of AUTHOR_COLOR_KEYS) {
    n.colors[key] = isColorValue(settings.colors[key]) ? settings.colors[key] : d.colors[key];
  }

  n.outline.enabled = pickBool(settings.outline.enabled, d.outline.enabled);
  for (const key of OUTLINE_NUMERIC_KEYS) {
    n.outline[key] = clampNumber(settings.outline[key], d.outline[key], resolveLimits(key));
  }

  return n;
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
