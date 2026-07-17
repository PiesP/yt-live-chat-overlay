import { describe, it, expect, vi, afterEach } from 'vitest';
import { RenderWorkerManager } from '@renderer/worker/manager';
import type { ImageFetchManager } from '@renderer/image-fetch-manager';
import type { OverlaySettings } from '@app-types';
import { DEFAULT_SETTINGS } from '@settings/schema';

// ── Mock Worker ──────────────────────────────────────────────────────

function createMockWorker(): Worker {
  const listeners: Map<string, Set<EventListener>> = new Map();
  return {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    }),
    // Expose for test use
    _fireMessageError: () => {
      listeners.get('messageerror')?.forEach((l) => l(new MessageEvent('messageerror')));
    },
    dispatchEvent: vi.fn(),
    onerror: null,
    onmessage: null,
    onmessageerror: null,
  } as unknown as Worker;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('RenderWorkerManager isAlive after destroy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const settings = { ...DEFAULT_SETTINGS } as OverlaySettings;

  function createManager(): RenderWorkerManager {
    return new RenderWorkerManager({
      settings: Object.freeze(settings),
      estimateDimensions: () => ({ width: 100, height: 20 }),
      getMessagePriority: () => 50,
      getEffectiveSpeedPxPerSec: () => 100,
      imageFetchManager: {} as ImageFetchManager,
      observability: {
        onMessageDropped: vi.fn(),
        recordDrainQueue: vi.fn(),
      } as never,
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
});
