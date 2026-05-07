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

export const outlineFormName = (key: OutlineSettingKey): string => `outline-${key}`;

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

interface NumericFieldDef {
  limits: Readonly<{ min: number; max: number }>;
}

const ROOT_NUMERIC_FIELDS: Readonly<
  Record<
    Exclude<
      RootScalarSettingKey,
      | 'enabled'
      | 'allowShortTextMessages'
      | 'logLevel'
      | 'showDebugOverlay'
      | 'enableDropLogging'
      | 'authorRateLimitEnabled'
    >,
    NumericFieldDef
  >
> = {
  speedPxPerSec: { limits: SETTINGS_LIMITS.speedPxPerSec },
  fontSize: { limits: SETTINGS_LIMITS.fontSize },
  opacity: { limits: SETTINGS_LIMITS.opacity },
  superChatOpacity: { limits: SETTINGS_LIMITS.superChatOpacity },
  safeTop: { limits: SETTINGS_LIMITS.safeTop },
  safeBottom: { limits: SETTINGS_LIMITS.safeBottom },
  maxConcurrentMessages: { limits: SETTINGS_LIMITS.maxConcurrentMessages },
  maxMessagesPerSecond: { limits: SETTINGS_LIMITS.maxMessagesPerSecond },
  minTextLength: { limits: SETTINGS_LIMITS.minTextLength },
  laneSpacing: { limits: SETTINGS_LIMITS.laneSpacing },
  debugOverlayOpacity: { limits: SETTINGS_LIMITS.debugOverlayOpacity },
  authorRateLimitWindowMs: { limits: SETTINGS_LIMITS.authorRateLimitWindowMs },
  authorRateLimitMaxMessages: { limits: SETTINGS_LIMITS.authorRateLimitMaxMessages },
};

const OUTLINE_NUMERIC_FIELDS: Readonly<
  Record<Exclude<OutlineSettingKey, 'enabled'>, NumericFieldDef>
> = {
  widthPx: { limits: SETTINGS_LIMITS.outlineWidthPx },
  blurPx: { limits: SETTINGS_LIMITS.outlineBlurPx },
  opacity: { limits: SETTINGS_LIMITS.outlineOpacity },
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

  for (const [key, { limits }] of Object.entries(ROOT_NUMERIC_FIELDS)) {
    n[key as keyof typeof ROOT_NUMERIC_FIELDS] = clampNumber(
      settings[key as keyof typeof ROOT_NUMERIC_FIELDS],
      d[key as keyof typeof ROOT_NUMERIC_FIELDS],
      limits
    );
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
  for (const [key, { limits }] of Object.entries(OUTLINE_NUMERIC_FIELDS)) {
    n.outline[key as keyof typeof OUTLINE_NUMERIC_FIELDS] = clampNumber(
      settings.outline[key as keyof typeof OUTLINE_NUMERIC_FIELDS],
      d.outline[key as keyof typeof OUTLINE_NUMERIC_FIELDS],
      limits
    );
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
