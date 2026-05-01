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

export const createDefaultSettings = (): OverlaySettings => cloneSettings(DEFAULT_SETTINGS);

export const normalizeSettings = (settings: Readonly<OverlaySettings>): OverlaySettings => {
  const d = DEFAULT_SETTINGS;
  const n = createDefaultSettings();

  n.enabled = typeof settings.enabled === 'boolean' ? settings.enabled : d.enabled;
  n.speedPxPerSec = clampNumber(
    settings.speedPxPerSec,
    d.speedPxPerSec,
    SETTINGS_LIMITS.speedPxPerSec,
    false
  );
  n.fontSize = clampNumber(settings.fontSize, d.fontSize, SETTINGS_LIMITS.fontSize, false);
  n.opacity = clampNumber(settings.opacity, d.opacity, SETTINGS_LIMITS.opacity, false);
  n.superChatOpacity = clampNumber(
    settings.superChatOpacity,
    d.superChatOpacity,
    SETTINGS_LIMITS.superChatOpacity,
    false
  );
  n.safeTop = clampNumber(settings.safeTop, d.safeTop, SETTINGS_LIMITS.safeTop, false);
  n.safeBottom = clampNumber(settings.safeBottom, d.safeBottom, SETTINGS_LIMITS.safeBottom, false);
  n.maxConcurrentMessages = clampNumber(
    settings.maxConcurrentMessages,
    d.maxConcurrentMessages,
    SETTINGS_LIMITS.maxConcurrentMessages,
    true
  );
  n.maxMessagesPerSecond = clampNumber(
    settings.maxMessagesPerSecond,
    d.maxMessagesPerSecond,
    SETTINGS_LIMITS.maxMessagesPerSecond,
    true
  );
  n.allowShortTextMessages =
    typeof settings.allowShortTextMessages === 'boolean'
      ? settings.allowShortTextMessages
      : d.allowShortTextMessages;
  n.minTextLength = clampNumber(
    settings.minTextLength,
    d.minTextLength,
    SETTINGS_LIMITS.minTextLength,
    true
  );
  n.logLevel = isLogLevel(settings.logLevel) ? settings.logLevel : d.logLevel;
  n.laneSpacing = clampNumber(
    settings.laneSpacing,
    d.laneSpacing,
    SETTINGS_LIMITS.laneSpacing,
    true
  );

  for (const key of SHOW_AUTHOR_KEYS) {
    n.showAuthor[key] =
      typeof settings.showAuthor[key] === 'boolean' ? settings.showAuthor[key] : d.showAuthor[key];
  }

  for (const key of AUTHOR_COLOR_KEYS) {
    n.colors[key] = isColorValue(settings.colors[key]) ? settings.colors[key] : d.colors[key];
  }

  n.outline.enabled =
    typeof settings.outline.enabled === 'boolean' ? settings.outline.enabled : d.outline.enabled;
  n.outline.widthPx = clampNumber(
    settings.outline.widthPx,
    d.outline.widthPx,
    SETTINGS_LIMITS.outlineWidthPx,
    false
  );
  n.outline.blurPx = clampNumber(
    settings.outline.blurPx,
    d.outline.blurPx,
    SETTINGS_LIMITS.outlineBlurPx,
    false
  );
  n.outline.opacity = clampNumber(
    settings.outline.opacity,
    d.outline.opacity,
    SETTINGS_LIMITS.outlineOpacity,
    false
  );

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
