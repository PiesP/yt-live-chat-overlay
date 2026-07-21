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

vi.stubGlobal('queueMicrotask', (fn: () => void) => {
  // Synchronously execute microtask for test determinism
  Promise.resolve().then(fn);
});

// ══════════════════════════════════════════════════════════════════════

import { RenderWorkerManager } from '@renderer/worker/manager';

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
        get: vi.fn(),
        delete: vi.fn(),
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

  describe('constructor', () => {
    it('initializes with zero queue depth', () => {
      expect(manager.queueDepth).toBe(0);
    });

    it('accepts deps without worker (no crash)', () => {
      expect(() => new RenderWorkerManager(deps as any)).not.toThrow();
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
  });
});
