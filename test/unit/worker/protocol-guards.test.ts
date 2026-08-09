// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage, OverlaySettings } from '@app-types';
import type { ImageFetchManager } from '@media/image-fetch-manager';
import { isValidControlMessage } from '@renderer/worker/protocol-guards';
import { RenderWorkerManager } from '@renderer/worker/manager';
import { WorkerRenderer } from '@renderer/worker/renderer';
import { DEFAULT_SETTINGS } from '@settings/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockContext = {
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
  font: '',
  textBaseline: 'top',
  textAlign: 'left',
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  globalAlpha: 1,
  filter: 'none',
  imageSmoothingEnabled: true,
};

class MockOffscreenCanvas {
  width = 640;
  height = 360;

  getContext(): typeof mockContext {
    return mockContext;
  }
}

function makeMessage(id = 'backlog-message'): ChatMessage {
  return {
    id,
    text: 'hello',
    content: [{ type: 'text', content: 'hello' }],
    kind: 'text',
    timestamp: 1,
    authorType: 'normal',
    isBacklog: true,
  };
}

function createManager(renderer: WorkerRenderer): RenderWorkerManager {
  const manager = new RenderWorkerManager({
    settings: { ...DEFAULT_SETTINGS } as OverlaySettings,
    observability: { onMessageDropped: vi.fn() } as never,
    imageFetchManager: {
      workerBitmapCache: {
        get: vi.fn(),
        delete: vi.fn(),
      },
    } as unknown as ImageFetchManager,
    estimateDimensions: () => ({ width: 100, height: 20 }),
    getMessagePriority: () => -1,
    getEffectiveSpeedPxPerSec: () => 100,
  });
  const worker = {
    postMessage: vi.fn((data: unknown) => {
      expect(isValidControlMessage(data)).toBe(true);
      renderer.handleMessage({ data } as MessageEvent);
    }),
  } as unknown as Worker;
  (manager as unknown as { worker: Worker }).worker = worker;
  return manager;
}

function initializeRenderer(): WorkerRenderer {
  const renderer = new WorkerRenderer();
  renderer.handleMessage({
    data: {
      type: 'init',
      config: { ...DEFAULT_SETTINGS },
      canvas: new MockOffscreenCanvas(),
      dpr: 1,
      width: 640,
      height: 360,
    },
  } as unknown as MessageEvent);
  return renderer;
}

beforeEach(() => {
  vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);
  vi.stubGlobal('ImageBitmap', class {
    close(): void {}
  });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  Object.defineProperty(self, 'postMessage', {
    value: vi.fn(),
    writable: true,
    configurable: true,
  });
});

