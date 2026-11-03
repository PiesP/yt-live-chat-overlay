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
 *   import { t, resolveActiveLanguage } from '@i18n/index';
 *   resolveActiveLanguage('auto');          // at startup
 *   element.textContent = t('app.title'); // in DOM construction
 */

import type { LanguageSetting, TranslationTarget } from '@app-types';
import { AR } from '@i18n/ar';
import { EN } from '@i18n/en';
import { ES } from '@i18n/es';
import { JA } from '@i18n/ja';
import { KO } from '@i18n/ko';
import {
  type InterfaceLanguage,
  INTERFACE_LANGUAGE_CODES,
  INTERFACE_LANGUAGE_FALLBACK,
  resolvePreferredLanguage,
  TRANSLATION_TARGET_CODES,
  type TranslationTargetCode,
  TRANSLATION_TARGET_FALLBACK,
} from '@i18n/language-domains';
import { ZH_CN } from '@i18n/zh-CN';
import type { Locale } from '@piesp/browser-core/locale';
import { getUILanguage as getPlatformUILanguage } from '@platform/language-adapter';

/** Languages with shipped interface translations, independent of Translator support. */
type SupportedLanguage = InterfaceLanguage;

// ── Module-level active language ─────────────────────────────────────────
// Module-level mutable state is intentional here — the active language is
// a singleton that affects all t() calls. This is not a pure function, but
// the pattern is appropriate for a global i18n context.

let activeLanguage: SupportedLanguage = INTERFACE_LANGUAGE_FALLBACK;

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
 * @param getUILang Optional override for platform UI language detection (for testing).
 * @param languages Optional override for navigator.languages (for deterministic
 *   detection — avoids direct global access which breaks referential transparency).
 */
export function detectBrowserLanguage(
  getUILang?: () => string | undefined,
  languages?: readonly string[]
): SupportedLanguage {
  return detectDomainLanguage(
    INTERFACE_LANGUAGE_CODES,
    INTERFACE_LANGUAGE_FALLBACK,
    getUILang,
    languages
  );
}

function detectDomainLanguage<T extends Locale>(
  domain: readonly T[],
  fallback: T,
  getUILang?: () => string | undefined,
  languages?: readonly string[]
): T {
  try {
    const uiLanguage = (getUILang ?? getPlatformUILanguage)();
    const browserLanguages =
      languages ?? (typeof navigator !== 'undefined' ? navigator.languages : undefined);
    const singleLanguage = typeof navigator !== 'undefined' ? navigator.language : undefined;
    return resolvePreferredLanguage(
      [uiLanguage, ...(browserLanguages ?? []), singleLanguage],
      domain,
      fallback
    );
  } catch {
    return fallback;
  }
}

/**
 * Resolve the translation target language.
 * When 'auto', checks the translation-target domain against
 * platform UI language → navigator.languages[] → navigator.language.
 * Returns the concrete TranslationLanguage code for Chrome Translator API.
 */
export function resolveTranslationTarget(target: TranslationTarget): TranslationTargetCode {
  if (target !== 'auto') return target;
  return detectDomainLanguage(TRANSLATION_TARGET_CODES, TRANSLATION_TARGET_FALLBACK);
}

// ── Translations ─────────────────────────────────────────────────────────

type TranslationMap = Record<string, string>;

export const TRANSLATION_MAPS: Record<SupportedLanguage, TranslationMap> = {
  en: EN,

  ko: KO,
  ja: JA,
  es: ES,
  'zh-CN': ZH_CN,
  ar: AR,
};
