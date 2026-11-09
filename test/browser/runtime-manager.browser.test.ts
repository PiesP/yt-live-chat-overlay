// SPDX-License-Identifier: MIT

import type { ChatMessage, OverlaySettings } from '@app-types';
import { Overlay } from '@app/overlay';
import { RuntimeManager } from '@app/runtime-manager';
import { LiveChatSource } from '@chat/source-live';
import { ReplayChatSource } from '@chat/source-replay';
import * as youtubeApi from '@chat/youtube/api';
import { CanvasRenderer } from '@renderer/canvas-renderer';
import { RenderWorkerManager } from '@renderer/worker/manager';
import { ObservabilityReporter } from '@util/observability';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('@chat/youtube/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chat/youtube/api')>();
  return { ...actual, bootstrapChatSession: vi.fn(actual.bootstrapChatSession) };
});

// RuntimeManager requires getCurrentUrl, getSettings, isValidPage callbacks.
// Tests verify constructor, settings access via backdoor, and health shape.

function makeDefaults(overrides: Partial<OverlaySettings> = {}): OverlaySettings {
  const d = {
    enabled: true,
    danmakuMode: 'scroll' as const,
    speedPxPerSec: 250,
    fontSize: 32,
    opacity: 1,
    superChatOpacity: 0.95,
    safeTop: 0,
    safeBottom: 0,
    maxConcurrentMessages: 300,
    allowShortTextMessages: false,
    minTextLength: 1,
    logLevel: 'warn' as const,
    showAuthor: {
      normal: false,
      member: true,
      moderator: true,
      owner: true,
      verified: true,
      superChat: true,
    },
    colors: {
      normal: '#FFFFFF',
      member: '#0F9D58',
      moderator: '#5E84F1',
      owner: '#FFD600',
      verified: '#AAAAAA',
    },
    outline: { enabled: true, widthPx: 2, opacity: 0.7 },
    laneSpacing: 1,
    showDebugOverlay: false,
    ignoreReducedMotion: false,
    authorRateLimit: 'normal' as const,
    backlogMaxRate: 10,
    backlogSpeedMultiplier: 1,
    backlogMode: 'playback' as const,
    backlogRecentMinutes: 5,
    backlogOpacityMultiplier: 0.5,
    depthLayersEnabled: false,
    depthNearSpeedMul: 1.2,
    depthFarSpeedMul: 0.8,
    depthFarOpacityMul: 0.6,
    modOwnerDurationMultiplier: 1.5,
    showSuperChatAmount: true,
    fontWeight: 'bold' as const,
    fontFamily: "'YouTube Sans', 'Roboto', 'Arial', sans-serif",
    preserveUserColor: true,
    superChatMaxBodyLines: 3,
    membershipMaxBodyLines: 2,
    fadeDurationMs: 300,
    minPollIntervalMs: 1000,
    maxPollIntervalMs: 10000,
    language: 'en' as const,
    translationEnabled: false,
    translationService: 'auto' as const,
    translationSource: 'auto' as const,
    translationTarget: 'en' as const,
    translationMode: 'dual' as const,
    exitPaddingPx: 50,
    scrollDurationMinMs: 3000,
    scrollDurationMaxMs: 15000,
    topBottomDurationMs: 5000,
    queueMaxSize: 500,
    backgroundQueueMax: 200,
    maxMessageAgeMs: 30000,
    headwayGapRatio: 0.3,
    emojiCacheMb: 20,
    photoCacheMb: 10,
    stickerCacheMb: 5,
    textCacheMb: 5,
    translationBatchSize: 5,
    emojiFetchLimit: 20,
    failedEmojiRetryMins: 5,
    burstSampleWindow: 60,
    burstElevatedThreshold: 5,
    burstHighThreshold: 15,
    burstExtremeThreshold: 30,
    backlogInjectionMax: 50,
    backlogDensityRampMs: 5000,
    livePollFallbackMs: 2000,
    livePollFailureLimit: 5,
    speedBoostThreshold: 2,
    backlogPauseThreshold: 0.3,
    backlogResumeThreshold: 0.1,
    activityTimeoutMs: 60000,
    staggerMaxDelayMs: 100,
    staggerMediumDelayMs: 50,
    emojiFetchTimeoutMs: 5000,
    backlogDensityRampMaxMs: 10000,
    backlogInjectionRateMin: 1,
    speedBoostMax: 1,
    speedBoostDenom: 2,
    backlogToggleCooldownMs: 2000,
    replayPrefetchPages: 50,
    replayBatchLimit: 50,
    ...overrides,
  } as OverlaySettings;
  return d;
}

