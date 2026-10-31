// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext, Script } from 'node:vm';

import type { ChatMessage, OverlaySettings } from '@app-types';
import { RenderWorkerManager } from '@renderer/worker/manager';
import type { ObservabilityReporter } from '@util/observability';
import { describe, expect, it, vi } from 'vite-plus/test';

import { resolveLimits } from '../../../src/settings/limits.ts';
import {
  assertPaidCaptureFrame,
  assertDetailedPresentationReady,
  assertBackend,
  assertCoherentVisibleFrame,
  assertCommittedVisibleItem,
  assertNoVisibleCardInk,
  assertOwnedContentInk,
  assertPreviewComparison,
  assertResizeSafeMotion,
  assertRestoredVisibility,
  attachWorkerManagerProbe,
  bindMatrixIdentity,
  classifyVacancySeedOrdinary,
  classifyMatrixRuntime,
  classifyPlanProbeCapability,
  flowTrace,
  instrumentWorkerManagerPageScript,
  MATRIX_BATCHES,
  membershipEffect,
  OVERLOAD_BATCHES,
  overloadTrace,
  overflowSeedAdmissionFinding,
  paidRowBudget,
  readManagerIngressFifoSelector,
  planPaidCaptureWait,
  planRoleVisibilityWait,
  planVisibleItemWait,
  presentationItem,
  presentationGeometry,
  scrollCurrentPreviewCanvasIntoView,
  snapshot,
  waitForPaidPlan,
  waitForPaidCapture,
  validateMatrixMode,
  waitForIngress,
  waitForOverflowSeedProcessed,
} from '../../../validation/windows/comment-display-matrix.ts';
import { canvasProbePrelude } from '../../../validation/windows/placement-timing.ts';

const source = MATRIX_BATCHES.content.map(
  (action) => Object.values(action.addChatItemAction.item)[0]
);

