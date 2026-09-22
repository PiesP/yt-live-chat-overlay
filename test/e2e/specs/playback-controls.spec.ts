// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_SETTINGS,
  injectUserscript,
  MOCK_WATCH_URL,
  OVERLAY_ID,
  setupMockPageRoute,
  USERSCRIPT_PATH,
  installYTMock,
} from '../fixtures/test-utils';
import {
  installPlaybackWorkerObserver,
  PLAYBACK_WORKER_URL,
  type PlaybackWorkerTelemetry,
  routePlaybackWorker,
} from '../fixtures/playback-worker';

const installPlaybackMock = (options: {
  forceMainThread: boolean;
  chatMode?: 'live' | 'replay';
  videoId?: string;
}): void => {
  const { chatMode = 'replay', videoId = 'dQw4w9WgXcQ' } = options;
  if (options.forceMainThread) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
      configurable: true,
      value: () => {
        throw new Error('Force deterministic main-thread rendering for playback assertions');
      },
    });
  }
  const state = new WeakMap<HTMLMediaElement, { currentTime: number; paused: boolean }>();
  const getState = (media: HTMLMediaElement): { currentTime: number; paused: boolean } => {
    let current = state.get(media);
    if (!current) {
      current = { currentTime: 0, paused: false };
      state.set(media, current);
    }
    return current;
  };

  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get() {
      return getState(this).currentTime;
    },
    set(value: number) {
      getState(this).currentTime = value;
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get() {
      return getState(this).paused;
    },
  });

  const global = window as unknown as Record<string, unknown>;
  global.__setPlaybackState = (currentTime: number, paused: boolean): void => {
    const video = document.querySelector('video');
    if (!(video instanceof HTMLVideoElement)) throw new Error('Mock video is missing');
    const current = getState(video);
    current.currentTime = currentTime;
    current.paused = paused;
    video.dispatchEvent(new Event(paused ? 'pause' : 'play'));
  };
  global.ytcfg = {
    data_: {
      INNERTUBE_API_KEY: 'e2e-key',
      INNERTUBE_CONTEXT_CLIENT_NAME: '1',
      INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
      INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
    },
  };
  global.ytInitialData = {
    currentVideoEndpoint: { watchEndpoint: { videoId } },
    contents: {
      twoColumnWatchNextResults: {
        conversationBar: {
          liveChatRenderer: {
            isReplay: chatMode === 'replay',
            continuations: [
              chatMode === 'replay'
                ? { playerSeekContinuationData: { continuation: 'initial-replay' } }
                : {
                    timedContinuationData: {
                      continuation: `initial-live-${videoId}`,
                      timeoutMs: 30_000,
                    },
                  },
            ],
          },
        },
      },
    },
  };
};

const replayAction = (offsetMs: number, id: string, text: string): unknown => ({
  replayChatItemAction: {
    videoOffsetTimeMsec: offsetMs,
    actions: [
      {
        addChatItemAction: {
          item: {
            liveChatTextMessageRenderer: {
              id,
              authorName: { simpleText: 'Playback E2E' },
              message: { runs: [{ text }] },
            },
          },
        },
      },
    ],
  },
});

const liveAction = (id: string, text: string): unknown => ({
  addChatItemAction: {
    item: {
      liveChatTextMessageRenderer: {
        id,
        authorName: { simpleText: `Author ${id}` },
        message: { runs: [{ text }] },
      },
    },
  },
});

const liveResponse = (actions: unknown[]): unknown => ({
  continuationContents: {
    liveChatContinuation: {
      actions,
      continuations: [
        {
          timedContinuationData: {
            continuation: 'sustained-live-next',
            timeoutMs: 30_000,
          },
        },
      ],
    },
  },
});

