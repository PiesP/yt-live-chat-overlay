// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type {
  AuthorRateLimitPreset,
  BacklogMode,
  DanmakuMode,
  FontWeight,
  LanguageSetting,
  LogLevel,
  OverlaySettings,
  TranslationMode,
  TranslationService,
  TranslationSource,
  TranslationTarget,
} from '@app-types';
import { DEFAULT_SETTINGS, migrateSettings } from '@core/settings-defaults';
import { resolveLimits } from '@core/settings-limits';
import {
  AUTHOR_COLOR_KEYS,
  ROOT_SETTING_META,
  SHOW_AUTHOR_KEYS,
  VISUAL_ROOT_KEYS,
} from '@core/settings-meta';

// ── Re-exports for backward compatibility ───────────────────────────────────────
export {
  DEFAULT_SETTINGS,
  migrateSettings,
  SETTINGS_VERSION,
  STORAGE_KEY,
} from '@core/settings-defaults';
export type {
  OutlineSettingKey,
  RootNumericSettingKey,
  SettingsLimitKey,
} from '@core/settings-limits';
export {
  getOutlineDisplayScale,
  OUTLINE_NUMERIC_KEYS,
  resolveLimits,
  resolveOutlineLimits,
} from '@core/settings-limits';
export type { RootScalarSettingKey } from '@core/settings-meta';
export { AUTHOR_COLOR_KEYS, getRootDisplayMeta } from '@core/settings-meta';
// ── End re-exports ──────────────────────────────────────────────────────────────

export const isLogLevel = (value: unknown): value is LogLevel =>
  LOG_LEVEL_VALUES.includes(value as LogLevel);

const VALID_BACKLOG_MODES = [
  'playback',
  'recent',
  'full',
  'none',
] as const satisfies readonly BacklogMode[];
const VALID_DANMAKU_MODES = [
  'scroll',
  'reverse',
  'top',
  'bottom',
] as const satisfies readonly DanmakuMode[];

const AUTHOR_RATE_LIMIT_VALUES = [
  'off',
  'normal',
  'strict',
] as const satisfies readonly AuthorRateLimitPreset[];
const LANGUAGE_VALUES = [
  'auto',
  'en',
  'ko',
  'ja',
  'es',
  'zh-CN',
  'ar',
] as const satisfies readonly LanguageSetting[];
const TRANSLATION_SERVICE_VALUES = ['auto', 'off'] as const satisfies readonly TranslationService[];
const TRANSLATION_TARGET_VALUES = [
  'auto',
  'en',
  'ko',
  'ja',
  'es',
  'zh-CN',
  'ar',
] as const satisfies readonly TranslationTarget[];
const TRANSLATION_SOURCE_VALUES = [
  'auto',
  'en',
  'ko',
  'ja',
  'es',
  'zh-CN',
  'ar',
] as const satisfies readonly TranslationSource[];
const TRANSLATION_MODE_VALUES = ['dual', 'replace'] as const satisfies readonly TranslationMode[];
const FONT_WEIGHT_VALUES = ['normal', 'bold'] as const satisfies readonly FontWeight[];
const LOG_LEVEL_VALUES = ['warn', 'info', 'debug'] as const satisfies readonly LogLevel[];

// ── Color validation ────────────────────────────────────────────────────────────

/**
 * Matches hex color strings: #RGB, #RRGGBB, #RGBA, #RRGGBBAA.
 */
export const isColorValue = (value: unknown): value is string =>
  typeof value === 'string' && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6,8})$/i.test(value);

