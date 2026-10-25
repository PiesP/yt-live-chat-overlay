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
 * - Model setup may require user activation and can also be blocked by
 *   browser policy or user settings. A settings action can retry creation.
 * - Sequential translations only — a large text blocks subsequent calls.
 *   For chat (short messages), this is acceptable.
 */
import type { TranslationSource, TranslationSourceLanguage, TranslationTarget } from '@app-types';
import { resolveTranslationTarget } from '@i18n/index';
import { ResizableByteLimitedCache } from '@piesp/browser-core/util';
import { createLogger } from '@util/logging';

const log = createLogger('TranslationService');

// ── Type declarations for Chrome Translator API ───────────────────────────
// Types are defined in @platform/translation-adapter and re-exported for
// use within this module.

import {
  getTranslator,
  isTranslationSupported,
  type TranslatorDownloadEvent,
  type TranslatorInstance,
  type TranslatorStatic,
} from '@platform/translation-adapter';

// A renderer can be replaced while its previous native Promise is still
// unsettled. Key the lease by the actual API object so a new service cannot
// overlap that work; test stubs with separate API objects remain independent.
const nativeLeases = new WeakMap<TranslatorStatic, { owner: Promise<void> | null }>();

async function claimNativeLease(
  api: TranslatorStatic,
  timeoutMs: number
): Promise<(() => void) | null> {
  let lease = nativeLeases.get(api);
  if (!lease) {
    lease = { owner: null };
    nativeLeases.set(api, lease);
  }
  const deadline = Date.now() + timeoutMs;
  while (lease.owner) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      lease.owner.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), remaining);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!settled) return null;
  }
  let releaseOwner!: () => void;
  const owner = new Promise<void>((resolve) => {
    releaseOwner = resolve;
  });
  lease.owner = owner;
  return () => {
    if (lease.owner === owner) lease.owner = null;
    releaseOwner();
  };
}

type TranslateQueueEntry = {
  text: string;
  cacheKey: string;
  generation: number;
  priority: number;
  accountedBytes: number;
  signal?: AbortSignal | undefined;
  onAbort?: (() => void) | undefined;
  resolve: (result: string | null) => void;
  settled: boolean;
};

export interface TranslateRequestOptions {
  signal?: AbortSignal;
  /** Paid messages take precedence in recent turns; every third turn remains oldest-first. */
  priority?: number;
}

type ConfigurationCancellation = {
  promise: Promise<void>;
  cancelled: boolean;
  cancel: () => void;
};

type ConfigurationReservation = {
  generation: number;
  cancellation: ConfigurationCancellation;
};

type ConfigurationRaceResult<T> = { cancelled: true } | { cancelled: false; value: T };

export type TranslationRuntimePhase =
  | 'off'
  | 'preparing'
  | 'downloading'
  | 'active'
  | 'unavailable'
  | 'needs-action'
  | 'failed';

export type TranslationRuntimeReason =
  | 'disabled'
  | 'service-off'
  | 'api-unavailable'
  | 'pair-unavailable'
  | 'model-pending'
  | 'blocked'
  | 'create-failed'
  | 'translator-failed'
  | null;

export type TranslationRuntimeStatus = Readonly<{
  phase: TranslationRuntimePhase;
  reason: TranslationRuntimeReason;
  source: string | null;
  target: string | null;
  progressPercent: number | null;
  generation: number;
}>;

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Translation service state.
 * Created once per renderer lifecycle.
 */
