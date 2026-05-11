import {
  type AuthorType,
  isLogLevel,
  type OutlineSettings,
  type OverlaySettings,
} from '@app-types';
import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from '@core/settings-definitions';

type RootScalarSettingKey = Exclude<keyof OverlaySettings, 'showAuthor' | 'colors' | 'outline'>;
type OutlineSettingKey = keyof OutlineSettings;

export type { OutlineSettingKey, RootNumericSettingKey, RootScalarSettingKey };

const VALID_BACKLOG_MODES = ['playback', 'recent', 'full', 'none'] as const;

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
  'maxMessagesPerSecond',
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
  'speedPxPerSec',
  'fontSize',
  'opacity',
  'superChatOpacity',
  'safeTop',
  'safeBottom',
  'maxConcurrentMessages',
  'maxMessagesPerSecond',
  'allowShortTextMessages',
  'minTextLength',
  'logLevel',
  'laneSpacing',
  'showDebugOverlay',
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
  stored: Partial<OverlaySettings> | null | undefined
): OverlaySettings =>
  stored
    ? applySettingsPatch(cloneSettings(DEFAULT_SETTINGS), stored)
    : cloneSettings(DEFAULT_SETTINGS);

export const shouldResetRendererForSettingsChange = (
  previous: Readonly<OverlaySettings>,
  next: Readonly<OverlaySettings>
): boolean => {
  if (ROOT_SETTING_KEYS.some((key) => previous[key] !== next[key])) return true;
  if (SHOW_AUTHOR_KEYS.some((key) => previous.showAuthor[key] !== next.showAuthor[key]))
    return true;
  if (AUTHOR_COLOR_KEYS.some((key) => previous.colors[key] !== next.colors[key])) return true;
  return OUTLINE_SETTING_KEYS.some((key) => previous.outline[key] !== next.outline[key]);
};
