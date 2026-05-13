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
const VALID_RENDERER_TYPES = ['css', 'canvas'] as const;

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

export const ROOT_NUMERIC_KEYS = [
  'speedPxPerSec',
  'fontSize',
  'opacity',
  'superChatOpacity',
  'safeTop',
  'safeBottom',
  'maxConcurrentMessages',
  'minTextLength',
  'laneSpacing',
  'authorRateLimitWindowMs',
  'authorRateLimitMaxMessages',
  'backlogMaxRate',
  'backlogSpeedMultiplier',
  'backlogRecentMinutes',
] as const satisfies readonly RootNumericSettingKey[];

export const ROOT_SETTING_KEYS = [
  'enabled',
  'danmakuMode',
  'speedPxPerSec',
  'fontSize',
  'opacity',
  'superChatOpacity',
  'safeTop',
  'safeBottom',
  'maxConcurrentMessages',
  'allowShortTextMessages',
  'minTextLength',
  'logLevel',
  'laneSpacing',
  'showDebugOverlay',
  'rendererType',
  'authorRateLimitEnabled',
  'authorRateLimitWindowMs',
  'authorRateLimitMaxMessages',
  'backlogMaxRate',
  'backlogSpeedMultiplier',
  'showBacklogIndicator',
  'backlogMode',
  'backlogRecentMinutes',
] as const satisfies readonly RootScalarSettingKey[];

export const OUTLINE_SETTING_KEYS = [
  'enabled',
  'widthPx',
  'blurPx',
  'opacity',
] as const satisfies readonly OutlineSettingKey[];

export const OUTLINE_NUMERIC_KEYS = [
  'widthPx',
  'blurPx',
  'opacity',
] as const satisfies ReadonlyArray<Exclude<OutlineSettingKey, 'enabled'>>;

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
  | 'outlineBlurPx'
  | 'outlineOpacity'
  | 'laneSpacing'
  | 'authorRateLimitWindowMs'
  | 'authorRateLimitMaxMessages'
  | 'backlogMaxRate'
  | 'backlogSpeedMultiplier'
  | 'backlogRecentMinutes';

export const SETTINGS_LIMITS = {
  speedPxPerSec: { min: 100, max: 400, step: 10 },
  fontSize: { min: 18, max: 40, step: 2 },
  opacity: { min: 0.5, max: 1, step: 0.05 },
  superChatOpacity: { min: 0.35, max: 1, step: 0.05 },
  safeTop: { min: 0, max: 0.25, step: 0.01 },
  safeBottom: { min: 0, max: 0.5, step: 0.01 },
  maxConcurrentMessages: { min: 30, max: 100, step: 10 },
  minTextLength: { min: 1, max: 10, step: 1 },
  outlineWidthPx: { min: 0, max: 5, step: 0.5 },
  outlineBlurPx: { min: 0, max: 8, step: 0.5 },
  outlineOpacity: { min: 0, max: 1, step: 0.1 },
  laneSpacing: { min: 0, max: 20, step: 1 },
  authorRateLimitWindowMs: { min: 1000, max: 30000, step: 1000 },
  authorRateLimitMaxMessages: { min: 1, max: 20, step: 1 },
  backlogMaxRate: { min: 0, max: 50, step: 5 },
  backlogSpeedMultiplier: { min: 1, max: 5, step: 0.5 },
  backlogRecentMinutes: { min: 1, max: 30, step: 1 },
} as const satisfies Record<SettingsLimitKey, NumericSettingLimit>;

export const STORAGE_KEY = 'yt-live-chat-overlay-settings';

// ── Defaults ────────────────────────────────────────────────────────────────────

const DEFAULT_SHOW_AUTHOR: OverlaySettings['showAuthor'] = {
  normal: false,
  member: false,
  moderator: true,
  owner: true,
  verified: false,
  superChat: true,
};

const DEFAULT_COLORS: OverlaySettings['colors'] = {
  normal: designColors.authorNormal,
  member: designColors.authorMember,
  moderator: designColors.authorModerator,
  owner: designColors.authorOwner,
  verified: designColors.authorVerified,
};

const DEFAULT_OUTLINE: OutlineSettings = {
  enabled: true,
  widthPx: 1.5,
  blurPx: 2,
  opacity: 0.7,
};

