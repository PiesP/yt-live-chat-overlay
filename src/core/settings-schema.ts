import {
  type AuthorType,
  isLogLevel,
  type OutlineSettings,
  type OverlaySettings,
} from '@app-types';
import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from '@core/settings-definitions';

type RootScalarSettingKey = Exclude<keyof OverlaySettings, 'showAuthor' | 'colors' | 'outline'>;
type OutlineSettingKey = keyof OutlineSettings;

export type { OutlineSettingKey, RootScalarSettingKey };

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

const RESET_RENDERER_ROOT_KEYS = [
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
  'laneSpacing',
] as const satisfies readonly RootScalarSettingKey[];

const RESET_RENDERER_OUTLINE_KEYS = [
  'enabled',
  'widthPx',
  'blurPx',
  'opacity',
] as const satisfies readonly OutlineSettingKey[];

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
] as const satisfies readonly RootScalarSettingKey[];

export const OUTLINE_SETTING_KEYS = [
  'enabled',
  'widthPx',
  'blurPx',
  'opacity',
] as const satisfies readonly OutlineSettingKey[];

const isColorValue = (value: unknown): value is string =>
  typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);

const clampNumber = (
  value: unknown,
  fallback: number,
  limits: Readonly<{ min: number; max: number }>,
  rounded: boolean
): number => {
  const numericValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  const clamped = Math.min(limits.max, Math.max(limits.min, numericValue));
  return rounded ? Math.round(clamped) : clamped;
};

export const cloneSettings = (settings: Readonly<OverlaySettings>): OverlaySettings => ({
  ...settings,
  showAuthor: { ...settings.showAuthor },
  colors: { ...settings.colors },
  outline: { ...settings.outline },
});

const createDefaultSettings = (): OverlaySettings => cloneSettings(DEFAULT_SETTINGS);

const ROOT_NUMERIC_FIELDS: ReadonlyArray<{
  key:
    | 'speedPxPerSec'
    | 'fontSize'
    | 'opacity'
    | 'superChatOpacity'
    | 'safeTop'
    | 'safeBottom'
    | 'maxConcurrentMessages'
    | 'maxMessagesPerSecond'
    | 'minTextLength'
    | 'laneSpacing';
  limits: Readonly<{ min: number; max: number }>;
  clamp: boolean;
}> = [
  { key: 'speedPxPerSec', limits: SETTINGS_LIMITS.speedPxPerSec, clamp: false },
  { key: 'fontSize', limits: SETTINGS_LIMITS.fontSize, clamp: false },
  { key: 'opacity', limits: SETTINGS_LIMITS.opacity, clamp: false },
  { key: 'superChatOpacity', limits: SETTINGS_LIMITS.superChatOpacity, clamp: false },
  { key: 'safeTop', limits: SETTINGS_LIMITS.safeTop, clamp: false },
  { key: 'safeBottom', limits: SETTINGS_LIMITS.safeBottom, clamp: false },
  { key: 'maxConcurrentMessages', limits: SETTINGS_LIMITS.maxConcurrentMessages, clamp: true },
  { key: 'maxMessagesPerSecond', limits: SETTINGS_LIMITS.maxMessagesPerSecond, clamp: true },
  { key: 'minTextLength', limits: SETTINGS_LIMITS.minTextLength, clamp: true },
  { key: 'laneSpacing', limits: SETTINGS_LIMITS.laneSpacing, clamp: true },
];

const OUTLINE_NUMERIC_FIELDS: ReadonlyArray<{
  key: 'widthPx' | 'blurPx' | 'opacity';
  limits: Readonly<{ min: number; max: number }>;
  clamp: boolean;
}> = [
  { key: 'widthPx', limits: SETTINGS_LIMITS.outlineWidthPx, clamp: false },
  { key: 'blurPx', limits: SETTINGS_LIMITS.outlineBlurPx, clamp: false },
  { key: 'opacity', limits: SETTINGS_LIMITS.outlineOpacity, clamp: false },
];

const normalizeSettings = (settings: Readonly<OverlaySettings>): OverlaySettings => {
  const d = DEFAULT_SETTINGS;
  const n = createDefaultSettings();

  n.enabled = typeof settings.enabled === 'boolean' ? settings.enabled : d.enabled;
  n.allowShortTextMessages =
    typeof settings.allowShortTextMessages === 'boolean'
      ? settings.allowShortTextMessages
      : d.allowShortTextMessages;

  for (const { key, limits, clamp } of ROOT_NUMERIC_FIELDS) {
    n[key] = clampNumber(settings[key], d[key], limits, clamp);
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
  for (const { key, limits, clamp } of OUTLINE_NUMERIC_FIELDS) {
    n.outline[key] = clampNumber(settings.outline[key], d.outline[key], limits, clamp);
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
  stored ? applySettingsPatch(createDefaultSettings(), stored) : createDefaultSettings();

export const shouldResetRendererForSettingsChange = (
  previous: Readonly<OverlaySettings>,
  next: Readonly<OverlaySettings>
): boolean =>
  RESET_RENDERER_ROOT_KEYS.some((key) => previous[key] !== next[key]) ||
  SHOW_AUTHOR_KEYS.some((key) => previous.showAuthor[key] !== next.showAuthor[key]) ||
  AUTHOR_COLOR_KEYS.some((key) => previous.colors[key] !== next.colors[key]) ||
  RESET_RENDERER_OUTLINE_KEYS.some((key) => previous.outline[key] !== next.outline[key]);
