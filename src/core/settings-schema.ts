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
  | 'enableDropLogging'
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
  'debugOverlayOpacity',
  'authorRateLimitWindowMs',
  'authorRateLimitMaxMessages',
  'backlogMaxRate',
  'backlogSpeedMultiplier',
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
  'enableDropLogging',
  'debugOverlayOpacity',
  'authorRateLimitEnabled',
  'authorRateLimitWindowMs',
  'authorRateLimitMaxMessages',
  'backlogMaxRate',
  'backlogSpeedMultiplier',
  'showBacklogIndicator',
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
  const outlineKey = OUTLINE_LIMITS_MAP[key];
  if (outlineKey) return SETTINGS_LIMITS[outlineKey];
  return SETTINGS_LIMITS.speedPxPerSec; // fallback, should not happen
};

const OUTLINE_LIMITS_MAP: Record<string, keyof typeof SETTINGS_LIMITS> = {
  widthPx: 'outlineWidthPx',
  blurPx: 'outlineBlurPx',
  opacity: 'outlineOpacity',
};

const normalizeSettings = (settings: Readonly<OverlaySettings>): OverlaySettings => {
  const d = DEFAULT_SETTINGS;
  const n = cloneSettings(DEFAULT_SETTINGS);

  n.enabled = typeof settings.enabled === 'boolean' ? settings.enabled : d.enabled;
  n.allowShortTextMessages =
    typeof settings.allowShortTextMessages === 'boolean'
      ? settings.allowShortTextMessages
      : d.allowShortTextMessages;
  n.showDebugOverlay =
    typeof settings.showDebugOverlay === 'boolean' ? settings.showDebugOverlay : d.showDebugOverlay;
  n.enableDropLogging =
    typeof settings.enableDropLogging === 'boolean'
      ? settings.enableDropLogging
      : d.enableDropLogging;
  n.authorRateLimitEnabled =
    typeof settings.authorRateLimitEnabled === 'boolean'
      ? settings.authorRateLimitEnabled
      : d.authorRateLimitEnabled;
  n.showBacklogIndicator =
    typeof settings.showBacklogIndicator === 'boolean'
      ? settings.showBacklogIndicator
      : d.showBacklogIndicator;

  for (const key of ROOT_NUMERIC_KEYS) {
    n[key] = clampNumber(settings[key], d[key], resolveLimits(key));
  }

  n.logLevel = isLogLevel(settings.logLevel) ? settings.logLevel : d.logLevel;

  for (const key of SHOW_AUTHOR_KEYS) {
    n.showAuthor[key] =
      typeof settings.showAuthor[key] === 'boolean' ? settings.showAuthor[key] : d.showAuthor[key];
  }

  for (const key of AUTHOR_COLOR_KEYS) {
    n.colors[key] = isColorValue(settings.colors[key]) ? settings.colors[key] : d.colors[key];
  }

  n.outline.enabled =
    typeof settings.outline.enabled === 'boolean' ? settings.outline.enabled : d.outline.enabled;
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
): boolean =>
  ROOT_SETTING_KEYS.some((key) => previous[key] !== next[key]) ||
  SHOW_AUTHOR_KEYS.some((key) => previous.showAuthor[key] !== next.showAuthor[key]) ||
  AUTHOR_COLOR_KEYS.some((key) => previous.colors[key] !== next.colors[key]) ||
  OUTLINE_SETTING_KEYS.some((key) => previous.outline[key] !== next.outline[key]);
