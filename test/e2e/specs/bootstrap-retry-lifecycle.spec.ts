// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, test, type Page } from '@playwright/test';
import {
  DEFAULT_SETTINGS,
  injectUserscript,
  installYTMock,
  MOCK_WATCH_URL,
  OVERLAY_ID,
  setupMockPageRoute,
} from '../fixtures/test-utils';

const INITIAL_VIDEO_ID: string = new URL(MOCK_WATCH_URL).searchParams.get('v') ?? '';
if (!INITIAL_VIDEO_ID) throw new Error('Missing video ID in mock watch URL');

const NEXT_VIDEO_ID = 'bootstrap-video-b';
const SHORT_TEST_TIMEOUT_MS = 500;
const TERMINATION_PENDING_TIMEOUT_MS = 10_000;
const STOP_SETTLE_MS = 2_500;

interface BootstrapProbe {
  timeoutRequests: number[];
  watchRequests: Record<string, number>;
  pendingWatchBodies: string[];
  aborts: Array<{ videoId: string; reason: string }>;
  abortedLiveContinuations: string[];
  lateWatchResponsesReleased: string[];
  liveContinuations: string[];
  runtimeStartedVideoIds: string[];
}

declare global {
  interface Window {
    __ytBootstrapProbe?: BootstrapProbe;
    __ytReleasePendingWatchHtml?: (videoId: string) => boolean;
  }
}

type ProbeScenario =
  | 'retry-recovers'
  | 'navigation-cancels-retry'
  | 'termination-cancels-retry';

