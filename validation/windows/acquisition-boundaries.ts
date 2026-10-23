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

const ENTRY_MARKER = '\n\tmain();\n';
const WATCH_A = 'https://www.youtube.com/watch?v=windowsAcquisitionA';
const WATCH_B = 'https://www.youtube.com/watch?v=windowsAcquisitionB';
const CHAT_PATH = '/youtubei/v1/live_chat/get_live_chat';
const IMAGE_PREFIX = 'https://yt3.ggpht.com/windows-acquisition-';
const OLD_IMAGE = `${IMAGE_PREFIX}shared-old.png`;
const FINAL_IMAGE = `${IMAGE_PREFIX}shared-final.png`;
const CAP_ORIGINAL = 'CAP02 original response ☃ remains readable';
const MAX_RECORDS = 48;
const MAX_CHAT_BYTES = 8 * 1024 * 1024;
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGP8z8DwnwEJMDGgAcICAIPRAgYCkO9YAAAAAElFTkSuQmCC',
  'base64'
);

type StreamName = 'cap' | 'late';
type StreamRecord = {
  response: Response | null;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  cloneCalls: number;
  cloneCancelCalls: number;
  cloneReadsDone: number;
  sourceCancelCalls: number;
  released: boolean;
};
type RuntimeProbe = {
  state: string;
  targetUrl: string | null;
  sessionGeneration: number;
  renderer: RendererProbe | null;
  chatSource: object | null;
  fetchInterceptorUnsubscribe: (() => void) | null;
};
type RendererProbe = {
  canvas: HTMLCanvasElement | null;
  workerManager: { workerRef: Worker | null };
  settings: { danmakuMode: string; topBottomDurationMs: number };
};
type Pin = {
  renderer: RendererProbe | null;
  canvas: HTMLCanvasElement | null;
  source: object | null;
  generation: number;
};
type PageState = {
  manager: RuntimeProbe | null;
  app: Window['__ytChatOverlay'] | null;
  pins: Partial<Record<'a1' | 'b' | 'a2', Pin>>;
  imagePrefix: string;
  capOriginal: string;
  workerAttempts: number;
  installs: number;
  restores: number;
  streams: Record<StreamName, StreamRecord>;
  accepted: Array<{
    id: string;
    photo: string | null;
    action: string | null;
    generation: number | null;
    current: boolean;
  }>;
  draws: Array<{ url: string; generation: number | null; current: boolean }>;
  textDraws: Array<{ text: string; generation: number | null }>;
  overflow: number;
  sourceBound: boolean;
};

declare global {
  interface Window {
    __ytAcquisitionBoundary?: PageState;
  }
}

function responseBody(id?: string, photo?: string, actionType: 'add' | 'replace' = 'add') {
  const actions =
    id && photo
      ? [
          {
            [actionType === 'replace' ? 'replaceChatItemAction' : 'addChatItemAction']: {
              item: {
                liveChatTextMessageRenderer: {
                  id,
                  authorName: { simpleText: 'Acquisition fixture viewer' },
                  authorPhoto: { thumbnails: [{ url: photo, width: 48, height: 48 }] },
                  message: { runs: [{ text: `WIN306_ACQ_${id}` }] },
                },
              },
            },
          },
        ]
      : [];
  return {
    continuationContents: {
      liveChatContinuation: {
        actions,
        continuations: [
          {
            timedContinuationData: {
              continuation: 'windows-acquisition-next',
              timeoutMs: 30_000,
            },
          },
        ],
      },
    },
  };
}

