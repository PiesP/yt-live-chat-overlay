// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { CanvasRenderer } from '@renderer/canvas-renderer';
import type { CanvasMessage } from '@renderer/constants';
import { Overlay } from '@app/overlay';
import type { ChatMessage, OverlaySettings } from '@app-types';
import { LanguageDetectorService } from '@translation/language-detector';

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

function makeMessage(id: string, text: string): ChatMessage {
  return {
    id,
    text,
    content: [{ type: 'text', content: text }],
    kind: 'text',
    timestamp: Date.now(),
    authorType: 'normal',
  };
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

  it('applies text-cache and translation-batch limits without a reload', () => {
    const renderer = new CanvasRenderer(overlay, makeSettings());
    const internals = renderer as unknown as {
      translationBatchSize: number;
      textBitmapCache: { maxBytes: number };
    };

    renderer.updateSettings(makeSettings({ textCacheMb: 3, translationBatchSize: 11 }));

    expect(internals.translationBatchSize).toBe(11);
    expect(internals.textBitmapCache.maxBytes).toBe(3_000_000);
    renderer.destroy();
  });

  it('collects auto source-language samples on the Worker path', () => {
    const settings = makeSettings({ translationEnabled: true, translationSource: 'auto' });
    const renderer = new CanvasRenderer(overlay, settings);
    const internals = renderer as unknown as {
      workerManager: { setActive(active: boolean): void };
      sourceSampleBuffer: string[];
    };
    internals.workerManager.setActive(true);

    renderer.addMessage(makeMessage('worker-language-sample', 'hello from worker rendering'));

    expect(internals.sourceSampleBuffer).toEqual(['hello from worker rendering']);
    renderer.destroy();
  });

  it('lazily initializes source detection when translation is enabled later', () => {
    const settings = makeSettings({ translationEnabled: false, translationSource: 'auto' });
    const renderer = new CanvasRenderer(overlay, settings);
    const internals = renderer as unknown as {
      languageDetector: unknown;
      channelMemory: unknown;
    };
    expect(internals.languageDetector).toBeNull();
    expect(internals.channelMemory).toBeNull();

    renderer.updateSettings(makeSettings({ translationEnabled: true, translationSource: 'auto' }));

    expect(internals.languageDetector).not.toBeNull();
    expect(internals.channelMemory).not.toBeNull();
    renderer.destroy();
  });

  it('rejects an in-flight translation result after translation is disabled', () => {
    const renderer = new CanvasRenderer(
      overlay,
      makeSettings({ translationEnabled: true, translationMode: 'replace' })
    );
    const message = {
      translatedText: 'queued translation',
      translatedRenderMessage: makeMessage('translation-result', 'queued translation'),
    } as CanvasMessage;
    const internals = renderer as unknown as {
      activeMessages: CanvasMessage[];
      pendingTranslations: Array<{ msg: CanvasMessage; text: string | null }>;
      translationConfigurationGeneration: number;
      queueTranslationResult(
        msg: CanvasMessage,
        text: string | null,
        generation: number
      ): void;
      applyPendingTranslations(): void;
    };
    internals.activeMessages.push(message);
    internals.pendingTranslations.push({ msg: message, text: 'queued translation' });
    const generation = internals.translationConfigurationGeneration;

    renderer.updateSettings(
      makeSettings({ translationEnabled: false, translationMode: 'replace' })
    );
    internals.queueTranslationResult(message, 'late translation', generation);
    internals.applyPendingTranslations();

    expect(internals.pendingTranslations).toEqual([]);
    expect(message.translatedText).toBeNull();
    expect(message.translatedRenderMessage).toBeUndefined();
    renderer.destroy();
  });

  it('keeps bounded fallback detection after detector initialization rejects', async () => {
    vi.spyOn(LanguageDetectorService.prototype, 'initialize').mockRejectedValueOnce(
      new Error('detector initialization failed')
    );
    const detectFromSamples = vi
      .spyOn(LanguageDetectorService.prototype, 'detectFromSamples')
      .mockResolvedValue('en');
    const renderer = new CanvasRenderer(
      overlay,
      makeSettings({ translationEnabled: true, translationSource: 'auto' })
    );
    const internals = renderer as unknown as {
      languageDetector: LanguageDetectorService | null;
      sourceSampleBuffer: string[];
      sourceDetectionDone: boolean;
      collectSourceLanguageSample(message: ChatMessage): void;
    };

    await Promise.resolve();
    expect(internals.languageDetector).not.toBeNull();

    for (let index = 0; index < 16; index++) {
      internals.collectSourceLanguageSample(makeMessage(`sample-${index}`, `sample ${index}`));
    }
    await vi.waitFor(() => expect(internals.sourceDetectionDone).toBe(true));

    expect(detectFromSamples).toHaveBeenCalledTimes(1);
    expect(detectFromSamples.mock.calls[0]?.[0]).toHaveLength(8);
    expect(internals.sourceSampleBuffer).toEqual([]);
    renderer.destroy();
  });

  it('runs only one source-language detection from a bounded sample snapshot', async () => {
    const renderer = new CanvasRenderer(
      overlay,
      makeSettings({ translationEnabled: true, translationSource: 'auto' })
    );
    let resolveDetection!: (language: 'ja') => void;
    const detection = new Promise<'ja'>((resolve) => {
      resolveDetection = resolve;
    });
    const detectFromSamples = vi.fn(() => detection);
    const internals = renderer as unknown as {
      languageDetector: {
        detectFromSamples(samples: string[]): Promise<'ja'>;
        destroy(): void;
      };
      sourceSampleBuffer: string[];
      performSourceDetection(): Promise<void>;
    };
    internals.languageDetector = { detectFromSamples, destroy: vi.fn() };
    internals.sourceSampleBuffer = Array.from({ length: 10 }, (_, index) => `sample-${index}`);

    const first = internals.performSourceDetection();
    const second = internals.performSourceDetection();

    expect(detectFromSamples).toHaveBeenCalledTimes(1);
    expect(detectFromSamples).toHaveBeenCalledWith(internals.sourceSampleBuffer.slice(0, 8));

    resolveDetection('ja');
    await Promise.all([first, second]);
    renderer.destroy();
  });

  it('ignores a source-language result after translation is disabled', async () => {
    const renderer = new CanvasRenderer(
      overlay,
      makeSettings({ translationEnabled: true, translationSource: 'auto' })
    );
    let resolveDetection!: (language: 'ja') => void;
    const detection = new Promise<'ja'>((resolve) => {
      resolveDetection = resolve;
    });
    const internals = renderer as unknown as {
      languageDetector: {
        detectFromSamples(samples: string[]): Promise<'ja'>;
        destroy(): void;
      };
      sourceSampleBuffer: string[];
      translationService: { setDetectedSource(language: 'ja'): Promise<void> };
      performSourceDetection(): Promise<void>;
    };
    internals.languageDetector = { detectFromSamples: () => detection, destroy: vi.fn() };
    internals.sourceSampleBuffer = Array.from({ length: 8 }, (_, index) => `sample-${index}`);
    const setDetectedSource = vi
      .spyOn(internals.translationService, 'setDetectedSource')
      .mockResolvedValue();

    const pending = internals.performSourceDetection();
    renderer.updateSettings(makeSettings({ translationEnabled: false, translationSource: 'auto' }));
    resolveDetection('ja');
    await pending;

    expect(setDetectedSource).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it('does not overlap source detection across configuration generations', async () => {
    const renderer = new CanvasRenderer(
      overlay,
      makeSettings({ translationEnabled: true, translationSource: 'auto' })
    );
    let resolveFirst!: (language: 'ja') => void;
    const firstDetection = new Promise<'ja'>((resolve) => {
      resolveFirst = resolve;
    });
    const detectFromSamples = vi
      .fn<() => Promise<'ja'>>()
      .mockReturnValueOnce(firstDetection)
      .mockResolvedValue('ja');
    const internals = renderer as unknown as {
      languageDetector: {
        detectFromSamples(samples: string[]): Promise<'ja'>;
        destroy(): void;
      };
      sourceSampleBuffer: string[];
      performSourceDetection(): Promise<void>;
    };
    internals.languageDetector = { detectFromSamples, destroy: vi.fn() };
    internals.sourceSampleBuffer = Array.from({ length: 8 }, (_, index) => `old-${index}`);

    const oldRun = internals.performSourceDetection();
    renderer.updateSettings(makeSettings({ translationEnabled: false, translationSource: 'auto' }));
    renderer.updateSettings(makeSettings({ translationEnabled: true, translationSource: 'auto' }));
    internals.sourceSampleBuffer = Array.from({ length: 8 }, (_, index) => `new-${index}`);
    const blockedRun = internals.performSourceDetection();

    expect(detectFromSamples).toHaveBeenCalledTimes(1);
    resolveFirst('ja');
    await Promise.all([oldRun, blockedRun]);

    await internals.performSourceDetection();
    expect(detectFromSamples).toHaveBeenCalledTimes(2);
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

  it('limits disconnected pointer handling to a dedicated reload button', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    (overlay as unknown as { container: HTMLDivElement }).container = container;
    const renderer = new CanvasRenderer(overlay, makeSettings());
    const onStatusBarClick = vi.fn();
    renderer.onStatusBarClick = onStatusBarClick;

    renderer.setConnectionStatus('disconnected');

    const canvas = container.querySelector('canvas');
    const button = container.querySelector<HTMLButtonElement>('#yt-chat-overlay-status-action');
    expect(canvas?.style.pointerEvents).toBe('none');
    expect(button?.style.display).toBe('flex');
    button?.click();
    expect(onStatusBarClick).toHaveBeenCalledOnce();

    renderer.setConnectionStatus('connected');
    expect(button?.style.display).toBe('none');
    renderer.destroy();
  });

  it('clears exactly once for a connected active frame', () => {
    const renderer = new CanvasRenderer(overlay, makeSettings());
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const clearRect = vi.fn();
    const message = makeMessage('active-frame', 'active');
    const internals = renderer as unknown as {
      canvas: HTMLCanvasElement;
      ctx: CanvasRenderingContext2D;
      activeMessages: CanvasMessage[];
      workerManager: { setActive(active: boolean): void };
      laneAllocator: { resetBatch(now?: number): void; getUtilization(): number };
      drainQueue(now: number): void;
      applyPendingTranslations(): void;
      updateCanvasDpr(
        canvas: HTMLCanvasElement,
        ctx: CanvasRenderingContext2D,
        dims: { width: number; height: number }
      ): void;
      applyLaneDensityIfChanged(): void;
      renderFrame(): void;
    };
    internals.canvas = canvas;
    internals.ctx = { clearRect } as unknown as CanvasRenderingContext2D;
    internals.workerManager.setActive(false);
    internals.laneAllocator = { resetBatch: vi.fn(), getUtilization: () => 0 };
    internals.drainQueue = vi.fn();
    internals.applyPendingTranslations = vi.fn();
    internals.updateCanvasDpr = vi.fn();
    internals.applyLaneDensityIfChanged = vi.fn();
    vi.spyOn(overlay, 'getDimensions').mockReturnValue({ width: 640, height: 360 });
    internals.activeMessages.push({
      message,
      renderMessage: message,
      ghostText: message.text,
      startTime: performance.now() + 1_000,
      fadeStartTime: performance.now() + 1_000,
      duration: 5_000,
      invDuration: 1 / 5_000,
      width: 100,
      height: 20,
      startX: 640,
      x: 640,
      y: 0,
      pausedDuration: 0,
      laneIndex: 0,
      laneArrayIndices: [],
      staggerDelay: 1_000,
      speedTier: 1,
    });

    internals.renderFrame();

    expect(clearRect).toHaveBeenCalledOnce();
    expect(clearRect).toHaveBeenCalledWith(0, 0, 640, 360);
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

  it('keeps sync and async drain queue bookkeeping in parity', async () => {
    const runDrain = async (asyncMode: boolean) => {
      const localOverlay = new Overlay();
      (localOverlay as unknown as { dimensions: { width: number; height: number } }).dimensions = {
        width: 1280,
        height: 720,
      };
      const renderer = new CanvasRenderer(localOverlay, makeSettings());
      const messages = [
        makeMessage('placed-a', 'a'),
        makeMessage('transient', 'b'),
        makeMessage('placed-b', 'c'),
      ];
      type DrainInternals = {
        pendingQueue: {
          enqueue(message: ChatMessage, priority: number): void;
          toArray(): ChatMessage[];
        };
        placeQueuedMessage: ReturnType<typeof vi.fn>;
        drainQueue(now: number): void;
        drainQueueAsync(now: number): Promise<void>;
      };
      const internals = renderer as unknown as DrainInternals;
      for (const message of messages) internals.pendingQueue.enqueue(message, 0);
      internals.placeQueuedMessage = vi.fn((message: ChatMessage) => ({
        placed: message.id !== 'transient',
        oversized: false,
      }));

      if (asyncMode) await internals.drainQueueAsync(100);
      else internals.drainQueue(100);

      const result = {
        pendingIds: internals.pendingQueue.toArray().map((message) => message.id),
        placements: internals.placeQueuedMessage.mock.calls.map(
          ([message, _now, _dimensions, batchIndex]) => [
            (message as ChatMessage).id,
            batchIndex as number,
          ]
        ),
      };
      renderer.destroy();
      return result;
    };

    expect(await runDrain(true)).toEqual(await runDrain(false));
  });

  it('aborts async drain after destruction during a scheduler yield', async () => {
    (overlay as unknown as { dimensions: { width: number; height: number } }).dimensions = {
      width: 1280,
      height: 720,
    };
    const renderer = new CanvasRenderer(overlay, makeSettings());
    type DrainInternals = {
      pendingQueue: { enqueue(message: ChatMessage, priority: number): void };
      placeQueuedMessage: ReturnType<typeof vi.fn>;
      drainQueueAsync(now: number): Promise<void>;
      drainLocked: boolean;
    };
    const internals = renderer as unknown as DrainInternals;
    internals.pendingQueue.enqueue(makeMessage('first', 'a'), 0);
    internals.pendingQueue.enqueue(makeMessage('second', 'b'), 0);
    internals.placeQueuedMessage = vi.fn(() => ({ placed: true, oversized: false }));

    const originalScheduler = Object.getOwnPropertyDescriptor(globalThis, 'scheduler');
    Object.defineProperty(globalThis, 'scheduler', {
      configurable: true,
      value: { yield: vi.fn(async () => renderer.destroy()) },
    });
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(100);

    try {
      await internals.drainQueueAsync(100);
    } finally {
      if (originalScheduler) {
        Object.defineProperty(globalThis, 'scheduler', originalScheduler);
      } else {
        Reflect.deleteProperty(globalThis, 'scheduler');
      }
    }

    expect(internals.placeQueuedMessage).toHaveBeenCalledOnce();
    expect(internals.drainLocked).toBe(false);
  });
});
