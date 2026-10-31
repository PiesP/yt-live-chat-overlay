// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage, OverlaySettings } from '@app-types';
import { DRAIN_WORK_BUDGET_MS } from '@renderer/canvas/drain-batch';
import type { MessageMotionPlan } from '@renderer/layout/message-schedule';
import { RenderWorkerManager } from '@renderer/worker/manager';
import {
  isValidControlMessage,
  isValidWorkerBatchReceipt,
  isValidWorkerClearStateAck,
  isValidWorkerStatsMessage,
} from '@renderer/worker/protocol-guards';
import { WorkerRenderer } from '@renderer/worker/renderer';
import type { WorkerMessage, WorkerStatsMessage } from '@renderer/worker/types';
import { DEFAULT_SETTINGS } from '@settings/schema';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

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
vi.stubGlobal(
  'ImageBitmap',
  class {
    close(): void {}
  }
);
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

function initializedRenderer(
  settings: OverlaySettings = { ...DEFAULT_SETTINGS, queueMaxSize: 50 }
): WorkerRenderer {
  const renderer = new WorkerRenderer();
  renderer.handleMessage({
    data: {
      type: 'init',
      canvas: new TestOffscreenCanvas(),
      config: {
        ...RenderWorkerManager.buildWorkerConfig(settings),
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

function initializedManager(
  settings: OverlaySettings = DEFAULT_SETTINGS,
  getMessagePriority: (message: ChatMessage) => number = () => 0,
  onMessageDispatched?: (message: ChatMessage, id: string) => void
) {
  const observability = {
    onMessageDropped: vi.fn(),
    onMessagesDropped: vi.fn(),
    onMessagesRendered: vi.fn(),
    onMessagesPresented: vi.fn(),
    updateActiveMessages: vi.fn(),
    updateQueueDepth: vi.fn(),
    updateLaneUtilization: vi.fn(),
    tick: vi.fn(),
  };
  const onStats = vi.fn();
  const manager = new RenderWorkerManager({
    settings,
    observability,
    estimateDimensions: () => ({ width: 100, height: 20 }),
    getMessagePriority,
    getEffectiveSpeedPxPerSec: () => settings.speedPxPerSec,
    onMessageDispatched,
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

  expect(manager.init(canvas, settings, overlay as never, 'worker.js').started).toBe(true);
  const worker = TestWorker.instances.at(-1);
  if (!worker) throw new Error('Worker was not created');
  return { manager, observability, onStats, worker };
}

function coupleWorker(managerWorker: TestWorker, renderer: WorkerRenderer): void {
  managerWorker.postMessage.mockImplementation((message: unknown) => {
    renderer.handleMessage({ data: message } as MessageEvent);
  });
  postMessage.mockImplementation((message: unknown) => managerWorker.emitMessage(message));
}

async function flushMicrotasks(turns = 4): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
}

interface TestPlacement {
  laneIndex: number;
  waitMs: number;
  laneY: number;
  slotCount: number;
  verticalOffset: number;
}

interface AuthorAssetRendererState {
  activeMessages: Array<{ id: string }>;
  pendingQueue: WorkerMessage[];
  messageById: Map<string, unknown>;
  authorPhotoCache: unknown;
  drainResumePriority: number | undefined;
  drainCursors: Map<number, WorkerMessage>;
  totalRendered: number;
  totalDrops: number;
  dropReasons: Record<string, number>;
  isDestroyed: boolean;
  animFrameId: number | null;
  activateMessage(
    message: WorkerMessage,
    now: number,
    placement: TestPlacement,
    batchIndex: number,
    previousStaggerDelayMs: number,
    speedTier: number,
    width: number,
    height: number,
    motion?: MessageMotionPlan
  ): number;
  findPlacement(
    height: number,
    speedTier: number,
    now: number,
    strategy: string
  ): TestPlacement | null;
  checkCollision(
    placement: TestPlacement,
    message: WorkerMessage,
    speedTier: number,
    batchIndex: number,
    previousStaggerDelayMs: number,
    now: number,
    width: number,
    motion?: MessageMotionPlan
  ): boolean;
  prefetchImages(urls: string[], cache: unknown, ownerId: string): Promise<void>;
}

const AUTHOR_ASSET_FRAME_LIMIT = 3;
const AUTHOR_ASSET_WORK_CASES = [
  DRAIN_WORK_BUDGET_MS - 0.001,
  DRAIN_WORK_BUDGET_MS,
  DRAIN_WORK_BUDGET_MS + 0.001,
];
const hiddenAuthorSettings: OverlaySettings = {
  ...DEFAULT_SETTINGS,
  queueMaxSize: 50,
  showAuthor: { ...DEFAULT_SETTINGS.showAuthor, normal: false, superChat: false },
};
const regularAuthorMessage: ChatMessage = {
  id: 'asset-regular',
  text: 'regular',
  content: [{ type: 'text', content: 'regular' }],
  timestamp: 1,
  kind: 'text',
  authorType: 'normal',
  author: 'regular author',
  authorPhotoUrl: 'https://yt3.ggpht.com/regular-author.png',
};
const paidAuthorMessage: ChatMessage = {
  id: 'asset-paid',
  text: 'paid',
  content: [{ type: 'text', content: 'paid' }],
  timestamp: 1,
  kind: 'superchat',
  authorType: 'normal',
  author: 'paid author',
  authorPhotoUrl: 'https://yt3.ggpht.com/paid-author.png',
  superChat: { amount: '$5', tier: 'blue' },
};
const authorAssetIds = [regularAuthorMessage.id, paidAuthorMessage.id];

function createAuthorAssetFixture(
  manager: RenderWorkerManager,
  worker: TestWorker,
  renderer: WorkerRenderer,
  clock: { now: number; frames: number },
  elapsedWorkMs: number
) {
  const state = renderer as unknown as AuthorAssetRendererState;
  const prefetch = vi.spyOn(state, 'prefetchImages').mockResolvedValue(undefined);
  const findPlacement = vi.spyOn(state, 'findPlacement');
  const checkCollision = vi.spyOn(state, 'checkCollision');
  const originalActivate = state.activateMessage.bind(renderer);
  const activate = vi.spyOn(state, 'activateMessage').mockImplementation((...args) => {
    const result = originalActivate(...args);
    // Preserve real activation and prewarming; charge work before the next budget check.
    if (args[0].id === paidAuthorMessage.id) clock.now += elapsedWorkMs;
    return result;
  });
  coupleWorker(worker, renderer);
  postMessage.mockImplementation((message: unknown) => {
    worker.emitMessage(message);
    // Real Worker delivery is asynchronous. Install the manager's listener before ACK.
    if ((message as { type?: string }).type === 'ack') {
      queueMicrotask(() => worker.acknowledgeDestroy());
    }
  });

  const diagnostics = () =>
    JSON.stringify({
      expectedIds: authorAssetIds,
      activeIds: state.activeMessages.map(({ id }) => id),
      pendingIds: state.pendingQueue.map(({ id }) => id),
      now: clock.now,
      frames: clock.frames,
      queuedFrames: scheduledAnimationFrames.length,
      resumePriority: state.drainResumePriority ?? null,
      totalRendered: state.totalRendered,
      totalDrops: state.totalDrops,
      dropReasons: state.dropReasons,
    });
  const isReady = () =>
    authorAssetIds.every(
      (id) =>
        state.activeMessages.some((message) => message.id === id) &&
        !state.pendingQueue.some((message) => message.id === id)
    );
  const nextFrame = () => {
    const frame = scheduledAnimationFrames.shift();
    if (!frame) throw new Error(`Missing author-asset RAF callback: ${diagnostics()}`);
    clock.now += 16;
    clock.frames++;
    frame(clock.now);
  };
  const waitUntilActive = async () => {
    for (let frame = 0; frame < AUTHOR_ASSET_FRAME_LIMIT && !isReady(); frame++) {
      nextFrame();
      await flushMicrotasks();
    }
    if (!isReady()) {
      throw new Error(
        `Author-asset readiness frame limit (${AUTHOR_ASSET_FRAME_LIMIT}): ${diagnostics()}`
      );
    }
    expect(state.activeMessages.map(({ id }) => id).sort()).toEqual([...authorAssetIds].sort());
    expect(state.pendingQueue).toHaveLength(0);
  };
  return {
    manager,
    worker,
    renderer,
    state,
    prefetch,
    activate,
    findPlacement,
    checkCollision,
    clock,
    nextFrame,
    waitUntilActive,
    async sendPair() {
      expect(manager.sendToWorker(regularAuthorMessage, regularAuthorMessage.id)).toBe(true);
      expect(manager.sendToWorker(paidAuthorMessage, paidAuthorMessage.id)).toBe(true);
      await flushMicrotasks();
    },
    async showAuthors() {
      manager.updateSettings({
        ...hiddenAuthorSettings,
        showAuthor: { ...hiddenAuthorSettings.showAuthor, normal: true, superChat: true },
      });
      await flushMicrotasks();
    },
    restoreSpies() {
      activate.mockRestore();
      checkCollision.mockRestore();
      findPlacement.mockRestore();
      prefetch.mockRestore();
    },
  };
}

type AuthorAssetFixture = ReturnType<typeof createAuthorAssetFixture>;

async function withAuthorAssetFixture(
  elapsedWorkMs: number,
  body: (fixture: AuthorAssetFixture) => Promise<void>
): Promise<void> {
  // Own timers only inside this fixture; RAF and promise delivery remain manually driven.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const clock = { now: 1_000, frames: 0 };
  const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
  let manager: RenderWorkerManager | undefined;
  let worker: TestWorker | undefined;
  let renderer: WorkerRenderer | undefined;
  let fixture: AuthorAssetFixture | undefined;
  try {
    ({ manager, worker } = initializedManager(hiddenAuthorSettings, (message) =>
      message.kind === 'superchat' ? 100 : 0
    ));
    renderer = initializedRenderer(hiddenAuthorSettings);
    fixture = createAuthorAssetFixture(manager, worker, renderer, clock, elapsedWorkMs);
    await body(fixture);
  } finally {
    try {
      manager?.destroy();
      await flushMicrotasks(); // Deliver the coupled destroy ACK before disconnecting the bridge.
      if (renderer && !(renderer as unknown as AuthorAssetRendererState).isDestroyed) {
        renderer.handleMessage({ data: { type: 'destroy' } } as MessageEvent);
      }
      if (worker) expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      worker?.postMessage.mockReset();
      if (worker) TestWorker.instances.splice(TestWorker.instances.indexOf(worker), 1);
      postMessage.mockReset();
      scheduledAnimationFrames.length = 0;
      fixture?.restoreSpies();
      randomSpy.mockRestore();
      nowSpy.mockRestore();
      vi.useRealTimers();
    }
  }
}

function expectAuthorRequests(fixture: AuthorAssetFixture, messages: ChatMessage[]): void {
  // Assert request intent and exact owner/cache routing, without an incidental call order.
  expect(fixture.prefetch).toHaveBeenCalledTimes(messages.length);
  for (const [, cache] of fixture.prefetch.mock.calls) {
    expect(cache).toBe(fixture.state.authorPhotoCache);
  }
  for (const message of messages) {
    expect(fixture.prefetch).toHaveBeenCalledWith(
      [message.authorPhotoUrl],
      fixture.state.authorPhotoCache,
      message.id
    );
  }
}

describe('Worker renderer state synchronization', () => {
  beforeEach(() => {
    postMessage.mockReset();
    TestWorker.instances.length = 0;
    scheduledAnimationFrames.length = 0;
  });

  it('applies current fontSize through manager dispatch while excluding legacy preferences', () => {
    const initialSettings = {
      ...DEFAULT_SETTINGS,
      fontSize: 30,
      fontBaseViewportHeight: 720,
      fontMinSize: 12,
      fontMaxSize: 42,
    };
    const { manager, worker } = initializedManager(initialSettings);
    const renderer = initializedRenderer(initialSettings);
    coupleWorker(worker, renderer);
    const workerFontSize = () =>
      (renderer as unknown as { config: { fontSize: number } }).config.fontSize;

    try {
      const legacyChanged = {
        ...initialSettings,
        fontBaseViewportHeight: 1440,
        fontMinSize: 20,
        fontMaxSize: 60,
      };
      manager.updateSettings(legacyChanged);
      const legacyUpdate = worker.postMessage.mock.calls.at(-1)?.[0] as {
        type: string;
        config: Record<string, unknown>;
      };
      expect(legacyUpdate.type).toBe('updateConfig');
      expect(legacyUpdate.config.fontSize).toBe(30);
      for (const key of ['fontBaseViewportHeight', 'fontMinSize', 'fontMaxSize']) {
        expect(Object.hasOwn(legacyUpdate.config, key)).toBe(false);
      }
      expect(workerFontSize()).toBe(30);

      manager.updateSettings({ ...legacyChanged, fontSize: 40 });
      expect(workerFontSize()).toBe(40);
    } finally {
      manager.destroy();
      worker.acknowledgeDestroy();
    }
  });

  it('retains ordinary burst acceleration while Backlog ignores serialized burst', () => {
    const renderer = initializedRenderer({
      ...DEFAULT_SETTINGS,
      speedPxPerSec: 250,
      backlogSpeedMultiplier: 2,
    });
    const { getMessageVelocity } = renderer as unknown as {
      getMessageVelocity(
        message: Pick<WorkerMessage, 'burstSpeedMultiplier'>,
        tier: number
      ): number;
    };
    const velocity = getMessageVelocity.bind(renderer);
    expect(velocity({ burstSpeedMultiplier: 1.35 }, 1)).toBe(337.5);
    expect(velocity({ burstSpeedMultiplier: 1.35 }, 3)).toBe(500);
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

  it('accepts consistent known drop reasons and rejects malformed counters', () => {
    expect(
      isValidWorkerStatsMessage({
        ...validStats(),
        dropReasons: { queue_priority: 1, oversized: 2 },
      })
    ).toBe(true);
    for (const dropReasons of [
      { queue_priority: 2 },
      { queue_priority: -1, oversized: 4 },
      { queue_priority: 1, oversized: Number.NaN },
      { unknown_reason: 3 },
      { queue_priority: Number.MAX_SAFE_INTEGER, oversized: 1 },
    ]) {
      expect(isValidWorkerStatsMessage({ ...validStats(), dropReasons })).toBe(false);
    }
  });

  it('accepts only bounded batch receipts and clear-state fence acknowledgements', () => {
    const receipt = {
      type: 'batchReceipt',
      epoch: 2,
      batchSequence: 7,
      pendingQueueDepth: 50,
      admittedMessages: 1,
      minimumPendingPriority: 0,
    };
    expect(isValidWorkerBatchReceipt(receipt)).toBe(true);
    for (const invalid of [
      { ...receipt, epoch: -1 },
      { ...receipt, batchSequence: 0 },
      { ...receipt, pendingQueueDepth: 1_001 },
      { ...receipt, admittedMessages: Number.NaN },
      { ...receipt, minimumPendingPriority: Number.POSITIVE_INFINITY },
    ]) {
      expect(isValidWorkerBatchReceipt(invalid)).toBe(false);
    }
    expect(isValidWorkerClearStateAck({ type: 'clearStateAck', epoch: 2 })).toBe(true);
    expect(isValidWorkerClearStateAck({ type: 'clearStateAck', epoch: -1 })).toBe(false);
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
    // Keep the measurement inside the lane reservation regardless of runner load.
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(10_000);
    try {
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
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('counts and announces only completed visible Worker frames across future entry and replacement', () => {
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    try {
      const renderer = initializedRenderer({
        ...DEFAULT_SETTINGS,
        translationEnabled: true,
        translationMode: 'dual',
      });
      renderer.handleMessage({
        data: { type: 'addMessages', messages: [makeWorkerMessage('present')], batchSequence: 1 },
      } as MessageEvent);
      const internals = renderer as unknown as {
        activeMessages: Array<{
          startTime: number;
          fadeStartTime: number;
          startX: number;
          duration: number;
          text: string;
          canonicalText?: string;
          translatedText?: string | null;
          reflowHidden?: boolean;
          wasPresented?: boolean;
        }>;
        opacityConfig: { baseOpacity: number };
        statsFrameCounter: number;
        renderFrame(): void;
        postStats(force: boolean): void;
      };
      internals.renderFrame();
      const message = internals.activeMessages[0];
      expect(message).toBeDefined();
      if (!message) return;
      message.startTime = 5_000;
      message.fadeStartTime = 1_000;
      message.duration = 10_000;
      internals.renderFrame();
      message.startTime = 1_000;
      message.startX = 2_000;
      nowSpy.mockReturnValue(2_000);
      internals.renderFrame();
      message.startX = 640;
      internals.opacityConfig.baseOpacity = 0.001;
      internals.renderFrame();
      internals.postStats(true);
      expect(latestStats()).toMatchObject({ totalRendered: 1, totalPresented: 0 });
      expect(
        postMessage.mock.calls.some(
          ([value]) => (value as { type?: string }).type === 'liveRegionSnippets'
        )
      ).toBe(false);

      internals.opacityConfig.baseOpacity = 1;
      message.canonicalText = 'full original';
      message.translatedText = 'translation';
      internals.statsFrameCounter = 29;
      internals.renderFrame();
      expect(message.wasPresented).toBe(true);
      expect(
        postMessage.mock.calls.findLast(
          ([value]) => (value as { type?: string }).type === 'liveRegionSnippets'
        )?.[0]
      ).toMatchObject({ messages: [{ id: 'present', text: 'full original — translation' }] });

      message.reflowHidden = true;
      internals.statsFrameCounter = 29;
      internals.renderFrame();
      message.reflowHidden = false;
      renderer.handleMessage({
        data: {
          type: 'addMessages',
          batchSequence: 2,
          messages: [
            {
              ...makeWorkerMessage('present'),
              actionType: 'replace',
              text: 'edited',
              canonicalText: 'full edit',
              translatedText: 'other translation',
              content: [{ type: 'text', content: 'edited' }],
            },
          ],
        },
      } as MessageEvent);
      internals.statsFrameCounter = 29;
      internals.renderFrame();
      internals.postStats(true);
      expect(latestStats()?.totalPresented).toBe(1);
      expect(
        postMessage.mock.calls.findLast(
          ([value]) => (value as { type?: string }).type === 'liveRegionSnippets'
        )?.[0]
      ).toMatchObject({ messages: [{ id: 'present', text: 'full edit — other translation' }] });
      renderer.handleMessage({ data: { type: 'snapshotMessages', requestId: 17 } } as MessageEvent);
      expect(
        postMessage.mock.calls.findLast(
          ([value]) => (value as { type?: string }).type === 'messageSnapshot'
        )?.[0]
      ).toMatchObject({
        totalRendered: 1,
        totalPresented: 1,
        motionSnapshot: { activeMotions: [{ id: 'present', wasPresented: true }] },
      });
    } finally {
      nowSpy.mockRestore();
    }
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
    expect(latestStats()?.dropReasons).toMatchObject({ queue_priority: 1, queue_replaced: 0 });
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
    expect(latestStats()?.dropReasons).toMatchObject({
      queue_priority: 0,
      queue_replaced: 0,
      oversized: 0,
      reflow_capacity: 0,
    });
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
    expect(
      (trackedQueue as unknown as { dropReasons: { queue_replaced: number } }).dropReasons
        .queue_replaced
    ).toBe(1);
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
    const first = { ...validStats(), totalPresented: 2 };

    worker.emitMessage(first);
    worker.emitMessage(first);
    worker.emitMessage({
      ...first,
      totalRendered: 8,
      totalPresented: 4,
      totalDrops: 4,
      laneUtilization: 0.75,
    });

    expect(observability.onMessagesRendered.mock.calls).toEqual([[5], [3]]);
    expect(observability.onMessagesPresented.mock.calls).toEqual([[2], [2]]);
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

  it('reconciles final presentation counters from a recovery snapshot once', async () => {
    const { manager, observability, worker } = initializedManager();
    const recovery = manager.snapshotMessages(1_000);
    const request = worker.postMessage.mock.calls
      .map(([message]) => message as { type?: string; requestId?: number; epoch?: number })
      .findLast((message) => message.type === 'snapshotMessages');
    if (request?.requestId === undefined || request.epoch === undefined) {
      throw new Error('Expected snapshot request');
    }
    worker.emitMessage({
      type: 'messageSnapshot',
      requestId: request.requestId,
      epoch: request.epoch,
      activeMessageIds: [],
      pendingMessageIds: [],
      processedBatchSequence: 0,
      totalRendered: 2,
      totalPresented: 1,
    });
    await expect(recovery).resolves.toEqual([]);
    expect(observability.onMessagesRendered.mock.calls).toEqual([[2]]);
    expect(observability.onMessagesPresented.mock.calls).toEqual([[1]]);

    worker.emitMessage({
      ...validStats(),
      activeMessages: 0,
      pendingQueueDepth: 0,
      activeMessageIds: [],
      pendingMessageIds: [],
      totalRendered: 2,
      totalPresented: 1,
      totalDrops: 0,
    });
    expect(observability.onMessagesRendered.mock.calls).toEqual([[2]]);
    expect(observability.onMessagesPresented.mock.calls).toEqual([[1]]);
    manager.destroy();
    worker.acknowledgeDestroy();
  });

  it('reports reason-specific cumulative deltas without double counting repeats', () => {
    const { manager, observability, worker } = initializedManager();
    const first = {
      ...validStats(),
      totalDrops: 2,
      dropReasons: { queue_priority: 1, oversized: 1 },
    };
    worker.emitMessage(first);
    worker.emitMessage(first);
    worker.emitMessage({
      ...first,
      totalDrops: 4,
      dropReasons: { queue_priority: 1, oversized: 2, reflow_capacity: 1 },
    });
    expect(observability.onMessagesDropped.mock.calls).toEqual([
      [1, 'queue_priority'],
      [1, 'oversized'],
      [1, 'oversized'],
      [1, 'reflow_capacity'],
    ]);
    manager.destroy();
    worker.acknowledgeDestroy();
  });

  it('keeps mixed legacy stats unlabeled until a reason baseline is established', () => {
    const { manager, observability, worker } = initializedManager();
    worker.emitMessage({ ...validStats(), totalDrops: 2 });
    worker.emitMessage({
      ...validStats(),
      totalDrops: 3,
      dropReasons: { queue_priority: 2, oversized: 1 },
    });
    worker.emitMessage({
      ...validStats(),
      totalDrops: 4,
      dropReasons: { queue_priority: 3, oversized: 1 },
    });
    expect(observability.onMessagesDropped.mock.calls).toEqual([[2], [1], [1, 'queue_priority']]);
    manager.destroy();
    worker.acknowledgeDestroy();
  });

  it('couples receipts to preserve paid priority without unbounded expensive work', async () => {
    const settings = { ...DEFAULT_SETTINGS, queueMaxSize: 50, maxConcurrentMessages: 30 };
    const estimateDimensions = vi.fn(() => ({ width: 100, height: 20 }));
    const dispatched = vi.fn();
    const { manager, worker } = initializedManager(
      settings,
      (message) => (message.kind === 'superchat' ? 100 : 0),
      dispatched
    );
    (
      manager as unknown as { deps: { estimateDimensions: typeof estimateDimensions } }
    ).deps.estimateDimensions = estimateDimensions;
    const renderer = initializedRenderer(settings);
    coupleWorker(worker, renderer);
    const makeIngress = (id: string, paid = false): ChatMessage => ({
      id,
      text: id,
      content: [{ type: 'text', content: id }],
      timestamp: 1,
      kind: paid ? 'superchat' : 'text',
      authorType: 'normal',
      ...(paid ? { superChat: { amount: '$5', tier: 'blue' as const } } : {}),
    });

    for (let index = 0; index < 50; index++) manager.sendToWorker(makeIngress(`normal-${index}`));
    await flushMicrotasks();
    for (let index = 0; index < 50; index++)
      manager.sendToWorker(makeIngress(`paid-${index}`, true));
    await flushMicrotasks(120);

    const pending = (
      renderer as unknown as { pendingQueue: Array<{ id: string; priority: number }> }
    ).pendingQueue;
    expect(pending).toHaveLength(50);
    expect(pending.every((message) => message.priority === 100)).toBe(true);
    expect(estimateDimensions).toHaveBeenCalledTimes(100);

    for (let index = 0; index < 50; index++)
      manager.sendToWorker(makeIngress(`extra-${index}`, true));
    await flushMicrotasks(60);
    expect(estimateDimensions).toHaveBeenCalledTimes(100);
    expect(dispatched).toHaveBeenCalledTimes(100);
    expect(
      worker.postMessage.mock.calls
        .map(([message]) => message as { type?: string; messages?: unknown[] })
        .filter((message) => message.type === 'addMessages')
        .every((message) => (message.messages?.length ?? 0) <= 1_000)
    ).toBe(true);
    manager.destroy();
    postMessage.mockImplementation(() => undefined);
  });

  it('coalesces a same-id replacement flood before dimensions and dispatch', async () => {
    const settings = { ...DEFAULT_SETTINGS, queueMaxSize: 50 };
    const estimateDimensions = vi.fn(() => ({ width: 100, height: 20 }));
    const dispatched = vi.fn();
    const { manager, worker } = initializedManager(settings, () => 0, dispatched);
    (
      manager as unknown as { deps: { estimateDimensions: typeof estimateDimensions } }
    ).deps.estimateDimensions = estimateDimensions;
    const renderer = initializedRenderer(settings);
    coupleWorker(worker, renderer);
    const original: ChatMessage = {
      id: 'same-id',
      text: 'original',
      content: [{ type: 'text', content: 'original' }],
      timestamp: 1,
      kind: 'text',
      authorType: 'normal',
    };
    manager.sendToWorker(original, original.id);
    await flushMicrotasks();

    for (let index = 0; index < 10_000; index++) {
      manager.sendToWorker(
        {
          ...original,
          actionType: 'replace',
          text: `replacement-${index}`,
          content: [{ type: 'text', content: `replacement-${index}` }],
        },
        original.id
      );
    }
    await flushMicrotasks();

    expect(estimateDimensions).toHaveBeenCalledTimes(2);
    expect(dispatched).toHaveBeenCalledTimes(2);
    expect(
      (renderer as unknown as { pendingQueue: Array<{ text: string }> }).pendingQueue[0]?.text
    ).toBe('replacement-9999');
    manager.destroy();
    postMessage.mockImplementation(() => undefined);
  });

  it('admits normal work after a frame drain publishes fresh capacity', async () => {
    const settings = { ...DEFAULT_SETTINGS, queueMaxSize: 50, maxConcurrentMessages: 30 };
    const { manager, worker } = initializedManager(settings);
    const renderer = initializedRenderer(settings);
    coupleWorker(worker, renderer);
    const makeIngress = (id: string): ChatMessage => ({
      id,
      text: id,
      content: [{ type: 'text', content: id }],
      timestamp: 1,
      kind: 'text',
      authorType: 'normal',
    });
    for (let index = 0; index < 50; index++) manager.sendToWorker(makeIngress(`queued-${index}`));
    await flushMicrotasks();
    expect(manager.sendToWorker(makeIngress('blocked'))).toBe(false);

    scheduledAnimationFrames.shift()?.(performance.now());

    expect(manager.sendToWorker(makeIngress('after-drain'))).toBe(true);
    await flushMicrotasks();
    expect(
      (renderer as unknown as { messageById: Map<string, unknown> }).messageById.has('after-drain')
    ).toBe(true);
    manager.destroy();
    postMessage.mockImplementation(() => undefined);
  });

  it.each(AUTHOR_ASSET_WORK_CASES)(
    'refreshes active regular and SuperChat author assets when settings toggle (paid work %sms)',
    async (elapsedWorkMs) => {
      await withAuthorAssetFixture(elapsedWorkMs, async (fixture) => {
        await fixture.sendPair();
        await fixture.waitUntilActive();
        expect(fixture.clock.frames).toBe(elapsedWorkMs < DRAIN_WORK_BUDGET_MS ? 1 : 2);
        expect(fixture.prefetch).not.toHaveBeenCalled();

        await fixture.showAuthors();
        expectAuthorRequests(fixture, [regularAuthorMessage, paidAuthorMessage]);

        fixture.prefetch.mockClear();
        fixture.manager.updateSettings(hiddenAuthorSettings);
        await flushMicrotasks();
        expect(fixture.prefetch).not.toHaveBeenCalled();
      });
    }
  );

  it.each(AUTHOR_ASSET_WORK_CASES)(
    'resumes author assets after bounded Worker draining (paid work %sms)',
    async (elapsedWorkMs) => {
      await withAuthorAssetFixture(elapsedWorkMs, async (fixture) => {
        await fixture.sendPair();
        fixture.nextFrame();
        const deferred = elapsedWorkMs >= DRAIN_WORK_BUDGET_MS;
        const attemptedIds = fixture.activate.mock.calls.map(([message]) => message.id);
        expect(attemptedIds).toEqual(
          deferred ? [paidAuthorMessage.id] : [paidAuthorMessage.id, regularAuthorMessage.id]
        );
        expect(fixture.state.activeMessages.map(({ id }) => id)).toEqual(attemptedIds);
        expect(fixture.state.pendingQueue.map(({ id }) => id)).toEqual(
          deferred ? [regularAuthorMessage.id] : []
        );
        expect(fixture.state.drainResumePriority).toBe(deferred ? 0 : undefined);
        expect(fixture.state.drainCursors.has(0)).toBe(!deferred);
        expect(fixture.findPlacement).toHaveBeenCalledTimes(deferred ? 1 : 2);
        expect(
          fixture.findPlacement.mock.results.every(
            ({ value }) => value !== null && value.waitMs === 0
          )
        ).toBe(true);
        expect(fixture.checkCollision.mock.results.map(({ value }) => value)).toEqual(
          deferred ? [true] : [true, true]
        );
        expect([...fixture.state.messageById.keys()].sort()).toEqual([...authorAssetIds].sort());
        expect(fixture.state.totalDrops).toBe(0);
        expect(fixture.prefetch).not.toHaveBeenCalled();

        await fixture.showAuthors();
        if (deferred) {
          expectAuthorRequests(fixture, [paidAuthorMessage]);
          // The original single-frame preparation cannot satisfy its two-resource assertion.
          expect(() =>
            expectAuthorRequests(fixture, [regularAuthorMessage, paidAuthorMessage])
          ).toThrow();
          expect(fixture.state.pendingQueue[0]).toMatchObject({
            id: regularAuthorMessage.id,
            actionType: 'replace',
            authorPhotoUrl: regularAuthorMessage.authorPhotoUrl,
          });
          await flushMicrotasks(20);
          expect(fixture.state.pendingQueue.map(({ id }) => id)).toEqual([regularAuthorMessage.id]);
          expectAuthorRequests(fixture, [paidAuthorMessage]);
          fixture.nextFrame();
          await flushMicrotasks();
        }
        expectAuthorRequests(fixture, [regularAuthorMessage, paidAuthorMessage]);
        expect(fixture.activate.mock.calls.map(([message]) => message.id)).toEqual([
          paidAuthorMessage.id,
          regularAuthorMessage.id,
        ]);
        expect(fixture.checkCollision.mock.results.map(({ value }) => value)).toEqual([true, true]);
        expect(fixture.state.activeMessages.map(({ id }) => id).sort()).toEqual(
          [...authorAssetIds].sort()
        );
        expect(fixture.state.pendingQueue).toHaveLength(0);
        expect([...fixture.state.messageById.keys()].sort()).toEqual([...authorAssetIds].sort());
        expect(fixture.state.totalRendered).toBe(2);
        expect(fixture.state.totalDrops).toBe(0);
      });
    }
  );

  it.each(['body failure', 'readiness frame limit', 'missing frame'] as const)(
    'cleans author-asset fixtures after %s and keeps the next fixture independent',
    async (failure) => {
      const originalNow = performance.now;
      const originalRandom = Math.random;
      let failedFixture: AuthorAssetFixture | undefined;
      const run = withAuthorAssetFixture(DRAIN_WORK_BUDGET_MS, async (fixture) => {
        failedFixture = fixture;
        await fixture.sendPair();
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        if (failure === 'body failure') {
          expect('injected assertion failure').toBe('successful body');
        } else if (failure === 'missing frame') {
          scheduledAnimationFrames.length = 0;
          await fixture.waitUntilActive();
        } else {
          // Keep legitimate pending work unready without replacing the activation algorithm.
          fixture.renderer.handleMessage({
            data: { type: 'setPaused', paused: true },
          } as MessageEvent);
          const pausedFrame = scheduledAnimationFrames.shift();
          if (!pausedFrame) throw new Error('Expected paused fixture frame');
          const frame: FrameRequestCallback = (timestamp) => {
            pausedFrame(timestamp);
            scheduledAnimationFrames.push(frame);
          };
          scheduledAnimationFrames.push(frame);
          await fixture.waitUntilActive();
        }
      });
      if (failure === 'body failure') {
        await expect(run).rejects.toThrow('injected assertion failure');
      } else if (failure === 'missing frame') {
        await expect(run).rejects.toThrow(/Missing author-asset RAF callback:.*"frames":0/);
      } else {
        await expect(run).rejects.toThrow(
          /readiness frame limit \(3\):.*"expectedIds":\["asset-regular","asset-paid"\].*"activeIds":\[\].*"pendingIds":.*"now":1048,"frames":3.*"totalDrops":0/
        );
      }
      if (!failedFixture) throw new Error('Failure fixture was not created');
      expect(failedFixture.worker.terminate).toHaveBeenCalledTimes(1);
      expect(failedFixture.state).toMatchObject({
        isDestroyed: true,
        animFrameId: null,
        activeMessages: [],
        pendingQueue: [],
      });
      expect(failedFixture.state.messageById.size).toBe(0);
      expect(failedFixture.worker.postMessage.getMockImplementation()).toBeUndefined();
      expect(postMessage.getMockImplementation()).toBeUndefined();
      expect(scheduledAnimationFrames).toHaveLength(0);
      expect(TestWorker.instances).toHaveLength(0);
      expect(performance.now).toBe(originalNow);
      expect(Math.random).toBe(originalRandom);
      expect(vi.isFakeTimers()).toBe(false);

      const failedWorker = failedFixture.worker;
      await withAuthorAssetFixture(0, async (fresh) => {
        expect(fresh.worker).not.toBe(failedWorker);
        expect(fresh.clock).toEqual({ now: 1_000, frames: 0 });
        expect(fresh.state.activeMessages).toHaveLength(0);
        expect(fresh.state.pendingQueue).toHaveLength(0);
        expect(fresh.prefetch).not.toHaveBeenCalled();
        await fresh.sendPair();
        await fresh.waitUntilActive();
        await fresh.showAuthors();
        expectAuthorRequests(fresh, [regularAuthorMessage, paidAuthorMessage]);
      });
    }
  );

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

    (manager as unknown as { latestWorkerPendingDepth: number }).latestWorkerPendingDepth =
      DEFAULT_SETTINGS.queueMaxSize;
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

  it('does not admit or reinject messages after fallback detaches Worker routing', async () => {
    const { manager, worker } = initializedManager();
    const message: ChatMessage = {
      id: 'detached-worker',
      text: 'detached',
      content: [{ type: 'text', content: 'detached' }],
      timestamp: 1,
      kind: 'text',
      authorType: 'normal',
    };
    manager.sendToWorker(message, message.id);
    await flushMicrotasks();
    worker.postMessage.mockClear();
    manager.setActive(false);

    manager.updateSettings({ ...DEFAULT_SETTINGS, fontSize: DEFAULT_SETTINGS.fontSize + 2 });
    expect(manager.sendToWorker({ ...message, id: 'late' }, 'late')).toBe(false);
    await flushMicrotasks();

    expect(worker.postMessage).not.toHaveBeenCalled();
    manager.destroy();
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
    await expect(firstSnapshot).resolves.toEqual([{ message: unacknowledged, trackDrops: true }]);

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

  it.each([
    [249, false],
    [250, true],
    [251, true],
  ])(
    'settles a held recovery snapshot at the 250 ms boundary (%i ms)',
    async (elapsed, settled) => {
      vi.useFakeTimers();
      const { manager, worker } = initializedManager();
      const message: ChatMessage = {
        id: 'snapshot-time-boundary',
        text: 'recover at deadline',
        content: [{ type: 'text', content: 'recover at deadline' }],
        timestamp: 1,
        kind: 'text',
        authorType: 'normal',
      };

      try {
        expect(manager.sendToWorker(message, message.id)).toBe(true);
        await flushMicrotasks();
        const resolved = vi.fn();
        const snapshot = manager.snapshotMessages().then((messages) => {
          resolved(messages);
          return messages;
        });
        vi.advanceTimersByTime(elapsed);
        await flushMicrotasks();

        expect(resolved).toHaveBeenCalledTimes(settled ? 1 : 0);
        if (!settled) {
          const request = worker.postMessage.mock.calls
            .map(([value]) => value as { type?: string; requestId?: number })
            .findLast((value) => value.type === 'snapshotMessages');
          worker.emitMessage({
            type: 'messageSnapshot',
            requestId: request?.requestId,
            epoch: 0,
            activeMessageIds: [message.id],
            pendingMessageIds: [],
            processedBatchSequence: 1,
          });
          await expect(snapshot).resolves.toEqual([{ message, trackDrops: false }]);
        } else {
          await expect(snapshot).resolves.toEqual([{ message, trackDrops: true }]);
        }
      } finally {
        manager.destroy();
        worker.acknowledgeDestroy();
        vi.useRealTimers();
      }
    }
  );

  it('ignores wrong-request, malformed, and future-sequence snapshots until a valid reply', async () => {
    vi.useFakeTimers();
    const { manager, worker } = initializedManager();
    const message: ChatMessage = {
      id: 'snapshot-valid-reply',
      text: 'recover valid reply',
      content: [{ type: 'text', content: 'recover valid reply' }],
      timestamp: 1,
      kind: 'text',
      authorType: 'normal',
    };

    try {
      expect(manager.sendToWorker(message, message.id)).toBe(true);
      await flushMicrotasks();
      const resolved = vi.fn();
      const snapshot = manager.snapshotMessages().then((messages) => {
        resolved(messages);
        return messages;
      });
      const request = worker.postMessage.mock.calls
        .map(([value]) => value as { type?: string; requestId?: number })
        .findLast((value) => value.type === 'snapshotMessages');
      expect(request?.requestId).toBeDefined();
      const valid = {
        type: 'messageSnapshot',
        requestId: request?.requestId,
        epoch: 0,
        activeMessageIds: [message.id],
        pendingMessageIds: [],
        processedBatchSequence: 1,
      };
      worker.emitMessage({ ...valid, requestId: (request?.requestId ?? 0) + 1 });
      worker.emitMessage({ ...valid, pendingMessageIds: [null] });
      worker.emitMessage({ ...valid, processedBatchSequence: 2 });
      vi.advanceTimersByTime(249);
      await flushMicrotasks();
      expect(resolved).not.toHaveBeenCalled();

      worker.emitMessage(valid);
      await expect(snapshot).resolves.toEqual([{ message, trackDrops: false }]);
      expect(resolved).toHaveBeenCalledTimes(1);
    } finally {
      manager.destroy();
      worker.acknowledgeDestroy();
      vi.useRealTimers();
    }
  });

  it('attaches validated active motion only to the retained current-epoch message', async () => {
    const { manager, worker } = initializedManager();
    const message: ChatMessage = {
      id: 'active-motion',
      text: 'active motion',
      content: [{ type: 'text', content: 'active motion' }],
      timestamp: 1,
      kind: 'text',
      authorType: 'normal',
    };
    expect(manager.sendToWorker(message, message.id)).toBe(true);
    await Promise.resolve();
    const snapshot = manager.snapshotMessages(1_000);
    const request = worker.postMessage.mock.calls
      .map(([value]) => value as { type?: string; requestId?: number; epoch?: number })
      .findLast((value) => value.type === 'snapshotMessages');
    expect(request?.epoch).toBe(0);
    const activeMotion = {
      id: message.id,
      mode: 'scroll',
      startX: 640,
      width: 100,
      height: 20,
      y: 20,
      laneIndex: 1,
      laneSlotCount: 1,
      durationMs: 5_000,
      startEpochMs: 11_000,
      fadeStartEpochMs: 10_900,
      speedTier: 1,
    };
    worker.emitMessage({
      type: 'messageSnapshot',
      requestId: request?.requestId,
      epoch: 0,
      activeMessageIds: [message.id],
      pendingMessageIds: [],
      processedBatchSequence: 1,
      motionSnapshot: {
        capturedAtEpochMs: 10_600,
        effectiveNowEpochMs: 10_000,
        isPaused: true,
        viewportWidthPx: 640,
        exitPaddingPx: 100,
        activeMotions: [activeMotion],
      },
    });
    await expect(snapshot).resolves.toEqual([
      {
        message,
        trackDrops: false,
        activeMotion: {
          ...activeMotion,
          epoch: 0,
          capturedAtEpochMs: 10_600,
          effectiveNowEpochMs: 10_000,
          isPaused: true,
          viewportWidthPx: 640,
          exitPaddingPx: 100,
        },
      },
    ]);
    manager.destroy();
    worker.acknowledgeDestroy();
  });

  it('uses explicit ID-only requeue when the Worker snapshot epoch is stale', async () => {
    const { manager, worker } = initializedManager();
    const message: ChatMessage = {
      id: 'stale-motion',
      text: 'stale motion',
      content: [{ type: 'text', content: 'stale motion' }],
      timestamp: 1,
      kind: 'text',
      authorType: 'normal',
    };
    manager.sendToWorker(message, message.id);
    await Promise.resolve();
    const snapshot = manager.snapshotMessages(1_000);
    const request = worker.postMessage.mock.calls
      .map(([value]) => value as { type?: string; requestId?: number })
      .findLast((value) => value.type === 'snapshotMessages');
    worker.emitMessage({
      type: 'messageSnapshot',
      requestId: request?.requestId,
      epoch: 1,
      activeMessageIds: [message.id],
      pendingMessageIds: [],
      processedBatchSequence: 1,
    });
    await expect(snapshot).resolves.toEqual([{ message, trackDrops: true }]);
    manager.destroy();
    worker.acknowledgeDestroy();
  });

  it('keeps a receipted batch recoverable until stats or snapshot observes it', async () => {
    const { manager, worker } = initializedManager();
    const message: ChatMessage = {
      id: 'receipt-is-not-recovery-watermark',
      text: 'recover me',
      content: [{ type: 'text', content: 'recover me' }],
      timestamp: 1,
      kind: 'text',
      authorType: 'normal',
    };
    manager.sendToWorker(message, message.id);
    await flushMicrotasks();
    worker.emitMessage({
      type: 'batchReceipt',
      epoch: 0,
      batchSequence: 1,
      pendingQueueDepth: 1,
      admittedMessages: 1,
      minimumPendingPriority: 0,
    });

    await expect(manager.snapshotMessages(0)).resolves.toEqual([{ message, trackDrops: true }]);
    manager.destroy();
    worker.acknowledgeDestroy();
  });

  it('releases ownership immediately and resets queue accounting after the matching clear fence ack', async () => {
    const settings = { ...DEFAULT_SETTINGS, queueMaxSize: 50 };
    const { manager, worker } = initializedManager(settings);
    const message: ChatMessage = {
      id: 'before-clear',
      text: 'before clear',
      content: [{ type: 'text', content: 'before clear' }],
      timestamp: 1,
      kind: 'text',
      authorType: 'normal',
    };
    manager.sendToWorker(message, message.id);
    await flushMicrotasks();
    worker.emitMessage({
      type: 'batchReceipt',
      epoch: 0,
      batchSequence: 1,
      pendingQueueDepth: 50,
      admittedMessages: 1,
      minimumPendingPriority: 0,
    });
    expect(manager.isCurrentMessage(message.id!, message)).toBe(true);
    manager.clearState();
    expect(manager.isCurrentMessage(message.id!, message)).toBe(false);
    worker.emitMessage({
      type: 'batchReceipt',
      epoch: 0,
      batchSequence: 1,
      pendingQueueDepth: 7,
      admittedMessages: 1,
      minimumPendingPriority: 0,
    });

    expect(manager.queueDepth).toBe(50);
    worker.emitMessage({ type: 'clearStateAck', epoch: 0 });
    expect(manager.queueDepth).toBe(50);
    expect(manager.isCurrentMessage(message.id!, message)).toBe(false);
    worker.emitMessage({ type: 'clearStateAck', epoch: 1 });
    expect(manager.queueDepth).toBe(0);
    expect(manager.isCurrentMessage(message.id!, message)).toBe(false);
    manager.destroy();
    worker.acknowledgeDestroy();
  });

  it('recovers bounded deferred paid ingress without dispatching it during fallback', async () => {
    const settings = { ...DEFAULT_SETTINGS, queueMaxSize: 50 };
    const { manager, worker } = initializedManager(settings, (message) =>
      message.kind === 'superchat' ? 100 : 0
    );
    const seed: ChatMessage = {
      id: 'admission-seed',
      text: 'seed',
      content: [{ type: 'text', content: 'seed' }],
      timestamp: 1,
      kind: 'text',
      authorType: 'normal',
    };
    manager.sendToWorker(seed, seed.id);
    await flushMicrotasks();
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
    worker.postMessage.mockClear();
    worker.emitMessage({
      type: 'batchReceipt',
      epoch: 0,
      batchSequence: 1,
      pendingQueueDepth: 50,
      admittedMessages: 0,
      minimumPendingPriority: 100,
    });
    const paid: ChatMessage = {
      id: 'deferred-paid',
      text: 'paid',
      content: [{ type: 'text', content: 'paid' }],
      timestamp: 1,
      kind: 'superchat',
      authorType: 'normal',
      superChat: { amount: '$5', tier: 'blue' },
    };
    expect(manager.sendToWorker(paid, paid.id)).toBe(true);
    manager.setActive(false);

    await expect(manager.snapshotMessages(0)).resolves.toEqual([
      { message: paid, trackDrops: true },
    ]);
    expect(
      worker.postMessage.mock.calls.filter(
        ([message]) => (message as { type?: string }).type === 'addMessages'
      )
    ).toHaveLength(0);
    manager.destroy();
    worker.acknowledgeDestroy();
  });

  it('does not resurrect pre-clear ownership if the Worker fails before the fence ack', async () => {
    const { manager, worker } = initializedManager();
    const message: ChatMessage = {
      id: 'cleared-before-ack',
      text: 'cleared',
      content: [{ type: 'text', content: 'cleared' }],
      timestamp: 1,
      kind: 'text',
      authorType: 'normal',
    };
    manager.sendToWorker(message, message.id);
    await flushMicrotasks();
    manager.clearState();
    manager.setActive(false);

    await expect(manager.snapshotMessages(0)).resolves.toEqual([]);
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
