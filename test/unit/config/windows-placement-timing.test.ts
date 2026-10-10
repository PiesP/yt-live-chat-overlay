// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Portable Windows acceptance runtime is intentionally plain ESM.
import { summarizeSamples, workerProbePrelude, workerProbeSuffix } from '../../../validation/windows/placement-timing.mjs';

describe('Windows placement timing probe', () => {
  it('summarizes bounded, nonnegative frame samples without treating invalid values as work', () => {
    expect(summarizeSamples([])).toEqual({ count: 0, p50: null, p95: null, max: null });
    expect(summarizeSamples([10, 1, Infinity, -1, 3, 2, 4])).toEqual({
      count: 5, p50: 3, p95: 10, max: 10,
    });
  });

  it('associates a cached fixture bitmap with actual Worker canvas draw bounds', () => {
    const listeners: Record<string, (event: { data: unknown }) => void> = {};
    const messages: Array<{ type: string; sample?: { firstEntry: Record<string, number>; bounds: unknown[] } }> = [];
    const overlay = { width: 640, height: 360 };
    const bitmap = { width: 100, height: 24 };
    let now = 5;
    class FakeContext {
      canvas: typeof overlay;

      constructor(canvas: typeof overlay) { this.canvas = canvas; }
      fillText(_text: string, _x: number, _y: number) {}
      drawImage(_image: object, _x: number, _y: number, _width: number, _height: number) {}
      clearRect(_x: number, _y: number, _width: number, _height: number) {}
      measureText() { return { width: 100, actualBoundingBoxAscent: 20, actualBoundingBoxDescent: 4 }; }
      getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
    }
    const sandbox = {
      OffscreenCanvasRenderingContext2D: FakeContext,
      performance: { timeOrigin: 1000, now: () => now++ },
      requestAnimationFrame: (callback: (time: number) => void) => callback(0),
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
        listeners[type] = listener;
      },
      postMessage: (message: { type: string; sample?: { firstEntry: Record<string, number>; bounds: unknown[] } }) => {
        messages.push(message);
      },
    };
    runInNewContext(workerProbePrelude(['WINDOWS193_SHORT']), sandbox);
    listeners.message?.({ data: { type: 'init', canvas: overlay } });
    listeners.message?.({ data: { type: 'addMessages', messages: [{ id: 'WINDOWS193_SHORT' }] } });
    sandbox.requestAnimationFrame(() => {
      const cache = new FakeContext(bitmap);
      cache.fillText('WINDOWS193_SHORT', 0, 0);
      const display = new FakeContext(overlay);
      display.clearRect(0, 0, 640, 360);
      display.drawImage(bitmap, 12, 20, 100, 24);
    });
    listeners.message?.({ data: { type: 'ytPlacementFlush' } });

    const sample = messages.at(-1)?.sample;
    expect(sample?.firstEntry.WINDOWS193_SHORT).toBeGreaterThan(1000);
    expect(sample?.bounds).toHaveLength(1);
    expect(sample?.bounds[0]).toMatchObject({
      id: 'WINDOWS193_SHORT', left: 12, top: 20, right: 112, bottom: 44,
    });
  });

  it('hooks the emitted Worker instance and records exact drain and queue residence', () => {
    const source = `var sample = {
      pendingQueue: [], activeMessages: [], numLanes: 10, laneHeight: 20,
      enqueueMessage(message) { this.pendingQueue.push(message); return true; },
      activateMessage(message) { this.activeMessages.push({ ...message, x: 10, y: 5,
        startX: 10, duration: 100, laneIndex: 1 }); },
      recordDrop() {}, checkCollision() { return true; },
      findPlacement() { return { laneIndex: 1 }; },
      drainQueue() { const message = this.pendingQueue.shift(); if (message) this.activateMessage(message); },
      renderFrame() { this.drainQueue(); }, handleMessage() {},
    }; self.onmessage=e=>{sample.handleMessage(e)};`;
    expect(workerProbeSuffix(`${source}\n//# sourceMappingURL=renderer.js.map`)).toBeNull();
    const suffix = workerProbeSuffix(source);
    expect(suffix).toContain('(sample)');
    const listeners: Record<string, (event: { data: unknown }) => void> = {};
    const messages: Array<{ sample?: { exact?: {
      drains: unknown[]; frames: unknown[]; dispositions: Array<{ queueResidenceMs: number }>;
    } } }> = [];
    let now = 1;
    const sandbox = {
      performance: { timeOrigin: 1000, now: () => now++ },
      requestAnimationFrame: (_callback: (time: number) => void) => 1,
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
        listeners[type] = listener;
      },
      postMessage: (message: { sample?: { exact?: {
        drains: unknown[]; frames: unknown[]; dispositions: Array<{ queueResidenceMs: number }>;
      } } }) => { messages.push(message); },
    };
    runInNewContext(`self = globalThis; ${workerProbePrelude(['WINDOWS193_SHORT'])}${source}${suffix}`,
      sandbox);
    runInNewContext(`sample.enqueueMessage({ id: 'WINDOWS193_SHORT' }); sample.renderFrame();`, sandbox);
    listeners.message?.({ data: { type: 'ytPlacementFlush' } });
    const exact = messages.at(-1)?.sample?.exact;
    expect(exact?.drains).toHaveLength(1);
    expect(exact?.frames).toHaveLength(1);
    expect(exact?.dispositions).toMatchObject([
      { kind: 'activated', id: 'WINDOWS193_SHORT', queueResidenceMs: expect.any(Number) },
    ]);
  });
});
