// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'self', {
    value: globalThis,
    writable: true,
    configurable: true,
  });
});

// ── Mock browser APIs before module import ───────────────────────────────

const mockCtx = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  measureText: vi.fn(() => ({
    width: 100,
    actualBoundingBoxAscent: 16,
    actualBoundingBoxDescent: 4,
  })),
  fillText: vi.fn(),
  fillRect: vi.fn(),
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
  putImageData: vi.fn(),
  getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(100) })),
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

const MockOffscreenCanvas = class {
  getContext() {
    return mockCtx;
  }
};

vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);
vi.stubGlobal(
  'ImageBitmap',
  class {
    close() {}
  }
);
vi.stubGlobal('OffscreenCanvasRenderingContext2D', class {});
vi.stubGlobal(
  'createImageBitmap',
  vi.fn(() => Promise.resolve({ close: vi.fn() }))
);

let rAFId = 1;
vi.stubGlobal(
  'requestAnimationFrame',
  vi.fn(() => rAFId++)
);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

// PostMessage spy — attach to the actual self/window BEFORE module import
const postMessageSpy = vi.fn();
// Use Object.defineProperty on self to intercept postMessage
// The module does: self.postMessage(...)
// We want to spy on self.postMessage without replacing self entirely
Object.defineProperty(self, 'postMessage', {
  value: postMessageSpy,
  writable: true,
  configurable: true,
});

vi.spyOn(performance, 'now').mockReturnValue(10000);

// ═══════════════════════════════════════════════════════════════════════════
// Import module — it sets self.onmessage at module scope
// ═══════════════════════════════════════════════════════════════════════════

import { MAX_RENDER_FIELD_CODE_POINTS } from '@chat/render-resource-limits';
import { getBidiLayoutCacheUsage, resolveTextDirection } from '@renderer/canvas/bidi-layout';
import type { CardConfigWorker } from '@renderer/card-config';
import { GRADIENT_CACHE_MAX } from '@renderer/constants';
import { motionPlanFromMessage, motionPlansCollide } from '@renderer/layout/message-schedule';
import { getRowSlotCount } from '@renderer/layout/row-geometry';
import { isValidWorkerMessageSnapshot } from '@renderer/worker/protocol-guards';
import { resetWorkerForTests, WorkerRenderer } from '@renderer/worker/renderer';
import type { ActiveMessage, WorkerMessage } from '@renderer/worker/types';

vi.mock('@media/bounded-image-response', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@media/bounded-image-response')>()),
  MAX_WORKER_IMAGE_BYTES: 16,
}));

// ── Helpers ───────────────────────────────────────────────────────────────

function imageResponse(ok = true, finalUrl = 'https://yt3.ggpht.com/image'): Response {
  const response = new Response(new Blob(['image']), { status: ok ? 200 : 404 });
  Object.defineProperty(response, 'url', { value: finalUrl });
  return response;
}

function makeMinimalConfig(): Record<string, unknown> {
  return {
    fontSize: 16,
    speedPxPerSec: 100,
    fontFamily: 'sans-serif',
    opacity: 1,
    safeTop: 0.05,
    safeBottom: 0.05,
    laneSpacing: 4,
    maxConcurrentMessages: 200,
    danmakuMode: 'scroll',
    backlogSpeedMultiplier: 1,
    depthLayersEnabled: false,
    depthFarSpeedMul: 1,
    depthNearSpeedMul: 1,
    depthFarOpacityMul: 0.6,
    motionBlurEnabled: false,
    motionBlurAlpha: 0.03,
    backlogOpacityMultiplier: 0.5,
    fadeDurationMs: 300,
    maxMessageAgeMs: 30000,
    color: '#fff',
    authorColors: {},
    backgroundColors: {},
    modOwnerDurationMultiplier: 1.5,
    outlineWidthPx: 2,
    outlineOpacity: 0.8,
    superChatOpacity: 0.85,
    superChatMaxBodyLines: 2,
    membershipMaxBodyLines: 2,
    showAuthor: {},
    translationEnabled: false,
    translationMode: 'dual',
    showSuperChatAmount: true,
    exitPaddingPx: 100,
    scrollDurationMinMs: 1000,
    scrollDurationMaxMs: 15000,
    topBottomDurationMs: 5000,
    headwayGapRatio: 0.08,
    queueMaxSize: 500,
    backgroundQueueMax: 200,
    emojiCacheMb: 4,
    photoCacheMb: 2,
    stickerCacheMb: 2,
    textCacheMb: 4,
    translationBatchSize: 5,
    emojiFetchLimit: 10,
    failedEmojiRetryMins: 5,
    staggerMaxDelayMs: 200,
    staggerMediumDelayMs: 100,
    emojiFetchTimeoutMs: 5000,
    ignoreReducedMotion: false,
    reducedMotion: false,
    preserveUserColor: false,
    isReplayMode: false,
    fontWeight: 'bold',
  };
}

function getHandler(): (e: MessageEvent) => void {
  // Module sets self.onmessage at import time
  const handler = (self as unknown as Record<string, unknown>).onmessage;
  if (typeof handler !== 'function') {
    throw new Error(
      `self.onmessage not set — type=${typeof handler}, keys: ${Object.keys(self).slice(0, 5).join(',')}`
    );
  }
  return handler as (e: MessageEvent) => void;
}

function makeEvent(data: Record<string, unknown>): MessageEvent {
  return { data } as MessageEvent;
}

function makeWorkerMessage(overrides: Partial<WorkerMessage> = {}): WorkerMessage {
  return {
    id: 'worker-message',
    text: 'hello',
    width: 100,
    height: 20,
    priority: 0,
    isBacklog: false,
    ...overrides,
  };
}

function initializeRenderer(configOverrides: Record<string, unknown> = {}): WorkerRenderer {
  const renderer = new WorkerRenderer();
  renderer.handleMessage(
    makeEvent({
      type: 'init',
      config: { ...makeMinimalConfig(), ...configOverrides },
      canvas: new MockOffscreenCanvas(),
      dpr: 1,
      width: 640,
      height: 360,
    })
  );
  return renderer;
}

function workerLaneHeight(renderer: WorkerRenderer): number {
  return (renderer as unknown as { laneHeight: number }).laneHeight;
}

function prepareGradientPaidCard() {
  const renderer = initializeRenderer({ danmakuMode: 'top' });
  const card: CardConfigWorker = {
    background: 'gradient',
    backgroundGradient: { topBoost: 0.12, bottomReduction: 0.15, minOpacity: 0.35 },
    decoration: 'none',
    badgeEnabled: false,
    badgeFillColor: '',
    badgeStrokeColor: '',
    badgeRadius: 0,
    badgePaddingH: 0,
    badgePaddingV: 0,
    badgeStrokeWidth: 0,
    headerTagEnabled: false,
    headerTagFontSizeScale: 1,
    headerTagColor: '',
    headerTagMarginTop: 0,
    headerTagMarginBottom: 0,
    authorShow: false,
    authorNameMaxWidth: 0,
    bodyMaxLines: 1,
    bodyMarginTop: 0,
    stickerEnabled: false,
    stickerSizeScale: 1,
    stickerMarginTop: 0,
    showBadgeAmount: false,
    padding: { horizontal: 0, vertical: 0 },
    cardRadius: 0,
    textColor: '#fff',
    resolveColorRgb: { r: 0, g: 0, b: 0 },
    needsGradientCache: true,
    needsElapsed: false,
  };
  const message: ActiveMessage = {
    id: 'paid-gradient',
    x: 100,
    y: 20,
    startX: 100,
    width: 120,
    height: 40,
    startTime: 0,
    fadeStartTime: 0,
    duration: 30_000,
    invDuration: 1 / 30_000,
    pausedDuration: 0,
    laneIndex: 0,
    laneSlotCount: 1,
    laneArrayIndices: [],
    speedTier: 1,
    text: '',
    color: '#fff',
    content: [],
    ghostText: '',
    kind: 'superchat',
    cardConfigWorker: card,
  };
  const internals = renderer as unknown as {
    activeMessages: ActiveMessage[];
    superChatGradientCache: {
      size: number;
      has(key: string): boolean;
      keys(): IterableIterator<string>;
    };
    renderFrame(): void;
  };
  internals.activeMessages.push(message);
  const renderColor = (red: number) => {
    card.resolveColorRgb = { r: red, g: 0, b: 0 };
    internals.renderFrame();
  };
  return { renderer, internals, message, renderColor };
}

