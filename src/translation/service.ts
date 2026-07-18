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
import type { TranslationLanguage } from '@app-types';
import { resolveTranslationTarget } from '@i18n/index';
import { ByteLimitedCache } from '@util/byte-limited-cache';
import { createLogger } from '@util/logging';

const log = createLogger('TranslationService');

// ── Type declarations for Chrome Translator API ───────────────────────────
// Types are defined in @platform/translation-adapter and re-exported for
// use within this module.

import type { TranslatorDownloadEvent, TranslatorInstance } from '@platform/translation-adapter';
import { getTranslator, isTranslationSupported } from '@platform/translation-adapter';

type TranslateQueueEntry = {
  text: string;
  cacheKey: string;
  generation: number;
  resolve: (result: string | null) => void;
  settled: boolean;
};

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
  /** Invalidates queued work and async configuration results from older owners. */
  private configurationGeneration = 0;
  /** FIFO translation queue. */
  private translateQueue: TranslateQueueEntry[] = [];
  /** Entry currently awaited by the drain loop, if any. */
  private activeEntry: TranslateQueueEntry | null = null;
  /** Whether the drain loop is currently running. */
  private drainActive = false;
  /** Pending source/target from the most recent configure() for retry. */
  private pendingSource: string | null = null;
  private pendingTarget: string | null = null;
  /** Consecutive translate() failures. On threshold, the translator is invalidated. */
  private consecutiveFailures = 0;
  private static readonly MAX_CONSECUTIVE_FAILURES = 6;
  /** Number of death→recovery cycles this session. Capped to prevent noise. */
  private recoveryCycleCount = 0;
  private static readonly MAX_RECOVERY_CYCLES = 3;
  /** Timestamp of the last successful translation. Used to time-base-reset recovery cycles. */
  private lastSuccessTimestamp = 0;
  /** If more than this many ms have passed since last success, reset recoveryCycleCount. */
  private static readonly RECOVERY_RESET_MS = 300_000; // 5 minutes
  /** Translation result cache with LRU eviction to keep frequently repeated short text (e.g. "LOL", "ㅋㅋㅋ"). */
  private readonly translationCache = new ByteLimitedCache<string>(
    50_000, // ~50KB (equivalent to ~2500 average chat messages)
    (text) => text.length * 2 // UTF-16 byte estimate
  );
  /** Maximum number of entries allowed in the translate queue.
   * When exceeded, oldest entries are dropped to prevent
   * unbounded growth during sustained chat bursts. */
  private static readonly MAX_TRANSLATE_QUEUE_SIZE = 1000;

  /** Call this when settings change to reconfigure the translator. */
  async configure(settings: {
    enabled: boolean;
    service: string;
    source: string;
    target: string;
  }): Promise<void> {
    // Resolve 'auto' target to concrete browser language for Chrome Translator API.
    // Chrome Translator requires a BCP 47 language code — it does not accept 'auto'.
    const resolvedTarget =
      settings.target === 'auto' ? resolveTranslationTarget('auto') : settings.target;

    // Resolve 'auto' source — use 'en' as initial fallback until Language Detector
    // determines the actual language via setDetectedSource().
    const resolvedSource = settings.source === 'auto' ? 'en' : settings.source;

    this.enabled = settings.enabled && settings.service === 'auto';
    if (!this.enabled) {
      this.configurationGeneration++;
      this.disposeTranslator(this.translator);
      this.translator = null;
      this.currentTarget = null;
      this.currentSource = null;
      this.pendingSource = null;
      this.pendingTarget = null;
      return;
    }

    if (!getTranslator()) {
      log.warn('translation.service.api-unavailable');
      this.enabled = false;
      this.configurationGeneration++;
      this.disposeTranslator(this.translator);
      this.translator = null;
      this.currentTarget = null;
      this.currentSource = null;
      return;
    }

    // Serialize: wait for any in-flight configure before starting a new one.
    if (this.configurePromise) {
      const requestedGeneration = this.configurationGeneration;
      await this.configurePromise;
      // Re-check no-op after the previous call completed.
      if (!this.enabled || requestedGeneration !== this.configurationGeneration) return;
    }

    if (resolvedTarget === this.currentTarget && resolvedSource === this.currentSource) return;

    this.configurePromise = this.doConfigure(resolvedSource, resolvedTarget);
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

    // Don't stack retries — if a configure is already in-flight, let it finish.
    if (this.configurePromise) return;

    log.info('translation.service.retry-user-activation');
    this.configurePromise = this.doConfigure(this.pendingSource, this.pendingTarget);
    try {
      await this.configurePromise;
    } finally {
      this.configurePromise = null;
    }
  }

  /** Prevents overlapping translator creation during source detection updates. */
  private sourceDetectionPromise: Promise<void> | null = null;

  /**
   * Update the source language post-detection.
   * Called by the renderer after LanguageDetectorService determines
   * the actual chat language. Only creates a new translator if the
   * detected source differs from the current one.
   */
  async setDetectedSource(source: TranslationLanguage): Promise<void> {
    if (!this.enabled) return;

    // Serialize with configure() to avoid overlapping translator creation.
    if (this.configurePromise) {
      await this.configurePromise;
    }

    if (!this.enabled || !this.currentTarget) return;

    // Serialize overlapping detections as well. Re-check the current target
    // and source only after the previous detection has completed.
    if (this.sourceDetectionPromise) {
      await this.sourceDetectionPromise;
    }

    if (!this.enabled || !this.currentTarget || source === this.currentSource) return;

    const target = this.currentTarget;
    const detectionPromise = this.doConfigure(source, target);
    this.sourceDetectionPromise = detectionPromise;
    try {
      await detectionPromise;
    } finally {
      if (this.sourceDetectionPromise === detectionPromise) {
        this.sourceDetectionPromise = null;
      }
    }
  }

  private resolveQueueEntry(entry: TranslateQueueEntry, result: string | null): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.resolve(result);
  }

  private disposeTranslator(
    translator: TranslatorInstance | null,
    logMessage = 'translation.service.destroy-failed'
  ): void {
    if (!translator) return;
    try {
      translator.destroy();
    } catch {
      log.debug(logMessage);
    }
  }

  private async doConfigure(sourceLanguage: string, targetLanguage: string): Promise<void> {
    const generation = ++this.configurationGeneration;
    this.pendingSource = sourceLanguage;
    this.pendingTarget = targetLanguage;

    try {
      const availability = await getTranslator()?.availability({
        sourceLanguage,
        targetLanguage,
      });

      if (generation !== this.configurationGeneration || !this.enabled) return;

      // 'unavailable' means the language pair is not supported at all.
      // Don't attempt to create — it would fail immediately.
      if (availability === 'unavailable') {
        log.warn(
          `Translator not available for ${sourceLanguage}→${targetLanguage} (unsupported language pair).`
        );
        this.disposeTranslator(this.translator);
        this.translator = null;
        this.currentTarget = null;
        this.currentSource = null;
        return;
      }

      // For both 'available' and 'downloadable', attempt to create the translator.
      // When 'downloadable', Translator.create() triggers the model download
      // (requires user activation within 5 seconds). The Promise resolves once
      // the download completes and the translator is ready.
      const newTranslator =
        (await getTranslator()?.create({
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
        })) ?? null;

      // A newer configuration or disable may have taken ownership while
      // create() was pending. This result belongs to the old operation and
      // must be disposed without touching the active translator.
      if (generation !== this.configurationGeneration || !this.enabled) {
        this.disposeTranslator(newTranslator);
        return;
      }

      const previousTranslator = this.translator;
      this.translator = newTranslator;
      this.currentTarget = targetLanguage;
      this.currentSource = sourceLanguage;
      this.pendingSource = null;
      this.pendingTarget = null;
      this.consecutiveFailures = 0;
      this.recoveryCycleCount = 0;
      this.lastSuccessTimestamp = 0;
      if (previousTranslator && previousTranslator !== newTranslator) {
        this.disposeTranslator(previousTranslator);
      }
      log.info('translation.service.ready', { source: sourceLanguage, target: targetLanguage });
    } catch (err: unknown) {
      // create() may fail if user activation was missing (NotAllowedError)
      // or if the download failed. The translator stays null and isActive
      // returns false. It will be retried on the next configure() or
      // onUserActivation() call.
      // Clear currentTarget/currentSource so the next configure() with
      // the same language pair does not incorrectly no-op (see line 94).
      if (generation !== this.configurationGeneration) return;
      log.warn('translation.service.create-failed', { error: String(err) });
      this.disposeTranslator(this.translator);
      this.translator = null;
      this.currentTarget = null;
      this.currentSource = null;
      // pendingSource/pendingTarget stay set so onUserActivation() can retry.
    }
  }

  /** Check if the browser supports the Translator API. */
  static isSupported(): boolean {
    return isTranslationSupported();
  }

  /** Whether translation is currently active (translator ready). */
  get isActive(): boolean {
    return this.enabled && this.translator !== null;
  }

  /** Whether translation is enabled in settings. True even when translator is
   * temporarily dead (awaiting auto-recovery). */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Translate text. Returns the translation or null on failure.
   *
   * Translations are processed via a FIFO queue. Only one translation
   * is in-flight at a time to prevent concurrent failures from instantly
   * hitting the MAX_CONSECUTIVE_FAILURES threshold and destroying the
   * translator.
   *
   * When the translator instance dies (destroyed after consecutive failures),
   * the next call automatically attempts recovery by recreating it via
   * doConfigure() with the preserved language pair. This means translations
   * resume without requiring user interaction (settings change, click).
   *
   * @param text The text to translate.
   */
  async translate(text: string): Promise<string | null> {
    // ── Lock-free fast path: empty text and cache hits ─────────────────
    if (!text.trim()) {
      return text;
    }

    // Include language pair in cache key so stale translations from a
    // previous target language aren't returned after settings change.
    const cacheSource = this.pendingSource ?? this.currentSource ?? 'auto';
    const cacheTarget = this.pendingTarget ?? this.currentTarget;
    const cacheKey = `${cacheSource}:${cacheTarget}:${text}`;
    const cached = this.translationCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // ── Enqueue (FIFO) ────────────────────────────────────────────────
    return new Promise<string | null>((resolve) => {
      // Drop oldest entry if the queue is at capacity.
      if (this.translateQueue.length >= TranslationService.MAX_TRANSLATE_QUEUE_SIZE) {
        const dropped = this.translateQueue.shift();
        if (dropped) this.resolveQueueEntry(dropped, null);
        log.debug(
          `Translate queue at capacity (${TranslationService.MAX_TRANSLATE_QUEUE_SIZE}) — dropped oldest entry`
        );
      }
      this.translateQueue.push({
        text,
        cacheKey,
        generation: this.configurationGeneration,
        resolve,
        settled: false,
      });
      if (!this.drainActive) {
        this.drainActive = true;
        this.drainQueue();
      }
    });
  }

  /**
   * Drain the queue one item at a time.
   * Only one drain loop runs at a time (guarded by drainActive).
   */
  private async drainQueue(): Promise<void> {
    try {
      while (this.translateQueue.length > 0) {
        const entry = this.translateQueue.shift();
        if (!entry) break;

        this.activeEntry = entry;
        try {
          if (entry.generation !== this.configurationGeneration) {
            this.resolveQueueEntry(entry, null);
            continue;
          }

          // Re-check cache after dequeue — another caller may have translated this text
          const reCached = this.translationCache.get(entry.cacheKey);
          if (reCached !== undefined) {
            this.resolveQueueEntry(entry, reCached);
            continue;
          }

          // ── Auto-recovery: translator died, but Translator.create() requires
          // user activation (click/keypress within 5s).  We cannot recover here —
          // drainQueue() runs in the background without user interaction.
          // Instead, resolve all pending translations immediately with null and
          // preserve pendingSource/pendingTarget so onUserActivation() (called
          // from click handlers) can recover when the user next interacts.
          if (!this.translator && this.enabled && this.pendingSource && this.pendingTarget) {
            // Time-based reset: if translations were working recently, allow fresh recovery attempts.
            if (
              this.lastSuccessTimestamp > 0 &&
              Date.now() - this.lastSuccessTimestamp > TranslationService.RECOVERY_RESET_MS
            ) {
              log.debug('translation.service.recovery-reset');
              this.recoveryCycleCount = 0;
            }
            if (this.recoveryCycleCount >= TranslationService.MAX_RECOVERY_CYCLES) {
              log.warn(
                `Translator died ${this.recoveryCycleCount} times — disabling auto-recovery for this session. Open settings and click Save to retry.`
              );
              this.pendingSource = null;
              this.pendingTarget = null;
            }
            // Resolve all remaining queue entries — translator is dead and can't be
            // recreated without user activation.  The queue drain loop will exit
            // naturally after resolving these.
            this.resolveQueueEntry(entry, null);
            // Fast-drain remaining queue items (they'll all resolve null)
            while (this.translateQueue.length > 0) {
              const next = this.translateQueue.shift();
              if (next) this.resolveQueueEntry(next, null);
            }
            return;
          }

          const translator = this.translator;
          if (!translator) {
            this.resolveQueueEntry(entry, null);
            continue;
          }

          // ── Execute translation ───────────────────────────────────────────

          try {
            const result = await translator.translate(entry.text);
            if (
              entry.generation !== this.configurationGeneration ||
              this.translator !== translator ||
              !this.enabled
            ) {
              this.resolveQueueEntry(entry, null);
              continue;
            }
            this.consecutiveFailures = 0;
            this.lastSuccessTimestamp = Date.now();
            this.translationCache.set(entry.cacheKey, result);
            this.resolveQueueEntry(entry, result);
          } catch (err: unknown) {
            if (
              entry.generation !== this.configurationGeneration ||
              this.translator !== translator ||
              !this.enabled
            ) {
              this.resolveQueueEntry(entry, null);
              continue;
            }
            this.consecutiveFailures++;
            const errName = err instanceof DOMException ? err.name : 'Unknown';
            if (this.consecutiveFailures >= TranslationService.MAX_CONSECUTIVE_FAILURES) {
              this.recoveryCycleCount++;
              if (this.recoveryCycleCount === 1) {
                log.warn(
                  `Translator failed ${this.consecutiveFailures} times consecutively (last: ${errName}) — invalidating instance for recovery`
                );
              } else {
                log.debug(
                  `Translator failed again (cycle #${this.recoveryCycleCount}, last: ${errName}) — invalidating instance`
                );
              }
              if (!this.pendingSource && this.currentSource) {
                this.pendingSource = this.currentSource;
              }
              if (!this.pendingTarget && this.currentTarget) {
                this.pendingTarget = this.currentTarget;
              }
              this.disposeTranslator(translator);
              this.translator = null;
              this.currentTarget = null;
              this.currentSource = null;
              this.consecutiveFailures = 0;
            } else {
              log.debug('translation.service.translate-failed', {
                errorName: errName,
                error: String(err),
              });
            }
            this.resolveQueueEntry(entry, null);
          }
        } finally {
          if (this.activeEntry === entry) this.activeEntry = null;
        }
      }
    } finally {
      // Ensure drainActive is always reset even if an unexpected exception
      // escapes the inner try/catch. Without this, a single unhandled error
      // would permanently stall the queue — all future translate() calls
      // would create promises that never resolve.
      this.drainActive = false;
    }
  }

  destroy(): void {
    // Release the underlying Chrome Translator instance to free the per-profile
    // slot (Chromium enforces a 10-instance limit per browsing context).
    // Without this call, every RuntimeSession restart leaks one slot, and after
    // ~10 restarts (watchdog, foreground-return, standby-resolved, settings
    // changes) Translator.create() fails permanently.
    this.configurationGeneration++;
    this.disposeTranslator(this.translator, 'translation.service.shutdown-destroy-failed');
    this.translator = null;
    this.currentTarget = null;
    this.currentSource = null;
    this.pendingSource = null;
    this.pendingTarget = null;
    this.enabled = false;
    this.consecutiveFailures = 0;
    this.recoveryCycleCount = 0;
    this.lastSuccessTimestamp = 0;
    // Resolve the active caller as well as pending translate() callers with null
    // before clearing the queue. The drain loop remains active until its current
    // translator operation settles, so a second drain cannot race its finally.
    if (this.activeEntry) {
      this.resolveQueueEntry(this.activeEntry, null);
    }
    // Without this, any caller awaiting translate() has a Promise that never settles,
    // causing a Promise leak that retains closures and their entire scope chain.
    for (const entry of this.translateQueue) {
      this.resolveQueueEntry(entry, null);
    }
    this.translateQueue = [];
    this.translationCache.clear();
  }
}
