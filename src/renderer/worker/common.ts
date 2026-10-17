// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Shared worker-manager protocol — common Canvas2D worker message-dispatch methods.
 *
 * The manager wraps a Worker reference and delegates settings sync and
 * lifecycle commands to these small helpers.
 */

import type { OverlaySettings } from '@app-types';

import type { WorkerConfig } from './types';

/**
 * Minimal worker manager shape used by the shared dispatch functions.
 */
export interface WorkerManagerLike {
  worker: Worker | null;
}

/**
 * Send updated settings to the worker as an 'updateConfig' command.
 * The config object contains the Canvas2D worker settings selected by the caller.
 */
export function sendUpdateConfigToWorker(
  manager: WorkerManagerLike,
  config: Partial<WorkerConfig>
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
export function sendClearStateToWorker(manager: WorkerManagerLike, epoch?: number): void {
  manager.worker?.postMessage({
    type: 'clearState',
    ...(epoch !== undefined ? { epoch } : {}),
  });
}

/**
 * Build a partial OverlaySettings config for the worker by picking
 * the subset of keys the worker needs. Shared helper used by both
 * the manager's updateSettings() implementation.
 */
export function buildPartialWorkerConfig<K extends keyof OverlaySettings>(
  settings: OverlaySettings,
  keys: readonly K[]
): Pick<OverlaySettings, K> {
  // The loop fills every requested key; Pick preserves each key's value type.
  const config = {} as Pick<OverlaySettings, K>;
  for (const key of keys) {
    config[key] = settings[key];
  }
  return config;
}
