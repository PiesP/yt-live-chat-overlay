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
import { AUTHOR_BACKGROUND_ALPHA_HEX, DEFAULT_SETTINGS, migrateSettings } from '@settings/defaults';
import { resolveLimits, resolveOutlineLimits } from '@settings/limits';
import {
  AUTHOR_COLOR_KEYS,
  ROOT_SETTING_META,
  type RootScalarSettingKey,
  SHOW_AUTHOR_KEYS,
  VISUAL_ROOT_KEYS,
} from '@settings/meta';

// ── Re-exports for backward compatibility ───────────────────────────────────────
export {
  AUTHOR_BACKGROUND_ALPHA_HEX,
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  STORAGE_KEY,
} from '@settings/defaults';
export type { OutlineSettingKey, RootNumericSettingKey } from '@settings/limits';
export {
  getOutlineDisplayScale,
  OUTLINE_NUMERIC_KEYS,
  resolveLimits,
  resolveOutlineLimits,
} from '@settings/limits';
export type { RootScalarSettingKey } from '@settings/meta';
export { AUTHOR_COLOR_KEYS, getRootDisplayMeta } from '@settings/meta';

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

const MAX_FONT_FAMILY_LENGTH = 256;
const UNSAFE_FONT_FAMILY_CHARS = /[;{}\u0000-\u001f\u007f]/;

export function isSafeFontFamily(value: string): boolean {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_FONT_FAMILY_LENGTH ||
    UNSAFE_FONT_FAMILY_CHARS.test(trimmed)
  ) {
    return false;
  }
  return (
    typeof CSS === 'undefined' ||
    typeof CSS.supports !== 'function' ||
    CSS.supports('font-family', trimmed)
  );
}

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
const WHOLE_MEGABYTE_SETTING_KEYS = new Set<keyof OverlaySettings>([
  'emojiCacheMb',
  'photoCacheMb',
  'stickerCacheMb',
  'textCacheMb',
]);

// ── Color validation ────────────────────────────────────────────────────────────

/**
 * Matches hex color strings: #RGB, #RRGGBB, #RGBA, #RRGGBBAA.
 */
export const isColorValue = (value: unknown): value is string =>
  typeof value === 'string' && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6,8})$/i.test(value);

export function clampNumber(
  value: unknown,
  fallback: number,
  limits: Readonly<{ min: number; max: number }>
): number {
  const numericValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, numericValue));
}

export const cloneSettings = (settings: Readonly<OverlaySettings>): OverlaySettings => ({
  ...settings,
  showAuthor: { ...settings.showAuthor },
  colors: { ...settings.colors },
  backgroundColors: { ...settings.backgroundColors },
  outline: { ...settings.outline },
});

/**
 * Canonicalize a background color to #RRGGBBAA. RGB inputs receive the
 * product's fixed translucent alpha. Only fully transparent alpha is preserved.
 */
export function normalizeBackgroundColor(value: unknown, fallback: string): string {
  if (!isColorValue(value)) return fallback;

  const hex = value.slice(1);
  let rgba: string;
  if (hex.length === 3) {
    rgba = `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}${AUTHOR_BACKGROUND_ALPHA_HEX}`;
  } else if (hex.length === 4) {
    const alpha = `${hex[3]}${hex[3]}`.toUpperCase() === '00' ? '00' : AUTHOR_BACKGROUND_ALPHA_HEX;
    rgba = `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}${alpha}`;
  } else if (hex.length === 6) {
    rgba = `${hex}${AUTHOR_BACKGROUND_ALPHA_HEX}`;
  } else {
    const alpha = hex.slice(6).toUpperCase() === '00' ? '00' : AUTHOR_BACKGROUND_ALPHA_HEX;
    rgba = `${hex.slice(0, 6)}${alpha}`;
  }
  return `#${rgba.toUpperCase()}`;
}

// ── Normalization ───────────────────────────────────────────────────────────────

