// SPDX-License-Identifier: MIT

import type { ChatMessage } from '@app-types';
import type { OverlaySettings } from '@app-types';
import { RenderWorkerManager } from '@renderer/worker/manager';
import { DEFAULT_SETTINGS } from '@settings/schema';
import type { ObservabilityReporter } from '@util/observability';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const makeMessage = (id: string, kind: ChatMessage['kind']): ChatMessage => ({
  id,
  kind,
  text: id,
  content: [{ type: 'text', content: id }],
  timestamp: 0,
  author: id,
  authorType: 'normal',
});

describe('WorkerManager saturated ingress', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([50, 80])(
    'passes four fresh ordinary messages through real Worker receipts after %i old messages',
    async (oldCount) => {
      const receipts: Array<Record<string, unknown>> = [];
      vi.stubGlobal('self', {
        postMessage: (message: Record<string, unknown>) => receipts.push(message),
      });
      const { WorkerRenderer } = await import('@renderer/worker/renderer');
      const renderer = new WorkerRenderer();
      const workerState = renderer as unknown as {
        config: { queueMaxSize: number };
        animFrameId: number | null;
        pendingQueue: Array<{ id: string }>;
        totalDrops: number;
        dropReasons: { queue_replaced: number };
        measureMessageGeometry: ReturnType<typeof vi.fn>;
      };
      workerState.config = { queueMaxSize: 50 };
      workerState.animFrameId = 1;
      workerState.measureMessageGeometry = vi.fn(() => ({ width: 80, height: 20 }));
      const manager = new RenderWorkerManager({
        settings: { queueMaxSize: 50, maxConcurrentMessages: 30 } as OverlaySettings,
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
      const sent: Array<Record<string, unknown>> = [];
      const sentHistory: Array<Record<string, unknown>> = [];
      const receiptHistory: Array<Record<string, unknown>> = [];
      const managerState = manager as unknown as {
        worker: Worker | null;
        applyBatchReceipt: (receipt: Record<string, unknown>) => void;
        deferredIngress: Array<{ id: string }>;
        latestWorkerPendingDepth: number;
        minimumWorkerPendingPriority: number | null;
        unacknowledgedBatches: Map<number, unknown>;
      };
      managerState.worker = {
        postMessage: (message: Record<string, unknown>) => sent.push(message),
      } as unknown as Worker;
      manager.setActive(true);
      const pump = async () => {
        await Promise.resolve();
        while (sent.length > 0 || receipts.length > 0) {
          const posted = sent.shift();
          if (posted) {
            sentHistory.push(posted);
            renderer.handleMessage(new MessageEvent('message', { data: posted }));
          }
          while (receipts.length > 0) {
            const receipt = receipts.shift();
            if (receipt?.type === 'batchReceipt') {
              receiptHistory.push(receipt);
              managerState.applyBatchReceipt(receipt);
            }
          }
          await Promise.resolve();
        }
      };
      for (let i = 0; i < oldCount; i++)
        expect(manager.sendToWorker(makeMessage(`old-${i}`, 'text'))).toBe(true);
      await pump();
      expect(
        sentHistory
          .flatMap((batch) => (batch.messages as Array<{ id: string }>).map((entry) => entry.id))
          .filter((id) => id.startsWith('old-'))
      ).toHaveLength(oldCount);
      expect(managerState.latestWorkerPendingDepth).toBe(50);
      expect(managerState.minimumWorkerPendingPriority).toBe(0);
      expect(managerState.unacknowledgedBatches.size).toBe(0);
      expect(managerState.deferredIngress).toHaveLength(0);
      for (let i = 0; i < 4; i++)
        expect(manager.sendToWorker(makeMessage(`new-${i}`, 'text'))).toBe(true);
      await pump();
      expect(workerState.pendingQueue).toHaveLength(50);
      expect(
        sentHistory
          .flatMap((batch) => (batch.messages as Array<{ id: string }>).map((entry) => entry.id))
          .filter((id) => id.startsWith('new-'))
      ).toEqual(['new-0', 'new-1', 'new-2', 'new-3']);
      expect(receiptHistory.slice(-4).map((receipt) => receipt.admittedMessages)).toEqual([
        1, 1, 1, 1,
      ]);
      expect(workerState.pendingQueue.slice(0, 4).map((entry) => entry.id)).toEqual(
        Array.from({ length: 4 }, (_, index) => `old-${oldCount - 46 + index}`)
      );
      expect(workerState.pendingQueue.slice(-4).map((entry) => entry.id)).toEqual([
        'new-0',
        'new-1',
        'new-2',
        'new-3',
      ]);
      expect(workerState.totalDrops).toBe(oldCount - 50 + 4);
      expect(workerState.dropReasons.queue_replaced).toBe(oldCount - 50 + 4);
      const staleBatch = sentHistory.at(-1);
      if (!staleBatch) throw new Error('Missing last Worker batch');
      renderer.handleMessage(
        new MessageEvent('message', {
          data: { type: 'clearState', epoch: 1 },
        })
      );
      expect(workerState.pendingQueue).toHaveLength(0);
      const receiptCount = receipts.length;
      renderer.handleMessage(
        new MessageEvent('message', {
          data: { ...staleBatch, epoch: 0 },
        })
      );
      expect(workerState.pendingQueue).toHaveLength(0);
      expect(receipts).toHaveLength(receiptCount);
      expect(managerState.deferredIngress).toHaveLength(0);
      managerState.worker = null;
      manager.destroy();
    }
  );

  it('evicts the four oldest ordinary IDs from a full Manager buffer and drains survivors in FIFO order', async () => {
    const receipts: Array<Record<string, unknown>> = [];
    vi.stubGlobal('self', {
      postMessage: (message: Record<string, unknown>) => receipts.push(message),
    });
    const { WorkerRenderer } = await import('@renderer/worker/renderer');
    const renderer = new WorkerRenderer();
    const workerState = renderer as unknown as {
      config: { queueMaxSize: number };
      animFrameId: number | null;
      pendingQueue: Array<{ id: string }>;
      measureMessageGeometry: ReturnType<typeof vi.fn>;
      postCapacityReceipt: () => void;
    };
    workerState.config = { queueMaxSize: 50 };
    workerState.animFrameId = 1;
    workerState.measureMessageGeometry = vi.fn(() => ({ width: 80, height: 20 }));

    const dropped = vi.fn();
    const manager = new RenderWorkerManager({
      settings: { ...DEFAULT_SETTINGS, queueMaxSize: 50, maxConcurrentMessages: 30 },
      observability: {
        onMessageDropped: dropped,
        updateActiveMessages: vi.fn(),
        updateQueueDepth: vi.fn(),
        updateLaneUtilization: vi.fn(),
      } as unknown as ObservabilityReporter,
      estimateDimensions: () => ({ width: 80, height: 20 }),
      getMessagePriority: (message) => (message.kind === 'superchat' ? 200 : 0),
      getEffectiveSpeedPxPerSec: () => 100,
    });
    const sent: Array<Record<string, unknown>> = [];
    const sentIds: string[] = [];
    const managerState = manager as unknown as {
      worker: Worker | null;
      applyBatchReceipt: (receipt: Record<string, unknown>) => void;
      deferredIngress: Array<{ id: string }>;
      latestWorkerPendingDepth: number;
      minimumWorkerPendingPriority: number | null;
      unacknowledgedBatches: Map<number, unknown>;
    };
    managerState.worker = {
      postMessage: (message: Record<string, unknown>) => sent.push(message),
    } as unknown as Worker;
    manager.setActive(true);
    const pump = async () => {
      await Promise.resolve();
      while (sent.length > 0 || receipts.length > 0) {
        const posted = sent.shift();
        if (posted) {
          sentIds.push(...(posted.messages as Array<{ id: string }>).map((entry) => entry.id));
          renderer.handleMessage(new MessageEvent('message', { data: posted }));
        }
        while (receipts.length > 0) {
          const receipt = receipts.shift();
          if (receipt?.type === 'batchReceipt') managerState.applyBatchReceipt(receipt);
        }
        await Promise.resolve();
      }
    };

    for (let index = 0; index < 50; index++)
      expect(manager.sendToWorker(makeMessage(`paid-${index}`, 'superchat'))).toBe(true);
    await pump();
    expect(workerState.pendingQueue).toHaveLength(50);
    expect(managerState.latestWorkerPendingDepth).toBe(50);
    expect(managerState.minimumWorkerPendingPriority).toBe(200);
    expect(managerState.unacknowledgedBatches.size).toBe(0);

    for (let index = 0; index < 80; index++)
      expect(manager.sendToWorker(makeMessage(`old-${index}`, 'text'))).toBe(true);
    expect(managerState.deferredIngress.map((entry) => entry.id)).toEqual(
      Array.from({ length: 80 }, (_, index) => `old-${index}`)
    );
    expect(sent).toHaveLength(0);
    expect(dropped).not.toHaveBeenCalled();
    for (let index = 0; index < 4; index++)
      expect(manager.sendToWorker(makeMessage(`new-${index}`, 'text'))).toBe(true);
    expect(managerState.deferredIngress.map((entry) => entry.id)).toEqual([
      ...Array.from({ length: 76 }, (_, index) => `old-${index + 4}`),
      'new-0',
      'new-1',
      'new-2',
      'new-3',
    ]);
    expect(managerState.deferredIngress).toHaveLength(80);
    expect(dropped).toHaveBeenCalledTimes(4);
    expect(dropped).toHaveBeenCalledWith('worker_backpressure');
    expect(sent).toHaveLength(0);

    // A real WorkerRenderer receipt reports the vacancy created by a completed
    // paid cohort. The Manager must send the retained ordinary rows in order.
    workerState.pendingQueue.splice(0);
    workerState.postCapacityReceipt();
    await pump();
    expect(managerState.deferredIngress).toHaveLength(0);
    expect(managerState.unacknowledgedBatches.size).toBe(0);
    expect(sentIds.filter((id) => id.startsWith('old-') || id.startsWith('new-'))).toEqual([
      ...Array.from({ length: 76 }, (_, index) => `old-${index + 4}`),
      'new-0',
      'new-1',
      'new-2',
      'new-3',
    ]);
    expect(workerState.pendingQueue).toHaveLength(50);
    expect(dropped).toHaveBeenCalledTimes(4);
    managerState.worker = null;
    manager.destroy();
  });

  it('uses its existing bounded deferred buffer for one ordinary service opportunity', () => {
    const dropped = vi.fn();
    const manager = new RenderWorkerManager({
      settings: { queueMaxSize: 2, maxConcurrentMessages: 1 } as OverlaySettings,
      observability: {
        onMessageDropped: dropped,
        updateActiveMessages: vi.fn(),
        updateQueueDepth: vi.fn(),
        updateLaneUtilization: vi.fn(),
      } as unknown as ObservabilityReporter,
      estimateDimensions: () => ({ width: 80, height: 20 }),
      estimateTranslatedDimensions: () => ({ width: 80, height: 20, translationHeight: 0 }),
      getMessagePriority: (message) => (message.kind === 'superchat' ? 200 : 0),
      getEffectiveSpeedPxPerSec: () => 100,
    });
    const internals = manager as unknown as {
      worker: Worker | null;
      latestWorkerPendingDepth: number;
      minimumWorkerPendingPriority: number | null;
      deferredIngress: Array<{ id: string; priority: number }>;
      prepareMessageForBatch: ReturnType<typeof vi.fn>;
      drainDeferredIngress(): void;
    };
    internals.worker = { postMessage: vi.fn() } as unknown as Worker;
    manager.setActive(true);
    internals.latestWorkerPendingDepth = 2;
    internals.minimumWorkerPendingPriority = 200;
    expect(manager.sendToWorker(makeMessage('paid-0', 'superchat'))).toBe(true);
    expect(manager.sendToWorker(makeMessage('paid-1', 'superchat'))).toBe(true);
    expect(manager.sendToWorker(makeMessage('paid-2', 'superchat'))).toBe(true);
    expect(manager.sendToWorker(makeMessage('ordinary-old', 'text'))).toBe(true);
    expect(internals.deferredIngress.map((entry) => entry.id)).toEqual([
      'paid-1',
      'paid-2',
      'ordinary-old',
    ]);
    expect(manager.sendToWorker(makeMessage('ordinary-new', 'text'))).toBe(true);
    expect(internals.deferredIngress.map((entry) => entry.id)).toContain('ordinary-new');
    expect(internals.deferredIngress).toHaveLength(3);
    expect(dropped).toHaveBeenCalledTimes(2);

    internals.prepareMessageForBatch = vi.fn(() => true);
    internals.latestWorkerPendingDepth = 1;
    internals.drainDeferredIngress();
    expect(internals.prepareMessageForBatch.mock.calls.map(([_message, id]) => id)).toEqual([
      'paid-1',
      'paid-2',
      'ordinary-new',
    ]);
    expect(internals.deferredIngress).toHaveLength(0);
    internals.worker = null;
    manager.destroy();
  });

  it('dispatches eligible paid displacement while holding ordinary for a real vacancy', () => {
    const manager = new RenderWorkerManager({
      settings: { queueMaxSize: 2, maxConcurrentMessages: 1 } as OverlaySettings,
      observability: {
        onMessageDropped: vi.fn(),
        updateActiveMessages: vi.fn(),
        updateQueueDepth: vi.fn(),
        updateLaneUtilization: vi.fn(),
      } as unknown as ObservabilityReporter,
      estimateDimensions: () => ({ width: 80, height: 20 }),
      estimateTranslatedDimensions: () => ({ width: 80, height: 20, translationHeight: 0 }),
      getMessagePriority: (message) => (message.kind === 'superchat' ? 200 : 0),
      getEffectiveSpeedPxPerSec: () => 100,
    });
    const internals = manager as unknown as {
      worker: Worker | null;
      latestWorkerPendingDepth: number;
      minimumWorkerPendingPriority: number | null;
      higherPriorityIngressDispatches: number;
      deferredIngress: Array<{ id: string; priority: number }>;
      hasSaturationProbeInFlight: ReturnType<typeof vi.fn>;
      prepareMessageForBatch: ReturnType<typeof vi.fn>;
      drainDeferredIngress(): void;
    };
    internals.worker = { postMessage: vi.fn() } as unknown as Worker;
    manager.setActive(true);
    internals.latestWorkerPendingDepth = 2;
    internals.minimumWorkerPendingPriority = 100;
    internals.hasSaturationProbeInFlight = vi.fn(() => true);
    expect(manager.sendToWorker(makeMessage('paid', 'superchat'))).toBe(true);
    expect(manager.sendToWorker(makeMessage('ordinary', 'text'))).toBe(true);
    expect(internals.deferredIngress.map((entry) => entry.id)).toEqual(['paid', 'ordinary']);

    internals.higherPriorityIngressDispatches = 2;
    internals.hasSaturationProbeInFlight = vi.fn(() => false);
    internals.prepareMessageForBatch = vi.fn(() => true);
    internals.drainDeferredIngress();
    expect(internals.prepareMessageForBatch.mock.calls.map(([_message, id]) => id)).toEqual([
      'paid',
    ]);
    expect(internals.deferredIngress.map((entry) => entry.id)).toEqual(['ordinary']);
    expect(internals.higherPriorityIngressDispatches).toBe(2);

    internals.latestWorkerPendingDepth = 1;
    internals.drainDeferredIngress();
    expect(internals.prepareMessageForBatch.mock.calls.map(([_message, id]) => id)).toEqual([
      'paid',
      'ordinary',
    ]);
    expect(internals.higherPriorityIngressDispatches).toBe(0);
    internals.worker = null;
    manager.destroy();
  });
});
