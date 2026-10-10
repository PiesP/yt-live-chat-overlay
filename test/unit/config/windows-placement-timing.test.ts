// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Portable Windows acceptance runtime is intentionally plain ESM.
import { assertBacklogMotion, assertBacklogReflow, canvasProbePrelude, findOverlappingActivePair, instrumentCanvasPageScript, measureAllocationRowPitch, measureVisibleRowPitch, PLACEMENT_SCENARIOS, runPlacementTimingFixture, spacingFixtureIds, summarizeExactWorkerProbe, summarizeSamples, workerProbePrelude, workerProbeSuffix } from '../../../validation/windows/placement-timing.mjs';

describe('Windows placement timing probe', () => {
  it('covers fixed, reduced-motion, safe-zone, congestion and translation states with unique receipts', () => {
    const names = PLACEMENT_SCENARIOS.map((scenario: { name: string }) => scenario.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([
      'worker-top', 'worker-bottom', 'worker-reduced-toggle', 'worker-safe-density',
      'worker-congestion', 'worker-translation', 'worker-replay',
      'worker-spacing-speed', 'main-spacing-speed',
    ]));
  });

  it('routes distinct Japanese message IDs to the zero-gap and eight-gap batches', () => {
    const { gap0, gap8 } = spacingFixtureIds();
    expect(gap0).toHaveLength(12);
    expect(gap8).toHaveLength(12);
    expect(gap0.every((id: string) => id.startsWith('WINDOWS196_GAP0_'))).toBe(true);
    expect(gap8.every((id: string) => id.startsWith('WINDOWS196_GAP8_'))).toBe(true);
    expect(new Set([...gap0, ...gap8]).size).toBe(24);
  });

  it('labels active-origin spacing as allocation pitch', () => {
    const messages = [
      { id: 'WINDOWS196_GAP0_A', y: 13, height: 32 },
      { id: 'WINDOWS196_GAP0_B', y: 51, height: 32 },
      { id: 'WINDOWS196_GAP0_00', y: 89, height: 32 },
      { id: 'unrelated', y: 14, height: 32 },
    ];
    expect(measureAllocationRowPitch(messages)).toBe(38);
    expect(measureAllocationRowPitch(messages.slice(0, 1))).toBeNull();
  });

  it.each(['main', 'worker'])('measures only two painted, eligible row origins in one %s frame', (renderer) => {
    const row = (id: string, x: number, y: number) => ({ id, x, y, width: 100,
      height: 32, startAtEpochMs: 900, endAtEpochMs: 1100 });
    const draw = (id: string, top: number, alpha = 1, frameId = 7) => ({ id, frameId, alpha,
      rect: { left: 10, top, right: 110, bottom: top + 32 },
      japanese: { text: '東京', rect: { left: 10, top, right: 50, bottom: top + 32 } } });
    const frame = { frameId: 7, complete: true, truncated: false,
      startedAtEpochMs: 1000, finishedAtEpochMs: 1001,
      logicalWidth: 800, logicalHeight: 400, backingRatioX: 2, backingRatioY: 2,
      config: { renderer, fontSize: 32, laneSpacing: 0 },
      active: [row('WINDOWS196_GAP0_A', 10, 0), row('WINDOWS196_GAP0_B', 10, 88),
        row('WINDOWS196_GAP0_C', 810, 44)],
      draws: [draw('WINDOWS196_GAP0_A', 0), draw('WINDOWS196_GAP0_B', 88),
        draw('WINDOWS196_GAP0_C', 44)] };
    expect(measureVisibleRowPitch(frame)).toMatchObject({ status: 'measured', pitchPx: 88,
      includedIds: ['WINDOWS196_GAP0_A', 'WINDOWS196_GAP0_B'],
      excluded: [{ id: 'WINDOWS196_GAP0_C', reason: 'offscreen_row' }],
      japaneseVisibleIds: ['WINDOWS196_GAP0_A', 'WINDOWS196_GAP0_B'],
      japaneseVisibleRowOriginsPx: [0, 88] });
    const sameJapaneseRow = measureVisibleRowPitch({ ...frame,
      active: [row('WINDOWS196_GAP0_A', 10, 0), row('WINDOWS196_GAP0_B', 10, 0),
        row('WINDOWS196_GAP0_C', 10, 88)],
      draws: [draw('WINDOWS196_GAP0_A', 0), draw('WINDOWS196_GAP0_B', 0),
        { ...draw('WINDOWS196_GAP0_C', 88), japanese: null }] });
    expect(sameJapaneseRow).toMatchObject({ status: 'measured', pitchPx: 88,
      japaneseVisibleIds: ['WINDOWS196_GAP0_A', 'WINDOWS196_GAP0_B'],
      japaneseVisibleRowOriginsPx: [0] });
    expect(sameJapaneseRow.japaneseVisibleRowOriginsPx).toHaveLength(1);
    expect(measureVisibleRowPitch({ ...frame, active: frame.active.slice(0, 1),
      draws: frame.draws.slice(0, 1) }))
      .toMatchObject({ status: 'insufficient', pitchPx: null });
    expect(measureVisibleRowPitch({ ...frame,
      active: [row('WINDOWS196_GAP0_A', 10, 0), row('WINDOWS196_GAP0_B', 10, 0)],
      draws: [draw('WINDOWS196_GAP0_A', 0), draw('WINDOWS196_GAP0_B', 0)] }))
      .toMatchObject({ status: 'insufficient', pitchPx: null });
    expect(measureVisibleRowPitch({ ...frame, active: frame.active.map((entry) => ({
      ...entry, x: 900,
    })) })).toMatchObject({ status: 'insufficient', pitchPx: null });
    expect(measureVisibleRowPitch({ ...frame, draws: [draw('WINDOWS196_GAP0_A', 0),
      draw('WINDOWS196_GAP0_B', 10)] })).toMatchObject({ status: 'unknown', pitchPx: null,
      reason: 'draw_row_mismatch' });
    expect(measureVisibleRowPitch({ ...frame, draws: [...frame.draws,
      draw('WINDOWS196_GAP0_MISSING', 132)] })).toMatchObject({ status: 'unknown',
      pitchPx: null, reason: 'draw_without_active_row' });
  });

  it('excludes future, expired, undrawn and transparent rows, and rejects incoherent frames', () => {
    const row = (id: string, y: number, start = 900, end = 1100) => ({ id, x: 10, y,
      width: 100, height: 30, startAtEpochMs: start, endAtEpochMs: end });
    const draw = (id: string, top: number, alpha = 1, frameId = 9) => ({ id, frameId, alpha,
      rect: { left: 10, top, right: 110, bottom: top + 30 } });
    const frame = { frameId: 9, complete: true, truncated: false,
      startedAtEpochMs: 1000, finishedAtEpochMs: 1001,
      logicalWidth: 800, logicalHeight: 400, backingRatioX: 2, backingRatioY: 2,
      config: { renderer: 'main', fontSize: 32, laneSpacing: 0 },
      active: [row('WINDOWS196_GAP0_A', 0), row('WINDOWS196_GAP0_B', 88),
        row('WINDOWS196_GAP0_FUTURE', 44, 1050, 1200),
        row('WINDOWS196_GAP0_EXPIRED', 66, 850, 990),
        row('WINDOWS196_GAP0_NODRAW', 132), row('WINDOWS196_GAP0_ZERO', 176)],
      draws: [draw('WINDOWS196_GAP0_A', 0), draw('WINDOWS196_GAP0_B', 88),
        draw('WINDOWS196_GAP0_FUTURE', 44), draw('WINDOWS196_GAP0_EXPIRED', 66),
        draw('WINDOWS196_GAP0_ZERO', 176, 0)] };
    expect(measureVisibleRowPitch(frame)).toMatchObject({ status: 'measured', pitchPx: 88,
      excluded: [
        { id: 'WINDOWS196_GAP0_FUTURE', reason: 'future' },
        { id: 'WINDOWS196_GAP0_EXPIRED', reason: 'expired' },
        { id: 'WINDOWS196_GAP0_NODRAW', reason: 'no_current_frame_draw' },
        { id: 'WINDOWS196_GAP0_ZERO', reason: 'zero_alpha' },
      ] });
    for (const bad of [
      { ...frame, complete: false }, { ...frame, truncated: true },
      { ...frame, logicalWidth: null }, { ...frame, finishedAtEpochMs: null },
      { ...frame, draws: null }, { ...frame, config: {} },
    ]) {
      expect(measureVisibleRowPitch(bad)).toMatchObject({ status: 'unknown', pitchPx: null });
    }
    expect(measureVisibleRowPitch({ ...frame, draws: [draw('WINDOWS196_GAP0_A', 0, 1, 8),
      draw('WINDOWS196_GAP0_B', 88)] })).toMatchObject({ status: 'unknown', pitchPx: null,
      reason: 'draw_frame_mismatch' });
    expect(measureVisibleRowPitch({ ...frame, active: [row('WINDOWS196_GAP0_A', 0, 1000.5),
      row('WINDOWS196_GAP0_B', 88)], draws: frame.draws.slice(0, 2) }))
      .toMatchObject({ status: 'unknown', pitchPx: null,
      reason: 'eligibility_changed_during_frame' });
  });

  it('rejects clamped or burst-accelerated Backlog motion while retaining baseline comparison', () => {
    const motion = { id: 'WINDOWS195_BACKLOG_LONG', kind: 'activated', isBacklog: true,
      width: 2200, durationMs: 7160, travelDistancePx: 3580,
      burstSpeedMultiplier: 1.35, actualVelocityPxPerMs: 0.5 };
    expect(() => assertBacklogMotion(motion, 'worker')).not.toThrow();
    expect(() => assertBacklogMotion({ ...motion, burstSpeedMultiplier: null }, 'worker'))
      .toThrow(/finite burst multiplier/);
    expect(() => assertBacklogMotion({ ...motion, burstSpeedMultiplier: null }, 'main'))
      .not.toThrow();
    expect(() => assertBacklogMotion({ ...motion, durationMs: 5000 }, 'worker')).toThrow(/clamped/);
    const accelerated = { ...motion, durationMs: 3580 / 0.675,
      actualVelocityPxPerMs: 0.675 };
    expect(() => assertBacklogMotion(accelerated, 'worker')).toThrow(/extra burst/);
    expect(() => assertBacklogMotion(accelerated, 'worker', true)).not.toThrow();
  });

  it('keeps Canvas exact observations out of Worker-only timing fields', () => {
    const canvas = { exact: { dispositions: [{ id: 'WINDOWS196_GAP0_A' }],
      activeNow: [{ id: 'WINDOWS196_GAP0_A' }] } };
    expect(summarizeExactWorkerProbe(canvas, 'main')).toEqual({
      exactWorkerFrameMs: null, exactWorkerDrainMs: null, exactWorker: null,
    });
    const worker = { exact: { frames: [{ workMs: 2 }], drains: [{ workMs: 1 }],
      dispositions: [], active: [] } };
    expect(summarizeExactWorkerProbe(worker, 'worker')).toMatchObject({
      exactWorkerFrameMs: { count: 1, p95: 2 },
      exactWorkerDrainMs: { count: 1, p95: 1 },
    });
  });

  it('requires real video growth and retention of the same Backlog ID after reflow', () => {
    const before = { config: { logicalWidth: 858, logicalHeight: 482, fontSize: 32 },
      activeNow: [{ id: 'WINDOWS195_BACKLOG_LONG' }] };
    const after = { config: { logicalWidth: 998, logicalHeight: 561, fontSize: 32 },
      activeNow: [{ id: 'WINDOWS195_BACKLOG_LONG' }] };
    expect(() => assertBacklogReflow(before, after, 'WINDOWS195_BACKLOG_LONG')).not.toThrow();
    expect(() => assertBacklogReflow(before, { ...after, config: before.config },
      'WINDOWS195_BACKLOG_LONG')).toThrow(/video geometry/);
    expect(() => assertBacklogReflow(before, { ...after, activeNow: [] },
      'WINDOWS195_BACKLOG_LONG')).toThrow(/disappeared/);
  });

  it('adds a Canvas probe only at the expected packaged app entry', () => {
    const source = 'function getRegularCardInsets() { return { vertical: 1 }; }\n' +
      'var CanvasRenderer = class CanvasRenderer extends RendererBase {};' +
      '\n\tmain();\n})();';
    const instrumented = instrumentCanvasPageScript(source, 'function probe() {}');
    expect(instrumented).toContain(';(function probe() {})(CanvasRenderer, getRegularCardInsets);');
    expect(instrumented?.replace('\n\t;(function probe() {})(CanvasRenderer, getRegularCardInsets);', ''))
      .toBe(source);
    expect(instrumentCanvasPageScript(source.replace('RendererBase', 'OtherBase'))).toBeNull();
    expect(instrumentCanvasPageScript(source.replace('})();', '\n\tmain();\n})();')))
      .toBeNull();
  });

  it('observes Canvas queue and committed motion from an emitted-script-shaped closure', () => {
    const source = `(() => {
      class RendererBase {}
      function getRegularCardInsets() { return { vertical: 1 }; }
      var CanvasRenderer = class CanvasRenderer extends RendererBase {
        constructor() {
          super(); this.settings = { fontSize: 32, laneSpacing: 0 }; this.activeMessages = [];
          this.pendingQueue = { items: [], get size() { return this.items.length; },
            toArray() { return this.items; } };
          this.laneAllocator = { getLaneHeight: () => 34, getLaneCount: () => 20 };
          this.overlay = { getDimensions: () => ({ width: 1280, height: 720 }) };
        }
        enqueueMessage(message) { this.pendingQueue.items.push(message); }
        placeQueuedMessage(message) {
          this.pendingQueue.items.shift(); this.activeMessages.push({ message, laneIndex: 1,
            x: 1280, y: 34, width: 2200, height: 34, slotCount: 1,
            motion: { durationMs: 7160, actualVelocityPxPerMs: .5,
              travelDistancePx: 3580, viewportEntryTime: 100, visibleExitTime: 7260 } });
          return { placed: true };
        }
        renderFrame() {}
      };
      function main() { const renderer = new CanvasRenderer();
        const message = { id: 'WINDOWS195_BACKLOG_LONG', isBacklog: true };
        renderer.enqueueMessage(message); renderer.placeQueuedMessage(message); renderer.renderFrame(); }
      main();
    })();`;
    const state: Record<string, unknown> = {
      beginRenderFrame: () => ({ frameId: 1, cleared: true }),
      endRenderFrame: () => {},
    };
    const script = instrumentCanvasPageScript(source.replace('      main();', '\tmain();'));
    expect(script).not.toBeNull();
    runInNewContext(script!, { __ytPlacementProbe: state,
      performance: { timeOrigin: 1000, now: () => 1 } });
    const exact = state.exact as { peaks: { pending: number; active: number };
      dispositions: Array<{ id: string; laneHeight: number; travelDistancePx: number;
        burstSpeedMultiplier: number | null }> };
    expect(state.canvasSourceHooked).toBe(true);
    expect(exact.peaks).toEqual({ pending: 1, active: 1 });
    expect(exact.dispositions[0]).toMatchObject({ id: 'WINDOWS195_BACKLOG_LONG',
      laneHeight: 34, travelDistancePx: 3580, burstSpeedMultiplier: null });
    expect(() => assertBacklogMotion(exact.dispositions[0], 'main')).not.toThrow();
  });

  it.each(['main', 'worker'])('joins native %s draws and row origins in the same complete frame', (renderer) => {
    const listeners: Record<string, (event: { origin: string; data: unknown }) => void> = {};
    const overlay = { width: renderer === 'main' ? 800 : 1600,
      height: renderer === 'main' ? 400 : 800, closest: () => ({}) };
    const bitmapA = { width: 200, height: 50, closest: () => null };
    const bitmapB = { width: 200, height: 50, closest: () => null };
    let nativeDraws = 0;
    let failNativeDraw = false;
    let clock = 100;
    class FakeContext {
      canvas: { width: number; height: number; closest: () => object | null };
      globalAlpha = 1;
      font = 'bold 32px sans-serif';
      lineWidth = 2;
      constructor(canvas: { width: number; height: number; closest: () => object | null }) {
        this.canvas = canvas;
      }
      fillText(_text: string, _x: number, _y: number) {
        if (failNativeDraw) throw new Error('Native draw failed');
        nativeDraws++;
      }
      strokeText(_text: string, _x: number, _y: number) { nativeDraws++; }
      drawImage(..._args: unknown[]) { nativeDraws++; }
      clearRect(..._args: number[]) {}
      measureText(text: string) { return { width: text.length * 10, actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: text.length * 10,
        actualBoundingBoxAscent: 20, actualBoundingBoxDescent: 5 }; }
      getTransform() { return { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }; }
    }
    const sandbox = { CanvasRenderingContext2D: FakeContext,
      OffscreenCanvasRenderingContext2D: FakeContext, FakeContext, overlay, bitmapA, bitmapB,
      self: undefined as unknown, performance: { timeOrigin: 1000, now: () => clock++ },
      requestAnimationFrame: (_callback: (time: number) => void) => 1,
      addEventListener: (type: string, listener: (event: { origin: string; data: unknown }) => void) => {
        listeners[type] = listener;
      },
      postMessage: (_message: unknown) => {},
      MutationObserver: class { observe() {} }, document: { querySelectorAll: () => [] },
      Blob: class {}, Worker: class {}, HTMLCanvasElement: class {},
    };
    const idA = 'WINDOWS196_GAP0_A';
    const idB = 'WINDOWS196_GAP0_B';
    const active = `[{ id: '${idA}', x: 10, y: 0, width: 100, height: 32,
      startTime: -100, pausedDuration: 0, duration: 1000 },
      { id: '${idB}', x: 10, y: 88, width: 100, height: 32,
      startTime: -100, pausedDuration: 0, duration: 1000 }]`;
    if (renderer === 'main') {
      const source = `(() => {
        class RendererBase {}
        function getRegularCardInsets() { return { vertical: 1 }; }
        var CanvasRenderer = class CanvasRenderer extends RendererBase {
          constructor() {
            super(); this.ctx = new FakeContext(overlay); this.canvas = overlay;
            this.settings = { fontSize: 32, laneSpacing: 0 }; this.activeMessages =
              ${active}.map((entry) => ({ ...entry, message: { id: entry.id } }));
            this.pendingQueue = { size: 0, toArray: () => [] };
            this.laneAllocator = { getLaneHeight: () => 34, getLaneCount: () => 20 };
            this.overlay = { getDimensions: () => ({ width: 800, height: 400 }) };
          }
          enqueueMessage() {} placeQueuedMessage() {} renderFrame() {
            this.canvas.width = 1600; this.canvas.height = 800;
            this.ctx.clearRect(0, 0, 800, 400);
            if (this.paint) {
              this.ctx.fillText('東京 ${idA}', 10, 25);
              if (this.distortRatio) this.canvas.width = 1800;
              this.ctx.fillText('東京 ${idB}', 10, 113);
            }
          }
        };
        function main() { globalThis.fixtureRenderer = new CanvasRenderer();
          fixtureRenderer.paint = true; fixtureRenderer.renderFrame(); }
\tmain();
      })();`;
      const script = instrumentCanvasPageScript(source);
      expect(script).not.toBeNull();
      runInNewContext(`${canvasProbePrelude({ tokens: [idA, idB] })}\n${script}`, sandbox);
    } else {
      const source = `var sample = {
        ctx: new FakeContext(overlay), canvas: overlay,
        config: { fontSize: 32, laneSpacing: 0 }, logicalWidth: 800, logicalHeight: 400,
        activeMessages: ${active}, pendingQueue: [], numLanes: 20, laneHeight: 34,
        enqueueMessage() {}, activateMessage() {}, recordDrop() {},
        checkCollision() { return true; }, findPlacement() { return {}; }, drainQueue() {},
        renderFrame() {
          this.ctx.clearRect(0, 0, 800, 400);
          if (this.paint) {
            this.ctx.drawImage(bitmapA, 0, 0, 200, 50, 10, 5, 100, 25);
            this.ctx.drawImage(bitmapB, 10, 93, 100, 25);
          }
        }, handleMessage() {},
      }; self.onmessage=e=>{sample.handleMessage(e)};`;
      const suffix = workerProbeSuffix(source);
      expect(suffix).not.toBeNull();
      runInNewContext(`self = globalThis; ${workerProbePrelude([idA, idB])}\n${source}${suffix}`, sandbox);
      listeners.message?.({ origin: '', data: { type: 'init', canvas: overlay } });
      runInNewContext(`new FakeContext(bitmapA).fillText('東京 ${idA}', 0, 20);
        new FakeContext(bitmapB).fillText('東京 ${idB}', 0, 20);
        sample.paint = true; sample.renderFrame();`, sandbox);
      expect(nativeDraws).toBeGreaterThan(0);
    }
    const frame = runInNewContext('__ytPlacementProbe.latestRenderFrame', sandbox);
    expect(frame).toMatchObject({ frameId: 1, complete: true, logicalWidth: 800,
      logicalHeight: 400, backingRatioX: 2, backingRatioY: 2 });
    expect(frame.draws[0].rect).toMatchObject({ left: 10 });
    expect(nativeDraws).toBeGreaterThan(0);
    if (renderer === 'main') {
      expect(measureVisibleRowPitch(frame)).toMatchObject({ status: 'measured', pitchPx: 88,
        japaneseVisibleIds: [idA, idB], japaneseVisibleRowOriginsPx: [0, 88] });
      runInNewContext('fixtureRenderer.paint = false; fixtureRenderer.renderFrame();', sandbox);
    } else {
      expect(measureVisibleRowPitch(frame)).toMatchObject({ status: 'measured', pitchPx: 88,
        japaneseVisibleIds: [idA, idB], japaneseVisibleRowOriginsPx: [0, 88] });
      runInNewContext('sample.paint = false; sample.renderFrame();', sandbox);
    }
    const next = runInNewContext('__ytPlacementProbe.latestRenderFrame', sandbox);
    expect(next.frameId).toBe(2);
    expect(next.draws).toHaveLength(0);
    expect(measureVisibleRowPitch(next)).toMatchObject({ status: 'insufficient', pitchPx: null,
      reason: 'fewer_than_two_distinct_visible_rows' });
    if (renderer === 'main') {
      runInNewContext('fixtureRenderer.paint = true; fixtureRenderer.distortRatio = true; fixtureRenderer.renderFrame();', sandbox);
      const incoherent = runInNewContext('__ytPlacementProbe.latestRenderFrame', sandbox);
      expect(incoherent.complete).toBe(false);
      expect(measureVisibleRowPitch(incoherent)).toMatchObject({ status: 'unknown', pitchPx: null });
      failNativeDraw = true;
      expect(() => runInNewContext('fixtureRenderer.renderFrame();', sandbox))
        .toThrow('Native draw failed');
      const failedDraw = runInNewContext('__ytPlacementProbe.latestRenderFrame', sandbox);
      expect(failedDraw).toMatchObject({ complete: false, draws: [] });
    }
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
    expect(result.scenarios).toHaveLength(PLACEMENT_SCENARIOS.length);
    expect(result.scenarios[0]).toMatchObject({ status: 'failed', errorType: 'Error',
      frameWorkMs: { count: 1, p95: 4 }, exactWorkerDrainMs: { count: 1, p95: 1 },
      bounds: [{ id: 'WINDOWS193_SHORT' }], screenshot: 'placement-worker-scroll.png' });
  });

  it('accepts only explicit, known spacing scenario names for a narrow run', async () => {
    const args = { context: {}, root: process.cwd(), output: '/tmp', extensionId: 'fixture' };
    for (const options of [
      { spacingOnly: true },
      { spacingOnly: true, selectedScenarios: ['worker-scroll'] },
      { selectedScenarios: ['unknown'] },
      { selectedScenarios: ['worker-spacing-speed', 'worker-spacing-speed'] },
      { selectedScenarios: [] },
    ]) {
      await expect(runPlacementTimingFixture({ ...args, ...options })).rejects.toThrow();
    }
  });

  it('summarizes bounded, nonnegative frame samples without treating invalid values as work', () => {
    expect(summarizeSamples([])).toEqual({ count: 0, p50: null, p95: null, max: null });
    expect(summarizeSamples([10, 1, Infinity, -1, 3, 2, 4])).toEqual({
      count: 5, p50: 3, p95: 10, max: 10,
    });
  });

  it.each([1, 2])('associates a cached bitmap with viewport bounds at scale %s', (scale) => {
    const listeners: Record<string, (event: { origin: string; data: unknown }) => void> = {};
    const messages: Array<{ type: string; sample?: { firstEntry: Record<string, number>; bounds: unknown[];
      ink: Array<{ sourceInk?: { fill?: { font: string }; stroke?: { lineWidth: number } } }> } }> = [];
    const overlay = { width: 640 * scale, height: 360 * scale };
    const bitmap = { width: 100, height: 24 };
    let now = 5;
    class FakeContext {
      canvas: typeof overlay;
      globalAlpha = 1;
      font = 'bold 32px sans-serif';
      lineWidth = 2;

      constructor(canvas: typeof overlay) { this.canvas = canvas; }
      fillText(_text: string, _x: number, _y: number) {}
      strokeText(_text: string, _x: number, _y: number) {}
      drawImage(_image: object, _x: number, _y: number, _width: number, _height: number) {}
      clearRect(_x: number, _y: number, _width: number, _height: number) {}
      measureText() { return { width: 100, actualBoundingBoxAscent: 20, actualBoundingBoxDescent: 4 }; }
      getTransform() { return { a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 }; }
    }
    const sandbox = {
      OffscreenCanvasRenderingContext2D: FakeContext,
      performance: { timeOrigin: 1000, now: () => now++ },
      requestAnimationFrame: (callback: (time: number) => void) => callback(0),
      addEventListener: (type: string, listener: (event: { origin: string; data: unknown }) => void) => {
        listeners[type] = listener;
      },
      postMessage: (message: { type: string; sample?: { firstEntry: Record<string, number>; bounds: unknown[];
        ink: Array<{ sourceInk?: { fill?: { font: string }; stroke?: { lineWidth: number } } }> } }) => {
        messages.push(message);
      },
    };
    runInNewContext(workerProbePrelude(['WINDOWS193_SHORT']), sandbox);
    listeners.message?.({ origin: '', data: { type: 'init', canvas: overlay } });
    listeners.message?.({ origin: '', data: { type: 'addMessages', messages: [{ id: 'WINDOWS193_SHORT' }] } });
    sandbox.requestAnimationFrame(() => {
      const cache = new FakeContext(bitmap);
      cache.fillText('WINDOWS193_SHORT', 0, 0);
      cache.strokeText('WINDOWS193_SHORT', 0, 0);
      const display = new FakeContext(overlay);
      display.clearRect(0, 0, 640, 360);
      display.globalAlpha = 0;
      display.drawImage(bitmap, 500, 20, 100, 24);
      display.globalAlpha = 1;
      display.drawImage(bitmap, 500, 20, 100, 24);
    });
    listeners.message?.({ origin: 'https://attacker.example', data: { type: 'ytPlacementFlush' } });
    expect(messages).toHaveLength(0);
    listeners.message?.({ origin: '', data: { type: 'ytPlacementFlush' } });

    const sample = messages.at(-1)?.sample;
    expect(sample?.firstEntry.WINDOWS193_SHORT).toBeGreaterThan(1000);
    expect(sample?.bounds).toHaveLength(1);
    expect(sample?.bounds[0]).toMatchObject({
      id: 'WINDOWS193_SHORT', left: 500 * scale, top: 20 * scale,
      right: 600 * scale, bottom: 44 * scale,
    });
    expect(sample?.ink[0]?.sourceInk).toMatchObject({
      fill: { font: 'bold 32px sans-serif' }, stroke: { lineWidth: 2 },
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
    const listeners: Record<string, (event: { origin: string; data: unknown }) => void> = {};
    const messages: Array<{ sample?: { exact?: {
      drops: Record<string, number>;
      drains: unknown[]; frames: unknown[]; dispositions: Array<{ queueResidenceMs: number }>;
    } } }> = [];
    let now = 1;
    const sandbox = {
      performance: { timeOrigin: 1000, now: () => now++ },
      requestAnimationFrame: (_callback: (time: number) => void) => 1,
      addEventListener: (type: string, listener: (event: { origin: string; data: unknown }) => void) => {
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
    listeners.message?.({ origin: '', data: { type: 'ytPlacementFlush' } });
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
