// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Bounded #327 baseline: controlled viewing tasks, not a human usability verdict. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, win32 } from 'node:path';
import { promisify } from 'node:util';

import type { Browser, BrowserContext, Page } from '@playwright/test';

import { mediaResponse } from './reload-feedback.ts';

const WATCH_URL = 'https://www.youtube.com/watch?v=windowsAcceptance';
const REPLAY_URL = 'https://www.youtube.com/watch?v=windowsAcceptanceReplay';
const SETTINGS_KEY = 'yt-live-chat-overlay-settings';
const MODAL = '#yt-chat-overlay-settings-backdrop';
const VIDEO_PREFIX = '/viewing-';
const IME_TITLE = 'YT Viewing IME Checkpoint';
const execFileAsync = promisify(execFile);
const MEDIA = {
  bright: 'de75569b7fd474c55080d8bc35aeb02b8a629010729de8dbd30dfe925522c14f',
  dark: '5c58845db4a7f37ddd3a15c7bd764e1cb05f28301ffe3d94234c9184f812d89a',
  detailed: 'dd98dd1a1b0a45847d1c199d4a1c74ea96867a813a9e79a9bcb987d737c0c484',
} as const;
type Scene = keyof typeof MEDIA;
type Case = { id: string; observations: unknown[]; screenshots: string[]; error?: string };
type RouteState = {
  disconnected: boolean;
  servedIds: string[];
  mediaRanges: string[];
  replayBatch?: string;
  replayRequests?: Array<{
    method: string;
    contentType: string | null;
    continuation: string | null;
    offsetMs: number | null;
    actions: number;
  }>;
};

declare global {
  interface Window {
    __ytViewingDenyWrites?: boolean;
    __ytViewingImeEvents?: Array<Record<string, unknown>>;
  }
}

type ImeCheckpoint = {
  title: string;
  focus: string | null;
  input: string | null;
  events: Array<Record<string, unknown>>;
  videoPaused: boolean | null;
  videoTime: number | null;
  overlayPaused: boolean;
};

/** An opt-in selector keeps ordinary baseline runs free of native input. */
export async function readViewingImeSelection(root: string): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(
      join(root, 'validation/windows/inputs/viewing-experience-ime.json'),
      'utf8'
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  assert.deepEqual(JSON.parse(contents), { enabled: true }, 'Invalid viewing IME selector');
  return true;
}

async function ownedBrowserIdentity(browser: Browser): Promise<{ pid: number; profile: string }> {
  const session = await browser.newBrowserCDPSession();
  try {
    const processInfo = await session.send('SystemInfo.getProcessInfo');
    const browsers = processInfo.processInfo.filter((entry) => entry.type === 'browser');
    assert.equal(browsers.length, 1, 'CDP must expose exactly one browser process');
    const pid = browsers[0]?.id;
    assert(
      typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff,
      'Invalid browser PID'
    );
    const commandLine = await session.send('Browser.getBrowserCommandLine');
    const profiles: string[] = [];
    for (const [index, arg] of commandLine.arguments.entries()) {
      if (arg.toLowerCase().startsWith('--user-data-dir=')) {
        profiles.push(arg.slice('--user-data-dir='.length));
      } else if (arg.toLowerCase() === '--user-data-dir') {
        profiles.push(commandLine.arguments[index + 1] ?? '');
      }
    }
    assert.equal(profiles.length, 1, 'Browser must expose one user-data-dir');
    const profile = profiles[0];
    assert(
      profile && win32.isAbsolute(profile),
      'Browser profile must be an absolute Windows path'
    );
    return { pid, profile };
  } finally {
    await session.detach();
  }
}

async function runNativeImeAction({
  root,
  output,
  identity,
  sequence,
  koreanLayout = false,
}: {
  root: string;
  output: string;
  identity: { pid: number; profile: string };
  sequence: 'ComposeCurrent' | 'ComposeToggleRoundTrip' | 'CtrlSpaceRoundTrip';
  koreanLayout?: boolean;
}): Promise<{ receiptFile: string; receipt: unknown; error: string | null }> {
  assert.equal(process.platform, 'win32', 'Native IME requires the Windows runner');
  const receiptFile = `viewing-ime-${sequence.toLowerCase()}.json`;
  const receiptPath = join(output, receiptFile);
  const systemRoot = process.env.SystemRoot;
  assert(systemRoot && win32.isAbsolute(systemRoot), 'Windows SystemRoot is unavailable');
  const powershell = win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(root, 'validation/windows/native-ime.ps1'),
    '-Sequence',
    sequence,
    '-ExpectedWindowTitle',
    IME_TITLE,
    '-ExpectedProfileDirectory',
    identity.profile,
    '-OwnedOutputDirectory',
    output,
    '-ReceiptPath',
    receiptPath,
    '-ExpectedBrowserPID',
    String(identity.pid),
  ];
  if (koreanLayout) args.push('-RequestExistingKoreanLayout');
  let error: string | null = null;
  try {
    await execFileAsync(powershell, args, { timeout: 45_000, maxBuffer: 4_096, windowsHide: true });
  } catch (cause) {
    const failure = cause as { code?: string | number; signal?: string; killed?: boolean };
    error = `Native helper failed (code=${String(failure.code ?? 'unknown')}, signal=${String(failure.signal ?? 'none')}, timedOut=${failure.killed === true})`;
  }
  let receipt: unknown = null;
  try {
    receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  } catch (cause) {
    const failure = cause as NodeJS.ErrnoException;
    error ??= `Native helper left no readable receipt (${failure.code ?? 'invalid-json'})`;
  }
  return { receiptFile, receipt, error };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function watchPage(html: string): string {
  assert.match(html, /<video aria-label="Acceptance fixture video"/u);
  return html
    .replace(
      '</head>',
      '<style>body.yt-viewing-theater .player-wrapper{max-width:none!important;width:100vw!important}' +
        'body.yt-viewing-theater #movie_player{height:85vh!important}' +
        '#yt-viewing-controls{position:fixed;right:8px;bottom:8px;z-index:1000}</style></head>'
    )
    .replace(
      '</body>',
      '<div id="yt-viewing-controls"><button id="yt-viewing-theater" type="button">Theater</button>' +
        '<button id="yt-viewing-fullscreen" type="button">Fullscreen</button></div></body>'
    );
}

