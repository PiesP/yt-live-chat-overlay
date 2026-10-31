// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { runInNewContext, Script } from 'node:vm';

import type { ChatMessage, OverlaySettings } from '@app-types';
import { RenderWorkerManager } from '@renderer/worker/manager';
import type { ObservabilityReporter } from '@util/observability';
import { describe, expect, it, vi } from 'vite-plus/test';

import {
  assertBackend,
  assertCoherentVisibleFrame,
  assertCommittedVisibleItem,
  assertNoVisibleCardInk,
  assertPreviewComparison,
  assertResizeSafeMotion,
  assertRestoredVisibility,
  attachWorkerManagerProbe,
  bindMatrixIdentity,
  classifyMatrixRuntime,
  classifyPlanProbeCapability,
  flowTrace,
  instrumentWorkerManagerPageScript,
  MATRIX_BATCHES,
  membershipEffect,
  OVERLOAD_BATCHES,
  overloadTrace,
  paidRowBudget,
  presentationItem,
  presentationGeometry,
  snapshot,
  validateMatrixMode,
} from '../../../validation/windows/comment-display-matrix.ts';

const source = MATRIX_BATCHES.content.map(
  (action) => Object.values(action.addChatItemAction.item)[0]
);

describe('Windows comment display matrix contract', () => {
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
      exact: { activeNow: frame.active },
      firstEntry: { [id]: 1001 },
      ingress: {},
    };
    const sandbox = {
      window: { __ytPlacementProbe: probe },
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
    expect(() => assertRestoredVisibility(snapshot, id, restored)).toThrow();
    expect(() =>
      assertRestoredVisibility(
        {
          ...snapshot,
          firstEntry: { ...snapshot.firstEntry, [restored]: 1001 },
          frame: {
            ...snapshot.frame!,
            draws: [
              ...snapshot.frame!.draws,
              { id: restored, alpha: 1, rect: { left: 100, top: 10, right: 180, bottom: 40 } },
            ],
          },
        },
        id,
        restored
      )
    ).not.toThrow();
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
