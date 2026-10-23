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
import { buildVisibleWatchHtml } from './visible-watch.ts';

const FIXTURE_URL = 'https://www.youtube.com/watch?v=windowsPlayerBoundaries';
const IMAGE_URL = 'https://yt3.ggpht.com/windows-player-independent-image.png';
const ENTRY_MARKER = '\n\tmain();\n';
const EVENT_LIMIT = 80;
const BYTE_LIMIT = 8 * 1024 * 1024;
const DENIED_ID = 'windows-player-autoplay-denied';
const HEALTHY_ID = 'windows-player-healthy';
const STALLED_ID = 'windows-player-during-stall';
const REPLACED_ID = 'windows-player-after-replacement';
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGP8z8DwnwEJMDGgAcICAIPRAgYCkO9YAAAAAElFTkSuQmCC',
  'base64'
);

type PlayerEvent = {
  phase: string;
  source: 'first' | 'replacement';
  type: string;
  trusted: boolean;
  paused: boolean;
  time: number;
  readyState: number;
  atMs: number;
};
type PauseCall = {
  phase: string;
  paused: boolean;
  currentVideo: 'first' | 'replacement' | 'absent';
  atMs: number;
};
type PlayerProbe = {
  phase: string;
  starts: number;
  calls: PauseCall[];
  overflow: number;
};
type PlayerFixture = {
  first: HTMLVideoElement;
  replacement: HTMLVideoElement | null;
  stream: MediaStream;
  audio: AudioContext;
  oscillator: OscillatorNode;
  recorder: MediaRecorder | null;
  chunks: Uint8Array[];
  recordedBytes: number;
  mediaSource: MediaSource | null;
  sourceBuffer: SourceBuffer | null;
  objectUrl: string | null;
  animationFrame: number;
  frameCallbacks: { first: number | null; replacement: number | null };
  sourceFrames: number;
  videoFrames: { first: number; replacement: number };
  events: PlayerEvent[];
  eventOverflow: number;
  actionErrors: string[];
  autoplay: { activationBefore: boolean; rejection: string | null } | null;
  trustedActions: string[];
  recordedMime: string | null;
  pendingChunkReads: Promise<void>[];
  waitForEvent: (
    target: EventTarget,
    success: string,
    failure: string,
    trigger: () => void
  ) => Promise<void>;
  headChunks: number;
  headBufferedEnd: number | null;
  oldPauseBefore: boolean | null;
};
type Snapshot = {
  phase: string;
  url: string;
  visibility: DocumentVisibilityState;
  timeOrigin: number;
  starts: number;
  currentVideo: 'first' | 'replacement' | 'absent';
  paused: boolean;
  time: number;
  width: number;
  height: number;
  readyState: number;
  mediaError: number | null;
  currentSrc: string;
  currentSrcKind: 'stream' | 'blob' | 'other';
  sourceFrames: number;
  videoFrames: { first: number; replacement: number };
  autoplay: PlayerFixture['autoplay'];
  trustedActions: string[];
  recordedBytes: number;
  recordedChunks: number;
  recordedMime: string | null;
  headChunks: number;
  headBufferedEnd: number | null;
  oldPauseBefore: boolean | null;
  events: PlayerEvent[];
  eventOverflow: number;
  calls: PauseCall[];
  callOverflow: number;
  actionErrors: string[];
  liveIds: string[];
  debug: string | null;
};