function chatItem(id: string, kind: 'text' | 'paid', text: string): unknown {
  const authorName = { simpleText: `Viewing author ${id}` };
  if (kind === 'paid') {
    return {
      addChatItemAction: {
        item: {
          liveChatPaidMessageRenderer: {
            id,
            authorName,
            purchaseAmountText: { simpleText: '$5.00' },
            message: { runs: [{ text }] },
          },
        },
      },
    };
  }
  return {
    addChatItemAction: {
      item: { liveChatTextMessageRenderer: { id, authorName, message: { runs: [{ text }] } } },
    },
  };
}

function messages(batch: string, count: number, replay: boolean, offsetMs = 0): unknown[] {
  const texts = [
    'Short',
    'A long English comment about keeping the subtitle and player controls readable while comments move across the detailed footage.',
    '😀🌟 긴 한국어 댓글에서 자막과 재생 버튼을 가리지 않고 핵심 내용을 끝까지 읽을 수 있는지 확인합니다.',
    '有料メッセージと字幕の読みやすさを確認する長い日本語コメントです。',
    'Original chat for the controlled English to Korean translation example.',
  ];
  return Array.from({ length: count }, (_, index) => {
    const id = `viewing-${batch}-${index}`;
    const item = chatItem(id, index % 5 === 3 ? 'paid' : 'text', texts[index % texts.length] ?? '');
    return replay
      ? { replayChatItemAction: { videoOffsetTimeMsec: offsetMs, actions: [item] } }
      : item;
  });
}

async function installFixture(
  context: BrowserContext,
  userscript: string,
  html: string,
  media: Record<Scene, Buffer>,
  state: RouteState,
  language = 'en'
): Promise<void> {
  await context.route(/^https?:\/\//u, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'www.youtube.com') {
      await route.fulfill({ status: 204 });
      return;
    }
    if (route.request().resourceType() === 'document') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
      return;
    }
    const scene = url.pathname.slice(VIDEO_PREFIX.length, -'.mp4'.length) as Scene;
    if (url.pathname.startsWith(VIDEO_PREFIX) && Object.hasOwn(MEDIA, scene)) {
      const bytes = media[scene];
      const range = route.request().headers()['range'] ?? null;
      if (state.mediaRanges.length < 30) state.mediaRanges.push(range ?? 'none');
      await route.fulfill({ ...mediaResponse(bytes, range), contentType: 'video/mp4' });
      return;
    }
    if (url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat')) {
      if (state.disconnected) {
        await route.fulfill({ status: 503, body: 'Controlled disconnection' });
        return;
      }
      const replay = url.pathname.endsWith('get_live_chat_replay');
      let batch = url.searchParams.get('fixture-batch');
      let count = Math.min(15, Math.max(0, Number(url.searchParams.get('fixture-count') ?? 0)));
      let offsetMs = 0;
      if (replay && state.replayBatch) {
        const body: unknown =
          route.request().method() === 'POST' ? route.request().postDataJSON() : null;
        const requestBody =
          body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
        const playerState = requestBody.currentPlayerState;
        const rawOffset =
          playerState && typeof playerState === 'object'
            ? (playerState as Record<string, unknown>).playerOffsetMs
            : null;
        const parsedOffset = typeof rawOffset === 'string' ? Number(rawOffset) : null;
        const validOffset =
          parsedOffset !== null && Number.isFinite(parsedOffset) && parsedOffset >= 0;
        if (validOffset && parsedOffset < 5_000) {
          batch = state.replayBatch;
          count = 2;
          offsetMs = parsedOffset;
        }
        state.replayRequests ??= [];
        if (state.replayRequests.length < 30) {
          state.replayRequests.push({
            method: route.request().method(),
            contentType: route.request().headers()['content-type'] ?? null,
            continuation:
              typeof requestBody.continuation === 'string' ? requestBody.continuation : null,
            offsetMs: validOffset ? parsedOffset : null,
            actions: batch ? count : 0,
          });
        }
      }
      const actions = batch ? messages(batch, count, replay, offsetMs) : [];
      if (batch) {
        for (let index = 0; index < count; index++) {
          const id = `viewing-${batch}-${index}`;
          if (!state.servedIds.includes(id)) state.servedIds.push(id);
        }
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          continuationContents: {
            liveChatContinuation: {
              actions,
              continuations: [
                replay
                  ? { playerSeekContinuationData: { continuation: 'viewing-replay' } }
                  : { timedContinuationData: { continuation: 'viewing-live', timeoutMs: 1_000 } },
              ],
            },
          },
        },
      });
      return;
    }
    await route.fulfill({ status: 204 });
  });
  await context.addInitScript(
    ({ key, selectedLanguage }) => {
      (window as Window & { unsafeWindow?: Window }).unsafeWindow = window;
      window.ytcfg = {
        data_: {
          INNERTUBE_API_KEY: 'viewing-fixture-key',
          INNERTUBE_CONTEXT_CLIENT_NAME: '1',
          INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
          INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
        },
      };
      const replay = location.search.includes('windowsAcceptanceReplay');
      window.ytInitialData = {
        currentVideoEndpoint: {
          watchEndpoint: { videoId: replay ? 'windowsAcceptanceReplay' : 'windowsAcceptance' },
        },
        contents: {
          twoColumnWatchNextResults: {
            conversationBar: {
              liveChatRenderer: {
                isReplay: replay,
                continuations: [
                  replay
                    ? { playerSeekContinuationData: { continuation: 'viewing-replay' } }
                    : {
                        timedContinuationData: { continuation: 'viewing-live', timeoutMs: 1_000 },
                      },
                ],
              },
            },
          },
        },
      };
      if (localStorage.getItem(key) === null) {
        localStorage.setItem(
          key,
          JSON.stringify({
            language: selectedLanguage,
            livePollFailureLimit: 3,
            livePollFallbackMs: 500,
          })
        );
      }
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (storageKey: string, value: string): void {
        if (storageKey === key && window.__ytViewingDenyWrites) {
          throw new DOMException('Controlled write denial', 'QuotaExceededError');
        }
        originalSetItem.call(this, storageKey, value);
      };
      Object.defineProperty(window, 'Translator', {
        configurable: true,
        value: {
          availability: async () => 'available',
          create: async () => ({
            translate: async (text: string) => `번역: ${text}`,
            destroy() {},
          }),
        },
      });
      document.addEventListener('DOMContentLoaded', () => {
        document.querySelector('#yt-viewing-theater')?.addEventListener('click', () => {
          document.body.classList.toggle('yt-viewing-theater');
        });
        document.querySelector('#yt-viewing-fullscreen')?.addEventListener('click', () => {
          const player = document.querySelector<HTMLElement>('#movie_player');
          if (document.fullscreenElement) void document.exitFullscreen();
          else if (player) void player.requestFullscreen();
        });
      });
    },
    { key: SETTINGS_KEY, selectedLanguage: language }
  );
  await context.addInitScript({ content: userscript });
}

