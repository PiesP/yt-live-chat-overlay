// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Browser Translation Service
 *
 * Wraps the Chrome built-in Translator API (Chrome 138+) for real-time
 * chat message translation. Falls back gracefully when unavailable.
 *
 * Design notes:
 * - One translator instance per language pair (cached after creation).
 * - `Translator.create()` requires user activation (click/keypress within
 *   5 seconds). Call `onUserActivation()` from settings dialog save/close
 *   events to trigger model downloads.
 * - Sequential translations only — a large text blocks subsequent calls.
 *   For chat (short messages), this is acceptable.
 */

import { createLogger } from '@core/logging';

const log = createLogger('TranslationService');

// ── Type declarations for Chrome Translator API ───────────────────────────

interface TranslatorInstance {
  translate(text: string): Promise<string>;
}

interface TranslatorCreateOptions {
  sourceLanguage: string;
  targetLanguage: string;
  monitor?: (monitor: EventTarget) => void;
}

type TranslatorAvailability = 'available' | 'downloadable' | 'unavailable';

interface TranslatorStatic {
  create(options: TranslatorCreateOptions): Promise<TranslatorInstance>;
  availability(options: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<TranslatorAvailability>;
}

declare global {
  const Translator: TranslatorStatic | undefined;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Translation service state.
 * Created once per renderer lifecycle.
 */
export class TranslationService {
  private translator: TranslatorInstance | null = null;
  private currentTarget: string | null = null;
  private currentSource: string | null = null;
  private enabled = false;
  /** Serializes configure() calls to prevent overlapping translator creation. */
  private configurePromise: Promise<void> | null = null;

  /** Call this when settings change to reconfigure the translator. */
  async configure(settings: {
    enabled: boolean;
    service: string;
    source: string;
    target: string;
  }): Promise<void> {
    this.enabled = settings.enabled && settings.service === 'auto';
    if (!this.enabled) {
      this.translator = null;
      this.currentTarget = null;
      this.currentSource = null;
      return;
    }

    if (typeof Translator === 'undefined') {
      log.warn('Chrome Translator API not available (requires Chrome 138+). Translation disabled.');
      this.enabled = false;
      return;
    }

    if (settings.target === this.currentTarget && settings.source === this.currentSource) return;

    // Serialize: wait for any in-flight configure before starting a new one.
    if (this.configurePromise) {
      await this.configurePromise;
      // Re-check no-op after the previous call completed.
      if (settings.target === this.currentTarget && settings.source === this.currentSource) return;
    }

    this.configurePromise = this.doConfigure(settings.source, settings.target);
    try {
      await this.configurePromise;
    } finally {
      this.configurePromise = null;
    }
  }

  private async doConfigure(sourceLanguage: string, targetLanguage: string): Promise<void> {
    if (typeof Translator === 'undefined') return;
    try {
      const availability = await Translator.availability({
        sourceLanguage,
        targetLanguage,
      });

      if (availability !== 'available') {
        log.info(`Translator model for →${targetLanguage}: ${availability}. Waiting for download.`);
        this.translator = null;
        this.currentTarget = null;
        return;
      }

      this.translator = await Translator.create({
        sourceLanguage,
        targetLanguage,
      });
      this.currentTarget = targetLanguage;
      this.currentSource = sourceLanguage;
      log.info(`Translator ready: ${sourceLanguage} → ${targetLanguage}`);
    } catch (err) {
      log.error('Failed to create translator:', err);
      this.enabled = false;
      this.translator = null;
    }
  }

  /** Check if the browser supports the Translator API. */
  static isSupported(): boolean {
    return typeof Translator !== 'undefined';
  }

  /** Whether translation is currently active. */
  get isActive(): boolean {
    return this.enabled && this.translator !== null;
  }

  /**
   * Translate text. Returns the translation or null on failure.
   * Sequential — one call at a time.
   */
  async translate(text: string): Promise<string | null> {
    if (!this.translator) return null;
    if (!text.trim()) return text;

    try {
      const result = await this.translator.translate(text);
      return result;
    } catch (err) {
      log.debug('Translation failed:', err);
      return null;
    }
  }

  destroy(): void {
    this.translator = null;
    this.currentTarget = null;
    this.enabled = false;
  }
}