declare global {
  interface Window {
    __ytNativePlayerProbe?: PlayerProbe;
    __ytNativePlayerFixture?: PlayerFixture;
    __ytNativePlayerSetupError?: string;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function instrumentPageScript(source: string): string {
  assert.equal(source.split(ENTRY_MARKER).length, 2, 'Packaged page entry shape changed');
  assert(source.includes('var VideoPauseController = class {'));
  const insertion = `
\tif (typeof VideoPauseController.prototype.start !== 'function')
\t\tthrow new Error('Packaged video controller shape changed');
\tconst nativePlayerProbe = { phase: 'initial', starts: 0, calls: [], overflow: 0 };
\twindow.__ytNativePlayerProbe = nativePlayerProbe;
\tconst originalNativePlayerStart = VideoPauseController.prototype.start;
\tVideoPauseController.prototype.start = function(callbacks) {
\t\tnativePlayerProbe.starts++;
\t\tconst originalPauseable = callbacks.pauseable;
\t\tconst originalSetPaused = originalPauseable.setPaused;
\t\treturn Reflect.apply(originalNativePlayerStart, this, [{
\t\t\t...callbacks,
\t\t\tpauseable: {
\t\t\t\tsetPaused(paused) {
\t\t\t\t\tconst fixture = window.__ytNativePlayerFixture;
\t\t\t\t\tconst video = document.querySelector('#movie_player video');
\t\t\t\t\tconst currentVideo = video === fixture?.first ? 'first' :
\t\t\t\t\t\tvideo === fixture?.replacement ? 'replacement' : 'absent';
\t\t\t\t\tconst record = { phase: nativePlayerProbe.phase, paused,
\t\t\t\t\t\tcurrentVideo, atMs: performance.now() };
\t\t\t\t\tif (nativePlayerProbe.calls.length < ${EVENT_LIMIT}) nativePlayerProbe.calls.push(record);
\t\t\t\t\telse nativePlayerProbe.overflow++;
\t\t\t\t\treturn Reflect.apply(originalSetPaused, originalPauseable, [paused]);
\t\t\t\t},
\t\t\t},
\t\t}]);
\t};`;
  return source.replace(ENTRY_MARKER, `${insertion}${ENTRY_MARKER}`);
}

async function snapshot(page: Page, phase: string): Promise<Snapshot> {
  return page.evaluate((label) => {
    const fixture = window.__ytNativePlayerFixture;
    const probe = window.__ytNativePlayerProbe;
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    if (!fixture || !probe || !video) throw new Error('Native player fixture disappeared');
    return {
      phase: label,
      url: location.href,
      visibility: document.visibilityState,
      timeOrigin: performance.timeOrigin,
      starts: probe.starts,
      currentVideo:
        video === fixture.first
          ? 'first'
          : video === fixture.replacement
            ? 'replacement'
            : 'absent',
      paused: video.paused,
      time: video.currentTime,
      width: video.videoWidth,
      height: video.videoHeight,
      readyState: video.readyState,
      mediaError: video.error?.code ?? null,
      currentSrc: video.currentSrc,
      currentSrcKind: video.srcObject
        ? 'stream'
        : video.currentSrc.startsWith('blob:')
          ? 'blob'
          : 'other',
      sourceFrames: fixture.sourceFrames,
      videoFrames: { ...fixture.videoFrames },
      autoplay: fixture.autoplay,
      trustedActions: [...fixture.trustedActions],
      recordedBytes: fixture.recordedBytes,
      recordedChunks: fixture.chunks.length,
      recordedMime: fixture.recordedMime,
      headChunks: fixture.headChunks,
      headBufferedEnd: fixture.headBufferedEnd,
      oldPauseBefore: fixture.oldPauseBefore,
      events: [...fixture.events],
      eventOverflow: fixture.eventOverflow,
      calls: [...probe.calls],
      callOverflow: probe.overflow,
      actionErrors: [...fixture.actionErrors],
      liveIds: Array.from(
        document.querySelectorAll('#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p'),
        (element) => element.getAttribute('data-message-id') ?? ''
      ).slice(-32),
      debug: document.querySelector('#yt-chat-overlay-debug > div')?.textContent ?? null,
    };
  }, phase);
}

function assertHealthy(state: Snapshot, expectedVideo: 'first' | 'replacement'): void {
  assert.equal(state.url, FIXTURE_URL);
  assert.equal(state.visibility, 'visible');
  assert.equal(state.currentVideo, expectedVideo);
  assert.equal(state.paused, false);
  assert(state.time > 0.2, 'Native video time did not progress');
  assert(state.width > 0 && state.height > 0, 'Native video dimensions are unavailable');
  assert(state.readyState >= 2, 'Native video has no current frame');
  assert.equal(state.mediaError, null);
  assert.equal(state.eventOverflow, 0);
  assert.equal(state.callOverflow, 0);
  assert.deepEqual(state.actionErrors, []);
}

async function appendChat(page: Page, id: string): Promise<void> {
  await page.evaluate((messageId) => {
    const items = document.querySelector('yt-live-chat-item-list-renderer #items');
    if (!items) throw new Error('Owned chat item container disappeared');
    const renderer = document.createElement('yt-live-chat-text-message-renderer');
    renderer.id = messageId;
    const author = document.createElement('span');
    author.id = 'author-name';
    author.textContent = 'Native fixture author';
    const message = document.createElement('span');
    message.id = 'message';
    message.textContent = `Player boundary ${messageId}`;
    renderer.append(author, message);
    items.append(renderer);
  }, id);
}

async function waitForOneLive(page: Page, id: string): Promise<void> {
  await page.waitForFunction(
    (messageId) =>
      Array.from(
        document.querySelectorAll('#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p')
      ).filter((element) => element.getAttribute('data-message-id') === messageId).length === 1,
    id,
    { timeout: 8_000 }
  );
}

async function setPhase(page: Page, phase: string): Promise<void> {
  await page.evaluate((value) => {
    const probe = window.__ytNativePlayerProbe;
    if (!probe) throw new Error('Native player probe disappeared');
    probe.phase = value;
  }, phase);
}

async function waitForCall(page: Page, phase: string, paused: boolean): Promise<void> {
  await page.waitForFunction(
    ({ phase, paused }) =>
      window.__ytNativePlayerProbe?.calls.some(
        (call) => call.phase === phase && call.paused === paused
      ) === true,
    { phase, paused },
    { timeout: 6_000 }
  );
}

/** Observe readiness without granting the user activation under test. */
async function waitForAutoplayDecision(context: BrowserContext, page: Page): Promise<void> {
  const session = await context.newCDPSession(page);
  try {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const reply = await session.send('Runtime.evaluate', {
        expression:
          '({ ready: Boolean(window.__ytNativePlayerFixture?.autoplay), error: window.__ytNativePlayerSetupError ?? null })',
        userGesture: false,
        returnByValue: true,
      });
      assert(!reply.exceptionDetails, 'Native autoplay decision readback failed');
      const value = reply.result.value as { ready: boolean; error: string | null };
      assert.equal(value.error, null, 'Native autoplay setup failed: ' + value.error);
      if (value.ready) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Native autoplay decision was not recorded before its deadline');
  } finally {
    await session.detach();
  }
}

/** Installed Chrome, natural autoplay policy, actual media starvation and element rebinding. */
export async function runNativePlayerBoundaries({
  context,
  root,
  output,
  extensionId,
}: {
  context: BrowserContext;
  root: string;
  output: string;
  extensionId: string;
}): Promise<Record<string, unknown>> {
  const source = await readFile(join(root, 'dist-extension/page-script.js'), 'utf8');
  const instrumentedSource = instrumentPageScript(source);
  const preview = await readFile(join(root, 'test/visual/preview.html'), 'utf8');
  const html = buildVisibleWatchHtml(preview, 'Native player boundary video')
    .replace(
      '<div id="chat">',
      '<div id="chat" class="ytd-live-chat-frame" style="min-height:1px">'
    )
    .replace(
      '</body>',
      '<div id="native-player-controls"><button id="native-play">Play</button>' +
        '<button id="native-stall-play">Play recorded segment</button>' +
        '<button id="native-replace">Replace video</button>' +
        '<button id="native-old-play">Play retired video</button>' +
        '<button id="native-old-pause">Pause retired video</button>' +
        '<button id="native-new-pause">Pause current video</button>' +
        '<button id="native-new-play">Resume current video</button></div></body>'
    );
  const page = await context.newPage();
  const states: Snapshot[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  let pageErrorOverflow = 0;
  let consoleErrorOverflow = 0;
  let documentRequests = 0;
  let chatRequests = 0;
  let imageRequests = 0;
  let imageControl: { currentSrc: string; width: number; height: number } | null = null;
  let probe: NativePageScriptProbe | undefined;
  let probeProvenance: NativePageScriptProbe['provenance'] | null = null;
  let routeRegistered = false;
  let primaryError: unknown;
  let scenarioError: unknown;
  let currentState: Snapshot | null = null;
  let result: Record<string, unknown> | undefined;
  const cleanup: Record<string, unknown> = {};
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
    if (url.href === IMAGE_URL && route.request().resourceType() === 'image') {
      imageRequests++;
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: { 'access-control-allow-origin': 'https://www.youtube.com' },
        body: RED_PNG,
      });
    }
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
                {
                  timedContinuationData: { continuation: 'windows-player-next', timeoutMs: 30_000 },
                },
              ],
            },
          },
        },
      });
    }
    return route.fulfill({
      status: 403,
      contentType: 'text/plain',
      body: 'Blocked by player fixture',
    });
  };

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
        currentVideoEndpoint: { watchEndpoint: { videoId: 'windowsPlayerBoundaries' } },
        contents: {
          twoColumnWatchNextResults: {
            conversationBar: {
              liveChatRenderer: {
                isReplay: false,
                continuations: [
                  {
                    timedContinuationData: {
                      continuation: 'windows-player-live',
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
    // Playwright function evaluation grants user activation. Decide autoplay
    // inside the document before using any page evaluation or locator polling.
    await page.addInitScript(
      ({ eventLimit, byteLimit }) => {
        document.addEventListener(
          'DOMContentLoaded',
          () => {
            void (async () => {
              const video = document.querySelector<HTMLVideoElement>('#movie_player video');
              if (!video) throw new Error('Owned video is absent');
              if (typeof HTMLCanvasElement.prototype.captureStream !== 'function')
                throw new Error('Native canvas capture is unavailable');
              if (typeof video.requestVideoFrameCallback !== 'function')
                throw new Error('Native video frame callbacks are unavailable');
              if (!navigator.userActivation || navigator.userActivation.hasBeenActive)
                throw new Error('Autoplay admission is contaminated by a prior user activation');
              const canvas = document.createElement('canvas');
              canvas.width = 160;
              canvas.height = 90;
              const drawing = canvas.getContext('2d');
              if (!drawing) throw new Error('Native canvas drawing is unavailable');
              const audio = new AudioContext();
              const destination = audio.createMediaStreamDestination();
              const oscillator = audio.createOscillator();
              const gain = audio.createGain();
              gain.gain.value = 0.01;
              oscillator.frequency.value = 220;
              oscillator.connect(gain);
              gain.connect(destination);
              oscillator.start();
              const capture = canvas.captureStream(20);
              const stream = new MediaStream([
                ...capture.getVideoTracks(),
                ...destination.stream.getAudioTracks(),
              ]);
              if (stream.getVideoTracks().length !== 1 || stream.getAudioTracks().length !== 1)
                throw new Error('Owned stream lacks its native video or audio track');
              const waitForEvent = (
                target: EventTarget,
                success: string,
                failure: string,
                trigger: () => void
              ) =>
                new Promise<void>((resolve, reject) => {
                  const finish = (error?: unknown) => {
                    clearTimeout(timer);
                    target.removeEventListener(success, onSuccess);
                    target.removeEventListener(failure, onFailure);
                    if (error) reject(error);
                    else resolve();
                  };
                  const onSuccess = () => finish();
                  const onFailure = () => finish(new Error(`Native ${failure} event`));
                  const timer = setTimeout(
                    () => finish(new Error(`Native ${success} event timed out`)),
                    5_000
                  );
                  target.addEventListener(success, onSuccess);
                  target.addEventListener(failure, onFailure);
                  try {
                    trigger();
                  } catch (error) {
                    finish(error);
                  }
                });
              const fixture: PlayerFixture = {
                first: video,
                replacement: null,
                stream,
                audio,
                oscillator,
                recorder: null,
                chunks: [],
                recordedBytes: 0,
                mediaSource: null,
                sourceBuffer: null,
                objectUrl: null,
                animationFrame: 0,
                frameCallbacks: { first: null, replacement: null },
                sourceFrames: 0,
                videoFrames: { first: 0, replacement: 0 },
                events: [],
                eventOverflow: 0,
                actionErrors: [],
                autoplay: null,
                trustedActions: [],
                recordedMime: null,
                pendingChunkReads: [],
                waitForEvent,
                headChunks: 0,
                headBufferedEnd: null,
                oldPauseBefore: null,
              };
              window.__ytNativePlayerFixture = fixture;
              const paint = () => {
                drawing.fillStyle = fixture.sourceFrames % 2 ? '#088' : '#880';
                drawing.fillRect(0, 0, canvas.width, canvas.height);
                fixture.sourceFrames++;
                fixture.animationFrame = requestAnimationFrame(paint);
              };
              paint();
              const recordVideo = (item: HTMLVideoElement, source: 'first' | 'replacement') => {
                for (const type of ['pause', 'play', 'playing', 'waiting', 'stalled', 'error']) {
                  item.addEventListener(type, (event) => {
                    const record: PlayerEvent = {
                      phase: window.__ytNativePlayerProbe?.phase ?? 'missing',
                      source,
                      type,
                      trusted: event.isTrusted,
                      paused: item.paused,
                      time: item.currentTime,
                      readyState: item.readyState,
                      atMs: performance.now(),
                    };
                    if (fixture.events.length < eventLimit) fixture.events.push(record);
                    else fixture.eventOverflow++;
                  });
                }
                const nextFrame = () => {
                  fixture.videoFrames[source]++;
                  fixture.frameCallbacks[source] = item.requestVideoFrameCallback(nextFrame);
                };
                fixture.frameCallbacks[source] = item.requestVideoFrameCallback(nextFrame);
              };
              recordVideo(video, 'first');
              const action = (id: string, callback: () => Promise<unknown> | void) => {
                const button = document.getElementById(id);
                if (!(button instanceof HTMLButtonElement))
                  throw new Error(`Missing ${id} control`);
                button.addEventListener('click', (event) => {
                  if (!event.isTrusted) {
                    fixture.actionErrors.push(`${id}: untrusted click`);
                    return;
                  }
                  fixture.trustedActions.push(id);
                  void Promise.resolve()
                    .then(callback)
                    .catch((error: unknown) =>
                      fixture.actionErrors.push(`${id}: ${String(error)}`.slice(0, 180))
                    );
                });
              };
              action('native-play', async () => {
                await audio.resume();
                await video.play();
                if (!MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus'))
                  throw new Error('Native VP8/Opus MediaRecorder is unavailable');
                const recorder = new MediaRecorder(stream, {
                  mimeType: 'video/webm;codecs=vp8,opus',
                });
                fixture.recorder = recorder;
                fixture.recordedMime = recorder.mimeType;
                recorder.addEventListener('dataavailable', (event) => {
                  if (event.data.size === 0) return;
                  const chunkIndex = fixture.pendingChunkReads.length;
                  const read = event.data
                    .arrayBuffer()
                    .then((buffer) => {
                      fixture.recordedBytes += buffer.byteLength;
                      if (fixture.recordedBytes > byteLimit)
                        fixture.actionErrors.push('Recorded native bytes exceeded fixture bound');
                      else fixture.chunks[chunkIndex] = new Uint8Array(buffer);
                    })
                    .catch((error: unknown) => {
                      fixture.actionErrors.push(
                        `Native chunk read failed: ${String(error)}`.slice(0, 180)
                      );
                    });
                  fixture.pendingChunkReads.push(read);
                });
                recorder.addEventListener('error', (event) => {
                  fixture.actionErrors.push(`Native recorder error: ${event.type}`);
                });
                recorder.start(500);
              });
              action('native-stall-play', () => video.play());
              action('native-replace', async () => {
                if (fixture.replacement) throw new Error('Video replacement repeated');
                const next = document.createElement('video');
                next.setAttribute('aria-label', 'Replacement native video');
                next.style.cssText = video.style.cssText;
                next.playsInline = true;
                next.muted = false;
                recordVideo(next, 'replacement');
                fixture.replacement = next;
                video.replaceWith(next);
                document.body.append(video);
                video.style.display = 'none';
                next.srcObject = stream;
                await next.play();
              });
              action('native-old-play', async () => {
                if (!fixture.replacement) throw new Error('Replacement video is absent');
                video.srcObject = stream;
                await video.play();
              });
              action('native-old-pause', () => {
                fixture.oldPauseBefore = video.paused;
                if (video.paused) throw new Error('Retired video was already paused');
                video.pause();
              });
              action('native-new-pause', () => {
                if (!fixture.replacement) throw new Error('Replacement video is absent');
                fixture.replacement.pause();
              });
              action('native-new-play', () => {
                if (!fixture.replacement) throw new Error('Replacement video is absent');
                return fixture.replacement.play();
              });
              video.playsInline = true;
              video.muted = false;
              video.volume = 0.01;
              video.srcObject = stream;

              const deadline = performance.now() + 5000;
              while (window.__ytNativePlayerProbe?.starts !== 1) {
                if (performance.now() >= deadline)
                  throw new Error('Native controller did not start before autoplay');
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
              window.__ytNativePlayerProbe.phase = 'autoplay-denial';

              const activationBefore = navigator.userActivation.hasBeenActive;
              let rejection: string | null = null;
              let timeout: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  fixture.first.play(),
                  new Promise<never>((_, reject) => {
                    timeout = setTimeout(
                      () => reject(new Error('Autoplay decision timed out')),
                      5_000
                    );
                  }),
                ]);
              } catch (error) {
                rejection = error instanceof DOMException ? error.name : String(error);
              } finally {
                clearTimeout(timeout);
              }
              fixture.autoplay = { activationBefore, rejection };
            })().catch((error: unknown) => {
              window.__ytNativePlayerSetupError = String(error);
            });
          },
          { once: true }
        );
      },
      { eventLimit: EVENT_LIMIT, byteLimit: BYTE_LIMIT }
    );
    probe = await installNativePageScriptProbe({
      context,
      root,
      extensionId,
      fixtureUrl: FIXTURE_URL,
      instrumentedSource,
    });
    probeProvenance = probe.provenance;
    await probe.assertReady();
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await waitForAutoplayDecision(context, page);
    await page.bringToFront();
    await page.waitForFunction(() => document.visibilityState === 'visible', undefined, {
      timeout: 5_000,
    });
    await page
      .locator('#yt-live-chat-overlay canvas')
      .waitFor({ state: 'attached', timeout: 15_000 });
    await probe.assertInjected();
    await page.waitForFunction(() => window.__ytNativePlayerProbe?.starts === 1, undefined, {
      timeout: 5_000,
    });
    await probe.restore();
    probe = undefined;

    const denied = await snapshot(page, 'autoplay-denial');
    states.push(denied);
    assert.equal(denied.autoplay?.activationBefore, false);
    assert.equal(
      denied.autoplay?.rejection,
      'NotAllowedError',
      'Native autoplay denial was absent'
    );
    assert.equal(denied.paused, true);
    assert.equal(denied.mediaError, null);
    assert.equal(denied.starts, 1);
    assert(
      denied.calls.some((call) => call.paused === true),
      'Production controller did not preserve the autoplay-blocked pause'
    );
    await appendChat(page, DENIED_ID);
    await page.waitForTimeout(300);
    const deniedAfterChat = await snapshot(page, 'autoplay-denial-chat');
    states.push(deniedAfterChat);
    assert(!deniedAfterChat.liveIds.includes(DENIED_ID), 'Autoplay denial flowed into the overlay');

    await setPhase(page, 'trusted-play');
    await page.locator('#native-play').click();
    await waitForCall(page, 'trusted-play', false);
    await page.waitForFunction(
      () => {
        const fixture = window.__ytNativePlayerFixture;
        const video = fixture?.first;
        return (
          video &&
          !video.paused &&
          video.currentTime > 0.25 &&
          video.videoWidth > 0 &&
          video.videoHeight > 0 &&
          (fixture?.videoFrames.first ?? 0) > 2 &&
          fixture?.recorder?.state === 'recording'
        );
      },
      undefined,
      { timeout: 8_000 }
    );
    await appendChat(page, HEALTHY_ID);
    await waitForOneLive(page, DENIED_ID);
    await waitForOneLive(page, HEALTHY_ID);
    const healthy = await snapshot(page, 'trusted-play');
    states.push(healthy);
    assertHealthy(healthy, 'first');
    assert.equal(healthy.currentSrcKind, 'stream');
    assert(healthy.trustedActions.includes('native-play'));
    assert(healthy.liveIds.includes(DENIED_ID));
    assert(healthy.liveIds.includes(HEALTHY_ID));

    // Record native encoded bytes, then expose only an initial segment to the
    // player. MediaSource starvation must cause the browser's own waiting event.
    await page.waitForTimeout(4_000);
    await page.evaluate(async (byteLimit) => {
      const fixture = window.__ytNativePlayerFixture;
      const recorder = fixture?.recorder;
      if (!fixture || !recorder || recorder.state !== 'recording')
        throw new Error('Native recorder stopped before the stall input was ready');
      await fixture.waitForEvent(recorder, 'stop', 'error', () => recorder.stop());
      await Promise.all(fixture.pendingChunkReads);
      if (
        fixture.chunks.length < 3 ||
        fixture.recordedBytes <= 0 ||
        fixture.recordedBytes > byteLimit
      )
        throw new Error('Bounded native recording did not produce enough chunks');
      if (!fixture.recordedMime || !MediaSource.isTypeSupported(fixture.recordedMime))
        throw new Error('Native MediaSource cannot consume the recorded MIME type');
      const mediaSource = new MediaSource();
      fixture.mediaSource = mediaSource;
      fixture.objectUrl = URL.createObjectURL(mediaSource);
      await fixture.waitForEvent(mediaSource, 'sourceopen', 'sourceended', () => {
        fixture.first.srcObject = null;
        fixture.first.src = fixture.objectUrl ?? '';
        fixture.first.load();
      });
      fixture.sourceBuffer = mediaSource.addSourceBuffer(fixture.recordedMime);
      const append = async (bytes: Uint8Array) => {
        const sourceBuffer = fixture.sourceBuffer;
        if (!sourceBuffer) throw new Error('Native SourceBuffer disappeared');
        await fixture.waitForEvent(sourceBuffer, 'updateend', 'error', () =>
          sourceBuffer.appendBuffer(new Uint8Array(bytes))
        );
      };
      const head = Math.max(1, Math.floor(fixture.chunks.length / 3));
      for (const bytes of fixture.chunks.slice(0, head)) await append(bytes);
      fixture.headChunks = head;
      const ranges = fixture.first.buffered;
      fixture.headBufferedEnd = ranges.length ? ranges.end(ranges.length - 1) : null;
      if (
        !(
          fixture.headBufferedEnd !== null &&
          fixture.headBufferedEnd > 0.2 &&
          head < fixture.chunks.length
        )
      )
        throw new Error('Initial native segment or withheld recovery bytes are unavailable');
    }, BYTE_LIMIT);
    await setPhase(page, 'buffer-starvation');
    await page.locator('#native-stall-play').click();
    await page.waitForFunction(
      () => {
        const fixture = window.__ytNativePlayerFixture;
        const video = fixture?.first;
        const end = fixture?.headBufferedEnd;
        return (
          video &&
          end !== null &&
          end !== undefined &&
          video.currentTime >= end - 0.15 &&
          video.readyState <= 2 &&
          fixture.events.some(
            (event) =>
              event.phase === 'buffer-starvation' &&
              event.type === 'waiting' &&
              event.trusted &&
              event.time >= end - 0.15
          )
        );
      },
      undefined,
      { timeout: 12_000 }
    );
    await waitForCall(page, 'buffer-starvation', true);
    const stalledBefore = await snapshot(page, 'buffer-starvation-before');
    await appendChat(page, STALLED_ID);
    await page.waitForTimeout(700);
    const stalled = await snapshot(page, 'buffer-starvation');
    states.push(stalled);
    assert.equal(stalled.currentSrcKind, 'blob');
    assert(stalled.currentSrc.startsWith('blob:https://www.youtube.com/'));
    assert.equal(stalled.mediaError, null);
    assert.equal(stalled.paused, false, 'Buffer starvation was mistaken for a user pause');
    assert(stalled.headBufferedEnd !== null);
    assert(stalled.time >= stalled.headBufferedEnd - 0.15);
    assert(
      Math.abs(stalled.time - stalledBefore.time) < 0.06,
      'Native video advanced during starvation'
    );
    assert.equal(
      stalled.videoFrames.first,
      stalledBefore.videoFrames.first,
      'Native decoded frames advanced during starvation'
    );
    assert(!stalled.liveIds.includes(STALLED_ID), 'Paused overlay rendered the held message');
    assert(stalled.trustedActions.includes('native-stall-play'));
    imageControl = await page.evaluate(async (url) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          image.onload = null;
          image.onerror = null;
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(() => finish(new Error('Independent image timed out')), 5_000);
        image.onload = () => finish();
        image.onerror = () => finish(new Error('Independent native image did not decode'));
        image.src = url;
      });
      return {
        currentSrc: image.currentSrc,
        width: image.naturalWidth,
        height: image.naturalHeight,
      };
    }, IMAGE_URL);
    assert.deepEqual(imageControl, { currentSrc: IMAGE_URL, width: 4, height: 4 });
    assert.equal(imageRequests, 1, 'Independent image route was not used once');
    const afterImage = await snapshot(page, 'buffer-starvation-image-control');
    states.push(afterImage);
    assert.equal(afterImage.mediaError, null);
    assert.equal(afterImage.videoFrames.first, stalled.videoFrames.first);
    assert(Math.abs(afterImage.time - stalled.time) < 0.06);

    await setPhase(page, 'buffer-recovery');
    await page.evaluate(async () => {
      const fixture = window.__ytNativePlayerFixture;
      const sourceBuffer = fixture?.sourceBuffer;
      if (!fixture || !sourceBuffer || fixture.headChunks < 1)
        throw new Error('Native recovery SourceBuffer is absent');
      for (const bytes of fixture.chunks.slice(fixture.headChunks)) {
        await fixture.waitForEvent(sourceBuffer, 'updateend', 'error', () =>
          sourceBuffer.appendBuffer(new Uint8Array(bytes))
        );
      }
    });
    await waitForCall(page, 'buffer-recovery', false);
    await page.waitForFunction(
      (before) => {
        const fixture = window.__ytNativePlayerFixture;
        return (
          fixture &&
          !fixture.first.paused &&
          fixture.first.currentTime > before + 0.3 &&
          fixture.videoFrames.first > 0 &&
          fixture.events.some(
            (event) =>
              event.phase === 'buffer-recovery' && event.type === 'playing' && event.trusted
          )
        );
      },
      stalled.time,
      { timeout: 8_000 }
    );
    await waitForOneLive(page, STALLED_ID);
    const recovered = await snapshot(page, 'buffer-recovery');
    states.push(recovered);
    assertHealthy(recovered, 'first');
    assert(recovered.time > stalled.time + 0.3);
    assert(recovered.videoFrames.first > stalled.videoFrames.first);

    await setPhase(page, 'video-replacement');
    await page.locator('#native-replace').click();
    await waitForCall(page, 'video-replacement', false);
    await page.waitForFunction(
      () => {
        const fixture = window.__ytNativePlayerFixture;
        const video = fixture?.replacement;
        return (
          video &&
          video.isConnected &&
          !video.paused &&
          video.currentTime > 0.25 &&
          video.videoWidth > 0 &&
          video.videoHeight > 0 &&
          document.querySelector('#movie_player video') === video
        );
      },
      undefined,
      { timeout: 8_000 }
    );
    // The production observer rebinding is debounced by 100 ms.
    await page.waitForTimeout(250);
    const replacement = await snapshot(page, 'video-replacement');
    states.push(replacement);
    assertHealthy(replacement, 'replacement');
    assert.equal(replacement.currentSrcKind, 'stream');
    await appendChat(page, REPLACED_ID);
    await waitForOneLive(page, REPLACED_ID);

    await setPhase(page, 'retired-video-play');
    await page.locator('#native-old-play').click();
    await page.waitForFunction(
      () => {
        const fixture = window.__ytNativePlayerFixture;
        return (
          fixture &&
          !fixture.first.paused &&
          fixture.first.currentTime > 0.2 &&
          fixture.events.some(
            (event) =>
              event.phase === 'retired-video-play' &&
              event.source === 'first' &&
              event.type === 'playing' &&
              event.trusted
          )
        );
      },
      undefined,
      { timeout: 6_000 }
    );
    const retiredPlaying = await snapshot(page, 'retired-video-play');
    states.push(retiredPlaying);
    assert.equal(
      retiredPlaying.calls.some((call) => call.phase === 'retired-video-play'),
      false,
      'Retired video play affected the current overlay'
    );
    assertHealthy(retiredPlaying, 'replacement');

    await setPhase(page, 'retired-video-pause');
    await page.locator('#native-old-pause').click();
    await page.waitForFunction(
      () =>
        window.__ytNativePlayerFixture?.events.some(
          (event) =>
            event.phase === 'retired-video-pause' &&
            event.source === 'first' &&
            event.type === 'pause' &&
            event.trusted
        ) === true,
      undefined,
      { timeout: 5_000 }
    );
    const retired = await snapshot(page, 'retired-video-pause');
    states.push(retired);
    assert.equal(retired.oldPauseBefore, false, 'Retired video had no live playback to pause');
    assert.equal(
      retired.calls.some((call) => call.phase === 'retired-video-pause' && call.paused),
      false,
      'Retired video pause affected the current overlay'
    );
    assertHealthy(retired, 'replacement');

    await setPhase(page, 'replacement-pause');
    await page.locator('#native-new-pause').click();
    await waitForCall(page, 'replacement-pause', true);
    const pausedReplacement = await snapshot(page, 'replacement-pause');
    states.push(pausedReplacement);
    assert.equal(pausedReplacement.paused, true);
    await setPhase(page, 'replacement-recovery');
    await page.locator('#native-new-play').click();
    await waitForCall(page, 'replacement-recovery', false);
    await page.waitForFunction(
      (before) =>
        (document.querySelector<HTMLVideoElement>('#movie_player video')?.currentTime ?? 0) >
        before + 0.2,
      pausedReplacement.time,
      { timeout: 6_000 }
    );
    const final = await snapshot(page, 'replacement-recovery');
    states.push(final);
    assertHealthy(final, 'replacement');
    assert.equal(final.starts, 1, 'Production controller was unexpectedly restarted');
    assert(
      states.every((state) => state.timeOrigin === denied.timeOrigin),
      'Fixture document changed'
    );
    assert.equal(documentRequests, 1, 'Owned watch document was not routed exactly once');
    assert(chatRequests > 0, 'Healthy chat acquisition did not occur');
    assert.deepEqual(pageErrors, []);
    assert.equal(pageErrorOverflow, 0);
    assert.deepEqual(consoleErrors, []);
    assert.equal(consoleErrorOverflow, 0);
    result = {
      status: 'passed',
      scope:
        'installed Chrome extension; native unmuted autoplay denial, trusted play, encoded MediaSource starvation and recovery, video element rebinding',
      fixtureUrl: FIXTURE_URL,
      probeProvenance,
      documentRequests,
      chatRequests,
      imageRequests,
      imageControl,
      imageControlScope:
        'native image transport and decode while video alone is starved; app image rendering is assessed by the separate image fixture',
      states,
      pageErrors,
      pageErrorOverflow,
      consoleErrors,
      consoleErrorOverflow,
    };
  } catch (error) {
    primaryError = error;
    scenarioError = error;
    try {
      currentState = await snapshot(page, 'failure');
    } catch {
      // Navigation or script injection may have failed before fixture setup.
    }
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      cleanup.media = await page.evaluate(async () => {
        const fixture = window.__ytNativePlayerFixture;
        if (!fixture) return { status: 'fixture-not-started' };
        const videos = [fixture.first, fixture.replacement].filter(
          (video): video is HTMLVideoElement => video !== null
        );
        for (const video of videos) {
          video.pause();
          video.srcObject = null;
          video.removeAttribute('src');
          video.load();
        }
        cancelAnimationFrame(fixture.animationFrame);
        if (fixture.frameCallbacks.first !== null)
          fixture.first.cancelVideoFrameCallback(fixture.frameCallbacks.first);
        if (fixture.frameCallbacks.replacement !== null && fixture.replacement)
          fixture.replacement.cancelVideoFrameCallback(fixture.frameCallbacks.replacement);
        if (fixture.recorder?.state === 'recording') fixture.recorder.stop();
        fixture.oscillator.stop();
        for (const track of fixture.stream.getTracks()) track.stop();
        await fixture.audio.close();
        if (fixture.objectUrl) URL.revokeObjectURL(fixture.objectUrl);
        return {
          status: 'cleaned',
          tracksEnded: fixture.stream.getTracks().every((track) => track.readyState === 'ended'),
          audioClosed: fixture.audio.state === 'closed',
          sourcesDetached: videos.every(
            (video) => video.srcObject === null && !video.hasAttribute('src')
          ),
        };
      });
      const media = cleanup.media;
      if (
        result &&
        (!media ||
          typeof media !== 'object' ||
          !('status' in media) ||
          media.status !== 'cleaned' ||
          !('tracksEnded' in media) ||
          !media.tracksEnded ||
          !('audioClosed' in media) ||
          !media.audioClosed ||
          !('sourcesDetached' in media) ||
          !media.sourcesDetached)
      )
        cleanupErrors.push(new Error('Owned player media cleanup was incomplete'));
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (probe) {
        await probe.restore();
        cleanup.probeRestored = true;
      } else cleanup.probeRestored = 'already-restored';
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (routeRegistered) await page.unroute('**/*', routeFixture);
      cleanup.routeRemoved = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await page.close();
      cleanup.pageClosed = page.isClosed();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      cleanup.errors = cleanupErrors.map(errorText);
      primaryError = primaryError
        ? new AggregateError([primaryError, ...cleanupErrors], 'Player scenario and cleanup failed')
        : new AggregateError(cleanupErrors, 'Player cleanup failed');
    }
  }
  if (primaryError) {
    try {
      await writeFile(
        join(output, 'native-player-boundaries-failure.json'),
        JSON.stringify(
          {
            status: 'failed',
            error: errorText(primaryError),
            scenarioError: scenarioError ? errorText(scenarioError) : null,
            probeProvenance,
            documentRequests,
            chatRequests,
            imageRequests,
            imageControl,
            states,
            currentState,
            pageErrors,
            pageErrorOverflow,
            consoleErrors,
            consoleErrorOverflow,
            cleanup,
          },
          null,
          2
        )
      );
    } catch (writeError) {
      throw new AggregateError([primaryError, writeError], 'Player failure receipt write failed');
    }
    throw primaryError;
  }
  assert(result);
  result.cleanup = cleanup;
  return result;
}
