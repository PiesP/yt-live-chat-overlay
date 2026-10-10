// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Portable Windows acceptance runtime is intentionally plain ESM.
import { findOverlappingActivePair, PLACEMENT_SCENARIOS, runPlacementTimingFixture, summarizeSamples, workerProbePrelude, workerProbeSuffix } from '../../../validation/windows/placement-timing.mjs';

describe('Windows placement timing probe', () => {
  it('covers fixed, reduced-motion, safe-zone, congestion and translation states with unique receipts', () => {
    const names = PLACEMENT_SCENARIOS.map((scenario: { name: string }) => scenario.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([
      'worker-top', 'worker-bottom', 'worker-reduced-toggle', 'worker-safe-density',
      'worker-congestion', 'worker-translation', 'worker-replay',
    ]));
  });

  it('detects visible active rectangles that overlap after reflow', () => {
    const a = { id: 'a', x: 10, y: 10, width: 50, height: 20 };
    const b = { id: 'b', x: 30, y: 20, width: 50, height: 20 };
    expect(findOverlappingActivePair([a, b], 100, 100)).toEqual(['a', 'b']);
    expect(findOverlappingActivePair([a, { ...b, y: 31 }], 100, 100)).toBeNull();
    expect(findOverlappingActivePair([{ ...a, x: 101 }, b], 100, 100)).toBeNull();
  });

  it('retains bounded timing and geometry when a scenario fails before its final assertion', async () => {
    const raw = { sourcePrefixed: true, sourceHooked: true, requestAtEpochMs: 1000,
      frames: [], bounds: [], firstEntry: {}, ingress: {}, overflow: 0,
      workers: [{ ready: true, stats: [], sample: {
        frames: [{ workMs: 4, preClearMs: 2 }], bounds: [{ id: 'WINDOWS193_SHORT',
          left: 10, top: 10, right: 20, bottom: 20 }], firstEntry: { WINDOWS193_SHORT: 1010 },
        ingress: { WINDOWS193_SHORT: 1000 }, overflow: 0,
        exact: { frames: [{ workMs: 3 }], drains: [{ workMs: 1 }],
          dispositions: [], active: [], activeNow: [], config: {}, overflow: 0 },
      } }],
    };
    const page = { setViewportSize: async () => {}, emulateMedia: async () => {},
      route: async () => { throw new Error('Synthetic fixture setup failure'); },
      screenshot: async () => {}, isClosed: () => false, close: async () => {},
      evaluate: async (fn: () => unknown) => fn.toString().includes('const probe = window.__ytPlacementProbe')
        ? raw : undefined,
      waitForTimeout: async () => {},
    };
    const result = await runPlacementTimingFixture({
      context: { newPage: async () => page }, root: process.cwd(), output: '/tmp', extensionId: 'fixture',
    });
    expect(result.status).toBe('failed');
    expect(result.scenarios[0]).toMatchObject({ status: 'failed', errorType: 'Error',
      frameWorkMs: { count: 1, p95: 4 }, exactWorkerDrainMs: { count: 1, p95: 1 },
      bounds: [{ id: 'WINDOWS193_SHORT' }], screenshot: 'placement-worker-scroll.png' });
  });

  it('summarizes bounded, nonnegative frame samples without treating invalid values as work', () => {
    expect(summarizeSamples([])).toEqual({ count: 0, p50: null, p95: null, max: null });
    expect(summarizeSamples([10, 1, Infinity, -1, 3, 2, 4])).toEqual({
      count: 5, p50: 3, p95: 10, max: 10,
    });
  });

  it.each([1, 2])('associates a cached bitmap with viewport bounds at scale %s', (scale) => {
    const listeners: Record<string, (event: { data: unknown }) => void> = {};
    const messages: Array<{ type: string; sample?: { firstEntry: Record<string, number>; bounds: unknown[] } }> = [];
    const overlay = { width: 640 * scale, height: 360 * scale };
    const bitmap = { width: 100, height: 24 };
    let now = 5;
    class FakeContext {
      canvas: typeof overlay;
      globalAlpha = 1;

      constructor(canvas: typeof overlay) { this.canvas = canvas; }
      fillText(_text: string, _x: number, _y: number) {}
      drawImage(_image: object, _x: number, _y: number, _width: number, _height: number) {}
      clearRect(_x: number, _y: number, _width: number, _height: number) {}
      measureText() { return { width: 100, actualBoundingBoxAscent: 20, actualBoundingBoxDescent: 4 }; }
      getTransform() { return { a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 }; }
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
      display.globalAlpha = 0;
      display.drawImage(bitmap, 500, 20, 100, 24);
      display.globalAlpha = 1;
      display.drawImage(bitmap, 500, 20, 100, 24);
    });
    listeners.message?.({ data: { type: 'ytPlacementFlush' } });

    const sample = messages.at(-1)?.sample;
    expect(sample?.firstEntry.WINDOWS193_SHORT).toBeGreaterThan(1000);
    expect(sample?.bounds).toHaveLength(1);
    expect(sample?.bounds[0]).toMatchObject({
      id: 'WINDOWS193_SHORT', left: 500 * scale, top: 20 * scale,
      right: 600 * scale, bottom: 44 * scale,
    });
  });

  it('hooks the emitted Worker instance and records exact drain and queue residence', () => {
    const source = `var sample = {
      pendingQueue: [], activeMessages: [], numLanes: 10, laneHeight: 20,
      enqueueMessage(message) { this.pendingQueue.push(message); return true; },
      activateMessage(message) { this.activeMessages.push({ ...message, x: 10, y: 5,
        startX: 10, duration: 100, laneIndex: 1 }); },
      recordDrop(message, reason) { this.lastDrop = [message.id, reason]; }, checkCollision() { return true; },
      findPlacement() { return { laneIndex: 1 }; },
      drainQueue() { const message = this.pendingQueue.shift(); if (message) this.activateMessage(message); },
      renderFrame() { this.drainQueue(); }, handleMessage() {},
    }; self.onmessage=e=>{sample.handleMessage(e)};`;
    expect(workerProbeSuffix(`${source}\n//# sourceMappingURL=renderer.js.map`)).toBeNull();
    const suffix = workerProbeSuffix(source);
    expect(suffix).toContain('(sample)');
    const listeners: Record<string, (event: { data: unknown }) => void> = {};
    const messages: Array<{ sample?: { exact?: {
      drops: Record<string, number>;
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
        drops: Record<string, number>;
      drains: unknown[]; frames: unknown[]; dispositions: Array<{ queueResidenceMs: number }>;
      } } }) => { messages.push(message); },
    };
    runInNewContext(`self = globalThis; ${workerProbePrelude(['WINDOWS193_SHORT'])}${source}${suffix}`,
      sandbox);
    runInNewContext(`sample.enqueueMessage({ id: 'WINDOWS193_SHORT' }); sample.renderFrame();
      sample.recordDrop({ id: 'WINDOWS193_DROP' }, 'reflow_capacity');
      sample.recordDrop({ id: 'WINDOWS193_UNTRACKED', trackDrops: false }, 'oversized');`, sandbox);
    listeners.message?.({ data: { type: 'ytPlacementFlush' } });
    const exact = messages.at(-1)?.sample?.exact;
    expect(exact?.drains).toHaveLength(1);
    expect(exact?.frames).toHaveLength(1);
    expect(exact?.dispositions[0]).toMatchObject({
      kind: 'activated', id: 'WINDOWS193_SHORT', queueResidenceMs: expect.any(Number),
    });
    expect(exact?.drops).toEqual({ reflow_capacity: 1 });
    expect(runInNewContext('sample.lastDrop', sandbox)).toEqual(['WINDOWS193_UNTRACKED', 'oversized']);
  });
});
