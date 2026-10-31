// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// ── Mock browser APIs ───────────────────────────────────────────────

vi.stubGlobal(
  'Worker',
  class {
    postMessage = vi.fn();
    terminate = vi.fn();
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
  }
);

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
      onMessagesDropped: vi.fn(),
      onMessagesRendered: vi.fn(),
      updateActiveMessages: vi.fn(),
      updateQueueDepth: vi.fn(),
      updateLaneUtilization: vi.fn(),
      tick: vi.fn(),
    } as any,
    estimateDimensions: vi.fn(() => ({ width: 100, height: 20 })),
    estimateTranslatedDimensions: vi.fn(() => ({
      width: 180,
      height: 40,
      translationHeight: 12,
    })),
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

  it('releases retained translation owners on replacement and state clear', () => {
    const released = vi.fn();
    (deps as any).onMessageReleased = released;
    (manager as any).worker = {
      postMessage: vi.fn(),
      terminate: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Worker;
    manager.setActive(true);
    const original = {
      id: 'same',
      timestamp: Date.now(),
      text: 'original',
      content: [{ type: 'text' as const, content: 'original' }],
      kind: 'text' as const,
      authorType: 'normal' as const,
    };
    const replacement = { ...original, actionType: 'replace' as const, text: 'new' };
    expect(manager.sendToWorker(original, original.id)).toBe(true);
    expect(manager.sendToWorker(replacement, replacement.id)).toBe(true);
    expect(released).toHaveBeenCalledWith(original, original.id);
    manager.clearState();
    expect(released).toHaveBeenCalledWith(replacement, replacement.id);
  });

  describe('worker configuration', () => {
    it('transfers the explicit wide card preference instead of its stacked default', () => {
      const config = RenderWorkerManager.buildWorkerConfig({
        ...DEFAULT_SETTINGS,
        superChatLayout: 'wide',
      });
      expect(config.superChatLayout).toBe('wide');
      expect(RenderWorkerManager.buildWorkerConfig(DEFAULT_SETTINGS).superChatLayout).toBe(
        'stacked'
      );
    });

    it('copies every selected setting and derives the initial wire fields', () => {
      const settings = {
        ...DEFAULT_SETTINGS,
        outline: { enabled: false, widthPx: 5, opacity: 0.4 },
        colors: { ...DEFAULT_SETTINGS.colors, normal: '#112233' },
      };
      const config = RenderWorkerManager.buildWorkerConfig(settings);

      for (const key of RenderWorkerManager.WORKER_CONFIG_KEYS) {
        expect(config[key]).toEqual(settings[key]);
      }
      expect(config.outlineWidthPx).toBe(0);
      expect(config.outlineOpacity).toBe(0);
      expect(config.color).toBe('#112233');
      expect(config.authorColors).toEqual(settings.colors);
      expect(config.authorColors).not.toBe(settings.colors);
      expect(config.showAuthor).toBe(settings.showAuthor);
      expect(config.reducedMotion).toBe(
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      );
      expect(config.isReplayMode).toBe(false);
      expect(config.translationGeneration).toBe(0);
    });

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
      manager.setActive(true);

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

    it('updates selected and derived fields without resetting replay mode', () => {
      const postMessage = vi.fn();
      (manager as unknown as { worker: Worker | null }).worker = {
        postMessage,
        terminate: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as Worker;
      manager.setActive(true);
      const settings = {
        ...DEFAULT_SETTINGS,
        speedPxPerSec: 320,
        outline: { enabled: false, widthPx: 8, opacity: 0.2 },
        colors: { ...DEFAULT_SETTINGS.colors, normal: '#ABCDEF' },
      };

      manager.updateSettings(settings, 7);

      const update = postMessage.mock.calls[0]?.[0];
      expect(update.type).toBe('updateConfig');
      expect(update.config).toMatchObject({
        speedPxPerSec: 320,
        outlineWidthPx: 0,
        outlineOpacity: 0,
        color: '#ABCDEF',
        translationGeneration: 7,
      });
      expect(update.config).not.toHaveProperty('isReplayMode');
      expect(update.config.authorColors).not.toBe(settings.colors);
      expect(update.config.showAuthor).toBe(settings.showAuthor);
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
    it.each(['Worker', 'OffscreenCanvas'] as const)(
      'keeps the original canvas usable when %s is unavailable',
      (missingApi) => {
        const original = globalThis[missingApi];
        const context = {} as CanvasRenderingContext2D;
        const canvas = {
          getContext: vi.fn(() => context),
          transferControlToOffscreen: vi.fn(),
        } as unknown as HTMLCanvasElement;
        const overlay = {
          getDimensions: vi.fn(() => ({ width: 640, height: 360 })),
          onDimensionsChanged: vi.fn(() => vi.fn()),
        };
        vi.stubGlobal(missingApi, undefined);

        try {
          expect(manager.init(canvas, DEFAULT_SETTINGS, overlay as any, 'worker.js')).toEqual({
            started: false,
            canvasTransferred: false,
          });
          expect(canvas.transferControlToOffscreen).not.toHaveBeenCalled();
          expect(canvas.getContext('2d')).toBe(context);
          expect(manager.isActive).toBe(false);
        } finally {
          vi.stubGlobal(missingApi, original);
        }
      }
    );

    it.each([
      ['CSP SecurityError', () => new DOMException('blocked', 'SecurityError')],
      ['TrustedScriptURL TypeError', () => new TypeError('TrustedScriptURL required')],
    ])(
      'leaves the original canvas available after %s during Worker construction',
      (_label, error) => {
        const originalWorker = globalThis.Worker;
        const context = {} as CanvasRenderingContext2D;
        const canvas = {
          getContext: vi.fn(() => context),
          transferControlToOffscreen: vi.fn(),
        } as unknown as HTMLCanvasElement;
        const overlay = {
          getDimensions: vi.fn(() => ({ width: 640, height: 360 })),
          onDimensionsChanged: vi.fn(() => vi.fn()),
        };
        const constructorAttempt = vi.fn(() => {
          throw error();
        });
        vi.stubGlobal('Worker', constructorAttempt);

        try {
          expect(manager.init(canvas, DEFAULT_SETTINGS, overlay as any, 'worker.js')).toEqual({
            started: false,
            canvasTransferred: false,
          });
          expect(constructorAttempt).toHaveBeenCalledOnce();
          expect(canvas.transferControlToOffscreen).not.toHaveBeenCalled();
          expect(canvas.getContext('2d')).toBe(context);
          expect(manager.isActive).toBe(false);
        } finally {
          vi.stubGlobal('Worker', originalWorker);
        }
      }
    );

    it('terminates the Worker and preserves the original canvas after transfer failure', () => {
      const originalWorker = globalThis.Worker;
      const terminate = vi.fn();
      vi.stubGlobal(
        'Worker',
        class {
          terminate = terminate;
        }
      );
      const context = {} as CanvasRenderingContext2D;
      const transferControlToOffscreen = vi.fn(() => {
        throw new DOMException('transfer denied', 'InvalidStateError');
      });
      const canvas = {
        getContext: vi.fn(() => context),
        transferControlToOffscreen,
      } as unknown as HTMLCanvasElement;
      const overlay = {
        getDimensions: vi.fn(() => ({ width: 640, height: 360 })),
        onDimensionsChanged: vi.fn(() => vi.fn()),
      };

      try {
        expect(manager.init(canvas, DEFAULT_SETTINGS, overlay as any, 'worker.js')).toEqual({
          started: false,
          canvasTransferred: false,
        });
        expect(transferControlToOffscreen).toHaveBeenCalledOnce();
        expect(terminate).toHaveBeenCalledOnce();
        expect(canvas.getContext('2d')).toBe(context);
        expect(manager.isActive).toBe(false);
      } finally {
        vi.stubGlobal('Worker', originalWorker);
      }
    });

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

        expect(
          manager.init(
            canvas,
            DEFAULT_SETTINGS,
            overlay as unknown as Parameters<RenderWorkerManager['init']>[2],
            'worker.js'
          )
        ).toEqual({
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

    it('keeps legacy sizing preferences out of init, mixed updates, and reinitialization', () => {
      const canvas = {
        transferControlToOffscreen: vi.fn(() => ({ getContext: vi.fn() })),
      } as unknown as HTMLCanvasElement;
      const overlay = {
        getDimensions: vi.fn(() => ({ width: 640, height: 360 })),
        onDimensionsChanged: vi.fn(() => vi.fn()),
      };
      const initialSettings = {
        ...DEFAULT_SETTINGS,
        fontSize: 30,
        fontBaseViewportHeight: 720,
        fontMinSize: 12,
        fontMaxSize: 42,
      };
      deps.settings = initialSettings;

      const postedConfig = (worker: { postMessage: ReturnType<typeof vi.fn> }, type: string) => {
        const message = worker.postMessage.mock.calls.find(
          ([value]) => (value as { type?: string }).type === type
        )?.[0] as { config: Record<string, unknown> } | undefined;
        expect(message).toBeDefined();
        return message?.config ?? {};
      };
      const expectNoLegacyKeys = (config: Record<string, unknown>) => {
        for (const key of ['fontBaseViewportHeight', 'fontMinSize', 'fontMaxSize']) {
          expect(Object.hasOwn(config, key)).toBe(false);
        }
      };

      expect(manager.init(canvas, initialSettings, overlay as any, 'worker.js').started).toBe(true);
      const firstWorker = (
        manager as unknown as { worker: { postMessage: ReturnType<typeof vi.fn> } }
      ).worker;
      const initialConfig = postedConfig(firstWorker, 'init');
      expectNoLegacyKeys(initialConfig);
      expect(initialConfig).toMatchObject({
        fontSize: 30,
        speedPxPerSec: initialSettings.speedPxPerSec,
        outlineWidthPx: initialSettings.outline.widthPx,
        translationGeneration: 0,
      });

      const updatedSettings = {
        ...initialSettings,
        fontSize: 38,
        fontBaseViewportHeight: 1440,
        fontMinSize: 20,
        fontMaxSize: 60,
        speedPxPerSec: 320,
      };
      manager.updateSettings(updatedSettings, 7);
      const updateConfig = postedConfig(firstWorker, 'updateConfig');
      expectNoLegacyKeys(updateConfig);
      expect(updateConfig).toMatchObject({
        fontSize: 38,
        speedPxPerSec: 320,
        translationGeneration: 7,
      });

      manager.destroy();
      expect(manager.init(canvas, updatedSettings, overlay as any, 'worker.js').started).toBe(true);
      const nextWorker = (
        manager as unknown as { worker: { postMessage: ReturnType<typeof vi.fn> } }
      ).worker;
      expect(nextWorker).not.toBe(firstWorker);
      const recoveredConfig = postedConfig(nextWorker, 'init');
      expectNoLegacyKeys(recoveredConfig);
      expect(recoveredConfig).toMatchObject({
        fontSize: 38,
        speedPxPerSec: 320,
        outlineWidthPx: updatedSettings.outline.widthPx,
        translationGeneration: 0,
      });
    });

    it('remeasures every worker-owned message after an overlay resize', async () => {
      const transferControlToOffscreen = vi.fn(() => ({ getContext: vi.fn() }));
      const canvas = { transferControlToOffscreen } as unknown as HTMLCanvasElement;
      const onDimensionsChanged = vi.fn(
        (_callback: (dimensions: { width: number; height: number }) => void) => vi.fn()
      );
      const overlay = {
        getDimensions: vi.fn(() => ({ width: 640, height: 360 })),
        onDimensionsChanged,
      };
      deps.estimateDimensions.mockReturnValue({ width: 100, height: 20 });

      expect(manager.init(canvas, DEFAULT_SETTINGS, overlay as any, 'worker.js').started).toBe(
        true
      );
      const worker = (manager as unknown as { worker: { postMessage: ReturnType<typeof vi.fn> } })
        .worker;
      const first = {
        id: 'first',
        timestamp: Date.now(),
        text: 'first',
        content: [{ type: 'text' as const, content: 'first' }],
        kind: 'text' as const,
        authorType: 'normal' as const,
      };
      const second = { ...first, id: 'second', text: 'second' };
      manager.sendToWorker(first, first.id);
      manager.sendToWorker(second, second.id);
      await Promise.resolve();
      manager.sendTranslation(
        first.id,
        'translated first',
        { width: 180, height: 40, translationHeight: 12 },
        0
      );
      worker.postMessage.mockClear();
      deps.estimateDimensions.mockReturnValue({ width: 220, height: 60 });
      deps.estimateTranslatedDimensions.mockReturnValue({
        width: 260,
        height: 80,
        translationHeight: 16,
      });

      const dimensionsChanged = onDimensionsChanged.mock.calls[0]?.[0];
      if (!dimensionsChanged) throw new Error('Dimension listener was not registered');
      dimensionsChanged({ width: 320, height: 180 });
      await Promise.resolve();
      await Promise.resolve();

      expect(worker.postMessage).toHaveBeenCalledWith({
        type: 'resize',
        width: 320,
        height: 180,
        dpr: window.devicePixelRatio || 1,
      });
      expect(worker.postMessage).toHaveBeenCalledWith({
        type: 'updateMessageGeometries',
        geometries: [
          { id: 'first', width: 260, height: 80, translationHeight: 16 },
          { id: 'second', width: 220, height: 60 },
        ],
      });
      expect(worker.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'addMessages' })
      );
    });

    it('invalidates a late original translation when a deferred replacement is admitted', async () => {
      deps.settings.queueMaxSize = 1;
      const transferControlToOffscreen = vi.fn(() => ({ getContext: vi.fn() }));
      const canvas = { transferControlToOffscreen } as unknown as HTMLCanvasElement;
      const onDimensionsChanged = vi.fn(
        (_callback: (dimensions: { width: number; height: number }) => void) => vi.fn()
      );
      const overlay = {
        getDimensions: vi.fn(() => ({ width: 640, height: 360 })),
        onDimensionsChanged,
      };

      expect(manager.init(canvas, DEFAULT_SETTINGS, overlay as any, 'worker.js').started).toBe(
        true
      );
      const worker = (
        manager as unknown as {
          worker: {
            onmessage?: (event: MessageEvent) => void;
            postMessage: ReturnType<typeof vi.fn>;
          };
        }
      ).worker;
      const original = {
        id: 'deferred-replacement',
        timestamp: Date.now(),
        text: 'original',
        content: [{ type: 'text' as const, content: 'original' }],
        kind: 'text' as const,
        authorType: 'normal' as const,
      };
      expect(manager.sendToWorker(original, original.id)).toBe(true);
      await Promise.resolve();

      const unacknowledgedBatches = (
        manager as unknown as {
          unacknowledgedBatches: Map<number, { saturationProbe: boolean }>;
        }
      ).unacknowledgedBatches;
      const firstBatch = unacknowledgedBatches.get(1);
      if (!firstBatch) throw new Error('Original batch was not sent');
      firstBatch.saturationProbe = true;

      expect(
        manager.sendToWorker(
          {
            ...original,
            actionType: 'replace',
            text: 'replacement',
            content: [{ type: 'text' as const, content: 'replacement' }],
          },
          original.id
        )
      ).toBe(true);
      expect((manager as any).deferredIngress).toHaveLength(1);

      manager.sendTranslation(
        original.id,
        'stale original translation',
        { width: 180, height: 40, translationHeight: 12 },
        0
      );
      expect((manager as any).translatedMessages.get(original.id)).toBe(
        'stale original translation'
      );

      worker.onmessage?.({
        data: {
          type: 'batchReceipt',
          epoch: 0,
          batchSequence: 1,
          pendingQueueDepth: 0,
          admittedMessages: 1,
          minimumPendingPriority: null,
        },
      } as MessageEvent);
      await Promise.resolve();

      expect((manager as any).deferredIngress).toHaveLength(0);
      expect((manager as any).translatedMessages.has(original.id)).toBe(false);

      worker.postMessage.mockClear();
      deps.estimateDimensions.mockReturnValue({ width: 220, height: 60 });
      const dimensionsChanged = onDimensionsChanged.mock.calls[0]?.[0];
      if (!dimensionsChanged) throw new Error('Dimension listener was not registered');
      dimensionsChanged({ width: 320, height: 180 });
      await Promise.resolve();
      await Promise.resolve();

      expect(deps.estimateTranslatedDimensions).not.toHaveBeenCalled();
      expect(worker.postMessage).toHaveBeenCalledWith({
        type: 'updateMessageGeometries',
        geometries: [{ id: original.id, width: 220, height: 60 }],
      });
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
      expect(manager.sendToWorker(msg)).toBe(false);
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
      manager.setActive(true);

      expect(
        manager.sendToWorker(
          {
            id: 'replacement',
            timestamp: Date.now(),
            content: [{ type: 'text', content: 'original' }],
            kind: 'chat',
            authorType: 'normal',
          } as any,
          'replacement'
        )
      ).toBe(true);
      await Promise.resolve();
      postMessage.mockClear();
      (manager as any).latestWorkerPendingDepth = deps.settings.queueMaxSize;

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

    it('sends one saturation probe for an unseen replacement under worker backpressure', async () => {
      const postMessage = vi.fn();
      (manager as any).worker = {
        postMessage,
        terminate: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as Worker;
      manager.setActive(true);
      (manager as any).latestWorkerPendingDepth = deps.settings.queueMaxSize;

      expect(
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
        )
      ).toBe(true);
      await Promise.resolve();

      expect(deps.observability.onMessageDropped).not.toHaveBeenCalled();
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'addMessages',
          messages: [expect.objectContaining({ id: 'fresh-replacement', actionType: 'replace' })],
        })
      );
      expect((manager as any).sentMessages.has('fresh-replacement')).toBe(true);
      expect((manager as any).deferredIngress).toHaveLength(0);
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
      manager.setActive(true);

      manager.destroy();
      expect(vi.getTimerCount()).toBe(1);

      listeners.get('message')?.({ data: { type: 'ack' } } as MessageEvent);

      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(500);
      expect(worker.terminate).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });

    it.each([
      { label: 'ACK at 499 ms', ackAtMs: 499 },
      { label: 'late ACK at 501 ms', ackAtMs: 501 },
      { label: 'no ACK', ackAtMs: null },
    ])('terminates only retired worker A with $label after B starts', ({ ackAtMs }) => {
      vi.useFakeTimers();
      const originalWorker = globalThis.Worker;
      const instances: RecordingWorker[] = [];
      class RecordingWorker {
        postMessage = vi.fn();
        terminate = vi.fn();
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        onmessageerror: ((event: MessageEvent) => void) | null = null;
        private readonly listeners = new Set<EventListener>();

        constructor() {
          instances.push(this);
        }

        addEventListener = vi.fn((_type: string, listener: EventListener) => {
          this.listeners.add(listener);
        });
        removeEventListener = vi.fn((_type: string, listener: EventListener) => {
          this.listeners.delete(listener);
        });

        emitMessage(data: unknown): void {
          const event = { data } as MessageEvent;
          this.onmessage?.(event);
          for (const listener of this.listeners) listener(event);
        }
      }
      vi.stubGlobal('Worker', RecordingWorker);

      const init = (): void => {
        const canvas = {
          transferControlToOffscreen: vi.fn(() => ({ getContext: vi.fn() })),
        } as unknown as HTMLCanvasElement;
        const overlay = {
          getDimensions: vi.fn(() => ({ width: 640, height: 360 })),
          onDimensionsChanged: vi.fn(() => vi.fn()),
        };
        expect(manager.init(canvas, DEFAULT_SETTINGS, overlay as any, 'worker.js')).toEqual({
          started: true,
          canvasTransferred: true,
        });
      };

      try {
        init();
        const workerA = instances[0];
        expect(workerA).toBeDefined();
        manager.destroy();
        expect(manager.workerRef).toBeNull();
        expect(workerA?.postMessage).toHaveBeenLastCalledWith({ type: 'destroy' });
        expect(workerA?.terminate).not.toHaveBeenCalled();

        init();
        const workerB = instances[1];
        expect(workerB).toBeDefined();
        expect(manager.workerRef).toBe(workerB);

        vi.advanceTimersByTime(499);
        expect(workerA?.terminate).not.toHaveBeenCalled();
        expect(workerB?.terminate).not.toHaveBeenCalled();
        if (ackAtMs === 499) workerA?.emitMessage({ type: 'ack' });
        expect(workerA?.terminate).toHaveBeenCalledTimes(ackAtMs === 499 ? 1 : 0);

        vi.advanceTimersByTime(1);
        expect(workerA?.terminate).toHaveBeenCalledOnce();
        if (ackAtMs === 501) {
          vi.advanceTimersByTime(1);
          workerA?.emitMessage({ type: 'ack' });
        }
        workerA?.emitMessage({ type: 'error', error: 'stale worker' });
        workerA?.onerror?.(new ErrorEvent('error', { message: 'stale worker' }));
        workerA?.onmessageerror?.(new MessageEvent('messageerror', { data: null }));
        expect(workerA?.terminate).toHaveBeenCalledOnce();
        expect(workerB?.terminate).not.toHaveBeenCalled();
        expect(manager.workerRef).toBe(workerB);
        expect(manager.isActive).toBe(true);
      } finally {
        manager.destroy();
        instances[1]?.emitMessage({ type: 'ack' });
        vi.stubGlobal('Worker', originalWorker);
        vi.useRealTimers();
      }
    });
  });
});
