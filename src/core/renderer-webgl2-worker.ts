// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * RendererWebGL2Worker — RendererBase subclass that delegates all rendering
 * to a WebGL2 OffscreenCanvas Web Worker.
 *
 * The worker handles lane allocation, SDF atlas generation, message queue
 * draining, and GPU rendering entirely off the main thread. This wrapper
 * translates RendererBase lifecycle events (pause, resume, destroy) into
 * worker messages and forwards incoming chat messages to the worker.
 */

import type { ChatMessage, OverlaySettings } from '@app-types';
import { createLogger } from '@core/logging';
import type { Overlay } from '@core/overlay';
import { RendererBase } from '@core/renderer-base';
import { RenderWorkerManagerWebGL2 } from '@core/renderer-worker-manager-webgl2';

const log = createLogger('RendererWebGL2Worker');

export class RendererWebGL2Worker extends RendererBase {
  private workerManager: RenderWorkerManagerWebGL2;

  constructor(overlay: Overlay, settings: OverlaySettings) {
    super(overlay, settings);

    const container = overlay.getContainer();
    const canvas = document.createElement('canvas');
    canvas.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none';
    if (container) container.appendChild(canvas);

    this.workerManager = new RenderWorkerManagerWebGL2();

    this.workerManager.onAtlasReady = () => {
      log.info('Worker atlas ready');
    };

    this.workerManager.onError = (err) => {
      log.error('Worker error:', err);
    };

    // Initialize worker with OffscreenCanvas and config.
    // init() is async but we intentionally don't await it — the worker sends
    // messages independently and the render loop starts once it receives 'init'.
    const config = RenderWorkerManagerWebGL2.buildWorkerConfig(settings);
    this.workerManager.init(canvas, config);
  }

  // ── RendererBase abstract overrides ──────────────────────────────────

  /** Worker owns the lane allocator; 0 exposed on the main thread. */
  get laneCount(): number {
    return 0;
  }

  addMessage(message: ChatMessage): void {
    this.workerManager.addMessages([message]);
  }

  protected getQueueLength(): number {
    return 0;
  }

  /** Worker manages its own requestAnimationFrame loop. */
  startRenderLoop(): void {
    // No-op: worker runs its own rAF loop after init.
  }

  // ── Lifecycle hooks ──────────────────────────────────────────────────

  updateSettings(settings: OverlaySettings, options?: { resetState?: boolean }): void {
    super.updateSettings(settings, options);
    this.workerManager.updateConfig(settings);
  }

  protected onPause(): void {
    this.workerManager.setPaused(true, this.isVideoPaused);
  }

  protected onResume(): void {
    this.workerManager.setPaused(false, this.isVideoPaused);
  }

  protected applyPausedDuration(_ms: number): void {
    // Worker handles timing internally via its own performance.now() clock.
  }

  protected resetState(): void {
    // Worker handles state reset internally via destroy + recreate pattern.
  }

  protected onDestroy(): void {
    this.workerManager.destroy();
  }
}