export const clampNumber = (
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

// ── Normalization ───────────────────────────────────────────────────────────────

const STRING_VALIDATORS: Partial<Record<keyof OverlaySettings, (v: string) => boolean>> = {
  backlogMode: (v) => VALID_BACKLOG_MODES.includes(v as (typeof VALID_BACKLOG_MODES)[number]),
  danmakuMode: (v) => VALID_DANMAKU_MODES.includes(v as (typeof VALID_DANMAKU_MODES)[number]),
  logLevel: (v) => isLogLevel(v),
  fontWeight: (v) => FONT_WEIGHT_VALUES.includes(v as FontWeight),
  fontFamily: (_v) => true,
  authorRateLimit: (v) => AUTHOR_RATE_LIMIT_VALUES.includes(v as AuthorRateLimitPreset),
  language: (v) => LANGUAGE_VALUES.includes(v as LanguageSetting),
  translationService: (v) => TRANSLATION_SERVICE_VALUES.includes(v as TranslationService),
  translationTarget: (v) => TRANSLATION_TARGET_VALUES.includes(v as TranslationTarget),
  translationMode: (v) => TRANSLATION_MODE_VALUES.includes(v as TranslationMode),
  translationSource: (v) => TRANSLATION_SOURCE_VALUES.includes(v as TranslationSource),
};

/**
 * Apply validated scalar settings from `settings` onto `out` (mutating in place).
 * Each key is type-routed via ROOT_SETTING_META, so the assignment is guaranteed
 * to match the target field's declared type. This avoids `as unknown as` while
 * still working around OverlaySettings lacking an index signature.
 */
function mutateScalarSettings(
  out: OverlaySettings,
  settings: Readonly<OverlaySettings>,
  defaults: OverlaySettings
): void {
  const mutableOut = out as unknown as Record<string, unknown>;
  const mutableDefaults = defaults as unknown as Record<string, unknown>;
  for (const key of Object.keys(ROOT_SETTING_META) as (keyof OverlaySettings)[]) {
    const meta = (ROOT_SETTING_META as Record<string, { type: string }>)[key as string];
    const raw = (settings as unknown as Record<string, unknown>)[key as string];
    if (meta?.type === 'boolean') {
      if (typeof raw === 'boolean') {
        mutableOut[key as string] = raw;
      }
    } else if (meta?.type === 'number') {
      const defaultVal = mutableDefaults[key as string];
      if (typeof defaultVal === 'number') {
        mutableOut[key as string] = clampNumber(raw, defaultVal, resolveLimits(key as string));
      }
    } else {
      const validator = STRING_VALIDATORS[key as keyof OverlaySettings];
      if (typeof raw === 'string' && validator?.(raw)) {
        mutableOut[key as string] = raw;
      }
    }
  }
}

const normalizeSettings = (settings: Readonly<OverlaySettings>): OverlaySettings => {
  const d = DEFAULT_SETTINGS;
  // Start from defaults, then overlay valid values from the input
  const out = cloneSettings(DEFAULT_SETTINGS);

  const pickBool = (v: unknown, fallback: boolean): boolean =>
    typeof v === 'boolean' ? v : fallback;

  // Root scalar settings: type-routed via ROOT_SETTING_META.
  // Write into a mutable copy since OverlaySettings has no index signature.
  // Each write is guarded by the type-checking if/else branches inside the helper.
  mutateScalarSettings(out, settings, d);

  for (const key of SHOW_AUTHOR_KEYS) {
    out.showAuthor[key] = pickBool(settings.showAuthor[key], d.showAuthor[key]);
  }

  for (const key of AUTHOR_COLOR_KEYS) {
    out.colors[key] = isColorValue(settings.colors[key]) ? settings.colors[key] : d.colors[key];
  }

  out.outline.enabled = pickBool(settings.outline.enabled, d.outline.enabled);
  for (const key of ['widthPx', 'opacity'] as const) {
    (out.outline as unknown as Record<string, unknown>)[key] = clampNumber(
      settings.outline[key],
      d.outline[key],
      resolveLimits(key)
    );
  }

  return out;
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
  stored: Record<string, unknown> | null | undefined
): OverlaySettings => {
  if (!stored) return cloneSettings(DEFAULT_SETTINGS);
  const migrated = migrateSettings(stored);
  return applySettingsPatch(cloneSettings(DEFAULT_SETTINGS), migrated as Partial<OverlaySettings>);
};

export const shouldResetRendererForSettingsChange = (
  previous: Readonly<OverlaySettings>,
  next: Readonly<OverlaySettings>
): boolean => {
  if (VISUAL_ROOT_KEYS.some((key) => previous[key] !== next[key])) return true;
  if (SHOW_AUTHOR_KEYS.some((key) => previous.showAuthor[key] !== next.showAuthor[key]))
    return true;
  if (AUTHOR_COLOR_KEYS.some((key) => previous.colors[key] !== next.colors[key])) return true;
  return (['enabled', 'widthPx', 'opacity'] as const).some(
    (key) => previous.outline[key] !== next.outline[key]
  );
};
