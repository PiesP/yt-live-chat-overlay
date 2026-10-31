// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, Page, Route } from '@playwright/test';

import {
  installNativePageScriptProbe,
  type NativePageScriptProbe,
} from './native-page-script-probe.ts';
import { verifyNativeTabLifetime } from './native-tab-lifetime.ts';
import { buildVisibleWatchHtml } from './visible-watch.ts';

const FIXTURE_URL = 'https://www.youtube.com/watch?v=windowsVideoPiP';
const ENTRY_MARKER = '\n\tmain();\n';
const PROBE_LIMIT = 48;
const EVENT_LIMIT = 48;

type PauseCall = {
  phase: string;
  paused: boolean;
  pipMatchesVideo: boolean;
  videoPaused: boolean | null;
  videoTime: number | null;
  atMs: number;
};
type VideoEvent = {
  phase: string;
  type: string;
  pipMatchesVideo: boolean;
  videoPaused: boolean;
  videoTime: number;
  atMs: number;
};
type PiPProbe = {
  phase: string;
  starts: number;
  calls: PauseCall[];
  overflow: number;
};
type PiPFixture = {
  stream: MediaStream;
  animationFrame: number;
  frames: number;
  events: VideoEvent[];
  eventOverflow: number;
  actionErrors: string[];
};
type PiPSnapshot = {
  phase: string;
  url: string;
  timeOrigin: number;
  pipSupported: boolean;
  captureSupported: boolean;
  pipMatchesVideo: boolean;
  videoPaused: boolean;
  videoTime: number;
  videoWidth: number;
  videoHeight: number;
  readyState: number;
  mediaError: number | null;
  frames: number;
  starts: number;
  calls: PauseCall[];
  callOverflow: number;
  events: VideoEvent[];
  eventOverflow: number;
  actionErrors: string[];
};

declare global {
  interface Window {
    __ytVideoPiPProbe: PiPProbe;
    __ytVideoPiPFixture: PiPFixture;
  }
}

