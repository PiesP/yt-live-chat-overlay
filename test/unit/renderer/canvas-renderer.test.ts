// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { CanvasRenderer } from '@renderer/canvas-renderer';
import { Overlay } from '@app/overlay';
import type { OverlaySettings } from '@app-types';

// Mock OffscreenCanvas
vi.stubGlobal('OffscreenCanvas', class {
  width = 0;
  height = 0;
  getContext(_t: string) { return null; }
  transferToImageBitmap() { return {}; }
  convertToBlob() { return Promise.resolve(new Blob()); }
});

function makeSettings(overrides: Partial<OverlaySettings> = {}): OverlaySettings {
  return {
    enabled: true, danmakuMode: 'scroll' as const, speedPxPerSec: 250,
    fontSize: 32, opacity: 1, superChatOpacity: 0.95, safeTop: 0, safeBottom: 0,
    maxConcurrentMessages: 300, allowShortTextMessages: false, minTextLength: 1,
    logLevel: 'warn' as const,
    showAuthor: { normal: false, member: true, moderator: true, owner: true, verified: true, superChat: true },
    colors: { normal: '#FFFFFF', member: '#0F9D58', moderator: '#5E84F1', owner: '#FFD600', verified: '#AAAAAA' },
    outline: { enabled: true, widthPx: 2, opacity: 0.7 },
    laneSpacing: 1, showDebugOverlay: false, ignoreReducedMotion: false,
    authorRateLimit: 'normal' as const, backlogMaxRate: 10, backlogSpeedMultiplier: 1,
    backlogMode: 'playback' as const, backlogRecentMinutes: 5, backlogOpacityMultiplier: 0.5,
    depthLayersEnabled: false, depthNearSpeedMul: 1.2, depthFarSpeedMul: 0.8, depthFarOpacityMul: 0.6,
    modOwnerDurationMultiplier: 1.5, showSuperChatAmount: true,
    fontWeight: 'bold' as const, fontFamily: "'YouTube Sans', 'Roboto', 'Arial', sans-serif",
    preserveUserColor: true, superChatMaxBodyLines: 3, membershipMaxBodyLines: 2,
    fadeDurationMs: 300, minPollIntervalMs: 1000, maxPollIntervalMs: 10000,
    language: 'en' as const, translationEnabled: false, translationService: 'auto' as const,
    translationSource: 'auto' as const, translationTarget: 'en' as const,
    translationMode: 'dual' as const, exitPaddingPx: 50,
    scrollDurationMinMs: 3000, scrollDurationMaxMs: 15000, topBottomDurationMs: 5000,
    queueMaxSize: 500, backgroundQueueMax: 200, maxMessageAgeMs: 30000, headwayGapRatio: 0.3,
    emojiCacheMb: 20, photoCacheMb: 10, stickerCacheMb: 5, textCacheMb: 5,
    translationBatchSize: 5, emojiFetchLimit: 20, failedEmojiRetryMins: 5,
    burstSampleWindow: 60, burstElevatedThreshold: 5, burstHighThreshold: 15, burstExtremeThreshold: 30,
    backlogInjectionMax: 50, backlogDensityRampMs: 5000, livePollFallbackMs: 2000, livePollFailureLimit: 5,
    speedBoostThreshold: 2, backlogPauseThreshold: 0.3, backlogResumeThreshold: 0.1,
    activityTimeoutMs: 60000, staggerMaxDelayMs: 100, staggerMediumDelayMs: 50,
    emojiFetchTimeoutMs: 5000, backlogDensityRampMaxMs: 10000, backlogInjectionRateMin: 1,
    speedBoostMax: 1, speedBoostDenom: 2, backlogToggleCooldownMs: 2000,
    replayPrefetchPages: 50, replayBatchLimit: 50,
    ...overrides,
  } as OverlaySettings;
}

