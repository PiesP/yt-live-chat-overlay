// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { RuntimeManager } from '@app/runtime-manager';
import type { OverlaySettings } from '@app-types';

// RuntimeManager requires getCurrentUrl, getSettings, isValidPage callbacks.
// Tests verify constructor, settings access via backdoor, and health shape.

function makeDefaults(overrides: Partial<OverlaySettings> = {}): OverlaySettings {
  const d = {
    enabled: true, danmakuMode: 'scroll' as const, speedPxPerSec: 250,
    fontSize: 32, opacity: 1, superChatOpacity: 0.95, safeTop: 0, safeBottom: 0,
    maxConcurrentMessages: 300, allowShortTextMessages: false, minTextLength: 1,
    logLevel: 'warn' as const, showAuthor: { normal: false, member: true, moderator: true, owner: true, verified: true, superChat: true },
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
  return d;
}

describe('RuntimeManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const createOpts = (overrides: { url?: string; settings?: OverlaySettings; valid?: boolean } = {}) => ({
    getCurrentUrl: () => overrides.url ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    getSettings: () => overrides.settings ?? makeDefaults(),
    isValidPage: () => overrides.valid ?? true,
  });

  it('constructs without throwing', () => {
    expect(() => new RuntimeManager(createOpts())).not.toThrow();
  });

  it('accepts custom settings callback', () => {
    const s = makeDefaults({ fontSize: 64 });
    const rm = new RuntimeManager(createOpts({ settings: s }));
    expect(rm).toBeDefined();
  });

  it('provides current session settings to ChatSource providers', () => {
    const initial = makeDefaults({ minTextLength: 2 });
    const next = makeDefaults({ minTextLength: 5 });
    const rm = new RuntimeManager(createOpts({ settings: initial }));
    const internals = rm as unknown as {
      settings: OverlaySettings | null;
      getSessionSettings: () => Readonly<OverlaySettings>;
    };

    internals.settings = initial;
    const getSessionSettings = internals.getSessionSettings.bind(rm);
    expect(getSessionSettings()).toBe(initial);

    internals.settings = next;
    expect(getSessionSettings()).toBe(next);
  });

  it('derives and updates backlog pending capacity from queueMaxSize', () => {
    const initial = makeDefaults({ queueMaxSize: 300 });
    const next = makeDefaults({ queueMaxSize: 75 });
    const rm = new RuntimeManager(createOpts({ settings: initial }));
    const fakeRenderer = {
      addMessage: vi.fn(),
      destroy: vi.fn(),
      getLaneUtilization: vi.fn(() => 0),
      laneCount: 24,
      observability: undefined,
      onBacklogPauseChange: null,
      updateSettings: vi.fn(),
    };
    const internals = rm as unknown as {
      state: string;
      settings: OverlaySettings | null;
      renderer: typeof fakeRenderer | null;
      backlogController: {
        config: { pendingCapacity: number };
      } | null;
      ensureBacklogController: (renderer: typeof fakeRenderer) => void;
      updateSessionSettings: (settings: OverlaySettings) => void;
    };

    internals.state = 'active';
    internals.settings = initial;
    internals.renderer = fakeRenderer;
    internals.ensureBacklogController(fakeRenderer);
    expect(internals.backlogController?.config.pendingCapacity).toBe(300);

    internals.updateSessionSettings(next);
    expect(internals.backlogController?.config.pendingCapacity).toBe(75);

    rm.destroy();
  });

  it('accepts invalid page callback', () => {
    const rm = new RuntimeManager(createOpts({ valid: false }));
    expect(rm).toBeDefined();
  });

  it('accepts non-watch URL', () => {
    const rm = new RuntimeManager(createOpts({ url: 'https://www.youtube.com/' }));
    expect(rm).toBeDefined();
  });

  it('start() and reconcileNow() are async methods', () => {
    const rm = new RuntimeManager(createOpts());
    expect(rm.start()).toBeInstanceOf(Promise);
    expect(rm.reconcileNow('startup')).toBeInstanceOf(Promise);
    expect(rm.restartSession()).toBeInstanceOf(Promise);
  });

  it('multiple instances can coexist', () => {
    const a = new RuntimeManager(createOpts());
    const b = new RuntimeManager(createOpts({ valid: false }));
    expect(a).not.toBe(b);
  });

  it('does not apply visibility side effects after disposal has started', () => {
    type RuntimeManagerInternals = {
      state: string;
      hiddenSince: number | null;
      startForegroundListeners: () => void;
      stopForegroundListeners: () => void;
    };

    const rm = new RuntimeManager(createOpts());
    const internals = rm as unknown as RuntimeManagerInternals;
    internals.state = 'destroyed';
    internals.startForegroundListeners();

    const originalVisibilityState = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(internals.hiddenSince).toBeNull();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: originalVisibilityState,
    });
    internals.stopForegroundListeners();
  });

  it('clears visibility state when standby resumes in the foreground', () => {
    const rm = new RuntimeManager(createOpts());
    const setPauseReason = vi.fn();
    const pauseStandby = vi.fn();
    const resumeStandby = vi.fn();
    const pauseRenderer = vi.fn();
    const resumeRenderer = vi.fn();
    const internals = rm as unknown as {
      hiddenSince: number | null;
      chatSource: { setPauseReason(reason: 'visibility', active: boolean): void } | null;
      renderer: {
        pause(): void;
        resume(): void;
        trimBackgroundQueue(): void;
      } | null;
      standbyController: {
        pause(): void;
        resume(): void;
        isStandby(): boolean;
      };
      startForegroundListeners(): void;
      stopForegroundListeners(): void;
    };
    internals.chatSource = { setPauseReason };
    internals.renderer = {
      pause: pauseRenderer,
      resume: resumeRenderer,
      trimBackgroundQueue: vi.fn(),
    };
    internals.standbyController = {
      pause: pauseStandby,
      resume: resumeStandby,
      isStandby: () => true,
    };
    internals.startForegroundListeners();

    const originalVisibilityState = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(internals.hiddenSince).not.toBeNull();
    expect(setPauseReason).toHaveBeenLastCalledWith('visibility', true);
    expect(pauseStandby).toHaveBeenCalledOnce();
    expect(pauseRenderer).toHaveBeenCalledOnce();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(internals.hiddenSince).toBeNull();
    expect(setPauseReason).toHaveBeenLastCalledWith('visibility', false);
    expect(resumeStandby).toHaveBeenCalledOnce();
    expect(resumeRenderer).toHaveBeenCalledOnce();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: originalVisibilityState,
    });
    internals.stopForegroundListeners();
  });

  it('cancels a deferred restart when the active session is disposed', () => {
    vi.useFakeTimers();
    const rm = new RuntimeManager(createOpts());
    const internals = rm as unknown as {
      state: string;
      targetUrl: string | null;
      sessionGeneration: number;
      restartTimer: ReturnType<typeof setTimeout> | null;
      requestManagedRestart: (reason: 'watchdog') => void;
      disposeActiveSession: () => void;
      handleSessionRestart: (reason: 'watchdog') => void;
    };
    const restartSpy = vi.spyOn(internals, 'handleSessionRestart');

    internals.state = 'active';
    internals.targetUrl = 'https://www.youtube.com/watch?v=old';
    internals.sessionGeneration = 1;
    internals.requestManagedRestart('watchdog');
    expect(internals.restartTimer).not.toBeNull();

    internals.disposeActiveSession();
    internals.targetUrl = 'https://www.youtube.com/watch?v=new';
    internals.state = 'active';
    vi.advanceTimersByTime(5_000);

    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('ignores a deferred restart whose session generation changed', () => {
    vi.useFakeTimers();
    const rm = new RuntimeManager(createOpts());
    const internals = rm as unknown as {
      state: string;
      targetUrl: string | null;
      sessionGeneration: number;
      requestManagedRestart: (reason: 'watchdog') => void;
      handleSessionRestart: (reason: 'watchdog') => void;
    };
    const restartSpy = vi.spyOn(internals, 'handleSessionRestart');

    internals.state = 'active';
    internals.targetUrl = 'https://www.youtube.com/watch?v=old';
    internals.sessionGeneration = 1;
    internals.requestManagedRestart('watchdog');

    // Simulate a missed cleanup to exercise the callback's identity guard.
    internals.sessionGeneration = 2;
    internals.targetUrl = 'https://www.youtube.com/watch?v=new';
    internals.state = 'active';
    vi.advanceTimersByTime(5_000);

    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('does not start a second session while a deferred restart is pending', async () => {
    vi.useFakeTimers();
    const rm = new RuntimeManager(createOpts());
    const internals = rm as unknown as {
      state: string;
      targetUrl: string | null;
      restartTimer: ReturnType<typeof setTimeout> | null;
      startSession: () => Promise<'started'>;
    };

    internals.state = 'restarting';
    internals.targetUrl = 'https://www.youtube.com/watch?v=current';
    internals.restartTimer = setTimeout(() => {}, 5_000);
    const startSpy = vi.spyOn(internals, 'startSession').mockResolvedValue('started');

    await rm.reconcileNow('settings-change');

    expect(startSpy).not.toHaveBeenCalled();
    clearTimeout(internals.restartTimer);
  });
});
