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
export class ChromeLanguageAdapter implements LanguageAdapter {
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

// ── DefaultLanguageAdapter ─────────────────────────────────────────────────

/**
 * Fallback adapter for environments without chrome.i18n.
 * Returns undefined so the caller can fall back to navigator.language.
 */
export class DefaultLanguageAdapter implements LanguageAdapter {
  getUILanguage(): string | undefined {
    return undefined;
  }
}

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

  cachedAdapter = new DefaultLanguageAdapter();
  return cachedAdapter;
}
