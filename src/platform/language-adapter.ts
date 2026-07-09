// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Platform language detection — single function.
 *
 * Returns the browser UI language from chrome.i18n when available,
 * or undefined in other environments.
 */

/**
 * Detect the browser's UI language via chrome.i18n.getUILanguage().
 * Returns undefined when chrome.i18n is unavailable (userscript/web context).
 */
export function getUILanguage(): string | undefined {
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage) {
      return chrome.i18n.getUILanguage();
    }
    return undefined;
  } catch {
    return undefined;
  }
}
