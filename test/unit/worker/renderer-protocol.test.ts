// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

function initializeRenderer(): WorkerRenderer {
  const renderer = new WorkerRenderer();
  renderer.handleMessage(
    makeEvent({
      type: 'init',
      config: makeMinimalConfig(),
      canvas: new MockOffscreenCanvas(),
      dpr: 1,
      width: 640,
      height: 360,
    })
  );
  return renderer;
}

beforeEach(() => {
  postMessageSpy.mockClear();
  // Spy on performance.now again (clearAllMocks removes it)
  vi.spyOn(performance, 'now').mockReturnValue(10000);
  resetWorkerForTests();
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

      getHandler()(makeEvent({ type: 'resize', width: 640, height: 360 }));

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
        640,
        360
      );

      expect(internals.activeMessages[0]?.startTime).toBe(10_125);
      expect(internals.activeMessages[0]?.fadeStartTime).toBe(10_125);
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
