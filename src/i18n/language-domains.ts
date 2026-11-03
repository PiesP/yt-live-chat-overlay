// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import {
  type Locale,
  normalizeLocale,
  SUPPORTED_LOCALES,
  type TextDirection,
} from '@piesp/browser-core/locale';

// Each tuple owns a product domain and its presentation order. Equal membership today
// does not couple shipped UI translations to the Translator's selectable languages.
export const INTERFACE_LANGUAGE_CODES = [
  'en',
  'ko',
  'ja',
  'es',
  'zh-CN',
  'ar',
] as const satisfies readonly Locale[];
export const TRANSLATION_SOURCE_CODES = [
  'en',
  'ko',
  'ja',
  'es',
  'zh-CN',
  'ar',
] as const satisfies readonly Locale[];
export const TRANSLATION_TARGET_CODES = [
  'ko',
  'en',
  'ja',
  'es',
  'zh-CN',
  'ar',
] as const satisfies readonly Locale[];

export type InterfaceLanguage = (typeof INTERFACE_LANGUAGE_CODES)[number];
export type TranslationSourceCode = (typeof TRANSLATION_SOURCE_CODES)[number];
export type TranslationTargetCode = (typeof TRANSLATION_TARGET_CODES)[number];
export type LanguageSetting = 'auto' | InterfaceLanguage;
export type TranslationSource = 'auto' | TranslationSourceCode;
export type TranslationTarget = 'auto' | TranslationTargetCode;
export type TranslationLanguage = (
  | typeof TRANSLATION_SOURCE_CODES
  | typeof TRANSLATION_TARGET_CODES
)[number];
/** Detector-only scripts remain distinct from selectable persisted languages. */
export type TranslationSourceLanguage = TranslationSourceCode | 'zh-Hans' | 'zh-Hant';

export const INTERFACE_LANGUAGE_FALLBACK = 'en' satisfies InterfaceLanguage;
export const TRANSLATION_SOURCE_FALLBACK = 'en' satisfies TranslationSourceCode;
export const TRANSLATION_TARGET_FALLBACK = 'en' satisfies TranslationTargetCode;

export function isInterfaceLanguage(value: unknown): value is InterfaceLanguage {
  return INTERFACE_LANGUAGE_CODES.some((code) => code === value);
}
export function isTranslationSourceCode(value: unknown): value is TranslationSourceCode {
  return TRANSLATION_SOURCE_CODES.some((code) => code === value);
}
export function isTranslationTargetCode(value: unknown): value is TranslationTargetCode {
  return TRANSLATION_TARGET_CODES.some((code) => code === value);
}
export function isLanguageSetting(value: unknown): value is LanguageSetting {
  return value === 'auto' || isInterfaceLanguage(value);
}
export function isTranslationSource(value: unknown): value is TranslationSource {
  return value === 'auto' || isTranslationSourceCode(value);
}
export function isTranslationTarget(value: unknown): value is TranslationTarget {
  return value === 'auto' || isTranslationTargetCode(value);
}

function localeInfo(code: Locale): (typeof SUPPORTED_LOCALES)[number] {
  const info = SUPPORTED_LOCALES.find((entry) => entry.code === code);
  if (!info) throw new Error(`Missing shared locale metadata: ${code}`);
  return info;
}

function options<T extends Locale>(
  codes: readonly T[],
  autoLabel: string
): ReadonlyArray<[T | 'auto', string]> {
  return [
    ['auto', autoLabel],
    ...codes.map((code): [T, string] => [code, code === 'zh-CN' ? '中文' : localeInfo(code).name]),
  ];
}

export const INTERFACE_LANGUAGE_OPTIONS = options(
  INTERFACE_LANGUAGE_CODES,
  'translation.languageAuto'
);
export const TRANSLATION_SOURCE_OPTIONS = options(
  TRANSLATION_SOURCE_CODES,
  'translation.sourceAuto'
);
export const TRANSLATION_TARGET_OPTIONS = options(
  TRANSLATION_TARGET_CODES,
  'translation.languageAuto'
);

export function getInterfaceLanguageDirection(language: InterfaceLanguage): TextDirection {
  return localeInfo(language).dir;
}

/** Normalize browser hints one at a time, skipping shared locales outside this product domain. */
export function resolvePreferredLanguage<T extends Locale>(
  candidates: readonly (string | undefined)[],
  domain: readonly T[],
  fallback: T
): T {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeLocale(candidate);
    const supported = domain.find((code) => code === normalized);
    if (supported) return supported;
  }
  return fallback;
}
