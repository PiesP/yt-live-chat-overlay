import { SETTINGS_LIMITS } from '@core/settings-definitions';
import {
  OUTLINE_SETTING_DEFINITIONS,
  type OutlineSettingKey,
  ROOT_SETTING_DEFINITIONS,
  type RootScalarSettingKey,
} from '@core/settings-schema';

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

const getRootNumericInputOptions = (key: RootScalarSettingKey): NumericInputOptions =>
  ROOT_NUMERIC_INPUT_OPTIONS[key] ?? {};

const getOutlineNumericInputOptions = (_key: OutlineSettingKey): NumericInputOptions => ({});

const getDefinitionLimitsKey = (
  definition:
    | (typeof ROOT_SETTING_DEFINITIONS)[RootScalarSettingKey]
    | (typeof OUTLINE_SETTING_DEFINITIONS)[OutlineSettingKey]
): keyof typeof SETTINGS_LIMITS | null =>
  'limitsKey' in definition ? (definition.limitsKey ?? null) : null;

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
  const options = getRootNumericInputOptions(key);
  const scaledValue = scaleUiValue(value, options.scale ?? 1);
  return options.precision === undefined ? scaledValue : scaledValue.toFixed(options.precision);
};

export const formatOutlineNumericSettingForInput = (
  key: OutlineSettingKey,
  value: number
): string | number => {
  const options = getOutlineNumericInputOptions(key);
  const scaledValue = scaleUiValue(value, options.scale ?? 1);
  return options.precision === undefined ? scaledValue : scaledValue.toFixed(options.precision);
};

export const normalizeRootNumericInputValue = (
  key: RootScalarSettingKey,
  value: unknown,
  fallback: number
): number => {
  const definition = ROOT_SETTING_DEFINITIONS[key];
  const limitsKey = getDefinitionLimitsKey(definition);
  if (!limitsKey) {
    return fallback;
  }

  return normalizeNumericValue(
    value,
    fallback,
    SETTINGS_LIMITS[limitsKey],
    definition.kind === 'rounded-number',
    getRootNumericInputOptions(key).scale
  );
};

export const normalizeOutlineNumericInputValue = (
  key: OutlineSettingKey,
  value: unknown,
  fallback: number
): number => {
  const definition = OUTLINE_SETTING_DEFINITIONS[key];
  const limitsKey = getDefinitionLimitsKey(definition);
  if (!limitsKey) {
    return fallback;
  }

  return normalizeNumericValue(
    value,
    fallback,
    SETTINGS_LIMITS[limitsKey],
    false,
    getOutlineNumericInputOptions(key).scale
  );
};

export const getRootNumericInputAttributes = (
  key: RootScalarSettingKey
): Readonly<{ min: number; max: number; step: number }> => {
  const definition = ROOT_SETTING_DEFINITIONS[key];
  const limitsKey = getDefinitionLimitsKey(definition);
  if (!limitsKey) {
    throw new TypeError('Setting does not define numeric limits.');
  }

  const limits = SETTINGS_LIMITS[limitsKey];
  const scale = getRootNumericInputOptions(key).scale ?? 1;

  return {
    min: scaleUiValue(limits.min, scale),
    max: scaleUiValue(limits.max, scale),
    step: scaleUiValue(limits.step, scale),
  };
};

export const getOutlineNumericInputAttributes = (
  key: OutlineSettingKey
): Readonly<{ min: number; max: number; step: number }> => {
  const definition = OUTLINE_SETTING_DEFINITIONS[key];
  const limitsKey = getDefinitionLimitsKey(definition);
  if (!limitsKey) {
    throw new TypeError('Setting does not define numeric limits.');
  }

  const limits = SETTINGS_LIMITS[limitsKey];
  const scale = getOutlineNumericInputOptions(key).scale ?? 1;

  return {
    min: scaleUiValue(limits.min, scale),
    max: scaleUiValue(limits.max, scale),
    step: scaleUiValue(limits.step, scale),
  };
};