/** Document-only instrumentation; production fetch, parser, source and renderer stay in use. */
function installPrelude({
  imagePrefix,
  capOriginal,
  maxChatBytes,
  maxRecords,
}: {
  imagePrefix: string;
  capOriginal: string;
  maxChatBytes: number;
  maxRecords: number;
}): void {
  const makeStream = (): StreamRecord => ({
    response: null,
    controller: null,
    cloneCalls: 0,
    cloneCancelCalls: 0,
    cloneReadsDone: 0,
    sourceCancelCalls: 0,
    released: false,
  });
  const state: PageState = {
    manager: null,
    app: null,
    pins: {},
    imagePrefix,
    capOriginal,
    workerAttempts: 0,
    installs: 0,
    restores: 0,
    streams: { cap: makeStream(), late: makeStream() },
    accepted: [],
    draws: [],
    textDraws: [],
    overflow: 0,
    sourceBound: false,
  };
  window.__ytAcquisitionBoundary = state;
  // This fixture supplies an isolated video readiness prerequisite; it does
  // not claim playback, buffering, player identity or real media acceptance.
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get: () => false,
  });
  const NativeWorker = window.Worker;
  window.Worker = new Proxy(NativeWorker, {
    construct(target, args) {
      const [url, options] = args;
      if (
        String(url) === window.__ytExtensionBridge?.workerUrl &&
        String(url).startsWith('blob:https://www.youtube.com/') &&
        options?.type === 'module'
      ) {
        state.workerAttempts++;
        throw new DOMException('Fixture worker-src restriction', 'SecurityError');
      }
      return Reflect.construct(target, args);
    },
  });
  const nativeFetch = window.fetch;
  window.fetch = function (this: typeof window, input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === 'string') {
      const url = new URL(input, location.href);
      const streamName = url.searchParams.get('windows306Stream');
      if (
        url.origin === location.origin &&
        url.pathname === '/youtubei/v1/live_chat/get_live_chat' &&
        (streamName === 'cap' || streamName === 'late')
      ) {
        const record = state.streams[streamName];
        if (record.response) throw new Error(`Fixture stream ${streamName} reused`);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            record.controller = controller;
          },
          cancel() {
            record.sourceCancelCalls++;
          },
        });
        record.response = new Response(body, {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            ...(streamName === 'cap' ? { 'content-length': String(maxChatBytes + 1) } : {}),
          },
        });
        return Promise.resolve(record.response);
      }
    }
    return nativeFetch.call(this, input, init);
  };
  const nativeClone = Response.prototype.clone;
  Response.prototype.clone = function (this: Response): Response {
    const cloned = nativeClone.call(this);
    for (const name of ['cap', 'late'] as const) {
      const record = state.streams[name];
      if (this !== record.response) continue;
      record.cloneCalls++;
      const body = cloned.body;
      if (body) {
        const nativeCancel = body.cancel.bind(body);
        body.cancel = (reason?: unknown) => {
          record.cloneCancelCalls++;
          return nativeCancel(reason);
        };
        const nativeGetReader = () =>
          Reflect.apply(
            ReadableStream.prototype.getReader,
            body,
            []
          ) as ReadableStreamDefaultReader<Uint8Array>;
        Object.defineProperty(body, 'getReader', {
          configurable: true,
          value: () => {
            const reader = nativeGetReader();
            const nativeRead = reader.read.bind(reader);
            reader.read = async () => {
              const result = await nativeRead();
              if (result.done) record.cloneReadsDone++;
              return result;
            };
            return reader;
          },
        });
      }
    }
    return cloned;
  };
  const derivedUrls = new WeakMap<object, string>();
  const sourceUrl = (image: CanvasImageSource): string | null => {
    if (image instanceof HTMLImageElement) return image.currentSrc || image.src || null;
    return typeof image === 'object' && image !== null ? (derivedUrls.get(image) ?? null) : null;
  };
  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
    const offscreenDraw = OffscreenCanvasRenderingContext2D.prototype.drawImage;
    OffscreenCanvasRenderingContext2D.prototype.drawImage = function (
      image: CanvasImageSource,
      ...args: number[]
    ): void {
      Reflect.apply(offscreenDraw, this, [image, ...args]);
      const url = sourceUrl(image);
      if (url?.startsWith(imagePrefix)) derivedUrls.set(this.canvas, url);
    };
    const offscreenText = OffscreenCanvasRenderingContext2D.prototype.fillText;
    OffscreenCanvasRenderingContext2D.prototype.fillText = function (
      text: string,
      x: number,
      y: number,
      maxWidth?: number
    ): void {
      Reflect.apply(
        offscreenText,
        this,
        maxWidth === undefined ? [text, x, y] : [text, x, y, maxWidth]
      );
      if (!text.startsWith('WIN306_ACQ_')) return;
      const generation = state.manager?.sessionGeneration ?? null;
      if (state.textDraws.some((entry) => entry.text === text && entry.generation === generation))
        return;
      if (state.textDraws.length < maxRecords) state.textDraws.push({ text, generation });
      else state.overflow++;
    };
  }
  const nativeDraw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (
    image: CanvasImageSource,
    ...args: number[]
  ): void {
    Reflect.apply(nativeDraw, this, [image, ...args]);
    const url = sourceUrl(image);
    if (!url?.startsWith(imagePrefix)) return;
    if (!this.canvas.closest('#yt-live-chat-overlay')) {
      derivedUrls.set(this.canvas, url);
      return;
    }
    const generation = state.manager?.sessionGeneration ?? null;
    const current = this.canvas === state.manager?.renderer?.canvas;
    if (
      state.draws.some(
        (entry) => entry.url === url && entry.generation === generation && entry.current === current
      )
    )
      return;
    if (state.draws.length < maxRecords) state.draws.push({ url, generation, current });
    else state.overflow++;
  };
  const nativeText = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (
    text: string,
    x: number,
    y: number,
    maxWidth?: number
  ): void {
    Reflect.apply(nativeText, this, maxWidth === undefined ? [text, x, y] : [text, x, y, maxWidth]);
    if (!text.startsWith('WIN306_ACQ_') || !this.canvas.closest('#yt-live-chat-overlay')) return;
    const generation = state.manager?.sessionGeneration ?? null;
    if (state.textDraws.some((entry) => entry.text === text && entry.generation === generation))
      return;
    if (state.textDraws.length < maxRecords) state.textDraws.push({ text, generation });
    else state.overflow++;
  };
  window.ytcfg = {
    data_: {
      INNERTUBE_API_KEY: 'windows-acceptance-key',
      INNERTUBE_CONTEXT_CLIENT_NAME: '1',
      INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
      INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
    },
  };
  window.ytInitialData = {
    currentVideoEndpoint: { watchEndpoint: { videoId: 'windowsAcquisitionA' } },
    contents: {
      twoColumnWatchNextResults: {
        conversationBar: {
          liveChatRenderer: {
            isReplay: false,
            continuations: [
              {
                timedContinuationData: { continuation: 'windows-acquisition-a', timeoutMs: 30_000 },
              },
            ],
          },
        },
      },
    },
  };
}