describe('Worker reservation safety', () => {
  it.each([
    {
      name: 'mixed heights with only 1px clearance',
      activeY: 5,
      activeHeight: 46,
      candidateY: 52,
      allowed: false,
    },
    {
      name: 'exactly 8px of clearance',
      activeY: 0,
      activeHeight: 44,
      candidateY: 52,
      allowed: true,
    },
    {
      name: 'fractional safe-zone origin at exact clearance',
      activeY: 15.99,
      activeHeight: 44,
      candidateY: 67.99,
      allowed: true,
    },
    {
      name: 'fractional origin with 7.9px clearance',
      activeY: 15.99,
      activeHeight: 44.1,
      candidateY: 67.99,
      allowed: false,
    },
  ])(
    'checks normal Worker admission for $name',
    ({ activeY, activeHeight, candidateY, allowed }) => {
      const renderer = initializeRenderer({
        danmakuMode: 'top',
        laneSpacing: 8,
        safeTop: activeY === 15.99 ? 15.99 / 360 : 0,
      });
      const placement = {
        laneIndex: 4,
        waitMs: 0,
        laneY: candidateY,
        slotCount: 4,
        verticalOffset: 0,
      };
      const active = {
        y: activeY,
        height: activeHeight,
        width: 100,
        startX: 270,
        startTime: 0,
        pausedDuration: 0,
        duration: 5000,
        invDuration: 1 / 5000,
      };
      const internals = renderer as unknown as {
        activeMessagesByLane: Map<number, (typeof active)[]>;
        checkCollision(
          candidatePlacement: typeof placement,
          entry: WorkerMessage,
          speedTier: number,
          batchIndex: number,
          previousStaggerDelayMs: number,
          now: number,
          width: number,
          precomputedMotion: ReturnType<typeof motionPlanFromMessage>
        ): boolean;
      };
      for (let lane = 0; lane < getRowSlotCount(activeHeight, 13, 8); lane++) {
        internals.activeMessagesByLane.set(lane, [active]);
      }
      const motion = motionPlanFromMessage(
        {
          startTime: 1000,
          pausedDuration: 0,
          startX: 270,
          width: 100,
          duration: 5000,
        },
        'top',
        640,
        100
      );
      expect(
        internals.checkCollision(
          placement,
          makeWorkerMessage({ width: 100, height: 44 }),
          1,
          0,
          0,
          1000,
          640,
          motion
        )
      ).toBe(allowed);
    }
  );

  it('reflows a geometry update without losing the fixed-row gap or lane index', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000);
    const renderer = initializeRenderer({
      danmakuMode: 'top',
      laneSpacing: 8,
      safeTop: 0,
      safeBottom: 0,
      outlineWidthPx: 0,
    });
    renderer.handleMessage(makeEvent({ type: 'laneDensity', factor: 0.5 }));
    const internals = renderer as unknown as {
      laneHeight: number;
      activeMessages: ActiveMessage[];
      activeMessagesByLane: Map<number, ActiveMessage[]>;
      drainQueue(now: number, width: number, height: number): void;
    };
    const baselineHeight = internals.laneHeight * 4 - 8;
    renderer.handleMessage(
      makeEvent({
        type: 'addMessages',
        messages: [
          makeWorkerMessage({ id: 'first', height: baselineHeight }),
          makeWorkerMessage({ id: 'second', height: baselineHeight }),
        ],
      })
    );
    internals.drainQueue(10_000, 640, 360);
    expect(internals.activeMessages.map(({ laneIndex }) => laneIndex)).toEqual([0, 4]);
    renderer.handleMessage(
      makeEvent({
        type: 'updateMessageGeometries',
        geometries: [{ id: 'first', width: 100, height: baselineHeight + 2 }],
      })
    );
    const [first, second] = internals.activeMessages;
    expect(internals.activeMessages).toHaveLength(2);
    if (!first || !second) throw new Error('Worker row was lost during reflow');
    expect([first.laneIndex, second.laneIndex]).toEqual([0, 5]);
    expect(second.y - (first.y + first.height)).toBeGreaterThanOrEqual(8);
    expect(internals.activeMessagesByLane.get(second.laneIndex)).toContain(second);
  });

  it('budgets failed placement work and rotates through all priority groups', () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const renderer = initializeRenderer();
    const internals = renderer as unknown as {
      pendingQueue: WorkerMessage[];
      drainCursors: Map<number, WorkerMessage>;
      findPlacement: ReturnType<typeof vi.fn>;
      drainQueue(now: number, width: number, height: number): void;
    };
    internals.pendingQueue.push(
      ...[200, 100, 0].map((priority) =>
        makeWorkerMessage({ id: `priority-${priority}`, priority })
      )
    );
    internals.findPlacement = vi.fn(() => {
      clock += 2;
      return null;
    });
    internals.drainQueue(0, 640, 360);
    expect(internals.findPlacement.mock.calls.map((args) => args[1])).toHaveLength(2);
    // Pending identity cursors, rather than dequeues, retain every failure.
    expect(internals.pendingQueue).toHaveLength(3);
    expect([...internals.drainCursors.keys()]).toEqual([200, 100]);
    internals.drainQueue(16, 640, 360);
    expect(internals.findPlacement).toHaveBeenCalledTimes(4);
    expect(internals.drainCursors.get(0)?.id).toBe('priority-0');
    expect(internals.pendingQueue).toHaveLength(3);
  });

  function setup(mode: 'scroll' | 'reverse' | 'top' = 'scroll', reducedMotion = false) {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const renderer = initializeRenderer({
      danmakuMode: mode,
      reducedMotion,
      speedPxPerSec: 350,
      laneSpacing: 0,
      scrollDurationMinMs: 5000,
      scrollDurationMaxMs: 30000,
      outlineWidthPx: 0,
      outlineOpacity: 0,
      safeTop: 0,
      safeBottom: 0,
    });
    const internals = renderer as unknown as {
      laneHeap: [number, number][];
      laneIndexToHeapIndex: Map<number, number>;
      numLanes: number;
      laneHeight: number;
      logicalHeight: number;
      activeMessages: ActiveMessage[];
      pendingQueue: WorkerMessage[];
      totalDrops: number;
      dropReasons: { oversized: number; reflow_capacity: number };
      drainQueue(now: number, width: number, height: number): void;
      reflowActiveMessages(): void;
    };
    internals.laneHeap = [
      [0, 0],
      [1, 0],
    ];
    internals.laneIndexToHeapIndex = new Map([
      [0, 0],
      [1, 1],
    ]);
    internals.numLanes = 2;
    internals.laneHeight = 20;
    internals.logicalHeight = 40;
    for (const id of ['first', 'short', 'long']) {
      internals.pendingQueue.push({
        id,
        text: id,
        content: [{ type: 'text', content: id }],
        priority: 0,
        isBacklog: false,
        kind: 'text',
        authorType: 'normal',
        width: id === 'short' ? 100 : 600,
        height: 20,
      });
    }
    return { renderer, internals };
  }

  it('uses local Worker canvas metrics before admitting transferred fixed geometry', () => {
    (mockCtx as typeof mockCtx & { canvas?: InstanceType<typeof MockOffscreenCanvas> }).canvas =
      new MockOffscreenCanvas();
    try {
      const renderer = initializeRenderer({ danmakuMode: 'top', safeTop: 0, safeBottom: 0 });
      const internals = renderer as unknown as { pendingQueue: WorkerMessage[] };
      const text = 'long content '.repeat(12);
      renderer.handleMessage(
        makeEvent({
          type: 'addMessages',
          messages: [
            makeWorkerMessage({
              id: 'local-geometry',
              text,
              content: [{ type: 'text', content: text }],
              width: 2000,
              height: 1,
            }),
          ],
        })
      );
      expect(internals.pendingQueue[0]?.width).toBeLessThanOrEqual(640);
      expect(internals.pendingQueue[0]?.height).toBeGreaterThan(1);
    } finally {
      delete (mockCtx as typeof mockCtx & { canvas?: InstanceType<typeof MockOffscreenCanvas> })
        .canvas;
    }
  });

  it.each(['scroll', 'reverse'] as const)(
    'checks future reservations and uses an alternative lane in %s',
    (mode) => {
      const { internals } = setup(mode);
      internals.drainQueue(0, 640, 40);
      expect(internals.activeMessages).toHaveLength(3);
      const short = internals.activeMessages.find((m) => m.id === 'short');
      const long = internals.activeMessages.find((m) => m.id === 'long');
      expect(short?.startTime).toBeGreaterThan(0);
      expect(long?.laneIndex).not.toBe(short?.laneIndex);
      for (const a of internals.activeMessages) {
        for (const b of internals.activeMessages) {
          if (a === b || a.y + a.height <= b.y || b.y + b.height <= a.y) continue;
          expect(
            motionPlansCollide(
              motionPlanFromMessage(a, mode, 640, 100),
              motionPlanFromMessage(b, mode, 640, 100),
              0.08,
              0
            )
          ).toBe(false);
        }
      }
    }
  );

  it('preserves future starts and resolves fixed capacity when reflow shrinks the lane range', () => {
    const { internals } = setup('top');
    internals.drainQueue(0, 640, 40);
    const futureStarts = new Map(internals.activeMessages.map((m) => [m.id, m.startTime]));
    expect([...futureStarts.values()].some((time) => time > 0)).toBe(true);
    internals.numLanes = 1;
    internals.logicalHeight = 20;
    internals.reflowActiveMessages();
    expect(internals.totalDrops).toBe(1);
    expect(internals.dropReasons.reflow_capacity).toBe(1);
    expect(internals.activeMessages).toHaveLength(2);
    expect(internals.activeMessages.every((m) => m.startTime === futureStarts.get(m.id))).toBe(
      true
    );
    for (const a of internals.activeMessages) {
      for (const b of internals.activeMessages) {
        if (a === b) continue;
        expect(
          motionPlansCollide(
            motionPlanFromMessage(a, 'top', 640, 100),
            motionPlanFromMessage(b, 'top', 640, 100),
            0.08,
            0
          )
        ).toBe(false);
      }
    }
  });

  it('labels an active message that becomes taller than the viewport on reflow', () => {
    const { internals } = setup('top');
    internals.drainQueue(0, 640, 40);
    const first = internals.activeMessages[0];
    expect(first).toBeDefined();
    if (!first) return;
    first.height = 10_000;
    internals.reflowActiveMessages();
    expect(internals.dropReasons.oversized).toBe(1);
  });

  it('reconciles a live reduced-motion preference change before drawing', () => {
    const { renderer, internals } = setup();
    internals.drainQueue(0, 640, 40);
    renderer.handleMessage(makeEvent({ type: 'updateConfig', config: { reducedMotion: true } }));
    expect(
      internals.activeMessages.every(
        (m) => m.motion?.mode === 'top' && m.x === Math.floor((640 - m.width) / 2)
      )
    ).toBe(true);
    for (const a of internals.activeMessages) {
      for (const b of internals.activeMessages) {
        if (a === b || a.y + a.height <= b.y || b.y + b.height <= a.y) continue;
        expect(a.motion && b.motion && motionPlansCollide(a.motion, b.motion, 0.08, 0)).toBe(false);
      }
    }
    renderer.handleMessage(
      makeEvent({ type: 'updateConfig', config: { ignoreReducedMotion: true } })
    );
    expect(internals.activeMessages.every((m) => m.motion?.mode === 'scroll')).toBe(true);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  // Spy on performance.now again (clearAllMocks removes it)
  vi.spyOn(performance, 'now').mockReturnValue(10000);
  resetWorkerForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Worker module', () => {
  it('keeps Worker row geometry tied to fontSize across resize and active changes', () => {
    mockCtx.measureText.mockImplementation(() => {
      const size = Number.parseInt(mockCtx.font, 10);
      return {
        width: 100,
        actualBoundingBoxAscent: size * 0.8,
        actualBoundingBoxDescent: size * 0.2,
      };
    });
    try {
      const renderer = initializeRenderer({ fontSize: 20 });
      const initialHeight = workerLaneHeight(renderer);
      expect(initialHeight).toBeGreaterThan(0);

      renderer.handleMessage(makeEvent({ type: 'resize', width: 1280, height: 720, dpr: 1 }));
      expect(workerLaneHeight(renderer)).toBe(initialHeight);

      renderer.handleMessage(makeEvent({ type: 'updateConfig', config: { fontSize: 40 } }));
      expect(workerLaneHeight(renderer)).toBeGreaterThan(initialHeight);
    } finally {
      mockCtx.measureText.mockImplementation(() => ({
        width: 100,
        actualBoundingBoxAscent: 16,
        actualBoundingBoxDescent: 4,
      }));
    }
  });

  it('sets self.onmessage at import time', () => {
    expect(typeof getHandler()).toBe('function');
  });

  it('resetWorkerForTests does not throw', () => {
    expect(() => resetWorkerForTests()).not.toThrow();
  });
});

describe('Worker paid-card gradient cache integration', () => {
  it('reuses rendered gradients and promotes them before the bounded capacity evicts the oldest', () => {
    const { renderer, internals, renderColor } = prepareGradientPaidCard();
    const cache = internals.superChatGradientCache;

    renderColor(0);
    const firstKey = [...cache.keys()][0];
    renderColor(0);
    expect(mockCtx.createLinearGradient).toHaveBeenCalledTimes(1);

    renderColor(1);
    const secondKey = [...cache.keys()][1];
    if (firstKey === undefined || secondKey === undefined) {
      throw new Error('Expected two paid-card gradient keys');
    }
    for (let red = 2; red < GRADIENT_CACHE_MAX; red++) renderColor(red);
    expect(cache.size).toBe(GRADIENT_CACHE_MAX);
    expect(mockCtx.createLinearGradient).toHaveBeenCalledTimes(GRADIENT_CACHE_MAX);

    renderColor(0);
    expect(mockCtx.createLinearGradient).toHaveBeenCalledTimes(GRADIENT_CACHE_MAX);
    renderColor(GRADIENT_CACHE_MAX);
    expect(cache.size).toBe(GRADIENT_CACHE_MAX);
    expect(cache.has(firstKey)).toBe(true);
    expect(cache.has(secondKey)).toBe(false);
    renderColor(1);
    expect(mockCtx.createLinearGradient).toHaveBeenCalledTimes(GRADIENT_CACHE_MAX + 2);
    renderer.handleMessage(makeEvent({ type: 'destroy' }));
  });

  it('retains gradients across same-context state reset and invalidates them for style, init, and destroy', () => {
    const { renderer, internals, message, renderColor } = prepareGradientPaidCard();
    const cache = internals.superChatGradientCache;

    renderColor(7);
    expect(cache.size).toBe(1);
    renderer.handleMessage(makeEvent({ type: 'clearState', epoch: 1 }));
    expect(cache.size).toBe(1);
    internals.activeMessages.push(message);
    renderColor(7);
    expect(mockCtx.createLinearGradient).toHaveBeenCalledTimes(1);

    renderer.handleMessage(makeEvent({ type: 'updateConfig', config: { superChatOpacity: 0.7 } }));
    expect(cache.size).toBe(0);
    renderColor(7);
    expect(mockCtx.createLinearGradient).toHaveBeenCalledTimes(2);

    const nextCtx = {
      ...mockCtx,
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    };
    renderer.handleMessage(
      makeEvent({
        type: 'init',
        config: makeMinimalConfig(),
        canvas: { getContext: () => nextCtx },
        dpr: 1,
        width: 640,
        height: 360,
      })
    );
    expect(cache.size).toBe(0);
    renderColor(7);
    expect(mockCtx.createLinearGradient).toHaveBeenCalledTimes(2);
    expect(nextCtx.createLinearGradient).toHaveBeenCalledOnce();
    renderer.handleMessage(makeEvent({ type: 'destroy' }));
    expect(cache.size).toBe(0);
  });
});

