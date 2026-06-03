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
  'headwayGapRatio',
  'exitPaddingPx',
  'speedPxPerSec',
  'backlogSpeedMultiplier',
  'depthLayersEnabled',
  'depthFarOpacityMul',
  'backlogOpacityMultiplier',
  'queueMaxSize',
  'backgroundQueueMax',
  'showAuthor',
  'superChatOpacity',
  'translationMode',
];

export interface WorkerStatsWebGL2 {
  activeMessages: number;
  fps: number;
  drops: number;
  queueDepth: number;
}

export type WorkerConfigWebGL2 = Pick<OverlaySettings, (typeof WORKER_CONFIG_KEYS)[number]> & {
  outlineWidthPx: number;
  outlineOpacity: number;
  authorColors: Record<string, string>;
};

export class RenderWorkerManagerWebGL2 {
  private worker: Worker | null = null;
  private _ready = false;

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
  async init(canvas: HTMLCanvasElement, config: WorkerConfigWebGL2): Promise<void> {
    const offscreen = canvas.transferControlToOffscreen();
    // Create worker from the bundled worker file
    // Note: The build system produces the worker bundle; path resolution depends on bundler config.
    // For development, we use a blob URL or the vite-bundled path.
    const workerUrl = new URL('./renderer-worker-webgl2.ts', import.meta.url);
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
      log.error('Worker error:', ev.message);
      this.onError?.(ev.message);
    };

    this.worker.postMessage({ type: 'init', canvas: offscreen, config }, [offscreen]);
  }

  addMessages(messages: ChatMessage[]): void {
    this.worker?.postMessage({ type: 'addMessages', messages });
  }

  updateConfig(settings: OverlaySettings): void {
    const config = RenderWorkerManagerWebGL2.buildWorkerConfig(settings);
    this.worker?.postMessage({ type: 'updateConfig', config });
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
