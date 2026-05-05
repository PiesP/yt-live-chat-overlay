import { SETTINGS_LIMITS } from '@core/settings-definitions';
import type { OutlineSettingKey, RootScalarSettingKey } from '@core/settings-schema';

// ── Limit key lookups ──────────────────────────────────────────────────────

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

// ── UI display helpers ─────────────────────────────────────────────────────

interface NumericInputOptions {
  readonly scale?: number;
  readonly precision?: number;
}

/** Settings displayed as percentages in the UI (stored as 0-1 internally). */
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

// ── Public API ─────────────────────────────────────────────────────────────

export const formatRootNumericSettingForInput = (
  key: RootScalarSettingKey,
  value: number
): string | number => {
  const options = ROOT_NUMERIC_INPUT_OPTIONS[key];
  const scaledValue = scaleUiValue(value, options?.scale ?? 1);
  return options?.precision === undefined ? scaledValue : scaledValue.toFixed(options.precision);
};

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
