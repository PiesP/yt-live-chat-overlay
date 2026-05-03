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

const normalizeSettings = (settings: Readonly<OverlaySettings>): OverlaySettings => {
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

// ── UI input formatting & normalization (merged from settings-form.ts) ─────

const ROOT_LIMITS_KEY: Partial<Record<RootScalarSettingKey, keyof typeof SETTINGS_LIMITS>> = {
  speedPxPerSec: 'speedPxPerSec',
  fontSize: 'fontSize',
  opacity: 'opacity',
  superChatOpacity: 'superChatOpacity',
  safeTop: 'safeTop',
  safeBottom: 'safeBottom',
  maxConcurrentMessages: 'maxConcurrentMessages',
  maxMessagesPerSecond: 'maxMessagesPerSecond',
  minTextLength: 'minTextLength',
  laneSpacing: 'laneSpacing',
};

const OUTLINE_NUMERIC_LIMITS_KEY: Record<
  Exclude<OutlineSettingKey, 'enabled'>,
  keyof typeof SETTINGS_LIMITS
> = {
  widthPx: 'outlineWidthPx',
  blurPx: 'outlineBlurPx',
  opacity: 'outlineOpacity',
};

const ROOT_ROUNDED_KEYS = new Set<RootScalarSettingKey>([
  'maxConcurrentMessages',
  'maxMessagesPerSecond',
  'minTextLength',
  'laneSpacing',
]);

interface NumericInputOptions {
  readonly scale?: number;
  readonly precision?: number;
}

const ROOT_NUMERIC_INPUT_OPTIONS: Partial<Record<RootScalarSettingKey, NumericInputOptions>> = {
  superChatOpacity: { scale: 100, precision: 0 },
  safeTop: { scale: 100, precision: 1 },
  safeBottom: { scale: 100, precision: 1 },
};

const scaleUiValue = (value: number, scale: number): number => Number((value * scale).toFixed(4));

const getRootScale = (key: RootScalarSettingKey): number =>
  ROOT_NUMERIC_INPUT_OPTIONS[key]?.scale ?? 1;

const normalizeNumericValue = (
  value: unknown,
  fallback: number,
  limits: Readonly<{ min: number; max: number }>,
  rounded: boolean,
  scale = 1
): number => {
  const scaledValue = typeof value === 'number' ? value / scale : Number(value) / scale;
  const numericValue = Number.isFinite(scaledValue) ? scaledValue : fallback;
  const clamped = Math.min(limits.max, Math.max(limits.min, numericValue));
  return rounded ? Math.round(clamped) : clamped;
};

export const formatRootNumericSettingForInput = (
  key: RootScalarSettingKey,
  value: number
): string | number => {
  const options = ROOT_NUMERIC_INPUT_OPTIONS[key];
  const scaledValue = scaleUiValue(value, options?.scale ?? 1);
  return options?.precision === undefined ? scaledValue : scaledValue.toFixed(options.precision);
};

export const formatOutlineNumericSettingForInput = (
  _key: OutlineSettingKey,
  value: number
): string | number => String(value);

export const normalizeRootNumericInputValue = (
  key: RootScalarSettingKey,
  value: unknown,
  fallback: number
): number => {
  const limitsKey = ROOT_LIMITS_KEY[key];
  if (!limitsKey) return fallback;
  return normalizeNumericValue(
    value,
    fallback,
    SETTINGS_LIMITS[limitsKey],
    ROOT_ROUNDED_KEYS.has(key),
    getRootScale(key)
  );
};

export const normalizeOutlineNumericInputValue = (
  key: Exclude<OutlineSettingKey, 'enabled'>,
  value: unknown,
  fallback: number
): number => {
  const limitsKey = OUTLINE_NUMERIC_LIMITS_KEY[key];
  return normalizeNumericValue(value, fallback, SETTINGS_LIMITS[limitsKey], false);
};

export const getRootNumericInputAttributes = (
  key: RootScalarSettingKey
): Readonly<{ min: number; max: number; step: number }> => {
  const limitsKey = ROOT_LIMITS_KEY[key];
  if (!limitsKey) throw new TypeError(`Setting "${key}" does not define numeric limits.`);

  const limits = SETTINGS_LIMITS[limitsKey];
  const scale = getRootScale(key);

  return {
    min: scaleUiValue(limits.min, scale),
    max: scaleUiValue(limits.max, scale),
    step: scaleUiValue(limits.step, scale),
  };
};

export const getOutlineNumericInputAttributes = (
  key: Exclude<OutlineSettingKey, 'enabled'>
): Readonly<{ min: number; max: number; step: number }> => {
  const limitsKey = OUTLINE_NUMERIC_LIMITS_KEY[key];
  const limits = SETTINGS_LIMITS[limitsKey];

  return {
    min: limits.min,
    max: limits.max,
    step: limits.step,
  };
};