function describe(error: unknown): { message: string; stack: string | null } {
  return {
    message: String(error).slice(0, 2_000),
    stack: error instanceof Error ? (error.stack?.slice(0, 4_000) ?? null) : null,
  };
}

async function within(promise: Promise<void>, label: string, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const state = window.__ytAcquisitionBoundary;
    if (!state?.manager) throw new Error('Source-bound runtime manager unavailable');
    const manager = state.manager;
    const currentCanvas = manager.renderer?.canvas;
    return {
      url: location.href,
      timeOrigin: performance.timeOrigin,
      appPinned: window.__ytChatOverlay === state.app,
      sourceBound: state.sourceBound,
      managerState: manager.state,
      targetUrl: manager.targetUrl,
      generation: manager.sessionGeneration,
      sourcePresent: manager.chatSource !== null,
      rendererPresent: manager.renderer !== null,
      interceptorPresent: manager.fetchInterceptorUnsubscribe !== null,
      workerPresent: manager.renderer?.workerManager.workerRef !== null,
      canvasCount: document.querySelectorAll('#yt-live-chat-overlay canvas').length,
      currentCanvasConnected: currentCanvas?.isConnected ?? false,
      initialCanvasConnected: state.pins.a1?.canvas?.isConnected ?? null,
      sameA1Renderer: state.pins.a1?.renderer === manager.renderer,
      sameBRenderer: state.pins.b?.renderer === manager.renderer,
      sameA1Source: state.pins.a1?.source === manager.chatSource,
      sameBSource: state.pins.b?.source === manager.chatSource,
      workerAttempts: state.workerAttempts,
      installs: state.installs,
      restores: state.restores,
      streams: {
        cap: {
          cloneCalls: state.streams.cap.cloneCalls,
          cloneCancelCalls: state.streams.cap.cloneCancelCalls,
          cloneReadsDone: state.streams.cap.cloneReadsDone,
          sourceCancelCalls: state.streams.cap.sourceCancelCalls,
          released: state.streams.cap.released,
          originalBodyUsed: state.streams.cap.response?.bodyUsed ?? null,
          originalLocked: state.streams.cap.response?.body?.locked ?? null,
        },
        late: {
          cloneCalls: state.streams.late.cloneCalls,
          cloneCancelCalls: state.streams.late.cloneCancelCalls,
          cloneReadsDone: state.streams.late.cloneReadsDone,
          sourceCancelCalls: state.streams.late.sourceCancelCalls,
          released: state.streams.late.released,
          originalBodyUsed: state.streams.late.response?.bodyUsed ?? null,
          originalLocked: state.streams.late.response?.body?.locked ?? null,
        },
      },
      accepted: state.accepted,
      draws: state.draws,
      textDraws: state.textDraws,
      overflow: state.overflow,
    };
  });
}