describe('RuntimeManager', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const createOpts = (
    overrides: { url?: string; settings?: OverlaySettings; valid?: boolean } = {}
  ) => ({
    getCurrentUrl: () => overrides.url ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    getSettings: () => overrides.settings ?? makeDefaults(),
    isValidPage: () => overrides.valid ?? true,
  });

  const readyBootstrap = (isReplay: boolean) => ({
    status: 'ready' as const,
    data: {
      videoId: 'video',
      isReplay,
      clientContext: {},
      clientNameHeader: 'WEB',
      ytcfg: {},
      initialContinuation: { continuation: 'initial' },
    },
  });

  const installPlayer = (): HTMLElement => {
    const player = document.createElement('div');
    player.id = 'movie_player';
    player.style.width = '640px';
    player.style.height = '360px';
    Object.defineProperty(player, 'offsetWidth', { configurable: true, value: 640 });
    Object.defineProperty(player, 'offsetHeight', { configurable: true, value: 360 });
    document.body.append(player);
    vi.spyOn(RenderWorkerManager.prototype, 'init').mockReturnValue({
      started: false,
      canvasTransferred: false,
    });
    return player;
  };

  it('constructs without throwing', () => {
    expect(() => new RuntimeManager(createOpts())).not.toThrow();
  });

  it('projects managed recovery through actual health and terminal retry states', () => {
    vi.useFakeTimers();
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const onRecoveryStatus = vi.fn();
    const rm = new RuntimeManager({ ...createOpts(), onRecoveryStatus });
    const internals = rm as unknown as {
      state: string;
      targetUrl: string | null;
      sessionGeneration: number;
      chatSource: { getHealthSnapshot: () => object } | null;
      requestManagedRestart: (reason: 'watchdog') => void;
      clearRecoveryWhenHealthy: () => void;
      handleStartFailure: (url: string, status: 'retryable') => void;
    };

    internals.state = 'active';
    internals.targetUrl = url;
    internals.sessionGeneration = 1;
    internals.requestManagedRestart('watchdog');
    expect(onRecoveryStatus.mock.calls).toEqual([['recovering']]);
    internals.requestManagedRestart('watchdog');
    expect(onRecoveryStatus).toHaveBeenCalledTimes(1);

    internals.state = 'active';
    internals.chatSource = {
      getHealthSnapshot: () => ({
        consecutiveErrors: 0,
        observerAlive: true,
        recentlyActive: true,
      }),
    };
    internals.clearRecoveryWhenHealthy();
    expect(onRecoveryStatus.mock.calls).toEqual([['recovering'], [null]]);

    internals.chatSource = null;
    internals.requestManagedRestart('watchdog');
    internals.handleStartFailure(url, 'retryable');
    internals.handleStartFailure(url, 'retryable');
    expect(onRecoveryStatus.mock.lastCall).toEqual(['recovering']);
    internals.handleStartFailure(url, 'retryable');
    expect(onRecoveryStatus.mock.lastCall).toEqual(['failed']);
    rm.destroy();
    expect(onRecoveryStatus.mock.lastCall).toEqual([null]);
  });

  it('clears recovery feedback immediately when the overlay is disabled', () => {
    vi.useFakeTimers();
    let enabled = true;
    const onRecoveryStatus = vi.fn();
    const rm = new RuntimeManager({
      ...createOpts(),
      getSettings: () => makeDefaults({ enabled }),
      onRecoveryStatus,
    });
    const internals = rm as unknown as {
      state: string;
      targetUrl: string | null;
      requestManagedRestart: (reason: 'watchdog') => void;
    };
    internals.state = 'active';
    internals.targetUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    internals.requestManagedRestart('watchdog');
    expect(onRecoveryStatus.mock.lastCall).toEqual(['recovering']);

    enabled = false;
    rm.requestReconcile('settings-change');
    expect(onRecoveryStatus.mock.lastCall).toEqual([null]);
    rm.destroy();
  });

  it('clears terminal restart feedback if the active chat source heals naturally', () => {
    vi.useFakeTimers();
    const onRecoveryStatus = vi.fn();
    const rm = new RuntimeManager({ ...createOpts(), onRecoveryStatus });
    const internals = rm as unknown as {
      state: string;
      targetUrl: string | null;
      consecutiveWatchdogRestarts: number;
      chatSource: { getHealthSnapshot: () => object; stop: () => void } | null;
      requestManagedRestart: (reason: 'watchdog') => void;
      clearRecoveryWhenHealthy: () => void;
    };
    internals.state = 'active';
    internals.targetUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    internals.requestManagedRestart('watchdog');
    expect(onRecoveryStatus.mock.lastCall).toEqual(['recovering']);

    internals.state = 'active';
    internals.consecutiveWatchdogRestarts = 4;
    internals.requestManagedRestart('watchdog');
    expect(onRecoveryStatus.mock.lastCall).toEqual(['failed']);
    internals.chatSource = {
      getHealthSnapshot: () => ({
        consecutiveErrors: 0,
        observerAlive: true,
        recentlyActive: true,
      }),
      stop: vi.fn(),
    };
    internals.clearRecoveryWhenHealthy();
    expect(onRecoveryStatus.mock.lastCall).toEqual([null]);
    rm.destroy();
  });

  it('rebinds pause state to the current overlay and detaches the retired overlay', () => {
    const onUserPauseStatus = vi.fn();
    const rm = new RuntimeManager({ ...createOpts(), onUserPauseStatus });
    const internals = rm as unknown as {
      overlay: Overlay | null;
      bindUserPause: (overlay: Overlay) => void;
      detachUserPause: () => void;
    };
    const first = new Overlay();
    const second = new Overlay();
    internals.overlay = first;
    internals.bindUserPause(first);
    expect(onUserPauseStatus.mock.calls).toEqual([[false]]);
    first.toggleUserPause();
    expect(onUserPauseStatus.mock.lastCall).toEqual([true]);

    internals.overlay = second;
    internals.bindUserPause(second);
    expect(onUserPauseStatus.mock.lastCall).toEqual([false]);
    onUserPauseStatus.mockClear();
    first.toggleUserPause();
    expect(onUserPauseStatus).not.toHaveBeenCalled();
    second.toggleUserPause();
    expect(onUserPauseStatus.mock.calls).toEqual([[true]]);
    internals.detachUserPause();
    expect(onUserPauseStatus.mock.lastCall).toEqual([null]);
    onUserPauseStatus.mockClear();
    second.toggleUserPause();
    expect(onUserPauseStatus).not.toHaveBeenCalled();
    rm.destroy();
  });

  it('keeps the watchdog active without treating a 45-second user pause as renderer failure', () => {
    vi.useFakeTimers();
    const rm = new RuntimeManager(createOpts());
    const overlay = new Overlay();
    const container = document.createElement('div');
    document.body.appendChild(container);
    vi.spyOn(overlay, 'getContainer').mockReturnValue(container);
    vi.spyOn(overlay, 'getDimensions').mockReturnValue({ width: 640, height: 360 });
    const renderer = {
      isWorkerAlive: vi.fn(() => true),
      getQueueLength: vi.fn(() => 5),
      getActiveMessageCount: vi.fn(() => 0),
      getMsSinceLastRenderActivity: vi.fn(() => 45_000),
      fallbackToMainThread: vi.fn(),
      setConnectionStatus: vi.fn(),
    };
    let chatHealthy = true;
    const source = {
      getHealthSnapshot: vi.fn(() => ({
        observerAlive: true,
        recentlyActive: chatHealthy,
        consecutiveErrors: 0,
        isInBackoff: false,
      })),
    };
    const internals = rm as unknown as {
      state: string;
      overlay: Overlay | null;
      renderer: typeof renderer | null;
      chatSource: typeof source | null;
      getVideoElement: () => HTMLVideoElement | null;
      getRuntimeHealthSnapshot: () => { isRendererStuck: boolean; shouldRestart: boolean };
      performOverlayRefresh: (reason: string) => void;
      requestManagedRestart: (reason: 'watchdog') => void;
      startChatWatchdog: () => void;
      stopChatWatchdog: () => void;
    };
    internals.state = 'active';
    internals.overlay = overlay;
    internals.renderer = renderer;
    internals.chatSource = source;
    vi.spyOn(internals, 'getVideoElement').mockReturnValue(null);
    const refresh = vi.spyOn(internals, 'performOverlayRefresh').mockImplementation(() => {});
    const restart = vi.spyOn(internals, 'requestManagedRestart').mockImplementation(() => {});

    try {
      expect(overlay.toggleUserPause()).toBe(true);
      internals.startChatWatchdog();
      vi.advanceTimersByTime(45_000);
      expect(internals.getRuntimeHealthSnapshot()).toMatchObject({
        isRendererStuck: false,
        shouldRestart: false,
      });
      expect(refresh).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();

      expect(overlay.toggleUserPause()).toBe(false);
      expect(internals.getRuntimeHealthSnapshot().isRendererStuck).toBe(true);
      vi.advanceTimersByTime(15_000);
      expect(refresh).toHaveBeenCalledExactlyOnceWith('renderer-stuck');

      expect(overlay.toggleUserPause()).toBe(true);
      chatHealthy = false;
      expect(internals.getRuntimeHealthSnapshot()).toMatchObject({
        isRendererStuck: false,
        shouldRestart: true,
      });
      vi.advanceTimersByTime(15_000);
      expect(restart).toHaveBeenCalledExactlyOnceWith('watchdog');

      chatHealthy = true;
      renderer.isWorkerAlive.mockReturnValue(false);
      expect(internals.getRuntimeHealthSnapshot().isRendererStuck).toBe(true);
      vi.advanceTimersByTime(15_000);
      expect(renderer.fallbackToMainThread).toHaveBeenCalledExactlyOnceWith('worker-dead');
    } finally {
      internals.stopChatWatchdog();
      internals.chatSource = null;
      internals.renderer = null;
      internals.overlay = null;
      rm.destroy();
      overlay.destroy();
      container.remove();
    }
  });

  it('attributes late replay drops only to the current session', async () => {
    vi.mocked(youtubeApi.bootstrapChatSession).mockResolvedValueOnce({
      status: 'ready',
      data: {
        videoId: 'video',
        isReplay: true,
        clientContext: {},
        clientNameHeader: 'WEB',
        ytcfg: {},
        initialContinuation: { continuation: 'initial' },
      },
    });
    vi.spyOn(ReplayChatSource.prototype, 'start').mockResolvedValue('started');
    const observability = new ObservabilityReporter();
    const onMessagesDropped = vi.spyOn(observability, 'onMessagesDropped');
    const rm = new RuntimeManager(createOpts());
    const internals = rm as unknown as {
      renderer: {
        setReplayMode: (enabled: boolean) => void;
        observability: ObservabilityReporter;
      } | null;
      chatSource: ReplayChatSource | null;
      sessionGeneration: number;
      abortController: AbortController;
      startChatSource: (signal: AbortSignal) => Promise<string>;
    };
    internals.renderer = { setReplayMode: vi.fn(), observability };
    const controller = internals.abortController;
    expect(await internals.startChatSource(controller.signal)).toBe('started');
    const source = internals.chatSource;
    expect(source).toBeInstanceOf(ReplayChatSource);

    source?.onLateDrop?.(2);
    expect(onMessagesDropped).toHaveBeenCalledWith(2, 'replay_late');
    expect(observability.getMetrics()).toMatchObject({
      totalReceived: 2,
      totalDropped: 2,
      dropRate: 1,
    });

    // The renderer counts the delivered messages through its own ingress path.
    observability.onMessageReceived();
    observability.onMessageReceived();
    expect(observability.getMetrics()).toMatchObject({
      totalReceived: 4,
      totalDropped: 2,
      dropRate: 0.5,
    });

    internals.sessionGeneration += 1;
    source?.onLateDrop?.(1);
    internals.sessionGeneration -= 1;
    internals.chatSource = null;
    source?.onLateDrop?.(1);
    internals.chatSource = source;
    controller.abort();
    source?.onLateDrop?.(1);
    expect(onMessagesDropped).toHaveBeenCalledTimes(1);
    expect(observability.getMetrics()).toMatchObject({
      totalReceived: 4,
      totalDropped: 2,
      dropRate: 0.5,
    });
  });

  it('does not adopt a source after bootstrap completes and the runtime is destroyed', async () => {
    vi.mocked(youtubeApi.bootstrapChatSession).mockClear();
    const bootstrap = readyBootstrap(false);
    const player = installPlayer();
    const sourceStart = vi.spyOn(LiveChatSource.prototype, 'start');
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            continuationContents: {
              liveChatContinuation: { actions: [], continuations: [] },
            },
          })
        )
    );
    vi.stubGlobal('fetch', fetchMock);
    const rm = new RuntimeManager(createOpts());
    vi.mocked(youtubeApi.bootstrapChatSession).mockImplementationOnce((signal) => {
      expect(signal?.aborted).toBe(false);
      return Promise.resolve(bootstrap).then((result) => {
        // Bootstrap legitimately settled while the signal was live. Retirement
        // occurs before createChatSource's await continuation can publish it.
        expect(signal?.aborted).toBe(false);
        queueMicrotask(() => rm.destroy());
        return result;
      });
    });
    const internals = rm as unknown as {
      state: string;
      targetUrl: string | null;
      chatSource: LiveChatSource | null;
      messageBus: { destroy(): void } | null;
      fetchInterceptorUnsubscribe: (() => void) | null;
      domWatcherUnsubscribe: (() => void) | null;
    };
    try {
      await rm.start();
      rm.destroy();

      expect(internals.state).toBe('destroyed');
      expect(internals.targetUrl).toBeNull();
      expect(internals.chatSource).toBeNull();
      expect(internals.messageBus).toBeNull();
      expect(internals.fetchInterceptorUnsubscribe).toBeNull();
      expect(internals.domWatcherUnsubscribe).toBeNull();
      expect(sourceStart).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(document.querySelector('#yt-live-chat-overlay')).toBeNull();
    } finally {
      // Retire baseline late owners too, so a failing regression cannot affect
      // subsequent tests while demonstrating the original leak.
      internals.chatSource?.stop();
      internals.messageBus?.destroy();
      internals.fetchInterceptorUnsubscribe?.();
      internals.domWatcherUnsubscribe?.();
      rm.destroy();
      player.remove();
      vi.unstubAllGlobals();
    }
  });

  it('keeps the replacement session after a stale bootstrap completes during manual restart', async () => {
    vi.mocked(youtubeApi.bootstrapChatSession).mockClear();
    const bootstrap = readyBootstrap(true);
    const player = installPlayer();
    const sourceStart = vi.spyOn(ReplayChatSource.prototype, 'start').mockResolvedValue('started');
    const rm = new RuntimeManager(createOpts());
    let restartPromise: Promise<void> | undefined;
    vi.mocked(youtubeApi.bootstrapChatSession)
      .mockImplementationOnce((signal) =>
        Promise.resolve(bootstrap).then((result) => {
          expect(signal?.aborted).toBe(false);
          queueMicrotask(() => {
            restartPromise = rm.restartSession();
          });
          return result;
        })
      )
      .mockResolvedValueOnce(bootstrap);
    const internals = rm as unknown as {
      state: string;
      chatSource: ReplayChatSource | null;
      messageBus: object | null;
    };
    try {
      await rm.start();
      expect(restartPromise).toBeDefined();
      await restartPromise;

      expect(internals.state).toBe('active');
      expect(internals.chatSource).toBeInstanceOf(ReplayChatSource);
      expect(internals.messageBus).not.toBeNull();
      expect(sourceStart).toHaveBeenCalledTimes(1);
      expect(youtubeApi.bootstrapChatSession).toHaveBeenCalledTimes(2);
      expect(document.querySelector('#yt-live-chat-overlay')).not.toBeNull();
    } finally {
      rm.destroy();
      player.remove();
    }
  });

  it('aborts the live seed through the runtime signal during source start', async () => {
    vi.mocked(youtubeApi.bootstrapChatSession).mockClear();
    const bootstrap = readyBootstrap(false);
    const player = installPlayer();
    const sourceStart = vi.spyOn(LiveChatSource.prototype, 'start');
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(youtubeApi.bootstrapChatSession).mockResolvedValueOnce(bootstrap);
    const rm = new RuntimeManager(createOpts());
    try {
      const start = rm.start();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const runtimeSignal = vi.mocked(youtubeApi.bootstrapChatSession).mock.calls.at(-1)?.[0];
      expect(sourceStart.mock.calls.at(-1)?.[1]).toBe(runtimeSignal);
      expect(runtimeSignal?.aborted).toBe(false);

      rm.destroy();
      await start;
      expect(runtimeSignal?.aborted).toBe(true);
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      rm.destroy();
      player.remove();
      vi.unstubAllGlobals();
    }
  });

  it.each(['late success', 'late rejection'] as const)(
    'does not let a retired chat-only bootstrap %s change a newer session',
    async (lateResult) => {
      vi.mocked(youtubeApi.bootstrapChatSession).mockClear();
      const bootstrap = readyBootstrap(true);
      const player = installPlayer();
      const sourceStart = vi
        .spyOn(ReplayChatSource.prototype, 'start')
        .mockResolvedValue('started');
      const sourceStop = vi.spyOn(ReplayChatSource.prototype, 'stop');
      const rm = new RuntimeManager(createOpts());
      let resolveOld!: (value: typeof bootstrap) => void;
      let rejectOld!: (reason: unknown) => void;
      let oldSignal: AbortSignal | undefined;
      vi.mocked(youtubeApi.bootstrapChatSession)
        .mockResolvedValueOnce(bootstrap)
        .mockImplementationOnce((signal) => {
          oldSignal = signal;
          return new Promise<typeof bootstrap>((resolve, reject) => {
            resolveOld = resolve;
            rejectOld = reject;
          });
        })
        .mockResolvedValueOnce(bootstrap);
      const internals = rm as unknown as {
        state: string;
        chatSource: ReplayChatSource | null;
        messageBus: object | null;
        renderer: CanvasRenderer | null;
        chatWatchdogTimer: ReturnType<typeof setInterval> | null;
        chatRestartPromise: Promise<unknown> | null;
        requestManagedRestart: (reason: 'watchdog') => void;
      };
      try {
        await rm.start();
        const original = internals.chatSource;
        const renderer = internals.renderer;
        if (!renderer || !original) throw new Error('Expected started runtime');
        vi.spyOn(renderer, 'isWorkerAlive').mockReturnValue(true);
        vi.spyOn(renderer, 'getQueueLength').mockReturnValue(0);

        vi.useFakeTimers();
        internals.requestManagedRestart('watchdog');
        await vi.advanceTimersByTimeAsync(5_000);
        const oldRestart = internals.chatRestartPromise;
        expect(oldRestart).not.toBeNull();
        expect(oldSignal?.aborted).toBe(false);

        await rm.restartSession();
        expect(internals.state).toBe('active');
        const replacement = internals.chatSource;
        const replacementBus = internals.messageBus;
        const replacementWatchdog = internals.chatWatchdogTimer;
        expect(replacement).toBeInstanceOf(ReplayChatSource);
        expect(replacement).not.toBe(original);
        expect(replacementBus).not.toBeNull();
        expect(replacementWatchdog).not.toBeNull();
        expect(oldSignal?.aborted).toBe(true);

        if (lateResult === 'late success') resolveOld(bootstrap);
        else rejectOld(new TypeError('old provider failed'));
        if (lateResult === 'late success') {
          await expect(oldRestart).rejects.toMatchObject({ name: 'AbortError' });
        } else {
          await expect(oldRestart).rejects.toBeInstanceOf(TypeError);
        }
        expect(internals.state).toBe('active');
        expect(internals.chatSource).toBe(replacement);
        expect(internals.messageBus).toBe(replacementBus);
        expect(internals.chatWatchdogTimer).toBe(replacementWatchdog);
        expect(sourceStart).toHaveBeenCalledTimes(2);
        expect(sourceStop).toHaveBeenCalledTimes(1);
        expect(youtubeApi.bootstrapChatSession).toHaveBeenCalledTimes(3);
        expect(document.querySelector('#yt-live-chat-overlay')).not.toBeNull();
      } finally {
        rm.destroy();
        player.remove();
      }
    }
  );

  it('does not publish a source when bootstrap rejects', async () => {
    vi.mocked(youtubeApi.bootstrapChatSession).mockClear();
    const player = installPlayer();
    const sourceStart = vi.spyOn(LiveChatSource.prototype, 'start');
    vi.mocked(youtubeApi.bootstrapChatSession).mockRejectedValueOnce(
      new TypeError('provider failed')
    );
    const rm = new RuntimeManager(createOpts());
    const internals = rm as unknown as {
      chatSource: LiveChatSource | null;
      messageBus: object | null;
      fetchInterceptorUnsubscribe: (() => void) | null;
    };
    try {
      await rm.start();
      expect(internals.chatSource).toBeNull();
      expect(internals.messageBus).toBeNull();
      expect(internals.fetchInterceptorUnsubscribe).toBeNull();
      expect(sourceStart).not.toHaveBeenCalled();
    } finally {
      rm.destroy();
      player.remove();
    }
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

  describe('foreground return thresholds', () => {
    const makeHarness = (videoPaused = false) => {
      const rm = new RuntimeManager(createOpts());
      const renderer = {
        isVideoPaused: videoPaused,
        pause: vi.fn(),
        resume: vi.fn(),
        clearPausedDuration: vi.fn(),
        trimBackgroundQueue: vi.fn(),
        drainPendingQueue: vi.fn(() => []),
        getActiveMessageCount: vi.fn(() => 0),
        getQueueLength: vi.fn(() => 0),
        getMsSinceLastRenderActivity: vi.fn(() => 0),
        isWorkerAlive: vi.fn(() => true),
      };
      const setPauseReason = vi.fn();
      const source = {
        setPauseReason,
        getHealthSnapshot: vi.fn(() => ({
          observerAlive: true,
          recentlyActive: true,
          consecutiveErrors: 0,
          isInBackoff: false,
        })),
      };
      const internals = rm as unknown as {
        state: string;
        hiddenSince: number | null;
        renderer: typeof renderer | null;
        chatSource: typeof source | null;
        standbyController: { pause: () => void; resume: () => void; isStandby: () => boolean };
        startForegroundListeners: () => void;
        stopForegroundListeners: () => void;
        getRuntimeHealthSnapshot: () => { shouldRestart: boolean; isRendererStuck: boolean };
        performOverlayRefresh: (reason: string) => void;
      };
      internals.state = 'active';
      internals.renderer = renderer;
      internals.chatSource = source;
      internals.standbyController = {
        pause: vi.fn(),
        resume: vi.fn(),
        isStandby: () => false,
      };
      vi.spyOn(internals, 'getRuntimeHealthSnapshot').mockReturnValue({
        shouldRestart: false,
        isRendererStuck: false,
      });
      const refresh = vi.spyOn(internals, 'performOverlayRefresh').mockImplementation(() => {});
      const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
      const setVisibility = (value: 'hidden' | 'visible'): void => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value });
        document.dispatchEvent(new Event('visibilitychange'));
      };
      internals.startForegroundListeners();

      return {
        internals,
        renderer,
        setPauseReason,
        refresh,
        setVisibility,
        cleanup: (): void => {
          internals.stopForegroundListeners();
          if (originalVisibility) {
            Object.defineProperty(document, 'visibilityState', originalVisibility);
          } else {
            Reflect.deleteProperty(document, 'visibilityState');
          }
        },
      };
    };

    it.each([
      { duration: 19_999, timeJump: true, refresh: false },
      { duration: 20_000, timeJump: false, refresh: false },
      { duration: 59_999, timeJump: false, refresh: false },
      { duration: 60_000, timeJump: false, refresh: true },
    ])('selects the correct recovery at $duration ms hidden', ({ duration, timeJump, refresh }) => {
      vi.useFakeTimers();
      vi.setSystemTime(100_000);
      const h = makeHarness();
      try {
        h.setVisibility('hidden');
        expect(h.internals.hiddenSince).toBe(100_000);
        expect(h.renderer.pause).toHaveBeenCalledOnce();
        expect(h.setPauseReason).toHaveBeenCalledWith('visibility', true);
        vi.advanceTimersByTime(duration);
        h.setVisibility('visible');
        expect(h.internals.hiddenSince).toBeNull();

        if (refresh) {
          expect(h.refresh).toHaveBeenCalledExactlyOnceWith('hidden-60s');
          expect(h.renderer.drainPendingQueue).not.toHaveBeenCalled();
          expect(h.renderer.resume).not.toHaveBeenCalled();
          expect(h.renderer.clearPausedDuration).not.toHaveBeenCalled();
        } else {
          expect(h.refresh).not.toHaveBeenCalled();
          expect(h.renderer.drainPendingQueue).toHaveBeenCalledOnce();
          expect(h.renderer.resume).toHaveBeenCalledOnce();
          expect(h.renderer.clearPausedDuration).toHaveBeenCalledTimes(timeJump ? 0 : 1);
          expect(h.setPauseReason).toHaveBeenLastCalledWith('visibility', false);
        }
      } finally {
        h.cleanup();
        vi.useRealTimers();
      }
    });

    it('keeps a paused video paused across visibilitychange, pageshow, and resume', () => {
      vi.useFakeTimers();
      vi.setSystemTime(100_000);
      const h = makeHarness(true);
      try {
        h.setVisibility('hidden');
        vi.advanceTimersByTime(60_000);
        h.setVisibility('visible');
        window.dispatchEvent(new Event('pageshow'));
        document.dispatchEvent(new Event('resume'));

        expect(h.renderer.drainPendingQueue).toHaveBeenCalledOnce();
        expect(h.renderer.resume).not.toHaveBeenCalled();
        expect(h.renderer.clearPausedDuration).not.toHaveBeenCalled();
        expect(h.refresh).not.toHaveBeenCalled();
        expect(h.setPauseReason.mock.calls).toEqual([
          ['visibility', true],
          ['visibility', false],
        ]);
      } finally {
        h.cleanup();
        vi.useRealTimers();
      }
    });
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

  it.each(['disabled', 'invalid-page'] as const)(
    'retires a soft-restarting runtime after %s prevents a new session',
    async (stoppedBy) => {
      let enabled = true;
      let valid = true;
      let url = 'https://www.youtube.com/watch?v=video';
      vi.mocked(youtubeApi.bootstrapChatSession).mockClear();
      vi.mocked(youtubeApi.bootstrapChatSession).mockResolvedValueOnce({
        status: 'ready',
        data: {
          videoId: 'video',
          isReplay: true,
          clientContext: {},
          clientNameHeader: 'WEB',
          ytcfg: {},
          initialContinuation: { continuation: 'initial' },
        },
      });
      vi.spyOn(ReplayChatSource.prototype, 'start').mockResolvedValue('started');
      vi.spyOn(RenderWorkerManager.prototype, 'init').mockReturnValue({
        started: false,
        canvasTransferred: false,
      });
      const player = document.createElement('div');
      player.id = 'movie_player';
      player.style.width = '640px';
      player.style.height = '360px';
      Object.defineProperty(player, 'offsetWidth', { configurable: true, value: 640 });
      Object.defineProperty(player, 'offsetHeight', { configurable: true, value: 360 });
      document.body.append(player);

      const rm = new RuntimeManager({
        getCurrentUrl: () => url,
        getSettings: () => makeDefaults({ enabled }),
        isValidPage: () => valid,
      });
      const internals = rm as unknown as {
        overlay: Overlay | null;
        renderer: CanvasRenderer | null;
        targetUrl: string | null;
        messageBus: object | null;
        getRuntimeHealthSnapshot: () => { isRendererStuck: boolean };
        requestManagedRestart: (reason: 'watchdog') => void;
      };
      try {
        await rm.start();
        const bootstrapCountAfterStart = vi.mocked(youtubeApi.bootstrapChatSession).mock.calls
          .length;
        const overlay = internals.overlay;
        const renderer = internals.renderer;
        expect(overlay).toBeInstanceOf(Overlay);
        expect(renderer).toBeInstanceOf(CanvasRenderer);
        if (!overlay || !renderer) throw new Error('Expected started runtime');
        const container = overlay.getContainer();
        expect(container?.isConnected).toBe(true);
        vi.spyOn(renderer, 'isWorkerAlive').mockReturnValue(true);
        vi.spyOn(renderer, 'getQueueLength').mockReturnValue(1);
        vi.spyOn(renderer, 'getActiveMessageCount').mockReturnValue(0);
        vi.spyOn(renderer, 'getMsSinceLastRenderActivity').mockReturnValue(10_000);
        expect(internals.getRuntimeHealthSnapshot().isRendererStuck).toBe(true);

        vi.useFakeTimers();
        if (stoppedBy === 'disabled') {
          enabled = false;
        } else {
          valid = false;
          url = 'https://www.youtube.com/';
        }
        internals.requestManagedRestart('watchdog');
        await vi.advanceTimersByTimeAsync(5_000);
        await rm.reconcileNow(stoppedBy === 'disabled' ? 'settings-change' : 'page-change');

        expect(internals.targetUrl).toBeNull();
        expect(internals.renderer).toBeNull();
        expect(internals.overlay).toBeNull();
        expect(internals.messageBus).toBeNull();
        expect(container?.isConnected).toBe(false);
        await rm.reconcileNow('retry');
        expect(internals.renderer).toBeNull();
        expect(youtubeApi.bootstrapChatSession).toHaveBeenCalledTimes(bootstrapCountAfterStart);
      } finally {
        rm.destroy();
        player.remove();
      }
    }
  );

  it.each(['continue', 'page-change'] as const)(
    'retire and %s after a soft restart with pending backlog',
    async (nextStep) => {
      const bootstrap = {
        status: 'ready' as const,
        data: {
          videoId: 'video',
          isReplay: true,
          clientContext: {},
          clientNameHeader: 'WEB',
          ytcfg: {},
          initialContinuation: { continuation: 'initial' },
        },
      };
      vi.mocked(youtubeApi.bootstrapChatSession).mockClear();
      vi.mocked(youtubeApi.bootstrapChatSession)
        .mockResolvedValueOnce(bootstrap)
        .mockResolvedValueOnce(bootstrap);
      vi.spyOn(ReplayChatSource.prototype, 'start').mockResolvedValue('started');
      vi.spyOn(RenderWorkerManager.prototype, 'init').mockReturnValue({
        started: false,
        canvasTransferred: false,
      });
      const player = document.createElement('div');
      player.id = 'movie_player';
      player.style.width = '640px';
      player.style.height = '360px';
      Object.defineProperty(player, 'offsetWidth', { configurable: true, value: 640 });
      Object.defineProperty(player, 'offsetHeight', { configurable: true, value: 360 });
      document.body.append(player);
      const settings = makeDefaults({ backlogMode: 'full', backlogMaxRate: 0 });
      let url = 'https://www.youtube.com/watch?v=video';
      const rm = new RuntimeManager({
        getCurrentUrl: () => url,
        getSettings: () => settings,
        isValidPage: () => true,
      });
      const internals = rm as unknown as {
        overlay: Overlay | null;
        renderer: CanvasRenderer | null;
        backlogController: {
          startBacklogInjection(messages: ChatMessage[]): void;
          drainPending(): ChatMessage[];
        } | null;
        _pendingBacklogMessages: ChatMessage[];
        ensureBacklogController(renderer: CanvasRenderer): void;
        restartChatSourceSoft(): void;
      };
      try {
        await rm.start();
        const bootstrapCountAfterStart = vi.mocked(youtubeApi.bootstrapChatSession).mock.calls
          .length;
        const firstOverlay = internals.overlay;
        const firstRenderer = internals.renderer;
        if (!firstOverlay || !firstRenderer) throw new Error('Expected started runtime');
        const firstContainer = firstOverlay.getContainer();
        internals.ensureBacklogController(firstRenderer);
        const pending: ChatMessage = {
          id: 'pending-restart',
          text: 'pending',
          content: [{ type: 'text', content: 'pending' }],
          kind: 'text',
          timestamp: Date.now(),
          authorType: 'normal',
        };
        internals.backlogController?.startBacklogInjection([pending]);
        expect(internals.backlogController?.drainPending()).toEqual([pending]);

        internals.restartChatSourceSoft();
        expect(firstContainer?.isConnected).toBe(false);
        expect(internals.renderer).toBeNull();
        expect(internals._pendingBacklogMessages).toEqual([pending]);
        if (nextStep === 'page-change') {
          url = 'https://www.youtube.com/watch?v=other';
          await rm.reconcileNow('page-change');
          expect(internals.renderer).toBeNull();
          expect(internals.overlay).toBeNull();
          expect(internals._pendingBacklogMessages).toEqual([]);
          expect(youtubeApi.bootstrapChatSession).toHaveBeenCalledTimes(bootstrapCountAfterStart);
          return;
        }
        await rm.reconcileNow('session-restart');

        expect(internals.renderer).toBeInstanceOf(CanvasRenderer);
        expect(internals.renderer).not.toBe(firstRenderer);
        expect(internals.overlay).not.toBe(firstOverlay);
        expect(internals.backlogController?.drainPending()).toEqual([pending]);
        expect(internals._pendingBacklogMessages).toEqual([]);
      } finally {
        rm.destroy();
        player.remove();
      }
    }
  );

  it('keeps the reenabled renderer after a disabled same-URL page change', async () => {
    let enabled = true;
    const bootstrap = {
      status: 'ready' as const,
      data: {
        videoId: 'video',
        isReplay: true,
        clientContext: {},
        clientNameHeader: 'WEB',
        ytcfg: {},
        initialContinuation: { continuation: 'initial' },
      },
    };
    vi.mocked(youtubeApi.bootstrapChatSession)
      .mockResolvedValueOnce(bootstrap)
      .mockResolvedValueOnce(bootstrap);
    vi.spyOn(ReplayChatSource.prototype, 'start').mockResolvedValue('started');
    vi.spyOn(RenderWorkerManager.prototype, 'init').mockReturnValue({
      started: false,
      canvasTransferred: false,
    });
    const player = document.createElement('div');
    player.id = 'movie_player';
    player.style.width = '640px';
    player.style.height = '360px';
    Object.defineProperty(player, 'offsetWidth', { configurable: true, value: 640 });
    Object.defineProperty(player, 'offsetHeight', { configurable: true, value: 360 });
    document.body.append(player);
    const rm = new RuntimeManager({
      getCurrentUrl: () => 'https://www.youtube.com/watch?v=video',
      getSettings: () => makeDefaults({ enabled }),
      isValidPage: () => true,
    });
    const internals = rm as unknown as {
      overlay: Overlay | null;
      renderer: CanvasRenderer | null;
      forceNewSession: boolean;
    };
    try {
      await rm.start();
      const original = internals.renderer;
      expect(original).toBeInstanceOf(CanvasRenderer);
      vi.useFakeTimers();
      enabled = false;
      await rm.reconcileNow('page-change');
      expect(internals.renderer).toBeNull();
      expect(internals.overlay).toBeNull();

      enabled = true;
      await rm.reconcileNow('settings-change');
      vi.setSystemTime(Date.now() + 2_000);
      await rm.reconcileNow('retry');
      const reenabled = internals.renderer;
      expect(reenabled).toBeInstanceOf(CanvasRenderer);
      expect(reenabled).not.toBe(original);
      const bootstrapCalls = vi.mocked(youtubeApi.bootstrapChatSession).mock.calls.length;

      await rm.reconcileNow('settings-change');
      expect(internals.renderer).toBe(reenabled);
      expect(youtubeApi.bootstrapChatSession).toHaveBeenCalledTimes(bootstrapCalls);
    } finally {
      rm.destroy();
      player.remove();
    }
  });
});
