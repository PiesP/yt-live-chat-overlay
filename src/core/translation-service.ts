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
import { ByteLimitedCache } from '@core/byte-limited-cache';
import { resolveTranslationTarget } from '@core/i18n';
import { createLogger } from '@core/logging';

const log = createLogger('TranslationService');

// ── Type declarations for Chrome Translator API ───────────────────────────

interface TranslatorDownloadEvent extends Event {
  loaded: number;
  total: number;
}

interface TranslatorInstance {
  translate(text: string): Promise<string>;
  destroy(): void;
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
  /** Priority-sorted translation queue (highest priority first, stable for equal priority). */
  private translateQueue: Array<{
    text: string;
    priority: number;
    resolve: (result: string | null) => void;
  }> = [];
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
  /** Translation result cache with LRU eviction to keep frequently repeated short text (e.g. "LOL", "ㅋㅋㅋ"). */
  private readonly translationCache = new ByteLimitedCache<string>(
    50_000, // ~50KB (equivalent to ~2500 average chat messages)
    (text) => text.length * 2 // UTF-16 byte estimate
  );
  /** Maximum number of entries allowed in the translate queue.
   * When exceeded, oldest low-priority entries are dropped to prevent
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

    if (resolvedTarget === this.currentTarget && resolvedSource === this.currentSource) return;

    // Serialize: wait for any in-flight configure before starting a new one.
    if (this.configurePromise) {
      await this.configurePromise;
      // Re-check no-op after the previous call completed.
      if (resolvedTarget === this.currentTarget && resolvedSource === this.currentSource) return;
    }

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

    log.info('Retrying translator creation via user activation…');
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
    if (!this.currentTarget) return;
    if (source === this.currentSource) return;

    // Serialize with configure() to avoid overlapping translator creation.
    if (this.configurePromise) {
      await this.configurePromise;
      if (source === this.currentSource) return;
    }

    this.sourceDetectionPromise = this.doConfigure(source, this.currentTarget);
    try {
      await this.sourceDetectionPromise;
    } finally {
      this.sourceDetectionPromise = null;
    }
  }

  private async doConfigure(sourceLanguage: string, targetLanguage: string): Promise<void> {
    this.pendingSource = sourceLanguage;
    this.pendingTarget = targetLanguage;

    try {
      const availability = await Translator?.availability({
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
      this.translator =
        (await Translator?.create({
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
      this.currentTarget = targetLanguage;
      this.currentSource = sourceLanguage;
      this.pendingSource = null;
      this.pendingTarget = null;
      this.consecutiveFailures = 0;
      this.recoveryCycleCount = 0;
      log.info(`Translator ready: ${sourceLanguage} → ${targetLanguage}`);
    } catch (err: unknown) {
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
   * Translations are processed via a priority queue — higher-priority
   * messages (SuperChat, Membership) are translated before lower-priority
   * normal text messages during chat bursts. Only one translation is
   * in-flight at a time to prevent concurrent failures from instantly
   * hitting the MAX_CONSECUTIVE_FAILURES threshold and destroying the
   * translator.
   *
   * When the translator instance dies (destroyed after consecutive failures),
   * the next call automatically attempts recovery by recreating it via
   * doConfigure() with the preserved language pair. This means translations
   * resume without requiring user interaction (settings change, click).
   *
   * @param text The text to translate.
   * @param priority Priority for queue ordering (higher = processed sooner).
   *                 Default 0. SuperChat=200, Membership=100, text=0.
   */
  async translate(text: string, priority = 0): Promise<string | null> {
    // ── Lock-free fast path: empty text and cache hits ─────────────────
    if (!text.trim()) {
      return text;
    }

    const cached = this.translationCache.get(text);
    if (cached !== undefined) {
      return cached;
    }

    // ── Enqueue with priority ─────────────────────────────────────────
    return new Promise<string | null>((resolve) => {
      // Drop oldest low-priority entries if the queue is at capacity.
      // This prevents unbounded growth when the translator is slow or
      // dead and messages keep arriving faster than they drain.
      if (this.translateQueue.length >= TranslationService.MAX_TRANSLATE_QUEUE_SIZE) {
        // Find the oldest entry with the lowest priority (end of queue).
        let dropIdx = this.translateQueue.length - 1;
        let minPriority = this.translateQueue[dropIdx]?.priority ?? 0;
        for (let i = this.translateQueue.length - 2; i >= 0; i--) {
          const p = this.translateQueue[i]?.priority ?? 0;
          if (p < minPriority) {
            minPriority = p;
            dropIdx = i;
          }
        }
        const dropped = this.translateQueue.splice(dropIdx, 1)[0];
        if (dropped) dropped.resolve(null);
        log.debug(
          `Translate queue at capacity (${TranslationService.MAX_TRANSLATE_QUEUE_SIZE}) — dropped oldest low-priority entry (priority=${minPriority})`
        );
      }
      const entry = { text, priority, resolve };
      // Insert sorted by priority DESC (highest first), stable for equal priority
      const insertIdx = this.translateQueue.findIndex((q) => q.priority < priority);
      if (insertIdx === -1) {
        this.translateQueue.push(entry);
      } else {
        this.translateQueue.splice(insertIdx, 0, entry);
      }
      if (!this.drainActive) {
        this.drainActive = true;
        this.drainQueue();
      }
    });
  }

