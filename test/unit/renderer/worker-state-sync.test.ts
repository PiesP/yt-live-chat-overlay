// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RenderWorkerManager } from '@renderer/worker/manager';
import {
  isValidControlMessage,
  isValidWorkerStatsMessage,
} from '@renderer/worker/protocol-guards';
import { WorkerRenderer } from '@renderer/worker/renderer';
import type { WorkerMessage, WorkerStatsMessage } from '@renderer/worker/types';
import { DEFAULT_SETTINGS } from '@settings/schema';

const context = {
  setTransform: vi.fn(),
  getTransform: vi.fn(() => ({ a: 1 })),
  scale: vi.fn(),
  clearRect: vi.fn(),
  measureText: vi.fn(() => ({
    width: 100,
    actualBoundingBoxAscent: 16,
    actualBoundingBoxDescent: 4,
  })),
  fillText: vi.fn(),
  fillRect: vi.fn(),
  strokeText: vi.fn(),
  strokeRect: vi.fn(),
  drawImage: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  translate: vi.fn(),
  beginPath: vi.fn(),
  closePath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  arc: vi.fn(),
  arcTo: vi.fn(),
  fill: vi.fn(),
  stroke: vi.fn(),
  clip: vi.fn(),
  createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  font: '',
  textBaseline: 'top',
  textAlign: 'left',
  textRendering: 'optimizeSpeed',
  fontKerning: 'none',
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  globalAlpha: 1,
  filter: 'none',
  imageSmoothingEnabled: true,
};

class TestOffscreenCanvas {
  constructor(
    public width = 640,
    public height = 360
  ) {}

  getContext(): typeof context {
    return context;
  }
}

class TestWorker {
  static instances: TestWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: OnErrorEventHandler = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
  private readonly listeners = new Map<string, EventListener>();