const STRING_VALIDATORS: Record<ScalarKeyOf<string>, (v: string) => boolean> = {
  backlogMode: (v) => VALID_BACKLOG_MODES.includes(v as (typeof VALID_BACKLOG_MODES)[number]),
  danmakuMode: (v) => VALID_DANMAKU_MODES.includes(v as (typeof VALID_DANMAKU_MODES)[number]),
  logLevel: (v) => isLogLevel(v),
  fontWeight: (v) => FONT_WEIGHT_VALUES.includes(v as FontWeight),
  fontFamily: (v) => isSafeFontFamily(v),
  authorRateLimit: (v) => AUTHOR_RATE_LIMIT_VALUES.includes(v as AuthorRateLimitPreset),
  language: (v) => LANGUAGE_VALUES.includes(v as LanguageSetting),
  translationService: (v) => TRANSLATION_SERVICE_VALUES.includes(v as TranslationService),
  translationTarget: (v) => TRANSLATION_TARGET_VALUES.includes(v as TranslationTarget),
  translationMode: (v) => TRANSLATION_MODE_VALUES.includes(v as TranslationMode),
  translationSource: (v) => TRANSLATION_SOURCE_VALUES.includes(v as TranslationSource),
};

type ScalarKeyOf<T> = {
  [K in RootScalarSettingKey]: OverlaySettings[K] extends T ? K : never;
}[RootScalarSettingKey];

