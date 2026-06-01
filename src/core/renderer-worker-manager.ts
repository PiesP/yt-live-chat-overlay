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

import type { ChatMessage, OverlaySettings } from '@app-types';
import type { ImageFetchManager } from '@core/image-fetch-manager';
import { createLogger } from '@core/logging';
import type { ObservabilityReporter } from '@core/observability';
import type { Overlay } from '@core/overlay';

type DimensionResult = { width: number; height: number };

interface WorkerManagerDeps {
  settings: OverlaySettings;
  observability: ObservabilityReporter;
  imageFetchManager: ImageFetchManager;
  estimateDimensions: (msg: ChatMessage) => DimensionResult;
  getMessagePriority: (msg: ChatMessage) => number;
  getEffectiveSpeedPxPerSec: () => number;
}

const log = createLogger('[RenderWorkerManager]');

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
    'backgroundQueueMax',
    'maxMessageAgeMs',
    'headwayGapRatio',
    'emojiCacheMb',
    'photoCacheMb',
    'stickerCacheMb',
    'textCacheMb',
    'translationBatchSize',
    'emojiFetchLimit',
    'failedEmojiRetryMins',
    'burstSampleWindow',
    'burstElevatedThreshold',
    'burstHighThreshold',
    'burstExtremeThreshold',
    'backlogInjectionMax',
    'backlogDensityRampMs',
    'livePollFallbackMs',
    'livePollFailureLimit',
    'speedBoostThreshold',
    'backlogPauseThreshold',
    'backlogResumeThreshold',
    'activityTimeoutMs',
    'staggerMaxDelayMs',
    'staggerMediumDelayMs',
    'emojiFetchTimeoutMs',
    'backlogDensityRampMaxMs',
    'backlogInjectionRateMin',
    'speedBoostMax',
    'speedBoostDenom',
    'backlogToggleCooldownMs',
    'replayPrefetchPages',
    'replayBatchLimit',
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
    return config;
  }

  private worker: Worker | null = null;
  private active = false;
  private _queueDepth = 0;
  private readonly deps: WorkerManagerDeps;
  /** Unsubscribe function for overlay dimension changes, stored for cleanup. */
  private dimensionsUnsubscribe: (() => void) | null = null;

  constructor(deps: WorkerManagerDeps) {
    this.deps = deps;
  }

  get isActive(): boolean {
    return this.active;
  }

  get workerRef(): Worker | null {
    return this.worker;
  }

  get queueDepth(): number {
    return this._queueDepth;
  }

  /**
   * Attempt to create and initialize the OffscreenCanvas render worker.
   * Returns true if the worker was successfully started.
   */
  init(canvas: HTMLCanvasElement, settings: OverlaySettings, overlay: Overlay): boolean {
    try {
      if (typeof OffscreenCanvas === 'undefined') {
        log.debug('OffscreenCanvas not available — using main-thread renderer');
        return false;
      }

      const offscreen = canvas.transferControlToOffscreen();
      const config = RenderWorkerManager.buildWorkerConfig(settings);
      const dims = overlay.getDimensions();

      // Vite bundles this as a separate worker chunk
      const workerUrl = new URL('./renderer-worker.ts', import.meta.url);
      const worker = new Worker(workerUrl, { type: 'module' });

      worker.onmessage = (e: MessageEvent) => {
        const data = e.data as { type: string } & Record<string, unknown>;
        switch (data.type) {
          case 'ready':
            log.info('Render worker started');
            break;
          case 'stats':
            this.deps.observability.updateActiveMessages((data.activeMessages as number) ?? 0);
            this._queueDepth = (data.pendingQueueDepth as number) ?? 0;
            break;
          case 'error':
            log.warn('Render worker error:', data.error);
            break;
        }
      };

      worker.onerror = (err) => {
        log.warn('Render worker unhandled error:', err.message);
      };

      worker.postMessage(
        {
          type: 'init',
          canvas: offscreen,
          config,
          width: dims?.width ?? 0,
          height: dims?.height ?? 0,
        },
        [offscreen]
      );

      this.dimensionsUnsubscribe = overlay.onDimensionsChanged((d) => {
        if (d) worker.postMessage({ type: 'resize', width: d.width, height: d.height });
      });

      this.worker = worker;
      this.active = true;

      log.info('Render worker initialized');
      return true;
    } catch (error: unknown) {
      log.debug('Render worker unavailable — using main-thread renderer:', error);
      return false;
    }
  }

  /**
   * Send a message to the render worker for display.
   * Serializes ChatMessage into lightweight cross-thread format.
   */
  sendToWorker(message: ChatMessage): void {
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
          id: message.id ?? `${message.timestamp}-${Math.random()}`,
          text,
          width: dims.width,
          height: dims.height,
          priority: this.deps.getMessagePriority(message),
          isBacklog: message.isBacklog ?? false,
          authorType: message.authorType,
          kind: message.kind,
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
                superChatTier: message.superChat.tier,
                superChatBgColor: message.superChat.backgroundColor,
                superChatStickerUrl: message.superChat.sticker?.url,
              }
            : {}),
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
  syncSettings(settings: OverlaySettings): void {
    if (!this.worker) return;
    this.worker.postMessage({
      type: 'updateConfig',
      config: RenderWorkerManager.buildWorkerConfig(settings),
    });
  }

  /** Destroy the render worker. */
  destroy(): void {
    this.dimensionsUnsubscribe?.();
    this.dimensionsUnsubscribe = null;
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.active = false;
    // Close any remaining pre-converted bitmaps (not yet transferred)
    for (const bitmap of this.deps.imageFetchManager.workerBitmapCache.values()) {
      bitmap.close();
    }
    this.deps.imageFetchManager.workerBitmapCache.clear();
  }

  /**
   * Compute the burst speed multiplier: ratio of effective (burst-adjusted)
   * speed to base speed. Always ≥ 1.0.
   */
  private computeBurstSpeedMultiplier(): number {
    return Math.max(1.0, this.deps.getEffectiveSpeedPxPerSec() / this.deps.settings.speedPxPerSec);
  }
}
