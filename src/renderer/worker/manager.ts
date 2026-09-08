// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * RenderWorkerManager — manages OffscreenCanvas Web Worker lifecycle
 * for off-main-thread rendering in CanvasRenderer.
 *
 * Handles worker init, bounded message sending,
 * settings sync, translation dispatch, burst speed computation,
 * and worker destruction.
 *
 * Extracted from CanvasRenderer for single-responsibility separation.
 */

import type { Overlay } from '@app/overlay';
import type { AccessibleChatMessage, ChatMessage, OverlaySettings } from '@app-types';
import { createWorkerUrl, workerSupported } from '@platform/worker-factory';
import { createLogger } from '@util/logging';
import type { ObservabilityReporter } from '@util/observability';
import {
  buildPartialWorkerConfig,
  sendClearStateToWorker,
  sendSetPausedToWorker,
  sendUpdateConfigToWorker,
} from './common';
import { serializeWorkerMessage } from './message-serializer';
import {
  isValidWorkerBatchReceipt,
  isValidWorkerClearStateAck,
  isValidWorkerErrorMessage,
  isValidWorkerMessageSnapshot,
  isValidWorkerStatsMessage,
  MAX_ADD_MESSAGES_PER_BATCH,
} from './protocol-guards';
import type { WorkerBatchReceipt, WorkerStatsMessage } from './types';

type DimensionResult = { width: number; height: number };

export interface WorkerInitResult {
  started: boolean;
  /** True once control of the HTML canvas has been permanently transferred. */
  canvasTransferred: boolean;
}

export interface WorkerRecoveryMessage {
  message: ChatMessage;
  trackDrops: boolean;
}

interface RetainedWorkerMessage extends WorkerRecoveryMessage {
  batchSequence: number;
  epoch: number;
  locallyDeferred?: boolean;
}

interface DeferredWorkerMessage extends WorkerRecoveryMessage {
  id: string;
  priority: number;
  knownReplacement: boolean;
  epoch: number;
}

interface WorkerManagerDeps {
  settings: OverlaySettings;
  observability: ObservabilityReporter;
  estimateDimensions: (msg: ChatMessage) => DimensionResult;
  getMessagePriority: (msg: ChatMessage) => number;
  getEffectiveSpeedPxPerSec: () => number;
  onMessageDispatched?: (message: ChatMessage, id: string) => void;
  onStats?: (stats: WorkerStatsMessage) => void;
}

const log = createLogger('RenderWorkerManager');

export class RenderWorkerManager {
  /** WorkerConfig keys subset of OverlaySettings for cross-thread transfer. */
  static readonly WORKER_CONFIG_KEYS: (keyof OverlaySettings)[] = [
    'speedPxPerSec',
    'fontSize',
    'fontBaseViewportHeight',
    'fontMinSize',
    'fontMaxSize',
    'fontWeight',
    'fontFamily',
    'opacity',
    'laneSpacing',
    'safeTop',
    'safeBottom',
    'maxConcurrentMessages',
    'danmakuMode',
    'backlogSpeedMultiplier',
    'depthLayersEnabled',
    'depthFarSpeedMul',
    'depthNearSpeedMul',
    'depthFarOpacityMul',
    'motionBlurEnabled',
    'motionBlurAlpha',
    'backlogOpacityMultiplier',
    'fadeDurationMs',
    'modOwnerDurationMultiplier',
    'superChatOpacity',
    'superChatMaxBodyLines',
    'membershipMaxBodyLines',
    'showAuthor',
    'backgroundColors',
    'showSuperChatAmount',
    'translationEnabled',
    'translationMode',
    'exitPaddingPx',
    'scrollDurationMinMs',
    'scrollDurationMaxMs',
    'topBottomDurationMs',
    'queueMaxSize',
    'maxMessageAgeMs',
    'headwayGapRatio',
    'emojiCacheMb',
    'photoCacheMb',
    'stickerCacheMb',
    'textCacheMb',
    'emojiFetchLimit',
    'emojiFetchTimeoutMs',
    'failedEmojiRetryMins',
    'staggerMaxDelayMs',
    'staggerMediumDelayMs',
    'ignoreReducedMotion',
    'preserveUserColor',
    'backgroundQueueMax',
    'translationBatchSize',
  ];
  /**
   * Build a flat, serializable config object from OverlaySettings.
   * Only includes keys needed by the render worker.
   */
  static buildWorkerConfig(settings: OverlaySettings): Record<string, unknown> {
    const config: Record<string, unknown> = {};
    for (const key of RenderWorkerManager.WORKER_CONFIG_KEYS) {
      config[key] = settings[key];
    }
    config.outlineWidthPx = settings.outline.enabled ? settings.outline.widthPx : 0;
    config.outlineOpacity = settings.outline.enabled ? settings.outline.opacity : 0;
    config.authorColors = { ...settings.colors };
    config.backgroundColors = { ...settings.backgroundColors };
    config.color = settings.colors.normal;
    // Workers cannot access matchMedia — main thread relays the OS preference.
    config.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    config.isReplayMode = false;
    config.translationGeneration = 0;
    return config;
  }

