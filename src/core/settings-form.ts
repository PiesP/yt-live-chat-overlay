import { SETTINGS_LIMITS } from '@core/settings-definitions';
import type { OutlineSettingKey, RootScalarSettingKey } from '@core/settings-schema';

// ── Root setting limits key mapping ──────────────────────────────────────────

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

const OUTLINE_LIMITS_KEY: Record<OutlineSettingKey, keyof typeof SETTINGS_LIMITS> = {
  enabled: 'outlineOpacity', // boolean, not used for limits but kept for type safety
  widthPx: 'outlineWidthPx',
  blurPx: 'outlineBlurPx',
  opacity: 'outlineOpacity',
};

// ── Root settings that use rounded integers ─────────────────────────────────

const ROOT_ROUNDED_KEYS = new Set<RootScalarSettingKey>([
  'maxConcurrentMessages',
  'maxMessagesPerSecond',
  'minTextLength',
  'laneSpacing',
]);

// ── UI input scaling for percentage-based settings ──────────────────────────

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

// ── Normalization ───────────────────────────────────────────────────────────

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

// ── Public API ──────────────────────────────────────────────────────────────

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
  key: OutlineSettingKey,
  value: unknown,
  fallback: number
): number => {
  const limitsKey = OUTLINE_LIMITS_KEY[key];
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
  key: OutlineSettingKey
): Readonly<{ min: number; max: number; step: number }> => {
  const limitsKey = OUTLINE_LIMITS_KEY[key];
  const limits = SETTINGS_LIMITS[limitsKey];

  return {
    min: limits.min,
    max: limits.max,
    step: limits.step,
  };
};
