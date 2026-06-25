// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * RenderWorkerManagerWebGL2 — manages WebGL2 OffscreenCanvas Web Worker lifecycle
 * for off-main-thread WebGL2 rendering.
 *
 * Handles worker init, message sending (with ImageBitmap transfer),
 * settings sync, translation dispatch, and worker destruction.
 *
 * Separated from Canvas2D's RenderWorkerManager for the WebGL2 render path.
 */

import type { ChatMessage, OverlaySettings } from '@app-types';
import { createLogger } from '@core/logging';
import type { WorkerFactory } from '@platform/types';
import { getWorkerFactory } from '@platform/worker-factory';
import {
  buildPartialWorkerConfig,
  sendAuthorPhotosToWorker,
  sendEmojiImagesToWorker,
  sendMessagesToWorker,
  sendResizeToWorker,
  sendSetPausedToWorker,
  sendTranslationToWorker,
  sendUpdateConfigToWorker,
} from './renderer-worker-manager-common';

const log = createLogger('[RenderWorkerManagerWebGL2]');

/** Subset of OverlaySettings needed by the WebGL2 render worker. */
const WORKER_CONFIG_KEYS: (keyof OverlaySettings)[] = [
  'fontSize',
  'fontFamily',
  'fontWeight',
  'opacity',
  'fadeDurationMs',
  'maxMessageAgeMs',
  'danmakuMode',
  'scrollDurationMaxMs',
  'laneSpacing',
  'safeTop',
  'safeBottom',
  'depthLayersEnabled',
  'depthFarOpacityMul',
  'backlogOpacityMultiplier',
  'queueMaxSize',
  'translationMode',
  'translationEnabled',
];

interface WorkerStatsWebGL2 {
  activeMessages: number;
  fps: number;
  drops: number;
  queueDepth: number;
}

type WorkerConfigWebGL2 = Pick<OverlaySettings, (typeof WORKER_CONFIG_KEYS)[number]> & {
  outlineWidthPx: number;
  outlineOpacity: number;
  authorColors: Record<string, string>;
};

export class RenderWorkerManagerWebGL2 {
  private worker: Worker | null = null;
  private _ready = false;
  private config: WorkerConfigWebGL2 | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private restartAttempts = 0;
  private restartTimerId: ReturnType<typeof setTimeout> | null = null;
  private static readonly MAX_RESTART_ATTEMPTS = 3;

  onStats?: (stats: WorkerStatsWebGL2) => void;
  onAtlasReady?: () => void;
  onAtlasError?: (error: string) => void;
  onError?: (error: string) => void;
  onRequestImages?: (urls: string[]) => void;

  get ready(): boolean {
    return this._ready;
  }

  /** Build flat config from OverlaySettings. */
  static buildWorkerConfig(settings: OverlaySettings): WorkerConfigWebGL2 {
    const config = buildPartialWorkerConfig(settings, WORKER_CONFIG_KEYS) as Record<
      string,
      unknown
    >;
    config.outlineWidthPx = settings.outline.widthPx;
    config.outlineOpacity = settings.outline.opacity;
    config.authorColors = { ...settings.colors };
    return config as WorkerConfigWebGL2;
  }

