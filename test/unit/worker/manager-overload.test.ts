// SPDX-License-Identifier: MIT

import type { ChatMessage } from '@app-types';
import type { OverlaySettings } from '@app-types';
import { RenderWorkerManager } from '@renderer/worker/manager';
import type { ObservabilityReporter } from '@util/observability';
import { describe, expect, it, vi } from 'vite-plus/test';

const makeMessage = (id: string, kind: ChatMessage['kind']): ChatMessage => ({
  id,
  kind,
  text: id,
  content: [{ type: 'text', content: id }],
  timestamp: 0,
  authorType: 'normal',
});

describe('WorkerManager saturated ingress', () => {
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
