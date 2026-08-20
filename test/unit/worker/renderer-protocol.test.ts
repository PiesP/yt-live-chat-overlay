// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock browser APIs before module import ───────────────────────────────

const mockCtx = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  measureText: vi.fn(() => ({ width: 100, actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 4 })),
  fillText: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), drawImage: vi.fn(),
  save: vi.fn(), restore: vi.fn(), translate: vi.fn(),
  beginPath: vi.fn(), closePath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
  arc: vi.fn(), arcTo: vi.fn(), fill: vi.fn(), stroke: vi.fn(), clip: vi.fn(),
  createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  putImageData: vi.fn(),
  getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(100) })),
  font: '', textBaseline: 'top', textAlign: 'left',
  textRendering: 'optimizeSpeed', fontKerning: 'none',
  fillStyle: '', strokeStyle: '', lineWidth: 1,
  globalAlpha: 1, filter: 'none', imageSmoothingEnabled: true,
};

const MockOffscreenCanvas = class {
  getContext() { return mockCtx; }
};

vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);
vi.stubGlobal('ImageBitmap', class { close() {} });
vi.stubGlobal('OffscreenCanvasRenderingContext2D', class {});
vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve({ close: vi.fn() })));

let rAFId = 1;
vi.stubGlobal('requestAnimationFrame', () => rAFId++);
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

import { resetWorkerForTests, WorkerRenderer } from '@renderer/worker/renderer';
import type { WorkerMessage } from '@renderer/worker/types';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeMinimalConfig(): Record<string, unknown> {
  return {
    fontSize: 16, speedPxPerSec: 100, fontFamily: 'sans-serif',
    opacity: 1, safeTop: 0.05, safeBottom: 0.05, laneSpacing: 4,
    maxConcurrentMessages: 200, danmakuMode: 'scroll',
    backlogSpeedMultiplier: 1, depthLayersEnabled: false,
    depthFarSpeedMul: 1, depthNearSpeedMul: 1, depthFarOpacityMul: 0.6,
    motionBlurEnabled: false, motionBlurAlpha: 0.03,
    backlogOpacityMultiplier: 0.5, fadeDurationMs: 300,
    maxMessageAgeMs: 30000, color: '#fff', authorColors: {}, backgroundColors: {},
    modOwnerDurationMultiplier: 1.5, outlineWidthPx: 2, outlineOpacity: 0.8,
    superChatOpacity: 0.85, superChatMaxBodyLines: 2,
    membershipMaxBodyLines: 2, showAuthor: {},
    translationEnabled: false, translationMode: 'dual',
    showSuperChatAmount: true, exitPaddingPx: 100,
    scrollDurationMinMs: 1000, scrollDurationMaxMs: 15000,
    topBottomDurationMs: 5000, headwayGapRatio: 0.08,
    queueMaxSize: 500, backgroundQueueMax: 200, emojiCacheMb: 4,
    photoCacheMb: 2, stickerCacheMb: 2, textCacheMb: 4,
    translationBatchSize: 5, emojiFetchLimit: 10,
    failedEmojiRetryMins: 5, staggerMaxDelayMs: 200,
    staggerMediumDelayMs: 100, emojiFetchTimeoutMs: 5000,
    ignoreReducedMotion: false, reducedMotion: false,
    preserveUserColor: false, isReplayMode: false,
    fontBaseViewportHeight: 1080, fontMinSize: 10, fontMaxSize: 120,
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
  it('sets self.onmessage at import time', () => {
    expect(typeof getHandler()).toBe('function');
  });

  it('resetWorkerForTests does not throw', () => {
    expect(() => resetWorkerForTests()).not.toThrow();
  });
});

describe('Worker message protocol', () => {
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

  describe('init error case', () => {
    it('posts error when canvas getContext returns null', () => {
      const BadCanvas = class { getContext() { return null; } };
      vi.stubGlobal('OffscreenCanvas', BadCanvas);

      getHandler()(makeEvent({
        type: 'init',
        config: makeMinimalConfig(),
        canvas: new BadCanvas(),
        dpr: 1,
        width: 640,
        height: 360,
      }));

      expect(postMessageSpy).toHaveBeenCalledWith({
        type: 'error',
        error: 'Failed to get 2D context',
      });
    });
  });

  describe('resize', () => {
    it('handles resize without errors after init', () => {
      getHandler()(makeEvent({
        type: 'init',
        config: makeMinimalConfig(),
        canvas: new MockOffscreenCanvas(),
        dpr: 1,
        width: 640,
        height: 360,
      }));
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

    it('drops messages that require more lanes than the viewport has', () => {
      const renderer = initializeRenderer();
      const internals = renderer as unknown as {
        drainQueue: (now: number, width: number, height: number) => void;
        pendingQueue: WorkerMessage[];
        totalDrops: number;
      };
      const oversized = makeWorkerMessage({ height: 10_000 });

      renderer.handleMessage(makeEvent({ type: 'addMessages', messages: [oversized] }));
      internals.drainQueue(10_000, 640, 360);

      expect(internals.pendingQueue).toHaveLength(0);
      expect(internals.totalDrops).toBe(1);
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

      expect(
        internals.checkCollision(placement, makeWorkerMessage(), 1, 0, 0, 10_000, 640)
      ).toBe(true);
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

    it('preserves decoded image caches across ordinary config updates', () => {
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
      renderer.handleMessage(makeEvent({ type: 'updateConfig', config: { opacity: 0.5 } }));

      expect(internals.emojiCache.size).toBe(1);
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
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        blob: async () => new Blob(['image']),
      } as Response);

      await internals.prefetchImages([url], internals.emojiCache);

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(internals.emojiCache.has(url)).toBe(true);
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
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok,
        blob: async () => new Blob(['image']),
      } as Response);
      if (ok) vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('decode failed'));

      await internals.prefetchImages([url], internals.emojiCache);
      await internals.prefetchImages([url], internals.emojiCache);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(internals.failedImageFetches.has(url)).toBe(true);

      nowSpy.mockReturnValue(61_001);
      await internals.prefetchImages([url], internals.emojiCache);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
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
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        blob: async () => new Blob(['image']),
      } as Response);

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

      expect(postMessageSpy).toHaveBeenCalledWith({
        type: 'messageSnapshot',
        requestId: 7,
        messageIds: ['pending-message'],
      });
    });

    it('uses the pending array as the single queue cursor while preserving every snapshot id', () => {
      const renderer = initializeRenderer();
      const first = makeWorkerMessage({ id: 'pending-first', priority: 10 });
      const second = makeWorkerMessage({ id: 'pending-second', priority: 20 });

      renderer.handleMessage(makeEvent({ type: 'addMessages', messages: [first, second] }));
      postMessageSpy.mockClear();
      renderer.handleMessage(makeEvent({ type: 'snapshotMessages', requestId: 8 }));

      expect(renderer).not.toHaveProperty('pendingQueueOffset');
      expect(postMessageSpy).toHaveBeenCalledWith({
        type: 'messageSnapshot',
        requestId: 8,
        messageIds: ['pending-first', 'pending-second'],
      });
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
