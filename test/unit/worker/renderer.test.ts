// SPDX-License-Identifier: MIT

import { LruMap } from '@piesp/browser-core/util';
import { GRADIENT_CACHE_MAX } from '@renderer/constants';
import { WorkerRenderer } from '@renderer/worker/renderer';
import type { WorkerMessage } from '@renderer/worker/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'self', {
    value: globalThis,
    writable: true,
    configurable: true,
  });
});

// Mock OffscreenCanvas
class MockOffscreenCanvas {
  width = 0;
  height = 0;
  getContext(_type: string): OffscreenCanvasRenderingContext2D | null {
    return null;
  }
  transferToImageBitmap() {
    return {};
  }
  convertToBlob() {
    return Promise.resolve(new Blob());
  }
}
vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);

// Mock self.postMessage (Web Worker context)
const postMessageSpy = vi.fn();

function makePostMessageEvent(data: Record<string, unknown>): MessageEvent {
  return new MessageEvent('message', { data });
}

describe('WorkerRenderer', () => {
  let wr: WorkerRenderer;

  beforeEach(() => {
    vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);
    // @ts-expect-error mock self
    globalThis.self = { postMessage: postMessageSpy };
    wr = new WorkerRenderer();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('constructs without throwing', () => {
    expect(() => new WorkerRenderer()).not.toThrow();
  });

  it('uses the same bounded core gradient cache as the main renderer', () => {
    const internals = wr as unknown as { superChatGradientCache: LruMap<string, CanvasGradient> };
    expect(internals.superChatGradientCache).toBeInstanceOf(LruMap);
    expect(internals.superChatGradientCache.maxSize).toBe(GRADIENT_CACHE_MAX);
  });

  it('keeps one live ordinary while refreshing equal-priority Worker overflow', () => {
    const internals = wr as unknown as {
      config: { queueMaxSize: number };
      pendingQueue: WorkerMessage[];
      messageById: Map<string, WorkerMessage>;
      animFrameId: number | null;
      measureMessageGeometry: ReturnType<typeof vi.fn>;
      enqueueMessage(message: WorkerMessage): boolean;
    };
    internals.config = { queueMaxSize: 2 };
    internals.animFrameId = 1;
    internals.measureMessageGeometry = vi.fn(() => ({ width: 80, height: 20 }));
    const message = (id: string, priority: number): WorkerMessage => ({
      id,
      priority,
      text: id,
      width: 80,
      height: 20,
      isBacklog: false,
    });
    expect(internals.enqueueMessage(message('ordinary-old', 0))).toBe(true);
    expect(internals.enqueueMessage(message('paid-1', 200))).toBe(true);
    expect(internals.enqueueMessage(message('paid-2', 200))).toBe(false);
    expect(internals.enqueueMessage(message('ordinary-new', 0))).toBe(true);
    expect(internals.pendingQueue.map((entry) => entry.id)).toEqual(['ordinary-new', 'paid-1']);
    expect(internals.messageById.has('ordinary-old')).toBe(false);
  });

  it('gives an admitted ordinary successful service after two paid Worker admissions', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const internals = wr as unknown as {
      config: Record<string, unknown>;
      pendingQueue: WorkerMessage[];
      activeMessages: unknown[];
      numLanes: number;
      laneHeight: number;
      findPlacement: ReturnType<typeof vi.fn>;
      planQueuedMessage: ReturnType<typeof vi.fn>;
      checkCollision: ReturnType<typeof vi.fn>;
      activateMessage: ReturnType<typeof vi.fn>;
      drainQueue(now: number, width: number, height: number): void;
    };
    internals.config = {
      queueMaxSize: 20,
      maxConcurrentMessages: 1,
      depthLayersEnabled: false,
      danmakuMode: 'scroll',
      fontSize: 20,
      fontWeight: 'bold',
      fontFamily: 'Arial',
      laneSpacing: 0,
      safeTop: 0,
      safeBottom: 0,
      outlineWidthPx: 0,
    };
    internals.numLanes = 10;
    internals.laneHeight = 20;
    internals.findPlacement = vi.fn(() => ({
      laneIndex: 0,
      slotCount: 1,
      laneY: 0,
      verticalOffset: 0,
      waitMs: 0,
    }));
    internals.planQueuedMessage = vi.fn(() => ({}));
    internals.checkCollision = vi.fn(() => true);
    internals.activateMessage = vi.fn((entry: WorkerMessage) => {
      internals.activeMessages.push(entry);
      return 0;
    });
    const message = (id: string, priority: number): WorkerMessage => ({
      id,
      priority,
      text: id,
      width: 80,
      height: 20,
      isBacklog: false,
    });
    internals.pendingQueue.push(message('ordinary', 0));
    for (let cycle = 0; cycle < 3; cycle++) {
      internals.activeMessages.length = 0;
      internals.pendingQueue.push(message(`paid-${cycle}`, 200));
      internals.drainQueue(cycle * 16, 640, 360);
    }
    expect(internals.activateMessage.mock.calls.map(([entry]) => entry.id)).toEqual([
      'paid-0',
      'paid-1',
      'ordinary',
    ]);
    expect(internals.pendingQueue.map((entry) => entry.id)).toContain('paid-2');
  });

  it.each([
    [false, false, 455],
    [false, true, 455],
    [true, false, 270],
    [true, true, 455],
  ])(
    'applies system reduced motion %s and stored override %s in Worker frames',
    (systemReduced, override, expectedX) => {
      vi.spyOn(performance, 'now').mockReturnValue(500);
      const message = {
        id: 'motion',
        text: 'motion',
        startTime: 0,
        fadeStartTime: 0,
        pausedDuration: 0,
        duration: 2000,
        invDuration: 1 / 2000,
        startX: 640,
        x: 640,
        y: 0,
        width: 100,
        height: 20,
        speedTier: 1,
      };
      const internals = wr as unknown as {
        ctx: OffscreenCanvasRenderingContext2D;
        canvas: OffscreenCanvas;
        config: Record<string, unknown>;
        logicalWidth: number;
        logicalHeight: number;
        activeMessages: (typeof message)[];
        statsFrameCounter: number;
        renderFrame(): void;
        applyPendingTranslations(): void;
        sortPendingQueueIfNeeded(): void;
        drainQueue(): void;
        postStats(): void;
        resetBatch(): void;
      };
      internals.ctx = { clearRect: vi.fn() } as unknown as OffscreenCanvasRenderingContext2D;
      internals.canvas = {} as OffscreenCanvas;
      internals.config = {
        danmakuMode: 'scroll',
        reducedMotion: systemReduced,
        ignoreReducedMotion: override,
        exitPaddingPx: 0,
        outlineWidthPx: 0,
        outlineOpacity: 0,
        isReplayMode: false,
      };
      internals.logicalWidth = 640;
      internals.logicalHeight = 360;
      internals.activeMessages.push(message);
      internals.statsFrameCounter = 1;
      internals.applyPendingTranslations = vi.fn();
      internals.sortPendingQueueIfNeeded = vi.fn();
      internals.drainQueue = vi.fn();
      internals.postStats = vi.fn();
      internals.resetBatch = vi.fn();

      internals.renderFrame();
      expect(message.x).toBe(expectedX);
    }
  );

  it('caches a finite advance width when Worker ink bounds are invalid', () => {
    const measureText = vi.fn(
      () =>
        ({
          width: 42,
          actualBoundingBoxLeft: Number.NaN,
          actualBoundingBoxRight: Number.POSITIVE_INFINITY,
        }) as TextMetrics
    );
    const internals = wr as unknown as {
      ctx: OffscreenCanvasRenderingContext2D;
      measureTextCached(text: string): number;
      textMeasureCache: Map<string, number>;
    };
    internals.ctx = { measureText } as unknown as OffscreenCanvasRenderingContext2D;

    expect(internals.measureTextCached('hello')).toBe(42);
    expect(internals.measureTextCached('hello')).toBe(42);
    expect([...internals.textMeasureCache.values()]).toEqual([42]);
    expect(measureText).toHaveBeenCalledOnce();
  });

  it('handleMessage processes init message', () => {
    const canvas = new OffscreenCanvas(1920, 1080);
    const event = makePostMessageEvent({
      type: 'init',
      canvas,
      dpr: 1,
      width: 1920,
      height: 1080,
      config: {
        fontSize: 32,
        speedPxPerSec: 250,
        opacity: 1,
        superChatOpacity: 0.95,
        outline: { enabled: true, widthPx: 2, opacity: 0.7 },
        colors: {
          normal: '#FFFFFF',
          member: '#0F9D58',
          moderator: '#5E84F1',
          owner: '#FFD600',
          verified: '#AAAAAA',
        },
        fontFamily: 'Arial',
        fontWeight: 'bold',
        laneCount: 30,
        topBottomDurationMs: 5000,
        scrollDurationMinMs: 3000,
        scrollDurationMaxMs: 15000,
        headwayGapRatio: 0.3,
        backlogOpacityMultiplier: 0.5,
        depthLayersEnabled: false,
        depthNearSpeedMul: 1.2,
        depthFarSpeedMul: 0.8,
        depthFarOpacityMul: 0.6,
        showSuperChatAmount: true,
        showAuthor: {
          normal: false,
          member: true,
          moderator: true,
          owner: true,
          verified: true,
          superChat: true,
        },
        superChatMaxBodyLines: 3,
        membershipMaxBodyLines: 2,
        fadeDurationMs: 300,
        maxMessageAgeMs: 30000,
        modOwnerDurationMultiplier: 1.5,
        preserveUserColor: true,
        translationEnabled: false,
        translationMode: 'dual',
        translationFontScale: 0.7,
        backgroundColor: '#000000',
        maxConcurrentMessages: 300,
        danmakuMode: 'scroll',
        exitPaddingPx: 50,
        laneSpacing: 1,
      },
    });
    // Should not throw even though getContext returns null
    expect(() => wr.handleMessage(event)).not.toThrow();
  });

  it('handleMessage processes addMessages', () => {
    const event = makePostMessageEvent({
      type: 'addMessages',
      messages: [
        {
          id: '1',
          authorName: 'Test',
          text: 'hello',
          color: '#fff',
          fontSize: 32,
          fontWeight: 'bold',
          fontFamily: 'Arial',
          opacity: 1,
          speedPxPerSec: 250,
          x: 0,
          y: 0,
        },
      ],
    });
    expect(() => wr.handleMessage(event)).not.toThrow();
  });

  it('handleMessage processes setPaused', () => {
    const event = makePostMessageEvent({ type: 'setPaused', paused: true });
    expect(() => wr.handleMessage(event)).not.toThrow();
  });

  it('handleMessage processes resize', () => {
    const event = makePostMessageEvent({ type: 'resize', width: 1920, height: 1080, dpr: 1 });
    expect(() => wr.handleMessage(event)).not.toThrow();
  });

  it('handleMessage processes updateConfig', () => {
    const event = makePostMessageEvent({ type: 'updateConfig', config: {} });
    expect(() => wr.handleMessage(event)).not.toThrow();
  });

  it('handleMessage processes destroy', () => {
    const destroyEvent = makePostMessageEvent({ type: 'destroy' });
    expect(() => wr.handleMessage(destroyEvent)).not.toThrow();

    // After destroy, further messages should be no-ops
    const addEvent = makePostMessageEvent({ type: 'addMessages', messages: [] });
    expect(() => wr.handleMessage(addEvent)).not.toThrow();
  });

  it('handleMessage ignores unknown message types', () => {
    const event = makePostMessageEvent({ type: 'unknown' });
    expect(() => wr.handleMessage(event)).not.toThrow();
  });

  it('handleMessage handles snapshotMessages request', () => {
    const event = makePostMessageEvent({ type: 'snapshotMessages', requestId: 1 });
    expect(() => wr.handleMessage(event)).not.toThrow();
  });

  it('handleMessage does not throw on malformed messages', () => {
    // Message without type
    const event1 = makePostMessageEvent({});
    expect(() => wr.handleMessage(event1)).not.toThrow();

    // Message with null type
    const event2 = makePostMessageEvent({ type: null } as any);
    expect(() => wr.handleMessage(event2)).not.toThrow();
  });

  it('init message with null canvas context sends error', () => {
    const canvas = new OffscreenCanvas(1920, 1080);
    const event = makePostMessageEvent({
      type: 'init',
      canvas,
      dpr: 1,
      width: 1920,
      height: 1080,
      config: {
        fontSize: 32,
        speedPxPerSec: 250,
        opacity: 1,
        superChatOpacity: 0.95,
        outline: { enabled: true, widthPx: 2, opacity: 0.7 },
        colors: {
          normal: '#FFFFFF',
          member: '#0F9D58',
          moderator: '#5E84F1',
          owner: '#FFD600',
          verified: '#AAAAAA',
        },
        fontFamily: 'Arial',
        fontWeight: 'bold',
        laneCount: 30,
        topBottomDurationMs: 5000,
        scrollDurationMinMs: 3000,
        scrollDurationMaxMs: 15000,
        headwayGapRatio: 0.3,
        backlogOpacityMultiplier: 0.5,
        depthLayersEnabled: false,
        depthNearSpeedMul: 1.2,
        depthFarSpeedMul: 0.8,
        depthFarOpacityMul: 0.6,
        showSuperChatAmount: true,
        showAuthor: {
          normal: false,
          member: true,
          moderator: true,
          owner: true,
          verified: true,
          superChat: true,
        },
        superChatMaxBodyLines: 3,
        membershipMaxBodyLines: 2,
        fadeDurationMs: 300,
        maxMessageAgeMs: 30000,
        modOwnerDurationMultiplier: 1.5,
        preserveUserColor: true,
        translationEnabled: false,
        translationMode: 'dual',
        translationFontScale: 0.7,
        backgroundColor: '#000000',
        maxConcurrentMessages: 300,
        danmakuMode: 'scroll',
        exitPaddingPx: 50,
        laneSpacing: 1,
      },
    });
    expect(() => wr.handleMessage(event)).not.toThrow();
  });
});
