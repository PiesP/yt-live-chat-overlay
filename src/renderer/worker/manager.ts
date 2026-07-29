// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * RenderWorkerManager — manages OffscreenCanvas Web Worker lifecycle
 * for off-main-thread rendering in CanvasRenderer.
 *
 * Handles worker init, message sending (with ImageBitmap transfer),
 * settings sync, translation dispatch, burst speed computation,
 * and worker destruction.
 *
 * Extracted from CanvasRenderer for single-responsibility separation.
 */

import type { Overlay } from '@app/overlay';
import type { AccessibleChatMessage, ChatMessage, OverlaySettings } from '@app-types';
import type { ImageFetchManager } from '@media/image-fetch-manager';
import { createWorkerUrl, workerSupported } from '@platform/worker-factory';
import {
  MEMBERSHIP_CARD_CONFIG,
  SUPERCHAT_CARD_CONFIG,
  toWorkerConfig,
} from '@renderer/card-config';
import { createLogger } from '@util/logging';
import type { ObservabilityReporter } from '@util/observability';
import {
  buildPartialWorkerConfig,
  sendClearStateToWorker,
  sendSetPausedToWorker,
  sendUpdateConfigToWorker,
} from './common';
import type { WorkerMessage } from './types';

type DimensionResult = { width: number; height: number };