async function openPage(context: BrowserContext, replay = false): Promise<Page> {
  const page = await context.newPage();
  await page.goto(replay ? REPLAY_URL : WATCH_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page
    .locator('#yt-live-chat-overlay canvas')
    .waitFor({ state: 'attached', timeout: 15_000 });
  await setScene(page, 'bright');
  return page;
}

async function setScene(page: Page, scene: Scene): Promise<void> {
  await page.evaluate(async (name) => {
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    if (!video) throw new Error('Owned video is missing');
    video.src = `/viewing-${name}.mp4`;
    video.muted = true;
    video.loop = true;
    video.controls = true;
    await video.play();
  }, scene);
  await page.waitForFunction(
    (name) => {
      const video = document.querySelector<HTMLVideoElement>('#movie_player video');
      return Boolean(
        video &&
        video.readyState >= 2 &&
        video.currentTime > 0.05 &&
        video.currentSrc.endsWith(`/viewing-${name}.mp4`)
      );
    },
    scene,
    { timeout: 15_000 }
  );
}

async function assertVideoAdvances(page: Page): Promise<void> {
  const start = await page.evaluate(
    () => document.querySelector<HTMLVideoElement>('#movie_player video')?.currentTime ?? -1
  );
  await page.waitForFunction(
    (before) => {
      const video = document.querySelector<HTMLVideoElement>('#movie_player video');
      return Boolean(
        video &&
        !video.paused &&
        (video.currentTime > before + 0.25 || video.currentTime < before - 1)
      );
    },
    start,
    { timeout: 5_000 }
  );
}

async function openSettings(page: Page, tab = 'comments'): Promise<void> {
  await page.locator('#movie_player').hover();
  await page.locator('#yt-chat-overlay-settings-button').click();
  await page.locator(`${MODAL} #tab-${tab}`).click();
}

async function closeSettings(page: Page): Promise<void> {
  await page.locator(`${MODAL} button.yt-chat-overlay-settings-close`).click();
  await page.locator(MODAL).waitFor({ state: 'hidden' });
}

async function setNumber(
  page: Page,
  name: string,
  displayValue: string,
  storedValue = Number(displayValue)
): Promise<void> {
  await page.locator(`${MODAL} input[name="${name}"]`).fill(displayValue);
  await page.waitForFunction(
    ({ key, expected }) => {
      const settings = window.__ytChatOverlay?.getSettings?.();
      const value = key.startsWith('outline-')
        ? settings?.outline[key.slice('outline-'.length) as keyof typeof settings.outline]
        : settings?.[key as keyof typeof settings];
      return Number(value) === expected;
    },
    { key: name, expected: storedValue },
    { timeout: 10_000 }
  );
}

async function feed(page: Page, batch: string, count: number, replay = false): Promise<string[]> {
  const ids = Array.from({ length: count }, (_, index) => `viewing-${batch}-${index}`);
  await page.evaluate(
    async ({ name, size, endpoint }) => {
      const response = await fetch(
        `/youtubei/v1/live_chat/${endpoint}?fixture-batch=${encodeURIComponent(name)}&fixture-count=${size}`
      );
      if (!response.ok) throw new Error(`Owned chat route returned ${response.status}`);
      await response.json();
    },
    { name: batch, size: count, endpoint: replay ? 'get_live_chat_replay' : 'get_live_chat' }
  );
  return ids;
}

async function waitForAnyRow(page: Page, ids: string[]): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      expected.some((id) =>
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p'
          )
        ).some((row) => row.dataset.messageId === id)
      ),
    ids,
    { timeout: 10_000 }
  );
}

async function snapshot(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    const canvas = document.querySelector<HTMLCanvasElement>('#yt-live-chat-overlay canvas');
    const modal = document.querySelector<HTMLDialogElement>('#yt-chat-overlay-settings-backdrop');
    const player = document.querySelector<HTMLElement>('#movie_player');
    const active = document.activeElement;
    const settings = window.__ytChatOverlay?.getSettings?.() ?? null;
    const rect = (element: Element | null) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        right: box.right,
        bottom: box.bottom,
      };
    };
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas?.getContext('2d') ?? null;
    } catch {
      // A transferred OffscreenCanvas is measured by its DOM geometry only.
    }
    let opaqueBottom = -1;
    let sampledOpaquePixels = 0;
    if (canvas && context && canvas.width && canvas.height) {
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let y = 0; y < canvas.height; y += 4) {
        for (let x = 0; x < canvas.width; x += 4) {
          if ((pixels.data[(y * canvas.width + x) * 4 + 3] ?? 0) > 20) {
            opaqueBottom = y;
            sampledOpaquePixels++;
          }
        }
      }
    }
    return {
      viewport: {
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
        documentScrollWidth: document.documentElement.scrollWidth,
      },
      mediaPreferences: {
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        forcedColors: matchMedia('(forced-colors: active)').matches,
      },
      video: video
        ? {
            src: video.currentSrc,
            time: video.currentTime,
            paused: video.paused,
            readyState: video.readyState,
            controls: video.controls,
            width: video.videoWidth,
            height: video.videoHeight,
          }
        : null,
      player: rect(player),
      canvas: canvas
        ? {
            ...rect(canvas),
            width: canvas.width,
            height: canvas.height,
            opaqueBottom,
            sampledOpaquePixels,
            safeBottomStart: Math.round(canvas.height * (1 - (settings?.safeBottom ?? 0))),
          }
        : null,
      rows: Array.from(
        document.querySelectorAll<HTMLElement>(
          '#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p'
        ),
        (row) => ({ id: row.dataset.messageId, text: row.textContent })
      ).slice(-10),
      pauseVisible: Array.from(
        document.querySelectorAll<HTMLElement>('#yt-live-chat-overlay div')
      ).some((node) => node.textContent === 'Paused' && getComputedStyle(node).display !== 'none'),
      settings,
      modal: modal
        ? {
            open: modal.open,
            bounds: rect(modal),
            scrollWidth: modal.scrollWidth,
            clientWidth: modal.clientWidth,
            scrollHeight: modal.scrollHeight,
            clientHeight: modal.clientHeight,
            activeTab: modal.querySelector('[role="tab"][aria-selected="true"]')?.id ?? null,
            status:
              modal.querySelector('.yt-chat-overlay-settings-runtime-status')?.textContent ?? null,
          }
        : null,
      notice: (() => {
        const element = document.querySelector<HTMLElement>(
          '.yt-chat-overlay-settings-persistence-notice'
        );
        return element
          ? {
              text: element.textContent,
              bounds: rect(element),
              action: element.querySelector('button')?.textContent ?? null,
            }
          : null;
      })(),
      focus: active
        ? {
            tag: active.tagName,
            id: active.id,
            bounds: rect(active),
            outlineWidth: getComputedStyle(active).outlineWidth,
          }
        : null,
      fullscreen: Boolean(document.fullscreenElement),
    };
  });
}

