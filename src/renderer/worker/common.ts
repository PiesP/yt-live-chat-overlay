// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Shared worker-manager protocol — common message-dispatch methods shared by
 * RenderWorkerManager (Canvas2D) and RenderWorkerManagerWebGL2.
 *
 * Both managers wrap a Worker reference and expose an identical public API
 * for message ingress, settings sync, and lifecycle control. This module
 * defines the protocol as a set of free functions so both managers can
 * delegate to shared logic without inheritance coupling.
 */

import type { OverlaySettings } from '@app-types';

/**
 * Minimal worker manager shape that both RenderWorkerManager and
 * RenderWorkerManagerWebGL2 satisfy. Used as the parameter type for
 * shared dispatch functions.
 */
export interface WorkerManagerLike {
  worker: Worker | null;
}

/**
 * Send updated settings to the worker as an 'updateConfig' command.
 * The config object is manager-specific (different keys for Canvas2D vs WebGL2).
 */
export function sendUpdateConfigToWorker(
  manager: WorkerManagerLike,
  config: Record<string, unknown>
): void {
  manager.worker?.postMessage({ type: 'updateConfig', config });
}

/**
 * Send a setPaused command to the worker.
 */
export function sendSetPausedToWorker(
  manager: WorkerManagerLike,
  paused: boolean,
  videoPaused?: boolean
): void {
  manager.worker?.postMessage({ type: 'setPaused', paused, videoPaused });
}

/**
 * Send a clearState command to the worker.
 * Instructs the Worker to reset its renderer state (active messages,
 * pending queue, lane allocator) while preserving caches.
 */
export function sendClearStateToWorker(manager: WorkerManagerLike): void {
  manager.worker?.postMessage({ type: 'clearState' });
}

/**
 * Build a partial OverlaySettings config for the worker by picking
 * the subset of keys the worker needs. Shared helper used by both
 * managers' updateSettings() implementations.
 */
export function buildPartialWorkerConfig(
  settings: OverlaySettings,
  keys: (keyof OverlaySettings)[]
): Record<string, unknown> {
  const config = {} as Record<string, unknown>;
  for (const key of keys) {
    config[key] = settings[key];
  }
  return config;
}