export class TranslationService {
  private runtimeStatus: TranslationRuntimeStatus = Object.freeze({
    phase: 'off',
    reason: 'disabled',
    source: null,
    target: null,
    progressPercent: null,
    generation: 0,
  });
  private readonly runtimeStatusListeners = new Set<(status: TranslationRuntimeStatus) => void>();
  private translator: TranslatorInstance | null = null;
  private currentTarget: string | null = null;
  private currentSource: string | null = null;
  private enabled = false;
  /** Serializes all lifecycle operations to prevent overlapping configuration. */
  private lifecyclePromise: Promise<void> = Promise.resolve();
  /** Invalidates queued work and async configuration results from older owners. */
  private configurationGeneration = 0;
  /** Generation that owns the currently ready translator. */
  private translatorGeneration: number | null = null;
  /** Generation currently waiting for availability/create, if any. */
  private configuringGeneration: number | null = null;
  /** Cancels availability/create for the superseded configuration generation. */
  private configurationCancellation: ConfigurationCancellation | null = null;
  /** Owner-cancellable queue; the oldest surviving caller receives every third backlog turn. */
  private translateQueue: TranslateQueueEntry[] = [];
  private queuedBytes = 0;
  private recentTurns = 0;
  /** Entry currently awaited by the drain loop, if any. */
  private activeEntry: TranslateQueueEntry | null = null;
  /** Native work remains owned until its actual Promise settles, even after local cancellation. */
  private nativeWork: Promise<void> | null = null;
  private nativeAbortController: AbortController | null = null;
  private nativeStallTimer: ReturnType<typeof setTimeout> | null = null;
  private nativeStalled = false;
  /** An unresolved create() blocks replacement creation; only its own result can release it. */
  private pendingCreation: Promise<void> | null = null;
  /** Whether the drain loop is currently running. */
  private drainActive = false;
  /** Requests a new drain after the current drain owns its finally block. */
  private drainRestartRequested = false;
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
  private readonly translationCache = new ResizableByteLimitedCache<string>(
    50_000, // ~50KB (equivalent to ~2500 average chat messages)
    (text) => text.length * 2 // UTF-16 byte estimate
  );
  private static readonly MAX_TRANSLATE_QUEUE_SIZE = 256;
  private static readonly MAX_TRANSLATE_QUEUE_BYTES = 64 * 1024;
  private static readonly MAX_TRANSLATE_TEXT_BYTES = 8 * 1024;
  private static readonly NATIVE_STALL_MS = 15_000;
  private static readonly OWNERSHIP_WAIT_MS = 1_500;

  getStatus(): TranslationRuntimeStatus {
    return this.runtimeStatus;
  }

  subscribeStatus(listener: (status: TranslationRuntimeStatus) => void): () => void {
    this.runtimeStatusListeners.add(listener);
    listener(this.runtimeStatus);
    return () => this.runtimeStatusListeners.delete(listener);
  }

  private publishStatus(
    phase: TranslationRuntimePhase,
    reason: TranslationRuntimeReason = null,
    progressPercent: number | null = null,
    source: string | null = this.pendingSource ?? this.currentSource,
    target: string | null = this.pendingTarget ?? this.currentTarget
  ): void {
    this.runtimeStatus = Object.freeze({
      phase,
      reason,
      source,
      target,
      progressPercent,
      generation: this.configurationGeneration,
    });
    for (const listener of this.runtimeStatusListeners) listener(this.runtimeStatus);
  }

  /** Call this when settings change to reconfigure the translator. */
  async configure(settings: {
    enabled: boolean;
    service: string;
    source: TranslationSource | TranslationSourceLanguage;
    target: TranslationTarget;
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
      this.disableTranslation();
      this.publishStatus('off', settings.enabled ? 'service-off' : 'disabled');
      return;
    }

    if (!getTranslator()) {
      log.warn('translation.service.api-unavailable');
      this.disableTranslation();
      this.publishStatus('unavailable', 'api-unavailable', null, resolvedSource, resolvedTarget);
      return;
    }

    const reservation = this.reserveConfiguration(resolvedSource, resolvedTarget);
    if (reservation === null) return;
    const { generation, cancellation } = reservation;

    await this.enqueueLifecycleOperation(async () => {
      if (!this.enabled || generation !== this.configurationGeneration) return;
      if (!getTranslator()) {
        log.warn('translation.service.api-unavailable');
        this.disableTranslation();
        this.publishStatus('unavailable', 'api-unavailable', null, resolvedSource, resolvedTarget);
        return;
      }
      if (
        resolvedTarget === this.currentTarget &&
        resolvedSource === this.currentSource &&
        this.translatorGeneration === this.configurationGeneration
      ) {
        return;
      }
      await this.doConfigure(resolvedSource, resolvedTarget, generation, cancellation);
    });
  }

