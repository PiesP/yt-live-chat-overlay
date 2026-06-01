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
import { ByteLimitedCache } from '@core/byte-limited-cache';
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
  /** Serializes translate() calls — queued lock prevents race window between check and acquire. */
  private translateLock: Promise<void> = Promise.resolve();
  /** Pending source/target from the most recent configure() for retry. */
  private pendingSource: string | null = null;
  private pendingTarget: string | null = null;
  /** Consecutive translate() failures. On threshold, the translator is invalidated. */
  private consecutiveFailures = 0;
  private static readonly MAX_CONSECUTIVE_FAILURES = 6;
  /** Minimum cooldown between recovery attempts (prevents death-loops). */
  private static readonly RECOVERY_COOLDOWN_MS = 5000;
  private lastRecoveryAttempt = 0;
  /** Number of death→recovery cycles this session. Capped to prevent noise. */
  private recoveryCycleCount = 0;
  private static readonly MAX_RECOVERY_CYCLES = 3;
  /** Translation result cache with LRU eviction to keep frequently repeated short text (e.g. "LOL", "ㅋㅋㅋ"). */
  private readonly translationCache = new ByteLimitedCache<string>(
    50_000, // ~50KB (equivalent to ~2500 average chat messages)
    (text) => text.length * 2 // UTF-16 byte estimate
  );

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
   * Serialized via internal mutex — only one translation is in-flight at a
   * time to prevent concurrent failures from instantly hitting the
   * MAX_CONSECUTIVE_FAILURES threshold and destroying the translator.
   *
   * When the translator instance dies (destroyed after consecutive failures),
   * the next call automatically attempts recovery by recreating it via
   * doConfigure() with the preserved language pair. This means translations
   * resume without requiring user interaction (settings change, click).
   */
  async translate(text: string): Promise<string | null> {
    // ── Serialize: queued lock — each caller atomically acquires a slot ─
    let releaseLock!: () => void;
    const currentLock = this.translateLock;
    this.translateLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await currentLock;

    if (!text.trim()) {
      releaseLock();
      return text;
    }

    // ── Auto-recovery: recreate translator if it died ─────────────────
    if (!this.translator && this.enabled && this.pendingSource && this.pendingTarget) {
      // Cap recovery cycles — after MAX_RECOVERY_CYCLES death-recovery
      // cycles, give up and disable auto-recovery. The Edge Translator API
      // is inherently unstable; endless cycling generates noise without
      // improving the user experience.
      if (this.recoveryCycleCount >= TranslationService.MAX_RECOVERY_CYCLES) {
        log.warn(
          `Translator died ${this.recoveryCycleCount} times — disabling auto-recovery for this session. Translation will resume after a settings change or page reload.`
        );
        this.pendingSource = null;
        this.pendingTarget = null;
        releaseLock();
        return null;
      }
      // Enforce cooldown between recovery attempts to prevent death-loops
      // where the translator is recreated and immediately fails again.
      const elapsed = Date.now() - this.lastRecoveryAttempt;
      if (elapsed < TranslationService.RECOVERY_COOLDOWN_MS) {
        const waitMs = TranslationService.RECOVERY_COOLDOWN_MS - elapsed;
        log.debug(`Recovery cooldown — waiting ${waitMs}ms before next attempt`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      // Don't stack recovery attempts — if a configure is already in-flight,
      // wait for it and re-check. Prevents N concurrent callers from each
      // spawning their own doConfigure().
      if (this.configurePromise) {
        await this.configurePromise;
      }
      // Re-check after waiting — the in-flight configure may have succeeded.
      if (!this.translator) {
        log.info('Translator instance is dead — attempting auto-recovery…');
        this.lastRecoveryAttempt = Date.now();
        this.configurePromise = this.doConfigure(this.pendingSource, this.pendingTarget);
        try {
          await this.configurePromise;
        } catch {
          log.debug('Translator recovery failed, retrying later');
        } finally {
          this.configurePromise = null;
        }
      }
    }

    if (!this.translator) return null;

    // ── Check cache before calling the API ────────────────────────────
    const cached = this.translationCache.get(text);
    if (cached !== undefined) {
      return cached;
    }

    // ── Execute translation ───────────────────────────────────────────

    try {
      const result = await this.translator.translate(text);
      this.consecutiveFailures = 0;

      // ByteLimitedCache handles eviction automatically based on byte limit
      this.translationCache.set(text, result);

      return result;
    } catch (err: unknown) {
      this.consecutiveFailures++;
      const errName = err instanceof DOMException ? err.name : 'Unknown';
      if (this.consecutiveFailures >= TranslationService.MAX_CONSECUTIVE_FAILURES) {
        this.recoveryCycleCount++;
        // Downgrade repeated threshold warnings to debug — the first cycle
        // is informative; subsequent cycles are noise from an unstable API.
        if (this.recoveryCycleCount === 1) {
          log.warn(
            `Translator failed ${this.consecutiveFailures} times consecutively (last: ${errName}) — invalidating instance for recovery`
          );
        } else {
          log.debug(
            `Translator failed again (cycle #${this.recoveryCycleCount}, last: ${errName}) — invalidating instance`
          );
        }
        // Preserve the language pair for retry, then release the dead instance.
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
      return null;
    } finally {
      releaseLock();
    }
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
    this.lastRecoveryAttempt = 0;
    this.translateLock = Promise.resolve();
    this.translationCache.clear();
  }
}
