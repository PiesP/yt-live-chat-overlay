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
    const config = {} as Record<string, unknown>;
    for (const key of WORKER_CONFIG_KEYS) {
      config[key] = settings[key];
    }
    return {
      ...config,
      outlineWidthPx: settings.outline.widthPx,
      outlineOpacity: settings.outline.opacity,
      authorColors: { ...settings.colors },
    } as unknown as WorkerConfigWebGL2;
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
      const { type, ...payload } = e.data;
      switch (type) {
        case 'ready':
          this._ready = true;
          break;
        case 'stats':
          this.onStats?.(payload as WorkerStatsWebGL2);
          break;
        case 'atlasReady':
          this.onAtlasReady?.();
          break;
        case 'atlasError':
          this.onAtlasError?.((payload as { error: string }).error);
          break;
        case 'requestImages':
          this.onRequestImages?.((payload as { urls: string[] }).urls);
          break;
        case 'error':
          this.onError?.((payload as { message: string }).message);
          break;
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
        setTimeout(() => {
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
    this.worker?.postMessage({ type: 'addMessages', messages });
  }

  updateConfig(settings: OverlaySettings): void {
    const config = RenderWorkerManagerWebGL2.buildWorkerConfig(settings);
    this.worker?.postMessage({ type: 'updateConfig', config });
  }

  resize(width: number, height: number): void {
    this.worker?.postMessage({ type: 'resize', width, height });
  }

  setPaused(paused: boolean, videoPaused?: boolean): void {
    this.worker?.postMessage({ type: 'setPaused', paused, videoPaused });
  }

  addEmojiImages(images: Array<{ url: string; bitmap: ImageBitmap }>): void {
    const bitmaps = images.map((i) => i.bitmap);
    this.worker?.postMessage({ type: 'addEmojiImages', images }, bitmaps);
  }

  addAuthorPhotos(photos: Array<{ url: string; bitmap: ImageBitmap }>): void {
    const bitmaps = photos.map((p) => p.bitmap);
    this.worker?.postMessage({ type: 'addAuthorPhotos', photos }, bitmaps);
  }

  setTranslation(messageId: string, text: string): void {
    this.worker?.postMessage({ type: 'setTranslation', messageId, text });
  }

  destroy(): void {
    this.worker?.postMessage({ type: 'destroy' });
    this.worker?.terminate();
    this.worker = null;
    this._ready = false;
  }
}
