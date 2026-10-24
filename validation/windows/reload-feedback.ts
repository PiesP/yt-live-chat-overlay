// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Browser, Page } from '@playwright/test';

const WATCH_URL = 'https://www.youtube.com/watch?v=windowsAcceptance';
const VIDEO_PATH = 'validation/windows/fixtures/autoplay-av.webm';
const VIDEO_SHA256 = '38d4e4e22c8aa3712a75c92bc70d461e3d6d0568fb75a146dfec2b91bd1b9cfe';
const RELOAD_BUTTON = '#yt-chat-overlay-reload-button';
const CANVAS = '#yt-live-chat-overlay canvas';

/** Serve the owned media fixture with the byte-range contract native video seeking uses. */
export function mediaResponse(
  bytes: Buffer,
  rangeHeader: string | null
): {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
} {
  const headers = { 'accept-ranges': 'bytes', 'content-length': String(bytes.length) };
  if (rangeHeader === null) return { status: 200, headers, body: bytes };

  const match = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader);
  const startText = match?.[1];
  const endText = match?.[2];
  let start: number;
  let end: number;
  if (startText === undefined || endText === undefined || (startText === '' && endText === '')) {
    return {
      status: 416,
      headers: { ...headers, 'content-range': `bytes */${bytes.length}`, 'content-length': '0' },
      body: Buffer.alloc(0),
    };
  }
  if (startText === '') {
    const suffixLength = Number(endText);
    start = bytes.length - suffixLength;
    end = bytes.length - 1;
    if (start < 0) start = 0;
    if (suffixLength === 0) start = bytes.length;
  } else {
    start = Number(startText);
    end = endText === '' ? bytes.length - 1 : Math.min(Number(endText), bytes.length - 1);
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= bytes.length ||
    end < start
  ) {
    return {
      status: 416,
      headers: { ...headers, 'content-range': `bytes */${bytes.length}`, 'content-length': '0' },
      body: Buffer.alloc(0),
    };
  }
  const body = bytes.subarray(start, end + 1);
  return {
    status: 206,
    headers: {
      ...headers,
      'content-range': `bytes ${start}-${end}/${bytes.length}`,
      'content-length': String(body.length),
    },
    body,
  };
}

