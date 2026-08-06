// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkerRenderer } from '@renderer/worker/renderer';

// Mock OffscreenCanvas
class MockOffscreenCanvas {
  width = 0;
  height = 0;
  getContext(_type: string): OffscreenCanvasRenderingContext2D | null { return null; }
  transferToImageBitmap() { return {}; }
  convertToBlob() { return Promise.resolve(new Blob()); }
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
    expect(internals.textMeasureCache.get('hello')).toBe(42);
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
        colors: { normal: '#FFFFFF', member: '#0F9D58', moderator: '#5E84F1', owner: '#FFD600', verified: '#AAAAAA' },
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
        showAuthor: { normal: false, member: true, moderator: true, owner: true, verified: true, superChat: true },
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
        { id: '1', authorName: 'Test', text: 'hello', color: '#fff', fontSize: 32, fontWeight: 'bold', fontFamily: 'Arial', opacity: 1, speedPxPerSec: 250, x: 0, y: 0 },
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
        fontSize: 32, speedPxPerSec: 250, opacity: 1, superChatOpacity: 0.95,
        outline: { enabled: true, widthPx: 2, opacity: 0.7 },
        colors: { normal: '#FFFFFF', member: '#0F9D58', moderator: '#5E84F1', owner: '#FFD600', verified: '#AAAAAA' },
        fontFamily: 'Arial', fontWeight: 'bold', laneCount: 30,
        topBottomDurationMs: 5000, scrollDurationMinMs: 3000, scrollDurationMaxMs: 15000,
        headwayGapRatio: 0.3, backlogOpacityMultiplier: 0.5, depthLayersEnabled: false,
        depthNearSpeedMul: 1.2, depthFarSpeedMul: 0.8, depthFarOpacityMul: 0.6,
        showSuperChatAmount: true,
        showAuthor: { normal: false, member: true, moderator: true, owner: true, verified: true, superChat: true },
        superChatMaxBodyLines: 3, membershipMaxBodyLines: 2, fadeDurationMs: 300,
        maxMessageAgeMs: 30000, modOwnerDurationMultiplier: 1.5, preserveUserColor: true,
        translationEnabled: false, translationMode: 'dual', translationFontScale: 0.7,
        backgroundColor: '#000000', maxConcurrentMessages: 300,
        danmakuMode: 'scroll', exitPaddingPx: 50, laneSpacing: 1,
      },
    });
    expect(() => wr.handleMessage(event)).not.toThrow();
  });
});
