// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Shared contract for render worker managers.
 *
 * Both RenderWorkerManager (Canvas2D) and RenderWorkerManagerWebGL2
 * implement this interface, providing a common shape for the renderer
 * wrapper classes to reference without coupling to a specific backend.
 *
 * The interface uses optional methods to accommodate API divergence
 * between the two implementations (e.g., sendToWorker vs addMessages).
 * Full unification with renamed methods would require call-site updates
 * across both renderer paths and is deferred to a focused session.
 */

import type { ChatMessage, OverlaySettings } from '@app-types';

export interface RenderWorkerManagerLike {
  /** Initialize the worker with canvas, settings, and platform factory. */
  init(canvas: HTMLCanvasElement | OffscreenCanvas, ...args: unknown[]): boolean | Promise<void>;

  /** Tear down the worker and release resources. */
  destroy(): void;
}

/**
 * Canvas2D-specific interface extension.
 * RenderWorkerManager uses sendToWorker / syncSettings naming.
 */
export interface Canvas2DWorkerManager extends RenderWorkerManagerLike {
  sendToWorker(message: ChatMessage, msgId?: string): void;
  syncSettings(settings: OverlaySettings): void;
  setTranslation(msgId: string, translatedText: string | null): void;
  get queueDepth(): number;
}

/**
 * WebGL2-specific interface extension.
 * RenderWorkerManagerWebGL2 uses addMessages / updateConfig naming.
 */
export interface WebGL2WorkerManager extends RenderWorkerManagerLike {
  addMessages(messages: ChatMessage[]): void;
  updateConfig(settings: OverlaySettings): void;
  setTranslation(msgId: string, translatedText: string | null): void;
  resize(width: number, height: number): void;
  setPaused(paused: boolean, videoPaused?: boolean): void;
  get ready(): boolean;
}
