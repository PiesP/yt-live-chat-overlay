import type { OverlaySettings } from '@app-types';
import { RenderWorkerManager } from '@renderer/worker/manager';
import { DEFAULT_SETTINGS } from '@settings/schema';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

// ── Mock Worker ──────────────────────────────────────────────────────

type MockWorker = Worker & {
  _fireMessageError: () => void;
};

function createMockWorker(): MockWorker {
  const listeners: Map<string, Set<EventListener>> = new Map();
  const worker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    }),
    dispatchEvent: vi.fn(),
    onerror: null,
    onmessage: null,
    onmessageerror: null,
  } as unknown as MockWorker;

  // RenderWorkerManager installs a property handler rather than an event listener.
  worker._fireMessageError = () => {
    worker.onmessageerror?.(new MessageEvent('messageerror'));
  };

  return worker;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('RenderWorkerManager isAlive after destroy', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, '__ytExtensionBridge');
  });

  const settings = { ...DEFAULT_SETTINGS } as OverlaySettings;

  function createManager(): RenderWorkerManager {
    return new RenderWorkerManager({
      settings: Object.freeze(settings),
      estimateDimensions: () => ({ width: 100, height: 20 }),
      getMessagePriority: () => 50,
      getEffectiveSpeedPxPerSec: () => 100,
      observability: {
        onMessageDropped: vi.fn(),
        onMessagesDropped: vi.fn(),
        onMessagesRendered: vi.fn(),
        updateActiveMessages: vi.fn(),
        updateQueueDepth: vi.fn(),
        updateLaneUtilization: vi.fn(),
        tick: vi.fn(),
        recordDrainQueue: vi.fn(),
      } as never,
    });
  }

  function stubWorkerEnvironment(worker: MockWorker): void {
    vi.stubGlobal(
      'Worker',
      vi.fn(function MockWorkerConstructor() {
        return worker;
      })
    );
    vi.stubGlobal('OffscreenCanvas', class {});
    Object.defineProperty(window, '__ytExtensionBridge', {
      configurable: true,
      value: {
        workerSupported: true,
        workerUrl: 'worker.js',
        storageType: 'chrome.storage.local',
        nonce: 'test-bridge-nonce',
      },
    });
  }

  it('isAlive returns false when active is true but worker is null (destroyed)', () => {
    const manager = createManager();

    // Simulate: worker was initialized (active=true), then destroyed
    // via messageerror path. After destroy(), worker=null but active=true.
    // isAlive() should detect this and return false.
    manager.setActive(true);

    // With active=true and no worker, the old code returned true.
    // The fix: isAlive() returns false when active && !worker.
    expect(manager.isAlive()).toBe(false);
  });

  it('isAlive returns true when active is false (never initialized)', () => {
    const manager = createManager();

    // Worker never initialized — not applicable, main thread is fine
    expect(manager.isAlive()).toBe(true);
  });

  it.each([
    [9_999, true],
    [10_000, false],
    [10_001, false],
  ])('uses the first-pong deadline at %i ms even while paused', (elapsed, expected) => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(100);
    const worker = createMockWorker();
    stubWorkerEnvironment(worker);
    const manager = createManager();
    const canvas = {
      transferControlToOffscreen: vi.fn(() => ({})),
    } as unknown as HTMLCanvasElement;
    const overlay = {
      getDimensions: vi.fn(() => ({ width: 640, height: 360 })),
      onDimensionsChanged: vi.fn(() => vi.fn()),
    };

    try {
      expect(manager.init(canvas, settings, overlay as never, 'worker.js').started).toBe(true);
      manager.setPaused(true);
      manager.setUserPaused(true);
      vi.advanceTimersByTime(elapsed);

      expect(manager.isAlive()).toBe(expected);
      expect(worker.postMessage).toHaveBeenCalledWith({ type: 'ping' });
    } finally {
      manager.destroy();
    }
  });

  it.each([
    [4_999, true],
    [5_000, false],
    [5_001, false],
  ])('uses the last-pong deadline at %i ms with no chat ingress', (elapsed, expected) => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(100);
    const worker = createMockWorker();
    stubWorkerEnvironment(worker);
    const manager = createManager();
    const canvas = {
      transferControlToOffscreen: vi.fn(() => ({})),
    } as unknown as HTMLCanvasElement;
    const overlay = {
      getDimensions: vi.fn(() => ({ width: 640, height: 360 })),
      onDimensionsChanged: vi.fn(() => vi.fn()),
    };

    try {
      expect(manager.init(canvas, settings, overlay as never, 'worker.js').started).toBe(true);
      vi.advanceTimersByTime(1_000);
      worker.onmessage?.({ data: { type: 'pong' } } as MessageEvent);
      expect(manager.isAlive()).toBe(true);
      vi.advanceTimersByTime(elapsed);

      expect(manager.isAlive()).toBe(expected);
      expect(worker.postMessage).toHaveBeenCalledWith({ type: 'ping' });
    } finally {
      manager.destroy();
    }
  });

  it('notifies the fatal callback once after the third consecutive messageerror', () => {
    const worker = createMockWorker();
    stubWorkerEnvironment(worker);

    const manager = createManager();
    const canvas = {
      transferControlToOffscreen: vi.fn(() => ({})),
    } as unknown as HTMLCanvasElement;
    const overlay = {
      getDimensions: vi.fn(() => ({ width: 640, height: 360 })),
      onDimensionsChanged: vi.fn(() => vi.fn()),
    };
    expect(manager.init(canvas, settings, overlay as never, 'worker.js')).toEqual({
      started: true,
      canvasTransferred: true,
    });

    const destroySpy = vi.spyOn(manager, 'destroy');
    const fatalCallback = vi.fn((_reason: string) => manager.destroy());
    manager.setFatalErrorCallback(fatalCallback);

    worker._fireMessageError();
    worker._fireMessageError();
    expect(fatalCallback).not.toHaveBeenCalled();

    worker._fireMessageError();
    worker._fireMessageError();

    expect(fatalCallback).toHaveBeenCalledTimes(1);
    expect(fatalCallback).toHaveBeenCalledWith('worker-messageerror');
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('destroys the worker once after the third messageerror without a callback', () => {
    const worker = createMockWorker();
    stubWorkerEnvironment(worker);

    const manager = createManager();
    const canvas = {
      transferControlToOffscreen: vi.fn(() => ({})),
    } as unknown as HTMLCanvasElement;
    const overlay = {
      getDimensions: vi.fn(() => ({ width: 640, height: 360 })),
      onDimensionsChanged: vi.fn(() => vi.fn()),
    };
    expect(manager.init(canvas, settings, overlay as never, 'worker.js')).toEqual({
      started: true,
      canvasTransferred: true,
    });

    const destroySpy = vi.spyOn(manager, 'destroy');
    worker._fireMessageError();
    worker._fireMessageError();
    worker._fireMessageError();
    worker._fireMessageError();

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(manager.isActive).toBe(false);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'destroy' });
  });
});