async function screenshot(page: Page, output: string, name: string): Promise<string> {
  const file = `${name}.png`;
  await page.screenshot({ path: join(output, file), timeout: 10_000 });
  return file;
}

async function nativeZoomScreenshot(page: Page, output: string, name: string) {
  const file = `${name}.png`;
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Page.bringToFront');
    // A clipped Playwright screenshot can retain pre-zoom CSS dimensions.
    const { data } = await session.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(data, 'base64');
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await writeFile(join(output, file), bytes);
    return {
      file,
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      sha256: sha256(bytes),
      method: 'cdp-page-capture-screenshot-no-clip',
    };
  } finally {
    await session.detach();
  }
}

async function runCase(id: string, work: (result: Case) => Promise<void>): Promise<Case> {
  const result: Case = { id, observations: [], screenshots: [] };
  try {
    await work(result);
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
  return result;
}

/** Prepare an owned browser focus target for an in-process native Windows input helper. */
async function prepareViewingImeCheckpoint(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.title = 'YT Viewing IME Checkpoint';
    const input = document.createElement('textarea');
    input.id = 'yt-viewing-ime-input';
    input.setAttribute('aria-label', 'Native IME composition checkpoint');
    input.style.cssText =
      'position:fixed;left:12px;top:12px;width:320px;height:80px;z-index:2147483647';
    document.body.appendChild(input);
    window.__ytViewingImeEvents = [];
    for (const type of [
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'beforeinput',
      'input',
      'keydown',
    ]) {
      input.addEventListener(type, (event) => {
        const keyboard = event instanceof KeyboardEvent ? event : null;
        const composition = event instanceof CompositionEvent ? event : null;
        window.__ytViewingImeEvents?.push({
          type,
          trusted: event.isTrusted,
          isComposing: keyboard?.isComposing ?? null,
          key: keyboard?.key ?? null,
          data: composition?.data ?? null,
          atMs: performance.now(),
        });
      });
    }
    document.addEventListener(
      'keydown',
      (event) => {
        if (!event.ctrlKey || event.code !== 'Space') return;
        const focus = document.activeElement?.id ?? null;
        window.__ytViewingImeEvents?.push({
          type: 'document-keydown',
          trusted: event.isTrusted,
          isComposing: event.isComposing,
          focus,
          atMs: performance.now(),
        });
        setTimeout(() => {
          window.__ytViewingImeEvents?.push({
            type: 'post-ctrl-space',
            focus,
            overlayPaused: Array.from(
              document.querySelectorAll<HTMLElement>('#yt-live-chat-overlay div')
            ).some(
              (node) => node.textContent === 'Paused' && getComputedStyle(node).display !== 'none'
            ),
            atMs: performance.now(),
          });
        }, 50);
      },
      true
    );
    input.focus();
  });
}

/** Read evidence after native input; this function never synthesizes a key event. */
async function readViewingImeCheckpoint(page: Page): Promise<ImeCheckpoint> {
  return page.evaluate(() => ({
    title: document.title,
    focus: document.activeElement?.id ?? null,
    input: document.querySelector<HTMLTextAreaElement>('#yt-viewing-ime-input')?.value ?? null,
    events: window.__ytViewingImeEvents ?? [],
    videoPaused: document.querySelector<HTMLVideoElement>('#movie_player video')?.paused ?? null,
    videoTime: document.querySelector<HTMLVideoElement>('#movie_player video')?.currentTime ?? null,
    overlayPaused: Array.from(
      document.querySelectorAll<HTMLElement>('#yt-live-chat-overlay div')
    ).some((node) => node.textContent === 'Paused' && getComputedStyle(node).display !== 'none'),
  }));
}