describe('CanvasRenderer', () => {
  let overlay: Overlay;

  beforeEach(() => {
    document.body.innerHTML = '';
    overlay = new Overlay();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('constructs without throwing', () => {
    const settings = makeSettings();
    expect(() => new CanvasRenderer(overlay, settings)).not.toThrow();
  });

  it('destroys without error', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    expect(() => renderer.destroy()).not.toThrow();
  });

  it('addMessage is a function', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    expect(typeof renderer.addMessage).toBe('function');
    renderer.destroy();
  });

  it('pause and resume work', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    expect(() => renderer.pause()).not.toThrow();
    expect(() => renderer.resume()).not.toThrow();
    renderer.destroy();
  });

  it('isPaused is false after construction', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    expect(renderer.isPaused).toBe(false);
    renderer.destroy();
  });

  it('updateSettings works', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    expect(() => renderer.updateSettings(makeSettings({ fontSize: 64 }))).not.toThrow();
    renderer.destroy();
  });

  it('setConnectionStatus accepts all status values', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    expect(() => renderer.setConnectionStatus('connected')).not.toThrow();
    expect(() => renderer.setConnectionStatus('disconnected')).not.toThrow();
    expect(() => renderer.setConnectionStatus('degraded')).not.toThrow();
    expect(() => renderer.setConnectionStatus('standby')).not.toThrow();
    expect(() => renderer.setConnectionStatus('connecting')).not.toThrow();
    renderer.destroy();
  });

  it('setReplayMode works', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    expect(() => renderer.setReplayMode(true)).not.toThrow();
    expect(() => renderer.setReplayMode(false)).not.toThrow();
    renderer.destroy();
  });

  it('getLaneUtilization returns a number between 0 and 1', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    const util = renderer.getLaneUtilization();
    expect(typeof util).toBe('number');
    expect(util).toBeGreaterThanOrEqual(0);
    expect(util).toBeLessThanOrEqual(1);
    renderer.destroy();
  });

  it('isWorkerAlive returns boolean', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    const alive = renderer.isWorkerAlive();
    expect(typeof alive).toBe('boolean');
    renderer.destroy();
  });

  it('getActiveMessageCount returns number', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    expect(typeof renderer.getActiveMessageCount()).toBe('number');
    renderer.destroy();
  });

  it('getQueueLength returns number', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    expect(typeof renderer.getQueueLength()).toBe('number');
    renderer.destroy();
  });

  it('getMsSinceLastRenderActivity returns number', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    expect(typeof renderer.getMsSinceLastRenderActivity()).toBe('number');
    renderer.destroy();
  });

  it('prepareForRefresh works', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    expect(() => renderer.prepareForRefresh()).not.toThrow();
    renderer.destroy();
  });

  it('resumeRenderLoop works', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    expect(() => renderer.resumeRenderLoop()).not.toThrow();
    renderer.destroy();
  });

  it('fallbackToMainThread works', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    expect(() => renderer.fallbackToMainThread('test-reason')).not.toThrow();
    renderer.destroy();
  });

  it('setStandbyStatus works', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    expect(() => renderer.setStandbyStatus(true)).not.toThrow();
    expect(() => renderer.setStandbyStatus(false)).not.toThrow();
    renderer.destroy();
  });

  it('setChatPanelOpen works', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    expect(() => renderer.setChatPanelOpen(true)).not.toThrow();
    expect(() => renderer.setChatPanelOpen(false)).not.toThrow();
    renderer.destroy();
  });

  it('destroy then further calls are safe no-ops', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    renderer.destroy();
    // After destroy, pause/resume should be safe no-ops
    expect(() => renderer.pause()).not.toThrow();
    expect(() => renderer.resume()).not.toThrow();
    // addMessage may fail after destroy because it accesses internal state
    // through message.content iteration — but it should not throw unrecoverably
  });

  it('onStatusBarClick callback is settable', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    expect(renderer.onStatusBarClick).toBeNull();
    const cb = vi.fn();
    renderer.onStatusBarClick = cb;
    expect(renderer.onStatusBarClick).toBe(cb);
    renderer.destroy();
  });

  it('onBacklogPauseChange callback is settable', () => {
    const settings = makeSettings();
    const renderer = new CanvasRenderer(overlay, settings);
    expect(renderer.onBacklogPauseChange).toBeNull();
    const cb = vi.fn();
    renderer.onBacklogPauseChange = cb;
    expect(renderer.onBacklogPauseChange).toBe(cb);
    renderer.destroy();
  });
});