describe('Worker message protocol', () => {
  it('clears its realm-local bidi caches with renderer state', () => {
    const renderer = initializeRenderer();
    resolveTextDirection('مرحبا');
    expect(getBidiLayoutCacheUsage().direction.entries).toBe(1);

    renderer.handleMessage(makeEvent({ type: 'clearState' }));

    expect(getBidiLayoutCacheUsage().direction.entries).toBe(0);
  });

  it('rejects a translation that would exceed the message aggregate budget', () => {
    const renderer = initializeRenderer();
    const originalText = 'a'.repeat(MAX_RENDER_FIELD_CODE_POINTS - 10);
    renderer.handleMessage(
      makeEvent({
        type: 'addMessages',
        messages: [
          makeWorkerMessage({
            id: 'aggregate-translation',
            text: originalText,
            content: [{ type: 'text', content: originalText }],
          }),
        ],
      })
    );
    renderer.handleMessage(
      makeEvent({
        type: 'updateTranslation',
        id: 'aggregate-translation',
        translatedText: 'translated text',
        width: 200,
        height: 40,
        translationHeight: 20,
      })
    );

    const internals = renderer as unknown as {
      messageById: Map<string, { translatedText?: string | null }>;
    };
    expect(internals.messageById.get('aggregate-translation')?.translatedText).toBeUndefined();
  });

  it('upserts pending and active replacement messages by id', () => {
    const renderer = initializeRenderer({ outlineWidthPx: 0 });
    const internals = renderer as unknown as {
      pendingQueue: WorkerMessage[];
      activeMessages: Array<{ id: string; text: string; width: number; content: unknown[] }>;
      drainQueue(now: number, width: number, height: number): void;
    };
    const original = makeWorkerMessage({
      id: 'replacement',
      text: 'original',
      content: [{ type: 'text', content: 'original' }],
    });

    renderer.handleMessage(makeEvent({ type: 'addMessages', messages: [original] }));
    renderer.handleMessage(
      makeEvent({
        type: 'addMessages',
        messages: [
          makeWorkerMessage({
            id: 'replacement',
            text: 'pending update',
            width: 180,
            actionType: 'replace',
            content: [{ type: 'text', content: 'pending update' }],
          }),
        ],
      })
    );

    expect(internals.pendingQueue).toHaveLength(1);
    expect(internals.pendingQueue[0]).toMatchObject({ text: 'pending update', width: 180 });

    internals.drainQueue(10_000, 640, 360);
    expect(internals.activeMessages).toHaveLength(1);

    renderer.handleMessage(
      makeEvent({
        type: 'addMessages',
        messages: [
          makeWorkerMessage({
            id: 'replacement',
            text: 'active update',
            width: 220,
            actionType: 'replace',
            content: [{ type: 'text', content: 'active update' }],
          }),
        ],
      })
    );

    expect(internals.activeMessages).toHaveLength(1);
    expect(internals.activeMessages[0]).toMatchObject({
      text: 'active update',
      width: 220,
      content: [{ type: 'text', content: 'active update' }],
    });
  });

  it('drops a previous canonical body when an active message is replaced by compact text', () => {
    const renderer = initializeRenderer({ outlineWidthPx: 0 });
    const internals = renderer as unknown as {
      activeMessages: Array<{ id: string; text: string; canonicalText?: string }>;
      drainQueue(now: number, width: number, height: number): void;
    };
    renderer.handleMessage(
      makeEvent({
        type: 'addMessages',
        messages: [
          makeWorkerMessage({
            id: 'edited',
            text: 'A'.repeat(79) + '…',
            canonicalText: 'A'.repeat(90),
          }),
        ],
      })
    );
    internals.drainQueue(10_000, 640, 360);
    expect(internals.activeMessages[0]?.canonicalText).toBe('A'.repeat(90));
    renderer.handleMessage(
      makeEvent({
        type: 'addMessages',
        messages: [makeWorkerMessage({ id: 'edited', text: 'B', actionType: 'replace' })],
      })
    );
    expect(internals.activeMessages[0]).toMatchObject({ text: 'B' });
    expect(internals.activeMessages[0]).not.toHaveProperty('canonicalText');
  });

  it('rebuilds lane reservations when an active replacement uses fewer slots', () => {
    const renderer = initializeRenderer({ outlineWidthPx: 0 });
    const internals = renderer as unknown as {
      activeMessages: Array<{ laneIndex: number; laneSlotCount: number }>;
      speedTierLanes: Map<number, unknown>;
      laneHeap: Array<[number, number]>;
      drainQueue(now: number, width: number, height: number): void;
    };
    renderer.handleMessage(
      makeEvent({
        type: 'addMessages',
        messages: [makeWorkerMessage({ id: 'resized', height: 60 })],
      })
    );
    internals.drainQueue(10_000, 640, 360);
    const active = internals.activeMessages[0];
    expect(active?.laneSlotCount).toBeGreaterThan(1);
    const oldReservedLanes = Array.from(
      { length: active?.laneSlotCount ?? 0 },
      (_, offset) => (active?.laneIndex ?? 0) + offset
    );

    renderer.handleMessage(
      makeEvent({
        type: 'addMessages',
        messages: [
          makeWorkerMessage({
            id: 'resized',
            height: 20,
            actionType: 'replace',
          }),
        ],
      })
    );

    expect(active?.laneSlotCount).toBe(1);
    expect([...internals.speedTierLanes.keys()]).toEqual([active?.laneIndex]);
    const availabilityByLane = new Map(
      internals.laneHeap.map(([laneIndex, availableAt]) => [laneIndex, availableAt])
    );
    for (const releasedLane of oldReservedLanes.slice(1)) {
      expect(availabilityByLane.get(releasedLane)).toBe(10_000);
    }
  });

  it('updates pending geometry without resurrecting a missing message id', () => {
    const renderer = initializeRenderer();
    const internals = renderer as unknown as {
      pendingQueue: WorkerMessage[];
      messageById: Map<string, unknown>;
    };
    renderer.handleMessage(
      makeEvent({
        type: 'addMessages',
        messages: [makeWorkerMessage({ id: 'still-pending', width: 100, height: 20 })],
      })
    );

    renderer.handleMessage(
      makeEvent({
        type: 'updateMessageGeometries',
        geometries: [
          { id: 'still-pending', width: 180, height: 40 },
          { id: 'already-expired', width: 220, height: 60 },
        ],
      })
    );

    expect(internals.pendingQueue).toHaveLength(1);
    expect(internals.pendingQueue[0]).toMatchObject({
      id: 'still-pending',
      width: 180,
      height: 40,
    });
    expect(internals.messageById.has('already-expired')).toBe(false);
  });

  it('updates pending base geometry while a translation clear is waiting to apply', () => {
    const renderer = initializeRenderer({ translationGeneration: 0 });
    const internals = renderer as unknown as {
      pendingQueue: WorkerMessage[];
      applyPendingTranslations(): void;
    };
    renderer.handleMessage(
      makeEvent({
        type: 'addMessages',
        messages: [makeWorkerMessage({ id: 'clear-translation', width: 100, height: 20 })],
      })
    );
    renderer.handleMessage(
      makeEvent({
        type: 'updateTranslation',
        id: 'clear-translation',
        translatedText: null,
        width: 120,
        height: 24,
        translationHeight: 0,
        translationGeneration: 0,
      })
    );

    renderer.handleMessage(
      makeEvent({
        type: 'updateMessageGeometries',
        geometries: [{ id: 'clear-translation', width: 200, height: 50 }],
      })
    );
    internals.applyPendingTranslations();

    expect(internals.pendingQueue[0]).toMatchObject({
      id: 'clear-translation',
      width: 200,
      height: 50,
      translatedText: null,
      translationHeight: 0,
    });
  });

  it('updates a pending translation clear without replacing active translated geometry early', () => {
    const renderer = initializeRenderer({
      outlineWidthPx: 0,
      translationEnabled: true,
      translationMode: 'dual',
      translationGeneration: 0,
    });
    const internals = renderer as unknown as {
      activeMessages: Array<{
        id: string;
        width: number;
        height: number;
        translatedText?: string | null;
        translationHeight?: number;
        translatedContent?: Array<{ type: string; content: string }>;
      }>;
      drainQueue(now: number, width: number, height: number): void;
      applyPendingTranslations(): void;
    };
    renderer.handleMessage(
      makeEvent({
        type: 'addMessages',
        messages: [makeWorkerMessage({ id: 'active-clear-resize' })],
      })
    );
    internals.drainQueue(10_000, 640, 360);
    renderer.handleMessage(
      makeEvent({
        type: 'updateTranslation',
        id: 'active-clear-resize',
        translatedText: 'translated text',
        width: 180,
        height: 40,
        translationHeight: 12,
        translationGeneration: 0,
      })
    );
    internals.applyPendingTranslations();
    renderer.handleMessage(
      makeEvent({
        type: 'updateTranslation',
        id: 'active-clear-resize',
        translatedText: null,
        width: 120,
        height: 24,
        translationHeight: 0,
        translationGeneration: 0,
      })
    );

    renderer.handleMessage(
      makeEvent({
        type: 'updateMessageGeometries',
        geometries: [{ id: 'active-clear-resize', width: 200, height: 50 }],
      })
    );

    expect(internals.activeMessages[0]).toMatchObject({
      width: 180,
      height: 40,
      translatedText: 'translated text',
      translationHeight: 12,
      translatedContent: [{ type: 'text', content: 'translated text' }],
    });
    internals.applyPendingTranslations();
    expect(internals.activeMessages[0]).toMatchObject({
      width: 200,
      height: 50,
      translatedText: null,
      translationHeight: 0,
    });
    expect(internals.activeMessages[0]?.translatedContent).toBeUndefined();
  });

  it('preserves active translation state during a geometry-only resize update', () => {
    const renderer = initializeRenderer({
      outlineWidthPx: 0,
      translationEnabled: true,
      translationMode: 'dual',
      translationGeneration: 0,
    });
    const internals = renderer as unknown as {
      activeMessages: Array<{
        id: string;
        width: number;
        height: number;
        translatedText?: string | null;
        translationHeight?: number;
        translatedContent?: Array<{ type: string; content: string }>;
      }>;
      drainQueue(now: number, width: number, height: number): void;
      applyPendingTranslations(): void;
    };
    renderer.handleMessage(
      makeEvent({
        type: 'addMessages',
        messages: [makeWorkerMessage({ id: 'translated-resize' })],
      })
    );
    internals.drainQueue(10_000, 640, 360);
    renderer.handleMessage(
      makeEvent({
        type: 'updateTranslation',
        id: 'translated-resize',
        translatedText: 'translated text',
        width: 180,
        height: 40,
        translationHeight: 12,
        translationGeneration: 0,
      })
    );
    internals.applyPendingTranslations();

    renderer.handleMessage(
      makeEvent({
        type: 'updateMessageGeometries',
        geometries: [
          {
            id: 'translated-resize',
            width: 220,
            height: 50,
            translationHeight: 14,
          },
        ],
      })
    );

    expect(internals.activeMessages[0]).toMatchObject({
      id: 'translated-resize',
      width: 220,
      height: 50,
      translatedText: 'translated text',
      translationHeight: 14,
      translatedContent: [{ type: 'text', content: 'translated text' }],
    });
  });

  describe('init error case', () => {
    it('posts error when canvas getContext returns null', () => {
      const BadCanvas = class {
        getContext() {
          return null;
        }
      };
      vi.stubGlobal('OffscreenCanvas', BadCanvas);

      getHandler()(
        makeEvent({
          type: 'init',
          config: makeMinimalConfig(),
          canvas: new BadCanvas(),
          dpr: 1,
          width: 640,
          height: 360,
        })
      );

      expect(postMessageSpy).toHaveBeenCalledWith({
        type: 'error',
        error: 'Failed to get 2D context',
      });
    });

    it('posts a validated error when canvas context creation throws', () => {
      const ThrowingCanvas = class {
        getContext(): never {
          throw new Error('context creation failed');
        }
      };
      vi.stubGlobal('OffscreenCanvas', ThrowingCanvas);

      getHandler()(
        makeEvent({
          type: 'init',
          config: makeMinimalConfig(),
          canvas: new ThrowingCanvas(),
          dpr: 1,
          width: 640,
          height: 360,
        })
      );

      expect(postMessageSpy).toHaveBeenCalledWith({
        type: 'error',
        error: 'context creation failed',
      });
    });
  });

  describe('resize', () => {
    it('handles resize without errors after init', () => {
      getHandler()(
        makeEvent({
          type: 'init',
          config: makeMinimalConfig(),
          canvas: new MockOffscreenCanvas(),
          dpr: 1,
          width: 640,
          height: 360,
        })
      );
      postMessageSpy.mockClear();

      getHandler()(makeEvent({ type: 'resize', width: 640, height: 360, dpr: 1 }));

      const errors = postMessageSpy.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.type === 'error'
      );
      expect(errors.length).toBe(0);
    });
  });

  describe('renderer parity safeguards', () => {
    it('includes placement wait time in Worker activation timestamps', () => {
      const renderer = initializeRenderer();
      const internals = renderer as unknown as {
        activateMessage: (...args: unknown[]) => void;
        activeMessages: Array<{ startTime: number; fadeStartTime: number }>;
      };

      internals.activateMessage(
        makeWorkerMessage(),
        10_000,
        { laneIndex: 0, waitMs: 125, laneY: 0, slotCount: 1, verticalOffset: 0 },
        0,
        0,
        1,
        640,
        360
      );

      expect(internals.activeMessages[0]?.startTime).toBe(10_125);
      expect(internals.activeMessages[0]?.fadeStartTime).toBe(10_125);
    });

    it('uses the shared fixed-mode stagger and safe centering policy', () => {
      const renderer = initializeRenderer({ danmakuMode: 'bottom' });
      const internals = renderer as unknown as {
        activateMessage: (...args: unknown[]) => number;
        activeMessages: Array<{ startTime: number; startX: number }>;
      };

      const staggerDelay = internals.activateMessage(
        makeWorkerMessage({ width: 800 }),
        10_000,
        { laneIndex: 0, waitMs: 0, laneY: 0, slotCount: 1, verticalOffset: 0 },
        1,
        0,
        1,
        640,
        360
      );

      expect(staggerDelay).toBeGreaterThan(0);
      expect(internals.activeMessages[0]?.startTime).toBe(10_000 + staggerDelay);
      expect(internals.activeMessages[0]?.startX).toBe(0);
    });

    it('keeps original content active for an empty translated string', () => {
      const renderer = initializeRenderer();
      const internals = renderer as unknown as {
        activateMessage: (...args: unknown[]) => void;
        activeMessages: Array<{
          text: string;
          content: Array<{ type: string; content: string }>;
          translatedText?: string | null;
          translatedContent?: Array<{ type: string; content: string }>;
        }>;
      };

      internals.activateMessage(
        makeWorkerMessage({
          text: 'hello',
          content: [{ type: 'text', content: 'hello' }],
          translatedText: '',
        }),
        10_000,
        { laneIndex: 0, waitMs: 0, laneY: 0, slotCount: 1, verticalOffset: 0 },
        0,
        0,
        1,
        640,
        360
      );

      expect(internals.activeMessages[0]).toMatchObject({
        text: 'hello',
        content: [{ type: 'text', content: 'hello' }],
        translatedText: '',
      });
      expect(internals.activeMessages[0]?.translatedContent).toBeUndefined();
    });

    it('defers an unfit message without repeated attempts, then admits it after viewport recovery', () => {
      const renderer = initializeRenderer({ fontSize: 32, safeTop: 0.25, safeBottom: 0.5 });
      const internals = renderer as unknown as {
        drainQueue: (now: number, width: number, height: number) => void;
        pendingQueue: WorkerMessage[];
        totalDrops: number;
        dropReasons: { oversized: number };
      };
      const deferred = makeWorkerMessage({ height: 47 });

      renderer.handleMessage(makeEvent({ type: 'resize', width: 640, height: 60, dpr: 1 }));

      renderer.handleMessage(makeEvent({ type: 'addMessages', messages: [deferred] }));
      internals.drainQueue(10_000, 640, 60);

      expect(internals.pendingQueue).toHaveLength(1);
      expect(internals.totalDrops).toBe(0);
      internals.drainQueue(10_016, 640, 60);
      expect(internals.pendingQueue).toHaveLength(1);
      renderer.handleMessage(makeEvent({ type: 'resize', width: 640, height: 400, dpr: 1 }));
      internals.drainQueue(10_032, 640, 400);
      expect(internals.pendingQueue).toHaveLength(0);
      expect(internals.totalDrops).toBe(0);
    });

    it('drops a permanently oversized message in a normal viewport', () => {
      const renderer = initializeRenderer();
      const internals = renderer as unknown as {
        drainQueue: (now: number, width: number, height: number) => void;
        pendingQueue: WorkerMessage[];
        dropReasons: { oversized: number };
      };
      renderer.handleMessage(
        makeEvent({ type: 'addMessages', messages: [makeWorkerMessage({ height: 10_000 })] })
      );
      internals.drainQueue(10_000, 640, 360);
      expect(internals.pendingQueue).toHaveLength(0);
      expect(internals.dropReasons.oversized).toBe(1);
    });

    it('does not count transient placement failures as drops or starve later candidates', () => {
      const renderer = initializeRenderer();
      const messages = Array.from({ length: 17 }, (_, index) =>
        makeWorkerMessage({ id: `queued-${index}` })
      );
      const placement = {
        laneIndex: 0,
        waitMs: 0,
        laneY: 0,
        slotCount: 1,
        verticalOffset: 0,
      };
      const findPlacement = vi.fn(() =>
        findPlacement.mock.calls.length === 17 ? placement : null
      );
      const activateMessage = vi.fn(() => 0);
      const internals = renderer as unknown as {
        drainQueue: (now: number, width: number, height: number) => void;
        pendingQueue: WorkerMessage[];
        totalDrops: number;
        findPlacement: typeof findPlacement;
        checkCollision: ReturnType<typeof vi.fn>;
        activateMessage: typeof activateMessage;
      };
      internals.pendingQueue.push(...messages);
      internals.findPlacement = findPlacement;
      internals.checkCollision = vi.fn(() => true);
      internals.activateMessage = activateMessage;

      internals.drainQueue(10_000, 640, 360);

      expect(findPlacement).toHaveBeenCalledTimes(17);
      expect(activateMessage).toHaveBeenCalledOnce();
      expect(internals.pendingQueue).toHaveLength(16);
      expect(internals.totalDrops).toBe(0);
    });

    it('re-sorts the Worker queue after replacing its lowest-priority entry', () => {
      const renderer = initializeRenderer({ queueMaxSize: 2 });
      const internals = renderer as unknown as {
        pendingQueue: WorkerMessage[];
        pendingQueueSortNeeded: boolean;
      };
      internals.pendingQueue.push(
        makeWorkerMessage({ id: 'low-a', priority: 0 }),
        makeWorkerMessage({ id: 'low-b', priority: 1 })
      );
      internals.pendingQueueSortNeeded = false;

      renderer.handleMessage(
        makeEvent({
          type: 'addMessages',
          messages: [makeWorkerMessage({ id: 'high', priority: 100 })],
        })
      );

      expect(internals.pendingQueueSortNeeded).toBe(true);
    });

    it('blocks a faster follower until it can no longer overtake the active comment', () => {
      const renderer = initializeRenderer();
      const placement = {
        laneIndex: 0,
        waitMs: 0,
        laneY: 18,
        slotCount: 1,
        verticalOffset: 0,
      };
      const active = {
        y: 18,
        height: 20,
        width: 100,
        startX: 640,
        startTime: 7_000,
        pausedDuration: 0,
        duration: 8_400,
        invDuration: 1 / 8_400,
      };
      const internals = renderer as unknown as {
        activeMessagesByLane: Map<number, unknown[]>;
        checkCollision(
          candidatePlacement: typeof placement,
          entry: WorkerMessage,
          speedTier: number,
          batchIndex: number,
          previousStaggerDelayMs: number,
          now: number,
          width: number
        ): boolean;
      };
      internals.activeMessagesByLane.set(0, [active]);

      expect(internals.checkCollision(placement, makeWorkerMessage(), 1, 0, 0, 10_000, 640)).toBe(
        true
      );
      expect(
        internals.checkCollision(
          placement,
          makeWorkerMessage({ burstSpeedMultiplier: 3 }),
          1,
          0,
          0,
          10_000,
          640
        )
      ).toBe(false);
    });

    it('preserves decoded images across config updates and releases them on destruction', () => {
      const renderer = initializeRenderer();
      const internals = renderer as unknown as {
        emojiCache: { size: number };
      };
      const bitmap = { width: 10, height: 10, close: vi.fn() };

      renderer.handleMessage(
        makeEvent({
          type: 'addMessages',
          messages: [],
          imageData: [{ url: 'https://yt3.ggpht.com/emoji', bitmap, target: 'emoji' }],
        })
      );
      renderer.handleMessage(
        makeEvent({ type: 'updateConfig', config: { ...makeMinimalConfig(), opacity: 0.5 } })
      );

      expect(internals.emojiCache.size).toBe(1);
      expect(bitmap.close).not.toHaveBeenCalled();
      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      expect(internals.emojiCache.size).toBe(0);
      expect(bitmap.close).toHaveBeenCalledOnce();
      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      expect(bitmap.close).toHaveBeenCalledOnce();
    });

    it('closes a replaced transferred bitmap once and retains its distinct replacement', () => {
      const renderer = initializeRenderer();
      const internals = renderer as unknown as {
        emojiCache: { get(url: string): ImageBitmap | undefined };
      };
      const url = 'https://yt3.ggpht.com/replaced-emoji';
      const first = { width: 64, height: 64, close: vi.fn() };
      const second = { width: 64, height: 64, close: vi.fn() };

      for (const bitmap of [first, second]) {
        renderer.handleMessage(
          makeEvent({
            type: 'addMessages',
            messages: [],
            imageData: [{ url, bitmap, target: 'emoji' }],
          })
        );
      }

      expect(internals.emojiCache.get(url)).toBe(second);
      expect(first.close).toHaveBeenCalledOnce();
      expect(second.close).not.toHaveBeenCalled();
      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      expect(first.close).toHaveBeenCalledOnce();
      expect(second.close).toHaveBeenCalledOnce();
    });

    it('promotes a defensively repeated same-key bitmap without re-estimating or closing it', () => {
      const renderer = initializeRenderer();
      const internals = renderer as unknown as {
        emojiCache: {
          get(url: string): ImageBitmap | undefined;
          has(url: string): boolean;
          currentBytes: number;
          size: number;
        };
      };
      const url = 'https://yt3.ggpht.com/repeated-bitmap';
      const otherUrl = 'https://yt3.ggpht.com/other-bitmap';
      const bitmap = { width: 400, height: 400, close: vi.fn() };
      const other = { width: 400, height: 400, close: vi.fn() };
      const register = (key: string, value: typeof bitmap) =>
        renderer.handleMessage(
          makeEvent({
            type: 'addMessages',
            messages: [],
            imageData: [{ url: key, bitmap: value, target: 'emoji' }],
          })
        );

      register(url, bitmap);
      register(otherUrl, other);
      const retainedBytes = internals.emojiCache.currentBytes;
      bitmap.width = 10_000; // Defensive fixture: a second estimate would exceed capacity.
      register(url, bitmap);

      expect(internals.emojiCache.has(url)).toBe(true);
      expect(internals.emojiCache.size).toBe(2);
      expect(internals.emojiCache.currentBytes).toBe(retainedBytes);
      expect(bitmap.close).not.toHaveBeenCalled();
      renderer.handleMessage(makeEvent({ type: 'updateConfig', config: { emojiCacheMb: 1 } }));
      expect(internals.emojiCache.has(url)).toBe(true);
      expect(internals.emojiCache.has(otherUrl)).toBe(false);
      expect(internals.emojiCache.get(url)).toBe(bitmap);
      expect(other.close).toHaveBeenCalledOnce();
      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      expect(bitmap.close).toHaveBeenCalledOnce();
      expect(other.close).toHaveBeenCalledOnce();
    });

    it('rejects a defensive cross-key bitmap alias before altering its owner', () => {
      const renderer = initializeRenderer();
      const internals = renderer as unknown as {
        emojiCache: {
          get(url: string): ImageBitmap | undefined;
          has(url: string): boolean;
          currentBytes: number;
          size: number;
        };
      };
      const firstUrl = 'https://yt3.ggpht.com/alias-first';
      const aliasUrl = 'https://yt3.ggpht.com/alias-second';
      const bitmap = { width: 64, height: 64, close: vi.fn() };
      renderer.handleMessage(
        makeEvent({
          type: 'addMessages',
          messages: [],
          imageData: [{ url: firstUrl, bitmap, target: 'emoji' }],
        })
      );
      const retainedBytes = internals.emojiCache.currentBytes;
      postMessageSpy.mockClear();

      renderer.handleMessage(
        makeEvent({
          type: 'addMessages',
          messages: [],
          imageData: [{ url: aliasUrl, bitmap, target: 'emoji' }],
        })
      );

      expect(postMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', error: expect.any(String) })
      );
      expect(internals.emojiCache.get(firstUrl)).toBe(bitmap);
      expect(internals.emojiCache.has(aliasUrl)).toBe(false);
      expect(internals.emojiCache.size).toBe(1);
      expect(internals.emojiCache.currentBytes).toBe(retainedBytes);
      expect(bitmap.close).not.toHaveBeenCalled();
      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      expect(bitmap.close).toHaveBeenCalledOnce();
    });

    it('closes only the evicted bitmap when a transferred-image cache shrinks', () => {
      const renderer = initializeRenderer({ emojiCacheMb: 4 });
      const internals = renderer as unknown as {
        emojiCache: { has(url: string): boolean };
      };
      const firstUrl = 'https://yt3.ggpht.com/first-bitmap';
      const secondUrl = 'https://yt3.ggpht.com/second-bitmap';
      const first = { width: 400, height: 400, close: vi.fn() };
      const second = { width: 400, height: 400, close: vi.fn() };
      renderer.handleMessage(
        makeEvent({
          type: 'addMessages',
          messages: [],
          imageData: [
            { url: firstUrl, bitmap: first, target: 'emoji' },
            { url: secondUrl, bitmap: second, target: 'emoji' },
          ],
        })
      );

      renderer.handleMessage(makeEvent({ type: 'updateConfig', config: { emojiCacheMb: 1 } }));

      expect(internals.emojiCache.has(firstUrl)).toBe(false);
      expect(internals.emojiCache.has(secondUrl)).toBe(true);
      expect(first.close).toHaveBeenCalledOnce();
      expect(second.close).not.toHaveBeenCalled();
      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      expect(second.close).toHaveBeenCalledOnce();
    });

    it('lets the cache close an oversized transferred bitmap without caller cleanup', () => {
      const renderer = initializeRenderer({ emojiCacheMb: 1 });
      const internals = renderer as unknown as {
        emojiCache: { has(url: string): boolean };
      };
      const url = 'https://yt3.ggpht.com/oversized-bitmap';
      const bitmap = { width: 1_000, height: 1_000, close: vi.fn() };

      renderer.handleMessage(
        makeEvent({
          type: 'addMessages',
          messages: [],
          imageData: [{ url, bitmap, target: 'emoji' }],
        })
      );

      expect(internals.emojiCache.has(url)).toBe(false);
      expect(bitmap.close).toHaveBeenCalledOnce();
      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      expect(bitmap.close).toHaveBeenCalledOnce();
    });

    it('clears a transferred image failure so eviction can self-fetch immediately', async () => {
      const renderer = initializeRenderer({ failedEmojiRetryMins: 5 });
      const internals = renderer as unknown as {
        emojiCache: {
          has(url: string): boolean;
          delete(url: string): boolean;
        };
        failedImageFetches: Map<string, number>;
        prefetchImages: (urls: string[], cache: unknown) => Promise<void>;
      };
      const url = 'https://yt3.ggpht.com/recovered-emoji';
      const transferredBitmap = { width: 10, height: 10, close: vi.fn() };
      internals.failedImageFetches.set(url, Date.now());

      renderer.handleMessage(
        makeEvent({
          type: 'addMessages',
          messages: [],
          imageData: [{ url, bitmap: transferredBitmap, target: 'emoji' }],
        })
      );

      expect(internals.emojiCache.has(url)).toBe(true);
      expect(internals.failedImageFetches.has(url)).toBe(false);

      expect(internals.emojiCache.delete(url)).toBe(true);
      const fetchedBitmap = { width: 10, height: 10, close: vi.fn() };
      vi.mocked(createImageBitmap).mockResolvedValueOnce(fetchedBitmap as unknown as ImageBitmap);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(imageResponse());

      await internals.prefetchImages([url], internals.emojiCache);

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(internals.emojiCache.has(url)).toBe(true);
    });

    it('rejects declared and streamed over-limit images, releasing each slot for a healthy image', async () => {
      const renderer = initializeRenderer({ emojiFetchLimit: 1 });
      const internals = renderer as unknown as {
        emojiCache: { has(url: string): boolean };
        failedImageFetches: Map<string, number>;
        fetchControllers: Set<AbortController>;
        imageFetchTasks: Map<string, unknown>;
        prefetchImages: (urls: string[], cache: unknown) => Promise<void>;
      };
      const declaredUrl = 'https://yt3.ggpht.com/declared-over-limit';
      const streamedUrl = 'https://yt3.ggpht.com/streamed-over-limit';
      const firstHealthyUrl = 'https://yt3.ggpht.com/after-declared-rejection';
      const secondHealthyUrl = 'https://yt3.ggpht.com/after-streamed-rejection';
      const declaredCancel = vi.fn();
      const streamedCancel = vi.fn();
      const rejectedBodies: ReadableStream<Uint8Array>[] = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        if (input === declaredUrl) {
          const response = new Response(
            new ReadableStream<Uint8Array>({ cancel: declaredCancel }),
            {
              headers: { 'content-length': '17' },
            }
          );
          Object.defineProperty(response, 'url', { value: declaredUrl });
          if (response.body) rejectedBodies.push(response.body);
          return response;
        }
        if (input === streamedUrl) {
          const response = new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(10));
                controller.enqueue(new Uint8Array(10));
              },
              cancel: streamedCancel,
            })
          );
          Object.defineProperty(response, 'url', { value: streamedUrl });
          if (response.body) rejectedBodies.push(response.body);
          return response;
        }
        return imageResponse(true, String(input));
      });
      const decoder = vi.mocked(createImageBitmap);
      decoder.mockClear();
      const firstBitmap = { width: 1, height: 1, close: vi.fn() };
      const secondBitmap = { width: 1, height: 1, close: vi.fn() };
      decoder
        .mockResolvedValueOnce(firstBitmap as unknown as ImageBitmap)
        .mockResolvedValueOnce(secondBitmap as unknown as ImageBitmap);

      for (const { failedUrl, healthyUrl } of [
        { failedUrl: declaredUrl, healthyUrl: firstHealthyUrl },
        { failedUrl: streamedUrl, healthyUrl: secondHealthyUrl },
      ]) {
        await internals.prefetchImages([failedUrl], internals.emojiCache);
        expect(internals.failedImageFetches.has(failedUrl)).toBe(true);
        expect(internals.emojiCache.has(failedUrl)).toBe(false);
        expect(internals.fetchControllers.size).toBe(0);
        expect(internals.imageFetchTasks.size).toBe(0);
        await internals.prefetchImages([failedUrl, healthyUrl], internals.emojiCache);
        expect(internals.emojiCache.has(healthyUrl)).toBe(true);
      }

      expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
        declaredUrl,
        firstHealthyUrl,
        streamedUrl,
        secondHealthyUrl,
      ]);
      await vi.waitFor(() => expect(declaredCancel).toHaveBeenCalledOnce());
      expect(streamedCancel).toHaveBeenCalledOnce();
      expect(rejectedBodies.map((body) => body.locked)).toEqual([false, false]);
      expect(decoder).toHaveBeenCalledTimes(2);
      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      expect(firstBitmap.close).toHaveBeenCalledOnce();
      expect(secondBitmap.close).toHaveBeenCalledOnce();
    });

    it('settles a null-body image task and uses its fetch slot for the next healthy asset', async () => {
      const renderer = initializeRenderer({ emojiFetchLimit: 1 });
      const internals = renderer as unknown as {
        emojiCache: { has(url: string): boolean };
        failedImageFetches: Map<string, number>;
        fetchControllers: Set<AbortController>;
        fetching: Set<string>;
        imageFetchTasks: Map<string, unknown>;
        prefetchImages: (urls: string[], cache: unknown) => Promise<void>;
      };
      const emptyUrl = 'https://yt3.ggpht.com/null-body';
      const healthyUrl = 'https://yt3.ggpht.com/after-null-body';
      const emptyResponse = new Response(null, { status: 200 });
      Object.defineProperty(emptyResponse, 'url', { value: emptyUrl });
      const blobFallback = vi.spyOn(emptyResponse, 'blob');
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input) =>
          input === emptyUrl ? emptyResponse : imageResponse(true, healthyUrl)
        );
      const decoder = vi.mocked(createImageBitmap);
      decoder.mockClear();
      const healthyBitmap = { width: 1, height: 1, close: vi.fn() };
      decoder.mockResolvedValueOnce(healthyBitmap as unknown as ImageBitmap);

      await internals.prefetchImages([emptyUrl, healthyUrl], internals.emojiCache);

      expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([emptyUrl, healthyUrl]);
      expect(blobFallback).not.toHaveBeenCalled();
      expect(decoder).toHaveBeenCalledOnce();
      expect(internals.failedImageFetches.has(emptyUrl)).toBe(true);
      expect(internals.emojiCache.has(emptyUrl)).toBe(false);
      expect(internals.emojiCache.has(healthyUrl)).toBe(true);
      expect(internals.fetchControllers.size).toBe(0);
      expect(internals.fetching.size).toBe(0);
      expect(internals.imageFetchTasks.size).toBe(0);
      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      expect(healthyBitmap.close).toHaveBeenCalledOnce();
    });

    it('accepts allowed final redirects and rejects an off-allowlist final URL before reading', async () => {
      const renderer = initializeRenderer();
      const internals = renderer as unknown as {
        emojiCache: { has(url: string): boolean };
        failedImageFetches: Map<string, number>;
        prefetchImages: (urls: string[], cache: unknown) => Promise<void>;
      };
      const allowedUrl = 'https://yt3.ggpht.com/allowed-redirect';
      const rejectedUrl = 'https://yt3.ggpht.com/rejected-redirect';
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input) =>
          input === allowedUrl
            ? imageResponse(true, 'https://yt4.ggpht.com/image')
            : imageResponse(true, 'https://example.test/image')
        );
      const decoder = vi.mocked(createImageBitmap);
      decoder.mockClear();
      decoder.mockResolvedValue({ width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap);

      await internals.prefetchImages([allowedUrl, rejectedUrl], internals.emojiCache);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(internals.emojiCache.has(allowedUrl)).toBe(true);
      expect(internals.emojiCache.has(rejectedUrl)).toBe(false);
      expect(internals.failedImageFetches.has(rejectedUrl)).toBe(true);
      expect(decoder).toHaveBeenCalledOnce();
    });

    it('rejects untrusted direct loader URLs without fetching or delaying an allowed neighbor', async () => {
      const renderer = initializeRenderer({ emojiFetchLimit: 1 });
      const internals = renderer as unknown as {
        emojiCache: { has(url: string): boolean };
        imageFetchTasks: Map<string, unknown>;
        fetching: Set<string>;
        prefetchImages: (urls: string[], cache: unknown) => Promise<void>;
      };
      const healthyUrl = 'https://yt3.ggpht.com/healthy-neighbor';
      const rejected = [
        '',
        'not a url',
        'data:image/png;base64,AA==',
        'blob:https://yt3.ggpht.com/opaque',
        'http://yt3.ggpht.com/insecure.png',
        '//yt3.ggpht.com/protocol-relative.png',
        'https://yt3.ggpht.com.evil.example/image.png',
        'https://evil.example/yt3.ggpht.com/image.png',
      ];
      const bitmap = { width: 1, height: 1, close: vi.fn() };
      vi.mocked(createImageBitmap).mockResolvedValueOnce(bitmap as unknown as ImageBitmap);
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(imageResponse(true, healthyUrl));

      await internals.prefetchImages([...rejected, healthyUrl], internals.emojiCache);

      expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([healthyUrl]);
      expect(internals.emojiCache.has(healthyUrl)).toBe(true);
      expect(internals.imageFetchTasks.size).toBe(0);
      expect(internals.fetching.size).toBe(0);
      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      expect(bitmap.close).toHaveBeenCalledOnce();
    });

    it.each([
      ['HTTP failure', false],
      ['decode failure', true],
    ])('suppresses repeated worker image fetch after %s until TTL expiry', async (_label, ok) => {
      const renderer = initializeRenderer({ failedEmojiRetryMins: 1 });
      const internals = renderer as unknown as {
        emojiCache: unknown;
        failedImageFetches: Map<string, number>;
        prefetchImages: (urls: string[], cache: unknown) => Promise<void>;
      };
      const url = 'https://yt3.ggpht.com/broken-emoji';
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(imageResponse(ok));
      if (ok) vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('decode failed'));

      await internals.prefetchImages([url], internals.emojiCache);
      await internals.prefetchImages([url], internals.emojiCache);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(internals.failedImageFetches.has(url)).toBe(true);

      nowSpy.mockReturnValue(61_001);
      await internals.prefetchImages([url], internals.emojiCache);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('decodes the same image URL after its negative-cache TTL and releases the recovered bitmap', async () => {
      const renderer = initializeRenderer({ failedEmojiRetryMins: 1 });
      const internals = renderer as unknown as {
        emojiCache: { get(url: string): ImageBitmap | undefined };
        failedImageFetches: Map<string, number>;
        fetchControllers: Set<AbortController>;
        fetching: Set<string>;
        imageFetchTasks: Map<string, unknown>;
        prefetchImages: (urls: string[], cache: unknown) => Promise<void>;
      };
      const url = 'https://yt3.ggpht.com/decode-recovery';
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(imageResponse(true, url));
      const decoder = vi.mocked(createImageBitmap);
      decoder.mockClear();
      const recoveredBitmap = { width: 10, height: 10, close: vi.fn() };
      decoder
        .mockRejectedValueOnce(new Error('decode failed'))
        .mockResolvedValueOnce(recoveredBitmap as unknown as ImageBitmap);

      await internals.prefetchImages([url], internals.emojiCache);
      expect(internals.failedImageFetches.get(url)).toBe(1_000);
      expect(internals.emojiCache.get(url)).toBeUndefined();
      expect(internals.fetchControllers.size).toBe(0);
      expect(internals.fetching.size).toBe(0);
      expect(internals.imageFetchTasks.size).toBe(0);

      nowSpy.mockReturnValue(60_999);
      await internals.prefetchImages([url], internals.emojiCache);
      expect(fetchSpy).toHaveBeenCalledOnce();

      nowSpy.mockReturnValue(61_000);
      await internals.prefetchImages([url], internals.emojiCache);
      await internals.prefetchImages([url], internals.emojiCache);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(decoder).toHaveBeenCalledTimes(2);
      expect(internals.failedImageFetches.has(url)).toBe(false);
      expect(internals.emojiCache.get(url)).toBe(recoveredBitmap);
      expect(internals.fetchControllers.size).toBe(0);
      expect(internals.fetching.size).toBe(0);
      expect(internals.imageFetchTasks.size).toBe(0);
      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      expect(recoveredBitmap.close).toHaveBeenCalledOnce();
    });

    it('negative-caches worker image fetch timeouts', async () => {
      vi.useFakeTimers();
      const renderer = initializeRenderer({ emojiFetchTimeoutMs: 5_000 });
      const internals = renderer as unknown as {
        emojiCache: unknown;
        failedImageFetches: Map<string, number>;
        prefetchImages: (urls: string[], cache: unknown) => Promise<void>;
      };
      const url = 'https://yt3.ggpht.com/timeout-emoji';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted')));
          })
      );

      const prefetch = internals.prefetchImages([url], internals.emojiCache);
      await vi.advanceTimersByTimeAsync(5_000);
      await prefetch;
      await internals.prefetchImages([url], internals.emojiCache);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(internals.failedImageFetches.has(url)).toBe(true);
    });

    it('aborts a stalled image body on timeout and settles its fetch task', async () => {
      vi.useFakeTimers();
      const renderer = initializeRenderer({ emojiFetchTimeoutMs: 5_000 });
      const internals = renderer as unknown as {
        emojiCache: { has(url: string): boolean };
        failedImageFetches: Map<string, number>;
        fetchControllers: Set<AbortController>;
        fetching: Set<string>;
        imageFetchTasks: Map<string, unknown>;
        prefetchImages: (urls: string[], cache: unknown) => Promise<void>;
      };
      const url = 'https://yt3.ggpht.com/stalled-body';
      const healthyUrl = 'https://yt3.ggpht.com/after-stalled-body';
      const stalledBodies: ReadableStream<Uint8Array>[] = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (input === healthyUrl) return imageResponse(true, healthyUrl);
        const response = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(4));
              init?.signal?.addEventListener('abort', () =>
                controller.error(new DOMException('Aborted', 'AbortError'))
              );
            },
          })
        );
        Object.defineProperty(response, 'url', { value: url });
        if (response.body) stalledBodies.push(response.body);
        return response;
      });
      const decoder = vi.mocked(createImageBitmap);
      decoder.mockClear();
      const healthyBitmap = { width: 1, height: 1, close: vi.fn() };
      decoder.mockResolvedValueOnce(healthyBitmap as unknown as ImageBitmap);

      const prefetch = internals.prefetchImages([url], internals.emojiCache);
      await vi.advanceTimersByTimeAsync(5_000);
      await prefetch;
      await internals.prefetchImages([url, healthyUrl], internals.emojiCache);

      expect(fetchSpy.mock.calls.map(([input]) => input)).toEqual([url, healthyUrl]);
      expect(internals.failedImageFetches.has(url)).toBe(true);
      expect(internals.fetchControllers.size).toBe(0);
      expect(internals.fetching.size).toBe(0);
      expect(internals.imageFetchTasks.size).toBe(0);
      expect(internals.emojiCache.has(url)).toBe(false);
      expect(internals.emojiCache.has(healthyUrl)).toBe(true);
      expect(stalledBodies.map((body) => body.locked)).toEqual([false]);
      expect(decoder).toHaveBeenCalledOnce();
      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      expect(healthyBitmap.close).toHaveBeenCalledOnce();
    });

    it('aborts a pending image body on destroy without decoding or retaining the task', async () => {
      const renderer = initializeRenderer();
      const internals = renderer as unknown as {
        emojiCache: { has(url: string): boolean };
        fetchControllers: Set<AbortController>;
        fetching: Set<string>;
        imageFetchTasks: Map<string, unknown>;
        prefetchImages: (urls: string[], cache: unknown) => Promise<void>;
      };
      const url = 'https://yt3.ggpht.com/teardown-body';
      let bodyReader: ReturnType<typeof vi.spyOn> | undefined;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        const response = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener('abort', () =>
                controller.error(new DOMException('Aborted', 'AbortError'))
              );
            },
          })
        );
        Object.defineProperty(response, 'url', { value: url });
        if (response.body) bodyReader = vi.spyOn(response.body, 'getReader');
        return response;
      });
      const decoder = vi.mocked(createImageBitmap);
      decoder.mockClear();

      const prefetch = internals.prefetchImages([url], internals.emojiCache);
      await vi.waitFor(() => expect(bodyReader).toHaveBeenCalledOnce());
      const signal = fetchSpy.mock.calls[0]?.[1]?.signal;

      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      await prefetch;

      expect(signal?.aborted).toBe(true);
      expect(internals.emojiCache.has(url)).toBe(false);
      expect(internals.fetchControllers.size).toBe(0);
      expect(internals.fetching.size).toBe(0);
      expect(internals.imageFetchTasks.size).toBe(0);
      expect(decoder).not.toHaveBeenCalled();
    });

    it('shares one global fetch limit across concurrent worker prefetch calls', async () => {
      const renderer = initializeRenderer({ emojiFetchLimit: 2 });
      const internals = renderer as unknown as {
        emojiCache: unknown;
        prefetchImages: (urls: string[], cache: unknown) => Promise<void>;
      };
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted')));
          })
      );

      const prefetches = [
        internals.prefetchImages(['https://yt3.ggpht.com/one'], internals.emojiCache),
        internals.prefetchImages(['https://yt3.ggpht.com/two'], internals.emojiCache),
        internals.prefetchImages(['https://yt3.ggpht.com/three'], internals.emojiCache),
      ];
      await Promise.resolve();

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      await Promise.all(prefetches);
    });

    it('drains queued visible assets once while preserving the global fetch limit', async () => {
      const renderer = initializeRenderer({ emojiFetchLimit: 2 });
      const internals = renderer as unknown as {
        emojiCache: unknown;
        authorPhotoCache: unknown;
        stickerCache: unknown;
        prefetchImages: (urls: string[], cache: unknown) => Promise<void>;
      };
      const releases: Array<() => void> = [];
      let active = 0;
      let maxActive = 0;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            active++;
            maxActive = Math.max(maxActive, active);
            releases.push(() => {
              active--;
              resolve(imageResponse());
            });
          })
      );
      vi.mocked(createImageBitmap).mockImplementation(
        async () =>
          ({
            width: 1,
            height: 1,
            close: vi.fn(),
          }) as unknown as ImageBitmap
      );
      const emojiUrls = Array.from(
        { length: 5 },
        (_, index) => `https://yt3.ggpht.com/queued-emoji-${index}`
      );
      const authorUrl = 'https://yt3.ggpht.com/queued-paid-author';
      const stickerUrl = 'https://yt3.ggpht.com/queued-paid-sticker';
      const pending = [
        internals.prefetchImages(emojiUrls, internals.emojiCache),
        internals.prefetchImages([authorUrl], internals.authorPhotoCache),
        internals.prefetchImages([stickerUrl], internals.stickerCache),
      ];
      await Promise.resolve();
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      for (let turn = 0; turn < 20 && (fetchSpy.mock.calls.length < 7 || active > 0); turn++) {
        const release = releases.shift();
        if (release) release();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(fetchSpy).toHaveBeenCalledTimes(7);
      expect(active).toBe(0);
      await Promise.all(pending);

      expect(maxActive).toBe(2);
      expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
        ...emojiUrls,
        authorUrl,
        stickerUrl,
      ]);
    });

    it('does not refetch a decoded bitmap that cannot fit its owner cache', async () => {
      const renderer = initializeRenderer({ emojiCacheMb: 1 });
      const internals = renderer as unknown as {
        emojiCache: unknown;
        prefetchImages: (urls: string[], cache: unknown) => Promise<void>;
      };
      const url = 'https://yt3.ggpht.com/too-large-for-cache';
      const bitmap = { width: 1_000, height: 1_000, close: vi.fn() };
      vi.mocked(createImageBitmap).mockResolvedValue(bitmap as unknown as ImageBitmap);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(imageResponse());

      await internals.prefetchImages([url], internals.emojiCache);
      await internals.prefetchImages([url], internals.emojiCache);

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(bitmap.close).toHaveBeenCalledOnce();
    });

    it('re-evaluates an oversized URL per target cache after capacity increases and decreases', async () => {
      const renderer = initializeRenderer({ emojiCacheMb: 1, photoCacheMb: 4 });
      const internals = renderer as unknown as {
        emojiCache: { get(url: string): ImageBitmap | undefined };
        authorPhotoCache: { get(url: string): ImageBitmap | undefined };
        fetchControllers: Set<AbortController>;
        imageFetchTasks: Map<string, unknown>;
        prefetchImages: (urls: string[], cache: unknown) => Promise<void>;
      };
      const url = 'https://yt3.ggpht.com/shared-large-image';
      const bitmaps = Array.from({ length: 4 }, () => ({
        width: 800,
        height: 800,
        close: vi.fn(),
      }));
      const decoder = vi.mocked(createImageBitmap);
      decoder.mockClear();
      for (const bitmap of bitmaps) {
        decoder.mockResolvedValueOnce(bitmap as unknown as ImageBitmap);
      }
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(imageResponse(true, url));

      await internals.prefetchImages([url], internals.emojiCache);
      expect(internals.emojiCache.get(url)).toBeUndefined();
      expect(bitmaps[0]?.close).toHaveBeenCalledOnce();
      await internals.prefetchImages([url], internals.emojiCache);
      expect(fetchSpy).toHaveBeenCalledOnce();

      await internals.prefetchImages([url], internals.authorPhotoCache);
      expect(internals.authorPhotoCache.get(url)).toBe(bitmaps[1]);
      expect(bitmaps[1]?.close).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      renderer.handleMessage(makeEvent({ type: 'updateConfig', config: { emojiCacheMb: 3 } }));
      await internals.prefetchImages([url], internals.emojiCache);
      expect(internals.emojiCache.get(url)).toBe(bitmaps[2]);
      expect(fetchSpy).toHaveBeenCalledTimes(3);

      renderer.handleMessage(makeEvent({ type: 'updateConfig', config: { emojiCacheMb: 1 } }));
      expect(internals.emojiCache.get(url)).toBeUndefined();
      expect(bitmaps[2]?.close).toHaveBeenCalledOnce();
      await internals.prefetchImages([url], internals.emojiCache);
      await internals.prefetchImages([url], internals.emojiCache);
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      expect(decoder).toHaveBeenCalledTimes(4);
      expect(bitmaps[3]?.close).toHaveBeenCalledOnce();
      expect(internals.authorPhotoCache.get(url)).toBe(bitmaps[1]);
      expect(internals.fetchControllers.size).toBe(0);
      expect(internals.imageFetchTasks.size).toBe(0);

      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledOnce();
    });

    it('discards obsolete queued asset owners before a fetch slot opens', async () => {
      const renderer = initializeRenderer({ emojiFetchLimit: 1 });
      const internals = renderer as unknown as {
        emojiCache: unknown;
        prefetchImages: (urls: string[], cache: unknown, ownerId?: string) => Promise<void>;
        releaseQueuedAssetsForOwner(ownerId: string): void;
      };
      const firstUrl = 'https://yt3.ggpht.com/slot-holder';
      const obsoleteUrl = 'https://yt3.ggpht.com/obsolete-owner';
      const liveUrl = 'https://yt3.ggpht.com/live-owner';
      const releases: Array<() => void> = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            releases.push(() => resolve(imageResponse()));
          })
      );
      vi.mocked(createImageBitmap).mockImplementation(
        async () =>
          ({
            width: 1,
            height: 1,
            close: vi.fn(),
          }) as unknown as ImageBitmap
      );

      const first = internals.prefetchImages([firstUrl], internals.emojiCache, 'first');
      const obsolete = internals.prefetchImages([obsoleteUrl], internals.emojiCache, 'expired');
      const live = internals.prefetchImages([liveUrl], internals.emojiCache, 'live');
      await Promise.resolve();
      internals.releaseQueuedAssetsForOwner('expired');
      await obsolete;
      releases.shift()?.();
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
      expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([firstUrl, liveUrl]);
      releases.shift()?.();
      await Promise.all([first, live]);
    });

    it('retains a shared queued image for its live owner and drops a final-owner image', async () => {
      const renderer = initializeRenderer({ emojiFetchLimit: 1 });
      const internals = renderer as unknown as {
        emojiCache: { has(url: string): boolean };
        imageFetchTasks: Map<string, unknown>;
        prefetchImages: (urls: string[], cache: unknown, ownerId?: string) => Promise<void>;
        releaseQueuedAssetsForOwner(ownerId: string): void;
      };
      const holderUrl = 'https://yt3.ggpht.com/shared-owner-holder';
      const sharedUrl = 'https://yt3.ggpht.com/shared-owner-image';
      const retiredUrl = 'https://yt3.ggpht.com/final-owner-retired';
      const recoveredUrl = 'https://yt3.ggpht.com/shared-owner-recovered';
      const releases: Array<() => void> = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        (input) =>
          new Promise<Response>((resolve) => {
            releases.push(() => resolve(imageResponse(true, String(input))));
          })
      );
      vi.mocked(createImageBitmap).mockImplementation(
        async () => ({ width: 1, height: 1, close: vi.fn() }) as unknown as ImageBitmap
      );

      const holder = internals.prefetchImages([holderUrl], internals.emojiCache, 'holder');
      const retiredShared = internals.prefetchImages([sharedUrl], internals.emojiCache, 'retired');
      const liveShared = internals.prefetchImages([sharedUrl], internals.emojiCache, 'live');
      const finalOwner = internals.prefetchImages([retiredUrl], internals.emojiCache, 'final');
      expect(internals.imageFetchTasks.size).toBe(3);
      expect(fetchSpy.mock.calls.map(([input]) => input)).toEqual([holderUrl]);

      internals.releaseQueuedAssetsForOwner('retired');
      internals.releaseQueuedAssetsForOwner('final');
      await finalOwner;
      expect(internals.imageFetchTasks.size).toBe(2);
      releases.shift()?.();
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
      expect(fetchSpy.mock.calls.map(([input]) => input)).toEqual([holderUrl, sharedUrl]);
      releases.shift()?.();
      await Promise.all([holder, retiredShared, liveShared]);
      expect(internals.emojiCache.has(sharedUrl)).toBe(true);
      expect(internals.emojiCache.has(retiredUrl)).toBe(false);

      const recovered = internals.prefetchImages([recoveredUrl], internals.emojiCache, 'new');
      expect(fetchSpy.mock.calls.map(([input]) => input)).toEqual([
        holderUrl,
        sharedUrl,
        recoveredUrl,
      ]);
      releases.shift()?.();
      await recovered;
      expect(internals.emojiCache.has(recoveredUrl)).toBe(true);
      expect(internals.imageFetchTasks.size).toBe(0);
      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      expect(internals.emojiCache.has(sharedUrl)).toBe(false);
    });

    it('caps 1,200 pending image tasks while retaining shared owners and recovering capacity', async () => {
      const renderer = initializeRenderer({ emojiFetchLimit: 1 });
      const internals = renderer as unknown as {
        emojiCache: unknown;
        authorPhotoCache: unknown;
        imageFetchTasks: Map<string, unknown>;
        prefetchImages: (urls: string[], cache: unknown, ownerId?: string) => Promise<void>;
        releaseQueuedAssetsForOwner(ownerId: string): void;
      };
      const urls = Array.from(
        { length: 1_200 },
        (_, index) => `https://yt3.ggpht.com/cap-${index}`
      );
      const sharedUrl = 'https://yt3.ggpht.com/cap-1199';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted')));
          })
      );

      const bulk = internals.prefetchImages(urls, internals.emojiCache, 'bulk');
      expect(internals.imageFetchTasks.size).toBe(1_200);
      expect(fetchSpy).toHaveBeenCalledOnce();

      await internals.prefetchImages(['https://yt3.ggpht.com/cap-refused'], internals.emojiCache);
      expect(internals.imageFetchTasks.size).toBe(1_200);
      const shared = internals.prefetchImages([sharedUrl], internals.emojiCache, 'shared');
      expect(internals.imageFetchTasks.size).toBe(1_200);

      internals.releaseQueuedAssetsForOwner('bulk');
      expect(internals.imageFetchTasks.size).toBe(2);
      const otherTarget = internals.prefetchImages(
        [sharedUrl],
        internals.authorPhotoCache,
        'author'
      );
      expect(internals.imageFetchTasks.size).toBe(3);

      internals.releaseQueuedAssetsForOwner('shared');
      await shared;
      expect(internals.imageFetchTasks.size).toBe(2);
      expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([urls[0]]);

      const recovered = internals.prefetchImages(
        ['https://yt3.ggpht.com/cap-recovered'],
        internals.emojiCache,
        'recovered'
      );
      expect(internals.imageFetchTasks.size).toBe(3);
      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      await Promise.all([bulk, otherTarget, recovered]);
      expect(internals.imageFetchTasks.size).toBe(0);
    });

    it('bounds and cleans worker image failure state on config update and destroy', () => {
      const renderer = initializeRenderer({ failedEmojiRetryMins: 5 });
      const internals = renderer as unknown as {
        failedImageFetches: Map<string, number>;
        recordFailedImageFetch(url: string): void;
      };
      vi.spyOn(Date, 'now').mockReturnValue(300_000);
      for (let i = 0; i <= 500; i++) internals.recordFailedImageFetch(`url-${i}`);
      expect(internals.failedImageFetches.size).toBeLessThanOrEqual(500);

      internals.failedImageFetches.set('expired', 0);
      renderer.handleMessage(
        makeEvent({ type: 'updateConfig', config: { failedEmojiRetryMins: 1 } })
      );
      expect(internals.failedImageFetches.has('expired')).toBe(false);

      internals.failedImageFetches.set('destroyed', Date.now());
      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      expect(internals.failedImageFetches.size).toBe(0);
    });

    it('aborts image prefetch and closes a bitmap that resolves after destroy', async () => {
      const renderer = initializeRenderer();
      const internals = renderer as unknown as {
        emojiCache: { has: (url: string) => boolean };
        fetchControllers: Set<AbortController>;
        fetching: Set<string>;
        prefetchImages: (urls: string[], cache: unknown) => Promise<void>;
      };
      const url = 'https://yt3.ggpht.com/late-emoji';
      const bitmap = { width: 10, height: 10, close: vi.fn() };
      let resolveBitmap!: (value: typeof bitmap) => void;
      const bitmapPromise = new Promise<typeof bitmap>((resolve) => {
        resolveBitmap = resolve;
      });
      const createBitmapMock = vi.mocked(createImageBitmap);
      createBitmapMock.mockImplementationOnce(() => bitmapPromise as Promise<ImageBitmap>);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(imageResponse());

      const prefetch = internals.prefetchImages([url], internals.emojiCache);
      await vi.waitFor(() => expect(createBitmapMock).toHaveBeenCalled());
      const signal = fetchSpy.mock.calls[0]?.[1]?.signal;

      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      expect(signal?.aborted).toBe(true);
      resolveBitmap(bitmap);
      await prefetch;

      expect(bitmap.close).toHaveBeenCalledOnce();
      expect(internals.emojiCache.has(url)).toBe(false);
      expect(internals.fetchControllers.size).toBe(0);
      expect(internals.fetching.size).toBe(0);
      fetchSpy.mockRestore();
    });

    it('settles a prefetch waiter on destroy even while bitmap decoding remains pending', async () => {
      const renderer = initializeRenderer();
      const internals = renderer as unknown as {
        emojiCache: { has(url: string): boolean };
        prefetchImages: (urls: string[], cache: unknown) => Promise<void>;
      };
      const url = 'https://yt3.ggpht.com/pending-decode';
      const bitmap = { width: 10, height: 10, close: vi.fn() };
      let resolveBitmap!: (value: typeof bitmap) => void;
      const bitmapPromise = new Promise<typeof bitmap>((resolve) => {
        resolveBitmap = resolve;
      });
      const decoder = vi.mocked(createImageBitmap);
      decoder.mockImplementationOnce(() => bitmapPromise as Promise<ImageBitmap>);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(imageResponse());

      const prefetch = internals.prefetchImages([url], internals.emojiCache);
      await vi.waitFor(() => expect(decoder).toHaveBeenCalledOnce());
      renderer.handleMessage(makeEvent({ type: 'destroy' }));
      const settledBeforeDecode = await Promise.race([
        prefetch.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 0)),
      ]);

      resolveBitmap(bitmap);
      await prefetch;
      expect(settledBeforeDecode).toBe(true);
      expect(bitmap.close).toHaveBeenCalledOnce();
      expect(internals.emojiCache.has(url)).toBe(false);
    });
  });

  describe('robustness', () => {
    it('rejects malformed init before context access or renderer state mutation', () => {
      const unsafePayloads = [
        { config: { ...makeMinimalConfig(), emojiCacheMb: Number.NaN } },
        { config: { ...makeMinimalConfig(), textCacheMb: 21 } },
        { width: Number.NaN },
        { height: 0 },
        { dpr: Number.POSITIVE_INFINITY },
      ];

      for (const unsafePayload of unsafePayloads) {
        const getContext = vi.fn(() => mockCtx);
        const renderer = new WorkerRenderer();
        const internals = renderer as unknown as {
          config: Record<string, unknown> | null;
          canvas: OffscreenCanvas | null;
        };

        renderer.handleMessage(
          makeEvent({
            type: 'init',
            config: makeMinimalConfig(),
            canvas: { getContext },
            width: 640,
            height: 360,
            dpr: 1,
            ...unsafePayload,
          })
        );

        expect(getContext).not.toHaveBeenCalled();
        expect(internals.config).toBeNull();
        expect(internals.canvas).toBeNull();
      }
    });

    it('does not mutate renderer config for rejected prototype and resource payloads', () => {
      const renderer = initializeRenderer();
      const internals = renderer as unknown as {
        config: Record<string, unknown>;
      };
      const originalPrototype = Object.getPrototypeOf(internals.config);
      const originalCacheBudget = internals.config.emojiCacheMb;
      const maliciousConfig = JSON.parse(
        '{"__proto__":{"polluted":true},"emojiCacheMb":1000000}'
      ) as Record<string, unknown>;

      renderer.handleMessage(makeEvent({ type: 'updateConfig', config: maliciousConfig }));

      expect(Object.getPrototypeOf(internals.config)).toBe(originalPrototype);
      expect(Object.hasOwn(internals.config, '__proto__')).toBe(false);
      expect(internals.config.emojiCacheMb).toBe(originalCacheBudget);
      expect((internals.config as { polluted?: boolean }).polluted).toBeUndefined();
    });

    it('snapshots messages that are still pending in the Worker', () => {
      const renderer = initializeRenderer();
      const message = makeWorkerMessage({ id: 'pending-message' });

      renderer.handleMessage(makeEvent({ type: 'addMessages', messages: [message] }));
      postMessageSpy.mockClear();
      renderer.handleMessage(makeEvent({ type: 'snapshotMessages', requestId: 7 }));

      expect(postMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'messageSnapshot',
          requestId: 7,
          epoch: 0,
          activeMessageIds: [],
          pendingMessageIds: ['pending-message'],
          processedBatchSequence: 0,
          motionSnapshot: expect.objectContaining({ activeMotions: [] }),
        })
      );
    });

    it('uses the pending array as the single queue cursor while preserving every snapshot id', () => {
      const renderer = initializeRenderer();
      const first = makeWorkerMessage({ id: 'pending-first', priority: 10 });
      const second = makeWorkerMessage({ id: 'pending-second', priority: 20 });

      renderer.handleMessage(makeEvent({ type: 'addMessages', messages: [first, second] }));
      postMessageSpy.mockClear();
      renderer.handleMessage(makeEvent({ type: 'snapshotMessages', requestId: 8 }));

      expect(renderer).not.toHaveProperty('pendingQueueOffset');
      expect(postMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'messageSnapshot',
          requestId: 8,
          epoch: 0,
          activeMessageIds: [],
          pendingMessageIds: ['pending-first', 'pending-second'],
          processedBatchSequence: 0,
          motionSnapshot: expect.objectContaining({ activeMotions: [] }),
        })
      );
    });

    it('snapshots the actual active timeline with a frozen clock during pause', () => {
      vi.spyOn(performance, 'now').mockReturnValue(10_000);
      const renderer = initializeRenderer();
      renderer.handleMessage(
        makeEvent({
          type: 'addMessages',
          messages: [makeWorkerMessage({ id: 'future-active', trackDrops: false })],
        })
      );
      const internals = renderer as unknown as {
        drainQueue(now: number, width: number, height: number): void;
        activeMessages: ActiveMessage[];
      };
      internals.drainQueue(10_000, 640, 360);
      const active = internals.activeMessages[0];
      expect(active).toBeDefined();
      if (!active) return;
      active.startTime = 10_500;
      active.fadeStartTime = 10_450;
      active.pausedDuration = 300;
      renderer.handleMessage(makeEvent({ type: 'setUserPaused', paused: true }));
      vi.spyOn(performance, 'now').mockReturnValue(10_600);

      postMessageSpy.mockClear();
      renderer.handleMessage(makeEvent({ type: 'snapshotMessages', requestId: 9, epoch: 0 }));
      const snapshot = postMessageSpy.mock.calls.at(-1)?.[0] as {
        type: string;
        epoch: number;
        motionSnapshot: {
          effectiveNowEpochMs: number;
          capturedAtEpochMs: number;
          isPaused: boolean;
          viewportWidthPx: number;
          exitPaddingPx: number;
          activeMotions: Array<{
            id: string;
            trackDrops?: boolean;
            startEpochMs: number;
            fadeStartEpochMs: number;
            startX: number;
            durationMs: number;
            laneIndex: number;
          }>;
        };
      };
      expect(snapshot.epoch).toBe(0);
      expect(isValidWorkerMessageSnapshot(snapshot)).toBe(true);
      expect(snapshot.motionSnapshot).toMatchObject({
        isPaused: true,
        viewportWidthPx: 640,
        exitPaddingPx: 100,
        effectiveNowEpochMs: performance.timeOrigin + 10_000,
        capturedAtEpochMs: performance.timeOrigin + 10_600,
      });
      expect(snapshot.motionSnapshot.activeMotions).toEqual([
        expect.objectContaining({
          id: active.id,
          startX: active.startX,
          durationMs: active.duration,
          trackDrops: false,
          laneIndex: active.laneIndex,
          startEpochMs: performance.timeOrigin + 10_800,
          fadeStartEpochMs: performance.timeOrigin + 10_750,
        }),
      ]);
    });

    it('keeps only the latest translation per id and reflows once per bounded frame batch', () => {
      const renderer = initializeRenderer({ translationBatchSize: 2, outlineWidthPx: 0 });
      const messages = ['one', 'two', 'three'].map((id) => makeWorkerMessage({ id }));
      renderer.handleMessage(makeEvent({ type: 'addMessages', messages }));
      const internals = renderer as unknown as {
        drainQueue(now: number, width: number, height: number): void;
        applyPendingTranslations(): void;
        reflowActiveMessages(): void;
        messageById: Map<string, { translatedText?: string | null; width: number }>;
        pendingTranslations: Map<string, unknown>;
      };
      internals.drainQueue(10_000, 640, 360);
      const reflow = vi.fn();
      internals.reflowActiveMessages = reflow;

      renderer.handleMessage(
        makeEvent({
          type: 'updateTranslation',
          id: 'one',
          translatedText: 'stale',
          width: 120,
          height: 20,
          translationHeight: 0,
          translationGeneration: 0,
        })
      );
      renderer.handleMessage(
        makeEvent({
          type: 'updateTranslation',
          id: 'one',
          translatedText: 'latest',
          width: 130,
          height: 20,
          translationHeight: 0,
          translationGeneration: 0,
        })
      );
      for (const id of ['two', 'three']) {
        renderer.handleMessage(
          makeEvent({
            type: 'updateTranslation',
            id,
            translatedText: `translated-${id}`,
            width: 130,
            height: 20,
            translationHeight: 0,
            translationGeneration: 0,
          })
        );
      }
      expect(internals.pendingTranslations.size).toBe(3);

      internals.applyPendingTranslations();
      expect(internals.messageById.get('one')?.translatedText).toBe('latest');
      expect(internals.messageById.get('two')?.translatedText).toBe('translated-two');
      expect(internals.messageById.get('three')?.translatedText).toBeUndefined();
      expect(reflow).toHaveBeenCalledOnce();

      internals.applyPendingTranslations();
      expect(internals.messageById.get('three')?.translatedText).toBe('translated-three');
      expect(reflow).toHaveBeenCalledTimes(2);
    });

    it('drops stale queued translations across replacement and config generations', () => {
      const renderer = initializeRenderer({ translationGeneration: 0 });
      const original = makeWorkerMessage({ id: 'stale-translation' });
      renderer.handleMessage(makeEvent({ type: 'addMessages', messages: [original] }));
      const internals = renderer as unknown as {
        applyPendingTranslations(): void;
        pendingTranslations: Map<string, unknown>;
        messageById: Map<string, { text: string; translatedText?: string | null }>;
      };
      renderer.handleMessage(
        makeEvent({
          type: 'updateTranslation',
          id: original.id,
          translatedText: 'old target',
          width: 120,
          height: 20,
          translationHeight: 0,
          translationGeneration: 0,
        })
      );
      renderer.handleMessage(
        makeEvent({ type: 'updateConfig', config: { translationGeneration: 1 } })
      );
      expect(internals.pendingTranslations.size).toBe(0);

      renderer.handleMessage(
        makeEvent({
          type: 'updateTranslation',
          id: original.id,
          translatedText: 'wrong generation',
          width: 120,
          height: 20,
          translationHeight: 0,
          translationGeneration: 0,
        })
      );
      renderer.handleMessage(
        makeEvent({
          type: 'addMessages',
          messages: [{ ...original, actionType: 'replace', text: 'replacement' }],
        })
      );
      internals.applyPendingTranslations();
      expect(internals.messageById.get(original.id)?.text).toBe('replacement');
      expect(internals.messageById.get(original.id)?.translatedText).toBeUndefined();
    });

    it('stops user-paused animation frames and resumes only after every pause cause clears', () => {
      const renderer = initializeRenderer();
      const requestFrame = vi.mocked(requestAnimationFrame);
      const cancelFrame = vi.mocked(cancelAnimationFrame);
      const initialRequests = requestFrame.mock.calls.length;

      renderer.handleMessage(makeEvent({ type: 'setUserPaused', paused: true }));
      expect(cancelFrame).toHaveBeenCalledOnce();
      renderer.handleMessage(
        makeEvent({ type: 'addMessages', messages: [makeWorkerMessage({ id: 'paused' })] })
      );
      expect(requestFrame).toHaveBeenCalledTimes(initialRequests);

      renderer.handleMessage(makeEvent({ type: 'setPaused', paused: true }));
      renderer.handleMessage(makeEvent({ type: 'setUserPaused', paused: false }));
      expect(requestFrame).toHaveBeenCalledTimes(initialRequests);
      renderer.handleMessage(makeEvent({ type: 'setPaused', paused: false }));
      expect(requestFrame).toHaveBeenCalledTimes(initialRequests + 1);
    });

    it('freezes active message elapsed time during a long user pause', () => {
      const renderer = initializeRenderer();
      const nowSpy = vi.mocked(performance.now);
      const internals = renderer as unknown as {
        activateMessage: (...args: unknown[]) => void;
        activeMessages: Array<{ pausedDuration: number }>;
      };
      internals.activateMessage(
        makeWorkerMessage(),
        9_000,
        { laneIndex: 0, waitMs: 0, laneY: 0, slotCount: 1, verticalOffset: 0 },
        0,
        0,
        1,
        640,
        360
      );

      nowSpy.mockReturnValue(10_000);
      renderer.handleMessage(makeEvent({ type: 'setUserPaused', paused: true }));
      nowSpy.mockReturnValue(130_000);
      renderer.handleMessage(makeEvent({ type: 'setUserPaused', paused: false }));

      expect(internals.activeMessages[0]?.pausedDuration).toBe(120_000);
    });

    it('resumes after visibility clears before an overlapping user pause', () => {
      const renderer = initializeRenderer();
      const requestFrame = vi.mocked(requestAnimationFrame);
      const initialRequests = requestFrame.mock.calls.length;

      renderer.handleMessage(makeEvent({ type: 'setUserPaused', paused: true }));
      renderer.handleMessage(makeEvent({ type: 'setPaused', paused: true }));
      renderer.handleMessage(makeEvent({ type: 'setPaused', paused: false }));
      expect(requestFrame).toHaveBeenCalledTimes(initialRequests);

      renderer.handleMessage(makeEvent({ type: 'setUserPaused', paused: false }));
      expect(requestFrame).toHaveBeenCalledTimes(initialRequests + 1);
    });

    it('preserves text caches for timing changes and invalidates them for font changes', () => {
      const renderer = initializeRenderer();
      const internals = renderer as unknown as {
        textMeasureCache: Map<string, number>;
        textBitmapCache: {
          set(key: string, value: OffscreenCanvas): boolean;
          clear(): void;
          size: number;
        };
      };
      internals.textMeasureCache.clear();
      internals.textBitmapCache.clear();
      internals.textMeasureCache.set('measure', 10);
      const bitmapCanvas = new MockOffscreenCanvas() as unknown as OffscreenCanvas;
      Object.assign(bitmapCanvas, { width: 2, height: 2 });
      internals.textBitmapCache.set('bitmap', bitmapCanvas);

      renderer.handleMessage(
        makeEvent({ type: 'updateConfig', config: { ...makeMinimalConfig(), opacity: 0.5 } })
      );
      expect(internals.textMeasureCache.size).toBe(1);
      expect(internals.textBitmapCache.size).toBe(1);

      renderer.handleMessage(makeEvent({ type: 'updateConfig', config: { fontFamily: 'serif' } }));
      expect(internals.textMeasureCache.size).toBe(0);
      expect(internals.textBitmapCache.size).toBe(0);
    });

    it('does not throw for unknown message type', () => {
      expect(() => getHandler()(makeEvent({ type: 'nonexistent' }))).not.toThrow();
    });

    it('does not throw for malformed data (null)', () => {
      expect(() => getHandler()({ data: null } as unknown as MessageEvent)).not.toThrow();
    });

    it('does not throw for missing type field', () => {
      expect(() => getHandler()(makeEvent({}))).not.toThrow();
    });

    it('destroy does not throw even without prior init', () => {
      expect(() => getHandler()(makeEvent({ type: 'destroy' }))).not.toThrow();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Worker types — compile-time verification
// ═══════════════════════════════════════════════════════════════════════════

import type { WorkerConfig } from '@renderer/worker/types';

describe('Worker types', () => {
  it('WorkerConfig type is importable (compile-time check)', () => {
    const config: WorkerConfig = makeMinimalConfig() as unknown as WorkerConfig;
    expect(config).toBeDefined();
  });
});
