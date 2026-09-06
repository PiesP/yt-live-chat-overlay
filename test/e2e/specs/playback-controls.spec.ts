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

const installPlaybackMock = (options: { forceMainThread: boolean }): void => {
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
    currentVideoEndpoint: { watchEndpoint: { videoId: 'dQw4w9WgXcQ' } },
    contents: {
      twoColumnWatchNextResults: {
        conversationBar: {
          liveChatRenderer: {
            isReplay: true,
            continuations: [
              { playerSeekContinuationData: { continuation: 'initial-replay' } },
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
});