async function runReplayScenario(page: Page, renderPath: 'main' | 'worker'): Promise<void> {
  const useWorker = renderPath === 'worker';
  const pageErrors: string[] = [];
  const requestedOffsets: number[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await setupMockPageRoute(page);
  if (useWorker) {
    await routePlaybackWorker(page);
  }
  await page.route('**/youtubei/v1/live_chat/get_live_chat_replay**', async (route) => {
    const body = route.request().postDataJSON() as {
      continuation?: string;
      currentPlayerState?: { playerOffsetMs?: string };
    };
    const rawOffset = body.currentPlayerState?.playerOffsetMs;
    const offsetMs = rawOffset === undefined ? undefined : Number(rawOffset);
    if (offsetMs !== undefined) requestedOffsets.push(offsetMs);

    const actions =
      offsetMs === undefined
        ? []
        : offsetMs >= 5000
          ? [replayAction(10_000, 'replay-later', 'message at ten seconds')]
          : [replayAction(0, 'replay-start', 'message at zero seconds')];
    await route.fulfill({
      json: {
        continuationContents: {
          liveChatContinuation: {
            actions,
            continuations: [{ playerSeekContinuationData: { continuation: 'player-seek' } }],
          },
        },
      },
    });
  });
  if (useWorker) {
    await page.addInitScript(installPlaybackWorkerObserver, PLAYBACK_WORKER_URL);
  }
  await page.addInitScript(installPlaybackMock, { forceMainThread: !useWorker });
  await page.addInitScript(installYTMock, {
    defaults: {
      ...DEFAULT_SETTINGS,
      allowShortTextMessages: true,
      showDebugOverlay: true,
    },
    platform: 'userscript' as const,
  });
  await injectUserscript(page);
  await page.goto(MOCK_WATCH_URL, { waitUntil: 'domcontentloaded' });
  await page.locator(`#${OVERLAY_ID}`).waitFor({ state: 'attached' });
  await page.waitForFunction(() => {
    const handle = (window as unknown as Record<string, unknown>).__ytChatOverlay;
    return typeof handle === 'object' && handle !== null;
  });

  const readWorkerTelemetry = (): Promise<PlaybackWorkerTelemetry> =>
    page.evaluate(() => {
      const telemetry = (window as unknown as Record<string, unknown>).__playbackWorkerTelemetry;
      return structuredClone(telemetry) as PlaybackWorkerTelemetry;
    });
  const latestWorkerMessageIds = async (): Promise<string[]> => {
    const telemetry = await readWorkerTelemetry();
    const latest = telemetry.stats.at(-1);
    if (!latest) return [];
    return [...latest.activeMessageIds, ...latest.pendingMessageIds];
  };
  const addedWorkerMessageIds = async (): Promise<string[]> => {
    const telemetry = await readWorkerTelemetry();
    return telemetry.addedMessageIds.flat();
  };

  if (useWorker) {
    await expect
      .poll(async () => {
        const telemetry = await readWorkerTelemetry();
        return {
          constructed: telemetry.constructed,
          ready: telemetry.ready,
          initTransferredOffscreenCanvas: telemetry.initTransferredOffscreenCanvas,
        };
      })
      .toEqual({ constructed: 1, ready: 1, initTransferredOffscreenCanvas: true });
  }

  await page.evaluate(() => {
    const setPlaybackState = (window as unknown as Record<string, unknown>)
      .__setPlaybackState as (currentTime: number, paused: boolean) => void;
    setPlaybackState(0, false);
  });

  const counters = page.locator('#yt-chat-overlay-debug > div').first();
  if (useWorker) {
    await expect.poll(addedWorkerMessageIds).toEqual(['replay-start']);
    await expect.poll(latestWorkerMessageIds).toEqual(['replay-start']);
    await expect(counters).toHaveText('Rcvd: 1 | Rndr: 1');
    await expect(page.locator('#yt-chat-overlay-debug > div').nth(5)).toHaveText(
      'Render: n/a | Drain: n/a',
    );
  } else {
    await expect(counters).toHaveText(/^Rcvd: 1 \| Rndr: \d+$/);
  }

  await page.waitForTimeout(1200);
  expect(requestedOffsets.filter((offset) => offset === 0)).toHaveLength(1);

  await page.evaluate(() => {
    const setPlaybackState = (window as unknown as Record<string, unknown>)
      .__setPlaybackState as (currentTime: number, paused: boolean) => void;
    setPlaybackState(0, true);
  });
  await page.waitForTimeout(100);
  if (useWorker) {
    await expect.poll(async () => (await readWorkerTelemetry()).pausedStates).toEqual([true]);
    await expect.poll(addedWorkerMessageIds).toEqual(['replay-start']);
    await expect(counters).toHaveText('Rcvd: 1 | Rndr: 1');
  } else {
    await expect(counters).toHaveText(/^Rcvd: 1 \| Rndr: \d+$/);
  }

  await page.evaluate(() => {
    const setPlaybackState = (window as unknown as Record<string, unknown>)
      .__setPlaybackState as (currentTime: number, paused: boolean) => void;
    setPlaybackState(10, false);
    document.querySelector('video')?.dispatchEvent(new Event('seeked'));
  });
  if (useWorker) {
    await expect.poll(addedWorkerMessageIds).toEqual(['replay-start', 'replay-later']);
    await expect.poll(latestWorkerMessageIds).toEqual(['replay-later']);
    await expect(counters).toHaveText('Rcvd: 2 | Rndr: 2');
  } else {
    await expect(counters).toHaveText(/^Rcvd: 2 \| Rndr: \d+$/);
  }

  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (!(video instanceof HTMLVideoElement)) throw new Error('Mock video is missing');
    video.currentTime = 0;
    video.dispatchEvent(new Event('seeked'));
  });
  if (useWorker) {
    await expect
      .poll(addedWorkerMessageIds)
      .toEqual(['replay-start', 'replay-later', 'replay-start']);
    await expect.poll(latestWorkerMessageIds).toEqual(['replay-start']);
    await expect(counters).toHaveText('Rcvd: 3 | Rndr: 3');

    const telemetryBeforeDestroy = await readWorkerTelemetry();
    expect(telemetryBeforeDestroy.pausedStates).toEqual([true, false]);
    expect(telemetryBeforeDestroy.sentTypes.filter((type) => type === 'clearState')).toHaveLength(2);

    await page.evaluate(async () => {
      const handle = (window as unknown as Record<string, unknown>).__ytChatOverlay as
        | { stop?: () => Promise<void> }
        | undefined;
      await handle?.stop?.();
    });
    await expect
      .poll(async () => {
        const telemetry = await readWorkerTelemetry();
        return {
          acknowledgements: telemetry.acknowledgements,
          terminated: telemetry.terminated,
        };
      })
      .toEqual({ acknowledgements: 1, terminated: 1 });
    await expect(page.locator(`#${OVERLAY_ID}`)).toHaveCount(0);
  } else {
    await expect(counters).toHaveText(/^Rcvd: 3 \| Rndr: \d+$/);
  }

  expect(pageErrors).toEqual([]);
}