function installBootstrapProbe(options: {
  scenario: ProbeScenario;
  initialVideoId: string;
  nextVideoId: string;
  shortTimeoutMs: number;
}): void {
  const { scenario, initialVideoId, nextVideoId, shortTimeoutMs } = options;
  const buildWatchHtml = (videoId: string): string => {
    const ytcfg = {
      INNERTUBE_API_KEY: `key-${videoId}`,
      INNERTUBE_CONTEXT_CLIENT_NAME: '1',
      INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
      INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
    };
    const initialData = {
      currentVideoEndpoint: { watchEndpoint: { videoId } },
      contents: {
        twoColumnWatchNextResults: {
          conversationBar: {
            liveChatRenderer: {
              continuations: [{ reloadContinuationData: { continuation: `continue-${videoId}` } }],
            },
          },
        },
      },
    };
    return `ytcfg.set(${JSON.stringify(ytcfg)});var ytInitialData = ${JSON.stringify(initialData)};`;
  };
  const probe: BootstrapProbe = {
    timeoutRequests: [],
    watchRequests: {},
    pendingWatchBodies: [],
    aborts: [],
    abortedLiveContinuations: [],
    lateWatchResponsesReleased: [],
    liveContinuations: [],
    runtimeStartedVideoIds: [],
  };
  Object.defineProperty(window, '__ytBootstrapProbe', {
    configurable: true,
    value: probe,
  });
  const pendingWatchReleases = new Map<string, () => void>();
  window.__ytReleasePendingWatchHtml = (videoId) => {
    const release = pendingWatchReleases.get(videoId);
    if (!release) return false;
    pendingWatchReleases.delete(videoId);
    probe.pendingWatchBodies = probe.pendingWatchBodies.filter((pendingId) => pendingId !== videoId);
    probe.lateWatchResponsesReleased.push(videoId);
    release();
    return true;
  };

  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  Object.defineProperty(AbortSignal, 'timeout', {
    configurable: true,
    value: (milliseconds: number) => {
      if (milliseconds === 20_000) {
        probe.timeoutRequests.push(milliseconds);
        return nativeTimeout(shortTimeoutMs);
      }
      return nativeTimeout(milliseconds);
    },
  });

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const inputUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(inputUrl, location.href);

    if (url.pathname === '/watch') {
      const videoId = url.searchParams.get('v') ?? '';
      const attempt = (probe.watchRequests[videoId] ?? 0) + 1;
      probe.watchRequests[videoId] = attempt;

      const shouldStall = videoId === initialVideoId && (
        (scenario === 'retry-recovers' && attempt === 1) ||
        (scenario === 'navigation-cancels-retry' && attempt <= 2) ||
        (scenario === 'termination-cancels-retry' && attempt === 2)
      );
      if (shouldStall) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const signal = init?.signal;
              if (!signal) throw new Error('Watch HTML request omitted its abort signal');
              const deferUntilReleased =
                (scenario === 'navigation-cancels-retry' && attempt === 2) ||
                (scenario === 'termination-cancels-retry' && attempt === 2);
              if (deferUntilReleased) {
                pendingWatchReleases.set(videoId, () => {
                  controller.enqueue(new TextEncoder().encode(buildWatchHtml(videoId)));
                  controller.close();
                });
                probe.pendingWatchBodies.push(videoId);
              }
              const abortBody = (): void => {
                const reason = signal.reason;
                probe.aborts.push({
                  videoId,
                  reason: reason instanceof Error ? reason.name : String(reason),
                });
                if (!deferUntilReleased) {
                  try {
                    controller.error(reason);
                  } catch {
                    // The stream may already have been errored by a competing abort.
                  }
                } else if (scenario === 'navigation-cancels-retry') {
                  window.setTimeout(() => {
                    window.__ytReleasePendingWatchHtml?.(videoId);
                  }, 50);
                }
              };
              if (signal.aborted) {
                abortBody();
              } else {
                signal.addEventListener('abort', abortBody, { once: true });
              }

              if (
                scenario === 'navigation-cancels-retry' &&
                videoId === initialVideoId &&
                attempt === 2
              ) {
                setTimeout(() => {
                  history.pushState({}, '', `/watch?v=${nextVideoId}`);
                  window.dispatchEvent(new Event('yt-navigate-finish'));
                }, 0);
              }
            },
          }),
          { headers: { 'content-type': 'text/html' } }
        );
      }
      return new Response(buildWatchHtml(videoId), { headers: { 'content-type': 'text/html' } });
    }

    if (url.pathname === '/youtubei/v1/live_chat/get_live_chat') {
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as { continuation?: string }) : {};
      const continuation = body.continuation;
      if (init?.signal?.aborted) {
        if (typeof continuation === 'string') probe.abortedLiveContinuations.push(continuation);
        return Promise.reject(init.signal.reason);
      }
      if (typeof continuation === 'string') {
        probe.liveContinuations.push(continuation);
      }
      return new Response(
        JSON.stringify({
          continuationContents: {
            liveChatContinuation: {
              actions: [],
              continuations: [
                { timedContinuationData: { continuation: 'next-poll', timeoutMs: 60_000 } },
              ],
            },
          },
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }

    return nativeFetch(input, init);
  };

  const nativeConsoleInfo = console.info.bind(console);
  console.info = (...args: unknown[]): void => {
    if (args.some((value) => String(value).includes('runtime.session.started'))) {
      const videoId = new URL(location.href).searchParams.get('v');
      if (videoId) probe.runtimeStartedVideoIds.push(videoId);
    }
    nativeConsoleInfo(...args);
  };
}

