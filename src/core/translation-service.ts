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
 *   5 seconds). The first successful create typically happens when the
 *   user clicks Save in the settings dialog.
 * - Sequential translations only — a large text blocks subsequent calls.
 *   For chat (short messages), this is acceptable.
 */
import { createLogger } from '@core/logging';

const log = createLogger('TranslationService');

// ── Type declarations for Chrome Translator API ───────────────────────────

interface TranslatorDownloadEvent extends Event {
  loaded: number;
  total: number;
}

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
  // eslint-disable-next-line no-var
  var Translator: TranslatorStatic | undefined;
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
  /** Pending source/target from the most recent configure() for retry. */
  private pendingSource: string | null = null;
  private pendingTarget: string | null = null;

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
      this.pendingSource = null;
      this.pendingTarget = null;
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

  /**
   * Re-attempt translator creation with the last configured language pair.
   * Call this from a user-activation context (e.g. click handler) when
   * the previous configure() failed because the model was still downloading
   * or user activation was missing.
   */
  async onUserActivation(): Promise<void> {
    if (!this.enabled) return;
    if (!this.pendingSource || !this.pendingTarget) return;
    if (typeof Translator === 'undefined') return;

    // Don't stack retries — if a configure is already in-flight, let it finish.
    if (this.configurePromise) return;

    log.info('Retrying translator creation via user activation…');
    this.configurePromise = this.doConfigure(this.pendingSource, this.pendingTarget);
    try {
      await this.configurePromise;
    } finally {
      this.configurePromise = null;
    }
  }

  private async doConfigure(sourceLanguage: string, targetLanguage: string): Promise<void> {
    if (typeof Translator === 'undefined') return;
    this.pendingSource = sourceLanguage;
    this.pendingTarget = targetLanguage;

    try {
      const availability = await Translator.availability({
        sourceLanguage,
        targetLanguage,
      });

      // 'unavailable' means the language pair is not supported at all.
      // Don't attempt to create — it would fail immediately.
      if (availability === 'unavailable') {
        log.warn(
          `Translator not available for ${sourceLanguage}→${targetLanguage} (unsupported language pair).`
        );
        this.translator = null;
        this.currentTarget = null;
        this.currentSource = null;
        return;
      }

      // For both 'available' and 'downloadable', attempt to create the translator.
      // When 'downloadable', Translator.create() triggers the model download
      // (requires user activation within 5 seconds). The Promise resolves once
      // the download completes and the translator is ready.
      this.translator = await Translator.create({
        sourceLanguage,
        targetLanguage,
        monitor: (monitor: EventTarget) => {
          monitor.addEventListener('downloadprogress', (e: Event) => {
            const evt = e as TranslatorDownloadEvent;
            if (evt.total > 0) {
              log.debug(
                `Translator model download: ${Math.round((evt.loaded / evt.total) * 100)}%`
              );
            }
          });
        },
      });
      this.currentTarget = targetLanguage;
      this.currentSource = sourceLanguage;
      this.pendingSource = null;
      this.pendingTarget = null;
      log.info(`Translator ready: ${sourceLanguage} → ${targetLanguage}`);
    } catch (err) {
      // create() may fail if user activation was missing (NotAllowedError)
      // or if the download failed. The translator stays null and isActive
      // returns false. It will be retried on the next configure() or
      // onUserActivation() call.
      // Clear currentTarget/currentSource so the next configure() with
      // the same language pair does not incorrectly no-op (see line 94).
      log.warn('Failed to create translator (may need user activation):', err);
      this.translator = null;
      this.currentTarget = null;
      this.currentSource = null;
      // pendingSource/pendingTarget stay set so onUserActivation() can retry.
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
    this.currentSource = null;
    this.pendingSource = null;
    this.pendingTarget = null;
    this.enabled = false;
  }
}