async function runSustainedViewingScenario(
  page: Page,
  renderPath: 'main' | 'worker',
): Promise<void> {
  const useWorker = renderPath === 'worker';
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const runtimeEvents: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error') consoleErrors.push(text);
    if (text.includes('[RuntimeManager] runtime.session.')) runtimeEvents.push(text);
  });

  const phaseActions = new Map<string, unknown[]>([
    ['low-1', [liveAction('sustained-low-1', 'low rate one')]],
    ['low-2', [liveAction('sustained-low-2', 'low rate two')]],
    [
      'burst',
      Array.from({ length: 8 }, (_, index) =>
        liveAction(`sustained-burst-${index + 1}`, `burst message ${index + 1}`),
      ),
    ],
    [
      'paused',
      [
        liveAction('sustained-paused-1', 'arrived while paused one'),
        liveAction('sustained-paused-2', 'arrived while paused two'),
      ],
    ],
    ['hidden', [liveAction('sustained-hidden', 'suppressed while hidden')]],
    ['visible', [liveAction('sustained-visible', 'delivered after foreground return')]],
    ['second-video', [liveAction('sustained-second-video', 'new video session')]],
  ]);

  await setupMockPageRoute(page);
  if (useWorker) {
    await routePlaybackWorker(page);
  }
  await page.route('**/youtubei/v1/live_chat/get_live_chat**', async (route) => {
    const url = new URL(route.request().url());
    const actions = phaseActions.get(url.searchParams.get('phase') ?? '') ?? [];
    await route.fulfill({ json: liveResponse(actions) });
  });
  if (useWorker) {
    await page.addInitScript(installPlaybackWorkerObserver, PLAYBACK_WORKER_URL);
  }
  await page.addInitScript(installPlaybackMock, {
    forceMainThread: !useWorker,
    chatMode: 'live' as const,
    videoId: 'sustained-first-video',
  });
  await page.addInitScript(() => {
    const global = window as unknown as Record<string, unknown>;
    global.__sustainedInterceptorBatches = 0;
    const nativeDebug = console.debug.bind(console);
    console.debug = (...args: unknown[]): void => {
      if (
        args[0] === '[FetchInterceptor]' &&
        args[1] === 'chat.interceptor.messages-received'
      ) {
        global.__sustainedInterceptorBatches =
          Number(global.__sustainedInterceptorBatches ?? 0) + 1;
      }
      nativeDebug(...args);
    };
  });
  await page.addInitScript(installYTMock, {
    defaults: {
      ...DEFAULT_SETTINGS,
      allowShortTextMessages: true,
      authorRateLimit: 'off',
      burstSampleWindow: 3,
      burstElevatedThreshold: 2,
      burstHighThreshold: 5,
      burstExtremeThreshold: 10,
      logLevel: 'debug',
      showDebugOverlay: true,
    },
    platform: 'userscript' as const,
  });
  await injectUserscript(page);
  await page.goto('https://www.youtube.com/watch?v=sustained-first-video', {
    waitUntil: 'domcontentloaded',
  });
  await page.locator(`#${OVERLAY_ID}`).waitFor({ state: 'attached' });
  await page.waitForFunction(() => {
    const handle = (window as unknown as Record<string, unknown>).__ytChatOverlay;
    return typeof handle === 'object' && handle !== null;
  });

  const readWorkerTelemetry = (): Promise<PlaybackWorkerTelemetry> =>
    page.evaluate(() => {
      const telemetry = (window as unknown as Record<string, unknown>).__playbackWorkerTelemetry;
      return structuredClone(telemetry) as PlaybackWorkerTelemetry;
    });
  const addedWorkerMessageIds = async (): Promise<string[]> => {
    const telemetry = await readWorkerTelemetry();
    return telemetry.addedMessageIds.flat();
  };
  const readAccessibleMessageIds = (): Promise<Array<string | null>> =>
    page
      .locator(`#${OVERLAY_ID} .yt-live-chat-overlay-live-region > p`)
      .evaluateAll((elements) => elements.map((element) => element.dataset.messageId ?? null));
  const expectAccessibleMessageSet = async (
    expectedIds: string[],
    phaseIds: string[] = expectedIds,
  ): Promise<void> => {
    const expected = {
      length: expectedIds.length,
      sortedIds: expectedIds.toSorted(),
      uniqueCount: expectedIds.length,
    };
    await expect
      .poll(async () => {
        const ids = await readAccessibleMessageIds();
        return {
          length: ids.length,
          sortedIds: ids.toSorted(),
          uniqueCount: new Set(ids).size,
        };
      })
      .toEqual(expected);
    const actualIds = await readAccessibleMessageIds();
    for (const id of phaseIds) expect(actualIds).toContain(id);
  };
  const requestPhase = async (phase: string): Promise<void> => {
    const previousBatches = await page.evaluate(() =>
      Number(
        (window as unknown as Record<string, unknown>).__sustainedInterceptorBatches ?? 0,
      ),
    );
    await page.evaluate(async (name) => {
      const response = await fetch(
        `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?phase=${name}`,
      );
      await response.json();
    }, phase);
    await page.waitForFunction(
      (previous) =>
        Number(
          (window as unknown as Record<string, unknown>).__sustainedInterceptorBatches ?? 0,
        ) > previous,
      previousBatches,
    );
  };
  const setPlaybackState = async (currentTime: number, paused: boolean): Promise<void> => {
    await page.evaluate(
      ({ time, isPaused }) => {
        const setter = (window as unknown as Record<string, unknown>).__setPlaybackState as (
          currentTime: number,
          paused: boolean,
        ) => void;
        setter(time, isPaused);
      },
      { time: currentTime, isPaused: paused },
    );
  };
  const setVisibility = async (visibility: 'hidden' | 'visible'): Promise<void> => {
    await page.evaluate((state) => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: state,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    }, visibility);
  };

  if (useWorker) {
    await expect
      .poll(async () => {
        const telemetry = await readWorkerTelemetry();
        return {
          constructed: telemetry.constructed,
          ready: telemetry.ready,
          initTransferredOffscreenCanvas: telemetry.initTransferredOffscreenCanvas,
        };
      })
      .toEqual({ constructed: 1, ready: 1, initTransferredOffscreenCanvas: true });
  }

  const lowRateIds = ['sustained-low-1', 'sustained-low-2'];
  await requestPhase('low-1');
  if (useWorker) {
    await expect.poll(addedWorkerMessageIds).toEqual(lowRateIds.slice(0, 1));
  }
  await expectAccessibleMessageSet(lowRateIds.slice(0, 1));
  await page.waitForTimeout(600);
  await requestPhase('low-2');
  if (useWorker) {
    await expect.poll(addedWorkerMessageIds).toEqual(lowRateIds);
  }
  await expectAccessibleMessageSet(lowRateIds, lowRateIds.slice(1));
  await expect(page.locator('#yt-chat-overlay-debug > div').nth(2)).toContainText('Burst: normal');

  const burstIds = Array.from({ length: 8 }, (_, index) => `sustained-burst-${index + 1}`);
  const initialIds = [...lowRateIds, ...burstIds];
  await requestPhase('burst');
  await expect
    .poll(async () => (await page.locator('#yt-chat-overlay-debug > div').nth(2).textContent()) ?? '')
    .toMatch(/Burst: (?:elevated|high|extreme)$/u);
  if (useWorker) {
    await expect.poll(addedWorkerMessageIds).toEqual(initialIds);
  }
  await expectAccessibleMessageSet(initialIds, burstIds);

  await setPlaybackState(12, true);
  if (useWorker) {
    await expect.poll(async () => (await readWorkerTelemetry()).pausedStates).toEqual([true]);
  }
  await requestPhase('paused');
  const debugCounters = page.locator('#yt-chat-overlay-debug > div').first();
  const debugDrops = page.locator('#yt-chat-overlay-debug > div').nth(1);
  if (useWorker) {
    await expect.poll(addedWorkerMessageIds).toEqual(initialIds);
  }
  await expectAccessibleMessageSet(initialIds);

  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (!(video instanceof HTMLVideoElement)) throw new Error('Mock video is missing');
    video.currentTime = 30;
    video.dispatchEvent(new Event('seeked'));
  });
  await expectAccessibleMessageSet(initialIds);

  const pausedIds = ['sustained-paused-1', 'sustained-paused-2'];
  const resumedIds = [...initialIds, ...pausedIds];
  await setPlaybackState(30, false);
  if (useWorker) {
    await expect.poll(addedWorkerMessageIds).toEqual(resumedIds);
  }
  await expectAccessibleMessageSet(resumedIds, pausedIds);
  await expect(debugCounters).toHaveText(/^Rcvd: 12 \| Rndr: \d+$/u);
  await expect(debugDrops).toHaveText(/^Drop: 2 /u);
  if (useWorker) {
    await expect.poll(async () => (await readWorkerTelemetry()).pausedStates).toEqual([true, false]);
    await expect
      .poll(async () => (await readWorkerTelemetry()).stats.at(-1)?.totalDrops)
      .toBe(0);
  }

  await setVisibility('hidden');
  await requestPhase('hidden');
  await expect(debugCounters).toHaveText(/^Rcvd: 12 \| Rndr: \d+$/u);
  await expect(debugDrops).toHaveText(/^Drop: 2 /u);
  if (useWorker) {
    await expect.poll(addedWorkerMessageIds).toEqual(resumedIds);
  }
  await expectAccessibleMessageSet(resumedIds);
  await setVisibility('visible');
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
  });
  await requestPhase('visible');
  const foregroundIds = [...resumedIds, 'sustained-visible'];
  if (useWorker) {
    await expect.poll(addedWorkerMessageIds).toEqual(foregroundIds);
  }
  await expectAccessibleMessageSet(foregroundIds, ['sustained-visible']);
  await expect(debugCounters).toHaveText(/^Rcvd: 13 \| Rndr: \d+$/u);
  await expect(debugDrops).toHaveText(/^Drop: 2 /u);
  if (useWorker) {
    await expect
      .poll(async () => (await readWorkerTelemetry()).pausedStates)
      .toEqual([true, false, true, false]);
  }

  await page.evaluate(() => {
    const canvas = document.querySelector('#yt-live-chat-overlay canvas');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Old overlay canvas is missing');
    (window as unknown as Record<string, unknown>).__sustainedOldCanvas = canvas;
    const initialData = (window as unknown as Record<string, unknown>).ytInitialData as {
      currentVideoEndpoint: { watchEndpoint: { videoId: string } };
    };
    initialData.currentVideoEndpoint.watchEndpoint.videoId = 'sustained-second-video';
    history.pushState({}, '', '/watch?v=sustained-second-video');
    window.dispatchEvent(new Event('yt-navigate-finish'));
  });
  await page.waitForFunction(() => {
    const oldCanvas = (window as unknown as Record<string, unknown>).__sustainedOldCanvas;
    const currentCanvas = document.querySelector('#yt-live-chat-overlay canvas');
    return (
      oldCanvas instanceof HTMLCanvasElement &&
      !oldCanvas.isConnected &&
      currentCanvas instanceof HTMLCanvasElement &&
      currentCanvas !== oldCanvas
    );
  });
  await expect
    .poll(() => runtimeEvents.filter((event) => event.includes('runtime.session.disposed')).length)
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => runtimeEvents.filter((event) => event.includes('runtime.session.started')).length)
    .toBeGreaterThanOrEqual(2);
  if (useWorker) {
    await expect
      .poll(async () => {
        const telemetry = await readWorkerTelemetry();
        return {
          acknowledgements: telemetry.acknowledgements,
          constructed: telemetry.constructed,
          ready: telemetry.ready,
          terminated: telemetry.terminated,
        };
      })
      .toEqual({ acknowledgements: 1, constructed: 2, ready: 2, terminated: 1 });
  }

  await requestPhase('second-video');
  if (useWorker) {
    await expect.poll(addedWorkerMessageIds).toEqual([...foregroundIds, 'sustained-second-video']);
  }
  await expectAccessibleMessageSet(['sustained-second-video']);
  const secondSessionCounters = page.locator('#yt-chat-overlay-debug > div').first();
  await expect(secondSessionCounters).toHaveText(/^Rcvd: 1 \| Rndr: \d+$/u);
  await expect(page.locator('#yt-chat-overlay-debug > div').nth(1)).toHaveText(/^Drop: 0 /u);

  await page.evaluate(async () => {
    const handle = (window as unknown as Record<string, unknown>).__ytChatOverlay as
      | { stop?: () => Promise<void> }
      | undefined;
    await handle?.stop?.();
  });
  await expect(page.locator(`#${OVERLAY_ID}`)).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const oldCanvas = (window as unknown as Record<string, unknown>).__sustainedOldCanvas;
        return oldCanvas instanceof HTMLCanvasElement && !oldCanvas.isConnected;
      }),
    )
    .toBe(true);
  if (useWorker) {
    await expect
      .poll(async () => {
        const telemetry = await readWorkerTelemetry();
        return {
          acknowledgements: telemetry.acknowledgements,
          terminated: telemetry.terminated,
        };
      })
      .toEqual({ acknowledgements: 2, terminated: 2 });
  }
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
}