describe('Windows comment display matrix contract', () => {
  it('selects only the exact source-owned Manager FIFO input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yt-manager-fifo-'));
    const inputs = join(root, 'validation/windows/inputs');
    try {
      expect(await readManagerIngressFifoSelector(root)).toBe(false);
      await mkdir(inputs, { recursive: true });
      const path = join(inputs, 'manager-ingress-fifo.json');
      await writeFile(path, '{"scenario":"manager-ingress-fifo"}');
      expect(await readManagerIngressFifoSelector(root)).toBe(true);
      await writeFile(path, '{"scenario":"overflow"}');
      await expect(readManagerIngressFifoSelector(root)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains the exact ordered ordinary IDs from returned native Worker posts', () => {
    const posts: Array<Record<string, unknown>> = [];
    class TestManager {
      worker = { postMessage: (message: Record<string, unknown>) => posts.push(message) };
      latestWorkerPendingDepth = 0;
      currentEpoch = 0;
      deps = { observability: { getMetrics: () => ({ totalDropped: 4 }) } };
      sendToWorker(message: { id: string }, id = message.id) {
        this.worker.postMessage({ type: 'addMessages', messages: [{ id }] });
        return true;
      }
      applyBatchReceipt() {}
      setPaused() {}
    }
    const target: Record<string, unknown> = {};
    attachWorkerManagerProbe(
      TestManager,
      target,
      ['WINDOWS387_FIFO_PAID_BOOTSTRAP', 'WINDOWS387_FIFO_OLD_4', 'WINDOWS387_FIFO_NEW_0'],
      false
    );
    const manager = new TestManager();
    manager.sendToWorker({ id: 'WINDOWS387_FIFO_PAID_BOOTSTRAP' });
    const probe = target.__ytMatrixManagerProbe as {
      read: () => {
        nativePostedOrdinaryIds: string[];
        omittedNativePostedOrdinaryIds: number;
      };
      sendFixture: (id: string, kind: 'text') => boolean;
      droppedCount: () => number;
    };
    expect(probe.sendFixture('WINDOWS387_FIFO_OLD_4', 'text')).toBe(true);
    expect(probe.sendFixture('WINDOWS387_FIFO_NEW_0', 'text')).toBe(true);
    expect(probe.read().nativePostedOrdinaryIds).toEqual([
      'WINDOWS387_FIFO_OLD_4',
      'WINDOWS387_FIFO_NEW_0',
    ]);
    expect(probe.read().omittedNativePostedOrdinaryIds).toBe(0);
    expect(probe.droppedCount()).toBe(4);
    expect(posts).toHaveLength(3);
    expect(() => probe.sendFixture('not-fixture-owned', 'text')).toThrow();
  });

  it('binds presentation capture to full or source-limited near-full paid ink', async () => {
    const id = 'WINDOWS380_DETAILED_PAID';
    const makeSample = (
      backend: 'main' | 'worker',
      viewportWidth: number,
      logicalWidth: number,
      cardWidth: number,
      x: number,
      velocity: number
    ) => {
      const row = {
        id,
        x,
        y: 100,
        width: cardWidth,
        height: 200,
        startAtEpochMs: 1000,
        endAtEpochMs: 16000,
        actualVelocityPxPerMs: velocity,
      };
      return {
        backend,
        sourcePrefixed: true,
        sourceHooked: true,
        canvasSourceHooked: backend === 'main',
        workerReady: backend === 'worker',
        viewport: { width: viewportWidth, height: 1100, dpr: 1 },
        overlay: { width: logicalWidth, height: 898, left: 0, top: 0 },
        frame: {
          frameId: 7,
          startedAtEpochMs: 1100,
          complete: true,
          cleared: true,
          truncated: false,
          logicalWidth,
          logicalHeight: 898,
          backingRatioX: 1,
          backingRatioY: 1,
          active: [row],
          draws: [
            {
              id,
              section: 'body' as const,
              alpha: 0.65,
              rect: { left: x + 10, top: 120, right: x + 100, bottom: 150 },
            },
            {
              id,
              section: 'translation' as const,
              alpha: 0.65,
              rect: { left: x + 10, top: 160, right: x + 100, bottom: 190 },
            },
          ],
          cardPlans: [
            {
              id,
              kind: 'superchat',
              height: 200,
              maxBodyLines: 4,
              bodyRows: 1,
              bodyY: 20,
              bodyHeight: 30,
              translationRows: 1,
              translationY: 60,
              translationHeight: 30,
              borderAlpha: null,
              borderStyle: null,
            },
          ],
          config: {
            superChatLayout: 'stacked',
            reducedMotion: false,
            ignoreReducedMotion: false,
          },
        },
        layout: 'stacked',
        firstEntry: { [id]: 1001 },
        ingress: {},
        dispositions: [],
        pendingNow: [],
        queuedNow: [],
        retained: null,
        activeNow: [row],
        frames: [],
        drains: [],
        ink: [],
        stats: [],
        accessibility: {},
        fixtureText: {},
        measuredPlans: {},
        presentationCount: 1,
        totalPresentationUnknown: null,
        presentationCounterAvailable: true,
        overflow: 0,
      } satisfies Parameters<typeof planPaidCaptureWait>[0];
    };
    for (const backend of ['main', 'worker'] as const) {
      const partial = makeSample(backend, 960, 858, 598, 816, 0.10373333333333333);
      const fullWait = planPaidCaptureWait(partial, id, 20_000);
      expect(fullWait).toMatchObject({ requiredVisibleFraction: 1, zeroFullExposureWindow: false });
      expect(fullWait.targetWindowMs).toBeGreaterThan(2500);
      expect(fullWait.timeoutMs).toBeGreaterThan(10_000);
      expect(() => assertPaidCaptureFrame(partial, id, 'stacked', fullWait, true)).toThrow();
      const full = makeSample(backend, 960, 858, 598, 200, 0.10373333333333333);
      expect(
        assertPaidCaptureFrame(full, id, 'stacked', fullWait, true).actualVisibleFraction
      ).toBe(1);
      let predicate = '';
      let input: unknown;
      const page = {
        waitForFunction: async (callback: (arg: unknown) => unknown, arg: unknown) => {
          predicate = callback.toString();
          input = arg;
        },
      } as unknown as Parameters<typeof waitForPaidCapture>[0];
      const browserMatches = (candidate: typeof partial, viewportWidth: number) => {
        const selected = {
          latestRenderFrame: candidate.frame,
          exact: { config: { superChatLayout: 'stacked' }, activeNow: candidate.activeNow },
        };
        const probe = {
          workers: backend === 'worker' ? [{ ready: true, sample: selected }] : [],
          ...selected,
          requestFlushIfDue: () => {},
        };
        return runInNewContext(`(${predicate})(${JSON.stringify(input)})`, {
          window: { __ytPlacementProbe: probe },
          innerWidth: viewportWidth,
        });
      };
      await waitForPaidCapture(page, backend, id, 'stacked', fullWait, true);
      expect(browserMatches(partial, 960)).toBe(false);
      expect(browserMatches(full, 960)).toBe(true);
      for (const shift of [1.7, 5.1]) {
        const renewedEpoch = makeSample(backend, 960, 858, 598, 200, 0.10373333333333333);
        renewedEpoch.frame.active[0]!.startAtEpochMs += shift;
        renewedEpoch.frame.active[0]!.endAtEpochMs += shift;
        expect(browserMatches(renewedEpoch, 960)).toBe(true);
        expect(() => assertPaidCaptureFrame(renewedEpoch, id, 'stacked', fullWait, true)).toThrow();
        const settled = planPaidCaptureWait(renewedEpoch, id, 20_000);
        expect(settled.plannedStartAtEpochMs - fullWait.plannedStartAtEpochMs).toBeCloseTo(shift);
        expect(assertPaidCaptureFrame(renewedEpoch, id, 'stacked', settled, true)).toBeTruthy();
        const postPngReplan = makeSample(backend, 960, 858, 598, 180, 0.10373333333333333);
        postPngReplan.frame.active[0]!.startAtEpochMs += shift + 1;
        postPngReplan.frame.active[0]!.endAtEpochMs += shift + 1;
        expect(() => assertPaidCaptureFrame(postPngReplan, id, 'stacked', settled, true)).toThrow();
        const staleExact = {
          ...renewedEpoch,
          activeNow: [{ ...renewedEpoch.activeNow[0]!, startAtEpochMs: 1000 }],
        };
        expect(browserMatches(staleExact, 960)).toBe(false);
        expect(() => planPaidCaptureWait(staleExact, id, 20_000)).toThrow();
        const staleFrameAfterPng = {
          ...renewedEpoch,
          frame: {
            ...renewedEpoch.frame,
            active: [{ ...renewedEpoch.frame.active[0]!, startAtEpochMs: 1000 }],
          },
        };
        expect(() =>
          assertPaidCaptureFrame(staleFrameAfterPng, id, 'stacked', settled, true, true)
        ).toThrow();
      }
      expect(() =>
        assertPaidCaptureFrame(
          makeSample(backend, 960, 858, 598, -1, 0.10373333333333333),
          id,
          'stacked',
          fullWait,
          true
        )
      ).toThrow();
      const narrowPartial = makeSample(backend, 400, 335, 335, 304, 0.051333333333333335);
      const narrowWait = planPaidCaptureWait(narrowPartial, id, 20_000);
      expect(narrowWait).toMatchObject({
        requiredVisibleFraction: 0.95,
        zeroFullExposureWindow: true,
      });
      expect(narrowWait.targetWindowMs).toBeGreaterThan(300);
      const nearFull = makeSample(backend, 400, 335, 335, 10, 0.051333333333333335);
      expect(
        assertPaidCaptureFrame(nearFull, id, 'stacked', narrowWait, true).actualVisibleFraction
      ).toBeGreaterThan(0.95);
      await waitForPaidCapture(page, backend, id, 'stacked', narrowWait, true);
      expect(browserMatches(narrowPartial, 400)).toBe(false);
      expect(browserMatches(nearFull, 400)).toBe(true);
      expect(() =>
        assertPaidCaptureFrame(narrowPartial, id, 'stacked', narrowWait, true)
      ).toThrow();
      const exitingNearFull = makeSample(backend, 400, 335, 335, -10, 0.051333333333333335);
      expect(() =>
        assertPaidCaptureFrame(exitingNearFull, id, 'stacked', narrowWait, true)
      ).toThrow();
      expect(
        assertPaidCaptureFrame(exitingNearFull, id, 'stacked', narrowWait, true, true)
          .actualVisibleFraction
      ).toBeGreaterThan(0.95);
      expect(() =>
        assertPaidCaptureFrame(
          makeSample(backend, 400, 335, 335, -18, 0.051333333333333335),
          id,
          'stacked',
          narrowWait,
          true,
          true
        )
      ).toThrow();
      expect(() =>
        assertPaidCaptureFrame(
          makeSample(backend, 400, 335, 335, -1, 0.051333333333333335),
          id,
          'stacked',
          narrowWait,
          true
        )
      ).toThrow();
      expect(planPaidCaptureWait(partial, id, 58_000).timeoutMs).toBe(0);
      expect(() =>
        planPaidCaptureWait(
          { ...partial, frame: { ...partial.frame, config: { superChatLayout: 'wide' } } },
          id,
          20_000
        )
      ).toThrow();
      expect(() =>
        planPaidCaptureWait(
          {
            ...partial,
            frame: {
              ...partial.frame,
              active: [{ ...partial.frame.active[0]!, startAtEpochMs: 2000 }],
            },
          },
          id,
          20_000
        )
      ).toThrow();
    }
  });

  it('requires the recorded detailed-wide role composition before the minimum-line reflow', () => {
    const name = 'detailed-960-wide';
    const observation = {
      name,
      scene: 'detailed',
      layout: 'wide',
      paid: { drawAlpha: 0.65 },
      translatedDraw: true,
      items: [
        { role: 'sticker', proof: { alpha: 0.65 } },
        { role: 'membership', proof: { alpha: 0.65 } },
        { role: 'ordinary', proof: { alpha: 0.65 } },
      ],
    };
    expect(() => assertDetailedPresentationReady(observation, name, 'wide')).not.toThrow();
    expect(() => assertDetailedPresentationReady(undefined, name, 'wide')).toThrow();
    expect(() =>
      assertDetailedPresentationReady({ ...observation, layout: 'stacked' }, name, 'wide')
    ).toThrow();
    expect(() =>
      assertDetailedPresentationReady({ ...observation, paid: { drawAlpha: 0 } }, name, 'wide')
    ).toThrow();
    expect(() =>
      assertDetailedPresentationReady(
        { ...observation, items: observation.items.filter((item) => item.role !== 'membership') },
        name,
        'wide'
      )
    ).toThrow();
    expect(() =>
      assertDetailedPresentationReady(
        {
          ...observation,
          items: observation.items.map((item) =>
            item.role === 'membership' ? { ...item, proof: { alpha: 0 } } : item
          ),
        },
        name,
        'wide'
      )
    ).toThrow();
  });

  it('waits for current-frame minimum paid body and translation viewport ink', async () => {
    const id = 'WINDOWS380_DETAILED_PAID';
    const makeDraw = (section: 'body' | 'translation', left: number, alpha = 0.65) => ({
      id,
      section,
      alpha,
      rect: { left, top: 555, right: left + 100, bottom: 593 },
    });
    const frame = {
      complete: true,
      cleared: true,
      truncated: false,
      logicalWidth: 858,
      logicalHeight: 898,
      cardPlans: [{ id, maxBodyLines: 2, bodyRows: 1, translationRows: 1, height: 200 }],
      active: [{ id, x: 845, y: 450, width: 628, height: 200 }],
      draws: [makeDraw('body', 869), makeDraw('translation', 872)],
    };
    for (const backend of ['main', 'worker'] as const) {
      let predicate = '';
      let input: unknown;
      const page = {
        waitForFunction: async (
          callback: (arg: unknown) => unknown,
          arg: unknown,
          options: { timeout: number }
        ) => {
          predicate = callback.toString();
          input = arg;
          expect(options.timeout).toBe(5801);
        },
      } as unknown as Parameters<typeof waitForPaidPlan>[0];
      await waitForPaidPlan(page, backend, id, 2, true, 5801);
      const matches = (candidate: typeof frame) => {
        const probe = {
          workers:
            backend === 'worker' ? [{ ready: true, sample: { latestRenderFrame: candidate } }] : [],
          latestRenderFrame: candidate,
          requestFlushIfDue: () => {},
        };
        return runInNewContext(`(${predicate})(${JSON.stringify(input)})`, {
          window: { __ytPlacementProbe: probe },
        });
      };
      expect(matches(frame)).toBe(false);
      const visible = { ...frame, draws: [makeDraw('body', 849), makeDraw('translation', 852)] };
      expect(matches(visible)).toBe(true);
      expect(
        matches({ ...visible, draws: [visible.draws[0]!, makeDraw('translation', 852, 0)] })
      ).toBe(false);
      expect(
        matches({ ...visible, cardPlans: [{ ...frame.cardPlans[0]!, maxBodyLines: 4 }] })
      ).toBe(false);
      expect(matches({ ...visible, truncated: true })).toBe(false);
    }
  });

  it('budgets source-planned role visibility inside the unchanged backend deadline', () => {
    const planned = planRoleVisibilityWait(1793452736488.9, 1793452735688, 25_000);
    expect(planned.plannedDelayMs).toBeCloseTo(800.9, 1);
    expect(planned.timeoutMs).toBe(5801);
    expect(planned.budgetLimited).toBe(false);
    expect(planRoleVisibilityWait(1000, 1100, 25_000).timeoutMs).toBe(5000);
    expect(planRoleVisibilityWait(null, 1100, 25_000).timeoutMs).toBe(5000);
    expect(planRoleVisibilityWait(Number.NaN, 1100, 25_000).timeoutMs).toBe(5000);
    const futureOutsideBudget = planRoleVisibilityWait(3100, 1100, 58_000);
    expect(futureOutsideBudget.timeoutMs).toBe(0);
    expect(futureOutsideBudget.budgetLimited).toBe(true);
    const limitedSlack = planRoleVisibilityWait(1600, 1100, 56_000);
    expect(limitedSlack.timeoutMs).toBe(3000);
    expect(limitedSlack.budgetLimited).toBe(true);
    const exhausted = planRoleVisibilityWait(1793452736488.9, 1793452735688, 59_000);
    expect(exhausted.timeoutMs).toBe(0);
    expect(exhausted.budgetLimited).toBe(true);
  });

  it('refreshes capped Worker samples while waiting for actual renderer ingress', async () => {
    const id = 'WINDOWS380_LOAD_OVERFLOW_NEW_3';
    let now = 0;
    let flushes = 0;
    const sandbox: Record<string, unknown> = {
      performance: { timeOrigin: 1000, now: () => now },
      requestAnimationFrame: () => 0,
      HTMLCanvasElement: class {},
      Worker: class {},
      MutationObserver: class {
        observe() {}
      },
      document: { querySelectorAll: () => [] },
    };
    sandbox.window = sandbox;
    runInNewContext(canvasProbePrelude({ forceFallback: true, tokens: [id] }), sandbox);
    const probe = sandbox.__ytPlacementProbe as {
      workers: Array<{
        ready: boolean;
        sample: { ingress: Record<string, number> };
        worker: object;
      }>;
      requestFlushIfDue: (worker: object) => void;
      flushSequence?: number;
    };
    const sample = { ingress: {} as Record<string, number> };
    const worker = {
      ready: true,
      sample,
      worker: {
        postMessage: (message: { type: string; requestId: number }) => {
          expect(message.type).toBe('ytPlacementFlush');
          flushes++;
          queueMicrotask(() => {
            sample.ingress[id] = 1001;
          });
        },
      },
    };
    probe.workers.push(worker);
    const page = {
      waitForFunction: async (callback: (input: unknown) => boolean, input: unknown) => {
        for (let attempt = 0; attempt < 4; attempt++) {
          const matched = runInNewContext(
            `(${callback.toString()})(${JSON.stringify(input)})`,
            sandbox
          );
          if (matched) return;
          await Promise.resolve();
        }
        throw new Error('Ingress did not become visible to the waiter');
      },
    } as unknown as Parameters<typeof waitForIngress>[0];
    await waitForIngress(page, 'worker', id);
    expect(flushes).toBe(1);
    expect(sample.ingress[id]).toBe(1001);
    probe.requestFlushIfDue(worker);
    now = 99;
    probe.requestFlushIfDue(worker);
    expect(flushes).toBe(1);
    now = 100;
    probe.requestFlushIfDue(worker);
    expect(flushes).toBe(2);
  });

  it('observes the actual Worker Manager without changing sends or receipts', async () => {
    const id = 'WINDOWS380_LOAD_OVERFLOW_NEW_3';
    const secondId = 'WINDOWS380_LOAD_OVERFLOW_NEW_2';
    const message: ChatMessage = {
      id,
      kind: 'text',
      text: `${id} PRIVATE_PAYLOAD`,
      content: [{ type: 'text', content: `${id} PRIVATE_PAYLOAD` }],
      timestamp: 0,
      authorType: 'normal',
    };
    const originalSend = RenderWorkerManager.prototype.sendToWorker;
    const prototype = RenderWorkerManager.prototype as unknown as Record<string, unknown>;
    const originalReceipt = prototype.applyBatchReceipt;
    const run = async (probeEnabled: boolean, oldShape = false) => {
      const posted: unknown[] = [];
      const worker = {
        postMessage: (value: unknown) => {
          posted.push(value);
        },
      };
      const manager = new RenderWorkerManager({
        settings: { queueMaxSize: 2, maxConcurrentMessages: 1 } as OverlaySettings,
        observability: {
          onMessageDropped: vi.fn(),
          updateActiveMessages: vi.fn(),
          updateQueueDepth: vi.fn(),
          updateLaneUtilization: vi.fn(),
        } as unknown as ObservabilityReporter,
        estimateDimensions: () => ({ width: 80, height: 20 }),
        getMessagePriority: () => 0,
        getEffectiveSpeedPxPerSec: () => 100,
      });
      const state = manager as unknown as Record<string, unknown>;
      state.worker = worker;
      manager.setActive(true);
      const originalDeferred = state.deferredIngress;
      const target: Record<string, unknown> = {};
      try {
        if (probeEnabled)
          attachWorkerManagerProbe(RenderWorkerManager, target, [id, secondId], !oldShape);
        const accepted = manager.sendToWorker(message, id);
        const secondAccepted = manager.sendToWorker({ ...message, id: secondId }, secondId);
        await Promise.resolve();
        const receipt = {
          type: 'batchReceipt',
          batchSequence: 1,
          epoch: state.currentEpoch,
          pendingQueueDepth: 2,
          minimumPendingPriority: 0,
        };
        Reflect.apply(state.applyBatchReceipt as Function, manager, [receipt]);
        if (oldShape) {
          state.deferredIngress = undefined;
          state.getProjectedWorkerWork = undefined;
        }
        const observed = (
          target.__ytMatrixManagerProbe as
            | {
                read: () => {
                  probeError: string | null;
                  manager: Record<string, unknown>;
                  events: Array<Record<string, unknown>>;
                };
              }
            | undefined
        )?.read();
        return {
          accepted,
          secondAccepted,
          posted,
          depth: state.latestWorkerPendingDepth,
          observed,
        };
      } finally {
        state.deferredIngress = originalDeferred;
        delete state.getProjectedWorkerWork;
        prototype.sendToWorker = originalSend;
        prototype.applyBatchReceipt = originalReceipt;
        state.worker = null;
        manager.destroy();
      }
    };
    const without = await run(false);
    const withProbe = await run(true);
    expect(withProbe.accepted).toBe(without.accepted);
    expect(withProbe.secondAccepted).toBe(without.secondAccepted);
    expect(withProbe.posted).toEqual(without.posted);
    expect(withProbe.depth).toBe(without.depth);
    expect(withProbe.observed?.probeError).toBeNull();
    expect(withProbe.observed?.manager).toMatchObject({
      latestWorkerPendingDepth: 2,
      lastWorkerReceiptSequence: 1,
      nextBatchSequence: 1,
      pendingBatchCount: 0,
      deferredIngressCount: 0,
      projectedWork: 2,
    });
    expect(withProbe.observed?.events.map((event) => event.kind)).toContain('native-post');
    expect(withProbe.observed?.events.find((event) => event.kind === 'native-post')).toMatchObject({
      fixtureMessageIds: [id, secondId],
      messageCount: 2,
      batchSequence: 1,
    });
    expect(withProbe.observed?.events.map((event) => event.kind)).toContain(
      'manager-receipt-after'
    );
    expect(JSON.stringify(withProbe.observed)).not.toContain('PRIVATE_PAYLOAD');
    const oldBaseline = await run(true, true);
    expect(oldBaseline.accepted).toBe(without.accepted);
    expect(oldBaseline.posted).toEqual(without.posted);
    expect(oldBaseline.observed?.probeError).toBeNull();
    expect(oldBaseline.observed?.manager).toMatchObject({
      latestWorkerPendingDepth: 2,
      deferredIngressCount: null,
      deferredIngress: null,
      projectedWork: null,
    });
    if (!withProbe.observed) throw new Error('Actual Manager probe was not captured');
    const probeWindow = {
      __ytPlacementProbe: {
        workers: [{ ready: true, sample: { ingress: {} as Record<string, number> } }],
        requestFlushIfDue: vi.fn(),
      },
      __ytMatrixManagerProbe: { read: () => withProbe.observed },
    };
    const page = {
      waitForFunction: async (callback: (value: unknown) => boolean, value: unknown) => {
        expect(
          runInNewContext(`(${callback.toString()})(${JSON.stringify(value)})`, {
            window: probeWindow,
          })
        ).toBe(true);
      },
    } as unknown as Parameters<typeof waitForOverflowSeedProcessed>[0];
    await waitForOverflowSeedProcessed(page, 'worker', id);
    expect(probeWindow.__ytPlacementProbe.workers[0]?.sample.ingress[id]).toBeUndefined();
    expect(overflowSeedAdmissionFinding('baseline', 'worker', 52)).toContain('52/80');
    expect(
      overflowSeedAdmissionFinding('baseline', 'worker', 52, {
        deferredCount: 28,
        recentRejectedSends: 1,
      })
    ).toContain('Manager deferred 28, rejected sends in recent ring 1');
    expect(() => overflowSeedAdmissionFinding('candidate', 'worker', 52)).toThrow();
    expect(() => overflowSeedAdmissionFinding('baseline', 'main', 52)).toThrow();
    expect(overflowSeedAdmissionFinding('candidate', 'worker', 80)).toBeNull();
  });

  it('inserts only at the packaged entry and rejects Manager shape drift', () => {
    const source =
      'var RenderWorkerManager = class RenderWorkerManager {' +
      'sendToWorker(message, msgId, trackDrops = true) {}' +
      'applyBatchReceipt(receipt) {} };\n\tmain();\n';
    const instrumented = instrumentWorkerManagerPageScript(source, 'candidate');
    expect(instrumented).not.toBeNull();
    expect(instrumented?.startsWith(source.split('\n\tmain();\n')[0]!)).toBe(true);
    expect(instrumented?.endsWith('\n\tmain();\n')).toBe(true);
    expect(() => new Script(instrumented!)).not.toThrow();
    expect(
      instrumentWorkerManagerPageScript(source.replace('applyBatchReceipt', 'renamed'), 'candidate')
    ).toBeNull();
  });
  it('keeps the three Unicode boundary inputs and accepted source tails distinct', () => {
    const bodies = source.slice(0, 3).map((item) => {
      if (!item || !('message' in item) || !('runs' in item.message))
        throw new Error('Missing text action');
      return item.message.runs[0]?.text;
    });
    expect(bodies[0]).toContain('e\u0301ZZZ CANONICAL_END');
    expect(bodies[1]).toContain('👍🏽Z CANONICAL_END');
    expect(bodies[2]).toContain('👨‍👩‍👧‍👦Z CANONICAL_END');
    for (const body of bodies) expect(body).toContain('WINDOWS380_');
  });

  it('requires an explicit comparison mode', () => {
    expect(() => validateMatrixMode('candidate')).not.toThrow();
    expect(() => validateMatrixMode('baseline')).not.toThrow();
    expect(() => validateMatrixMode(undefined)).toThrow();
    expect(() => validateMatrixMode('auto')).toThrow();
  });

  it('rejects planless legacy collection without labeling it an observed backend', () => {
    const legacy =
      'function getRegularCardInsets() {}\n' +
      'var CanvasRenderer = class CanvasRenderer extends RendererBase {};\n\tmain();\n})();';
    expect(classifyPlanProbeCapability('baseline', legacy)).toBe('unsupported-legacy-planless');
    expect(classifyPlanProbeCapability('candidate', legacy)).toBe('invalid');
    expect(classifyPlanProbeCapability('baseline', `${legacy} superChatLayout`)).toBe('invalid');
    expect(classifyPlanProbeCapability('baseline', '')).toBe('invalid');
    const shared = legacy.replace('main();', 'preparePaidCardPlan({ width: 1 }); main();');
    expect(classifyPlanProbeCapability('baseline', shared)).toBe('instrumented');
  });

  it('classifies transplanted legacy capability from both actual backends, independent of source SHA', () => {
    const transplantedSourceSha = 'a'.repeat(40);
    const legacy = [
      { backend: 'worker', status: 'passed', layoutSupport: 'legacy-stacked-only' },
      { backend: 'main', status: 'passed', layoutSupport: 'legacy-stacked-only' },
    ] as const;
    expect(classifyMatrixRuntime('baseline', transplantedSourceSha, legacy)).toEqual({
      kind: 'legacy-stacked-baseline',
      sourceSha: transplantedSourceSha,
      runtimeCapability: 'legacy-stacked-only',
    });
    expect(classifyMatrixRuntime('candidate', transplantedSourceSha, legacy).kind).toBe(
      'invalid-capability'
    );
    expect(
      classifyMatrixRuntime('baseline', transplantedSourceSha, [
        legacy[0],
        {
          ...legacy[1],
          layoutSupport: 'stacked-and-wide',
        },
      ]).kind
    ).toBe('invalid-capability');
    expect(
      classifyMatrixRuntime('baseline', transplantedSourceSha, [
        legacy[0],
        {
          ...legacy[1],
          status: 'failed',
          layoutSupport: 'unavailable',
        },
      ]).kind
    ).toBe('invalid-capability');
    const wide = legacy.map((entry) => ({ ...entry, layoutSupport: 'stacked-and-wide' as const }));
    expect(classifyMatrixRuntime('baseline', transplantedSourceSha, wide).kind).toBe(
      'wide-capable-baseline'
    );
    expect(classifyMatrixRuntime('candidate', transplantedSourceSha, wide).kind).toBe(
      'wide-capable-candidate'
    );
  });

  it('requires drawn production preview samples to respond to the layout selection', () => {
    const stacked = [
      {
        label: 'Paid',
        ariaLabel: 'Paid A very long author 이름',
        width: 300,
        height: 120,
        alphaPixels: 100,
      },
      {
        label: 'Narrow',
        ariaLabel: 'Narrow 長い名前 مرحبا',
        width: 240,
        height: 150,
        alphaPixels: 80,
      },
      { label: 'Member', ariaLabel: 'Member 회원 event', width: 300, height: 90, alphaPixels: 60 },
    ];
    expect(() => assertPreviewComparison(stacked, stacked)).toThrow();
    expect(() =>
      assertPreviewComparison(stacked, [{ ...stacked[0]!, height: 88 }, stacked[1]!, stacked[2]!])
    ).not.toThrow();
    expect(() =>
      assertPreviewComparison(stacked, [
        { ...stacked[0]!, alphaPixels: 0, height: 88 },
        stacked[1]!,
        stacked[2]!,
      ])
    ).toThrow();
  });

  it('scrolls a current readable preview after a detached canvas is replaced', () => {
    const makeCanvas = (connected: boolean, width: number, height: number) => ({
      isConnected: connected,
      width,
      height,
      getBoundingClientRect: () => ({ width, height }),
      getContext: () => ({
        getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
      }),
      scrollIntoView: vi.fn(),
    });
    const detached = makeCanvas(false, 300, 120);
    const replacement = makeCanvas(true, 300, 120);
    let current: ReturnType<typeof makeCanvas> | null = detached;
    let visibility = 'visible';
    const root = {
      querySelector: () => current,
      defaultView: { getComputedStyle: () => ({ visibility }) },
    } as unknown as Document;

    expect(scrollCurrentPreviewCanvasIntoView(root)).toBe(false);
    expect(detached.scrollIntoView).not.toHaveBeenCalled();
    current = replacement;
    expect(scrollCurrentPreviewCanvasIntoView(root)).toBe(true);
    expect(replacement.scrollIntoView).toHaveBeenCalledOnce();
    expect(replacement.getContext().getImageData().data[3]).toBe(255);

    current = null;
    expect(scrollCurrentPreviewCanvasIntoView(root)).toBe(false);
    current = replacement;
    visibility = 'hidden';
    expect(scrollCurrentPreviewCanvasIntoView(root)).toBe(false);
    expect(replacement.scrollIntoView).toHaveBeenCalledOnce();
  });

  it('keeps matched presentation inputs bounded and distinct by scene', () => {
    for (const scene of ['Bright', 'Dark', 'Detailed'] as const) {
      const actions = MATRIX_BATCHES[`presentation${scene}`];
      expect(actions).toHaveLength(4);
      const serialized = JSON.stringify(actions);
      expect(serialized).toContain(`${scene.toUpperCase()}_PAID`);
      expect(serialized).toContain('١٬٢٣٤٬٥٦٧٫٨٩ د.إ');
      expect(serialized).toContain('windows380-emoji-missing-author');
      expect(serialized).toContain(`${scene.toUpperCase()}_STICKER`);
      expect(serialized).toContain('"width":96,"height":48');
      expect(serialized).toContain(`${scene.toUpperCase()}_MEMBERSHIP`);
      expect(serialized).toContain(`${scene.toUpperCase()}_ORDINARY`);
    }
  });

  it('uses one fitting source row for narrow and reduced-motion owners', () => {
    expect(MATRIX_BATCHES.narrow).toEqual([MATRIX_BATCHES.content[0]]);
    expect(MATRIX_BATCHES.reduced).toHaveLength(1);
    expect(JSON.stringify(MATRIX_BATCHES.reduced)).toContain('WINDOWS380_REDUCED');
  });

  it('keeps overload workload IDs distinct and within the 128-record envelope', () => {
    const ids = Object.values(OVERLOAD_BATCHES).flatMap((batch) =>
      batch.map((action) => {
        const renderer = Object.values(action.addChatItemAction.item)[0] as { id: string };
        return renderer.id;
      })
    );
    expect(ids).toHaveLength(108);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('WINDOWS380_LOAD_VACANCY_ORDINARY');
    expect(ids).toContain('WINDOWS380_LOAD_VACANCY_LATE_ORDINARY');
    expect(ids).toContain('WINDOWS380_LOAD_IMPOSSIBLE_PAID');
    expect(ids).toContain('WINDOWS380_LOAD_OVERFLOW_NEW_3');
    expect(OVERLOAD_BATCHES.vacancySeed).toHaveLength(5);
    const oldBatches = Object.entries(OVERLOAD_BATCHES).filter(([key]) =>
      key.startsWith('overflowSeed')
    );
    expect(oldBatches).toHaveLength(20);
    for (const [, batch] of oldBatches) expect(batch).toHaveLength(4);
    expect(OVERLOAD_BATCHES.overflowLate).toHaveLength(4);
    expect(ids).toContain('WINDOWS380_LOAD_OVERFLOW_OLD_79');
    const moreA = OVERLOAD_BATCHES.vacancyMoreA.map((action) => {
      const renderer = Object.values(action.addChatItemAction.item)[0] as { id: string };
      return renderer.id;
    });
    expect(moreA.slice(0, -1)).toEqual(
      expect.arrayContaining([
        'WINDOWS380_LOAD_VACANCY_MORE_A_PAID_0',
        'WINDOWS380_LOAD_VACANCY_MORE_A_PAID_3',
      ])
    );
    expect(moreA.at(-1)).toBe('WINDOWS380_LOAD_VACANCY_LATE_ORDINARY');
  });

  it('distinguishes a future ordinary reservation from waiting and visible service', () => {
    const id = 'WINDOWS380_LOAD_VACANCY_ORDINARY';
    const ingressAt = 1793465167479;
    const reservedAt = 1793465167538.3;
    const frameAt = 1793465168042.9;
    const startAt = 1793465169007.9;
    const evidence = {
      ingress: { [id]: ingressAt },
      firstEntry: {},
      pendingNow: [],
      dispositions: [{ id, kind: 'activated', atEpochMs: reservedAt }],
      activeNow: [{ id, startAtEpochMs: startAt, endAtEpochMs: startAt + 1000 }],
      frame: { startedAtEpochMs: frameAt },
    };

    expect(classifyVacancySeedOrdinary(evidence, id, true)).toBe('ordinary-reserved-future');
    expect(classifyVacancySeedOrdinary(evidence, id, false)).toBeNull();
    expect(
      classifyVacancySeedOrdinary(
        { ...evidence, pendingNow: [id], dispositions: [], activeNow: [] },
        id,
        true
      )
    ).toBe('ordinary-waiting');
    expect(
      classifyVacancySeedOrdinary({ ...evidence, firstEntry: { [id]: startAt + 20 } }, id, true)
    ).toBe('ordinary-already-served');
    expect(classifyVacancySeedOrdinary({ ...evidence, ingress: {} }, id, true)).toBeNull();
    expect(
      classifyVacancySeedOrdinary(
        { ...evidence, activeNow: [{ id, startAtEpochMs: frameAt, endAtEpochMs: startAt }] },
        id,
        true
      )
    ).toBeNull();
    expect(classifyVacancySeedOrdinary({ ...evidence, activeNow: [] }, id, true)).toBeNull();
    expect(
      classifyVacancySeedOrdinary({ ...evidence, firstEntry: { [id]: Number.NaN } }, id, true)
    ).toBeNull();
  });

  it('compares measured paid row budgets, border alpha, and actual draw without promoting reservations', () => {
    const id = 'WINDOWS380_DETAILED_PAID';
    const member = 'WINDOWS380_BRIGHT_MEMBERSHIP';
    const rect = { left: 20, top: 30, right: 120, bottom: 42 };
    const originalPlan = {
      id,
      kind: 'superchat',
      height: 100,
      maxBodyLines: 4,
      bodyRows: 2,
      bodyY: 20,
      bodyHeight: 30,
      translationRows: 2,
      translationY: 55,
      translationHeight: 30,
      borderAlpha: null,
      borderStyle: null,
    };
    const sample = {
      backend: 'worker' as const,
      sourcePrefixed: true,
      sourceHooked: true,
      canvasSourceHooked: false,
      workerReady: true,
      viewport: { width: 960, height: 540, dpr: 1 },
      overlay: { width: 960, height: 540, left: 0, top: 0 },
      frame: {
        frameId: 7,
        startedAtEpochMs: 1000,
        complete: true,
        cleared: true,
        truncated: false,
        logicalWidth: 960,
        logicalHeight: 540,
        backingRatioX: 1,
        backingRatioY: 1,
        active: [{ id, x: 10, y: 10, width: 160, height: 100 }],
        draws: [
          { id, alpha: 1, rect, section: 'body', textSnippet: 'canonical body' },
          {
            id,
            alpha: 1,
            rect: { ...rect, top: 65, bottom: 77 },
            section: 'translation',
            textSnippet: '한국어',
          },
          {
            id: member,
            alpha: 0.8,
            rect: { left: 10, top: 100, right: 80, bottom: 120 },
            section: 'body',
            textSnippet: 'membership body',
          },
        ],
        cardPlans: [
          originalPlan,
          {
            id: member,
            kind: 'membership',
            height: 90,
            maxBodyLines: 3,
            bodyRows: 1,
            bodyY: 30,
            bodyHeight: 20,
            translationRows: 0,
            translationY: null,
            translationHeight: 0,
            borderAlpha: 0.75,
            borderStyle: 'rgba(10, 20, 30, 0.75)',
          },
        ],
        config: { reducedMotion: true, ignoreReducedMotion: false },
      },
      layout: 'stacked',
      firstEntry: { [id]: 1010, [member]: 1012 },
      ingress: { [id]: 900 },
      dispositions: [],
      pendingNow: [],
      queuedNow: [],
      retained: { pending: 0, active: 2 },
      activeNow: [{ id, x: 10, y: 10, width: 160, height: 100 }],
      frames: [{ workMs: 2 }],
      drains: [{ workMs: 1, pendingBefore: 2 }],
      ink: [],
      stats: [],
      accessibility: {},
      fixtureText: {},
      measuredPlans: {},
      presentationCount: 2,
      totalPresentationUnknown: null,
      presentationCounterAvailable: true,
      overflow: 0,
    } satisfies Parameters<typeof paidRowBudget>[0];
    const emptyBeforeInput = {
      ...sample,
      frame: { ...sample.frame, active: [], draws: [] },
      firstEntry: {},
      ingress: {},
      activeNow: [],
      drains: [],
    };
    expect(() => assertBackend(emptyBeforeInput, 'worker', 'before-input')).not.toThrow();
    expect(() => assertBackend(emptyBeforeInput, 'worker')).toThrow(/drain/);
    expect(() =>
      assertBackend({ ...emptyBeforeInput, sourceHooked: false }, 'worker', 'before-input')
    ).toThrow();
    expect(() =>
      assertBackend(
        { ...emptyBeforeInput, frame: { ...emptyBeforeInput.frame, complete: false } },
        'worker',
        'before-input'
      )
    ).toThrow();
    expect(() => assertResizeSafeMotion(sample, id)).not.toThrow();
    expect(() =>
      assertResizeSafeMotion(
        {
          ...sample,
          activeNow: sample.activeNow.map((row) => ({ ...row, x: 700 })),
          frame: {
            ...sample.frame,
            active: sample.frame.active.map((row) => ({ ...row, x: 700 })),
            draws: sample.frame.draws.slice(0, 1).map((draw) => ({
              ...draw,
              rect: { left: 705, top: 30, right: 800, bottom: 42 },
            })),
          },
        },
        id
      )
    ).toThrow(/resize-safe/);
    expect(paidRowBudget(sample, id, 4).plan.translationRows).toBe(2);
    const actual10Restoration = {
      ...sample,
      backend: 'main' as const,
      frame: { ...sample.frame, startedAtEpochMs: 1793454391906.7 },
      activeNow: [{ id, x: 10, y: 10, width: 160, height: 100, startAtEpochMs: 1793454396124.4 }],
    };
    expect(planVisibleItemWait(actual10Restoration, id, 25_000).timeoutMs).toBe(9218);
    const laterMainRole = {
      ...actual10Restoration,
      activeNow: [{ id, x: 10, y: 10, width: 160, height: 100, startAtEpochMs: 1793454398199.1 }],
    };
    expect(planVisibleItemWait(laterMainRole, id, 25_000).timeoutMs).toBe(11293);
    expect(planVisibleItemWait(actual10Restoration, 'MISSING', 25_000).timeoutMs).toBe(5000);
    expect(membershipEffect(sample, member).borderAlpha).toBe(0.75);
    const bodyDraw = sample.frame.draws[0]!;
    const translationDraw = sample.frame.draws[1]!;
    for (const rejected of [
      [bodyDraw],
      [bodyDraw, { ...translationDraw, id: member }],
      [bodyDraw, { ...translationDraw, alpha: 0 }],
      [bodyDraw, { ...translationDraw, rect: { left: 970, right: 990, top: 65, bottom: 77 } }],
    ]) {
      expect(() =>
        paidRowBudget({ ...sample, frame: { ...sample.frame, draws: rejected } }, id, 4)
      ).toThrow();
    }
    expect(() =>
      paidRowBudget({ ...sample, frame: { ...sample.frame, complete: false } }, id, 4)
    ).toThrow();
    expect(() =>
      paidRowBudget(
        {
          ...sample,
          frame: {
            ...sample.frame,
            cardPlans: [{ ...originalPlan, translationRows: 3 }],
          },
        },
        id,
        4
      )
    ).toThrow(/budget/);
    expect(() =>
      paidRowBudget(
        {
          ...sample,
          frame: {
            ...sample.frame,
            draws: [
              { ...sample.frame.draws[0]!, rect: { ...rect, right: 180 } },
              sample.frame.draws[1]!,
              sample.frame.draws[2]!,
            ],
          },
        },
        id,
        4
      )
    ).toThrow(/bounds/);
    for (const spill of [
      { ...sample.frame.draws[0]!, rect: { ...rect, left: 130, right: 180 } },
      { ...sample.frame.draws[1]!, rect: { ...rect, top: 100, bottom: 120 } },
    ]) {
      expect(() =>
        paidRowBudget(
          {
            ...sample,
            frame: { ...sample.frame, draws: [...sample.frame.draws, spill] },
          },
          id,
          4
        )
      ).toThrow(/bounds/);
    }
    const oneLine = {
      ...sample,
      frame: {
        ...sample.frame,
        draws: [sample.frame.draws[0]!],
        cardPlans: [
          {
            ...originalPlan,
            maxBodyLines: 1,
            bodyRows: 1,
            translationRows: 0,
            translationY: null,
            translationHeight: 0,
          },
        ],
      },
    };
    expect(paidRowBudget(oneLine, id, 1).oneLineFallback).toBe(true);
    const supportedMinimum = resolveLimits('superChatMaxBodyLines').min;
    expect(supportedMinimum).toBe(2);
    const minimumPlan = {
      ...sample,
      frame: {
        ...sample.frame,
        cardPlans: [
          { ...originalPlan, maxBodyLines: supportedMinimum, bodyRows: 1, translationRows: 1 },
        ],
      },
    };
    expect('superChatMaxBodyLines' in minimumPlan.frame.config).toBe(false);
    expect(paidRowBudget(minimumPlan, id, supportedMinimum).translationInk).not.toBeNull();
    expect(() =>
      paidRowBudget(
        {
          ...minimumPlan,
          frame: {
            ...minimumPlan.frame,
            cardPlans: [{ ...originalPlan, maxBodyLines: 4, bodyRows: 1, translationRows: 1 }],
          },
        },
        id,
        supportedMinimum
      )
    ).toThrow();
    expect(() =>
      paidRowBudget(
        {
          ...minimumPlan,
          frame: {
            ...minimumPlan.frame,
            draws: minimumPlan.frame.draws.map((draw) =>
              draw.section === 'translation' ? { ...draw, alpha: 0 } : draw
            ),
          },
        },
        id,
        supportedMinimum
      )
    ).toThrow();
    expect(() =>
      paidRowBudget(
        { ...minimumPlan, frame: { ...minimumPlan.frame, truncated: true } },
        id,
        supportedMinimum
      )
    ).toThrow();
    expect(() =>
      paidRowBudget(
        {
          ...minimumPlan,
          frame: {
            ...minimumPlan.frame,
            cardPlans: [
              { ...originalPlan, maxBodyLines: supportedMinimum, bodyRows: 2, translationRows: 1 },
            ],
          },
        },
        id,
        supportedMinimum
      )
    ).toThrow(/budget/);
    expect(() => assertNoVisibleCardInk(sample, member)).toThrow();
    expect(() =>
      assertNoVisibleCardInk(
        {
          ...sample,
          firstEntry: {},
          frame: {
            ...sample.frame,
            draws: [],
            cardPlans: [],
          },
        },
        member
      )
    ).not.toThrow();
    const trace = overloadTrace(
      {
        ...sample,
        dispositions: [
          {
            id,
            kind: 'activated',
            reason: null,
            atEpochMs: 950,
            queueResidenceMs: 20,
            isBacklog: false,
          },
        ],
      },
      [id, 'WINDOWS380_LOAD_VACANCY_ORDINARY'],
      { active: 30, queue: 50 },
      new Set([id])
    );
    expect(trace.byKind.paid).toMatchObject({ reserved: 1, firstVisible: 1 });
    expect(trace.byKind.ordinary).toMatchObject({ reserved: 0, firstVisible: 0 });
    const lateId = 'WINDOWS380_LOAD_VACANCY_LATE_ORDINARY';
    const laterPaidId = 'WINDOWS380_LOAD_VACANCY_MORE_B_PAID_0';
    const repeated = overloadTrace(
      {
        ...sample,
        ingress: { [lateId]: 1100, [laterPaidId]: 1200 },
        firstEntry: { [lateId]: 1320, [laterPaidId]: 1280 },
        activeNow: [
          {
            id: lateId,
            x: 10,
            y: 10,
            width: 80,
            height: 30,
            startAtEpochMs: 1300,
            endAtEpochMs: 2300,
          },
          {
            id: laterPaidId,
            x: 10,
            y: 40,
            width: 120,
            height: 80,
            startAtEpochMs: 1250,
            endAtEpochMs: 2250,
          },
        ],
        dispositions: [
          {
            id: lateId,
            kind: 'activated',
            reason: null,
            atEpochMs: 1300,
            queueResidenceMs: 200,
            isBacklog: false,
          },
          {
            id: laterPaidId,
            kind: 'activated',
            reason: null,
            atEpochMs: 1250,
            queueResidenceMs: 50,
            isBacklog: false,
          },
        ],
      },
      [lateId, laterPaidId],
      { active: 30, queue: 50 },
      new Set([lateId, laterPaidId])
    );
    expect(repeated.records).toMatchObject([
      {
        id: lateId,
        kind: 'ordinary',
        rendererIngressAtEpochMs: 1100,
        reservedAtEpochMs: 1300,
        plannedStartAtEpochMs: 1300,
        firstVisibleAtEpochMs: 1320,
      },
      {
        id: laterPaidId,
        kind: 'paid',
        rendererIngressAtEpochMs: 1200,
        reservedAtEpochMs: 1250,
        plannedStartAtEpochMs: 1250,
        firstVisibleAtEpochMs: 1280,
      },
    ]);
    expect(repeated.byKind).toMatchObject({
      paid: { firstVisible: 1 },
      ordinary: { firstVisible: 1 },
    });
    const seedId = 'WINDOWS380_LOAD_VACANCY_ORDINARY';
    const futureId = 'WINDOWS380_LOAD_FUTURE_MEMBERSHIP';
    const newOverflowId = 'WINDOWS380_LOAD_OVERFLOW_NEW_0';
    const stageIds = [seedId, lateId, laterPaidId, futureId, newOverflowId];
    const stage = (delivered: string[]) =>
      overloadTrace(sample, stageIds, { active: 30, queue: 50 }, new Set(delivered));
    expect(stage([seedId]).records.map((record) => record.delivered)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(stage([seedId, lateId]).byKind.ordinary).toMatchObject({ delivered: 2 });
    expect(stage([seedId, lateId, laterPaidId]).byKind.paid).toMatchObject({ delivered: 1 });
    expect(stage([seedId, lateId, laterPaidId, futureId]).byKind.membership).toMatchObject({
      delivered: 1,
      rendererIngress: 0,
      firstVisible: 0,
    });
    const overflowBeforeLate = overloadTrace(
      sample,
      ['WINDOWS380_LOAD_OVERFLOW_OLD_0', newOverflowId],
      { active: 30, queue: 50 },
      new Set(['WINDOWS380_LOAD_OVERFLOW_OLD_0'])
    );
    expect(overflowBeforeLate.records.map((record) => record.delivered)).toEqual([true, false]);
  });

  it('retains late source-owned ink beyond 48 records and rejects omitted frame draws', async () => {
    const id = 'WINDOWS380_DETAILED_PAID';
    const body = {
      id,
      section: 'body',
      alpha: 1,
      rect: { left: 20, top: 30, right: 120, bottom: 42 },
    };
    const translation = {
      id,
      section: 'translation',
      alpha: 1,
      rect: { left: 20, top: 65, right: 120, bottom: 77 },
    };
    const spill = { ...body, rect: { left: 130, top: 30, right: 180, bottom: 42 } };
    const frame = {
      frameId: 1,
      startedAtEpochMs: 1000,
      complete: true,
      cleared: true,
      truncated: false,
      logicalWidth: 960,
      logicalHeight: 540,
      backingRatioX: 1,
      backingRatioY: 1,
      config: { reducedMotion: false, ignoreReducedMotion: false },
      active: [{ id, x: 10, y: 10, width: 160, height: 100 }],
      draws: [...Array.from({ length: 48 }, () => body), translation, spill],
      cardPlans: [
        {
          id,
          kind: 'superchat',
          height: 100,
          maxBodyLines: 4,
          bodyRows: 2,
          bodyY: 20,
          bodyHeight: 30,
          translationRows: 2,
          translationY: 55,
          translationHeight: 30,
          borderAlpha: null,
          borderStyle: null,
        },
      ],
    };
    const probe = {
      workers: [],
      latestRenderFrame: frame,
      exact: { activeNow: frame.active, config: { fontSize: 50 } },
      firstEntry: { [id]: 1001 },
      ingress: {},
    };
    let effectiveFontSize = 50;
    const sandbox = {
      window: {
        __ytPlacementProbe: probe,
        __ytChatOverlay: { getSettings: () => ({ fontSize: effectiveFontSize }) },
      },
      document: {
        querySelector: () => ({
          getBoundingClientRect: () => ({ width: 960, height: 540, left: 0, top: 0 }),
        }),
        querySelectorAll: () => [],
      },
      innerWidth: 960,
      innerHeight: 540,
      devicePixelRatio: 1,
    };
    const page = {
      evaluate: async (callback: (input: unknown) => unknown, input: unknown) =>
        runInNewContext(`(${callback.toString()})(${JSON.stringify(input)})`, sandbox),
    } as unknown as Parameters<typeof snapshot>[0];
    const observed = await snapshot(page, 'main');
    expect(resolveLimits('fontSize')).toMatchObject({ min: 14, max: 50 });
    expect(observed).toMatchObject({ effectiveFontSize: 50, probeFontSize: 50 });
    effectiveFontSize = 14;
    probe.exact.config.fontSize = 14;
    expect(await snapshot(page, 'main')).toMatchObject({
      effectiveFontSize: 14,
      probeFontSize: 14,
    });
    expect(observed.frame?.truncated).toBe(false);
    expect(observed.frame?.draws).toHaveLength(50);
    expect(observed.frame?.draws.at(-2)?.section).toBe('translation');
    expect(observed.frame?.draws.at(-1)?.rect?.right).toBe(180);
    expect(() => paidRowBudget(observed, id, 4)).toThrow(/bounds/);
    probe.latestRenderFrame = { ...frame, draws: Array.from({ length: 241 }, () => body) };
    const capped = await snapshot(page, 'main');
    expect(capped.frame?.draws).toHaveLength(240);
    expect(capped.frame?.truncated).toBe(true);
    probe.latestRenderFrame = {
      ...frame,
      active: Array.from({ length: 49 }, () => frame.active[0]!),
    };
    const activeCapped = await snapshot(page, 'main');
    expect(activeCapped.frame?.active).toHaveLength(48);
    expect(activeCapped.frame?.truncated).toBe(true);
    probe.latestRenderFrame = {
      ...frame,
      cardPlans: Array.from({ length: 25 }, () => frame.cardPlans[0]!),
    };
    const plansCapped = await snapshot(page, 'main');
    expect(plansCapped.frame?.cardPlans).toHaveLength(24);
    expect(plansCapped.frame?.truncated).toBe(true);
  });

  it('retrieves separately retained restoration frames after the earlier row expires', async () => {
    const deferredId = 'WINDOWS380_ZERO';
    const newId = 'WINDOWS380_RESTORED';
    const makeFrame = (id: string, frameId: number, startedAtEpochMs: number) => ({
      frameId,
      startedAtEpochMs,
      complete: true,
      cleared: true,
      truncated: false,
      logicalWidth: 655,
      logicalHeight: 368,
      backingRatioX: 1,
      backingRatioY: 1,
      config: { superChatLayout: 'stacked' },
      active: [{ id, x: 10, y: 10, width: 80, height: 30 }],
      draws: [{ id, alpha: 1, rect: { left: 10, top: 10, right: 90, bottom: 40 } }],
      cardPlans: [],
    });
    const earlier = makeFrame(newId, 12, 1793454387200);
    const later = makeFrame(deferredId, 24, 1793454396200);
    const probe = {
      workers: [],
      latestRenderFrame: later,
      firstCompleteFrames: {
        [`${newId}|stacked`]: earlier,
        [`${deferredId}|stacked`]: later,
      },
      firstEntry: { [newId]: 1793454387200, [deferredId]: 1793454396200 },
      exact: { config: { superChatLayout: 'stacked' }, activeNow: later.active },
    };
    const sandbox = {
      window: { __ytPlacementProbe: probe },
      document: {
        querySelector: () => ({
          getBoundingClientRect: () => ({ width: 655, height: 368, left: 0, top: 0 }),
        }),
        querySelectorAll: () => [],
      },
      innerWidth: 720,
      innerHeight: 540,
      devicePixelRatio: 1,
    };
    const page = {
      evaluate: async (callback: (input: unknown) => unknown, input: unknown) =>
        runInNewContext(`(${callback.toString()})(${JSON.stringify(input)})`, sandbox),
    } as unknown as Parameters<typeof snapshot>[0];
    const deferred = await snapshot(page, 'main', 48, { id: deferredId, layout: 'stacked' });
    const restored = await snapshot(page, 'main', 48, { id: newId, layout: 'stacked' });
    expect(restored.frame?.frameId).toBe(12);
    expect(deferred.frame?.frameId).toBe(24);
    expect(
      assertRestoredVisibility(deferred, restored, deferredId, newId, 'stacked')
    ).toMatchObject({
      deferred: { id: deferredId, frameId: 24 },
      new: { id: newId, frameId: 12 },
    });
    const wrongLayout = await snapshot(page, 'main', 48, { id: newId, layout: 'wide' });
    expect(() =>
      assertRestoredVisibility(deferred, wrongLayout, deferredId, newId, 'stacked')
    ).toThrow();
  });

  it('binds both packaged files to the controller source, core, and build identities', () => {
    const fixture = 'validation/windows/comment-display-matrix.ts';
    const bundle = {
      profile: 'yt-visual',
      installation: 'extension',
      browser: 'msedge',
      source_sha: 'a'.repeat(40),
      core_sha: 'b'.repeat(40),
      build_log_sha256: 'c'.repeat(64),
      files: [
        { file: 'validation/windows/profile.json', sha256: 'd'.repeat(64) },
        { file: 'dist-extension/page-script.js', sha256: 'e'.repeat(64) },
        { file: fixture, sha256: 'f'.repeat(64) },
      ],
    };
    expect(
      bindMatrixIdentity(bundle, 'd'.repeat(64), 'e'.repeat(64), { [fixture]: 'f'.repeat(64) })
    ).toMatchObject({
      sourceSha: 'a'.repeat(40),
      coreSha: 'b'.repeat(40),
      browser: 'msedge',
    });
    expect(() =>
      bindMatrixIdentity(bundle, '0'.repeat(64), 'e'.repeat(64), { [fixture]: 'f'.repeat(64) })
    ).toThrow();
    expect(() =>
      bindMatrixIdentity(bundle, 'd'.repeat(64), 'e'.repeat(64), { [fixture]: '0'.repeat(64) })
    ).toThrow();
    expect(() =>
      bindMatrixIdentity({ ...bundle, source_sha: 'short' }, 'd'.repeat(64), 'e'.repeat(64), {
        [fixture]: 'f'.repeat(64),
      })
    ).toThrow();
    expect(() =>
      bindMatrixIdentity(
        { ...bundle, files: [...bundle.files, bundle.files[0]] },
        'd'.repeat(64),
        'e'.repeat(64),
        { [fixture]: 'f'.repeat(64) }
      )
    ).toThrow();
  });

  it('rejects allocation, zero alpha, incomplete, and off-viewport draws', () => {
    const id = 'WINDOWS380_COMBINING';
    const snapshot = {
      backend: 'worker',
      sourcePrefixed: true,
      sourceHooked: true,
      canvasSourceHooked: false,
      workerReady: true,
      viewport: { width: 960, height: 540, dpr: 2 },
      overlay: { width: 960, height: 540, left: 0, top: 0 },
      layout: 'stacked',
      firstEntry: { [id]: 1000 },
      frame: {
        frameId: 1,
        startedAtEpochMs: 1000,
        complete: true,
        cleared: true,
        truncated: false,
        logicalWidth: 960,
        logicalHeight: 540,
        backingRatioX: 2,
        backingRatioY: 2,
        active: [{ id, x: 10, y: 10, width: 80, height: 30 }],
        draws: [{ id, alpha: 1, rect: { left: 10, top: 10, right: 90, bottom: 40 } }],
        cardPlans: [],
        config: { reducedMotion: false, ignoreReducedMotion: false },
      },
      ingress: {},
      dispositions: [],
      pendingNow: [],
      queuedNow: [],
      retained: null,
      activeNow: [],
      frames: [],
      drains: [],
      ink: [],
      stats: [],
      accessibility: {},
      fixtureText: {},
      measuredPlans: {},
      presentationCount: 1,
      totalPresentationUnknown: null,
      presentationCounterAvailable: true,
      overflow: 0,
    } satisfies Parameters<typeof assertCoherentVisibleFrame>[0];
    expect(assertCoherentVisibleFrame(snapshot, id).alpha).toBe(1);
    expect(
      flowTrace({
        ...snapshot,
        ingress: { [id]: 900, WINDOWS380_PENDING: 950 },
        dispositions: [
          {
            id,
            kind: 'activated',
            reason: null,
            atEpochMs: 990,
            queueResidenceMs: 40,
            isBacklog: false,
          },
          {
            id: 'WINDOWS380_PENDING',
            kind: 'activated',
            reason: null,
            atEpochMs: 1000,
            queueResidenceMs: 20,
            isBacklog: false,
          },
          {
            id,
            kind: 'completed',
            reason: 'expired-duration',
            atEpochMs: 1500,
            queueResidenceMs: null,
            isBacklog: false,
          },
        ],
      }).records
    ).toMatchObject([
      {
        id,
        queuedAtEpochMs: 950,
        reservedAtEpochMs: 990,
        firstVisibleAtEpochMs: 1000,
        firstVisibleDelayMs: 100,
        completedAtEpochMs: 1500,
      },
      {
        id: 'WINDOWS380_PENDING',
        reservedAtEpochMs: 1000,
        firstVisibleAtEpochMs: null,
        firstVisibleDelayMs: null,
      },
    ]);
    expect(
      presentationGeometry(
        {
          ...snapshot,
          activeNow: [
            {
              id,
              x: 10,
              y: 10,
              width: 80,
              height: 30,
              actualVelocityPxPerMs: 0.25,
            },
          ],
        },
        id
      )
    ).toMatchObject({
      visibleFraction: 1,
      partialVisibility: false,
      actualSpeedPxPerSec: 250,
      fullCardExposureMs: 3520,
      firstVisibleAtEpochMs: 1000,
    });
    const restored = 'WINDOWS380_RESTORED';
    const restoredEndAt = 1793454395137.1;
    const deferredStartAt = 1793454396124.4;
    expect(restoredEndAt).toBeLessThan(deferredStartAt);
    const deferredRow = { id, x: 10, y: 10, width: 80, height: 30 };
    const newRow = { ...deferredRow, id: restored };
    const deferredFrame = {
      ...snapshot,
      frame: {
        ...snapshot.frame,
        frameId: 3,
        startedAtEpochMs: 1793454396200,
        active: [deferredRow],
      },
      activeNow: [deferredRow],
      firstEntry: { [id]: 1793454396200 },
    };
    const newFrame = {
      ...snapshot,
      frame: {
        ...snapshot.frame,
        frameId: 2,
        startedAtEpochMs: 1793454387200,
        active: [newRow],
        draws: [{ id: restored, alpha: 1, rect: { left: 10, top: 10, right: 90, bottom: 40 } }],
      },
      activeNow: [newRow],
      firstEntry: { [restored]: 1793454387200 },
    };
    expect(
      assertRestoredVisibility(deferredFrame, newFrame, id, restored, 'stacked')
    ).toMatchObject({
      deferred: { id, frameId: 3, ink: { alpha: 1 } },
      new: { id: restored, frameId: 2, ink: { alpha: 1 } },
    });
    expect(() =>
      assertRestoredVisibility(
        deferredFrame,
        { ...newFrame, firstEntry: {} },
        id,
        restored,
        'stacked'
      )
    ).toThrow();
    expect(() =>
      assertRestoredVisibility(
        deferredFrame,
        { ...newFrame, frame: { ...newFrame.frame, draws: [] } },
        id,
        restored,
        'stacked'
      )
    ).toThrow();
    expect(() =>
      assertRestoredVisibility(
        deferredFrame,
        {
          ...newFrame,
          frame: {
            ...newFrame.frame,
            draws: newFrame.frame.draws.map((draw) => ({ ...draw, alpha: 0 })),
          },
        },
        id,
        restored,
        'stacked'
      )
    ).toThrow();
    expect(() =>
      assertRestoredVisibility(
        deferredFrame,
        { ...newFrame, frame: { ...newFrame.frame, complete: false } },
        id,
        restored,
        'stacked'
      )
    ).toThrow();
    expect(() =>
      assertRestoredVisibility(
        deferredFrame,
        { ...newFrame, layout: 'wide' },
        id,
        restored,
        'stacked'
      )
    ).toThrow();
    expect(() =>
      assertRestoredVisibility(
        deferredFrame,
        { ...newFrame, backend: 'main' },
        id,
        restored,
        'stacked'
      )
    ).toThrow();
    expect(() => assertCoherentVisibleFrame({ ...snapshot, firstEntry: {} }, id)).toThrow();
    expect(() =>
      assertCoherentVisibleFrame(
        { ...snapshot, frame: { ...snapshot.frame!, complete: false } },
        id
      )
    ).toThrow();
    const committed = {
      ...snapshot,
      activeNow: [{ id, x: 10, y: 10, width: 80, height: 30 }],
    };
    const fullHistory = {
      ...committed,
      backend: 'main' as const,
      ink: Array.from({ length: 48 }, () => ({
        id: 'WINDOWS380_OTHER',
        left: 0,
        top: 0,
        right: 1,
        bottom: 1,
        kind: 'text',
      })),
    };
    expect(assertOwnedContentInk(fullHistory, id).id).toBe(id);
    for (const draw of [
      { ...snapshot.frame.draws[0]!, id: 'WINDOWS380_OTHER' },
      { ...snapshot.frame.draws[0]!, alpha: 0 },
      { ...snapshot.frame.draws[0]!, rect: { left: 970, top: 10, right: 990, bottom: 40 } },
      { ...snapshot.frame.draws[0]!, rect: { left: 10, top: 10, right: 10, bottom: 40 } },
    ])
      expect(() =>
        assertOwnedContentInk(
          {
            ...fullHistory,
            frame: { ...snapshot.frame, draws: [draw] },
          },
          id
        )
      ).toThrow();
    expect(() =>
      assertOwnedContentInk(
        {
          ...fullHistory,
          frame: { ...snapshot.frame, truncated: true },
        },
        id
      )
    ).toThrow();
    expect(assertCommittedVisibleItem(committed, id).row.width).toBe(80);
    expect(() => assertCommittedVisibleItem({ ...committed, activeNow: [] }, id)).toThrow();
    expect(() =>
      assertCommittedVisibleItem(
        { ...committed, activeNow: [{ id, x: 970, y: 10, width: 80, height: 30 }] },
        id
      )
    ).toThrow(/viewport overlap/);
    expect(() => presentationItem(committed, id, 'sticker')).toThrow(/Sticker lacks/);
    expect(() => presentationItem(committed, id, 'ordinary')).toThrow(/active source row/);
    expect(
      presentationItem(
        {
          ...committed,
          frame: {
            ...committed.frame!,
            draws: [{ ...committed.frame!.draws[0]!, section: 'regular' }],
          },
        },
        id,
        'ordinary'
      ).id
    ).toBe(id);
    expect(
      presentationItem(
        {
          ...committed,
          frame: {
            ...committed.frame!,
            draws: [{ ...committed.frame!.draws[0]!, kind: 'sticker-image' }],
          },
        },
        id,
        'sticker'
      ).alpha
    ).toBe(1);
    expect(() =>
      assertCoherentVisibleFrame({ ...snapshot, frame: { ...snapshot.frame!, draws: [] } }, id)
    ).toThrow();
    expect(() =>
      assertCoherentVisibleFrame(
        {
          ...snapshot,
          frame: {
            ...snapshot.frame!,
            draws: [{ id, alpha: 0, rect: { left: 10, top: 10, right: 90, bottom: 40 } }],
          },
        },
        id
      )
    ).toThrow();
    expect(() =>
      assertCoherentVisibleFrame(
        {
          ...snapshot,
          frame: {
            ...snapshot.frame!,
            draws: [{ id, alpha: 1, rect: { left: 970, top: 10, right: 990, bottom: 40 } }],
          },
        },
        id
      )
    ).toThrow();
  });
});
