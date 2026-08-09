// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { RuntimeManager } from '@app/runtime-manager';
import type { OverlaySettings } from '@app-types';

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

describe('RuntimeManager (extended)', () => {
  type RmInternals = {
    state: string;
    targetUrl: string | null;
    settings: OverlaySettings | null;
    sessionGeneration: number;
    restartTimer: ReturnType<typeof setTimeout> | null;
    chatRestartPromise: Promise<unknown> | null;
    consecutiveWatchdogRestarts: number;
    recentRestartTimestamps: number[];
    consecutiveRefreshFailures: number;
    startFailureState: { url: string | null; attempts: number };
    handleStartFailure: (url: string, status: 'retryable' | 'unavailable' | 'waiting') => void;
    resetStartFailures: () => void;
    disposeActiveSession: () => void;
    destroy: () => void;
    getDesiredState: () => { shouldRun: boolean; url: string; settings: OverlaySettings };
    matchesSessionUrl: (url: string) => boolean;
    getRemainingSettleDelay: () => number;
    handleSessionRestart: (reason: 'watchdog' | 'foreground-return' | 'standby-resolved', generation?: number) => void;
    requestManagedRestart: (reason: 'watchdog' | 'foreground-return' | 'standby-resolved') => void;
    computeConnectionStatus: () => string;
    acceptForRenderer: (msg: { id?: string; actionType?: 'add' | 'replace' }) => boolean;
    routeMessages: (msgs: Array<Record<string, unknown>>) => void;
    renderer: Record<string, unknown> | null;
    backlogController: { drainPending(): Array<Record<string, unknown>> } | null;
    _recoveringFromError: boolean;
  };

  function createOpts(overrides: { url?: string; settings?: OverlaySettings; valid?: boolean } = {}) {
    return {
      getCurrentUrl: () => overrides.url ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      getSettings: () => overrides.settings ?? makeDefaults(),
      isValidPage: () => overrides.valid ?? true,
    };
  }

  function internalsOf(rm: RuntimeManager): RmInternals {
    return rm as unknown as RmInternals;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('state transitions', () => {
    it('initial state is "init"', () => {
      const rm = new RuntimeManager(createOpts());
      expect(internalsOf(rm).state).toBe('init');
    });

    it('destroy transitions state to "destroyed"', () => {
      const rm = new RuntimeManager(createOpts());
      rm.destroy();
      expect(internalsOf(rm).state).toBe('destroyed');
    });

    it('destroy is idempotent', () => {
      const rm = new RuntimeManager(createOpts());
      rm.destroy();
      const stateAfter = internalsOf(rm).state;
      rm.destroy(); // Second destroy should be no-op
      expect(internalsOf(rm).state).toBe(stateAfter);
    });

    it('start after destroy logs a warning and returns', async () => {
      const rm = new RuntimeManager(createOpts());
      rm.destroy();
      const p = rm.start();
      await expect(p).resolves.toBeUndefined();
    });

    it('requestReconcile after destroy is ignored', () => {
      const rm = new RuntimeManager(createOpts());
      rm.destroy();
      // Should not throw
      expect(() => rm.requestReconcile('page-change')).not.toThrow();
    });

    it('disposeActiveSession increments sessionGeneration', () => {
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);
      const gen = internals.sessionGeneration;
      internals.state = 'active';
      internals.targetUrl = 'https://www.youtube.com/watch?v=test';
      internals.disposeActiveSession();
      expect(internals.sessionGeneration).toBe(gen + 1);
      expect(internals.targetUrl).toBeNull();
    });
  });

  describe('desired state', () => {
    it('returns shouldRun=true for valid page with enabled settings', () => {
      const rm = new RuntimeManager(createOpts({ valid: true }));
      const desired = internalsOf(rm).getDesiredState();
      expect(desired.shouldRun).toBe(true);
    });

    it('returns shouldRun=false when page is invalid', () => {
      const rm = new RuntimeManager(createOpts({ valid: false }));
      const desired = internalsOf(rm).getDesiredState();
      expect(desired.shouldRun).toBe(false);
    });

    it('returns shouldRun=false when settings are disabled', () => {
      const rm = new RuntimeManager(createOpts({
        settings: makeDefaults({ enabled: false }),
      }));
      const desired = internalsOf(rm).getDesiredState();
      expect(desired.shouldRun).toBe(false);
    });
  });

  describe('URL matching', () => {
    it('matchesSessionUrl returns true for same URL', () => {
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);
      internals.targetUrl = 'https://www.youtube.com/watch?v=same';
      expect(internals.matchesSessionUrl('https://www.youtube.com/watch?v=same')).toBe(true);
    });

    it('matchesSessionUrl returns false for different URL', () => {
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);
      internals.targetUrl = 'https://www.youtube.com/watch?v=old';
      expect(internals.matchesSessionUrl('https://www.youtube.com/watch?v=new')).toBe(false);
    });

    it('matchesSessionUrl returns false when targetUrl is null', () => {
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);
      internals.targetUrl = null;
      expect(internals.matchesSessionUrl('https://www.youtube.com/watch?v=any')).toBe(false);
    });
  });

  describe('connection status', () => {
    it('returns "standby" when standby controller is active', () => {
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);
      const standbyController = (rm as unknown as { standbyController: { isStandby: () => boolean } }).standbyController;

      // Force standby mode
      standbyController.isStandby = () => true;
      expect(internals.computeConnectionStatus()).toBe('standby');
    });

    it('returns "connecting" when no chat source', () => {
      const rm = new RuntimeManager(createOpts());
      expect(internalsOf(rm).computeConnectionStatus()).toBe('connecting');
    });
  });

  describe('start failure handling', () => {
    it('handleStartFailure marks "unavailable" with max attempts', () => {
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);
      internals.handleStartFailure('https://test.com/watch', 'unavailable');
      expect(internals.startFailureState.url).toBe('https://test.com/watch');
      expect(internals.startFailureState.attempts).toBe(3); // MAX_START_ATTEMPTS
    });

    it('handleStartFailure increments attempts for retryable', () => {
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);
      internals.startFailureState = { url: 'https://test.com/watch', attempts: 1 };
      internals.handleStartFailure('https://test.com/watch', 'retryable');
      expect(internals.startFailureState.attempts).toBe(2);
    });

    it('handleStartFailure resets attempts for new URL', () => {
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);
      internals.startFailureState = { url: 'https://old.com/watch', attempts: 3 };
      internals.handleStartFailure('https://new.com/watch', 'retryable');
      expect(internals.startFailureState.url).toBe('https://new.com/watch');
      expect(internals.startFailureState.attempts).toBe(1);
    });

    it('resetStartFailures sets state to defaults', () => {
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);
      internals.handleStartFailure('https://test.com/watch', 'retryable');
      internals.resetStartFailures();
      expect(internals.startFailureState.url).toBeNull();
      expect(internals.startFailureState.attempts).toBe(0);
    });
  });

  describe('message dedup', () => {
    it('acceptForRenderer accepts new message', () => {
      const rm = new RuntimeManager(createOpts());
      const result = internalsOf(rm).acceptForRenderer({ id: 'msg-1' });
      expect(result).toBe(true);
    });

    it('acceptForRenderer rejects duplicate message', () => {
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);
      internals.acceptForRenderer({ id: 'msg-1' });
      const result = internals.acceptForRenderer({ id: 'msg-1' });
      expect(result).toBe(false);
    });

    it('acceptForRenderer accepts a replacement for an already rendered id', () => {
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);
      internals.acceptForRenderer({ id: 'msg-1', actionType: 'add' });

      expect(internals.acceptForRenderer({ id: 'msg-1', actionType: 'replace' })).toBe(true);
      expect(internals.acceptForRenderer({ id: 'msg-1', actionType: 'add' })).toBe(false);
    });

    it('acceptForRenderer rejects an unseen replacement without claiming its id', () => {
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);

      expect(internals.acceptForRenderer({ id: 'msg-1', actionType: 'replace' })).toBe(false);
      expect(internals.acceptForRenderer({ id: 'msg-1', actionType: 'add' })).toBe(true);
      expect(internals.acceptForRenderer({ id: 'msg-1', actionType: 'replace' })).toBe(true);
      expect(internals.acceptForRenderer({ id: 'msg-1', actionType: 'add' })).toBe(false);
    });

    it.each([
      ['large backlog', 51, false, 0],
      ['error recovery', 2, true, 0],
      ['high utilization', 5, false, 1],
    ])('preserves a queued replacement through the %s route', (_label, batchSize, recovering, utilization) => {
      vi.useFakeTimers();
      const rm = new RuntimeManager(createOpts({ settings: makeDefaults({ backlogMode: 'full' }) }));
      const internals = internalsOf(rm);
      internals.settings = makeDefaults({ backlogMode: 'full' });
      const addMessage = vi.fn();
      internals.renderer = {
        addMessage,
        setStandbyStatus: vi.fn(),
        getLaneUtilization: vi.fn(() => utilization),
        laneCount: 24,
        observability: undefined,
        destroy: vi.fn(),
      };

      const makeBatch = (replacement: boolean) =>
        Array.from({ length: batchSize }, (_, index) => ({
          id: index === 1 ? 'target' : `${replacement ? 'next' : 'initial'}-${index}`,
          text: index === 1 && replacement ? 'replacement' : `message-${index}`,
          kind: 'text',
          timestamp: index,
          ...(index === 1 && replacement ? { actionType: 'replace' as const } : {}),
        }));

      internals._recoveringFromError = recovering;
      internals.routeMessages(makeBatch(false));
      internals._recoveringFromError = recovering;
      internals.routeMessages(makeBatch(true));

      const target = internals.backlogController
        ?.drainPending()
        .find((message) => message.id === 'target');
      expect(target).toMatchObject({ text: 'replacement', actionType: 'replace' });
      expect(addMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: 'target', text: 'replacement' })
      );
      rm.destroy();
    });

    it('acceptForRenderer always accepts messages without id', () => {
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);
      expect(internals.acceptForRenderer({})).toBe(true);
      expect(internals.acceptForRenderer({})).toBe(true);
    });
  });

  describe('settle delay', () => {
    it('getRemainingSettleDelay returns 0 with no page change', () => {
      const rm = new RuntimeManager(createOpts());
      expect(internalsOf(rm).getRemainingSettleDelay()).toBe(0);
    });
  });

  describe('managed restart', () => {
    it('requestManagedRestart is ignored when disposed', () => {
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);
      internals.state = 'disposed';
      expect(() => internals.requestManagedRestart('watchdog')).not.toThrow();
    });

    it('requestManagedRestart sets restarting state', () => {
      vi.useFakeTimers();
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);
      internals.state = 'active';
      internals.targetUrl = 'https://www.youtube.com/watch?v=test';
      internals.sessionGeneration = 5;
      internals.requestManagedRestart('watchdog');
      expect(internals.state).toBe('restarting');
      vi.useRealTimers();
    });

    it('consecutive restarts are tracked', () => {
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);
      expect(internals.consecutiveWatchdogRestarts).toBe(0);
    });

    it('consecutive refresh failures starts at 0', () => {
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);
      expect(internals.consecutiveRefreshFailures).toBe(0);
    });
  });

  describe('handleSessionRestart', () => {
    it('ignores call when destroyed', () => {
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);
      internals.state = 'destroyed';
      expect(() => internals.handleSessionRestart('watchdog')).not.toThrow();
    });

    it('ignores call when generation mismatches', () => {
      const rm = new RuntimeManager(createOpts());
      const internals = internalsOf(rm);
      internals.state = 'active';
      internals.sessionGeneration = 3;
      expect(() => internals.handleSessionRestart('watchdog', 5)).not.toThrow();
    });
  });
});
