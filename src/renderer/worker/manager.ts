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
import type { ChatMessage, OverlaySettings } from '@app-types';
import type { ImageFetchManager } from '@media/image-fetch-manager';
import { createWorkerUrl } from '@platform/worker-factory';
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
    config.outlineWidthPx = settings.outline.widthPx;
    config.outlineOpacity = settings.outline.opacity;
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
  private readonly deps: WorkerManagerDeps;
  /** Unsubscribe function for overlay dimension changes, stored for cleanup. */
  private dimensionsUnsubscribe: (() => void) | null = null;

  /** Ping/pong health check for detecting crashed or unresponsive workers. */
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongTime = 0;
  private static readonly PING_INTERVAL_MS = 1000;
  private static readonly PONG_TIMEOUT_MS = 5000;

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

  /**
   * Whether the worker is responding to ping messages.
   * Returns false when the worker has not responded within PONG_TIMEOUT_MS
   * of the last ping, indicating a crashed or frozen worker thread.
   */
  isAlive(): boolean {
    if (!this.active || !this.worker) return true; // no worker → not applicable
    if (this.lastPongTime === 0) return true; // haven't received first pong yet
    return performance.now() - this.lastPongTime < RenderWorkerManager.PONG_TIMEOUT_MS;
  }

  /** Start periodic ping/pong health checks with the worker. */
  private startPingPong(): void {
    this.stopPingPong();
    this.lastPongTime = 0;
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
      if (typeof OffscreenCanvas === 'undefined') {
        log.debug('OffscreenCanvas not available — using main-thread renderer');
        return false;
      }

      const dims = overlay.getDimensions();
      const dpr = window.devicePixelRatio || 1;
      // Apply DPR to canvas backing store BEFORE transferring to offscreen,
      // so the worker's OffscreenCanvas renders at native device resolution
      // instead of being browser-upscaled from CSS-pixel resolution.
      if (dims) {
        canvas.width = dims.width * dpr;
        canvas.height = dims.height * dpr;
      }
      const offscreen = canvas.transferControlToOffscreen();
      const config = RenderWorkerManager.buildWorkerConfig(settings);

      // Resolve worker URL via platform-specific factory
      const workerUrl = overrideWorkerUrl ?? createWorkerUrl('./renderer.ts');

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
          log.debug('Worker creation failed:', workerError);
        }
        return false;
      }

      // TS can't infer that worker is non-null here despite inner catch always
      // returning — assert non-null so the rest of the block sees Worker.
      const w = worker!;

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
          log.debug('Ignoring malformed worker message:', data);
          return;
        }
        const { type } = data as { type: string };
        switch (type) {
          case 'ready':
            log.info('Render worker started');
            break;
          case 'stats':
            this.deps.observability.updateActiveMessages(
              ((data as Record<string, unknown>).activeMessages as number) ?? 0
            );
            this._queueDepth = ((data as Record<string, unknown>).pendingQueueDepth as number) ?? 0;
            break;
          case 'error':
            log.warn('Render worker error:', (data as Record<string, unknown>).error);
            break;
          case 'pong':
            this.lastPongTime = performance.now();
            break;
        }
      };

      w.onerror = (err) => {
        log.warn('Render worker unhandled error:', err.message);
      };

      // Structured clone deserialization failures (malformed messages)
      // indicate a corrupted worker state. After N consecutive failures,
      // destroy the worker and let the renderer fall back to main thread.
      let messageErrorCount = 0;
      const MAX_MESSAGE_ERRORS = 3;
      w.onmessageerror = () => {
        messageErrorCount++;
        log.warn(
          `Render worker message deserialization failed (${messageErrorCount}/${MAX_MESSAGE_ERRORS})`
        );
        if (messageErrorCount >= MAX_MESSAGE_ERRORS) {
          log.error(
            'Render worker exceeded max message errors — destroying worker for main-thread fallback'
          );
          this.destroy();
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

      log.info('Render worker initialized');
      return true;
    } catch (error: unknown) {
      // Terminate any worker created before the failure to prevent leaks.
      // The offscreen canvas was already transferred via postMessage, so the
      // caller must create a fresh canvas for the main-thread fallback path.
      (worker as Worker)?.terminate();
      log.debug('Render worker unavailable — using main-thread renderer:', error);
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
      this.deps.imageFetchManager.workerBitmapCache.delete(url); // bitmap is detached on transfer
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

    if (transferredImages.length > 0) {
      workerMessage.imageData = transferredImages;
      this.worker.postMessage(workerMessage, transferList);
    } else {
      this.worker.postMessage(workerMessage);
    }
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
    const config = buildPartialWorkerConfig(
      settings,
      RenderWorkerManager.WORKER_CONFIG_KEYS
    ) as Record<string, unknown>;
    config.outlineWidthPx = settings.outline.widthPx;
    config.outlineOpacity = settings.outline.opacity;
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

  /** Send replay mode state to the worker. */
  sendReplayModeToWorker(isReplayMode: boolean): void {
    if (!this.worker) return;
    sendUpdateConfigToWorker({ worker: this.worker }, { isReplayMode } as Record<string, unknown>);
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

  /** Destroy the render worker. */
  destroy(): void {
    this.dimensionsUnsubscribe?.();
    this.dimensionsUnsubscribe = null;
    this.stopPingPong();
    if (!this.worker) return;
    // Send a destroy message so the worker can flush in-flight work
    // (pending ImageBitmap transfers) before terminate() severs the connection.
    // Without this, bitmaps mid-transfer may not be closed properly.
    this.worker.postMessage({ type: 'destroy' });

    // Listen for the worker's 'ack' before terminating, so in-flight
    // ImageBitmap transfers have time to complete.  A 500 ms safety
    // timeout prevents indefinite hangs if the ack never arrives.
    let terminated = false;
    const messageHandler = (event: MessageEvent): void => {
      if (event.data?.type === 'ack' && !terminated) {
        terminated = true;
        this.worker?.removeEventListener('message', messageHandler);
        this.worker?.terminate();
        this.worker = null;
        // Close any remaining pre-converted bitmaps (not yet transferred).
        // ByteLimitedCache.clear() calls onEvict (bitmap.close()) for each entry.
        this.deps.imageFetchManager.workerBitmapCache.clear();
      }
    };
    this.worker.addEventListener('message', messageHandler);

    // Safety timeout: if the ack never arrives, force-terminate after 500ms.
    setTimeout(() => {
      if (terminated) return;
      terminated = true;
      this.worker?.removeEventListener('message', messageHandler);
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }
      this.deps.imageFetchManager.workerBitmapCache.clear();
    }, 500);

    this.active = false;
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