async function setupBootstrapPage(page: Page, scenario: ProbeScenario): Promise<void> {
  await page.addInitScript(installBootstrapProbe, {
    scenario,
    initialVideoId: INITIAL_VIDEO_ID,
    nextVideoId: NEXT_VIDEO_ID,
    shortTimeoutMs:
      scenario === 'termination-cancels-retry'
        ? TERMINATION_PENDING_TIMEOUT_MS
        : SHORT_TEST_TIMEOUT_MS,
  });
  await setupMockPageRoute(page);
  await page.addInitScript(installYTMock, {
    preSeedSettings: JSON.stringify({ ...DEFAULT_SETTINGS, logLevel: 'info' }),
    defaults: DEFAULT_SETTINGS,
  });
  await injectUserscript(page);
  await page.goto(MOCK_WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator(`#${OVERLAY_ID} canvas`).waitFor({ state: 'attached', timeout: 15_000 });
}

async function getProbe(page: Page): Promise<BootstrapProbe | null> {
  return page.evaluate(() => window.__ytBootstrapProbe ?? null);
}

test.describe('initial bootstrap retry lifecycle', () => {
  test('recovers when the first watch HTML body stalls until its deadline', async ({ page }) => {
    await setupBootstrapPage(page, 'retry-recovers');

    await expect
      .poll(async () => (await getProbe(page))?.runtimeStartedVideoIds ?? [])
      .toEqual([INITIAL_VIDEO_ID]);

    const probe = await getProbe(page);
    expect(probe?.timeoutRequests).toContain(20_000);
    expect(probe?.watchRequests[INITIAL_VIDEO_ID]).toBe(2);
    expect(probe?.aborts).toContainEqual({ videoId: INITIAL_VIDEO_ID, reason: 'TimeoutError' });
    expect(probe?.liveContinuations).toEqual([`continue-${INITIAL_VIDEO_ID}`]);
  });

  test('navigation aborts an in-flight retry and starts only the new video session', async ({
    page,
  }) => {
    await setupBootstrapPage(page, 'navigation-cancels-retry');

    await expect
      .poll(async () => (await getProbe(page))?.runtimeStartedVideoIds ?? [], { timeout: 15_000 })
      .toEqual([NEXT_VIDEO_ID]);

    await page.waitForTimeout(SHORT_TEST_TIMEOUT_MS + 100);

    const probe = await getProbe(page);
    expect(probe?.watchRequests[INITIAL_VIDEO_ID]).toBe(2);
    expect(probe?.watchRequests[NEXT_VIDEO_ID]).toBe(1);
    expect(probe?.aborts).toContainEqual({ videoId: INITIAL_VIDEO_ID, reason: 'TimeoutError' });
    expect(probe?.aborts).toContainEqual({ videoId: INITIAL_VIDEO_ID, reason: 'AbortError' });
    expect(probe?.lateWatchResponsesReleased).toContain(INITIAL_VIDEO_ID);
    expect(probe?.abortedLiveContinuations).toEqual([]);
    expect(probe?.liveContinuations).toEqual([`continue-${NEXT_VIDEO_ID}`]);
    expect(probe?.runtimeStartedVideoIds).toEqual([NEXT_VIDEO_ID]);
  });

  test('termination aborts a restarted bootstrap and ignores its late watch response', async ({
    page,
  }) => {
    await setupBootstrapPage(page, 'termination-cancels-retry');
    await expect
      .poll(async () => (await getProbe(page))?.runtimeStartedVideoIds ?? [])
      .toEqual([INITIAL_VIDEO_ID]);

    await page.evaluate(() => {
      const handle = window.__ytChatOverlay;
      if (!handle) throw new Error('Userscript debug handle was not exposed after startup');
      delete window.ytcfg;
      delete window.ytInitialData;
      void handle.restartRuntime();
    });
    await expect
      .poll(async () => {
        const probe = await getProbe(page);
        return {
          watchRequests: probe?.watchRequests[INITIAL_VIDEO_ID] ?? 0,
          pendingBody: probe?.pendingWatchBodies.includes(INITIAL_VIDEO_ID) ?? false,
        };
      })
      .toEqual({ watchRequests: 2, pendingBody: true });

    await page.evaluate(async () => {
      const handle = window.__ytChatOverlay;
      if (!handle) throw new Error('Userscript debug handle disappeared before termination');
      await handle.stop();
    });
    const released = await page.evaluate((videoId) => {
      return window.__ytReleasePendingWatchHtml?.(videoId) ?? false;
    }, INITIAL_VIDEO_ID);
    expect(released).toBe(true);
    await page.waitForTimeout(STOP_SETTLE_MS);

    const probe = await getProbe(page);
    expect(probe?.watchRequests[INITIAL_VIDEO_ID]).toBe(2);
    expect(probe?.aborts).toContainEqual({ videoId: INITIAL_VIDEO_ID, reason: 'AbortError' });
    expect(probe?.lateWatchResponsesReleased).toContain(INITIAL_VIDEO_ID);
    expect(probe?.abortedLiveContinuations).toEqual([]);
    expect(probe?.liveContinuations).toEqual([`continue-${INITIAL_VIDEO_ID}`]);
    expect(probe?.runtimeStartedVideoIds).toEqual([INITIAL_VIDEO_ID]);
  });
});
