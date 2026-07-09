// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Platform translation adapter — abstracts the Chrome built-in Translator API
 * (Chrome 138+) behind a platform-neutral accessor.
 *
 * Core modules never reference the global `Translator` directly; they import
 * this adapter instead, making the code testable without requiring the actual
 * browser API to be present.
 */

// ── Type declarations for Chrome Translator API ───────────────────────────

export interface TranslatorDownloadEvent extends Event {
  loaded: number;
  total: number;
}

export interface TranslatorInstance {
  translate(text: string): Promise<string>;
  destroy(): void;
}

export interface TranslatorCreateOptions {
  sourceLanguage: string;
  targetLanguage: string;
  monitor?: (monitor: EventTarget) => void;
}

export type TranslatorAvailability = 'available' | 'downloadable' | 'unavailable';

export interface TranslatorStatic {
  create(options: TranslatorCreateOptions): Promise<TranslatorInstance>;
  availability(options: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<TranslatorAvailability>;
}

declare global {
  // eslint-disable-next-line no-var
  var Translator: TranslatorStatic | undefined;
}

// ── Platform adapter ──────────────────────────────────────────────────────

/**
 * Return the Chrome Translator API global, or undefined if unavailable.
 * Core modules should import and call this function instead of referencing
 * the global `Translator` directly, which makes the code testable.
 */
export function getTranslator(): typeof Translator | undefined {
  return typeof Translator !== 'undefined' ? Translator : undefined;
}

/** Whether the browser supports the Translator API. */
export function isTranslationSupported(): boolean {
  return typeof Translator !== 'undefined';
}
