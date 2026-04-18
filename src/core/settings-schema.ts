import {
  type AuthorType,
  isLogLevel,
  type OutlineSettings,
  type OverlaySettings,
} from '@app-types';
import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from '@core/settings-definitions';

type SettingDefinitionKind = 'boolean' | 'number' | 'rounded-number' | 'log-level';
type RootScalarSettingKey = Exclude<keyof OverlaySettings, 'showAuthor' | 'colors' | 'outline'>;
type OutlineSettingKey = keyof OutlineSettings;
type SettingLimitsKey = keyof typeof SETTINGS_LIMITS;

interface SettingDefinition {
  readonly kind: SettingDefinitionKind;
  readonly limitsKey?: SettingLimitsKey;
  readonly uiScale?: number;
  readonly uiPrecision?: number;
  readonly resetRenderer: boolean;
}

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

export const ROOT_SETTING_DEFINITIONS = {
  enabled: {
    kind: 'boolean',
    resetRenderer: true,
  },
  speedPxPerSec: {
    kind: 'number',
    limitsKey: 'speedPxPerSec',
    resetRenderer: true,
  },
  fontSize: {
    kind: 'number',
    limitsKey: 'fontSize',
    resetRenderer: true,
  },
  opacity: {
    kind: 'number',
    limitsKey: 'opacity',
    resetRenderer: true,
  },
  superChatOpacity: {
    kind: 'number',
    limitsKey: 'superChatOpacity',
    uiScale: 100,
    uiPrecision: 0,
    resetRenderer: true,
  },
  safeTop: {
    kind: 'number',
    limitsKey: 'safeTop',
    uiScale: 100,
    uiPrecision: 1,
    resetRenderer: true,
  },
  safeBottom: {
    kind: 'number',
    limitsKey: 'safeBottom',
    uiScale: 100,
    uiPrecision: 1,
    resetRenderer: true,
  },
  maxConcurrentMessages: {
    kind: 'rounded-number',
    limitsKey: 'maxConcurrentMessages',
    resetRenderer: true,
  },
  maxMessagesPerSecond: {
    kind: 'rounded-number',
    limitsKey: 'maxMessagesPerSecond',
    resetRenderer: true,
  },
  allowShortTextMessages: {
    kind: 'boolean',
    resetRenderer: true,
  },
  minTextLength: {
    kind: 'rounded-number',
    limitsKey: 'minTextLength',
    resetRenderer: true,
  },
  logLevel: {
    kind: 'log-level',
    resetRenderer: false,
  },
  laneSpacing: {
    kind: 'rounded-number',
    limitsKey: 'laneSpacing',
    resetRenderer: true,
  },
} as const satisfies Record<RootScalarSettingKey, SettingDefinition>;

export const OUTLINE_SETTING_DEFINITIONS = {
  enabled: {
    kind: 'boolean',
    resetRenderer: true,
  },
  widthPx: {
    kind: 'number',
    limitsKey: 'outlineWidthPx',
    resetRenderer: true,
  },
  blurPx: {
    kind: 'number',
    limitsKey: 'outlineBlurPx',
    resetRenderer: true,
  },
  opacity: {
    kind: 'number',
    limitsKey: 'outlineOpacity',
    resetRenderer: true,
  },
} as const satisfies Record<OutlineSettingKey, SettingDefinition>;

export const ROOT_SETTING_KEYS = Object.keys(
  ROOT_SETTING_DEFINITIONS
) as ReadonlyArray<RootScalarSettingKey>;
export const OUTLINE_SETTING_KEYS = Object.keys(
  OUTLINE_SETTING_DEFINITIONS
) as ReadonlyArray<OutlineSettingKey>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isColorValue = (value: unknown): value is string =>
  typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);

const clampNumber = (
  value: unknown,
  fallback: number,
  limits: { min: number; max: number }
): number => {
  const numericValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(limits.max, Math.max(limits.min, numericValue));
};

const normalizeBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const normalizeSettingValue = <T>(
  definition: SettingDefinition,
  value: unknown,
  fallback: T
): T => {
  if (definition.kind === 'boolean') {
    return normalizeBoolean(value, fallback as boolean) as T;
  }

  if (definition.kind === 'log-level') {
    return (isLogLevel(value) ? value : fallback) as T;
  }

  if (typeof fallback !== 'number' || !definition.limitsKey) {
    return fallback;
  }

  const clamped = clampNumber(value, fallback, SETTINGS_LIMITS[definition.limitsKey]);
  return (definition.kind === 'rounded-number' ? Math.round(clamped) : clamped) as T;
};