  /**
   * Re-attempt translator creation with the last configured language pair.
   * Call this from a user-activation context (e.g. click handler) when
   * the previous configure() failed because the model was still downloading
   * or user activation was missing.
   */
  async onUserActivation(): Promise<void> {
    if (!this.enabled) return;
    this.resetRecoveryCyclesIfExpired();
    if (this.recoveryCycleCount >= TranslationService.MAX_RECOVERY_CYCLES) return;

    const source = this.pendingSource;
    const target = this.pendingTarget;
    if (!source || !target) return;

    const reservation = this.reserveConfiguration(source, target);
    if (reservation === null) return;
    const { generation, cancellation } = reservation;

    await this.enqueueLifecycleOperation(async () => {
      if (
        !this.enabled ||
        generation !== this.configurationGeneration ||
        this.pendingSource !== source ||
        this.pendingTarget !== target
      ) {
        return;
      }

      log.info('translation.service.retry-user-activation');
      await this.doConfigure(source, target, generation, cancellation, true);
    });
  }

  /**
   * Update the source language post-detection.
   * Called by the renderer after LanguageDetectorService determines
   * the actual chat language. Only creates a new translator if the
   * detected source differs from the current one.
   */
  async setDetectedSource(source: TranslationSourceLanguage): Promise<void> {
    if (!this.enabled) return;

    const target = this.pendingTarget ?? this.currentTarget;
    const configuredSource = this.pendingSource ?? this.currentSource;
    if (!target || source === configuredSource) return;

    const reservation = this.reserveConfiguration(source, target);
    if (reservation === null) return;
    const { generation, cancellation } = reservation;

    await this.enqueueLifecycleOperation(async () => {
      if (
        !this.enabled ||
        generation !== this.configurationGeneration ||
        this.pendingSource !== source ||
        this.pendingTarget !== target
      ) {
        return;
      }

      await this.doConfigure(source, target, generation, cancellation);
    });
  }

  private enqueueLifecycleOperation(operation: () => Promise<void>): Promise<void> {
    const operationPromise = this.lifecyclePromise.then(operation);
    this.lifecyclePromise = operationPromise.catch(() => undefined);
    return operationPromise;
  }

  private reserveConfiguration(
    sourceLanguage: string,
    targetLanguage: string
  ): ConfigurationReservation | null {
    if (
      sourceLanguage === this.currentSource &&
      targetLanguage === this.currentTarget &&
      this.translator !== null &&
      this.translatorGeneration === this.configurationGeneration
    ) {
      return null;
    }
    if (
      sourceLanguage === this.pendingSource &&
      targetLanguage === this.pendingTarget &&
      this.configuringGeneration === this.configurationGeneration
    ) {
      const cancellation = this.configurationCancellation;
      if (cancellation) {
        return { generation: this.configurationGeneration, cancellation };
      }
    }

    this.cancelConfiguration();
    const generation = this.configurationGeneration + 1;
    this.configurationGeneration = generation;
    this.translatorGeneration = null;
    this.configuringGeneration = generation;
    const cancellation = this.createConfigurationCancellation();
    this.configurationCancellation = cancellation;
    this.cancelActiveTranslation();
    this.resolveStaleQueueEntries(generation);
    this.pendingSource = sourceLanguage;
    this.pendingTarget = targetLanguage;
    this.publishStatus('preparing');
    return { generation, cancellation };
  }