async function waitForHostState(
  condition: () => boolean,
  label: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`${label}: timed out after ${timeoutMs} ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('#yt-chat-overlay-reload-button');
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    const status = document.querySelector('#yt-live-chat-overlay [role="status"]');
    const canvas = document.querySelector('#yt-live-chat-overlay canvas');
    return {
      atMs: Math.round(performance.now()),
      buttonText: button?.textContent ?? null,
      buttonClass: button?.className ?? null,
      buttonLabel: button?.getAttribute('aria-label') ?? null,
      buttonDisabled: button?.disabled ?? null,
      statusText: status?.textContent ?? null,
      canvasPresent: Boolean(canvas),
      videoPresent: Boolean(video),
      videoPaused: video?.paused ?? null,
      videoTime: video ? Math.round(video.currentTime * 1000) / 1000 : null,
      videoReadyState: video?.readyState ?? null,
      videoDuration: video?.duration ?? null,
      videoSeeking: video?.seeking ?? null,
      videoEnded: video?.ended ?? null,
      videoNetworkState: video?.networkState ?? null,
      videoErrorCode: video?.error?.code ?? null,
      videoCurrentSrc: video?.currentSrc ?? null,
      videoSeekable: video
        ? Array.from({ length: video.seekable.length }, (_, index) => ({
            start: video.seekable.start(index),
            end: video.seekable.end(index),
          }))
        : null,
    };
  });
}

/** Focused, observable baseline through the real built userscript and native media element. */
export async function runReloadFeedbackFixture({
  browser,
  root,
  output,
  userscript,
  gmMocks,
  watchHtml,
}: {
  browser: Browser;
  root: string;
  output: string;
  userscript: string;
  gmMocks: string;
  watchHtml: string;
}) {
  const video = await readFile(join(root, VIDEO_PATH));
  assert.equal(createHash('sha256').update(video).digest('hex'), VIDEO_SHA256);
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 720 },
  });
  const pageErrors: string[] = [];
  let page: Page | undefined;
  let phase = 'setup';
  const timeline: { phase: string; state: Awaited<ReturnType<typeof snapshot>> }[] = [];
  let chatRequests = 0;
  let chatResponses = 0;
  const mediaRequests: {
    method: string;
    range: string | null;
    resourceType: string;
    responseStatus: number;
  }[] = [];
  let heldChatRequest = false;
  let holdChatRequests = false;
  let releaseHeldChatRequest: () => void = () => {};
  const heldChatGate = new Promise<void>((resolve) => {
    releaseHeldChatRequest = resolve;
  });
  const record = async (nextPhase: string, currentPage: Page) => {
    phase = nextPhase;
    timeline.push({ phase, state: await snapshot(currentPage) });
  };

  try {
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.hostname === 'www.youtube.com' && request.resourceType() === 'document') {
        await route.fulfill({ status: 200, contentType: 'text/html', body: watchHtml });
      } else if (url.hostname === 'www.youtube.com' && url.pathname === '/reload-fixture.webm') {
        const range = request.headers()['range'] ?? null;
        const response = mediaResponse(video, range);
        if (mediaRequests.length < 8) {
          mediaRequests.push({
            method: request.method(),
            range,
            resourceType: request.resourceType(),
            responseStatus: response.status,
          });
        }
        await route.fulfill({ ...response, contentType: 'video/webm' });
      } else if (
        url.hostname === 'www.youtube.com' &&
        url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat')
      ) {
        chatRequests++;
        if (holdChatRequests) {
          heldChatRequest = true;
          await heldChatGate;
        }
        if (request.failure()) return;
        try {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            json: {
              continuationContents: {
                liveChatContinuation: {
                  actions: [],
                  continuations: [
                    {
                      timedContinuationData: {
                        continuation: 'reload-fixture-next',
                        timeoutMs: 30_000,
                      },
                    },
                  ],
                },
              },
            },
          });
          chatResponses++;
        } catch (error) {
          if (!request.failure()) throw error;
        }
      } else {
        await route.fulfill({ status: 204 });
      }
    });
    await context.addInitScript(() => {
      (window as Window & { unsafeWindow?: Window }).unsafeWindow = window;
      window.ytcfg = {
        data_: {
          INNERTUBE_API_KEY: 'reload-fixture-key',
          INNERTUBE_CONTEXT_CLIENT_NAME: '1',
          INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
          INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
        },
      };
      window.ytInitialData = {
        currentVideoEndpoint: { watchEndpoint: { videoId: 'windowsAcceptance' } },
        contents: {
          twoColumnWatchNextResults: {
            conversationBar: {
              liveChatRenderer: {
                isReplay: false,
                continuations: [
                  {
                    timedContinuationData: {
                      continuation: 'reload-fixture-live',
                      timeoutMs: 30_000,
                    },
                  },
                ],
              },
            },
          },
        },
      };
    });
    await context.addInitScript({ content: gmMocks });
    await context.addInitScript({ content: userscript });
    page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator(CANVAS).waitFor({ state: 'attached', timeout: 15_000 });
    await page.locator(RELOAD_BUTTON).waitFor({ state: 'attached' });
    await page.waitForFunction(() => Boolean(window.__ytChatOverlay));
    await waitForHostState(() => chatResponses > 0, 'quiet chat response', 15_000);

    // Decode real media. A paused, seeked element lets the fixture check that
    // reload and standby preserve the native player rather than a mocked clock.
    phase = 'media-play-requested';
    await page.evaluate(async () => {
      const video = document.querySelector<HTMLVideoElement>('#movie_player video');
      if (!video) throw new Error('Fixture video is missing');
      video.src = '/reload-fixture.webm';
      video.muted = true;
      video.loop = true;
      await video.play();
    });
    await page.waitForFunction(() => {
      const video = document.querySelector<HTMLVideoElement>('#movie_player video');
      return Boolean(video && video.readyState >= 2 && video.currentTime > 0.05);
    });
    await record('media-positive-progress', page);
    phase = 'media-seek-requested';
    await page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>('#movie_player video');
      if (!video) throw new Error('Fixture video is missing');
      video.pause();
      video.currentTime = 0.8;
      video.dataset.reloadFixtureIdentity = 'original';
    });
    await record('media-seek-immediate', page);
    phase = 'media-seek-wait';
    await page.waitForFunction(
      () => {
        const video = document.querySelector<HTMLVideoElement>('#movie_player video');
        return Boolean(video && video.paused && Math.abs(video.currentTime - 0.8) < 0.15);
      },
      undefined,
      { timeout: 10_000 }
    );
    await page.locator('#movie_player').hover();
    await record('quiet-before', page);
    const responsesBeforeReload = chatResponses;
    holdChatRequests = true;
    await page.locator(RELOAD_BUTTON).click();
    await waitForHostState(() => heldChatRequest, 'held reload request', 10_000);
    await record('pointer-held', page);
    await page.locator(RELOAD_BUTTON).focus();
    await page.keyboard.press('Enter');
    await record('keyboard-repeat', page);
    await page.waitForTimeout(1_700);
    await record('still-waiting-after-old-feedback-timer', page);
    holdChatRequests = false;
    releaseHeldChatRequest();
    await waitForHostState(
      () => chatResponses > responsesBeforeReload,
      'released reload response',
      10_000
    );
    await record('quiet-after-release', page);

    await page.evaluate(() => {
      window.ytInitialData = {
        currentVideoEndpoint: { watchEndpoint: { videoId: 'windowsAcceptance' } },
        playabilityStatus: { status: 'LIVE_STREAM_OFFLINE' },
      };
    });
    await page.locator(RELOAD_BUTTON).click();
    await page.waitForFunction(() =>
      Boolean(document.querySelector('#yt-live-chat-overlay [role="status"]')?.textContent)
    );
    await record('legitimate-standby', page);
    const playerIdentity = await page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>('#movie_player video');
      return {
        original: video?.dataset.reloadFixtureIdentity === 'original',
        paused: video?.paused,
        time: video?.currentTime,
      };
    });
    assert.equal(playerIdentity.original, true, 'Reload replaced the native video element');
    assert.equal(playerIdentity.paused, true, 'Reload changed native pause state');
    assert(Math.abs((playerIdentity.time ?? 0) - 0.8) < 0.15, 'Reload changed native seek state');
    await page.evaluate(async () => {
      const video = document.querySelector<HTMLVideoElement>('#movie_player video');
      if (!video) throw new Error('Fixture video is missing');
      await video.play();
    });
    await page.waitForFunction(() => {
      const video = document.querySelector<HTMLVideoElement>('#movie_player video');
      return Boolean(video && !video.paused && video.currentTime > 0.9);
    });
    await record('native-play-resumed', page);
    assert.deepEqual(pageErrors, [], 'The page reported a script error');
    const result = {
      checks: {
        builtUserscriptFixture: true,
        sustainedViewingLifecycle: false,
        quietChatBootstrapped: chatRequests > 0,
        heldChatRequest,
        nativeVideoPreserved: playerIdentity.original && playerIdentity.paused,
        pageErrors: 0,
      },
      observations: {
        browserVersion: browser.version(),
        chatRequests,
        chatResponses,
        timeline,
        videoSha256: VIDEO_SHA256,
        installedExtension: 'not-run: focused selector exercises the built userscript',
      },
    };
    await writeFile(join(output, 'reload-feedback.json'), JSON.stringify(result, null, 2));
    await page.screenshot({ path: join(output, 'reload-feedback-standby.png') });
    return result;
  } catch (error) {
    await writeFile(
      join(output, 'reload-feedback-error.json'),
      JSON.stringify(
        {
          phase,
          error: String(error),
          chatRequests,
          chatResponses,
          mediaRequests,
          nativeVideo: page ? await snapshot(page).catch(() => null) : null,
          pageErrors,
          timeline,
        },
        null,
        2
      )
    );
    await page
      ?.screenshot({ path: join(output, 'reload-feedback-error.png'), timeout: 5_000 })
      .catch(() => {});
    throw error;
  } finally {
    releaseHeldChatRequest();
    await context.close();
  }
}