async function pinSession(page: Page, key: 'a1' | 'b' | 'a2') {
  return page.evaluate((pinKey) => {
    const state = window.__ytAcquisitionBoundary;
    const manager = state?.manager;
    if (!state || !manager?.renderer?.canvas || !manager.chatSource || !window.__ytChatOverlay)
      throw new Error('Active production session cannot be pinned');
    if (!state.app) state.app = window.__ytChatOverlay;
    state.pins[pinKey] = {
      renderer: manager.renderer,
      canvas: manager.renderer.canvas,
      source: manager.chatSource,
      generation: manager.sessionGeneration,
    };
    return {
      url: location.href,
      generation: manager.sessionGeneration,
      timeOrigin: performance.timeOrigin,
      appPinned: window.__ytChatOverlay === state.app,
      canvasCount: document.querySelectorAll('#yt-live-chat-overlay canvas').length,
    };
  }, key);
}

async function waitForSession(page: Page, url: string, minGeneration: number): Promise<void> {
  await page.waitForFunction(
    ({ target, after }) => {
      const manager = window.__ytAcquisitionBoundary?.manager;
      return (
        location.href === target &&
        manager?.targetUrl === target &&
        manager.state === 'active' &&
        manager.sessionGeneration > after &&
        manager.renderer?.canvas?.isConnected === true &&
        manager.chatSource !== null &&
        manager.fetchInterceptorUnsubscribe !== null &&
        document.querySelectorAll('#yt-live-chat-overlay canvas').length === 1
      );
    },
    { target: url, after: minGeneration },
    { timeout: 20_000 }
  );
}

