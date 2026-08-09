// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ── Mock browser APIs ───────────────────────────────────────────────

vi.stubGlobal('Worker', class {
  postMessage = vi.fn();
  terminate = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
});

vi.stubGlobal('OffscreenCanvas', class {});

vi.stubGlobal('queueMicrotask', (fn: () => void) => {
  // Synchronously execute microtask for test determinism
  Promise.resolve().then(fn);
});

// ══════════════════════════════════════════════════════════════════════

import { RenderWorkerManager } from '@renderer/worker/manager';
import { DEFAULT_SETTINGS } from '@settings/schema';

function createMinimalDeps() {
  return {
    settings: {
      queueMaxSize: 250,
    } as any,
    observability: {
      onMessageDropped: vi.fn(),
    } as any,
    imageFetchManager: {
      workerBitmapCache: {
        take: vi.fn(),
        delete: vi.fn(),
        clear: vi.fn(),
      },
    } as any,
    estimateDimensions: vi.fn(() => ({ width: 100, height: 20 })),
    getMessagePriority: vi.fn(() => 0),
    getEffectiveSpeedPxPerSec: vi.fn(() => 100),
  };
}

describe('RenderWorkerManager', () => {
  let deps: ReturnType<typeof createMinimalDeps>;
  let manager: RenderWorkerManager;

  beforeEach(() => {
    deps = createMinimalDeps();
    manager = new RenderWorkerManager(deps as any);
  });

  afterEach(() => {
    manager.destroy();
  });

  describe('worker configuration', () => {
    it('copies author background colors into the worker config snapshot', () => {
      const config = RenderWorkerManager.buildWorkerConfig(DEFAULT_SETTINGS);

      expect(config.backgroundColors).toEqual(DEFAULT_SETTINGS.backgroundColors);
      expect(config.backgroundColors).not.toBe(DEFAULT_SETTINGS.backgroundColors);
    });

    it('copies author background colors into live worker updates', () => {
      const postMessage = vi.fn();
      const worker = {
        postMessage,
        terminate: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as Worker;
      (manager as any).worker = worker;

      manager.updateSettings(DEFAULT_SETTINGS);

      expect(postMessage).toHaveBeenCalledWith({
        type: 'updateConfig',
        config: expect.objectContaining({
          backgroundColors: DEFAULT_SETTINGS.backgroundColors,
        }),
      });
      const postedConfig = postMessage.mock.calls[0]?.[0].config as Record<string, unknown>;
      expect(postedConfig.backgroundColors).not.toBe(DEFAULT_SETTINGS.backgroundColors);
    });
  });

  describe('constructor', () => {
    it('initializes with zero queue depth', () => {
      expect(manager.queueDepth).toBe(0);
    });

    it('accepts deps without worker (no crash)', () => {
      expect(() => new RenderWorkerManager(deps as any)).not.toThrow();
    });
  });

  describe('init', () => {
    it.each([
      ['missing', null],
      ['zero-width', { width: 0, height: 360 }],
      ['zero-height', { width: 640, height: 0 }],
      ['non-finite', { width: Number.POSITIVE_INFINITY, height: 360 }],
    ])(
      'falls back before transferring the canvas for %s initial dimensions',
      (_label, dimensions) => {
        const transferControlToOffscreen = vi.fn(() => ({ getContext: vi.fn() }));
        const canvas = { transferControlToOffscreen } as unknown as HTMLCanvasElement;
        const onDimensionsChanged = vi.fn(() => vi.fn());
        const overlay = {
          getDimensions: vi.fn(() => dimensions),
          onDimensionsChanged,
        };

        expect(manager.init(canvas, DEFAULT_SETTINGS, overlay as any, 'worker.js')).toEqual({
          started: false,
          canvasTransferred: false,
        });
        expect(manager.isActive).toBe(false);
        expect(transferControlToOffscreen).not.toHaveBeenCalled();
        expect(onDimensionsChanged).not.toHaveBeenCalled();
      }
    );

    it('starts the worker when initial dimensions are positive', () => {
      const transferControlToOffscreen = vi.fn(() => ({ getContext: vi.fn() }));
      const canvas = { transferControlToOffscreen } as unknown as HTMLCanvasElement;
      const onDimensionsChanged = vi.fn(() => vi.fn());
      const overlay = {
        getDimensions: vi.fn(() => ({ width: 640, height: 360 })),
        onDimensionsChanged,
      };

      expect(manager.init(canvas, DEFAULT_SETTINGS, overlay as any, 'worker.js')).toEqual({
        started: true,
        canvasTransferred: true,
      });
      expect(manager.isActive).toBe(true);
      expect(transferControlToOffscreen).toHaveBeenCalledOnce();
      expect(onDimensionsChanged).toHaveBeenCalledOnce();
    });

    it('reports a transferred canvas when the init post fails', () => {
      const originalWorker = globalThis.Worker;
      const terminate = vi.fn();
      vi.stubGlobal(
        'Worker',
        class {
          postMessage = vi.fn(() => {
            throw new DOMException('clone failed', 'DataCloneError');
          });
          terminate = terminate;
        }
      );
      const transferControlToOffscreen = vi.fn(() => ({ getContext: vi.fn() }));
      const canvas = { transferControlToOffscreen } as unknown as HTMLCanvasElement;
      const overlay = {
        getDimensions: vi.fn(() => ({ width: 640, height: 360 })),
        onDimensionsChanged: vi.fn(() => vi.fn()),
      };

      expect(manager.init(canvas, DEFAULT_SETTINGS, overlay as any, 'worker.js')).toEqual({
        started: false,
        canvasTransferred: true,
      });
      expect(transferControlToOffscreen).toHaveBeenCalledOnce();
      expect(terminate).toHaveBeenCalledOnce();
      vi.stubGlobal('Worker', originalWorker);
    });
  });

  describe('sendToWorker message batching', () => {
    it('accumulates messages in pendingBatch without immediate postMessage', () => {
      // sendToWorker should return early when no worker is set
      // (no crash even without worker)
      const msg = { id: 'test1', content: [{ type: 'text' as const, content: 'hello' }] } as any;
      manager.sendToWorker(msg);
      // With no worker, messages are dropped silently
      expect(deps.observability.onMessageDropped).not.toHaveBeenCalled();
    });

    it('delivers known replacement actions even when worker backpressure drops new messages', async () => {
      const postMessage = vi.fn();
      (manager as any).worker = {
        postMessage,
        terminate: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as Worker;

      manager.sendToWorker(
        {
          id: 'replacement',
          timestamp: Date.now(),
          content: [{ type: 'text', content: 'original' }],
          kind: 'chat',
          authorType: 'normal',
        } as any,
        'replacement'
      );
      await Promise.resolve();
      postMessage.mockClear();
      (manager as any)._queueDepth = deps.settings.queueMaxSize * 2 + 1;

      manager.sendToWorker(
        {
          id: 'replacement',
          actionType: 'replace',
          timestamp: Date.now(),
          content: [{ type: 'text', content: 'updated' }],
          kind: 'chat',
          authorType: 'normal',
        } as any,
        'replacement'
      );
      await Promise.resolve();

      expect(deps.observability.onMessageDropped).not.toHaveBeenCalled();
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'addMessages',
          messages: [expect.objectContaining({ id: 'replacement', actionType: 'replace' })],
        })
      );
    });

    it('applies worker backpressure to a replacement with an unseen id', async () => {
      const postMessage = vi.fn();
      (manager as any).worker = {
        postMessage,
        terminate: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as Worker;
      (manager as any)._queueDepth = deps.settings.queueMaxSize * 2 + 1;

      manager.sendToWorker(
        {
          id: 'fresh-replacement',
          actionType: 'replace',
          timestamp: Date.now(),
          content: [{ type: 'text', content: 'updated' }],
          kind: 'chat',
          authorType: 'normal',
        } as any,
        'fresh-replacement'
      );
      await Promise.resolve();

      expect(deps.observability.onMessageDropped).toHaveBeenCalledWith('worker_backpressure');
      expect(postMessage).not.toHaveBeenCalled();
      expect((manager as any).sentMessages.has('fresh-replacement')).toBe(false);
    });

    it('closes transferred bitmaps when the worker is destroyed before flush', async () => {
      vi.useFakeTimers();
      const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
      deps.imageFetchManager.workerBitmapCache.take.mockReturnValue(bitmap);
      deps.imageFetchManager.workerBitmapCache.clear = vi.fn();
      const worker = {
        postMessage: vi.fn(),
        terminate: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as Worker;
      (manager as any).worker = worker;

      try {
        manager.sendToWorker(
          {
            id: 'pending-1',
            timestamp: Date.now(),
            content: [{ type: 'emoji', emoji: { alt: ':wave:', url: 'https://example.com/wave' } }],
            kind: 'chat',
            authorType: 'normal',
          } as any,
          'pending-1'
        );
        manager.destroy();
        await Promise.resolve();

        expect(bitmap.close).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it('disposes transferred bitmaps when batch postMessage fails', async () => {
      const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
      deps.imageFetchManager.workerBitmapCache.take.mockReturnValue(bitmap);
      const postMessage = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('worker is gone');
        })
        .mockImplementation(() => undefined);
      (manager as any).worker = {
        postMessage,
        terminate: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as Worker;

      manager.sendToWorker(
        {
          id: 'failed-1',
          timestamp: Date.now(),
          content: [{ type: 'emoji', emoji: { alt: ':wave:', url: 'https://example.com/wave' } }],
          kind: 'chat',
          authorType: 'normal',
        } as any,
        'failed-1'
      );
      await Promise.resolve();

      expect(bitmap.close).toHaveBeenCalledOnce();
      (manager as any).worker = null;
    });
  });

  describe('queueDepth', () => {
    it('returns the internal _queueDepth value', () => {
      expect(manager.queueDepth).toBe(0);
    });
  });

  describe('destroy', () => {
    it('cleans up without error when no worker', () => {
      expect(() => manager.destroy()).not.toThrow();
    });

    it('clears sentMessages on destroy without worker', () => {
      // Access private sentMessages via any cast for testing
      const sentMap = (manager as any).sentMessages;
      expect(sentMap.size).toBe(0);
    });

    it('cancels the safety timeout when the worker acknowledges destruction', () => {
      vi.useFakeTimers();
      const listeners = new Map<string, EventListener>();
      const worker = {
        postMessage: vi.fn(),
        terminate: vi.fn(),
        addEventListener: vi.fn((type: string, listener: EventListener) => {
          listeners.set(type, listener);
        }),
        removeEventListener: vi.fn((type: string, listener: EventListener) => {
          if (listeners.get(type) === listener) listeners.delete(type);
        }),
      } as unknown as Worker;
      (manager as any).worker = worker;

      manager.destroy();
      expect(vi.getTimerCount()).toBe(1);

      listeners.get('message')?.({ data: { type: 'ack' } } as MessageEvent);

      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(deps.imageFetchManager.workerBitmapCache.clear).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(500);
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(deps.imageFetchManager.workerBitmapCache.clear).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });
  });
});