  private worker: Worker | null = null;
  private active = false;
  private _queueDepth = 0;
  private _activeMessageCount = 0;
  private _laneUtilization = 0;
  private lastWorkerTotalRendered = 0;
  private lastWorkerTotalDrops = 0;
  private lastWorkerProcessedBatchSequence = 0;
  private lastWorkerReceiptSequence = 0;
  private latestWorkerPendingDepth = 0;
  private minimumWorkerPendingPriority: number | null = null;
  private currentEpoch = 0;
  private lastWorkerActiveMessageIds = new Set<string>();
  private lastWorkerPendingMessageIds = new Set<string>();
  private readonly deps: WorkerManagerDeps;
  /** Original message and accounting state retained while the Worker owns rendering. */
  private readonly sentMessages = new Map<string, RetainedWorkerMessage>();
  private nextBatchSequence = 0;
  private pendingBatchSequence = 0;
  /** State to restore if the currently pending batch cannot be posted. */
  private readonly pendingBatchPreviousStates = new Map<string, RetainedWorkerMessage | null>();
  private snapshotSequence = 0;
  private readonly unacknowledgedBatches = new Map<
    number,
    { count: number; epoch: number; saturationProbe: boolean }
  >();
  private readonly deferredIngress: DeferredWorkerMessage[] = [];
  private messageSnapshotRequest: {
    requestId: number;
    knownMessages: Map<string, RetainedWorkerMessage>;
    resolve: (messages: WorkerRecoveryMessage[]) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** Unsubscribe function for overlay dimension changes, stored for cleanup. */
  private dimensionsUnsubscribe: (() => void) | null = null;

  /** Callback to push structured text alternatives to the overlay's aria-live region. */
  private _liveRegionCallback: ((messages: AccessibleChatMessage[]) => void) | null = null;
  /** Callback invoked when the worker reaches an unrecoverable message-error state. */
  private _fatalErrorCallback: ((reason: string) => void) | null = null;

  /**
   * Batch of pending Worker messages collected in the current microtask turn.
   * Flushed atomically via queueMicrotask to reduce postMessage overhead
   * during chat bursts. Raw same-ID replacements are coalesced before serialization.
   */
  private pendingBatch: Array<{
    sourceMessage: ChatMessage;
    id: string;
    priority: number;
    trackDrops: boolean;
    batchSequence: number;
    epoch: number;
    saturationProbe: boolean;
  }> = [];
  private batchFlushScheduled = false;

  /** Ping/pong health check for detecting crashed or unresponsive workers. */
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongTime = 0;
  /** Whether the worker reported OffscreenCanvas context loss. */
  private _contextLost = false;
  /** Timestamp when the worker was started (used to detect init-time crashes). */
  private initTime = 0;
  private static readonly PING_INTERVAL_MS = 1000;
  private static readonly PONG_TIMEOUT_MS = 5000;
  /** Max time after init before the first pong must arrive. */
  private static readonly INIT_TIMEOUT_MS = 10000;

  constructor(deps: WorkerManagerDeps) {
    this.deps = deps;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Force-set the active state (used by fallback paths after Worker destruction). */
  setActive(active: boolean): void {
    this.active = active;
    if (active) {
      if (this.pendingBatch.length > 0) this.scheduleBatchFlush();
      this.drainDeferredIngress();
    }
  }

  get workerRef(): Worker | null {
    return this.worker;
  }

  get queueDepth(): number {
    return this._queueDepth;
  }

  get activeMessageCount(): number {
    return this._activeMessageCount;
  }

  get laneUtilization(): number {
    return this._laneUtilization;
  }

  /** Whether a message is still the latest same-ID value owned by the Worker. */
  isCurrentMessage(id: string, message: ChatMessage): boolean {
    return this.sentMessages.get(id)?.message === message;
  }

  /**
   * Set the callback used to forward Worker live-region text snippets
   * to the overlay's aria-live region for screen reader access.
   */
  setLiveRegionCallback(callback: (messages: AccessibleChatMessage[]) => void): void {
    this._liveRegionCallback = callback;
  }

  /** Set the callback used to recover from an unrecoverable worker failure. */
  setFatalErrorCallback(callback: (reason: string) => void): void {
    this._fatalErrorCallback = callback;
  }

  /**
   * Whether the worker is responding to ping messages.
   * Returns false when the worker has not responded within PONG_TIMEOUT_MS
   * of the last ping, indicating a crashed or frozen worker thread.
   */
  isAlive(): boolean {
    // Worker was never initialized — not applicable, renderer uses main thread.
    if (!this.active) return true;
    // Worker was initialized but has been destroyed (e.g., after consecutive
    // message deserialization errors). It is dead and cannot render.
    if (!this.worker) return false;
    // Canvas context loss means the worker can no longer render, even
    // if it still responds to pings.
    if (this._contextLost) return false;
    // Grace period after init: allow the Worker time to send its first pong.
    // If the worker crashes during initialization (before the first pong),
    // we must eventually detect it — the init timeout covers this case.
    if (this.lastPongTime === 0) {
      return performance.now() - this.initTime < RenderWorkerManager.INIT_TIMEOUT_MS;
    }
    return performance.now() - this.lastPongTime < RenderWorkerManager.PONG_TIMEOUT_MS;
  }

  /** Start periodic ping/pong health checks with the worker. */
  private startPingPong(): void {
    this.stopPingPong();
    this.lastPongTime = 0;
    this.initTime = performance.now();
    this.pingTimer = setInterval(() => {
      if (this.worker) {
        this.worker.postMessage({ type: 'ping' });
      }
    }, RenderWorkerManager.PING_INTERVAL_MS);
  }

  /** Stop periodic ping/pong health checks. */
  private stopPingPong(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.lastPongTime = 0;
    this.initTime = 0;
  }

  /**
   * Attempt to create and initialize the OffscreenCanvas render worker.
   * Reports both startup success and whether canvas control was transferred.
   */
  init(
    canvas: HTMLCanvasElement,
    settings: OverlaySettings,
    overlay: Overlay,
    overrideWorkerUrl?: string | URL
  ): WorkerInitResult {
    let worker: Worker | null = null;
    let canvasTransferred = false;
    try {
      // Check Worker support BEFORE attempting URL construction.
      // In userscript IIFE builds, import.meta.url is mangled to {}.url
      // and Worker bundling is impossible. Skip early instead of relying
      // on the inner try/catch for URL construction failure.
      if (!workerSupported()) {
        log.debug('renderer.worker.unavailable', {
          reason: 'worker-unsupported-platform',
        });
        return { started: false, canvasTransferred };
      }

      if (typeof OffscreenCanvas === 'undefined') {
        log.debug('renderer.worker.unavailable', {
          reason: 'no-offscreen-canvas',
        });
        return { started: false, canvasTransferred };
      }

      const dims = overlay.getDimensions();
      if (
        !dims ||
        !Number.isFinite(dims.width) ||
        dims.width <= 0 ||
        !Number.isFinite(dims.height) ||
        dims.height <= 0
      ) {
        log.debug('renderer.worker.unavailable', {
          reason: 'invalid-overlay-dimensions',
        });
        return { started: false, canvasTransferred };
      }
      const dpr = window.devicePixelRatio || 1;
      const config = RenderWorkerManager.buildWorkerConfig(settings);

      // Resolve worker URL via platform-specific factory
      const workerUrl = overrideWorkerUrl ?? createWorkerUrl();

      // ── Create Worker BEFORE touching the canvas ─────────────────
      // If Worker creation fails (CSP, network, etc.), the canvas must
      // stay unmodified so the main-thread fallback can acquire a 2D
      // context on the original canvas element.
      //
      // In MAIN-world content scripts, the page's CSP (not the extension's)
      // governs Worker creation. If YouTube's CSP blocks the worker URL
      // (e.g. missing worker-src directive), the constructor throws a
      // SecurityError. We catch this and fall back to main-thread rendering.
      try {
        worker = new Worker(workerUrl, { type: 'module' });
      } catch (workerError: unknown) {
        const isSecurityError =
          workerError instanceof DOMException && workerError.name === 'SecurityError';
        if (isSecurityError) {
          log.info(
            'Worker creation blocked by page CSP — falling back to main-thread renderer.' +
              ' This can happen if the page CSP has a restrictive worker-src directive.'
          );
        } else {
          log.debug('renderer.worker.creation-failed', {
            error: String(workerError),
          });
        }
        return { started: false, canvasTransferred };
      }

      // TS can't infer that worker is non-null here despite inner catch always
      // returning — assert non-null so the rest of the block sees Worker.
      const w = worker!;

      // ── Worker ready — now transfer the canvas ───────────────────
      // Apply DPR to canvas backing store BEFORE transferring to offscreen,
      // so the worker's OffscreenCanvas renders at native device resolution
      // instead of being browser-upscaled from CSS-pixel resolution.
      canvas.width = dims.width * dpr;
      canvas.height = dims.height * dpr;
      const offscreen = canvas.transferControlToOffscreen();
      canvasTransferred = true;

      let messageErrorCount = 0;
      let fatalErrorHandled = false;
      const MAX_MESSAGE_ERRORS = 3;
      const handleFatalError = (reason: string): void => {
        if (fatalErrorHandled || this.worker !== w) return;
        fatalErrorHandled = true;
        if (this._fatalErrorCallback) {
          this._fatalErrorCallback(reason);
        } else {
          this.destroy();
        }
      };

      w.onmessage = (e: MessageEvent) => {
        if (this.worker !== w) return;
        // Type guard: validate message shape before dispatch.
        // Malformed or foreign messages (e.g. from a stale worker after
        // recreation, or injected by a page-level listener) must not
        // cause undefined property access.
        const data = e.data;
        if (
          data === null ||
          typeof data !== 'object' ||
          !('type' in data) ||
          typeof (data as { type: unknown }).type !== 'string'
        ) {
          log.debug('renderer.worker.malformed-message', {
            data: String(data),
          });
          return;
        }
        const { type } = data as { type: string };
        switch (type) {
          case 'ready':
            log.info('renderer.worker.started');
            break;
          case 'stats':
            if (!isValidWorkerStatsMessage(data)) {
              log.debug('renderer.worker.malformed-stats');
              break;
            }
            this.applyWorkerStats(data);
            break;
          case 'batchReceipt':
            if (!isValidWorkerBatchReceipt(data)) {
              log.debug('renderer.worker.malformed-batch-receipt');
              break;
            }
            this.applyBatchReceipt(data);
            break;
          case 'clearStateAck':
            if (!isValidWorkerClearStateAck(data)) {
              log.debug('renderer.worker.malformed-clear-state-ack');
              break;
            }
            this.applyClearStateAck(data.epoch);
            break;
          case 'messageSnapshot': {
            if (!isValidWorkerMessageSnapshot(data)) {
              log.debug('renderer.worker.malformed-message-snapshot');
              break;
            }
            if (data.processedBatchSequence > this.nextBatchSequence) {
              log.debug('renderer.worker.message-snapshot-ahead');
              break;
            }
            const request = this.messageSnapshotRequest;
            if (!request || request.requestId !== data.requestId) break;
            clearTimeout(request.timer);
            this.messageSnapshotRequest = null;
            request.resolve(
              this.takeSnapshotMessages(
                data.activeMessageIds,
                data.pendingMessageIds,
                data.processedBatchSequence,
                request.knownMessages
              )
            );
            break;
          }
          case 'error':
            if (!isValidWorkerErrorMessage(data)) {
              log.debug('renderer.worker.malformed-error');
              break;
            }
            log.warn('renderer.worker.error', {
              error: data.error,
            });
            handleFatalError('worker-runtime-error');
            break;
          case 'pong':
            this.lastPongTime = performance.now();
            break;
          case 'contextLost':
            log.warn('renderer.worker.context-lost');
            this._contextLost = true;
            break;
          case 'liveRegionSnippets':
            if (this._liveRegionCallback) {
              this._liveRegionCallback(
                ((data as Record<string, unknown>).messages as AccessibleChatMessage[]) ?? []
              );
            }
            break;
        }
      };

      w.onerror = (err) => {
        if (this.worker !== w) return;
        log.warn('renderer.worker.error', {
          error: err.message || 'Worker script failed to load or execute',
        });
        err.preventDefault();
        handleFatalError('worker-load-error');
      };

      // Structured clone deserialization failures (malformed messages)
      // indicate a corrupted worker state. After N consecutive failures,
      // notify the renderer so it can replace the transferred canvas. If no
      // recovery callback is registered, destroy the worker directly.
      w.onmessageerror = () => {
        if (this.worker !== w) return;
        messageErrorCount++;
        log.warn('renderer.worker.message-deserialization-failed', {
          attempt: messageErrorCount,
          max: MAX_MESSAGE_ERRORS,
        });
        if (messageErrorCount === MAX_MESSAGE_ERRORS) {
          log.error('renderer.worker.max-message-errors', {
            limit: MAX_MESSAGE_ERRORS,
          });
          handleFatalError('worker-messageerror');
        }
      };

      w.postMessage(
        {
          type: 'init',
          canvas: offscreen,
          config,
          width: dims.width,
          height: dims.height,
          dpr,
        },
        [offscreen]
      );

      this.dimensionsUnsubscribe = overlay.onDimensionsChanged((d) => {
        if (d) {
          const currentDpr = window.devicePixelRatio || 1;
          w.postMessage({
            type: 'resize',
            width: d.width,
            height: d.height,
            dpr: currentDpr,
          });
        }
      });

      this.worker = w;
      this.active = true;
      this.currentEpoch = 0;
      this.nextBatchSequence = 0;
      this.pendingBatchSequence = 0;
      this.lastWorkerReceiptSequence = 0;
      this.latestWorkerPendingDepth = 0;
      this.minimumWorkerPendingPriority = null;
      this.unacknowledgedBatches.clear();
      this.deferredIngress.length = 0;
      this.resetWorkerStats();
      this.startPingPong();

      log.info('renderer.worker.initialized');
      return { started: true, canvasTransferred };
    } catch (error: unknown) {
      // Terminate any worker created before the failure to prevent leaks.
      // The explicit canvasTransferred result tells the caller whether the
      // original canvas remains usable for main-thread fallback.
      (worker as Worker)?.terminate();
      this.worker = null;
      this.active = false;
      this.dimensionsUnsubscribe?.();
      this.dimensionsUnsubscribe = null;
      this.stopPingPong();
      log.debug('renderer.worker.unavailable', {
        error: String(error),
      });
      return { started: false, canvasTransferred };
    }
  }

  /**
   * Send a message to the render worker for display.
   * Serializes ChatMessage into lightweight cross-thread format.
   */
  sendToWorker(message: ChatMessage, msgId?: string, trackDrops = true): boolean {
    if (!this.active || !this.worker) return false;

    const priority = this.deps.getMessagePriority(message);
    const id = msgId ?? message.id ?? `${message.timestamp}-${Math.random()}`;
    const deferredForId = this.deferredIngress.find((entry) => entry.id === id);
    const isKnownReplacement =
      message.actionType === 'replace' &&
      (this.sentMessages.has(id) || deferredForId !== undefined);

    // A replacement still in the current local batch consumes the same queue
    // slot. Keep only its latest value before doing another cross-thread send.
    if (isKnownReplacement) {
      const localIndex = this.pendingBatch.findIndex((entry) => entry.id === id);
      if (localIndex >= 0) {
        return this.prepareMessageForBatch(message, id, priority, trackDrops, false, localIndex);
      }
    }

    const projectedWork = this.getProjectedWorkerWork();
    if (projectedWork < this.deps.settings.queueMaxSize) {
      return this.prepareMessageForBatch(message, id, priority, trackDrops, false);
    }

    // Keep paid/high-priority messages and known replacements as bounded raw
    // ingress. They are serialized only when a receipt proves capacity or the
    // Worker reports that the next priority can displace a queued entry.
    if (isKnownReplacement || priority >= 40) {
      const accepted = this.enqueueDeferredIngress({
        message,
        id,
        priority,
        knownReplacement: isKnownReplacement,
        trackDrops,
        epoch: this.currentEpoch,
      });
      this.drainDeferredIngress();
      return accepted;
    }

    if (trackDrops) this.deps.observability.onMessageDropped('worker_backpressure');
    return false;
  }

  private prepareMessageForBatch(
    message: ChatMessage,
    id: string,
    priority: number,
    trackDrops: boolean,
    saturationProbe: boolean,
    replaceIndex = -1
  ): boolean {
    if (!this.active || !this.worker) return false;

    if (replaceIndex < 0 && this.pendingBatch.length >= MAX_ADD_MESSAGES_PER_BATCH) {
      this.flushBatch();
      if (!this.active || !this.worker) return false;
    }

    if (this.pendingBatchSequence === 0) {
      this.nextBatchSequence = Math.min(Number.MAX_SAFE_INTEGER, this.nextBatchSequence + 1);
      this.pendingBatchSequence = this.nextBatchSequence;
    }
    if (!this.pendingBatchPreviousStates.has(id)) {
      this.pendingBatchPreviousStates.set(id, this.sentMessages.get(id) ?? null);
    }
    this.sentMessages.set(id, {
      message,
      batchSequence: this.pendingBatchSequence,
      epoch: this.currentEpoch,
      trackDrops,
    });

    if (replaceIndex >= 0) {
      const previous = this.pendingBatch[replaceIndex];
      if (!previous) return false;
      this.pendingBatch[replaceIndex] = {
        sourceMessage: message,
        id,
        priority,
        trackDrops,
        batchSequence: previous.batchSequence,
        epoch: previous.epoch,
        saturationProbe: previous.saturationProbe,
      };
      return true;
    }

    // ── Batch instead of immediate postMessage ──────────────────────
    // During chat bursts, multiple sendToWorker calls arrive in the same
    // microtask turn. Batching them into a single postMessage reduces
    // cross-thread overhead while keeping display latency to one microtask.
    this.pendingBatch.push({
      sourceMessage: message,
      id,
      priority,
      trackDrops,
      batchSequence: this.pendingBatchSequence,
      epoch: this.currentEpoch,
      saturationProbe,
    });
    if (this.pendingBatch.length >= MAX_ADD_MESSAGES_PER_BATCH) this.flushBatch();
    else this.scheduleBatchFlush();
    return true;
  }

  private getProjectedWorkerWork(): number {
    let unacknowledged = 0;
    for (const batch of this.unacknowledgedBatches.values()) {
      if (batch.epoch === this.currentEpoch) unacknowledged += batch.count;
    }
    return this.latestWorkerPendingDepth + unacknowledged + this.pendingBatch.length;
  }

  private hasSaturationProbeInFlight(): boolean {
    if (this.pendingBatch.some((entry) => entry.saturationProbe)) return true;
    for (const batch of this.unacknowledgedBatches.values()) {
      if (batch.epoch === this.currentEpoch && batch.saturationProbe) return true;
    }
    return false;
  }

  private enqueueDeferredIngress(entry: DeferredWorkerMessage): boolean {
    const existingIndex = this.deferredIngress.findIndex((queued) => queued.id === entry.id);
    if (entry.knownReplacement && existingIndex >= 0) {
      this.deferredIngress[existingIndex] = entry;
      return true;
    }

    const capacity = Math.max(
      1,
      this.deps.settings.queueMaxSize + (this.deps.settings.maxConcurrentMessages ?? 0)
    );
    if (this.deferredIngress.length < capacity) {
      this.deferredIngress.push(entry);
      return true;
    }

    const rank = (candidate: DeferredWorkerMessage): number =>
      candidate.knownReplacement ? Number.MAX_SAFE_INTEGER : candidate.priority;
    let lowestIndex = 0;
    for (let index = 1; index < this.deferredIngress.length; index++) {
      const candidate = this.deferredIngress[index];
      const lowest = this.deferredIngress[lowestIndex];
      if (candidate && lowest && rank(candidate) < rank(lowest)) lowestIndex = index;
    }
    const lowest = this.deferredIngress[lowestIndex];
    if (!lowest || rank(entry) <= rank(lowest)) {
      if (entry.trackDrops) this.deps.observability.onMessageDropped('worker_backpressure');
      return false;
    }
    if (lowest.trackDrops) this.deps.observability.onMessageDropped('worker_backpressure');
    this.deferredIngress[lowestIndex] = entry;
    return true;
  }

  private drainDeferredIngress(): void {
    if (!this.active || !this.worker || this.deferredIngress.length === 0) return;
    this.deferredIngress.sort((a, b) => {
      if (a.knownReplacement !== b.knownReplacement) return a.knownReplacement ? -1 : 1;
      return b.priority - a.priority;
    });

    while (this.deferredIngress.length > 0) {
      const projected = this.getProjectedWorkerWork();
      const candidate = this.deferredIngress[0];
      if (!candidate) return;
      if (projected < this.deps.settings.queueMaxSize) {
        this.deferredIngress.shift();
        this.prepareMessageForBatch(
          candidate.message,
          candidate.id,
          candidate.priority,
          candidate.trackDrops,
          false
        );
        continue;
      }
      if (this.hasSaturationProbeInFlight()) return;
      const canDisplace =
        candidate.knownReplacement ||
        this.minimumWorkerPendingPriority === null ||
        candidate.priority > this.minimumWorkerPendingPriority;
      if (!canDisplace) return;
      this.deferredIngress.shift();
      this.prepareMessageForBatch(
        candidate.message,
        candidate.id,
        candidate.priority,
        candidate.trackDrops,
        true
      );
      return;
    }
  }

  /**
   * Schedule an atomic flush of all pending batch messages.
   * Uses queueMicrotask so messages collected in the current sync execution
   * context are dispatched together in one postMessage call.
   */
  private scheduleBatchFlush(): void {
    if (this.batchFlushScheduled || !this.worker) return;
    this.batchFlushScheduled = true;
    queueMicrotask(() => this.flushBatch());
  }

  /**
   * Serialize and flush the admitted raw batch in a single postMessage.
   */
  private flushBatch(): void {
    this.batchFlushScheduled = false;
    if (!this.active) return;
    const batch = this.pendingBatch.splice(0);
    const previousStates = new Map(this.pendingBatchPreviousStates);
    this.pendingBatchPreviousStates.clear();
    this.pendingBatchSequence = 0;
    if (batch.length === 0) return;
    const worker = this.worker;
    if (!worker) {
      this.discardPendingBatch(batch, previousStates);
      return;
    }

    const messages = batch.map((entry) => {
      const dimensions = this.deps.estimateDimensions(entry.sourceMessage);
      return serializeWorkerMessage({
        message: entry.sourceMessage,
        id: entry.id,
        dimensions,
        priority: entry.priority,
        burstSpeedMultiplier: this.computeBurstSpeedMultiplier(),
        settings: this.deps.settings,
        trackDrops: entry.trackDrops,
      });
    });

    if (messages.length === 0) return;

    const workerMessage: Record<string, unknown> = {
      type: 'addMessages',
      messages,
      batchSequence: batch[0]?.batchSequence,
      epoch: batch[0]?.epoch,
    };
    const sequence = batch[0]?.batchSequence;
    if (sequence === undefined) return;
    this.unacknowledgedBatches.set(sequence, {
      count: messages.length,
      epoch: batch[0]?.epoch ?? this.currentEpoch,
      saturationProbe: batch.some((entry) => entry.saturationProbe),
    });
    try {
      worker.postMessage(workerMessage);
      for (const entry of batch) {
        this.deps.onMessageDispatched?.(entry.sourceMessage, entry.id);
      }
    } catch (error) {
      this.unacknowledgedBatches.delete(sequence);
      this.discardPendingBatch(batch, previousStates);
      log.warn('renderer.worker.batch-send-failed', { error: String(error) });
    }
  }

  /** Restore retained ownership when a raw batch cannot be posted. */
  private discardPendingBatch(
    batch: Array<{
      sourceMessage: ChatMessage;
      id: string;
      priority: number;
      trackDrops: boolean;
      batchSequence: number;
      epoch: number;
      saturationProbe: boolean;
    }>,
    previousStates: ReadonlyMap<string, RetainedWorkerMessage | null>
  ): void {
    const failedBatchSequence = batch[0]?.batchSequence;
    if (failedBatchSequence !== undefined) {
      for (const [id, previous] of previousStates) {
        if (this.sentMessages.get(id)?.batchSequence !== failedBatchSequence) continue;
        if (previous) {
          this.sentMessages.set(id, previous);
        } else {
          this.sentMessages.delete(id);
        }
      }
    }
  }

  /** Send a translation result to the render worker. */
  sendTranslation(
    msgId: string,
    translatedText: string | null,
    geometry: { width: number; height: number; translationHeight: number },
    translationGeneration = 0
  ): void {
    this.worker?.postMessage({
      type: 'updateTranslation',
      id: msgId,
      translatedText,
      width: geometry.width,
      height: geometry.height,
      translationHeight: geometry.translationHeight,
      translationGeneration,
    });
  }

  /** Restore Worker-owned messages to their untranslated card geometry. */
  clearTranslations(
    estimateGeometry: (message: ChatMessage) => {
      width: number;
      height: number;
      translationHeight: number;
    },
    translationGeneration = 0
  ): void {
    if (!this.worker) return;
    for (const [id, retained] of this.sentMessages) {
      this.sendTranslation(id, null, estimateGeometry(retained.message), translationGeneration);
    }
  }

  /** Send updated settings to the render worker. */
  updateSettings(settings: OverlaySettings, translationGeneration = 0): void {
    const previous = this.deps.settings;
    const messageLayoutChanged =
      settings.fontSize !== previous.fontSize ||
      settings.fontWeight !== previous.fontWeight ||
      settings.fontFamily !== previous.fontFamily ||
      settings.outline.enabled !== previous.outline.enabled ||
      settings.outline.widthPx !== previous.outline.widthPx ||
      settings.superChatMaxBodyLines !== previous.superChatMaxBodyLines ||
      settings.membershipMaxBodyLines !== previous.membershipMaxBodyLines ||
      settings.showSuperChatAmount !== previous.showSuperChatAmount ||
      settings.translationMode !== previous.translationMode ||
      Object.keys(settings.showAuthor).some(
        (key) =>
          settings.showAuthor[key as keyof OverlaySettings['showAuthor']] !==
          previous.showAuthor[key as keyof OverlaySettings['showAuthor']]
      );
    // Update the live settings reference so internal methods (backpressure
    // check in sendToWorker, burst speed in computeBurstSpeedMultiplier)
    // use current values, not the construction-time snapshot.
    this.deps.settings = settings;
    if (!this.active || !this.worker) return;

    const config = buildPartialWorkerConfig(
      settings,
      RenderWorkerManager.WORKER_CONFIG_KEYS
    ) as Record<string, unknown>;
    config.outlineWidthPx = settings.outline.enabled ? settings.outline.widthPx : 0;
    config.outlineOpacity = settings.outline.enabled ? settings.outline.opacity : 0;
    config.authorColors = { ...settings.colors };
    config.backgroundColors = { ...settings.backgroundColors };
    config.color = settings.colors.normal;
    config.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    config.translationGeneration = translationGeneration;
    sendUpdateConfigToWorker({ worker: this.worker }, config);
    if (messageLayoutChanged) {
      const retained = [...this.sentMessages.entries()].filter(
        ([, entry]) => entry.epoch === this.currentEpoch
      );
      for (const [id, entry] of retained) {
        this.sendToWorker({ ...entry.message, actionType: 'replace' }, id, false);
      }
    }
  }

  /** Inform the render worker of a pause/resume state change (tab visibility or video). */
  setPaused(paused: boolean): void {
    if (!this.worker) return;
    sendSetPausedToWorker({ worker: this.worker }, paused);
  }

  /** Inform the render worker of a user-initiated pause (Space key). */
  setUserPaused(paused: boolean): void {
    this.worker?.postMessage({ type: 'setUserPaused', paused });
  }

  /** Send replay mode state to the worker. */
  sendReplayModeToWorker(isReplayMode: boolean): void {
    if (!this.worker) return;
    sendUpdateConfigToWorker({ worker: this.worker }, { isReplayMode } as Record<string, unknown>);
  }

  /**
   * Relay OS reduced-motion preference change to the Worker.
   * Workers cannot access matchMedia — the main thread must push updates.
   */
  sendReducedMotion(reducedMotion: boolean): void {
    if (!this.worker) return;
    sendUpdateConfigToWorker({ worker: this.worker }, { reducedMotion } as Record<string, unknown>);
  }

  /**
   * Clear the worker's renderer state (active messages, pending queue,
   * lane allocator) while preserving caches (text bitmaps, emoji, etc.).
   * Used by performOverlayRefresh to reset both main-thread and worker
   * state consistently.
   */
  clearState(): void {
    if (!this.worker) return;
    const pendingBatch = this.pendingBatch.splice(0);
    const previousStates = new Map(this.pendingBatchPreviousStates);
    this.pendingBatchPreviousStates.clear();
    this.pendingBatchSequence = 0;
    this.batchFlushScheduled = false;
    if (pendingBatch.length > 0) this.discardPendingBatch(pendingBatch, previousStates);
    this.deferredIngress.length = 0;
    this.currentEpoch = Math.min(Number.MAX_SAFE_INTEGER, this.currentEpoch + 1);
    sendClearStateToWorker({ worker: this.worker }, this.currentEpoch);
  }

  /** Notify the render worker of a lane density factor change (burst-driven half-cell mode). */
  sendLaneDensity(factor: number): void {
    this.worker?.postMessage({ type: 'laneDensity', factor });
  }

  /**
   * Request all messages still owned by the Worker.
   *
   * The response is used during Worker recovery so messages waiting in the
   * Worker queue, as well as messages already on screen, are not lost when
   * the transferred canvas has to be replaced.
   */
  snapshotMessages(timeoutMs = 250): Promise<WorkerRecoveryMessage[]> {
    const worker = this.worker;
    if (!worker) return Promise.resolve([]);
    if (this.messageSnapshotRequest) return Promise.resolve([]);

    const requestId = ++this.snapshotSequence;
    const knownMessages = this.captureRecoverableMessages();
    return new Promise<WorkerRecoveryMessage[]>((resolve) => {
      const timer = setTimeout(() => {
        const request = this.messageSnapshotRequest;
        if (!request || request.requestId !== requestId) return;
        this.messageSnapshotRequest = null;
        resolve(this.takeKnownMessages(request.knownMessages));
      }, timeoutMs);
      this.messageSnapshotRequest = {
        requestId,
        knownMessages,
        resolve,
        timer,
      };
      try {
        worker.postMessage({ type: 'snapshotMessages', requestId });
      } catch {
        clearTimeout(timer);
        this.messageSnapshotRequest = null;
        resolve(this.takeKnownMessages(knownMessages));
      }
    });
  }

  private captureRecoverableMessages(): Map<string, RetainedWorkerMessage> {
    const messages = new Map<string, RetainedWorkerMessage>();
    for (const [id, retained] of this.sentMessages) {
      if (retained.epoch === this.currentEpoch) messages.set(id, retained);
    }
    for (const deferred of this.deferredIngress) {
      if (deferred.epoch !== this.currentEpoch) continue;
      messages.set(deferred.id, {
        message: deferred.message,
        trackDrops: deferred.trackDrops,
        batchSequence: Math.min(Number.MAX_SAFE_INTEGER, this.nextBatchSequence + 1),
        epoch: deferred.epoch,
        locallyDeferred: true,
      });
    }
    return messages;
  }

  /** Destroy the render worker. */
  destroy(): void {
    this.active = false;
    this._contextLost = false;
    this.resetWorkerStats();
    // Cancel pending message snapshot timeout
    if (this.messageSnapshotRequest) {
      const request = this.messageSnapshotRequest;
      clearTimeout(request.timer);
      this.messageSnapshotRequest = null;
      request.resolve(this.takeKnownMessages(request.knownMessages));
    }
    this.batchFlushScheduled = false;
    const pendingBatch = this.pendingBatch.splice(0);
    const pendingPreviousStates = new Map(this.pendingBatchPreviousStates);
    this.pendingBatchPreviousStates.clear();
    if (pendingBatch.length > 0) {
      this.discardPendingBatch(pendingBatch, pendingPreviousStates);
    }
    this.deferredIngress.length = 0;
    this.unacknowledgedBatches.clear();
    this.dimensionsUnsubscribe?.();
    this.dimensionsUnsubscribe = null;
    this.stopPingPong();
    if (!this.worker) {
      this.sentMessages.clear();
      this.nextBatchSequence = 0;
      this.pendingBatchSequence = 0;
      return;
    }
    // Capture the target worker so that if init() creates a new worker
    // before the ack/timeout fires, we still terminate the correct instance.
    const workerToDestroy = this.worker;
    // Detach synchronously. Settings/fallback paths must not treat a worker
    // waiting for its destroy ACK as active or post new work to it.
    this.worker = null;
    // Ask the worker to clean up realm-local resources before termination.
    workerToDestroy.postMessage({ type: 'destroy' });

    // Listen for the worker's 'ack' before terminating. A 500 ms safety
    // timeout prevents indefinite hangs if the ack never arrives.
    let terminated = false;
    let terminationTimeout: ReturnType<typeof setTimeout> | null = null;
    const finalizeWorkerTermination = (): void => {
      if (terminated) return;
      terminated = true;
      if (terminationTimeout !== null) {
        clearTimeout(terminationTimeout);
        terminationTimeout = null;
      }
      workerToDestroy.removeEventListener('message', messageHandler);
      workerToDestroy.terminate();
      if (this.worker === workerToDestroy) {
        this.worker = null;
      }
    };
    const messageHandler = (event: MessageEvent): void => {
      if (event.data?.type === 'ack') finalizeWorkerTermination();
    };
    workerToDestroy.addEventListener('message', messageHandler);

    // Safety timeout: if the ack never arrives, force-terminate after 500ms.
    terminationTimeout = setTimeout(finalizeWorkerTermination, 500);

    this.sentMessages.clear();
    this.nextBatchSequence = 0;
    this.pendingBatchSequence = 0;
  }

  private applyWorkerStats(stats: WorkerStatsMessage): void {
    if (
      stats.totalRendered < this.lastWorkerTotalRendered ||
      stats.totalDrops < this.lastWorkerTotalDrops ||
      stats.processedBatchSequence < this.lastWorkerProcessedBatchSequence ||
      stats.processedBatchSequence > this.nextBatchSequence
    ) {
      log.debug('renderer.worker.stats-regressed-or-ahead');
      return;
    }

    this._activeMessageCount = stats.activeMessages;
    if (stats.processedBatchSequence >= this.lastWorkerReceiptSequence) {
      this.lastWorkerReceiptSequence = stats.processedBatchSequence;
      this._queueDepth = stats.pendingQueueDepth;
      this.latestWorkerPendingDepth = stats.pendingQueueDepth;
      for (const [sequence, batch] of this.unacknowledgedBatches) {
        if (batch.epoch === this.currentEpoch && sequence <= stats.processedBatchSequence) {
          this.unacknowledgedBatches.delete(sequence);
        }
      }
    }
    this._laneUtilization = stats.laneUtilization;

    const renderedDelta = stats.totalRendered - this.lastWorkerTotalRendered;
    if (renderedDelta > 0) this.deps.observability.onMessagesRendered(renderedDelta);
    this.lastWorkerTotalRendered = stats.totalRendered;

    const dropDelta = stats.totalDrops - this.lastWorkerTotalDrops;
    if (dropDelta > 0) {
      this.deps.observability.onMessagesDropped(dropDelta);
    }
    this.lastWorkerTotalDrops = stats.totalDrops;
    this.lastWorkerProcessedBatchSequence = stats.processedBatchSequence;
    this.lastWorkerActiveMessageIds = new Set(stats.activeMessageIds);
    this.lastWorkerPendingMessageIds = new Set(stats.pendingMessageIds);

    this.deps.observability.updateActiveMessages(this._activeMessageCount);
    this.deps.observability.updateQueueDepth(this._queueDepth);
    this.deps.observability.updateLaneUtilization(this._laneUtilization);
    this.pruneSentMessages(
      stats.activeMessageIds,
      stats.pendingMessageIds,
      stats.processedBatchSequence
    );
    this.deps.onStats?.(stats);
    this.deps.observability.tick();
    this.drainDeferredIngress();
  }

  private applyBatchReceipt(receipt: WorkerBatchReceipt): void {
    if (
      receipt.epoch !== this.currentEpoch ||
      receipt.batchSequence < this.lastWorkerReceiptSequence ||
      receipt.batchSequence > this.nextBatchSequence
    ) {
      return;
    }
    this.lastWorkerReceiptSequence = receipt.batchSequence;
    this.latestWorkerPendingDepth = receipt.pendingQueueDepth;
    this.minimumWorkerPendingPriority = receipt.minimumPendingPriority;
    this._queueDepth = receipt.pendingQueueDepth;
    for (const [sequence, batch] of this.unacknowledgedBatches) {
      if (batch.epoch === receipt.epoch && sequence <= receipt.batchSequence) {
        this.unacknowledgedBatches.delete(sequence);
      }
    }
    this.deps.observability.updateQueueDepth(this._queueDepth);
    this.drainDeferredIngress();
  }

  private applyClearStateAck(epoch: number): void {
    if (epoch !== this.currentEpoch) return;
    this.latestWorkerPendingDepth = 0;
    this.minimumWorkerPendingPriority = null;
    this._queueDepth = 0;
    this._activeMessageCount = 0;
    this.lastWorkerActiveMessageIds.clear();
    this.lastWorkerPendingMessageIds.clear();
    for (const [sequence, batch] of this.unacknowledgedBatches) {
      if (batch.epoch < epoch) this.unacknowledgedBatches.delete(sequence);
    }
    for (const [id, retained] of this.sentMessages) {
      if (retained.epoch < epoch) this.sentMessages.delete(id);
    }
    this.deps.observability.updateActiveMessages(0);
    this.deps.observability.updateQueueDepth(0);
    this.drainDeferredIngress();
  }

  private resetWorkerStats(): void {
    this._activeMessageCount = 0;
    this._queueDepth = 0;
    this._laneUtilization = 0;
    this.lastWorkerTotalRendered = 0;
    this.lastWorkerTotalDrops = 0;
    this.lastWorkerProcessedBatchSequence = 0;
    this.lastWorkerReceiptSequence = 0;
    this.latestWorkerPendingDepth = 0;
    this.minimumWorkerPendingPriority = null;
    this.lastWorkerActiveMessageIds.clear();
    this.lastWorkerPendingMessageIds.clear();
    this.deps.observability.updateActiveMessages(0);
    this.deps.observability.updateQueueDepth(0);
    this.deps.observability.updateLaneUtilization(0);
  }

  private pruneSentMessages(
    activeIds: readonly string[],
    pendingIds: readonly string[],
    processedBatchSequence: number
  ): void {
    const currentIds = new Set([...activeIds, ...pendingIds]);
    for (const [id, retained] of this.sentMessages) {
      if (retained.batchSequence <= processedBatchSequence && !currentIds.has(id)) {
        this.sentMessages.delete(id);
      }
    }
  }

  private takeSnapshotMessages(
    activeIds: readonly string[],
    pendingIds: readonly string[],
    processedBatchSequence: number,
    knownMessages: ReadonlyMap<string, RetainedWorkerMessage>
  ): WorkerRecoveryMessage[] {
    const messages: WorkerRecoveryMessage[] = [];
    const activeIdSet = new Set(activeIds);
    const pendingIdSet = new Set(pendingIds);
    for (const [id, retained] of knownMessages) {
      if (retained.locallyDeferred) {
        const deferredIndex = this.deferredIngress.findIndex(
          (entry) => entry.id === id && entry.message === retained.message
        );
        if (deferredIndex >= 0) {
          messages.push({ message: retained.message, trackDrops: retained.trackDrops });
          this.deferredIngress.splice(deferredIndex, 1);
        }
        continue;
      }
      if (
        activeIdSet.has(id) ||
        pendingIdSet.has(id) ||
        retained.batchSequence > processedBatchSequence
      ) {
        messages.push({
          message: retained.message,
          trackDrops:
            retained.trackDrops &&
            !activeIdSet.has(id) &&
            (pendingIdSet.has(id) || retained.batchSequence > processedBatchSequence),
        });
      }
      if (this.sentMessages.get(id) === retained) {
        this.sentMessages.delete(id);
      }
    }
    return messages;
  }

  private takeKnownMessages(
    knownMessages: ReadonlyMap<string, RetainedWorkerMessage>
  ): WorkerRecoveryMessage[] {
    const messages: WorkerRecoveryMessage[] = [];
    for (const [id, retained] of knownMessages) {
      if (retained.locallyDeferred) {
        const deferredIndex = this.deferredIngress.findIndex(
          (entry) => entry.id === id && entry.message === retained.message
        );
        if (deferredIndex >= 0) {
          messages.push({ message: retained.message, trackDrops: retained.trackDrops });
          this.deferredIngress.splice(deferredIndex, 1);
        }
        continue;
      }
      if (this.sentMessages.get(id) !== retained) continue;
      const wasActive = this.lastWorkerActiveMessageIds.has(id);
      const wasPending = this.lastWorkerPendingMessageIds.has(id);
      const isUnacknowledged = retained.batchSequence > this.lastWorkerProcessedBatchSequence;
      if (!wasActive && !wasPending && !isUnacknowledged) {
        this.sentMessages.delete(id);
        continue;
      }
      messages.push({
        message: retained.message,
        // A timed-out Worker cannot prove a newer batch was placed. Preserve
        // tracking only for last-known pending or unacknowledged work.
        trackDrops: retained.trackDrops && !wasActive && (wasPending || isUnacknowledged),
      });
      this.sentMessages.delete(id);
    }
    return messages;
  }

  /**
   * Compute the burst speed multiplier: ratio of effective (burst-adjusted)
   * speed to base speed. Always ≥ 1.0.
   */
  private computeBurstSpeedMultiplier(): number {
    const baseSpeed = this.deps.settings.speedPxPerSec;
    const safeSpeed = Math.max(1, baseSpeed);
    return Math.max(1.0, this.deps.getEffectiveSpeedPxPerSec() / safeSpeed);
  }
}