  private createConfigurationCancellation(): ConfigurationCancellation {
    let resolveCancellation: (() => void) | undefined;
    const cancellation: ConfigurationCancellation = {
      promise: new Promise<void>((resolve) => {
        resolveCancellation = resolve;
      }),
      cancelled: false,
      cancel: () => {
        if (cancellation.cancelled) return;
        cancellation.cancelled = true;
        resolveCancellation?.();
      },
    };
    return cancellation;
  }

  private cancelConfiguration(): void {
    this.configurationCancellation?.cancel();
    this.configurationCancellation = null;
  }

  private async raceConfiguration<T>(
    operation: Promise<T> | undefined,
    cancellation: ConfigurationCancellation
  ): Promise<ConfigurationRaceResult<Awaited<T> | undefined>> {
    const operationPromise = Promise.resolve(operation);
    const result = await Promise.race([
      operationPromise.then(
        (value) => ({ cancelled: false as const, value }),
        (error: unknown) => Promise.reject(error)
      ),
      cancellation.promise.then(() => ({ cancelled: true as const })),
    ]);

    if (result.cancelled || cancellation.cancelled) {
      return { cancelled: true };
    }
    return result;
  }

  private resolveQueueEntry(entry: TranslateQueueEntry, result: string | null): void {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
    entry.resolve(result);
  }

  private cancelActiveTranslation(): void {
    this.nativeAbortController?.abort();
    const activeEntry = this.activeEntry;
    if (activeEntry) {
      this.resolveQueueEntry(activeEntry, null);
    }
  }

  private takeQueuedEntry(index: number): TranslateQueueEntry | undefined {
    const [entry] = this.translateQueue.splice(index, 1);
    if (entry) this.queuedBytes -= entry.accountedBytes;
    return entry;
  }

  private withdrawQueuedEntry(entry: TranslateQueueEntry): void {
    const index = this.translateQueue.indexOf(entry);
    if (index < 0) return;
    this.takeQueuedEntry(index);
    this.resolveQueueEntry(entry, null);
  }

  private takeNextEntry(): TranslateQueueEntry | undefined {
    if (this.translateQueue.length <= 1) return this.takeQueuedEntry(0);
    if (this.recentTurns >= 2) {
      this.recentTurns = 0;
      return this.takeQueuedEntry(0);
    }
    this.recentTurns++;
    let selected = this.translateQueue.length - 1;
    for (let i = selected - 1; i >= 0; i--) {
      const candidate = this.translateQueue[i];
      const current = this.translateQueue[selected];
      if (candidate && current && candidate.priority > current.priority) selected = i;
    }
    return this.takeQueuedEntry(selected);
  }