const assignNormalizedSetting = <Target extends object, K extends keyof Target>(
  target: Target,
  source: Readonly<Target>,
  key: K,
  definition: SettingDefinition,
  defaults: Readonly<Target>
): void => {
  target[key] = normalizeSettingValue(definition, source[key], defaults[key]) as never;
};

const hasAnyChanged = <T extends object>(
  previous: Readonly<T>,
  next: Readonly<T>,
  keys: readonly (keyof T)[]
): boolean => keys.some((key) => previous[key] !== next[key]);

const scaleUiValue = (value: number, scale: number): number => Number((value * scale).toFixed(4));

export const cloneSettings = (settings: Readonly<OverlaySettings>): OverlaySettings => ({
  ...settings,
  showAuthor: { ...settings.showAuthor },
  colors: { ...settings.colors },
  outline: { ...settings.outline },
});

const mergeNested = <T extends object>(base: Readonly<T>, partial: Partial<T> | undefined): T =>
  isRecord(partial) ? { ...base, ...partial } : { ...base };

export const mergeSettings = (
  base: Readonly<OverlaySettings>,
  partial: Partial<OverlaySettings>
): OverlaySettings => ({
  ...base,
  ...partial,
  showAuthor: mergeNested(base.showAuthor, partial.showAuthor),
  colors: mergeNested(base.colors, partial.colors),
  outline: mergeNested(base.outline, partial.outline),
});

export const normalizeSettings = (settings: Readonly<OverlaySettings>): OverlaySettings => {
  const normalized = cloneSettings(DEFAULT_SETTINGS);

  for (const key of ROOT_SETTING_KEYS) {
    assignNormalizedSetting(
      normalized,
      settings,
      key,
      ROOT_SETTING_DEFINITIONS[key],
      DEFAULT_SETTINGS
    );
  }

  for (const key of SHOW_AUTHOR_KEYS) {
    normalized.showAuthor[key] = normalizeBoolean(
      settings.showAuthor[key],
      DEFAULT_SETTINGS.showAuthor[key]
    );
  }

  for (const key of AUTHOR_COLOR_KEYS) {
    normalized.colors[key] = isColorValue(settings.colors[key])
      ? settings.colors[key]
      : DEFAULT_SETTINGS.colors[key];
  }

  for (const key of OUTLINE_SETTING_KEYS) {
    assignNormalizedSetting(
      normalized.outline,
      settings.outline,
      key,
      OUTLINE_SETTING_DEFINITIONS[key],
      DEFAULT_SETTINGS.outline
    );
  }

  return normalized;
};

export const applySettings = (
  base: Readonly<OverlaySettings>,
  partial: Partial<OverlaySettings>
): OverlaySettings => normalizeSettings(mergeSettings(base, partial));

export const shouldResetRendererForSettingsChange = (
  previous: Readonly<OverlaySettings>,
  next: Readonly<OverlaySettings>
): boolean =>
  ROOT_SETTING_KEYS.some(
    (key) => ROOT_SETTING_DEFINITIONS[key].resetRenderer && previous[key] !== next[key]
  ) ||
  hasAnyChanged(previous.showAuthor, next.showAuthor, SHOW_AUTHOR_KEYS) ||
  hasAnyChanged(previous.colors, next.colors, AUTHOR_COLOR_KEYS) ||
  OUTLINE_SETTING_KEYS.some(
    (key) =>
      OUTLINE_SETTING_DEFINITIONS[key].resetRenderer && previous.outline[key] !== next.outline[key]
  );

export const formatNumericSettingForInput = (
  definition: SettingDefinition,
  value: number
): string | number => {
  const scale = definition.uiScale ?? 1;
  const scaledValue = scaleUiValue(value, scale);
  return definition.uiPrecision === undefined
    ? scaledValue
    : scaledValue.toFixed(definition.uiPrecision);
};

export const normalizeNumericInputValue = (
  definition: SettingDefinition,
  value: unknown,
  fallback: number
): number => {
  const scale = definition.uiScale ?? 1;
  const scaledValue = typeof value === 'number' ? value / scale : Number(value) / scale;
  return normalizeSettingValue(definition, scaledValue, fallback) as number;
};

export const getNumericInputAttributes = (
  definition: SettingDefinition
): Readonly<{ min: number; max: number; step: number }> => {
  if (!definition.limitsKey) {
    throw new TypeError('Setting does not define numeric limits.');
  }

  const limits = SETTINGS_LIMITS[definition.limitsKey];
  const scale = definition.uiScale ?? 1;

  return {
    min: scaleUiValue(limits.min, scale),
    max: scaleUiValue(limits.max, scale),
    step: scaleUiValue(limits.step, scale),
  };
};
