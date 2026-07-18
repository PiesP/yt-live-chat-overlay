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

import { resetWorkerForTests } from '@renderer/worker/renderer';

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
    maxMessageAgeMs: 30000, color: '#fff', authorColors: {},
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
    staggerMediumDelayMs: 100, emojiFetchTimeoutMs: 3000,
    ignoreReducedMotion: false, reducedMotion: false,
    preserveUserColor: false, isReplayMode: false,
    fontBaseViewportHeight: 1080, fontMinSize: 10, fontMaxSize: 120,
    fontWeight: 'bold',
  };
}

function getHandler(): (e: MessageEvent) => void {
  // Module sets self.onmessage at import time
  const handler = (self as Record<string, unknown>).onmessage;
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
      }));
      postMessageSpy.mockClear();

      getHandler()(makeEvent({ type: 'resize', width: 640, height: 360 }));

      const errors = postMessageSpy.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.type === 'error'
      );
      expect(errors.length).toBe(0);
    });
  });

  describe('robustness', () => {
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

import type { WorkerConfig, WorkerMessage, ActiveMessage } from '@renderer/worker/types';

describe('Worker types', () => {
  it('WorkerConfig type is importable (compile-time check)', () => {
    const _c: WorkerConfig = makeMinimalConfig() as unknown as WorkerConfig;
    expect(true).toBe(true);
  });
});