  /**
   * Drain the priority queue one item at a time.
   * Only one drain loop runs at a time (guarded by drainActive).
   */
  private async drainQueue(): Promise<void> {
    while (this.translateQueue.length > 0) {
      const entry = this.translateQueue.shift();
      if (!entry) break;

      // Re-check cache after dequeue — another caller may have translated this text
      const reCached = this.translationCache.get(entry.text);
      if (reCached !== undefined) {
        entry.resolve(reCached);
        continue;
      }

      // ── Auto-recovery: translator died, but Translator.create() requires
      // user activation (click/keypress within 5s).  We cannot recover here —
      // drainQueue() runs in the background without user interaction.
      // Instead, resolve all pending translations immediately with null and
      // preserve pendingSource/pendingTarget so onUserActivation() (called
      // from click handlers) can recover when the user next interacts.
      if (!this.translator && this.enabled && this.pendingSource && this.pendingTarget) {
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
        entry.resolve(null);
        // Fast-drain remaining queue items (they'll all resolve null)
        while (this.translateQueue.length > 0) {
          const next = this.translateQueue.shift();
          if (next) next.resolve(null);
        }
        this.drainActive = false;
        return;
      }

      if (!this.translator) {
        entry.resolve(null);
        continue;
      }

      // ── Execute translation ───────────────────────────────────────────

      try {
        const result = await this.translator.translate(entry.text);
        this.consecutiveFailures = 0;
        this.translationCache.set(entry.text, result);
        entry.resolve(result);
      } catch (err: unknown) {
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
          if (this.translator) {
            try {
              this.translator.destroy();
            } catch {
              log.debug('Translator destroy during recovery failed');
            }
          }
          this.translator = null;
          this.currentTarget = null;
          this.currentSource = null;
          this.consecutiveFailures = 0;
        } else {
          log.debug(`Translation failed (${errName}):`, err);
        }
        entry.resolve(null);
      }
    }
    this.drainActive = false;
  }

  destroy(): void {
    // Release the underlying Chrome Translator instance to free the per-profile
    // slot (Chromium enforces a 10-instance limit per browsing context).
    // Without this call, every RuntimeSession restart leaks one slot, and after
    // ~10 restarts (watchdog, foreground-return, standby-resolved, settings
    // changes) Translator.create() fails permanently.
    if (this.translator) {
      try {
        this.translator.destroy();
      } catch {
        log.debug('Translator destroy during shutdown failed');
      }
    }
    this.translator = null;
    this.currentTarget = null;
    this.currentSource = null;
    this.pendingSource = null;
    this.pendingTarget = null;
    this.enabled = false;
    this.consecutiveFailures = 0;
    this.recoveryCycleCount = 0;
    // Resolve all pending translate() callers with null before clearing the queue.
    // Without this, any caller awaiting translate() has a Promise that never settles,
    // causing a Promise leak that retains closures and their entire scope chain.
    for (const entry of this.translateQueue) {
      entry.resolve(null);
    }
    this.translateQueue = [];
    this.drainActive = false;
    this.translationCache.clear();
  }
}