/** Run the source-bound baseline in the prepared Windows browser. */
export async function runViewingExperienceFixture({
  browser,
  root,
  output,
  userscript,
  watchHtml,
}: {
  browser: Browser;
  root: string;
  output: string;
  userscript: string;
  watchHtml: string;
}) {
  const media = {} as Record<Scene, Buffer>;
  for (const scene of Object.keys(MEDIA) as Scene[]) {
    const bytes = await readFile(join(root, `validation/windows/fixtures/viewing-${scene}.mp4`));
    assert.equal(sha256(bytes), MEDIA[scene], `${scene} owned media changed`);
    media[scene] = bytes;
  }
  const imeRequested = await readViewingImeSelection(root);
  let nativeImeInput: 'not-run' | 'failed' | 'verified' = 'not-run';
  const cases: Case[] = [];
  const pageErrors: string[] = [];
  const state: RouteState = { disconnected: false, servedIds: [], mediaRanges: [] };
  const html = watchPage(watchHtml);
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 720 },
  });
  try {
    await installFixture(context, userscript, html, media, state);
    const page = await openPage(context);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    cases.push(
      await runCase('Y04-live-controls', async (result) => {
        result.observations.push({
          stage: 'fresh',
          state: await snapshot(page),
          firstTimeHumanObserved: false,
        });
        await openSettings(page);
        await setNumber(page, 'fontSize', '26');
        await setNumber(page, 'opacity', '70', 0.7);
        result.observations.push({
          stage: 'size-opacity',
          state: await snapshot(page),
          actionPath: 'gear > Comments > Size / Text opacity',
          visibleShortcutHint: await page
            .locator(MODAL)
            .evaluate((node) => (node.textContent ?? '').includes('Ctrl+Space')),
        });
        result.screenshots.push(await screenshot(page, output, 'viewing-y04-comments-controls'));
        await closeSettings(page);
        const beforePause = await snapshot(page);
        await page.keyboard.press('Control+Space');
        await page
          .locator('#yt-live-chat-overlay')
          .getByText('Paused', { exact: true })
          .waitFor({ state: 'visible' });
        await assertVideoAdvances(page);
        result.observations.push({
          stage: 'overlay-paused',
          beforePause,
          state: await snapshot(page),
          actionPath: 'Ctrl+Space',
        });
        result.screenshots.push(await screenshot(page, output, 'viewing-y04-paused'));
        await page.keyboard.press('Control+Space');
        await page
          .locator('#yt-live-chat-overlay')
          .getByText('Paused', { exact: true })
          .waitFor({ state: 'hidden' });
        result.observations.push({ stage: 'overlay-resumed', state: await snapshot(page) });
        await openSettings(page);
        await page.locator(`${MODAL} input[name="enabled"]`).uncheck();
        await page.waitForFunction(() => window.__ytChatOverlay?.getSettings?.().enabled === false);
        result.observations.push({ stage: 'disabled', state: await snapshot(page) });
        await page.locator(`${MODAL} input[name="enabled"]`).check();
        await page.waitForFunction(() => window.__ytChatOverlay?.getSettings?.().enabled === true);
        await page.locator(`${MODAL} #tab-advanced`).click();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        result.observations.push({
          stage: 'reduced-motion-control',
          label: await page
            .locator(`${MODAL} input[name="ignoreReducedMotion"]`)
            .evaluate((node) => node.closest('label')?.textContent ?? ''),
          state: await snapshot(page),
        });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await closeSettings(page);
      })
    );
  } finally {
    await context.close();
  }
  const viewingState: RouteState = { disconnected: false, servedIds: [], mediaRanges: [] };
  const viewingContext = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 720 },
  });
  try {
    await installFixture(viewingContext, userscript, html, media, viewingState);
    let page = await openPage(viewingContext);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    cases.push(
      await runCase('Y05-moving-video', async (result) => {
        for (const scene of Object.keys(MEDIA) as Scene[]) {
          const baselinePage = await openPage(viewingContext);
          try {
            await setScene(baselinePage, scene);
            const ids = await feed(baselinePage, `low-${scene}`, 2);
            await waitForAnyRow(baselinePage, ids);
            result.observations.push({
              stage: `${scene}-normal-default`,
              ids,
              state: await snapshot(baselinePage),
            });
            result.screenshots.push(
              await screenshot(baselinePage, output, `viewing-y05-${scene}-normal`)
            );
          } finally {
            await baselinePage.close();
          }
        }
        await setScene(page, 'detailed');
        await page.locator('#yt-viewing-theater').click();
        const highIds = await feed(page, 'high-theater', 12);
        await waitForAnyRow(page, highIds);
        result.observations.push({
          stage: 'detailed-theater-high',
          state: await snapshot(page),
          inputCount: 12,
        });
        result.screenshots.push(await screenshot(page, output, 'viewing-y05-theater-high'));
        await page.locator('#yt-viewing-fullscreen').click();
        await page.waitForFunction(() => Boolean(document.fullscreenElement));
        result.observations.push({ stage: 'detailed-fullscreen', state: await snapshot(page) });
        result.screenshots.push(await screenshot(page, output, 'viewing-y05-fullscreen'));
        await page.keyboard.press('Escape');
        await page.close();
        page = await openPage(viewingContext);
        await setScene(page, 'detailed');
        await openSettings(page);
        await page
          .locator(`${MODAL} details`)
          .first()
          .evaluate((element) => {
            (element as HTMLDetailsElement).open = true;
          });
        await setNumber(page, 'safeBottom', '25', 0.25);
        await page.locator(`${MODAL} #tab-colors`).click();
        await setNumber(page, 'outline-widthPx', '3');
        result.observations.push({ stage: 'adjusted-preview', state: await snapshot(page) });
        result.screenshots.push(await screenshot(page, output, 'viewing-y05-preview-adjusted'));
        await closeSettings(page);
        const adjustedIds = await feed(page, 'adjusted', 2);
        await waitForAnyRow(page, adjustedIds);
        result.observations.push({
          stage: 'adjusted-video',
          adjustedIds,
          state: await snapshot(page),
          pairedWith: 'detailed-normal-default',
        });
        result.screenshots.push(await screenshot(page, output, 'viewing-y05-video-adjusted'));

        await openSettings(page, 'translation');
        await page.locator(`${MODAL} select[name="translationSource"]`).selectOption('en');
        await page.locator(`${MODAL} select[name="translationTarget"]`).selectOption('ko');
        await page.locator(`${MODAL} input[name="translationEnabled"]`).check();
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLElement>('.yt-chat-overlay-settings-runtime-status')?.dataset
              .phase === 'active',
          null,
          { timeout: 10_000 }
        );
        result.observations.push({
          stage: 'controlled-translation-active',
          state: await snapshot(page),
        });
        await closeSettings(page);
        const translatedIds = await feed(page, 'translated', 5);
        await waitForAnyRow(page, translatedIds);
        result.observations.push({
          stage: 'translated-chat-over-video',
          translatedIds,
          state: await snapshot(page),
        });
        result.screenshots.push(await screenshot(page, output, 'viewing-y05-translated'));

        await page.emulateMedia({ reducedMotion: 'reduce' });
        result.observations.push({ stage: 'reduced-motion', state: await snapshot(page) });
        result.screenshots.push(await screenshot(page, output, 'viewing-y05-reduced-motion'));
        await page.emulateMedia({ reducedMotion: 'no-preference' });
      })
    );
  } finally {
    await viewingContext.close();
  }
  const replayState: RouteState = {
    disconnected: false,
    servedIds: [],
    mediaRanges: [],
    replayBatch: 'replay',
    replayRequests: [],
  };
  const replayContext = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 720 },
  });
  try {
    await installFixture(replayContext, userscript, html, media, replayState);
    const replayPage = await openPage(replayContext, true);
    const replayConsole: string[] = [];
    replayPage.on('pageerror', (error) => pageErrors.push(error.message));
    replayPage.on('console', (message) => {
      if (['warning', 'error'].includes(message.type()) && replayConsole.length < 20) {
        replayConsole.push(`${message.type()}: ${message.text().slice(0, 500)}`);
      }
    });
    cases.push(
      await runCase('Y04-replay-controls', async (result) => {
        const ids = ['viewing-replay-0', 'viewing-replay-1'];
        try {
          await waitForAnyRow(replayPage, ids);
        } catch (error) {
          result.observations.push({
            stage: 'replay-admission-timeout',
            route: {
              servedIds: [...replayState.servedIds],
              replayRequests: [...(replayState.replayRequests ?? [])],
              mediaRanges: [...replayState.mediaRanges],
            },
            state: await snapshot(replayPage),
            bootstrap: await replayPage.evaluate(() =>
              JSON.stringify(window.ytInitialData).slice(0, 1_200)
            ),
            pageErrors: [...pageErrors],
            console: [...replayConsole],
          });
          result.screenshots.push(
            await screenshot(replayPage, output, 'viewing-y04-replay-admission-error')
          );
          throw error;
        }
        result.observations.push({
          stage: 'fresh-replay',
          ids,
          state: await snapshot(replayPage),
          route: { replayRequests: [...(replayState.replayRequests ?? [])] },
          firstTimeHumanObserved: false,
        });
        await replayPage.keyboard.press('Control+Space');
        await replayPage
          .locator('#yt-live-chat-overlay')
          .getByText('Paused', { exact: true })
          .waitFor({ state: 'visible' });
        await assertVideoAdvances(replayPage);
        result.observations.push({
          stage: 'replay-overlay-paused',
          state: await snapshot(replayPage),
        });
        await replayPage.keyboard.press('Control+Space');
        await replayPage
          .locator('#yt-live-chat-overlay')
          .getByText('Paused', { exact: true })
          .waitFor({ state: 'hidden' });
        result.observations.push({
          stage: 'replay-overlay-resumed',
          state: await snapshot(replayPage),
        });
        if (!imeRequested) {
          result.observations.push({
            stage: 'native-ime-not-run',
            reason: 'Optional viewing-experience-ime.json selector is absent',
          });
        } else if (process.platform !== 'win32') {
          result.observations.push({
            stage: 'native-ime-not-run',
            reason: 'Native input requires the prepared Windows runner',
          });
        } else {
          nativeImeInput = 'failed';
          const originalTitle = await replayPage.title();
          try {
            await prepareViewingImeCheckpoint(replayPage);
            await replayPage.bringToFront();
            const identity = await ownedBrowserIdentity(browser);
            const current = await runNativeImeAction({
              root,
              output,
              identity,
              sequence: 'ComposeCurrent',
            });
            const currentState = await readViewingImeCheckpoint(replayPage);
            result.observations.push({
              stage: 'native-ime-current-layout',
              ...current,
              state: currentState,
            });
            assert.equal(current.error, null, 'Native IME current-layout action failed');
            assert.equal(
              (current.receipt as { status?: unknown } | null)?.status,
              'action-dispatched',
              'Native IME current-layout receipt is incomplete'
            );
            const composed = (state: ImeCheckpoint) =>
              state.input?.includes('한글') &&
              state.events.some(
                (event) =>
                  event.trusted === true &&
                  (event.type === 'compositionstart' ||
                    event.type === 'compositionupdate' ||
                    event.type === 'compositionend')
              );
            if (!composed(currentState)) {
              await replayPage.evaluate(() => {
                const input = document.querySelector<HTMLTextAreaElement>('#yt-viewing-ime-input');
                if (input) {
                  input.value = '';
                  input.focus();
                }
                window.__ytViewingImeEvents = [];
              });
              await replayPage.bringToFront();
              const toggled = await runNativeImeAction({
                root,
                output,
                identity,
                sequence: 'ComposeToggleRoundTrip',
                koreanLayout: true,
              });
              const toggledState = await readViewingImeCheckpoint(replayPage);
              result.observations.push({
                stage: 'native-ime-existing-korean-layout',
                ...toggled,
                state: toggledState,
              });
              assert.equal(toggled.error, null, 'Native IME Korean-layout action failed');
              assert.equal(
                (toggled.receipt as { status?: unknown } | null)?.status,
                'action-dispatched',
                'Native IME Korean-layout receipt is incomplete'
              );
              assert(
                composed(toggledState),
                'Trusted Korean IME composition and 한글 text were not observed'
              );
            }
            await replayPage.evaluate(() => {
              document.querySelector<HTMLTextAreaElement>('#yt-viewing-ime-input')?.blur();
              window.__ytViewingImeEvents = [];
            });
            await replayPage.bringToFront();
            const controls = await runNativeImeAction({
              root,
              output,
              identity,
              sequence: 'CtrlSpaceRoundTrip',
            });
            await replayPage.waitForTimeout(100);
            const controlState = await readViewingImeCheckpoint(replayPage);
            result.observations.push({
              stage: 'native-ime-noneditable-control',
              ...controls,
              state: controlState,
            });
            assert.equal(controls.error, null, 'Native Ctrl+Space round trip failed');
            assert.equal(
              (controls.receipt as { status?: unknown } | null)?.status,
              'action-dispatched',
              'Native Ctrl+Space receipt is incomplete'
            );
            const presses = controlState.events.filter(
              (event) => event.type === 'document-keydown'
            );
            const settled = controlState.events.filter((event) => event.type === 'post-ctrl-space');
            assert.equal(presses.length, 2, 'Expected two native Ctrl+Space keydown events');
            assert(
              presses.every(
                (event) => event.trusted === true && event.focus !== 'yt-viewing-ime-input'
              )
            );
            assert.deepEqual(
              settled.map((event) => event.overlayPaused),
              [true, false],
              'Native Ctrl+Space did not pause then resume the overlay'
            );
            assert.equal(controlState.videoPaused, false, 'Native shortcut paused the video');
            await assertVideoAdvances(replayPage);
            nativeImeInput = 'verified';
          } finally {
            await replayPage.evaluate((title) => {
              document.querySelector('#yt-viewing-ime-input')?.remove();
              delete window.__ytViewingImeEvents;
              document.title = title;
            }, originalTitle);
          }
        }
      })
    );
  } finally {
    await replayContext.close();
  }
  for (const language of [
    { id: 'en', locale: 'en-US' },
    { id: 'ko', locale: 'ko-KR' },
    { id: 'ja', locale: 'ja-JP' },
    { id: 'ar', locale: 'ar-SA' },
  ]) {
    const localState: RouteState = { disconnected: false, servedIds: [], mediaRanges: [] };
    const localContext = await browser.newContext({
      locale: language.locale,
      viewport: { width: 390, height: 720 },
    });
    try {
      await installFixture(localContext, userscript, html, media, localState, language.id);
      const localPage = await openPage(localContext);
      localPage.on('pageerror', (error) => pageErrors.push(error.message));
      cases.push(
        await runCase(`Y06-${language.id}-narrow`, async (result) => {
          if (language.id === 'ar') await localPage.emulateMedia({ forcedColors: 'active' });
          if (language.id === 'ja') await localPage.emulateMedia({ reducedMotion: 'reduce' });
          await openSettings(localPage);
          for (const tab of ['comments', 'colors', 'advanced', 'translation']) {
            await localPage.locator(`${MODAL} #tab-${tab}`).click();
            result.observations.push({ stage: tab, state: await snapshot(localPage) });
            if (language.id === 'en') {
              result.screenshots.push(await screenshot(localPage, output, `viewing-y06-en-${tab}`));
            }
          }
          if (language.id !== 'en') {
            result.screenshots.push(
              await screenshot(localPage, output, `viewing-y06-${language.id}-translation`)
            );
          }
          if (language.id === 'en') {
            const [chooser] = await Promise.all([
              localPage.waitForEvent('filechooser'),
              localPage.locator(`${MODAL} button[data-action="import"]`).click(),
            ]);
            await chooser.setFiles({
              name: 'invalid.json',
              mimeType: 'application/json',
              buffer: Buffer.from('{'),
            });
            await localPage
              .locator(`${MODAL} .yt-chat-overlay-settings-toast`)
              .waitFor({ state: 'visible' });
            result.observations.push({
              stage: 'import-failure',
              toast: await localPage
                .locator(`${MODAL} .yt-chat-overlay-settings-toast`)
                .textContent(),
              state: await snapshot(localPage),
            });
            result.screenshots.push(
              await screenshot(localPage, output, 'viewing-y06-import-failure')
            );
            await localPage.locator(`${MODAL} button[data-action="reset"]`).click();
            const confirm = localPage.locator('dialog.yt-chat-overlay-settings-confirm');
            await confirm.waitFor({ state: 'visible' });
            result.observations.push({
              stage: 'reset-confirm',
              text: await confirm.textContent(),
              focus: await confirm.evaluate(() => document.activeElement?.className ?? null),
              state: await snapshot(localPage),
            });
            result.screenshots.push(
              await screenshot(localPage, output, 'viewing-y06-reset-confirm')
            );
            await confirm.locator('button.yt-chat-overlay-settings-confirm-cancel').click();
          }
          await localPage.locator(`${MODAL} select[name="translationService"]`).selectOption('off');
          await localPage.locator(`${MODAL} input[name="translationEnabled"]`).check();
          result.observations.push({
            stage: 'translation-inactive',
            state: await snapshot(localPage),
          });
          await closeSettings(localPage);
          const ids = await feed(localPage, `localized-${language.id}`, 5);
          await waitForAnyRow(localPage, ids);
          localState.disconnected = true;
          await localPage
            .locator('#yt-chat-overlay-status-action')
            .waitFor({ state: 'visible', timeout: 30_000 });
          result.observations.push({
            stage: 'disconnected-long-localized',
            state: await snapshot(localPage),
            served: localState.servedIds,
            statusAction: await localPage.locator('#yt-chat-overlay-status-action').textContent(),
          });
          result.screenshots.push(
            await screenshot(localPage, output, `viewing-y06-${language.id}-disconnected`)
          );
        })
      );
    } finally {
      await localContext.close();
    }
  }
  cases.push(
    await runCase('Y06-unsaved-conflict-narrow', async (result) => {
      const recoveryState: RouteState = { disconnected: false, servedIds: [], mediaRanges: [] };
      const recoveryContext = await browser.newContext({
        locale: 'en-US',
        viewport: { width: 390, height: 720 },
      });
      try {
        await installFixture(recoveryContext, userscript, html, media, recoveryState);
        const page = await openPage(recoveryContext);
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await openSettings(page);
        await setNumber(page, 'fontSize', '44');
        await page.evaluate(() => {
          window.__ytViewingDenyWrites = true;
        });
        await closeSettings(page);
        const notice = page.locator('.yt-chat-overlay-settings-persistence-notice');
        await notice.locator('button').waitFor({ state: 'visible' });
        result.observations.push({ stage: 'unsaved', state: await snapshot(page) });
        result.screenshots.push(await screenshot(page, output, 'viewing-y06-unsaved-narrow'));
        const remote = await recoveryContext.newPage();
        await remote.goto(WATCH_URL, { waitUntil: 'domcontentloaded' });
        await remote.evaluate((key) => {
          const previous = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
          localStorage.setItem(key, JSON.stringify({ ...previous, fontSize: 52 }));
        }, SETTINGS_KEY);
        await notice.locator('button').getByText('Save my values').waitFor({ state: 'visible' });
        result.observations.push({ stage: 'conflict', state: await snapshot(page) });
        result.screenshots.push(await screenshot(page, output, 'viewing-y06-conflict-narrow'));
      } finally {
        await recoveryContext.close();
      }
    })
  );
  cases.push(
    await runCase('Y06-real-200-percent-chrome', async (result) => {
      const bundle: unknown = JSON.parse(await readFile(join(root, 'bundle.json'), 'utf8'));
      assert(bundle && typeof bundle === 'object' && 'mode' in bundle && bundle.mode === 'desktop');
      const profilePath = await mkdtemp(join(root, 'yt-viewing-zoom-chrome-'));
      let zoomContext: BrowserContext | undefined;
      let settingsPage: Page | undefined;
      let previousZoom: string | undefined;
      let primaryError: unknown;
      const cleanupErrors: unknown[] = [];
      let zoomRestored = false;
      let contextClosed = false;
      let profileRemoved = false;
      try {
        zoomContext = await browser.browserType().launchPersistentContext(profilePath, {
          channel: 'chrome',
          headless: false,
          args: ['--mute-audio'],
          locale: 'ko-KR',
          viewport: { width: 780, height: 720 },
        });
        const zoomState: RouteState = { disconnected: false, servedIds: [], mediaRanges: [] };
        await installFixture(zoomContext, userscript, html, media, zoomState, 'ko');
        const page = await openPage(zoomContext);
        page.on('pageerror', (error) => pageErrors.push(error.message));
        const baseline = await page.evaluate(() => ({ dpr: devicePixelRatio, width: innerWidth }));
        settingsPage = await zoomContext.newPage();
        await settingsPage.goto('chrome://settings/appearance');
        const zoom = settingsPage.locator('select#zoomLevel');
        previousZoom = await zoom.inputValue();
        assert.equal(Number(previousZoom), 1, 'Owned Chrome profile did not start at 100% zoom');
        await zoom.selectOption('2');
        await page.bringToFront();
        await page.waitForFunction(
          (before) =>
            Math.abs(devicePixelRatio / before.dpr - 2) < 0.02 &&
            Math.abs(innerWidth / before.width - 0.5) < 0.02,
          baseline,
          { timeout: 10_000 }
        );
        await openSettings(page);
        for (const tab of ['comments', 'colors', 'advanced', 'translation']) {
          await page.locator(`${MODAL} #tab-${tab}`).click();
          result.observations.push({ stage: `ko-200-${tab}`, state: await snapshot(page) });
        }
        const capture = await nativeZoomScreenshot(page, output, 'viewing-y06-ko-200-translation');
        result.screenshots.push(capture.file);
        result.observations.push({ screenshot: capture });
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser'),
          page.locator(`${MODAL} button[data-action="import"]`).click(),
        ]);
        await chooser.setFiles({
          name: 'invalid.json',
          mimeType: 'application/json',
          buffer: Buffer.from('{'),
        });
        await page
          .locator(`${MODAL} .yt-chat-overlay-settings-toast`)
          .waitFor({ state: 'visible' });
        result.observations.push({ stage: 'ko-200-import-failure', state: await snapshot(page) });
        const importCapture = await nativeZoomScreenshot(page, output, 'viewing-y06-ko-200-import');
        result.screenshots.push(importCapture.file);
        result.observations.push({ screenshot: importCapture });
        await page.locator(`${MODAL} button[data-action="reset"]`).click();
        const reset = page.locator('dialog.yt-chat-overlay-settings-confirm');
        await reset.waitFor({ state: 'visible' });
        result.observations.push({
          stage: 'ko-200-reset-confirm',
          text: await reset.textContent(),
          state: await snapshot(page),
        });
        await reset.locator('button.yt-chat-overlay-settings-confirm-cancel').click();
        await page.locator(`${MODAL} select[name="translationService"]`).selectOption('off');
        await page.locator(`${MODAL} input[name="translationEnabled"]`).check();
        result.observations.push({
          stage: 'ko-200-translation-inactive',
          state: await snapshot(page),
        });
        await page.locator(`${MODAL} select[name="language"]`).selectOption('ja');
        result.observations.push({ stage: 'ja-200-translation', state: await snapshot(page) });
        const japaneseCapture = await nativeZoomScreenshot(
          page,
          output,
          'viewing-y06-ja-200-translation'
        );
        result.screenshots.push(japaneseCapture.file);
        result.observations.push({ screenshot: japaneseCapture });
        await closeSettings(page);
        const ids = await feed(page, 'zoom-ja-long', 5);
        await waitForAnyRow(page, ids);
        zoomState.disconnected = true;
        await page
          .locator('#yt-chat-overlay-status-action')
          .waitFor({ state: 'visible', timeout: 30_000 });
        result.observations.push({
          stage: 'ja-200-disconnected-long',
          state: await snapshot(page),
        });
        const disconnectedCapture = await nativeZoomScreenshot(
          page,
          output,
          'viewing-y06-ja-200-disconnected'
        );
        result.screenshots.push(disconnectedCapture.file);
        result.observations.push({ screenshot: disconnectedCapture });
      } catch (error) {
        primaryError = error;
      } finally {
        if (settingsPage && previousZoom) {
          try {
            await settingsPage.locator('select#zoomLevel').selectOption(previousZoom);
            zoomRestored = true;
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        try {
          await zoomContext?.close();
          contextClosed = true;
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (contextClosed) {
          try {
            assert(basename(profilePath).startsWith('yt-viewing-zoom-chrome-'));
            await rm(profilePath, { recursive: true });
            profileRemoved = true;
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      }
      result.observations.push({ cleanup: { zoomRestored, contextClosed, profileRemoved } });
      if (primaryError || cleanupErrors.length > 0) {
        const failures = [...(primaryError ? [primaryError] : []), ...cleanupErrors];
        throw new AggregateError(
          failures,
          `Owned Chrome zoom case or cleanup failed: ${failures.map(String).join(' | ')}`
        );
      }
    })
  );
  const result = {
    checks: {
      sourceBoundMovingMedia: true,
      builtUserscriptFixture: true,
      sustainedViewingLifecycle: false,
      firstTimeHumanObservation: false,
      humanReadabilityJudgment: 'pending-review',
      nativeImeInput,
      spokenScreenReaderCheck: 'not-run',
      nativeYouTubeControls: 'not-run',
      installedApplication: false,
      liveYouTube: false,
      failedCases: cases.filter((entry) => entry.error).map((entry) => entry.id),
      pageErrors,
    },
    observations: {
      mediaSha256: MEDIA,
      browserVersion: browser.version(),
      cases,
      operatorTasks: [
        'Make comments smaller and less opaque',
        'Freeze comments while video continues, then resume',
        'Disable comments, then restore',
        'Explain and change reduced-motion behavior',
      ].map((task) => ({
        task,
        observed: false,
        timeToFindMs: null,
        wrongActions: null,
        helpRequests: null,
      })),
      servedIds: [...state.servedIds, ...viewingState.servedIds, ...replayState.servedIds],
      mediaRanges: [
        ...state.mediaRanges,
        ...viewingState.mediaRanges,
        ...replayState.mediaRanges,
      ].slice(0, 30),
      scope:
        'built userscript; controlled parser-fed chat and owned moving video in prepared Windows browser',
    },
  };
  await writeFile(join(output, 'viewing-experience.json'), JSON.stringify(result, null, 2));
  assert.equal(
    cases.filter((entry) => entry.error).length,
    0,
    'Viewing baseline case failed; inspect viewing-experience.json'
  );
  assert.deepEqual(pageErrors, [], 'Viewing baseline page errors');
  return result;
}
