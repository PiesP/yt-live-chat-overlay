// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const PLAYBACK_WORKER_URL =
  'https://www.youtube.com/__yt-chat-overlay-e2e__/renderer-worker.js';

export interface PlaybackWorkerStats {
  activeMessages: number;
  pendingQueueDepth: number;
  activeMessageIds: string[];
  pendingMessageIds: string[];
}

export interface PlaybackWorkerTelemetry {
  constructed: number;
  ready: number;
  acknowledgements: number;
  terminated: number;
  initTransferredOffscreenCanvas: boolean;
  sentTypes: string[];
  pausedStates: boolean[];
  addedMessageIds: string[][];
  stats: PlaybackWorkerStats[];
}

/**
 * Route the exact built extension Worker bundle from the current checkout
 * through the mock YouTube origin. This lets Chromium execute a real module
 * Worker while keeping production URL selection untouched.
 */
export async function routePlaybackWorker(page: Page): Promise<void> {
  const workerPath = resolve(process.cwd(), 'dist-extension/workers/renderer.js');
  const workerSource = readFileSync(workerPath, 'utf8');
  await page.route(PLAYBACK_WORKER_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: workerSource,
    });
  });
}

/**
 * Install a transparent observer around native Worker construction. The
 * returned object is still the browser-created Worker; instrumentation only
 * records protocol traffic and lifecycle completion.
 */
export function installPlaybackWorkerObserver(workerUrl: string): void {
  const telemetry: PlaybackWorkerTelemetry = {
    constructed: 0,
    ready: 0,
    acknowledgements: 0,
    terminated: 0,
    initTransferredOffscreenCanvas: false,
    sentTypes: [],
    pausedStates: [],
    addedMessageIds: [],
    stats: [],
  };
  const NativeWorker = window.Worker;

  const InstrumentedWorker = function (
    this: Worker,
    scriptURL: string | URL,
    options?: WorkerOptions,
  ): Worker {
    const worker = new NativeWorker(scriptURL, options);
    telemetry.constructed++;

    worker.addEventListener('message', (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (data === null || typeof data !== 'object' || !('type' in data)) return;
      const record = data as Record<string, unknown>;
      if (record.type === 'ready') {
        telemetry.ready++;
      } else if (record.type === 'ack') {
        telemetry.acknowledgements++;
      } else if (record.type === 'stats') {
        telemetry.stats.push({
          activeMessages:
            typeof record.activeMessages === 'number' ? record.activeMessages : -1,
          pendingQueueDepth:
            typeof record.pendingQueueDepth === 'number' ? record.pendingQueueDepth : -1,
          activeMessageIds: Array.isArray(record.activeMessageIds)
            ? record.activeMessageIds.filter((id): id is string => typeof id === 'string')
            : [],
          pendingMessageIds: Array.isArray(record.pendingMessageIds)
            ? record.pendingMessageIds.filter((id): id is string => typeof id === 'string')
            : [],
        });
      }
    });

    const nativePostMessage = worker.postMessage.bind(worker);
    worker.postMessage = ((message: unknown, transfer?: Transferable[]): void => {
      if (message !== null && typeof message === 'object' && 'type' in message) {
        const record = message as Record<string, unknown>;
        if (typeof record.type === 'string') telemetry.sentTypes.push(record.type);
        if (record.type === 'init') {
          const canvas = record.canvas;
          telemetry.initTransferredOffscreenCanvas =
            typeof OffscreenCanvas !== 'undefined' &&
            canvas instanceof OffscreenCanvas &&
            Array.isArray(transfer) &&
            transfer.includes(canvas);
        } else if (record.type === 'setPaused' && typeof record.paused === 'boolean') {
          telemetry.pausedStates.push(record.paused);
        } else if (record.type === 'addMessages' && Array.isArray(record.messages)) {
          telemetry.addedMessageIds.push(
            record.messages
              .map((entry) =>
                entry !== null && typeof entry === 'object' && 'id' in entry
                  ? (entry as Record<string, unknown>).id
                  : undefined,
              )
              .filter((id): id is string => typeof id === 'string'),
          );
        }
      }
      if (transfer === undefined) {
        nativePostMessage(message);
      } else {
        nativePostMessage(message, transfer);
      }
    }) as Worker['postMessage'];

    const nativeTerminate = worker.terminate.bind(worker);
    worker.terminate = (): void => {
      telemetry.terminated++;
      nativeTerminate();
    };
    return worker;
  } as unknown as typeof Worker;

  InstrumentedWorker.prototype = NativeWorker.prototype;
  Object.setPrototypeOf(InstrumentedWorker, NativeWorker);
  window.Worker = InstrumentedWorker;

  const global = window as unknown as Record<string, unknown>;
  global.__playbackWorkerTelemetry = telemetry;
  global.__ytExtensionBridge = {
    workerSupported: true,
    workerUrl,
  };
}
