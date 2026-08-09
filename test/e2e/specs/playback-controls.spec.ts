// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import {
  DEFAULT_SETTINGS,
  injectUserscript,
  MOCK_WATCH_URL,
  OVERLAY_ID,
  setupMockPageRoute,
  USERSCRIPT_PATH,
  installYTMock,
} from '../fixtures/test-utils';

const installPlaybackMock = (): void => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
    configurable: true,
    value: () => {
      throw new Error('Force deterministic main-thread rendering for playback assertions');
    },
  });
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

test.describe('Playback controls', () => {
  test.beforeAll(() => {
    if (!existsSync(USERSCRIPT_PATH)) {
      throw new Error(
        `Userscript bundle not found at ${USERSCRIPT_PATH}. Run 'pnpm build:dev' first.`
      );
    }
  });

  test('keeps replay delivery consistent across pause, forward seek, and backward seek', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    const requestedOffsets: number[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await setupMockPageRoute(page);
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
              continuations: [
                { playerSeekContinuationData: { continuation: 'player-seek' } },
              ],
            },
          },
        },
      });
    });
    await page.addInitScript(installPlaybackMock);
    const mockInit = {
      defaults: {
        ...DEFAULT_SETTINGS,
        allowShortTextMessages: true,
        showDebugOverlay: true,
      },
      platform: 'userscript' as const,
    };
    await page.addInitScript(installYTMock, mockInit);
    await injectUserscript(page);
    await page.goto(MOCK_WATCH_URL, { waitUntil: 'domcontentloaded' });
    await page.locator(`#${OVERLAY_ID}`).waitFor({ state: 'attached' });
    await page.waitForFunction(() => {
      const handle = (window as unknown as Record<string, unknown>).__ytChatOverlay;
      return typeof handle === 'object' && handle !== null;
    });

    await page.evaluate(() => {
      const setPlaybackState = (window as unknown as Record<string, unknown>)
        .__setPlaybackState as (currentTime: number, paused: boolean) => void;
      setPlaybackState(0, false);
    });

    const counters = page.locator('#yt-chat-overlay-debug > div').first();
    await expect(counters).toHaveText(/^Rcvd: 1 \| Rndr: \d+$/);

    await page.waitForTimeout(1200);
    expect(requestedOffsets.filter((offset) => offset === 0)).toHaveLength(1);

    await page.evaluate(() => {
      const setPlaybackState = (window as unknown as Record<string, unknown>)
        .__setPlaybackState as (currentTime: number, paused: boolean) => void;
      setPlaybackState(0, true);
    });
    await page.waitForTimeout(100);
    await expect(counters).toHaveText(/^Rcvd: 1 \| Rndr: \d+$/);

    await page.evaluate(() => {
      const setPlaybackState = (window as unknown as Record<string, unknown>)
        .__setPlaybackState as (currentTime: number, paused: boolean) => void;
      setPlaybackState(10, false);
      document.querySelector('video')?.dispatchEvent(new Event('seeked'));
    });
    await expect(counters).toHaveText(/^Rcvd: 2 \| Rndr: \d+$/);

    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (!(video instanceof HTMLVideoElement)) throw new Error('Mock video is missing');
      video.currentTime = 0;
      video.dispatchEvent(new Event('seeked'));
    });
    await expect(counters).toHaveText(/^Rcvd: 3 \| Rndr: \d+$/);

    expect(pageErrors).toEqual([]);
  });
});