  /**
   * Initialize the worker with an OffscreenCanvas.
   * Transfers canvas control to the worker.
   */
  async init(
    canvas: HTMLCanvasElement,
    config: WorkerConfigWebGL2,
    workerFactory?: WorkerFactory
  ): Promise<void> {
    // Guard: terminate any existing worker to prevent double-init
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    // Store references for potential restart
    this.canvas = canvas;
    this.config = config;

    const offscreen = canvas.transferControlToOffscreen();
    // Resolve worker URL via platform-specific factory
    const factory = workerFactory ?? getWorkerFactory();
    const workerUrl = factory.createWorkerUrl('./renderer-worker-webgl2.ts');
    this.worker = new Worker(workerUrl, { type: 'module' });

    this.worker.onmessage = (e: MessageEvent) => {
      // Runtime validation: ensure incoming data is an object with a string `type` field.
      if (!e.data || typeof e.data !== 'object' || typeof e.data.type !== 'string') {
        log.warn('Invalid worker message received — missing or invalid type field:', e.data);
        return;
      }
      const { type, ...payload } = e.data;
      switch (type) {
        case 'ready':
          this._ready = true;
          break;
        case 'stats': {
          const stats = payload as WorkerStatsWebGL2;
          if (
            typeof stats.activeMessages !== 'number' ||
            typeof stats.fps !== 'number' ||
            typeof stats.drops !== 'number' ||
            typeof stats.queueDepth !== 'number'
          ) {
            log.warn('Invalid stats payload from worker:', stats);
            break;
          }
          this.onStats?.(stats);
          break;
        }
        case 'atlasReady':
          this.onAtlasReady?.();
          break;
        case 'atlasError': {
          const errorPayload = payload as { error: string };
          if (typeof errorPayload.error !== 'string') {
            log.warn('Invalid atlasError payload from worker:', errorPayload);
            break;
          }
          this.onAtlasError?.(errorPayload.error);
          break;
        }
        case 'requestImages': {
          const imagesPayload = payload as { urls: string[] };
          if (
            !Array.isArray(imagesPayload.urls) ||
            !imagesPayload.urls.every((u) => typeof u === 'string')
          ) {
            log.warn('Invalid requestImages payload from worker:', imagesPayload);
            break;
          }
          this.onRequestImages?.(imagesPayload.urls);
          break;
        }
        case 'error': {
          const msgPayload = payload as { message: string };
          if (typeof msgPayload.message !== 'string') {
            log.warn('Invalid error payload from worker:', msgPayload);
            break;
          }
          this.onError?.(msgPayload.message);
          break;
        }
        default:
          log.debug('Unknown worker message:', type);
      }
    };

    this.worker.onerror = (ev: ErrorEvent) => {
      log.warn('Worker error:', ev.message);
      this.onError?.(ev.message);

      // Attempt automatic restart with exponential backoff
      if (this.restartAttempts < RenderWorkerManagerWebGL2.MAX_RESTART_ATTEMPTS) {
        this.restartAttempts++;
        const delayMs = 1000 * 2 ** (this.restartAttempts - 1); // 1s, 2s, 4s
        log.info(
          `Worker restart attempt ${this.restartAttempts}/${RenderWorkerManagerWebGL2.MAX_RESTART_ATTEMPTS} in ${delayMs}ms`
        );
        this.restartTimerId = setTimeout(() => {
          this.restartTimerId = null;
          this.restart();
        }, delayMs);
      } else {
        log.warn(
          `Worker failed after ${RenderWorkerManagerWebGL2.MAX_RESTART_ATTEMPTS} restart attempts. Giving up.`
        );
      }
    };

    this.worker.postMessage({ type: 'init', canvas: offscreen, config }, [offscreen]);
  }

  /**
   * Restart the worker after a crash. Creates a new canvas element
   * (the old one had its control transferred), replaces it in the DOM,
   * terminates the old worker, and re-initializes.
   * Returns false if no saved config/canvas reference exists.
   */
  restart(): boolean {
    if (!this.canvas || !this.config) return false;

    // Reset retry counter so manual restart always gets a fresh attempt
    this.restartAttempts = 0;

    // Create a new canvas element since control of old one was transferred
    const newCanvas = document.createElement('canvas');
    newCanvas.style.cssText = this.canvas.style.cssText;
    if (this.canvas.parentNode) {
      this.canvas.parentNode.replaceChild(newCanvas, this.canvas);
    }
    this.canvas = newCanvas;

    // Terminate old worker
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this._ready = false;

    // Re-init
    this.init(newCanvas, this.config);
    return true;
  }

  addMessages(messages: ChatMessage[]): void {
    sendMessagesToWorker({ worker: this.worker }, messages);
  }

  updateSettings(settings: OverlaySettings): void {
    const config = buildPartialWorkerConfig(settings, WORKER_CONFIG_KEYS);
    config.outlineWidthPx = settings.outline.widthPx;
    config.outlineOpacity = settings.outline.opacity;
    config.authorColors = { ...settings.colors };
    sendUpdateConfigToWorker({ worker: this.worker }, config);
  }

  resize(width: number, height: number): void {
    sendResizeToWorker({ worker: this.worker }, width, height);
  }

  setPaused(paused: boolean, videoPaused?: boolean): void {
    sendSetPausedToWorker({ worker: this.worker }, paused, videoPaused);
  }

  addEmojiImages(images: Array<{ url: string; bitmap: ImageBitmap }>): void {
    sendEmojiImagesToWorker({ worker: this.worker }, images);
  }

  addAuthorPhotos(photos: Array<{ url: string; bitmap: ImageBitmap }>): void {
    sendAuthorPhotosToWorker({ worker: this.worker }, photos);
  }

  setTranslation(messageId: string, text: string): void {
    sendTranslationToWorker({ worker: this.worker }, messageId, text);
  }

  destroy(): void {
    if (this.restartTimerId !== null) {
      clearTimeout(this.restartTimerId);
      this.restartTimerId = null;
    }
    this.worker?.postMessage({ type: 'destroy' });
    this.worker?.terminate();
    this.worker = null;
    this._ready = false;
    delete this.onStats;
    delete this.onAtlasReady;
    delete this.onAtlasError;
    delete this.onError;
    delete this.onRequestImages;
  }
}