/** Apply validated scalar settings from `settings` onto `out` in place. */
function mutateScalarSettings(
  out: OverlaySettings,
  settings: Readonly<OverlaySettings>,
  defaults: OverlaySettings
): void {
  const setString = <K extends ScalarKeyOf<string>>(key: K, value: OverlaySettings[K]): void => {
    out[key] = value;
  };
  for (const key of Object.keys(ROOT_SETTING_META) as RootScalarSettingKey[]) {
    const meta = ROOT_SETTING_META[key];
    const raw: unknown = settings[key];
    if (meta.type === 'boolean') {
      if (typeof raw === 'boolean') {
        // The mapped metadata contract ties this tag to boolean setting keys.
        out[key as ScalarKeyOf<boolean>] = raw;
      }
    } else if (meta.type === 'number') {
      const numericKey = key as ScalarKeyOf<number>;
      const clamped = clampNumber(raw, defaults[numericKey], resolveLimits(numericKey));
      out[numericKey] = WHOLE_MEGABYTE_SETTING_KEYS.has(numericKey) ? Math.round(clamped) : clamped;
    } else {
      const validator = STRING_VALIDATORS[key as ScalarKeyOf<string>];
      if (typeof raw === 'string' && validator(raw)) {
        // Runtime validators refine the string union for this metadata key.
        setString(key as ScalarKeyOf<string>, raw as OverlaySettings[ScalarKeyOf<string>]);
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
  mutateScalarSettings(out, settings, d);

  for (const key of SHOW_AUTHOR_KEYS) {
    out.showAuthor[key] = pickBool(settings.showAuthor[key], d.showAuthor[key]);
  }

  for (const key of AUTHOR_COLOR_KEYS) {
    out.colors[key] = isColorValue(settings.colors[key]) ? settings.colors[key] : d.colors[key];
    out.backgroundColors[key] = normalizeBackgroundColor(
      settings.backgroundColors[key],
      d.backgroundColors[key]
    );
  }

  out.outline.enabled = pickBool(settings.outline.enabled, d.outline.enabled);
  for (const key of ['widthPx', 'opacity'] as const) {
    out.outline[key] = clampNumber(
      settings.outline[key],
      d.outline[key],
      resolveOutlineLimits(key)
    );
  }

  // ── Cross-field pair constraints ──────────────────────────────────────────
  // Individual clamping does not guarantee min ≤ max for related settings.
  // Swap inverted pairs so consumers (Math.min/max guards, threshold checks)
  // always see a valid min-max relationship.
  const PAIR_CONSTRAINTS = [
    ['fontMinSize', 'fontMaxSize'],
    ['minPollIntervalMs', 'maxPollIntervalMs'],
    ['scrollDurationMinMs', 'scrollDurationMaxMs'],
  ] as const;

  for (const [minKey, maxKey] of PAIR_CONSTRAINTS) {
    const minVal = out[minKey];
    const maxVal = out[maxKey];
    if (minVal > maxVal) {
      out[minKey] = maxVal;
      out[maxKey] = minVal;
    }
  }

  return out;
};

export function applySettingsPatch(
  base: Readonly<OverlaySettings>,
  partial: Partial<OverlaySettings>
): OverlaySettings {
  const merged: OverlaySettings = {
    ...base,
    ...partial,
    showAuthor: { ...base.showAuthor, ...partial.showAuthor },
    colors: { ...base.colors, ...partial.colors },
    backgroundColors: { ...base.backgroundColors, ...partial.backgroundColors },
    outline: { ...base.outline, ...partial.outline },
  };
  return normalizeSettings(merged);
}

/** Keep only the fields deliberately changed in a full settings form. */
export function changedSettingsPatch(
  baseline: Readonly<OverlaySettings>,
  current: Readonly<OverlaySettings>
): Partial<OverlaySettings> {
  const equal = (left: unknown, right: unknown): boolean =>
    left === right ||
    (typeof left === 'string' &&
      typeof right === 'string' &&
      /^#[0-9a-f]+$/i.test(left) &&
      /^#[0-9a-f]+$/i.test(right) &&
      left.toLowerCase() === right.toLowerCase());
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(current) as (keyof OverlaySettings)[]) {
    const next = current[key];
    const previous = baseline[key];
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
      const nested: Record<string, unknown> = {};
      const oldValues = (previous ?? {}) as Record<string, unknown>;
      for (const child of Object.keys(next)) {
        const value = (next as Record<string, unknown>)[child];
        if (!equal(value, oldValues[child])) nested[child] = value;
      }
      if (Object.keys(nested).length > 0) changed[key] = nested;
    } else if (!equal(next, previous)) {
      changed[key] = next;
    }
  }
  return changed as Partial<OverlaySettings>;
}

/** Combine explicit edits without replacing unrelated nested fields. */
export function combineSettingsPatches(
  previous: Partial<OverlaySettings>,
  next: Partial<OverlaySettings>
): Partial<OverlaySettings> {
  const merged = { ...previous, ...next };
  if (previous.showAuthor || next.showAuthor)
    merged.showAuthor = {
      ...previous.showAuthor,
      ...next.showAuthor,
    } as OverlaySettings['showAuthor'];
  if (previous.colors || next.colors)
    merged.colors = { ...previous.colors, ...next.colors } as OverlaySettings['colors'];
  if (previous.backgroundColors || next.backgroundColors)
    merged.backgroundColors = {
      ...previous.backgroundColors,
      ...next.backgroundColors,
    } as OverlaySettings['backgroundColors'];
  if (previous.outline || next.outline)
    merged.outline = { ...previous.outline, ...next.outline } as OverlaySettings['outline'];
  return merged;
}

export function normalizeStoredSettings(
  stored: Record<string, unknown> | null | undefined
): OverlaySettings {
  // Reject null, undefined, and arrays (arrays pass !stored as false)
  if (!stored || Array.isArray(stored)) return cloneSettings(DEFAULT_SETTINGS);
  const migrated = migrateSettings(stored);
  return applySettingsPatch(cloneSettings(DEFAULT_SETTINGS), migrated as Partial<OverlaySettings>);
}

export function shouldResetRendererForSettingsChange(
  previous: Readonly<OverlaySettings>,
  next: Readonly<OverlaySettings>
): boolean {
  if (VISUAL_ROOT_KEYS.some((key) => previous[key] !== next[key])) return true;
  if (SHOW_AUTHOR_KEYS.some((key) => previous.showAuthor[key] !== next.showAuthor[key]))
    return true;
  if (AUTHOR_COLOR_KEYS.some((key) => previous.colors[key] !== next.colors[key])) return true;
  return (['enabled', 'widthPx', 'opacity'] as const).some(
    (key) => previous.outline[key] !== next.outline[key]
  );
}