interface WorkerManagerDeps {
  settings: OverlaySettings;
  observability: ObservabilityReporter;
  imageFetchManager: ImageFetchManager;
  estimateDimensions: (msg: ChatMessage) => DimensionResult;
  getMessagePriority: (msg: ChatMessage) => number;
  getEffectiveSpeedPxPerSec: () => number;
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
    config.color = settings.colors.normal;
    // Workers cannot access matchMedia — main thread relays the OS preference.
    config.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    config.isReplayMode = false;
    return config;
  }

  private worker: Worker | null = null;
  private active = false;
  private _queueDepth = 0;
  private _activeMessageCount = 0;
  private readonly deps: WorkerManagerDeps;
  /** Original messages retained while the Worker owns their render state. */
  private readonly sentMessages = new Map<string, ChatMessage>();
  private snapshotSequence = 0;
  private messageSnapshotRequest: {
    requestId: number;
    knownMessages: Map<string, ChatMessage>;
    resolve: (messages: ChatMessage[]) => void;
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
   * during chat bursts. ImageBitmaps are deduplicated by URL on flush.
   */
  private pendingBatch: Array<{
    /** The actual WorkerMessage (extracted from the {type, messages} wrapper). */
    msg: WorkerMessage;
    transferredImages: Array<{
      url: string;
      bitmap: ImageBitmap;
      target: 'emoji' | 'author' | 'sticker';
    }>;
    transferList: ImageBitmap[];
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
   * Returns true if the worker was successfully started.
   */
  init(
    canvas: HTMLCanvasElement,
    settings: OverlaySettings,
    overlay: Overlay,
    overrideWorkerUrl?: string | URL
  ): boolean {
    let worker: Worker | null = null;
    try {
      // Check Worker support BEFORE attempting URL construction.
      // In userscript IIFE builds, import.meta.url is mangled to {}.url
      // and Worker bundling is impossible. Skip early instead of relying
      // on the inner try/catch for URL construction failure.
      if (!workerSupported()) {
        log.debug('renderer.worker.unavailable', {
          reason: 'worker-unsupported-platform',
        });
        return false;
      }

      if (typeof OffscreenCanvas === 'undefined') {
        log.debug('renderer.worker.unavailable', {
          reason: 'no-offscreen-canvas',
        });
        return false;
      }

      const dims = overlay.getDimensions();
      const dpr = window.devicePixelRatio || 1;
      const config = RenderWorkerManager.buildWorkerConfig(settings);

      // Resolve worker URL via platform-specific factory
      const workerUrl = overrideWorkerUrl ?? createWorkerUrl('./renderer.ts');

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
        return false;
      }

      // TS can't infer that worker is non-null here despite inner catch always
      // returning — assert non-null so the rest of the block sees Worker.
      const w = worker!;

      // ── Worker ready — now transfer the canvas ───────────────────
      // Apply DPR to canvas backing store BEFORE transferring to offscreen,
      // so the worker's OffscreenCanvas renders at native device resolution
      // instead of being browser-upscaled from CSS-pixel resolution.
      if (dims) {
        canvas.width = dims.width * dpr;
        canvas.height = dims.height * dpr;
      }
      const offscreen = canvas.transferControlToOffscreen();

      w.onmessage = (e: MessageEvent) => {
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
            this._activeMessageCount =
              ((data as Record<string, unknown>).activeMessages as number) ?? 0;
            this.deps.observability.updateActiveMessages(this._activeMessageCount);
            this._queueDepth = ((data as Record<string, unknown>).pendingQueueDepth as number) ?? 0;
            this.pruneSentMessages(
              (data as Record<string, unknown>).activeMessageIds,
              (data as Record<string, unknown>).pendingMessageIds
            );
            break;
          case 'messageSnapshot': {
            const request = this.messageSnapshotRequest;
            const requestId = (data as Record<string, unknown>).requestId;
            if (!request || request.requestId !== requestId) break;
            clearTimeout(request.timer);
            this.messageSnapshotRequest = null;
            const ids = Array.isArray((data as Record<string, unknown>).messageIds)
              ? ((data as Record<string, unknown>).messageIds as unknown[])
              : [];
            request.resolve(this.takeSentMessages(ids));
            break;
          }
          case 'error':
            log.warn('renderer.worker.error', {
              error: String((data as Record<string, unknown>).error),
            });
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
        log.warn('renderer.worker.error', {
          error: err.message,
        });
      };

      // Structured clone deserialization failures (malformed messages)
      // indicate a corrupted worker state. After N consecutive failures,
      // notify the renderer so it can replace the transferred canvas. If no
      // recovery callback is registered, destroy the worker directly.
      let messageErrorCount = 0;
      let fatalErrorHandled = false;
      const MAX_MESSAGE_ERRORS = 3;
      w.onmessageerror = () => {
        messageErrorCount++;
        log.warn('renderer.worker.message-deserialization-failed', {
          attempt: messageErrorCount,
          max: MAX_MESSAGE_ERRORS,
        });
        if (messageErrorCount === MAX_MESSAGE_ERRORS && !fatalErrorHandled) {
          fatalErrorHandled = true;
          log.error('renderer.worker.max-message-errors', {
            limit: MAX_MESSAGE_ERRORS,
          });
          if (this._fatalErrorCallback) {
            this._fatalErrorCallback('worker-messageerror');
          } else {
            this.destroy();
          }
        }
      };

      w.postMessage(
        {
          type: 'init',
          canvas: offscreen,
          config,
          width: dims?.width ?? 0,
          height: dims?.height ?? 0,
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
      this.startPingPong();

      log.info('renderer.worker.initialized');
      return true;
    } catch (error: unknown) {
      // Terminate any worker created before the failure to prevent leaks.
      // The canvas is untouched when Worker creation in the inner try/catch
      // returns false — the caller can safely use the original canvas for
      // the main-thread fallback path.
      (worker as Worker)?.terminate();
      log.debug('renderer.worker.unavailable', {
        error: String(error),
      });
      return false;
    }
  }

  /**
   * Send a message to the render worker for display.
   * Serializes ChatMessage into lightweight cross-thread format.
   */
  sendToWorker(message: ChatMessage, msgId?: string): void {
    if (!this.worker) return;

    // Backpressure: drop low-priority messages when worker queue is backed up
    const maxWorkerQueue = this.deps.settings.queueMaxSize * 2;
    if (this._queueDepth > maxWorkerQueue) {
      const priority = this.deps.getMessagePriority(message);
      if (priority < 40) {
        this.deps.observability.onMessageDropped('worker_backpressure');
        return;
      }
    }

    const dims = this.deps.estimateDimensions(message);

    const text = message.content.map((s) => (s.type === 'text' ? s.content : s.emoji.alt)).join('');

    const content = message.content.map((s) => {
      if (s.type === 'text') {
        return { type: 'text', content: s.content };
      }
      return {
        type: 'emoji',
        content: s.emoji.alt,
        emojiUrl: s.emoji.url,
        emojiAlt: s.emoji.alt,
        emojiFallbackText: s.emoji.fallbackText,
      };
    });

    // ── Collect ImageBitmap transfers ──────────────────────────────────
    // Pre-converted bitmaps are transferred via postMessage transfer list,
    // eliminating duplicate fetch+decode in the worker (zero-copy transfer).
    const transferList: ImageBitmap[] = [];
    const transferredImages: Array<{
      url: string;
      bitmap: ImageBitmap;
      target: 'emoji' | 'author' | 'sticker';
    }> = [];

    const collectBitmap = (
      url: string | undefined,
      target: 'emoji' | 'author' | 'sticker'
    ): void => {
      if (!url) return;
      const bitmap = this.deps.imageFetchManager.workerBitmapCache.get(url);
      if (!bitmap) return;
      transferList.push(bitmap);
      transferredImages.push({ url, bitmap, target });
      // Suppress onEvict (bitmap.close()): the bitmap is being transferred
      // via postMessage, not evicted from cache.  Calling close() before
      // transfer causes DataCloneError or transfers an empty bitmap.
      this.deps.imageFetchManager.workerBitmapCache.delete(url, true);
    };

    for (const seg of content) {
      if (seg.type === 'emoji') collectBitmap(seg.emojiUrl, 'emoji');
    }
    collectBitmap(message.authorPhotoUrl, 'author');
    if (message.kind === 'superchat' && message.superChat?.sticker?.url) {
      collectBitmap(message.superChat.sticker.url, 'sticker');
    }

    const workerMessage: Record<string, unknown> = {
      type: 'addMessages',
      messages: [
        {
          id: msgId ?? message.id ?? `${message.timestamp}-${Math.random()}`,
          text,
          width: dims.width,
          height: dims.height,
          priority: this.deps.getMessagePriority(message),
          isBacklog: message.isBacklog ?? false,
          authorType: message.authorType,
          kind: message.kind,
          userColor: message.userColor,
          cardConfigWorker:
            message.kind === 'superchat' || message.kind === 'membership'
              ? toWorkerConfig(
                  message.kind === 'superchat' ? SUPERCHAT_CARD_CONFIG : MEMBERSHIP_CARD_CONFIG,
                  message,
                  this.deps.settings
                )
              : undefined,
          burstSpeedMultiplier: this.computeBurstSpeedMultiplier(),
          translatedText: (message as { translatedText?: string }).translatedText || undefined,
          // NEW:
          content,
          author: message.author,
          authorPhotoUrl: message.authorPhotoUrl,
          // SuperChat (if applicable)
          ...(message.kind === 'superchat' && message.superChat
            ? {
                superChatAmount: message.superChat.amount,
                superChatStickerUrl: message.superChat.sticker?.url,
              }
            : {}),
          // Membership header (if applicable)
          ...(message.kind === 'membership' ? { membershipHeader: message.membershipHeader } : {}),
        },
      ],
    };

    const workerMessageId = workerMessage.messages as Array<{ id: string }>;
    const id = workerMessageId[0]?.id;
    if (id) this.sentMessages.set(id, message);

    // ── Batch instead of immediate postMessage ──────────────────────
    // During chat bursts, multiple sendToWorker calls arrive in the same
    // microtask turn. Batching them into a single postMessage reduces
    // cross-thread overhead while keeping display latency to one microtask.
    const innerMsg = (workerMessage.messages as WorkerMessage[])[0]!;
    this.pendingBatch.push({ msg: innerMsg, transferredImages, transferList });
    this.scheduleBatchFlush();
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
   * Flush all pending batch messages to the Worker in a single postMessage.
   * ImageBitmaps are deduplicated by URL to avoid DataCloneError when the
   * same bitmap (e.g. same emoji in two consecutive messages) is referenced
   * by multiple entries in the same batch.
   */
  private flushBatch(): void {
    this.batchFlushScheduled = false;
    const batch = this.pendingBatch.splice(0);
    if (batch.length === 0) return;
    const worker = this.worker;
    if (!worker) {
      this.discardPendingBatch(batch);
      return;
    }

    const messages: WorkerMessage[] = [];
    const seenUrls = new Set<string>();
    const allTransferredImages: Array<{
      url: string;
      bitmap: ImageBitmap;
      target: 'emoji' | 'author' | 'sticker';
    }> = [];
    const allTransferList: ImageBitmap[] = [];

    for (const entry of batch) {
      messages.push(entry.msg);

      // Deduplicate ImageBitmaps by URL across the batch
      for (const img of entry.transferredImages) {
        if (!seenUrls.has(img.url)) {
          seenUrls.add(img.url);
          allTransferredImages.push(img);
          allTransferList.push(img.bitmap);
        }
      }
    }

    if (messages.length === 0) return;

    const workerMessage: Record<string, unknown> = {
      type: 'addMessages',
      messages,
    };

    if (allTransferredImages.length > 0) {
      workerMessage.imageData = allTransferredImages;
      try {
        worker.postMessage(workerMessage, allTransferList);
      } catch (error) {
        this.discardPendingBatch(batch);
        log.warn('renderer.worker.batch-send-failed', { error: String(error) });
      }
    } else {
      try {
        worker.postMessage(workerMessage);
      } catch (error) {
        this.discardPendingBatch(batch);
        log.warn('renderer.worker.batch-send-failed', { error: String(error) });
      }
    }
  }

  /** Release ImageBitmaps that were removed from the cache but never transferred. */
  private discardPendingBatch(
    batch: Array<{
      msg: WorkerMessage;
      transferredImages: Array<{
        url: string;
        bitmap: ImageBitmap;
        target: 'emoji' | 'author' | 'sticker';
      }>;
      transferList: ImageBitmap[];
    }>
  ): void {
    const bitmaps = new Set<ImageBitmap>();
    for (const entry of batch) {
      this.sentMessages.delete(entry.msg.id);
      for (const image of entry.transferredImages) bitmaps.add(image.bitmap);
    }
    for (const bitmap of bitmaps) bitmap.close();
  }

  /** Send a translation result to the render worker. */
  sendTranslation(msgId: string, translatedText: string | null): void {
    this.worker?.postMessage({
      type: 'updateTranslation',
      id: msgId,
      translatedText,
    });
  }

  /** Send updated settings to the render worker. */
  updateSettings(settings: OverlaySettings): void {
    // Update the live settings reference so internal methods (backpressure
    // check in sendToWorker, burst speed in computeBurstSpeedMultiplier)
    // use current values, not the construction-time snapshot.
    this.deps.settings = settings;

    const config = buildPartialWorkerConfig(
      settings,
      RenderWorkerManager.WORKER_CONFIG_KEYS
    ) as Record<string, unknown>;
    config.outlineWidthPx = settings.outline.enabled ? settings.outline.widthPx : 0;
    config.outlineOpacity = settings.outline.enabled ? settings.outline.opacity : 0;
    config.authorColors = { ...settings.colors };
    config.color = settings.colors.normal;
    config.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    sendUpdateConfigToWorker({ worker: this.worker }, config);
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
    sendClearStateToWorker({ worker: this.worker });
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
  snapshotMessages(timeoutMs = 250): Promise<ChatMessage[]> {
    const worker = this.worker;
    if (!worker) return Promise.resolve([]);
    if (this.messageSnapshotRequest) return Promise.resolve([]);

    const requestId = ++this.snapshotSequence;
    const knownMessages = new Map(this.sentMessages);
    return new Promise<ChatMessage[]>((resolve) => {
      const timer = setTimeout(() => {
        const request = this.messageSnapshotRequest;
        if (!request || request.requestId !== requestId) return;
        this.messageSnapshotRequest = null;
        resolve(this.takeKnownMessages(request.knownMessages));
      }, timeoutMs);
      this.messageSnapshotRequest = { requestId, knownMessages, resolve, timer };
      try {
        worker.postMessage({ type: 'snapshotMessages', requestId });
      } catch {
        clearTimeout(timer);
        this.messageSnapshotRequest = null;
        resolve(this.takeKnownMessages(knownMessages));
      }
    });
  }

  /** Destroy the render worker. */
  destroy(): void {
    // Cancel pending message snapshot timeout
    if (this.messageSnapshotRequest) {
      const request = this.messageSnapshotRequest;
      clearTimeout(request.timer);
      this.messageSnapshotRequest = null;
      request.resolve(this.takeKnownMessages(request.knownMessages));
    }
    this.batchFlushScheduled = false;
    const pendingBatch = this.pendingBatch.splice(0);
    if (pendingBatch.length > 0) this.discardPendingBatch(pendingBatch);
    this.dimensionsUnsubscribe?.();
    this.dimensionsUnsubscribe = null;
    this.stopPingPong();
    if (!this.worker) {
      this.sentMessages.clear();
      return;
    }
    // Capture the target worker so that if init() creates a new worker
    // before the ack/timeout fires, we still terminate the correct instance.
    const workerToDestroy = this.worker;
    // Detach synchronously. Settings/fallback paths must not treat a worker
    // waiting for its destroy ACK as active or post new work to it.
    this.worker = null;
    // Send a destroy message so the worker can flush in-flight work
    // (pending ImageBitmap transfers) before terminate() severs the connection.
    // Without this, bitmaps mid-transfer may not be closed properly.
    workerToDestroy.postMessage({ type: 'destroy' });

    // Listen for the worker's 'ack' before terminating, so in-flight
    // ImageBitmap transfers have time to complete.  A 500 ms safety
    // timeout prevents indefinite hangs if the ack never arrives.
    let terminated = false;
    const messageHandler = (event: MessageEvent): void => {
      if (event.data?.type === 'ack' && !terminated) {
        terminated = true;
        workerToDestroy.removeEventListener('message', messageHandler);
        workerToDestroy.terminate();
        if (this.worker === workerToDestroy) {
          this.worker = null;
        }
        // Close any remaining pre-converted bitmaps (not yet transferred).
        // ResizableByteLimitedCache.clear() calls onEvict (bitmap.close()) for each entry.
        this.deps.imageFetchManager.workerBitmapCache.clear();
      }
    };
    workerToDestroy.addEventListener('message', messageHandler);

    // Safety timeout: if the ack never arrives, force-terminate after 500ms.
    setTimeout(() => {
      if (terminated) return;
      terminated = true;
      workerToDestroy.removeEventListener('message', messageHandler);
      workerToDestroy.terminate();
      if (this.worker === workerToDestroy) {
        this.worker = null;
      }
      this.deps.imageFetchManager.workerBitmapCache.clear();
    }, 500);

    this.active = false;
    this.sentMessages.clear();
  }

  private pruneSentMessages(activeIds: unknown, pendingIds: unknown): void {
    if (!Array.isArray(activeIds) && !Array.isArray(pendingIds)) return;
    const currentIds = new Set<string>();
    for (const id of [
      ...(Array.isArray(activeIds) ? activeIds : []),
      ...(Array.isArray(pendingIds) ? pendingIds : []),
    ]) {
      if (typeof id === 'string') currentIds.add(id);
    }
    for (const id of this.sentMessages.keys()) {
      if (!currentIds.has(id)) this.sentMessages.delete(id);
    }
  }

  private takeSentMessages(ids: unknown[]): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      const message = this.sentMessages.get(id);
      if (message) {
        messages.push(message);
        this.sentMessages.delete(id);
      }
    }
    return messages;
  }

  private takeKnownMessages(knownMessages: Map<string, ChatMessage>): ChatMessage[] {
    const messages = [...knownMessages.values()];
    for (const [id, message] of knownMessages) {
      if (this.sentMessages.get(id) === message) this.sentMessages.delete(id);
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