function instrumentPageScript(source: string): string {
  assert.equal(source.split(ENTRY_MARKER).length, 2, 'Packaged page entry shape changed');
  assert(
    source.includes('var VideoPauseController = class {'),
    'Packaged VideoPauseController shape changed'
  );
  // Forward the real callback into the real controller. Its event listeners,
  // PiP classification and downstream pause handling remain production code.
  const insertion = `
\tif (typeof VideoPauseController.prototype.start !== 'function')
\t\tthrow new Error('Packaged video pause controller changed');
\tconst videoPiPProbe = { phase: 'initial', starts: 0, calls: [], overflow: 0 };
\twindow.__ytVideoPiPProbe = videoPiPProbe;
\tconst originalVideoPiPStart = VideoPauseController.prototype.start;
\tVideoPauseController.prototype.start = function(callbacks) {
\t\tvideoPiPProbe.starts++;
\t\tconst originalPauseable = callbacks.pauseable;
\t\tconst originalSetPaused = originalPauseable.setPaused;
\t\treturn Reflect.apply(originalVideoPiPStart, this, [{
\t\t\t...callbacks,
\t\t\tpauseable: {
\t\t\t\tsetPaused(paused) {
\t\t\t\t\tconst video = document.querySelector('#movie_player video');
\t\t\t\t\tconst record = {
\t\t\t\t\t\tphase: videoPiPProbe.phase,
\t\t\t\t\t\tpaused,
\t\t\t\t\t\tpipMatchesVideo: !!video && document.pictureInPictureElement === video,
\t\t\t\t\t\tvideoPaused: video ? video.paused : null,
\t\t\t\t\t\tvideoTime: video ? video.currentTime : null,
\t\t\t\t\t\tatMs: performance.now(),
\t\t\t\t\t};
\t\t\t\t\tif (videoPiPProbe.calls.length < ${PROBE_LIMIT}) videoPiPProbe.calls.push(record);
\t\t\t\t\telse videoPiPProbe.overflow++;
\t\t\t\t\treturn Reflect.apply(originalSetPaused, originalPauseable, [paused]);
\t\t\t\t},
\t\t\t},
\t\t}]);
\t};`;
  return source.replace(ENTRY_MARKER, `${insertion}${ENTRY_MARKER}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function snapshot(page: Page): Promise<PiPSnapshot> {
  return page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    const probe = window.__ytVideoPiPProbe;
    const fixture = window.__ytVideoPiPFixture;
    if (!video || !probe || !fixture) throw new Error('Video PiP fixture or probe disappeared');
    return {
      phase: probe.phase,
      url: location.href,
      timeOrigin: performance.timeOrigin,
      pipSupported: typeof video.requestPictureInPicture === 'function',
      captureSupported: typeof HTMLCanvasElement.prototype.captureStream === 'function',
      pipMatchesVideo: document.pictureInPictureElement === video,
      videoPaused: video.paused,
      videoTime: video.currentTime,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      readyState: video.readyState,
      mediaError: video.error?.code ?? null,
      frames: fixture.frames,
      starts: probe.starts,
      calls: [...probe.calls],
      callOverflow: probe.overflow,
      events: [...fixture.events],
      eventOverflow: fixture.eventOverflow,
      actionErrors: [...fixture.actionErrors],
    };
  });
}

function assertLastCall(state: PiPSnapshot, phase: string, paused: boolean): void {
  const calls = state.calls.filter((call) => call.phase === phase);
  assert(calls.length > 0, `Production pause callback absent for ${phase}`);
  assert.equal(calls.at(-1)?.paused, paused, `Wrong production pause state for ${phase}`);
  assert.equal(state.callOverflow, 0, 'Production pause callback log overflowed');
  assert.equal(state.eventOverflow, 0, 'Native video event log overflowed');
  assert.deepEqual(state.actionErrors, [], 'Native media action failed');
}

async function setPhase(page: Page, phase: string): Promise<void> {
  await page.evaluate((value) => {
    window.__ytVideoPiPProbe.phase = value;
  }, phase);
}

async function waitForPhaseCall(page: Page, phase: string, paused: boolean): Promise<void> {
  await page.waitForFunction(
    ({ phase, paused }) =>
      window.__ytVideoPiPProbe.calls.some(
        (call) => call.phase === phase && call.paused === paused
      ) || window.__ytVideoPiPFixture.actionErrors.length > 0,
    { phase, paused },
    { timeout: 5_000 }
  );
}

async function verifyDomFallbackLifetime(page: Page, output: string) {
  const previous = await page.evaluate(() => {
    const app = window.__ytChatOverlay;
    if (!app) throw new Error('Installed application is unavailable for DOM fallback');
    const settings = structuredClone(app.getSettings());
    app.applySettings({
      showDebugOverlay: true,
      allowShortTextMessages: true,
      danmakuMode: 'top',
      depthLayersEnabled: false,
      topBottomDurationMs: 8_000,
    });
    return settings;
  });
  let primaryError: unknown;
  let result: { ids: string[]; counters: string | null } | undefined;
  const healthyId = 'windows-dom-control';
  const recoveredId = 'windows-dom-recovered';
  try {
    await page.evaluate(
      async ({ healthyId, recoveredId }) => {
        const items = document.querySelector('yt-live-chat-item-list-renderer #items');
        if (!items) throw new Error('DOM fallback chat container is missing');
        const append = (id: string) => {
          const renderer = document.createElement('yt-live-chat-text-message-renderer');
          renderer.id = id;
          const author = document.createElement('span');
          author.id = 'author-name';
          author.textContent = 'Fixture author';
          const message = document.createElement('span');
          message.id = 'message';
          message.textContent = `DOM lifetime ${id}`;
          renderer.append(author, message);
          items.append(renderer);
          return renderer;
        };
        append(healthyId);
        await new Promise(requestAnimationFrame);
        for (const relocation of ['detach', 'move']) {
          const retired = append(`windows-dom-retired-${relocation}`);
          // Native MutationObserver queues the batch before this continuation;
          // retirement still occurs before its native animation-frame flush.
          await Promise.resolve();
          if (relocation === 'detach') retired.remove();
          else document.body.append(retired);
          await new Promise(requestAnimationFrame);
        }
        append(recoveredId);
      },
      { healthyId, recoveredId }
    );
    await page.waitForFunction(
      (id) =>
        Array.from(
          document.querySelectorAll('#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p')
        ).some((element) => element.getAttribute('data-message-id') === id),
      recoveredId,
      { timeout: 8_000 }
    );
    await page.waitForFunction(() =>
      /^(?:Rcvd: 2 \| Alloc: 2 \| Shown≥\d+ \| Uncertain: \d+|Rcvd: 2 \| Rndr: 2)$/u.test(
        document.querySelector('#yt-chat-overlay-debug > div')?.textContent ?? ''
      )
    );
    result = await page.evaluate(() => ({
      ids: Array.from(
        document.querySelectorAll('#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p'),
        (element) => element.getAttribute('data-message-id') ?? ''
      ),
      counters: document.querySelector('#yt-chat-overlay-debug > div')?.textContent ?? null,
    }));
    assert(result.ids.includes(healthyId), 'Healthy DOM control was not rendered');
    assert(result.ids.includes(recoveredId), 'Healthy DOM recovery was not rendered');
    assert(!result.ids.some((id) => id.startsWith('windows-dom-retired-')));
    assert.match(
      result.counters ?? '',
      /^(?:Rcvd: 2 \| Alloc: 2 \| Shown≥\d+ \| Uncertain: \d+|Rcvd: 2 \| Rndr: 2)$/u,
      'Retired DOM input reached the runtime'
    );
  } catch (error) {
    primaryError = error;
    try {
      const observations = await page.evaluate(() => {
        const panel = document.querySelector('#chat.ytd-live-chat-frame');
        const rect = panel?.getBoundingClientRect();
        const video = document.querySelector<HTMLVideoElement>('#movie_player video');
        return {
          visibility: document.visibilityState,
          panel: rect ? { width: rect.width, height: rect.height } : null,
          chatIds: Array.from(
            document.querySelectorAll('yt-live-chat-item-list-renderer #items > *'),
            (node) => node.id
          ).slice(0, 8),
          liveIds: Array.from(
            document.querySelectorAll('.yt-live-chat-overlay-live-region > p'),
            (node) => node.getAttribute('data-message-id')
          ).slice(0, 8),
          debug: document.querySelector('#yt-chat-overlay-debug')?.textContent?.slice(0, 2_000),
          video: video ? { paused: video.paused, time: video.currentTime } : null,
        };
      });
      await writeFile(
        join(output, 'dom-fallback-failure.json'),
        JSON.stringify({ error: errorText(error), observations }, null, 2)
      );
    } catch (diagnosticError) {
      primaryError = new AggregateError(
        [error, diagnosticError],
        'DOM lifetime fixture and diagnostic collection failed'
      );
    }
  }
  try {
    await page.evaluate((settings) => window.__ytChatOverlay?.applySettings(settings), previous);
  } catch (error) {
    throw new AggregateError(
      primaryError ? [primaryError, error] : [error],
      'DOM lifetime fixture settings restoration failed'
    );
  }
  if (primaryError) throw primaryError;
  assert(result, 'DOM lifetime fixture completed without observations');
  return {
    status: 'passed',
    scope: 'native DOM mutation through installed overlay rendering',
    ...result,
  };
}

/** Installed Chromium: exercise native PiP events against the compiled controller. */
export async function runVideoPiPFixture({
  context,
  root,
  output,
  extensionId,
  nativeTabVisibility = false,
  artifactPrefix = 'video-pip',
}: {
  context: BrowserContext;
  root: string;
  output: string;
  extensionId: string;
  nativeTabVisibility?: boolean;
  artifactPrefix?: 'video-pip' | 'native-tab-chrome';
}) {
  const source = await readFile(join(root, 'dist-extension/page-script.js'), 'utf8');
  const instrumentedSource = instrumentPageScript(source);
  const preview = await readFile(join(root, 'test/visual/preview.html'), 'utf8');
  const html = buildVisibleWatchHtml(preview, 'Native PiP fixture video')
    // Match the production panel observer as well as the DOM item selector.
    .replace(
      '<div id="chat">',
      '<div id="chat" class="ytd-live-chat-frame" style="min-height:1px">'
    )
    .replace(
      '</body>',
      '<div id="pip-controls"><button id="pip-enter">Enter PiP</button>' +
        '<button id="pip-exit">Exit PiP</button><button id="pip-pause">Pause</button>' +
        '<button id="pip-play">Play</button></div></body>'
    );
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  let pageErrorOverflow = 0;
  let consoleErrorOverflow = 0;
  let documentRequests = 0;
  let chatRequests = 0;
  let nativeProbe: NativePageScriptProbe | undefined;
  let probeProvenance: NativePageScriptProbe['provenance'] | null = null;
  const states: PiPSnapshot[] = [];
  page.on('pageerror', (error) => {
    if (pageErrors.length < 10) pageErrors.push(errorText(error).slice(0, 200));
    else pageErrorOverflow++;
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (consoleErrors.length < 10) consoleErrors.push(message.text().slice(0, 200));
    else consoleErrorOverflow++;
  });
  const routeFixture = (route: Route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:' && url.hostname === extensionId)
      return route.continue();
    if (url.href === FIXTURE_URL && route.request().resourceType() === 'document') {
      documentRequests++;
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    }
    if (url.hostname === 'www.youtube.com' && url.pathname === '/favicon.ico')
      return route.fulfill({ status: 204 });
    if (
      url.hostname === 'www.youtube.com' &&
      url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat')
    ) {
      chatRequests++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          continuationContents: {
            liveChatContinuation: {
              actions: [],
              continuations: [
                { timedContinuationData: { continuation: 'windows-pip-next', timeoutMs: 30_000 } },
              ],
            },
          },
        },
      });
    }
    return route.fulfill({
      status: 403,
      contentType: 'text/plain',
      body: 'Blocked by PiP fixture',
    });
  };
  let routeRegistered = false;
  let primaryError: unknown;
  let scenarioError: unknown;
  let result: Record<string, unknown> | undefined;
  let currentState: PiPSnapshot | null = null;
  const cleanupReceipt: Record<string, unknown> = {};
  try {
    await page.route('**/*', routeFixture);
    routeRegistered = true;
    await page.addInitScript(() => {
      window.ytcfg = {
        data_: {
          INNERTUBE_API_KEY: 'windows-acceptance-key',
          INNERTUBE_CONTEXT_CLIENT_NAME: '1',
          INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
          INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
        },
      };
      window.ytInitialData = {
        currentVideoEndpoint: { watchEndpoint: { videoId: 'windowsVideoPiP' } },
        contents: {
          twoColumnWatchNextResults: {
            conversationBar: {
              liveChatRenderer: {
                isReplay: false,
                continuations: [
                  {
                    timedContinuationData: {
                      continuation: 'windows-pip-live',
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
    nativeProbe = await installNativePageScriptProbe({
      context,
      root,
      extensionId,
      fixtureUrl: FIXTURE_URL,
      instrumentedSource,
    });
    probeProvenance = nativeProbe.provenance;
    await nativeProbe.assertReady();
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page
      .locator('#yt-live-chat-overlay canvas')
      .waitFor({ state: 'attached', timeout: 15_000 });
    await nativeProbe.assertInjected();
    await page.waitForFunction(() => window.__ytVideoPiPProbe?.starts > 0, undefined, {
      timeout: 5_000,
    });
    await nativeProbe.restore();
    nativeProbe = undefined;

    await page.evaluate(async (eventLimit) => {
      const video = document.querySelector<HTMLVideoElement>('#movie_player video');
      if (!video) throw new Error('PiP fixture video is absent');
      if (typeof HTMLCanvasElement.prototype.captureStream !== 'function')
        throw new Error('Native HTMLCanvasElement.captureStream is unavailable');
      if (typeof video.requestPictureInPicture !== 'function')
        throw new Error('Native HTMLVideoElement.requestPictureInPicture is unavailable');
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 90;
      const drawing = canvas.getContext('2d');
      if (!drawing) throw new Error('Canvas stream drawing context is unavailable');
      const stream = canvas.captureStream(10);
      const fixture: PiPFixture = {
        stream,
        animationFrame: 0,
        frames: 0,
        events: [],
        eventOverflow: 0,
        actionErrors: [],
      };
      window.__ytVideoPiPFixture = fixture;
      const paint = () => {
        drawing.fillStyle = fixture.frames % 2 === 0 ? '#008800' : '#000088';
        drawing.fillRect(0, 0, canvas.width, canvas.height);
        fixture.frames++;
        fixture.animationFrame = requestAnimationFrame(paint);
      };
      paint();
      for (const type of [
        'enterpictureinpicture',
        'leavepictureinpicture',
        'pause',
        'play',
        'playing',
        'waiting',
      ]) {
        video.addEventListener(type, () => {
          const record = {
            phase: window.__ytVideoPiPProbe.phase,
            type,
            pipMatchesVideo: document.pictureInPictureElement === video,
            videoPaused: video.paused,
            videoTime: video.currentTime,
            atMs: performance.now(),
          };
          if (fixture.events.length < eventLimit) fixture.events.push(record);
          else fixture.eventOverflow++;
        });
      }
      const action = (id: string, callback: () => Promise<unknown> | void) => {
        document.getElementById(id)?.addEventListener('click', () => {
          try {
            void Promise.resolve(callback()).catch((error: unknown) => {
              if (fixture.actionErrors.length < 8)
                fixture.actionErrors.push(`${id}: ${String(error)}`.slice(0, 200));
            });
          } catch (error) {
            if (fixture.actionErrors.length < 8)
              fixture.actionErrors.push(`${id}: ${String(error)}`.slice(0, 200));
          }
        });
      };
      action('pip-enter', () => video.requestPictureInPicture());
      action('pip-exit', () => document.exitPictureInPicture());
      action('pip-pause', () => video.pause());
      action('pip-play', () => video.play());
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
    }, EVENT_LIMIT);
    await page.waitForFunction(
      () => {
        const video = document.querySelector<HTMLVideoElement>('#movie_player video');
        return video && video.videoWidth > 0 && video.videoHeight > 0 && video.currentTime > 0.2;
      },
      undefined,
      { timeout: 5_000 }
    );
    const initialState = await snapshot(page);
    states.push(initialState);
    assert.equal(initialState.starts, 1, 'Production video pause controller did not bind once');
    assert.equal(initialState.mediaError, null);
    assert(initialState.frames > 1, 'Native stream did not produce video frames');

    await setPhase(page, 'pip-playing');
    await page.locator('#pip-enter').click();
    await page.waitForFunction(
      () => document.pictureInPictureElement === document.querySelector('#movie_player video'),
      undefined,
      { timeout: 5_000 }
    );
    await waitForPhaseCall(page, 'pip-playing', true);
    const activeState = await snapshot(page);
    states.push(activeState);
    assertLastCall(activeState, 'pip-playing', true);
    assert(
      activeState.events.some(
        (event) => event.type === 'enterpictureinpicture' && event.pipMatchesVideo
      ),
      'Native PiP entry event was not observed'
    );
    await page.screenshot({
      path: join(output, `${artifactPrefix}-active.png`),
      animations: 'disabled',
    });

    await setPhase(page, 'pip-user-pause');
    await page.locator('#pip-pause').click();
    await page.waitForFunction(
      () => document.querySelector<HTMLVideoElement>('#movie_player video')?.paused === true,
      undefined,
      { timeout: 5_000 }
    );
    await waitForPhaseCall(page, 'pip-user-pause', true);
    const pausedInPiP = await snapshot(page);
    states.push(pausedInPiP);
    assert.equal(pausedInPiP.pipMatchesVideo, true, 'PiP closed when the user paused');
    assertLastCall(pausedInPiP, 'pip-user-pause', true);

    await setPhase(page, 'pip-user-play');
    await page.locator('#pip-play').click();
    await page.waitForFunction(
      () => document.querySelector<HTMLVideoElement>('#movie_player video')?.paused === false,
      undefined,
      { timeout: 5_000 }
    );
    await waitForPhaseCall(page, 'pip-user-play', true);
    await page.waitForFunction(
      () =>
        window.__ytVideoPiPFixture.events.some(
          (event) => event.phase === 'pip-user-play' && event.type === 'playing'
        ),
      undefined,
      { timeout: 5_000 }
    );
    const resumedInPiP = await snapshot(page);
    states.push(resumedInPiP);
    assert.equal(resumedInPiP.pipMatchesVideo, true);
    assertLastCall(resumedInPiP, 'pip-user-play', true);
    assert(
      resumedInPiP.calls
        .filter((call) => call.phase === 'pip-user-play' && call.pipMatchesVideo)
        .every((call) => call.paused),
      'A production callback temporarily resumed the page overlay during PiP'
    );
    assert(
      resumedInPiP.events.some((event) => event.phase === 'pip-user-play' && event.type === 'play'),
      'Native play event in PiP was not observed'
    );
    assert(
      resumedInPiP.calls.filter(
        (call) => call.phase === 'pip-user-play' && call.pipMatchesVideo && call.paused
      ).length >= 2,
      'Production play and playing callbacks did not retain PiP pause'
    );

    await setPhase(page, 'pip-exit-playing');
    await page.locator('#pip-exit').click();
    await page.waitForFunction(() => document.pictureInPictureElement === null, undefined, {
      timeout: 5_000,
    });
    await waitForPhaseCall(page, 'pip-exit-playing', false);
    const exitedPlaying = await snapshot(page);
    states.push(exitedPlaying);
    assert.equal(exitedPlaying.videoPaused, false);
    assertLastCall(exitedPlaying, 'pip-exit-playing', false);
    assert(
      exitedPlaying.events.some(
        (event) => event.phase === 'pip-exit-playing' && event.type === 'leavepictureinpicture'
      ),
      'Native playing PiP exit event was not observed'
    );

    await setPhase(page, 'pip-second-enter');
    await page.locator('#pip-enter').click();
    await page.waitForFunction(
      () => document.pictureInPictureElement === document.querySelector('#movie_player video'),
      undefined,
      { timeout: 5_000 }
    );
    await waitForPhaseCall(page, 'pip-second-enter', true);
    await setPhase(page, 'pip-second-pause');
    await page.locator('#pip-pause').click();
    await waitForPhaseCall(page, 'pip-second-pause', true);
    await setPhase(page, 'pip-exit-paused');
    await page.locator('#pip-exit').click();
    await page.waitForFunction(() => document.pictureInPictureElement === null, undefined, {
      timeout: 5_000,
    });
    const exitedPaused = await snapshot(page);
    states.push(exitedPaused);
    assert.equal(exitedPaused.videoPaused, true);
    assert.equal(
      exitedPaused.calls.some((call) => call.phase === 'pip-exit-paused' && !call.paused),
      false,
      'Leaving PiP cleared the user pause'
    );
    assert.equal(
      exitedPaused.events.some(
        (event) => event.phase === 'pip-exit-paused' && event.type === 'leavepictureinpicture'
      ),
      true,
      'Native paused PiP exit event was not observed'
    );

    await setPhase(page, 'restored-play');
    await page.locator('#pip-play').click();
    await waitForPhaseCall(page, 'restored-play', false);
    await page.waitForFunction(
      (before) => {
        const video = document.querySelector<HTMLVideoElement>('#movie_player video');
        return (
          video &&
          !video.paused &&
          video.currentTime > before + 0.1 &&
          window.__ytVideoPiPFixture.events.some(
            (event) => event.phase === 'restored-play' && event.type === 'playing'
          )
        );
      },
      exitedPaused.videoTime,
      { timeout: 5_000 }
    );
    const restoredPlaying = await snapshot(page);
    states.push(restoredPlaying);
    assertLastCall(restoredPlaying, 'restored-play', false);
    assert.equal(restoredPlaying.pipMatchesVideo, false);
    assert(restoredPlaying.videoTime > initialState.videoTime, 'Video time did not progress');
    assert.equal(documentRequests, 1, 'Exact PiP fixture document was not routed once');
    assert.deepEqual(pageErrors, []);
    assert.equal(pageErrorOverflow, 0);
    assert.deepEqual(consoleErrors, []);
    assert.equal(consoleErrorOverflow, 0);
    const domFallbackLifetime = await verifyDomFallbackLifetime(page, output);
    const nativeTabLifetime = nativeTabVisibility
      ? await verifyNativeTabLifetime({ context, page, output })
      : { status: 'not-requested', reason: 'requires a context attached with noDefaults' };
    assert.deepEqual(pageErrors, []);
    assert.equal(pageErrorOverflow, 0);
    assert.deepEqual(consoleErrors, []);
    assert.equal(consoleErrorOverflow, 0);
    result = {
      status: 'passed',
      scope: 'installed Chromium extension, native Picture-in-Picture, routed YouTube fixture',
      fixtureUrl: FIXTURE_URL,
      probeProvenance,
      documentRequests,
      chatRequests,
      states,
      domFallbackLifetime,
      nativeTabLifetime,
      pageErrors,
      pageErrorOverflow,
      consoleErrors,
      consoleErrorOverflow,
      screenshot: `${artifactPrefix}-active.png`,
      screenshotScope: 'page viewport while native PiP is active; external PiP window excluded',
    };
  } catch (error) {
    primaryError = error;
    scenarioError = error;
    try {
      currentState = await snapshot(page);
    } catch {
      // The page may have failed before the video/fixture existed.
    }
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      cleanupReceipt.media = await page.evaluate(async () => {
        const fixture = window.__ytVideoPiPFixture;
        if (!fixture) return { status: 'fixture-not-started' };
        const video = document.querySelector<HTMLVideoElement>('#movie_player video');
        let pipExitError: string | null = null;
        try {
          if (document.pictureInPictureElement) await document.exitPictureInPicture();
        } catch (error) {
          pipExitError = String(error).slice(0, 200);
        } finally {
          video?.pause();
          if (video) video.srcObject = null;
          cancelAnimationFrame(fixture.animationFrame);
          for (const track of fixture.stream.getTracks()) track.stop();
        }
        return {
          status: 'cleaned',
          pipExitError,
          pipClosed: document.pictureInPictureElement === null,
          videoSourceDetached: video?.srcObject === null,
          tracksEnded: fixture.stream.getTracks().every((track) => track.readyState === 'ended'),
        };
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
    const mediaCleanup = cleanupReceipt.media;
    if (
      result &&
      (!mediaCleanup ||
        typeof mediaCleanup !== 'object' ||
        !('status' in mediaCleanup) ||
        mediaCleanup.status !== 'cleaned' ||
        !('pipClosed' in mediaCleanup) ||
        mediaCleanup.pipClosed !== true ||
        !('pipExitError' in mediaCleanup) ||
        mediaCleanup.pipExitError !== null ||
        !('videoSourceDetached' in mediaCleanup) ||
        mediaCleanup.videoSourceDetached !== true ||
        !('tracksEnded' in mediaCleanup) ||
        mediaCleanup.tracksEnded !== true)
    )
      cleanupErrors.push(new Error('PiP media cleanup did not release all owned state'));
    try {
      if (nativeProbe) {
        await nativeProbe.restore();
        cleanupReceipt.probeRestored = true;
      } else {
        cleanupReceipt.probeRestored = 'already-restored';
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (routeRegistered) await page.unroute('**/*', routeFixture);
      cleanupReceipt.routeRemoved = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await page.close();
      cleanupReceipt.pageClosed = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      cleanupReceipt.errors = cleanupErrors.map(errorText);
      primaryError = primaryError
        ? new AggregateError([primaryError, ...cleanupErrors], 'PiP fixture and cleanup failed')
        : new AggregateError(cleanupErrors, 'PiP fixture cleanup failed');
    }
  }
  if (primaryError) {
    try {
      await writeFile(
        join(output, `${artifactPrefix}-failure.json`),
        JSON.stringify(
          {
            status: 'failed',
            error: errorText(primaryError),
            scenarioError: scenarioError ? errorText(scenarioError) : null,
            probeProvenance,
            documentRequests,
            chatRequests,
            states,
            currentState,
            pageErrors,
            pageErrorOverflow,
            consoleErrors,
            consoleErrorOverflow,
            cleanup: cleanupReceipt,
          },
          null,
          2
        )
      );
    } catch (writeError) {
      throw new AggregateError([primaryError, writeError], 'PiP failure and receipt write failed');
    }
    throw primaryError;
  }
  assert(result, 'PiP fixture completed without a result');
  result.cleanup = cleanupReceipt;
  return result;
}