  private async waitForOwnership(owner: Promise<void> | null): Promise<boolean> {
    if (!owner) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), TranslationService.OWNERSHIP_WAIT_MS);
    });
    try {
      return await Promise.race([owner.then(() => true), timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private clearNativeStallTimer(): void {
    if (this.nativeStallTimer !== null) clearTimeout(this.nativeStallTimer);
    this.nativeStallTimer = null;
  }

  private resolveStaleQueueEntries(generation: number): void {
    for (let index = this.translateQueue.length - 1; index >= 0; index--) {
      if (this.translateQueue[index]?.generation !== generation) {
        const entry = this.takeQueuedEntry(index);
        if (entry) this.resolveQueueEntry(entry, null);
      }
    }
  }

  private disableTranslation(): void {
    this.cancelConfiguration();
    this.configurationGeneration++;
    this.configuringGeneration = null;
    this.translatorGeneration = null;
    this.cancelActiveTranslation();
    this.disposeTranslator(this.translator);
    this.translator = null;
    this.currentTarget = null;
    this.currentSource = null;
    this.pendingSource = null;
    this.pendingTarget = null;
    this.enabled = false;
    for (const entry of this.translateQueue.splice(0)) {
      this.resolveQueueEntry(entry, null);
    }
    this.queuedBytes = 0;
  }

  private startDrainIfNeeded(): void {
    if (this.translateQueue.length === 0) return;
    if (this.drainActive) {
      this.drainRestartRequested = true;
      return;
    }
    this.drainActive = true;
    void this.drainQueue();
  }

  private resolveQueueEntriesForGeneration(generation: number): void {
    for (let index = this.translateQueue.length - 1; index >= 0; index--) {
      if (this.translateQueue[index]?.generation === generation) {
        const entry = this.takeQueuedEntry(index);
        if (entry) {
          this.resolveQueueEntry(entry, null);
        }
      }
    }
  }

  private isGenerationReady(generation: number): boolean {
    return (
      this.enabled &&
      this.translator !== null &&
      this.configurationGeneration === generation &&
      this.translatorGeneration === generation
    );
  }

  private resolveQueueAfterRecovery(): void {
    this.resetRecoveryCyclesIfExpired();
    if (this.recoveryCycleCount >= TranslationService.MAX_RECOVERY_CYCLES) {
      log.warn(
        `Translator died ${this.recoveryCycleCount} times — disabling auto-recovery for this session. Open settings and click Save to retry.`
      );
      this.pendingSource = null;
      this.pendingTarget = null;
    }
    while (this.translateQueue.length > 0) {
      const next = this.takeQueuedEntry(0);
      if (next) this.resolveQueueEntry(next, null);
    }
  }

  private resetRecoveryCyclesIfExpired(): void {
    if (
      this.lastSuccessTimestamp > 0 &&
      Date.now() - this.lastSuccessTimestamp > TranslationService.RECOVERY_RESET_MS
    ) {
      log.debug('translation.service.recovery-reset');
      this.recoveryCycleCount = 0;
    }
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

  private async doConfigure(
    sourceLanguage: string,
    targetLanguage: string,
    generation: number,
    cancellation: ConfigurationCancellation,
    preserveRecoveryCount = false
  ): Promise<void> {
    this.translatorGeneration = null;
    this.configuringGeneration = generation;
    this.cancelActiveTranslation();
    this.resolveStaleQueueEntries(generation);
    this.pendingSource = sourceLanguage;
    this.pendingTarget = targetLanguage;

    let releaseLease: (() => void) | null = null;
    let creationOwnsLease = false;
    try {
      // A locally cancelled caller is not evidence that its native operation
      // stopped. Neither a replacement translator nor another create() may
      // start while the previous operation still owns its browser slot.
      const nativeOwned = await this.waitForOwnership(this.nativeWork);
      const creationOwned = nativeOwned && (await this.waitForOwnership(this.pendingCreation));
      if (!nativeOwned || !creationOwned) {
        if (generation === this.configurationGeneration && this.enabled) {
          this.configuringGeneration = null;
          this.resolveQueueEntriesForGeneration(generation);
          this.publishStatus('failed', nativeOwned ? 'create-failed' : 'translator-failed');
        }
        return;
      }
      this.nativeStalled = false;
      if (generation !== this.configurationGeneration || !this.enabled) return;

      const api = getTranslator();
      if (!api) return;
      releaseLease = await claimNativeLease(api, TranslationService.OWNERSHIP_WAIT_MS);
      if (!releaseLease) {
        if (generation === this.configurationGeneration && this.enabled) {
          this.configuringGeneration = null;
          this.resolveQueueEntriesForGeneration(generation);
          this.publishStatus('failed', 'translator-failed');
        }
        return;
      }
      if (generation !== this.configurationGeneration || !this.enabled) return;

      const availabilityResult = await this.raceConfiguration(
        api.availability({
          sourceLanguage,
          targetLanguage,
        }),
        cancellation
      );
      if (availabilityResult.cancelled) return;
      const availability = availabilityResult.value;

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
        this.configuringGeneration = null;
        this.resolveQueueEntriesForGeneration(generation);
        this.publishStatus('unavailable', 'pair-unavailable');
        return;
      }

      // Availability does not establish readiness. create() may prepare or
      // download a model and only its resolved translator is active.
      if (availability === 'downloadable' || availability === 'downloading') {
        this.publishStatus('preparing', 'model-pending');
      }
      const creation = Promise.resolve(
        api.create({
          sourceLanguage,
          targetLanguage,
          monitor: (monitor: EventTarget) => {
            monitor.addEventListener('downloadprogress', (e: Event) => {
              const evt = e as TranslatorDownloadEvent;
              if (
                cancellation.cancelled ||
                generation !== this.configurationGeneration ||
                !this.enabled
              )
                return;
              const fraction =
                Number.isFinite(evt.loaded) && evt.loaded >= 0 && evt.loaded <= 1
                  ? evt.loaded
                  : Number.isFinite(evt.total) && evt.total > 0
                    ? evt.loaded / evt.total
                    : NaN;
              if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) return;
              const percent = Math.round(fraction * 100);
              log.debug(`Translator model download: ${percent}%`);
              this.publishStatus('downloading', null, percent);
            });
          },
        })
      );
      const creationSettled = creation.then(
        (createdTranslator) => {
          if (cancellation.cancelled) {
            if (createdTranslator) this.disposeTranslator(createdTranslator);
          }
        },
        () => undefined
      );
      this.pendingCreation = creationSettled;
      creationOwnsLease = true;
      const releaseAfterCreation = releaseLease;
      void creationSettled.finally(() => releaseAfterCreation?.());
      void creationSettled.finally(() => {
        if (this.pendingCreation === creationSettled) this.pendingCreation = null;
      });
      const createResult = await this.raceConfiguration(creation, cancellation);
      if (createResult.cancelled) return;
      const newTranslator = createResult.value ?? null;

      // A newer configuration or disable may have taken ownership while
      // create() was pending. This result belongs to the old operation and
      // must be disposed without touching the active translator.
      if (generation !== this.configurationGeneration || !this.enabled) {
        this.disposeTranslator(newTranslator);
        return;
      }

      if (!newTranslator) {
        this.configuringGeneration = null;
        this.translatorGeneration = null;
        this.disposeTranslator(this.translator);
        this.translator = null;
        this.currentTarget = null;
        this.currentSource = null;
        this.resolveQueueEntriesForGeneration(generation);
        this.publishStatus('failed', 'create-failed');
        return;
      }

      const previousTranslator = this.translator;
      this.translator = newTranslator;
      this.currentTarget = targetLanguage;
      this.currentSource = sourceLanguage;
      this.configuringGeneration = null;
      this.translatorGeneration = generation;
      this.pendingSource = null;
      this.pendingTarget = null;
      this.consecutiveFailures = 0;
      if (!preserveRecoveryCount) {
        this.recoveryCycleCount = 0;
      }
      this.lastSuccessTimestamp = 0;
      if (previousTranslator && previousTranslator !== newTranslator) {
        this.disposeTranslator(previousTranslator);
      }
      log.info('translation.service.ready', { source: sourceLanguage, target: targetLanguage });
      this.publishStatus('active');
      this.startDrainIfNeeded();
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
      this.configuringGeneration = null;
      this.translatorGeneration = null;
      this.resolveQueueEntriesForGeneration(generation);
      this.publishStatus(
        err instanceof Error && err.name === 'NotAllowedError' ? 'needs-action' : 'failed',
        err instanceof Error && err.name === 'NotAllowedError' ? 'blocked' : 'create-failed'
      );
      // pendingSource/pendingTarget stay set so onUserActivation() can retry.
    } finally {
      if (!creationOwnsLease) releaseLease?.();
    }
  }

  /** Check if the browser supports the Translator API. */
  static isSupported(): boolean {
    return isTranslationSupported();
  }

  /** Whether translation is currently active (translator ready). */
  get isActive(): boolean {
    return this.isGenerationReady(this.configurationGeneration);
  }

  /** Whether translation is enabled in settings. True even when translator is
   * temporarily dead (awaiting auto-recovery). */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Translate text. Returns the translation or null on failure.
   *
   * Translations are processed one at a time. Two recent/high-priority
   * entries are followed by the oldest surviving entry. Only one translation
   * is in-flight at a time to prevent concurrent failures from instantly
   * hitting the MAX_CONSECUTIVE_FAILURES threshold and destroying the
   * translator.
   *
   * When the translator instance dies (destroyed after consecutive failures),
   * the language pair is preserved for a later retry. Recovery requires
   * onUserActivation() or an explicit configure() / settings action.
   *
   * @param text The text to translate.
   */
  async translate(text: string, options: TranslateRequestOptions = {}): Promise<string | null> {
    // ── Lock-free fast path: empty text and cache hits ─────────────────
    if (!text.trim()) {
      return text;
    }
    if (!this.enabled || options.signal?.aborted || this.nativeStalled) {
      return null;
    }
    const accountedBytes = text.length * 2;
    if (accountedBytes > TranslationService.MAX_TRANSLATE_TEXT_BYTES) return null;

    // Include language pair in cache key so stale translations from a
    // previous target language aren't returned after settings change.
    const cacheSource = this.pendingSource ?? this.currentSource ?? 'auto';
    const cacheTarget = this.pendingTarget ?? this.currentTarget;
    const cacheKey = `${cacheSource}:${cacheTarget}:${text}`;
    const cached = this.translationCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // ── Enqueue within the count and byte budgets ─────────────────────
    return new Promise<string | null>((resolve) => {
      while (
        this.translateQueue.length >= TranslationService.MAX_TRANSLATE_QUEUE_SIZE ||
        this.queuedBytes + accountedBytes > TranslationService.MAX_TRANSLATE_QUEUE_BYTES
      ) {
        const dropped = this.takeQueuedEntry(0);
        if (dropped) this.resolveQueueEntry(dropped, null);
      }
      const entry: TranslateQueueEntry = {
        text,
        cacheKey,
        generation: this.configurationGeneration,
        priority: options.priority ?? 0,
        accountedBytes,
        signal: options.signal,
        resolve,
        settled: false,
      };
      if (options.signal) {
        entry.onAbort = () => {
          if (this.activeEntry === entry) {
            this.nativeAbortController?.abort();
            this.resolveQueueEntry(entry, null);
          } else {
            this.withdrawQueuedEntry(entry);
          }
        };
        options.signal.addEventListener('abort', entry.onAbort, { once: true });
        if (options.signal.aborted) {
          this.resolveQueueEntry(entry, null);
          return;
        }
      }
      this.translateQueue.push(entry);
      this.queuedBytes += accountedBytes;
      this.startDrainIfNeeded();
    });
  }

  /**
   * Drain the queue one item at a time.
   * Only one drain loop runs at a time (guarded by drainActive).
   */
  private async drainQueue(): Promise<void> {
    try {
      while (this.translateQueue.length > 0) {
        const queuedEntry = this.translateQueue[0];
        if (!queuedEntry) break;

        if (queuedEntry.generation !== this.configurationGeneration) {
          const staleEntry = this.takeQueuedEntry(0);
          if (staleEntry) this.resolveQueueEntry(staleEntry, null);
          continue;
        }

        // A translator from an older generation remains installed while a
        // replacement is being created, but it must not process new work.
        // Hold the current generation until its translator is ready.
        if (!this.isGenerationReady(queuedEntry.generation)) {
          const recoveryCapped =
            !this.translator &&
            this.recoveryCycleCount >= TranslationService.MAX_RECOVERY_CYCLES &&
            !this.pendingSource &&
            !this.pendingTarget;
          if (!this.enabled || recoveryCapped) {
            this.resolveQueueEntriesForGeneration(queuedEntry.generation);
            continue;
          }
          if (
            !this.translator &&
            this.enabled &&
            this.pendingSource &&
            this.pendingTarget &&
            this.configuringGeneration !== queuedEntry.generation
          ) {
            this.resolveQueueAfterRecovery();
          }
          break;
        }

        const entry = this.takeNextEntry();
        if (!entry) break;

        this.activeEntry = entry;
        try {
          // Re-check cache after dequeue — another caller may have translated this text
          const reCached = this.translationCache.get(entry.cacheKey);
          if (reCached !== undefined) {
            this.resolveQueueEntry(entry, reCached);
            continue;
          }

          const translator = this.translator;
          if (!translator) {
            this.resolveQueueEntry(entry, null);
            continue;
          }

          const api = getTranslator();
          if (!api) {
            this.resolveQueueEntry(entry, null);
            continue;
          }
          const releaseLease = await claimNativeLease(api, TranslationService.OWNERSHIP_WAIT_MS);
          if (!releaseLease) {
            this.resolveQueueEntry(entry, null);
            this.resolveQueueEntriesForGeneration(entry.generation);
            if (this.translator === translator && this.enabled) {
              this.publishStatus('failed', 'translator-failed');
            }
            break;
          }
          if (entry.settled || !this.isGenerationReady(entry.generation)) {
            releaseLease();
            this.resolveQueueEntry(entry, null);
            continue;
          }

          // The native call keeps ownership until its own Promise settles.
          // Abort releases the UI caller immediately but cannot prove that
          // Chromium has stopped the underlying translation.
          const controller = new AbortController();
          this.nativeAbortController = controller;
          let stall!: () => void;
          const stalled = new Promise<null>((resolve) => {
            stall = () => resolve(null);
          });
          let native: Promise<string>;
          try {
            native = Promise.resolve(
              translator.translate(entry.text, { signal: controller.signal })
            );
          } catch (error) {
            native = Promise.reject(error);
          }
          const ownership = native.then(
            () => undefined,
            () => undefined
          );
          this.nativeWork = ownership;
          void ownership.finally(releaseLease);
          void ownership.finally(() => {
            if (this.nativeWork === ownership) this.nativeWork = null;
          });
          this.nativeStallTimer = setTimeout(() => {
            this.nativeStalled = true;
            controller.abort();
            this.resolveQueueEntry(entry, null);
            this.resolveQueueEntriesForGeneration(entry.generation);
            if (this.translator === translator && this.enabled) {
              this.publishStatus('failed', 'translator-failed');
            }
            stall();
          }, TranslationService.NATIVE_STALL_MS);
          try {
            const result = await Promise.race([native, stalled]);
            if (result === null || entry.settled) {
              this.resolveQueueEntry(entry, null);
              if (this.nativeStalled) break;
              continue;
            }
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
            if (entry.settled || controller.signal.aborted) continue;
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
              this.publishStatus('failed', 'translator-failed');
            } else {
              log.debug('translation.service.translate-failed', {
                errorName: errName,
                error: String(err),
              });
            }
            this.resolveQueueEntry(entry, null);
          } finally {
            this.clearNativeStallTimer();
            if (this.nativeAbortController === controller) this.nativeAbortController = null;
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
      const restartRequested = this.drainRestartRequested;
      this.drainRestartRequested = false;
      if (restartRequested && !this.nativeStalled) this.startDrainIfNeeded();
    }
  }

  destroy(): void {
    // Release the underlying Chrome Translator instance to free the per-profile
    // slot (Chromium enforces a 10-instance limit per browsing context).
    // Without this call, every RuntimeSession restart leaks one slot, and after
    // ~10 restarts (watchdog, foreground-return, standby-resolved, settings
    // changes) Translator.create() fails permanently.
    this.cancelConfiguration();
    this.configurationGeneration++;
    this.configuringGeneration = null;
    this.translatorGeneration = null;
    this.cancelActiveTranslation();
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
    // Without this, any caller awaiting translate() has a Promise that never settles,
    // causing a Promise leak that retains closures and their entire scope chain.
    for (const entry of this.translateQueue) {
      this.resolveQueueEntry(entry, null);
    }
    this.translateQueue = [];
    this.translationCache.clear();
    this.publishStatus('off', 'disabled');
    this.runtimeStatusListeners.clear();
  }
}
