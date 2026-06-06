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
  const map = TRANSLATIONS[activeLanguage];
  if (!map) return text;
  return map[text] ?? text;
}

/** Return the currently active language code. */
export function getActiveLanguage(): SupportedLanguage {
  return activeLanguage;
}

// ── Browser language detection ────────────────────────────────────────────

const LANGUAGE_PATTERNS: ReadonlyArray<[SupportedLanguage, RegExp]> = [
  ['ko', /^ko\b/i],
  ['ja', /^ja\b/i],
  ['es', /^es\b/i],
  ['zh', /^zh\b/i],
];

function detectBrowserLanguage(): SupportedLanguage {
  try {
    const nav = navigator.language;
    if (!nav) return 'en';
    for (const [lang, re] of LANGUAGE_PATTERNS) {
      if (re.test(nav)) return lang;
    }
    return 'en';
  } catch {
    return 'en';
  }
}

/**
 * Resolve the translation target language.
 * When 'auto', detects the browser language via navigator.language.
 * Returns the concrete TranslationLanguage code for Chrome Translator API.
 */
export function resolveTranslationTarget(target: TranslationTarget): SupportedLanguage {
  if (target !== 'auto') return target;
  return detectBrowserLanguage();
}

// ── Translations ─────────────────────────────────────────────────────────

type TranslationMap = Record<string, string>;

import { ES } from './i18n/es';
import { JA } from './i18n/ja';
import { KO } from './i18n/ko';
import { ZH } from './i18n/zh';

const TRANSLATIONS: Record<SupportedLanguage, TranslationMap> = {
  en: {}, // English: no translation needed (strings are the keys)
  ko: KO,
  ja: JA,
  es: ES,
  zh: ZH,
};

// Export translation maps for consistency validation (test-only, not used at runtime)
export const TRANSLATION_MAPS: Record<string, TranslationMap> = {
  ko: KO,
  ja: JA,
  es: ES,
  zh: ZH,
};
