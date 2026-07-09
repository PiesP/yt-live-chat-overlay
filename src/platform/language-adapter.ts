// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Platform language adapter implementations.
 *
 * Each platform provides the browser's UI language hint via LanguageAdapter.
 * Core modules depend only on the interface, never on chrome.* directly.
 */

import type { LanguageAdapter } from '@platform/types';

// ── ChromeLanguageAdapter ──────────────────────────────────────────────────

/**
 * Uses chrome.i18n.getUILanguage() to determine the browser UI language.
 * Available only in Chrome extension contexts.
 */
class ChromeLanguageAdapter implements LanguageAdapter {
  getUILanguage(): string | undefined {
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage) {
        return chrome.i18n.getUILanguage();
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}

/** Inline fallback adapter that always returns undefined. */
const DEFAULT_ADAPTER: LanguageAdapter = { getUILanguage: () => undefined };

// ── Factory ────────────────────────────────────────────────────────────────

let cachedAdapter: LanguageAdapter | null = null;

/**
 * Returns the best available language adapter for the current environment.
 * Priority: chrome.i18n > default (undefined).
 */
export function getLanguageAdapter(): LanguageAdapter {
  if (cachedAdapter) return cachedAdapter;

  if (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage) {
    cachedAdapter = new ChromeLanguageAdapter();
    return cachedAdapter;
  }

  cachedAdapter = DEFAULT_ADAPTER;
  return cachedAdapter;
}

/** Reset cached adapter singleton for test isolation. */
export function resetLanguageAdapter(): void {
  cachedAdapter = null;
}