describe('renderer worker protocol guards', () => {
  it('rejects non-record, missing, non-string, and unknown message types', () => {
    for (const value of [null, undefined, [], 'init', {}, { type: 1 }, { type: 'unknown' }]) {
      expect(isValidControlMessage(value)).toBe(false);
    }
  });

  it('accepts a valid init message with a canvas-like transferable', () => {
    expect(
      isValidControlMessage({
        type: 'init',
        config: { ...DEFAULT_SETTINGS },
        canvas: new MockOffscreenCanvas(),
        width: 640,
        height: 360,
        dpr: 2,
      })
    ).toBe(true);
  });

  it('rejects unsafe init cache budgets', () => {
    const base = {
      type: 'init',
      canvas: new MockOffscreenCanvas(),
      width: 640,
      height: 360,
      dpr: 1,
    };

    expect(
      isValidControlMessage({
        ...base,
        config: { ...DEFAULT_SETTINGS, emojiCacheMb: Number.NaN },
      })
    ).toBe(false);
    expect(
      isValidControlMessage({
        ...base,
        config: { ...DEFAULT_SETTINGS, textCacheMb: 21 },
      })
    ).toBe(false);
  });

  it('rejects malformed init dimensions and non-canvas payloads', () => {
    const base = {
      type: 'init',
      config: { ...DEFAULT_SETTINGS },
      canvas: new MockOffscreenCanvas(),
      width: 640,
      height: 360,
      dpr: 1,
    };

    for (const invalid of [
      { width: 0 },
      { width: Number.NaN },
      { height: Number.POSITIVE_INFINITY },
      { dpr: 0 },
      { dpr: -1 },
      { dpr: Number.NaN },
      { dpr: Number.POSITIVE_INFINITY },
      { dpr: '2' },
      { canvas: {} },
      { canvas: null },
    ]) {
      expect(isValidControlMessage({ ...base, ...invalid })).toBe(false);
    }
  });

  it('requires a finite positive numeric DPR for resize messages', () => {
    const base = { type: 'resize', width: 640, height: 360, dpr: 2 };

    expect(isValidControlMessage(base)).toBe(true);
    for (const dpr of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '2']) {
      expect(isValidControlMessage({ ...base, dpr })).toBe(false);
    }
    expect(isValidControlMessage({ ...base, width: 0 })).toBe(false);
    expect(isValidControlMessage({ ...base, height: 0 })).toBe(false);
  });

  it('accepts manager messages through the guard and renderer', async () => {
    const renderer = initializeRenderer();
    const manager = createManager(renderer);

    manager.sendToWorker(makeMessage('backlog-message'), 'backlog-message');
    manager.sendToWorker(makeMessage('second-message'), 'second-message');
    await Promise.resolve();

    const internals = renderer as unknown as {
      pendingQueue: Array<{ id: string; priority: number }>;
      messageById: Map<string, { translatedText?: string }>;
      isUserPaused: boolean;
    };
    expect(internals.pendingQueue).toMatchObject([
      { id: 'backlog-message', priority: -1 },
      { id: 'second-message', priority: -1 },
    ]);

    manager.sendTranslation('backlog-message', 'translated', {
      width: 180,
      height: 52,
      translationHeight: 18,
    });
    expect(internals.messageById.get('backlog-message')?.translatedText).toBe('translated');
    expect(internals.messageById.get('backlog-message')).toMatchObject({
      width: 180,
      height: 52,
      translationHeight: 18,
    });

    manager.clearTranslations(() => ({ width: 96, height: 24, translationHeight: 0 }));
    expect(internals.messageById.get('backlog-message')).toMatchObject({
      translatedText: null,
      width: 96,
      height: 24,
      translationHeight: 0,
    });

    manager.setUserPaused(true);
    expect(internals.isUserPaused).toBe(true);
  });

  it('accepts signed finite priority but rejects non-finite priority', () => {
    const message = {
      id: 'negative-priority',
      text: 'backlog',
      width: 100,
      height: 20,
      priority: -10,
    };

    expect(isValidControlMessage({ type: 'addMessages', messages: [message] })).toBe(true);
    expect(
      isValidControlMessage({
        type: 'addMessages',
        messages: [{ ...message, priority: Number.NEGATIVE_INFINITY }],
      })
    ).toBe(false);
  });

  it('validates updateTranslation fields', () => {
    expect(
      isValidControlMessage({
        type: 'updateTranslation',
        id: 'message',
        translatedText: 'text',
        width: 180,
        height: 52,
        translationHeight: 18,
      })
    ).toBe(true);
    expect(
      isValidControlMessage({
        type: 'updateTranslation',
        id: 'message',
        translatedText: null,
        width: 100,
        height: 20,
        translationHeight: 0,
      })
    ).toBe(true);
    expect(
      isValidControlMessage({ type: 'updateTranslation', id: '', translatedText: 'text' })
    ).toBe(false);
    expect(
      isValidControlMessage({ type: 'updateTranslation', id: 'message', translatedText: 1 })
    ).toBe(false);
    for (const id of [1, '']) {
      expect(
        isValidControlMessage({
          type: 'updateTranslation',
          id,
          translatedText: 'text',
          width: 180,
          height: 52,
          translationHeight: 18,
        })
      ).toBe(false);
    }
    for (const geometry of [
      { width: 0, height: 52, translationHeight: 18 },
      { width: 180, height: Number.NaN, translationHeight: 18 },
      { width: 180, height: 52, translationHeight: -1 },
    ]) {
      expect(
        isValidControlMessage({
          type: 'updateTranslation',
          id: 'message',
          translatedText: 'text',
          ...geometry,
        })
      ).toBe(false);
    }
  });

  it('validates setUserPaused fields', () => {
    expect(isValidControlMessage({ type: 'setUserPaused', paused: true })).toBe(true);
    expect(isValidControlMessage({ type: 'setUserPaused', paused: false })).toBe(true);
    expect(isValidControlMessage({ type: 'setUserPaused', paused: 'false' })).toBe(false);
    expect(isValidControlMessage({ type: 'setUserPaused' })).toBe(false);
  });

  it('accepts only explicit booleans for renderer pause messages', () => {
    expect(isValidControlMessage({ type: 'setPaused', paused: true })).toBe(true);
    expect(isValidControlMessage({ type: 'setPaused', paused: false })).toBe(true);
    for (const paused of [undefined, null, 0, 1, 'false']) {
      expect(isValidControlMessage({ type: 'setPaused', paused })).toBe(false);
    }
  });

  it('accepts stateless control messages', () => {
    for (const type of ['clearState', 'destroy', 'ping']) {
      expect(isValidControlMessage({ type })).toBe(true);
    }
  });

  it('rejects prototype-like keys in config updates', () => {
    const prototypePayload = JSON.parse('{"__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;

    expect(isValidControlMessage({ type: 'updateConfig', config: prototypePayload })).toBe(false);
    expect(
      isValidControlMessage({
        type: 'updateConfig',
        config: { constructor: { prototype: { polluted: true } } },
      })
    ).toBe(false);
    expect(isValidControlMessage({ type: 'updateConfig', config: { prototype: {} } })).toBe(false);
  });

  it('rejects non-finite and out-of-policy resource settings', () => {
    expect(isValidControlMessage({ type: 'updateConfig', config: { opacity: 0.75 } })).toBe(true);
    expect(
      isValidControlMessage({
        type: 'updateConfig',
        config: { emojiCacheMb: Number.POSITIVE_INFINITY },
      })
    ).toBe(false);
    expect(isValidControlMessage({ type: 'updateConfig', config: { textCacheMb: 21 } })).toBe(
      false
    );
    expect(isValidControlMessage({ type: 'updateConfig', config: { queueMaxSize: 1001 } })).toBe(
      false
    );
    expect(isValidControlMessage({ type: 'updateConfig', config: null })).toBe(false);
    expect(isValidControlMessage({ type: 'updateConfig', config: { emojiCacheMb: '8' } })).toBe(
      false
    );
    expect(isValidControlMessage({ type: 'updateConfig', config: { opacity: -0.1 } })).toBe(false);
  });

  it('accepts only finite supported lane-density factors', () => {
    for (const factor of [0.5, 0.75, 1]) {
      expect(isValidControlMessage({ type: 'laneDensity', factor })).toBe(true);
    }
    for (const factor of [Number.NaN, Number.POSITIVE_INFINITY, 0, 0.49, 1.01, '0.5']) {
      expect(isValidControlMessage({ type: 'laneDensity', factor })).toBe(false);
    }
  });

  it('requires snapshot request IDs to be non-negative safe integers', () => {
    expect(isValidControlMessage({ type: 'snapshotMessages', requestId: 0 })).toBe(true);
    expect(isValidControlMessage({ type: 'snapshotMessages', requestId: 42 })).toBe(true);
    for (const requestId of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isValidControlMessage({ type: 'snapshotMessages', requestId })).toBe(false);
    }
  });

  it('bounds addMessages batches before the renderer iterates them', () => {
    const message = {
      id: 'bounded-message',
      text: 'hello',
      width: 100,
      height: 20,
      priority: 0,
    };

    expect(
      isValidControlMessage({ type: 'addMessages', messages: Array(1000).fill(message) })
    ).toBe(true);
    expect(
      isValidControlMessage({ type: 'addMessages', messages: Array(1001).fill(message) })
    ).toBe(false);
  });

  it('rejects malformed addMessages containers and required fields', () => {
    const message = {
      id: 'message',
      text: 'hello',
      width: 100,
      height: 20,
      priority: 0,
    };

    for (const messages of [undefined, null, {}, 'message']) {
      expect(isValidControlMessage({ type: 'addMessages', messages })).toBe(false);
    }
    for (const invalidMessage of [
      null,
      { ...message, id: '' },
      { ...message, id: 1 },
      { ...message, text: 1 },
      { ...message, width: -1 },
      { ...message, width: Number.NaN },
      { ...message, height: -1 },
      { ...message, height: Number.POSITIVE_INFINITY },
      { ...message, priority: Number.NaN },
    ]) {
      expect(isValidControlMessage({ type: 'addMessages', messages: [invalidMessage] })).toBe(
        false
      );
    }
  });
});