async function sendAction(page: Page, name: string): Promise<void> {
  await page.evaluate(async (key) => {
    const response = await fetch(
      `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?windows306Case=${key}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
    );
    if (!response.ok) throw new Error('Controlled chat response failed');
    await response.json();
  }, name);
}

async function waitForMessage(page: Page, id: string, photo: string): Promise<void> {
  await page.waitForFunction(
    ({ messageId, imageUrl }) => {
      const state = window.__ytAcquisitionBoundary;
      const generation = state?.manager?.sessionGeneration;
      return Boolean(
        state?.accepted.some(
          (entry) =>
            entry.id === messageId &&
            entry.photo === imageUrl &&
            entry.generation === generation &&
            entry.current
        ) &&
        state.draws.some(
          (entry) => entry.url === imageUrl && entry.generation === generation && entry.current
        ) &&
        state.textDraws.some(
          (entry) => entry.text === `WIN306_ACQ_${messageId}` && entry.generation === generation
        )
      );
    },
    { messageId: id, imageUrl: photo },
    { timeout: 12_000 }
  );
}

async function navigateSpa(page: Page, next: typeof WATCH_A | typeof WATCH_B): Promise<void> {
  await page.evaluate((url) => {
    const data = window.ytInitialData as {
      currentVideoEndpoint?: { watchEndpoint?: { videoId?: string } };
      contents?: {
        twoColumnWatchNextResults?: {
          conversationBar?: {
            liveChatRenderer?: { continuations?: unknown[] };
          };
        };
      };
    };
    const videoId = new URL(url).searchParams.get('v');
    if (!videoId || !data?.currentVideoEndpoint?.watchEndpoint)
      throw new Error('Controlled YouTube page identity was lost');
    data.currentVideoEndpoint.watchEndpoint.videoId = videoId;
    const renderer = data.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer;
    if (!renderer) throw new Error('Controlled live-chat renderer was lost');
    renderer.continuations = [
      {
        timedContinuationData: {
          continuation: `windows-acquisition-${videoId}`,
          timeoutMs: 30_000,
        },
      },
    ];
    history.pushState({}, '', url);
  }, next);
}

async function releaseStream(page: Page, name: StreamName, text: string): Promise<string> {
  return page.evaluate(
    async ({ streamName, body }) => {
      const record = window.__ytAcquisitionBoundary?.streams[streamName];
      if (!record?.controller || !record.response || record.released)
        throw new Error(`Held ${streamName} response was unavailable`);
      record.controller.enqueue(new TextEncoder().encode(body));
      record.controller.close();
      record.released = true;
      return record.response.text();
    },
    { streamName: name, body: text }
  );
}

/** Installed Main-renderer acquisition boundary with real page Response streams. */
export async function runAcquisitionBoundaries({
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
  assert.match(extensionId, /^[a-p]{32}$/);
  const source = await readFile(join(root, 'dist-extension/page-script.js'), 'utf8');
  assert.equal(source.split(ENTRY_MARKER).length, 2, 'Packaged page entry changed');
  for (const marker of [
    'function installFetchInterceptor(',
    'var RuntimeManager = class RuntimeManager',
    'var CanvasRenderer = class CanvasRenderer',
  ])
    assert(source.includes(marker), `Packaged acquisition seam changed: ${marker}`);
  const instrumented = source.replace(
    ENTRY_MARKER,
    `\n\tconst acquisitionState = window.__ytAcquisitionBoundary;\n` +
      `\tif (!acquisitionState) throw new Error('Acquisition prelude unavailable');\n` +
      `\tconst nativeInstallAcquisition = installFetchInterceptor;\n` +
      `\tinstallFetchInterceptor = function(...args) {\n` +
      `\t\tconst restore = nativeInstallAcquisition(...args); acquisitionState.installs++;\n` +
      `\t\treturn function() { acquisitionState.restores++; return restore(); };\n` +
      `\t};\n` +
      `\tconst nativeAcquisitionStart = RuntimeManager.prototype.start;\n` +
      `\tRuntimeManager.prototype.start = function(...args) {\n` +
      `\t\tacquisitionState.manager = this; return nativeAcquisitionStart.apply(this, args);\n` +
      `\t};\n` +
      `\tconst nativeAcquisitionAdd = CanvasRenderer.prototype.addMessage;\n` +
      `\tCanvasRenderer.prototype.addMessage = function(message) {\n` +
      `\t\tif (typeof message?.id === 'string' && message.id.startsWith('windows306-acq-')) {\n` +
      `\t\t\tif (acquisitionState.accepted.length < ${MAX_RECORDS}) acquisitionState.accepted.push({\n` +
      `\t\t\t\tid: message.id, photo: message.authorPhotoUrl ?? null, action: message.actionType ?? null,\n` +
      `\t\t\t\tgeneration: acquisitionState.manager?.sessionGeneration ?? null,\n` +
      `\t\t\t\tcurrent: acquisitionState.manager?.renderer === this\n` +
      `\t\t\t}); else acquisitionState.overflow++;\n` +
      `\t\t}\n` +
      `\t\treturn nativeAcquisitionAdd.call(this, message);\n` +
      `\t};\n` +
      `\tacquisitionState.sourceBound = true;${ENTRY_MARKER}`
  );
  const preview = await readFile(join(root, 'test/visual/preview.html'), 'utf8');
  const html = buildVisibleWatchHtml(preview, 'Acquisition boundary fixture video');
  const caseActions = new Map([
    ['cap-healthy', { id: 'windows306-acq-cap-healthy', photo: `${IMAGE_PREFIX}cap-healthy.png` }],
    ['shared-old', { id: 'windows306-acq-shared', photo: OLD_IMAGE }],
    ['b-healthy', { id: 'windows306-acq-b-healthy', photo: `${IMAGE_PREFIX}b-healthy.png` }],
    ['shared-final', { id: 'windows306-acq-shared', photo: FINAL_IMAGE }],
  ]);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const imageRequests: string[] = [];
  const routeErrors: string[] = [];
  let overflow = 0;
  let oldImageEntered!: () => void;
  const oldImageReached = new Promise<void>((resolve) => {
    oldImageEntered = resolve;
  });
  let releaseOldImage!: () => void;
  const oldImageHeld = new Promise<void>((resolve) => {
    releaseOldImage = resolve;
  });
  let oldImageSettled!: () => void;
  const oldImageComplete = new Promise<void>((resolve) => {
    oldImageSettled = resolve;
  });
  let oldImageRequested = false;
  let oldImageReleased = false;
  let oldImageDisposition: 'pending' | 'fulfilled' | 'unavailable' = 'pending';
  let oldImageError: string | null = null;
  let oldImageRequestFailure: string | null = null;
  page.on('requestfailed', (request) => {
    if (request.url() === OLD_IMAGE)
      oldImageRequestFailure = request.failure()?.errorText.slice(0, 300) ?? 'unknown failure';
  });
  page.on('pageerror', (error) => {
    if (pageErrors.length < 10) pageErrors.push(error.name);
    else overflow++;
  });
  page.on('console', (entry) => {
    if (entry.type() !== 'error') return;
    if (consoleErrors.length < 10) consoleErrors.push(entry.text().slice(0, 300));
    else overflow++;
  });
  const routeHandler = async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:' && url.hostname === extensionId)
      return route.continue();
    if (url.href.startsWith(IMAGE_PREFIX)) {
      if (imageRequests.length < MAX_RECORDS) imageRequests.push(url.href);
      else overflow++;
      if (url.href === OLD_IMAGE) {
        if (oldImageRequested) {
          if (routeErrors.length < 10) routeErrors.push('Old image route was requested twice');
          else overflow++;
          return route.fulfill({ status: 409, body: 'Duplicate old image request' });
        }
        oldImageRequested = true;
        oldImageEntered();
        await oldImageHeld;
        try {
          await route.fulfill({
            status: 200,
            contentType: 'image/png',
            headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
            body: RED_PNG,
          });
          oldImageDisposition = 'fulfilled';
        } catch (error) {
          oldImageDisposition = 'unavailable';
          oldImageError = String(error).slice(0, 300);
        } finally {
          oldImageSettled();
        }
        return;
      }
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
        body: RED_PNG,
      });
    }
    if (
      (url.href === WATCH_A || url.href === WATCH_B) &&
      route.request().resourceType() === 'document'
    )
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (url.hostname === 'www.youtube.com' && url.pathname === '/favicon.ico')
      return route.fulfill({ status: 204 });
    if (url.hostname === 'www.youtube.com' && url.pathname === CHAT_PATH) {
      const key = url.searchParams.get('windows306Case');
      const selected = key ? caseActions.get(key) : undefined;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: responseBody(selected?.id, selected?.photo),
      });
    }
    return route.fulfill({ status: 403, body: 'Blocked by acquisition fixture' });
  };
  let routeInstalled = false;
  let probe: NativePageScriptProbe | undefined;
  let provenance: NativePageScriptProbe['provenance'] | null = null;
  let originalSettings:
    | ReturnType<NonNullable<Window['__ytChatOverlay']>['getSettings']>
    | undefined;
  let phase = 'preflight';
  let primaryError: unknown;
  let result: Record<string, unknown> | undefined;
  const releaseHeldImage = async (): Promise<void> => {
    if (!oldImageRequested || oldImageReleased) return;
    oldImageReleased = true;
    releaseOldImage();
    await within(oldImageComplete, 'Old image route release', 5_000);
  };
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.route('**/*', routeHandler);
    routeInstalled = true;
    await page.addInitScript(installPrelude, {
      imagePrefix: IMAGE_PREFIX,
      capOriginal: CAP_ORIGINAL,
      maxChatBytes: MAX_CHAT_BYTES,
      maxRecords: MAX_RECORDS,
    });
    probe = await installNativePageScriptProbe({
      context,
      root,
      extensionId,
      fixtureUrl: WATCH_A,
      instrumentedSource: instrumented,
    });
    provenance = probe.provenance;
    await probe.assertReady();
    await page.goto(WATCH_A, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page
      .locator('#yt-live-chat-overlay canvas')
      .waitFor({ state: 'attached', timeout: 15_000 });
    await probe.assertInjected();
    await probe.restore();
    probe = undefined;
    await waitForSession(page, WATCH_A, -1);
    originalSettings = await page.evaluate(() => {
      const app = window.__ytChatOverlay;
      if (!app) throw new Error('Installed app unavailable');
      const settings = structuredClone(app.getSettings());
      app.applySettings({
        danmakuMode: 'top',
        topBottomDurationMs: 3_000,
        showAuthor: { ...settings.showAuthor, normal: true },
        allowShortTextMessages: true,
        translationEnabled: false,
        depthLayersEnabled: false,
      });
      return settings;
    });
    await page.waitForFunction(
      () => {
        const settings = window.__ytAcquisitionBoundary?.manager?.renderer?.settings;
        return settings?.danmakuMode === 'top' && settings.topBottomDurationMs === 3_000;
      },
      undefined,
      { timeout: 5_000 }
    );
    await waitForSession(page, WATCH_A, -1);
    const a1 = await pinSession(page, 'a1');
    assert.equal(a1.url, WATCH_A);
    assert.equal(a1.canvasCount, 1);
    assert.equal((await snapshot(page)).sourceBound, true);
    phase = 'cap02-native-tee';
    const capInitial = await page.evaluate(async () => {
      const response = await fetch(
        `${location.origin}/youtubei/v1/live_chat/get_live_chat?windows306Stream=cap`
      );
      const record = window.__ytAcquisitionBoundary?.streams.cap;
      if (!record || response !== record.response)
        throw new Error('CAP02 native Response identity changed');
      return { bodyUsed: response.bodyUsed, locked: response.body?.locked ?? null };
    });
    assert.deepEqual(capInitial, { bodyUsed: false, locked: false });
    await page.waitForFunction(
      () => {
        const record = window.__ytAcquisitionBoundary?.streams.cap;
        return record?.cloneCalls === 1 && record.cloneCancelCalls === 1;
      },
      undefined,
      { timeout: 5_000 }
    );
    const capBeforeRelease = await snapshot(page);
    assert.equal(capBeforeRelease.streams.cap.originalBodyUsed, false);
    assert.equal(capBeforeRelease.streams.cap.originalLocked, false);
    assert.equal(await releaseStream(page, 'cap', CAP_ORIGINAL), CAP_ORIGINAL);
    const capAfterRelease = await snapshot(page);
    assert.equal(capAfterRelease.streams.cap.cloneCalls, 1);
    assert.equal(capAfterRelease.streams.cap.cloneCancelCalls, 1);
    await sendAction(page, 'cap-healthy');
    await waitForMessage(page, 'windows306-acq-cap-healthy', `${IMAGE_PREFIX}cap-healthy.png`);
    phase = 'a1-held-image';
    await sendAction(page, 'shared-old');
    await within(oldImageReached, 'Old image route admission', 10_000);
    const a1Held = await snapshot(page);
    assert(
      a1Held.accepted.some(
        (entry) =>
          entry.id === 'windows306-acq-shared' &&
          entry.photo === OLD_IMAGE &&
          entry.generation === a1.generation
      )
    );
    assert.equal(
      a1Held.draws.some((entry) => entry.url === OLD_IMAGE),
      false
    );
    phase = 'b-healthy';
    await navigateSpa(page, WATCH_B);
    await waitForSession(page, WATCH_B, a1.generation);
    const b = await pinSession(page, 'b');
    const bState = await snapshot(page);
    assert.equal(b.timeOrigin, a1.timeOrigin);
    assert(b.appPinned && !bState.sameA1Renderer && !bState.sameA1Source);
    assert.equal(bState.initialCanvasConnected, false);
    await sendAction(page, 'b-healthy');
    await waitForMessage(page, 'windows306-acq-b-healthy', `${IMAGE_PREFIX}b-healthy.png`);
    phase = 'b-held-live-body';
    await page.evaluate(async () => {
      const response = await fetch(
        `${location.origin}/youtubei/v1/live_chat/get_live_chat?windows306Stream=late`
      );
      if (response !== window.__ytAcquisitionBoundary?.streams.late.response)
        throw new Error('Held B native Response identity changed');
    });
    await page.waitForFunction(
      () => window.__ytAcquisitionBoundary?.streams.late.cloneCalls === 1,
      undefined,
      { timeout: 5_000 }
    );
    const bHeld = await snapshot(page);
    assert.equal(bHeld.streams.late.originalBodyUsed, false);
    assert.equal(bHeld.streams.late.originalLocked, false);
    phase = 'a2-current';
    await navigateSpa(page, WATCH_A);
    await waitForSession(page, WATCH_A, b.generation);
    const a2 = await pinSession(page, 'a2');
    const a2State = await snapshot(page);
    assert.equal(a2.timeOrigin, a1.timeOrigin);
    assert(a2.appPinned && !a2State.sameA1Renderer && !a2State.sameBRenderer);
    assert(!a2State.sameA1Source && !a2State.sameBSource);
    assert.equal(a2State.canvasCount, 1);
    await sendAction(page, 'shared-final');
    await waitForMessage(page, 'windows306-acq-shared', FINAL_IMAGE);
    const beforeLateRelease = await snapshot(page);
    assert(beforeLateRelease.restores >= 2);
    phase = 'release-retired-work';
    const staleBody = JSON.stringify(
      responseBody('windows306-acq-stale-b', `${IMAGE_PREFIX}stale-b.png`)
    );
    assert.equal(await releaseStream(page, 'late', staleBody), staleBody);
    await releaseHeldImage();
    await page.waitForFunction(
      () => {
        const state = window.__ytAcquisitionBoundary;
        return (
          state?.manager?.targetUrl === location.href &&
          state.streams.late.released &&
          state.streams.late.response?.bodyUsed &&
          state.streams.late.cloneReadsDone === 1
        );
      },
      undefined,
      { timeout: 5_000 }
    );
    const final = await snapshot(page);
    assert.equal(final.url, WATCH_A);
    assert.equal(final.generation, a2.generation);
    assert(final.appPinned && final.currentCanvasConnected && final.canvasCount === 1);
    assert.equal(final.initialCanvasConnected, false);
    assert(
      final.draws.some(
        (entry) => entry.url === FINAL_IMAGE && entry.generation === a2.generation && entry.current
      )
    );
    assert.equal(
      final.draws.some(
        (entry) => entry.url === OLD_IMAGE && entry.generation === a2.generation && entry.current
      ),
      false
    );
    assert.equal(
      final.accepted.some((entry) => entry.id === 'windows306-acq-stale-b'),
      false
    );
    assert.equal(
      final.draws.some((entry) => entry.url === `${IMAGE_PREFIX}stale-b.png`),
      false
    );
    assert.equal(final.overflow, 0);
    assert.equal(overflow, 0);
    assert.deepEqual(routeErrors, []);
    assert.equal(pageErrors.length, 0);
    assert.deepEqual(consoleErrors, []);
    assert.equal(oldImageReleased, true);
    assert.notEqual(oldImageDisposition, 'pending');
    const imageDisposition = oldImageDisposition as 'fulfilled' | 'unavailable';
    const lateImageCompletion = {
      status: imageDisposition === 'fulfilled' ? 'passed' : 'inconclusive',
      scope: 'held old-image route delivery and absence from the current canvas',
      routeDisposition: imageDisposition,
      routeError: oldImageError,
      requestFailure: oldImageRequestFailure,
      cancellationObserved: Boolean(
        oldImageRequestFailure && /ERR_ABORTED|NS_BINDING_ABORTED/i.test(oldImageRequestFailure)
      ),
    };
    result = {
      status: lateImageCompletion.status === 'passed' ? 'passed' : 'partial',
      controlStatus: 'passed',
      scope: 'installed Edge extension, source-bound production interceptor/parser/Main Canvas',
      sourceBound: final,
      pageScriptProbeProvenance: provenance,
      cap02: {
        initial: capInitial,
        beforeRelease: capBeforeRelease.streams.cap,
        afterRelease: capAfterRelease.streams.cap,
      },
      sessions: { a1, a1Held, b, bHeld, a2, beforeLateRelease, final },
      lateImageCompletion,
      imageRequests,
      pageErrors,
      consoleErrors,
      videoPrerequisite:
        'paused property overridden only for this isolated renderer fixture; no playback claim',
      remainingScope: [
        ...(lateImageCompletion.status === 'inconclusive'
          ? [
              'Old-image late completion was not proven because its route could not fulfill after navigation',
            ]
          : []),
        'No same-session cross-source replacement or old-image redraw count (EVT-02)',
        'No replay seek/body lifecycle or stale Worker completion (RPL-02 and full SES-01 remain open)',
        'No held bootstrap window identity mismatch (UP-01)',
      ],
    };
  } catch (error) {
    primaryError = error;
    try {
      await writeFile(
        join(output, 'acquisition-boundaries-failure.json'),
        JSON.stringify(
          {
            status: 'failed',
            phase,
            failure: describe(error),
            provenance,
            oldImageRequested,
            oldImageReleased,
            oldImageDisposition,
            oldImageError,
            oldImageRequestFailure,
            imageRequests,
            routeErrors,
            pageErrors,
            consoleErrors,
            overflow,
            native: await snapshot(page).catch((snapshotError) => ({
              unavailable: describe(snapshotError),
            })),
          },
          null,
          2
        )
      );
    } catch (diagnosticError) {
      primaryError = new AggregateError(
        [error, diagnosticError],
        'Acquisition fixture and failure receipt failed'
      );
    }
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    async () => releaseHeldImage(),
    async () => {
      if (page.isClosed()) return;
      await page.evaluate(() => {
        const records = window.__ytAcquisitionBoundary?.streams;
        if (!records) return;
        for (const record of [records.cap, records.late]) {
          if (!record.controller || record.released) continue;
          record.controller.close();
          record.released = true;
        }
      });
    },
    async () => probe?.restore(),
    async () => {
      if (!originalSettings || page.isClosed()) return;
      await page.evaluate((settings) => {
        const app = window.__ytChatOverlay;
        if (!app) throw new Error('Installed app disappeared before settings restoration');
        app.applySettings(settings);
      }, originalSettings);
    },
    async () => {
      if (routeInstalled) await page.unroute('**/*', routeHandler);
    },
    async () => page.close(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    try {
      await writeFile(
        join(output, 'acquisition-boundaries-cleanup-failure.json'),
        JSON.stringify(
          {
            status: 'failed',
            scenarioError: primaryError ? describe(primaryError) : null,
            scenarioResult: result ?? null,
            cleanupErrors: cleanupErrors.map(describe),
          },
          null,
          2
        )
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    throw new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      'Acquisition fixture owned-resource cleanup failed'
    );
  }
  if (primaryError) throw primaryError;
  assert(result, 'Acquisition fixture returned no result');
  return result;
}