  constructor() {
    TestWorker.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  acknowledgeDestroy(): void {
    this.listeners.get('message')?.({ data: { type: 'ack' } } as MessageEvent);
  }
}

vi.stubGlobal('OffscreenCanvas', TestOffscreenCanvas);
vi.stubGlobal('ImageBitmap', class {
  close(): void {}
});
vi.stubGlobal('Worker', TestWorker);
const scheduledAnimationFrames: FrameRequestCallback[] = [];
vi.stubGlobal(
  'requestAnimationFrame',
  vi.fn((callback: FrameRequestCallback) => {
    scheduledAnimationFrames.push(callback);
    return scheduledAnimationFrames.length;
  })
);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

const postMessage = vi.fn();
Object.defineProperty(self, 'postMessage', {
  value: postMessage,
  writable: true,
  configurable: true,
});

function validStats(): Record<string, unknown> {
  return {
    type: 'stats',
    activeMessages: 2,
    pendingQueueDepth: 1,
    totalRendered: 5,
    totalDrops: 3,
    processedBatchSequence: 0,
    laneUtilization: 0.5,
    activeMessageIds: ['active-1', 'active-2'],
    pendingMessageIds: ['pending-1'],
  };
}

function makeWorkerMessage(id: string, height = 20): WorkerMessage {
  return {
    id,
    text: `message ${id}`,
    width: 100,
    height,
    priority: 0,
    isBacklog: false,
    content: [{ type: 'text', content: `message ${id}` }],
  };
}

function initializedRenderer(): WorkerRenderer {
  const renderer = new WorkerRenderer();
  renderer.handleMessage({
    data: {
      type: 'init',
      canvas: new TestOffscreenCanvas(),
      config: {
        ...RenderWorkerManager.buildWorkerConfig(DEFAULT_SETTINGS),
        queueMaxSize: 50,
      },
      width: 640,
      height: 360,
      dpr: 1,
    },
  } as MessageEvent);
  postMessage.mockClear();
  return renderer;
}

function latestStats(): WorkerStatsMessage | undefined {
  return postMessage.mock.calls
    .map(([message]) => message as unknown)
    .filter(isValidWorkerStatsMessage)
    .at(-1);
}

function initializedManager() {
  const observability = {
    onMessageDropped: vi.fn(),
    onMessagesDropped: vi.fn(),
    onMessagesRendered: vi.fn(),
    updateActiveMessages: vi.fn(),
    updateQueueDepth: vi.fn(),
    updateLaneUtilization: vi.fn(),
    tick: vi.fn(),
  };
  const onStats = vi.fn();
  const manager = new RenderWorkerManager({
    settings: DEFAULT_SETTINGS,
    observability,
    imageFetchManager: {
      workerBitmapCache: {
        take: vi.fn(),
        delete: vi.fn(),
        clear: vi.fn(),
      },
    },
    estimateDimensions: () => ({ width: 100, height: 20 }),
    getMessagePriority: () => 0,
    getEffectiveSpeedPxPerSec: () => DEFAULT_SETTINGS.speedPxPerSec,
    onStats,
  } as unknown as ConstructorParameters<typeof RenderWorkerManager>[0]);
  const canvas = {
    width: 0,
    height: 0,
    transferControlToOffscreen: () => new TestOffscreenCanvas(),
  } as unknown as HTMLCanvasElement;
  const overlay = {
    getDimensions: () => ({ width: 640, height: 360 }),
    onDimensionsChanged: () => vi.fn(),
  };

  expect(manager.init(canvas, DEFAULT_SETTINGS, overlay as never, 'worker.js').started).toBe(true);
  const worker = TestWorker.instances.at(-1);
  if (!worker) throw new Error('Worker was not created');
  return { manager, observability, onStats, worker };
}

describe('Worker renderer state synchronization', () => {
  beforeEach(() => {
    postMessage.mockClear();
    TestWorker.instances.length = 0;
    scheduledAnimationFrames.length = 0;
  });

  it('accepts only bounded, finite Worker stats', () => {
    expect(isValidWorkerStatsMessage(validStats())).toBe(true);

    for (const invalid of [
      { ...validStats(), totalRendered: -1 },
      { ...validStats(), totalDrops: Number.NaN },
      { ...validStats(), laneUtilization: 1.1 },
      { ...validStats(), activeMessageIds: [''] },
      { ...validStats(), pendingMessageIds: [1] },
    ]) {
      expect(isValidWorkerStatsMessage(invalid)).toBe(false);
    }
  });

  it('accepts only positive safe batch sequence watermarks', () => {
    const message = makeWorkerMessage('sequence');
    expect(
      isValidControlMessage({ type: 'addMessages', messages: [message], batchSequence: 1 })
    ).toBe(true);
    expect(
      isValidControlMessage({ type: 'addMessages', messages: [message], batchSequence: 0 })
    ).toBe(false);
    expect(
      isValidControlMessage({
        type: 'addMessages',
        messages: [message],
        batchSequence: Number.POSITIVE_INFINITY,
      })
    ).toBe(false);
  });

  it('reports actual placements and live lane utilization', () => {
    const renderer = initializedRenderer();
    renderer.handleMessage({
      data: {
        type: 'addMessages',
        messages: [makeWorkerMessage('rendered')],
        batchSequence: 7,
      },
    } as MessageEvent);

    const internals = renderer as unknown as { renderFrame(): void };
    for (let frame = 0; frame < 60; frame++) internals.renderFrame();

    expect(latestStats()).toMatchObject({
      totalRendered: 1,
      totalDrops: 0,
      processedBatchSequence: 7,
      activeMessages: 1,
      pendingQueueDepth: 0,
    });
    expect(latestStats()?.laneUtilization).toBeGreaterThan(0);
  });

  it('counts every message permanently discarded by queue overflow', () => {
    const renderer = initializedRenderer();
    renderer.handleMessage({
      data: {
        type: 'addMessages',
        messages: Array.from({ length: 51 }, (_, index) => makeWorkerMessage(`queued-${index}`)),
      },
    } as MessageEvent);

    const internals = renderer as unknown as { renderFrame(): void };
    for (let frame = 0; frame < 60; frame++) internals.renderFrame();

    expect(latestStats()?.totalDrops).toBe(1);
  });

  it('does not report replay overflow or oversized work as observed drops', () => {
    const renderer = initializedRenderer();
    renderer.handleMessage({
      data: {
        type: 'addMessages',
        messages: Array.from({ length: 51 }, (_, index) => ({
          ...makeWorkerMessage(`replay-${index}`, 10_000),
          trackDrops: false,
        })),
      },
    } as MessageEvent);

    const internals = renderer as unknown as { renderFrame(): void };
    for (let frame = 0; frame < 60; frame++) internals.renderFrame();

    expect(latestStats()?.totalDrops).toBe(0);
  });

  it('attributes queue displacement to the message that was actually discarded', () => {
    const untrackedQueue = initializedRenderer();
    untrackedQueue.handleMessage({
      data: {
        type: 'addMessages',
        messages: Array.from({ length: 50 }, (_, index) => ({
          ...makeWorkerMessage(`untracked-${index}`),
          trackDrops: false,
        })),
      },
    } as MessageEvent);
    untrackedQueue.handleMessage({
      data: {
        type: 'addMessages',
        messages: [{ ...makeWorkerMessage('tracked-high'), priority: 100, trackDrops: true }],
      },
    } as MessageEvent);
    expect((untrackedQueue as unknown as { totalDrops: number }).totalDrops).toBe(0);

    const trackedQueue = initializedRenderer();
    trackedQueue.handleMessage({
      data: {
        type: 'addMessages',
        messages: Array.from({ length: 50 }, (_, index) => ({
          ...makeWorkerMessage(`tracked-${index}`),
          trackDrops: true,
        })),
      },
    } as MessageEvent);
    trackedQueue.handleMessage({
      data: {
        type: 'addMessages',
        messages: [{ ...makeWorkerMessage('untracked-high'), priority: 100, trackDrops: false }],
      },
    } as MessageEvent);
    expect((trackedQueue as unknown as { totalDrops: number }).totalDrops).toBe(1);
  });

  it('publishes a final empty state before its idle render loop stops', () => {
    const renderer = initializedRenderer();
    const internals = renderer as unknown as { idleSince: number | null };
    internals.idleSince = performance.now() - 1_000;
    const frame = scheduledAnimationFrames.shift();
    if (!frame) throw new Error('Worker render frame was not scheduled');

    frame(performance.now());

    expect(latestStats()).toMatchObject({
      activeMessages: 0,
      pendingQueueDepth: 0,
      totalRendered: 0,
      totalDrops: 0,
      laneUtilization: 0,
    });
  });

  it('reconciles cumulative stats once and publishes Worker-owned runtime state', () => {
    const { manager, observability, onStats, worker } = initializedManager();
    const first = validStats();

    worker.emitMessage(first);
    worker.emitMessage(first);
    worker.emitMessage({
      ...first,
      totalRendered: 8,
      totalDrops: 4,
      laneUtilization: 0.75,
    });

    expect(observability.onMessagesRendered.mock.calls).toEqual([[5], [3]]);
    expect(observability.onMessagesDropped.mock.calls).toEqual([[3], [1]]);
    expect(observability.updateQueueDepth).toHaveBeenLastCalledWith(1);
    expect(observability.updateLaneUtilization).toHaveBeenLastCalledWith(0.75);
    expect(observability.tick).toHaveBeenCalledTimes(3);
    expect(onStats).toHaveBeenCalledTimes(3);
    expect(manager.queueDepth).toBe(1);
    expect(manager.activeMessageCount).toBe(2);
    expect(manager.laneUtilization).toBe(0.75);

    manager.destroy();
    worker.acknowledgeDestroy();
  });

  it('preserves untracked replay semantics through serialization and backpressure', async () => {
    const { manager, observability, worker } = initializedManager();
    const replay = {
      id: 'replay-backpressure',
      text: 'replay',
      content: [{ type: 'text' as const, content: 'replay' }],
      timestamp: 1,
      kind: 'text' as const,
      authorType: 'normal' as const,
      isBacklog: true,
    };

    expect(manager.sendToWorker(replay, replay.id, false)).toBe(true);
    await Promise.resolve();
    const sentBatch = worker.postMessage.mock.calls
      .map(([message]) => message as { type?: string; messages?: WorkerMessage[] })
      .find((message) => message.type === 'addMessages');
    expect(sentBatch?.messages?.[0]?.trackDrops).toBe(false);

    (manager as unknown as { _queueDepth: number })._queueDepth =
      DEFAULT_SETTINGS.queueMaxSize * 2 + 1;
    expect(manager.sendToWorker({ ...replay, id: 'replay-backpressure-2' }, undefined, false)).toBe(
      false
    );
    expect(observability.onMessageDropped).not.toHaveBeenCalled();
    manager.destroy();
    worker.acknowledgeDestroy();
  });

  it('resets cached stats and ignores messages from a retired Worker', () => {
    const { manager, observability, worker } = initializedManager();
    worker.emitMessage(validStats());
    manager.destroy();

    expect(manager.queueDepth).toBe(0);
    expect(manager.activeMessageCount).toBe(0);
    expect(manager.laneUtilization).toBe(0);
    const renderedCalls = observability.onMessagesRendered.mock.calls.length;
    worker.emitMessage({ ...validStats(), totalRendered: 100 });
    expect(observability.onMessagesRendered).toHaveBeenCalledTimes(renderedCalls);
    worker.acknowledgeDestroy();
  });

  it('does not prune a message newer than the Worker stats snapshot', () => {
    const { manager, worker } = initializedManager();
    const message = {
      id: 'newer-than-stats',
      text: 'newer than stats',
      content: [{ type: 'text' as const, content: 'newer than stats' }],
      timestamp: Date.now(),
      kind: 'text' as const,
      authorType: 'normal' as const,
    };
    expect(manager.sendToWorker(message, message.id)).toBe(true);

    worker.emitMessage({
      ...validStats(),
      activeMessages: 0,
      pendingQueueDepth: 0,
      activeMessageIds: [],
      pendingMessageIds: [],
      processedBatchSequence: 0,
    });

    expect(manager.isCurrentMessage(message.id, message)).toBe(true);
    manager.destroy();
    worker.acknowledgeDestroy();
  });

  it('prunes acknowledged state while retaining a newer same-ID replacement', async () => {
    const { manager, worker } = initializedManager();
    const original = {
      id: 'replacement-watermark',
      text: 'original',
      content: [{ type: 'text' as const, content: 'original' }],
      timestamp: 1,
      kind: 'text' as const,
      authorType: 'normal' as const,
    };
    const replacement = {
      ...original,
      text: 'replacement',
      content: [{ type: 'text' as const, content: 'replacement' }],
      actionType: 'replace' as const,
    };
    expect(manager.sendToWorker(original, original.id)).toBe(true);
    await Promise.resolve();
    expect(manager.sendToWorker(replacement, replacement.id)).toBe(true);

    worker.emitMessage({
      ...validStats(),
      activeMessages: 0,
      pendingQueueDepth: 0,
      totalRendered: 0,
      totalDrops: 0,
      activeMessageIds: [],
      pendingMessageIds: [],
      processedBatchSequence: 1,
    });
    expect(manager.isCurrentMessage(replacement.id, replacement)).toBe(true);

    await Promise.resolve();
    worker.emitMessage({
      ...validStats(),
      activeMessages: 0,
      pendingQueueDepth: 0,
      totalRendered: 0,
      totalDrops: 0,
      activeMessageIds: [],
      pendingMessageIds: [],
      processedBatchSequence: 2,
    });
    expect(manager.isCurrentMessage(replacement.id, replacement)).toBe(false);

    const batches = worker.postMessage.mock.calls
      .map(([message]) => message as { type?: string; batchSequence?: number })
      .filter((message) => message.type === 'addMessages');
    expect(batches.map((message) => message.batchSequence)).toEqual([1, 2]);
    manager.destroy();
    worker.acknowledgeDestroy();
  });

  it('restores prior sent state when a replacement batch fails atomically', async () => {
    const { manager, worker } = initializedManager();
    const original = {
      id: 'sent-before-failure',
      text: 'original',
      content: [{ type: 'text' as const, content: 'original' }],
      timestamp: 1,
      kind: 'text' as const,
      authorType: 'normal' as const,
    };
    expect(manager.sendToWorker(original, original.id)).toBe(true);
    await Promise.resolve();

    const replacement = {
      ...original,
      text: 'failed replacement',
      content: [{ type: 'text' as const, content: 'failed replacement' }],
      actionType: 'replace' as const,
    };
    const sameBatchOriginal = { ...original, id: 'only-in-failed-batch' };
    const sameBatchReplacement = {
      ...replacement,
      id: sameBatchOriginal.id,
    };
    worker.postMessage.mockImplementationOnce(() => {
      throw new Error('postMessage failed');
    });
    expect(manager.sendToWorker(replacement, replacement.id)).toBe(true);
    expect(manager.sendToWorker(sameBatchOriginal, sameBatchOriginal.id)).toBe(true);
    expect(manager.sendToWorker(sameBatchReplacement, sameBatchReplacement.id)).toBe(true);
    await Promise.resolve();

    expect(manager.isCurrentMessage(original.id, original)).toBe(true);
    expect(manager.isCurrentMessage(replacement.id, replacement)).toBe(false);
    expect(manager.isCurrentMessage(sameBatchOriginal.id, sameBatchOriginal)).toBe(false);
    expect(manager.isCurrentMessage(sameBatchReplacement.id, sameBatchReplacement)).toBe(false);
    await expect(manager.snapshotMessages(0)).resolves.toEqual([
      { message: original, trackDrops: true },
    ]);
    manager.destroy();
    worker.acknowledgeDestroy();
  });

  it('recovers unacknowledged batches without resurrecting acknowledged expired messages', async () => {
    const { manager, worker } = initializedManager();
    const unacknowledged = {
      id: 'unacknowledged',
      text: 'unacknowledged',
      content: [{ type: 'text' as const, content: 'unacknowledged' }],
      timestamp: 1,
      kind: 'text' as const,
      authorType: 'normal' as const,
    };
    expect(manager.sendToWorker(unacknowledged, unacknowledged.id)).toBe(true);
    await Promise.resolve();
    const firstSnapshot = manager.snapshotMessages(1_000);
    const firstRequest = worker.postMessage.mock.calls
      .map(([message]) => message as { type?: string; requestId?: number })
      .findLast((message) => message.type === 'snapshotMessages');
    worker.emitMessage({
      type: 'messageSnapshot',
      requestId: firstRequest?.requestId,
      activeMessageIds: [],
      pendingMessageIds: [],
      processedBatchSequence: 0,
    });
    await expect(firstSnapshot).resolves.toEqual([
      { message: unacknowledged, trackDrops: true },
    ]);

    const expired = { ...unacknowledged, id: 'acknowledged-expired' };
    expect(manager.sendToWorker(expired, expired.id)).toBe(true);
    await Promise.resolve();
    const secondSnapshot = manager.snapshotMessages(1_000);
    const secondRequest = worker.postMessage.mock.calls
      .map(([message]) => message as { type?: string; requestId?: number })
      .findLast((message) => message.type === 'snapshotMessages');
    worker.emitMessage({
      type: 'messageSnapshot',
      requestId: secondRequest?.requestId,
      activeMessageIds: [],
      pendingMessageIds: [],
      processedBatchSequence: 2,
    });
    await expect(secondSnapshot).resolves.toEqual([]);
    manager.destroy();
    worker.acknowledgeDestroy();
  });

  it('preserves drop tracking only for pending and unacknowledged live work', async () => {
    const { manager, worker } = initializedManager();
    const makeChatMessage = (id: string) => ({
      id,
      text: id,
      content: [{ type: 'text' as const, content: id }],
      timestamp: 1,
      kind: 'text' as const,
      authorType: 'normal' as const,
    });
    const pending = makeChatMessage('snapshot-pending');
    expect(manager.sendToWorker(pending, pending.id, true)).toBe(true);
    await Promise.resolve();
    const pendingSnapshot = manager.snapshotMessages(0);
    const pendingRequest = worker.postMessage.mock.calls
      .map(([message]) => message as { type?: string; requestId?: number })
      .findLast((message) => message.type === 'snapshotMessages');
    worker.emitMessage({
      type: 'messageSnapshot',
      requestId: pendingRequest?.requestId,
      activeMessageIds: [],
      pendingMessageIds: [pending.id],
      processedBatchSequence: 1,
    });
    await expect(pendingSnapshot).resolves.toEqual([{ message: pending, trackDrops: true }]);

    const active = makeChatMessage('snapshot-active');
    expect(manager.sendToWorker(active, active.id, true)).toBe(true);
    await Promise.resolve();
    const activeSnapshot = manager.snapshotMessages(0);
    const activeRequest = worker.postMessage.mock.calls
      .map(([message]) => message as { type?: string; requestId?: number })
      .findLast((message) => message.type === 'snapshotMessages');
    worker.emitMessage({
      type: 'messageSnapshot',
      requestId: activeRequest?.requestId,
      activeMessageIds: [active.id],
      pendingMessageIds: [],
      processedBatchSequence: 2,
    });
    await expect(activeSnapshot).resolves.toEqual([{ message: active, trackDrops: false }]);

    const unacknowledged = makeChatMessage('snapshot-unacknowledged');
    expect(manager.sendToWorker(unacknowledged, unacknowledged.id, true)).toBe(true);
    await Promise.resolve();
    const unacknowledgedSnapshot = manager.snapshotMessages(0);
    const unacknowledgedRequest = worker.postMessage.mock.calls
      .map(([message]) => message as { type?: string; requestId?: number })
      .findLast((message) => message.type === 'snapshotMessages');
    worker.emitMessage({
      type: 'messageSnapshot',
      requestId: unacknowledgedRequest?.requestId,
      activeMessageIds: [],
      pendingMessageIds: [],
      processedBatchSequence: 2,
    });
    await expect(unacknowledgedSnapshot).resolves.toEqual([
      { message: unacknowledged, trackDrops: true },
    ]);

    const activeAtTimeout = makeChatMessage('snapshot-timeout-active');
    expect(manager.sendToWorker(activeAtTimeout, activeAtTimeout.id, true)).toBe(true);
    await Promise.resolve();
    worker.emitMessage({
      type: 'stats',
      activeMessages: 1,
      pendingQueueDepth: 0,
      totalRendered: 1,
      totalDrops: 0,
      processedBatchSequence: 4,
      laneUtilization: 0.5,
      activeMessageIds: [activeAtTimeout.id],
      pendingMessageIds: [],
    });
    await expect(manager.snapshotMessages(0)).resolves.toEqual([
      { message: activeAtTimeout, trackDrops: false },
    ]);
    manager.destroy();
    worker.acknowledgeDestroy();
  });

  it('does not resurrect an entry acknowledged as expired while a snapshot times out', async () => {
    const { manager, worker } = initializedManager();
    const expired = {
      id: 'expired-during-snapshot',
      text: 'expired during snapshot',
      content: [{ type: 'text' as const, content: 'expired during snapshot' }],
      timestamp: 1,
      kind: 'text' as const,
      authorType: 'normal' as const,
    };
    expect(manager.sendToWorker(expired, expired.id, true)).toBe(true);
    await Promise.resolve();

    const snapshot = manager.snapshotMessages(0);
    worker.emitMessage({
      type: 'stats',
      activeMessages: 0,
      pendingQueueDepth: 0,
      totalRendered: 1,
      totalDrops: 0,
      processedBatchSequence: 1,
      laneUtilization: 0,
      activeMessageIds: [],
      pendingMessageIds: [],
    });

    await expect(snapshot).resolves.toEqual([]);
    manager.destroy();
    worker.acknowledgeDestroy();
  });

  it('escalates one native load error and preserves messages for recovery', async () => {
    const { manager, worker } = initializedManager();
    const onFatalError = vi.fn();
    let recovery: Promise<Array<{ message: { id?: string }; trackDrops: boolean }>> | undefined;
    manager.setFatalErrorCallback((reason) => {
      onFatalError(reason);
      recovery = manager.snapshotMessages(0);
    });
    expect(
      manager.sendToWorker(
        {
          id: 'pending-recovery',
          text: 'pending recovery',
          content: [{ type: 'text', content: 'pending recovery' }],
          timestamp: Date.now(),
          kind: 'text',
          authorType: 'normal',
        },
        'pending-recovery'
      )
    ).toBe(true);
    await Promise.resolve();

    const error = new ErrorEvent('error', {
      cancelable: true,
      message: 'Worker script failed to load',
    });
    worker.onerror?.(error);
    worker.onerror?.(error);

    expect(onFatalError).toHaveBeenCalledOnce();
    expect(onFatalError).toHaveBeenCalledWith('worker-load-error');
    expect(error.defaultPrevented).toBe(true);
    await expect(recovery).resolves.toEqual([
      {
        message: expect.objectContaining({ id: 'pending-recovery' }),
        trackDrops: true,
      },
    ]);
    manager.destroy();
    worker.acknowledgeDestroy();
  });

  it('escalates one validated Worker protocol error to recovery', () => {
    const { manager, worker } = initializedManager();
    const onFatalError = vi.fn();
    manager.setFatalErrorCallback(onFatalError);

    worker.emitMessage({ type: 'error', error: 42 });
    expect(onFatalError).not.toHaveBeenCalled();
    worker.emitMessage({ type: 'error', error: 'Failed to get 2D context' });
    worker.emitMessage({ type: 'error', error: 'duplicate error' });

    expect(onFatalError).toHaveBeenCalledOnce();
    expect(onFatalError).toHaveBeenCalledWith('worker-runtime-error');
    manager.destroy();
    worker.acknowledgeDestroy();
  });
});