test.describe('Playback controls', () => {
  test.beforeAll(() => {
    if (!existsSync(USERSCRIPT_PATH)) {
      throw new Error(
        `Userscript bundle not found at ${USERSCRIPT_PATH}. Run 'pnpm build:dev' first.`
      );
    }
    const workerPath = resolve(process.cwd(), 'dist-extension/workers/renderer.js');
    if (!existsSync(workerPath)) {
      throw new Error(
        `Extension renderer worker not found at ${workerPath}. Run 'pnpm build:extension' first.`,
      );
    }
  });

  test('keeps main-thread replay delivery consistent across pause and seeks', async ({ page }) => {
    await runReplayScenario(page, 'main');
  });

  test('keeps Worker replay delivery consistent across pause, seeks, and teardown', async ({
    page,
  }) => {
    await runReplayScenario(page, 'worker');
  });

  for (const renderer of ['main', 'worker'] as const) {
    test(`preserves a sustained viewing session across playback and SPA transitions with ${renderer} rendering`, async ({
      page,
    }) => {
      await runSustainedViewingScenario(page, renderer);
    });
  }

  for (const renderer of ['main', 'worker'] as const) {
    test(`flushes buffered replay during delayed network I/O with ${renderer} rendering`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await setupMockPageRoute(page);
      if (renderer === 'worker') {
        await routePlaybackWorker(page);
        await page.addInitScript(installPlaybackWorkerObserver, PLAYBACK_WORKER_URL);
      }
      let releaseRequest: (() => void) | undefined;
      const heldResponse = new Promise<void>((resolve) => {
        releaseRequest = resolve;
      });
      let requestWaiting = false;
      let responseReleased = false;
      await page.route('**/youtubei/v1/live_chat/get_live_chat_replay**', async (route) => {
        const body = route.request().postDataJSON() as {
          currentPlayerState?: { playerOffsetMs?: string };
        };
        const offsetMs = Number(body.currentPlayerState?.playerOffsetMs ?? 0);
        if (offsetMs >= 3000) {
          requestWaiting = true;
          await heldResponse;
        }
        await route.fulfill({
          json: {
            continuationContents: {
              liveChatContinuation: {
                actions: [
                  replayAction(0, 'delay-start', 'initial buffered message'),
                  replayAction(8000, 'delay-future', 'buffered message independent of network'),
                ],
                continuations: [
                  { playerSeekContinuationData: { continuation: 'delayed-player-seek' } },
                ],
              },
            },
          },
        });
      });
      await page.addInitScript(installPlaybackMock, { forceMainThread: renderer === 'main' });
      await page.addInitScript(installYTMock, {
        defaults: { ...DEFAULT_SETTINGS, allowShortTextMessages: true, showDebugOverlay: true },
        platform: 'userscript' as const,
      });
      await injectUserscript(page);
      try {
        await page.goto(MOCK_WATCH_URL, { waitUntil: 'domcontentloaded' });
        await page.locator(`#${OVERLAY_ID}`).waitFor({ state: 'attached' });
        await page.evaluate(() => {
          document.querySelector('video')?.dispatchEvent(new Event('play'));
        });
        const messages = page.locator('.yt-live-chat-overlay-live-region');
        const counters = page.locator('#yt-chat-overlay-debug > div').first();
        await expect(counters).toHaveText(/^Rcvd: 1 \| Rndr: \d+$/);
        await page.evaluate(() => {
          const video = document.querySelector('video');
          if (!video) throw new Error('Fixture video missing');
          video.currentTime = 3;
        });
        await expect.poll(() => requestWaiting).toBe(true);
        await page.evaluate(() => {
          const video = document.querySelector('video');
          if (!video) throw new Error('Fixture video missing');
          video.currentTime = 8;
        });
        if (renderer === 'worker') {
          await expect
            .poll(() => page.evaluate(() => {
              const telemetry = (window as unknown as Record<string, unknown>)
                .__playbackWorkerTelemetry as PlaybackWorkerTelemetry;
              return telemetry.stats.at(-1)?.activeMessageIds ?? [];
            }), { timeout: 3000 })
            .toContain('delay-future');
        } else {
          await expect(messages).toContainText('buffered message independent of network', {
            timeout: 3000,
          });
        }
        expect(responseReleased).toBe(false);
        expect(errors).toEqual([]);
      } finally {
        responseReleased = true;
        releaseRequest?.();
        await page.unrouteAll({ behavior: 'wait' });
      }
    });
  }
});