export const DEFAULT_SETTINGS = {
  enabled: true,
  danmakuMode: 'scroll',
  speedPxPerSec: 250,
  fontSize: 20,
  opacity: 0.85,
  superChatOpacity: 0.35,
  safeTop: 0,
  safeBottom: 0.15,
  maxConcurrentMessages: 50,
  allowShortTextMessages: false,
  minTextLength: 3,
  logLevel: 'warn',
  showAuthor: DEFAULT_SHOW_AUTHOR,
  colors: DEFAULT_COLORS,
  outline: DEFAULT_OUTLINE,
  laneSpacing: 0,
  showDebugOverlay: false,
  rendererType: 'css',
  authorRateLimitEnabled: true,
  authorRateLimitWindowMs: 5000,
  authorRateLimitMaxMessages: 5,
  backlogMaxRate: 10,
  backlogSpeedMultiplier: 2,
  showBacklogIndicator: true,
  backlogMode: 'playback',
  backlogRecentMinutes: 5,
} as const satisfies Readonly<OverlaySettings>;

// ── Visual reset keys ───────────────────────────────────────────────────────────

/**
 * Root-level setting keys that affect visual rendering and therefore
 * require a full renderer reset (clear messages + replay) when changed.
 *
 * Non-visual settings (logLevel, showDebugOverlay, backlog, rate limit
 * configuration, etc.) are excluded — those are applied without reset.
 */
export const VISUAL_ROOT_KEYS = [
  'speedPxPerSec',
  'fontSize',
  'opacity',
  'superChatOpacity',
  'safeTop',
  'safeBottom',
  'maxConcurrentMessages',
  'allowShortTextMessages',
  'minTextLength',
  'laneSpacing',
] as const satisfies readonly RootScalarSettingKey[];

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

const resolveLimits = (key: string): Readonly<{ min: number; max: number }> => {
  const direct = SETTINGS_LIMITS[key as keyof typeof SETTINGS_LIMITS];
  if (direct) return direct;
  const outlineKey = OUTLINE_LIMITS_MAP[key as keyof typeof OUTLINE_LIMITS_MAP];
  if (outlineKey) return SETTINGS_LIMITS[outlineKey];
  throw new Error(`Unknown setting key: ${key}`);
};

const OUTLINE_LIMITS_MAP: Record<
  Exclude<OutlineSettingKey, 'enabled'>,
  keyof typeof SETTINGS_LIMITS
> = {
  widthPx: 'outlineWidthPx',
  blurPx: 'outlineBlurPx',
  opacity: 'outlineOpacity',
};

export { OUTLINE_LIMITS_MAP };

// ── Normalization ───────────────────────────────────────────────────────────────

const pickBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const normalizeSettings = (settings: Readonly<OverlaySettings>): OverlaySettings => {
  const d = DEFAULT_SETTINGS;
  const n = cloneSettings(DEFAULT_SETTINGS);

  n.enabled = pickBool(settings.enabled, d.enabled);
  n.allowShortTextMessages = pickBool(settings.allowShortTextMessages, d.allowShortTextMessages);
  n.showDebugOverlay = pickBool(settings.showDebugOverlay, d.showDebugOverlay);
  n.authorRateLimitEnabled = pickBool(settings.authorRateLimitEnabled, d.authorRateLimitEnabled);
  n.showBacklogIndicator = pickBool(settings.showBacklogIndicator, d.showBacklogIndicator);

  // Backlog mode: validate against allowed values
  n.backlogMode = VALID_BACKLOG_MODES.includes(
    settings.backlogMode as (typeof VALID_BACKLOG_MODES)[number]
  )
    ? settings.backlogMode
    : d.backlogMode;

  n.danmakuMode = VALID_DANMAKU_MODES.includes(
    settings.danmakuMode as (typeof VALID_DANMAKU_MODES)[number]
  )
    ? settings.danmakuMode
    : d.danmakuMode;

  n.rendererType = VALID_RENDERER_TYPES.includes(
    settings.rendererType as (typeof VALID_RENDERER_TYPES)[number]
  )
    ? settings.rendererType
    : d.rendererType;

  for (const key of ROOT_NUMERIC_KEYS) {
    n[key] = clampNumber(settings[key], d[key], resolveLimits(key));
  }

  n.logLevel = isLogLevel(settings.logLevel) ? settings.logLevel : d.logLevel;

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
): OverlaySettings =>
  stored
    ? applySettingsPatch(cloneSettings(DEFAULT_SETTINGS), stored as Partial<OverlaySettings>)
    : cloneSettings(DEFAULT_SETTINGS);

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
