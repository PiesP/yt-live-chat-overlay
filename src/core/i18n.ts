// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Lightweight i18n module — zero dependencies.
 *
 * Uses the gettext model: English strings serve as both fallback values
 * and translation lookup keys.  Unknown keys fall through unchanged.
 *
 * Language auto-detection: `navigator.language` is matched against the
 * supported set; unknown locales fall back to English.
 *
 * Usage:
 *   import { t, resolveActiveLanguage } from '@core/i18n';
 *   resolveActiveLanguage('auto');          // at startup
 *   element.textContent = t('Chat Overlay'); // in DOM construction
 */

import type { LanguageSetting, TranslationLanguage, TranslationTarget } from '@app-types';
import { getLanguageAdapter } from '@platform/language-adapter';
import type { LanguageAdapter } from '@platform/types';

/** Language codes with actual translations (excluding 'auto'). Reuses TranslationLanguage from app-types. */
type SupportedLanguage = TranslationLanguage;

// ── Module-level active language ─────────────────────────────────────────

let activeLanguage: SupportedLanguage = 'en';

/**
 * Resolve and set the active language.
 * Call once at startup and whenever the language setting changes.
 */
export function resolveActiveLanguage(setting: LanguageSetting): void {
  activeLanguage = setting === 'auto' ? detectBrowserLanguage() : setting;
}

/**
 * Look up a translation for the given English text.
 * Returns the translation if found; otherwise returns the text unchanged.
 * The English source strings serve as both fallback and lookup key.
 */
export function t(text: string): string {
  const map = TRANSLATION_MAPS[activeLanguage];
  if (!map) return text;
  return map[text] ?? text;
}

/** Return the currently active language code. */
export function getActiveLanguage(): SupportedLanguage {
  return activeLanguage;
}

// ── Browser language detection ────────────────────────────────────────────

const LANGUAGE_PATTERNS: ReadonlyArray<[SupportedLanguage, RegExp]> = [
  ['en', /^en\b/i],
  ['ko', /^ko\b/i],
  ['ja', /^ja\b/i],
  ['es', /^es\b/i],
  ['zh-CN', /^(?:zh-TW|zh-HK|zh)\b/i],
  ['ar', /^ar\b/i],
];

/**
 * Iterate over an array of language codes and return the first supported match.
 */
function matchLanguages(languages: string[]): SupportedLanguage {
  for (const lang of languages) {
    for (const [code, re] of LANGUAGE_PATTERNS) {
      if (re.test(lang)) return code;
    }
  }
  return 'en';
}

/**
 * Detect the best supported language from the browser environment.
 *
 * Priority order:
 * 1. Platform-provided UI language hint (chrome.i18n.getUILanguage() in extension
 *    context, undefined otherwise) — most accurate for extension context.
 * 2. `navigator.languages[]` — user's ordered accept-language list (covers
 *    cases like "pt-BR" → fall through earlier entries → "en").
 * 3. `navigator.language` — single fallback (legacy / userscript).
 *
 * @param adapter Optional LanguageAdapter override (for testing). Uses the
 *                platform default when not provided.
 */
export function detectBrowserLanguage(adapter?: LanguageAdapter): SupportedLanguage {
  try {
    // 1. Platform-provided UI language (extension context only)
    const langAdapter = adapter ?? getLanguageAdapter();
    const uiLanguage = langAdapter.getUILanguage();
    if (uiLanguage) {
      return matchLanguages([uiLanguage]);
    }

    // 2. Navigator languages array (user preference order)
    if (typeof navigator !== 'undefined' && navigator.languages && navigator.languages.length > 0) {
      return matchLanguages([...navigator.languages]);
    }

    // 3. Single-language fallback
    if (typeof navigator !== 'undefined' && navigator.language) {
      return matchLanguages([navigator.language]);
    }

    return 'en';
  } catch {
    return 'en';
  }
}

/**
 * Resolve the translation target language.
 * When 'auto', delegates to detectBrowserLanguage() which checks
 * platform UI language → navigator.languages[] → navigator.language.
 * Returns the concrete TranslationLanguage code for Chrome Translator API.
 */
export function resolveTranslationTarget(target: TranslationTarget): SupportedLanguage {
  if (target !== 'auto') return target;
  return detectBrowserLanguage();
}

// ── Translations ─────────────────────────────────────────────────────────

type TranslationMap = Record<string, string>;

import { AR } from '@core/i18n/ar';
import { ES } from '@core/i18n/es';
import { JA } from '@core/i18n/ja';
import { KO } from '@core/i18n/ko';
import { ZH_CN } from '@core/i18n/zh-CN';

export const TRANSLATION_MAPS: Record<SupportedLanguage, TranslationMap> = {
  en: {}, // English: no translation needed (strings are the keys)
  ko: KO,
  ja: JA,
  es: ES,
  'zh-CN': ZH_CN,
  ar: AR,
};
