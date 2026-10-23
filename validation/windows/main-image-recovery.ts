// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, Page, Request, Route } from '@playwright/test';

import { restoreFixtureSettings } from './fixture-settings.ts';
import {
  installNativePageScriptProbe,
  type NativePageScriptProbe,
} from './native-page-script-probe.ts';
import { buildVisibleWatchHtml } from './visible-watch.ts';

const FIXTURE_URL = 'https://www.youtube.com/watch?v=windowsMainImageRecovery';
const IMAGE_PREFIX = 'https://yt3.ggpht.com/windows-main-issue306-';
const ENTRY_MARKER = '\n\tmain();\n';
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGP8z8DwnwEJMDGgAcICAIPRAgYCkO9YAAAAAElFTkSuQmCC',
  'base64'
);
const MAX_EVENTS = 40;
const MAX_DRAWS = 60;

type AssetKind = 'emoji' | 'author' | 'sticker';
type RoutePlan = 'png' | 'http404' | 'cors' | 'malformed' | 'connectionreset';
type Case = { id: string; kind: AssetKind; plan: RoutePlan; url: string; textToken: string };
type NativeImageEvent = {
  url: string;
  type: 'load' | 'error';
  currentSrc: string;
  naturalWidth: number;
  naturalHeight: number;
};
type NativeDraw = {
  url: string;
  sourceType: 'image' | 'derived-canvas';
  pixelAlpha: number | null;
  imagePixelChanged: boolean;
  pixelBefore: number[] | null;
  pixelAfter: number[] | null;
  pixelError: string | null;
  destination: number[];
  transform: number[];
  canvasDimensions: number[];
  sampledRectangle: { x: number; y: number; width: number; height: number } | null;
};
type NativeState = {
  workerAttempts: Array<{ url: string; type: string; error: string }>;
  workerOverflow: number;
  renderer: {
    imageFetchManager: {
      emojiCache: { has(url: string): boolean };
      authorPhotoCache: { has(url: string): boolean };
      stickerCache: { has(url: string): boolean };
      failedEmojiFetches: Map<string, number>;
      emojiFetching: Set<string>;
      imageLoading: Set<string>;
    };
    activeMessages: Array<{ message: { id?: string } }>;
    settings: { danmakuMode: string; topBottomDurationMs: number };
    workerManager: { workerRef: Worker | null };
  } | null;
  renderFrames: number;
  sourceBound: boolean;
  imageEvents: NativeImageEvent[];
  imageEventOverflow: number;
  draws: NativeDraw[];
  drawOverflow: number;
  textDraws: string[];
  textOverflow: number;
};

declare global {
  interface Window {
    __ytMainImageRecovery?: NativeState;
  }
}

function fixtureCases(): Case[] {
  const entries = [
    { id: 'healthy-emoji', kind: 'emoji', plan: 'png' },
    { id: 'healthy-author', kind: 'author', plan: 'png' },
    { id: 'healthy-sticker', kind: 'sticker', plan: 'png' },
    { id: 'fault-emoji-404', kind: 'emoji', plan: 'http404' },
    { id: 'recovery-emoji', kind: 'emoji', plan: 'png' },
    { id: 'fault-author-cors', kind: 'author', plan: 'cors' },
    { id: 'recovery-author', kind: 'author', plan: 'png' },
    { id: 'fault-author-connection', kind: 'author', plan: 'connectionreset' },
    { id: 'recovery-author-connection', kind: 'author', plan: 'png' },
    { id: 'fault-sticker-malformed', kind: 'sticker', plan: 'malformed' },
    { id: 'recovery-sticker', kind: 'sticker', plan: 'png' },
  ] satisfies Array<Omit<Case, 'url' | 'textToken'>>;
  return entries.map((entry, index) => ({
    ...entry,
    url: `${IMAGE_PREFIX}${entry.id}.png`,
    textToken: `WIN306_${index}`,
  }));
}

function isExpectedFaultConsoleError(
  observation: { text: string; url: string },
  cases: readonly Case[]
): boolean {
  return cases.some((entry) => {
    switch (entry.plan) {
      case 'http404':
        return (
          observation.url === entry.url &&
          observation.text ===
            'Failed to load resource: the server responded with a status of 404 (Not Found)'
        );
      case 'cors':
        return (
          (observation.url === FIXTURE_URL &&
            observation.text.startsWith(
              `Access to image at '${entry.url}' from origin 'https://www.youtube.com' has been blocked by CORS policy:`
            )) ||
          (observation.url === entry.url &&
            observation.text === 'Failed to load resource: net::ERR_FAILED')
        );
      case 'connectionreset':
        return (
          observation.url === entry.url &&
          observation.text === 'Failed to load resource: net::ERR_CONNECTION_RESET'
        );
      default:
        return false;
    }
  });
}

function actionFor(entry: Case) {
  const id = `WINDOWS306_MAIN_${entry.id.toUpperCase().replaceAll('-', '_')}`;
  const authorPhoto = { thumbnails: [{ url: entry.url, width: 48, height: 48 }] };
  if (entry.kind === 'sticker') {
    return {
      addChatItemAction: {
        item: {
          liveChatPaidMessageRenderer: {
            id,
            authorName: { simpleText: 'Main fixture donor' },
            purchaseAmountText: { simpleText: '$5.00' },
            message: { simpleText: entry.textToken },
            sticker: { thumbnails: [{ url: entry.url, width: 48, height: 48 }] },
          },
        },
      },
    };
  }
  return {
    addChatItemAction: {
      item: {
        liveChatTextMessageRenderer: {
          id,
          authorName: { simpleText: 'Main fixture viewer' },
          ...(entry.kind === 'author' ? { authorPhoto } : {}),
          message: {
            runs:
              entry.kind === 'emoji'
                ? [
                    { text: entry.textToken },
                    {
                      emoji: {
                        image: { thumbnails: [{ url: entry.url, width: 48, height: 48 }] },
                        shortcuts: [':fixture:'],
                      },
                    },
                  ]
                : [{ text: entry.textToken }],
          },
        },
      },
    },
  };
}

function chatResponse(action: ReturnType<typeof actionFor> | null) {
  return {
    continuationContents: {
      liveChatContinuation: {
        actions: action ? [action] : [],
        continuations: [
          { timedContinuationData: { continuation: 'windows-main-next', timeoutMs: 30_000 } },
        ],
      },
    },
  };
}

/** Forward native calls while recording bounded observations of the fixture page. */
function installPagePrelude({
  imagePrefix,
  maxEvents,
  maxDraws,
}: {
  imagePrefix: string;
  maxEvents: number;
  maxDraws: number;
}): void {
  const state: NativeState = {
    workerAttempts: [],
    workerOverflow: 0,
    renderer: null,
    renderFrames: 0,
    sourceBound: false,
    imageEvents: [],
    imageEventOverflow: 0,
    draws: [],
    drawOverflow: 0,
    textDraws: [],
    textOverflow: 0,
  };
  window.__ytMainImageRecovery = state;
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get: () => false,
  });
  const NativeWorker = window.Worker;
  window.Worker = new Proxy(NativeWorker, {
    construct(target, args) {
      const [url, options] = args;
      const workerUrl = String(url);
      const bridgeUrl = window.__ytExtensionBridge?.workerUrl;
      if (
        typeof bridgeUrl === 'string' &&
        workerUrl === bridgeUrl &&
        workerUrl.startsWith('blob:https://www.youtube.com/') &&
        options?.type === 'module'
      ) {
        if (state.workerAttempts.length < 4)
          state.workerAttempts.push({
            url: workerUrl,
            type: options.type,
            error: 'SecurityError',
          });
        else state.workerOverflow++;
        throw new DOMException('Fixture worker-src restriction', 'SecurityError');
      }
      return Reflect.construct(target, args);
    },
  });
  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (!srcDescriptor?.set || !srcDescriptor.get) throw new Error('Native Image.src changed');
  const nativeSetSrc = srcDescriptor.set;
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    enumerable: srcDescriptor.enumerable ?? false,
    get: srcDescriptor.get,
    set(this: HTMLImageElement, value: string) {
      const url = String(value);
      if (url.startsWith(imagePrefix)) {
        const record = (type: 'load' | 'error') => {
          const observation: NativeImageEvent = {
            url,
            type,
            currentSrc: this.currentSrc,
            naturalWidth: this.naturalWidth,
            naturalHeight: this.naturalHeight,
          };
          if (state.imageEvents.length < maxEvents) state.imageEvents.push(observation);
          else state.imageEventOverflow++;
        };
        this.addEventListener('load', () => record('load'), { once: true });
        this.addEventListener('error', () => record('error'), { once: true });
      }
      Reflect.apply(nativeSetSrc, this, [value]);
    },
  });

  const derivedUrls = new WeakMap<object, string>();
  const sourceUrl = (image: CanvasImageSource): string | null => {
    if (image instanceof HTMLImageElement) return image.currentSrc || image.src || null;
    return typeof image === 'object' && image !== null ? (derivedUrls.get(image) ?? null) : null;
  };
  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
    const offscreen = OffscreenCanvasRenderingContext2D.prototype;
    const nativeOffscreenDraw = offscreen.drawImage;
    offscreen.drawImage = function (image: CanvasImageSource, ...args: number[]): void {
      Reflect.apply(nativeOffscreenDraw, this, [image, ...args]);
      const url = sourceUrl(image);
      if (url?.startsWith(imagePrefix)) derivedUrls.set(this.canvas, url);
    };
  }
  const canvas = CanvasRenderingContext2D.prototype;
  const nativeDraw = canvas.drawImage;
  canvas.drawImage = function (image: CanvasImageSource, ...args: number[]): void {
    const url = sourceUrl(image);
    const overlay = this.canvas.closest('#yt-live-chat-overlay') !== null;
    if (!url?.startsWith(imagePrefix) || !overlay) {
      Reflect.apply(nativeDraw, this, [image, ...args]);
      if (url?.startsWith(imagePrefix)) derivedUrls.set(this.canvas, url);
      return;
    }
    let pixelAlpha: number | null = null;
    let imagePixelChanged = false;
    let pixelBefore: number[] | null = null;
    let pixelAfter: number[] | null = null;
    let pixelError: string | null = null;
    let before: ImageData | undefined;
    let rectangle: { x: number; y: number; width: number; height: number } | undefined;
    const width =
      image instanceof HTMLImageElement
        ? image.naturalWidth
        : 'width' in image && typeof image.width === 'number'
          ? image.width
          : 0;
    const height =
      image instanceof HTMLImageElement
        ? image.naturalHeight
        : 'height' in image && typeof image.height === 'number'
          ? image.height
          : 0;
    const destination =
      args.length === 2
        ? [args[0], args[1], width, height]
        : args.length === 4
          ? args
          : args.length === 8
            ? args.slice(4)
            : [];
    if (destination.length === 4) {
      const [dx = 0, dy = 0, dw = 0, dh = 0] = destination;
      const transform = this.getTransform();
      const corners = [
        [dx, dy],
        [dx + dw, dy],
        [dx, dy + dh],
        [dx + dw, dy + dh],
      ].map(([x = 0, y = 0]) => ({
        x: transform.a * x + transform.c * y + transform.e,
        y: transform.b * x + transform.d * y + transform.f,
      }));
      const x = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.x))));
      const y = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.y))));
      const right = Math.min(
        this.canvas.width,
        Math.ceil(Math.max(...corners.map((point) => point.x)))
      );
      const bottom = Math.min(
        this.canvas.height,
        Math.ceil(Math.max(...corners.map((point) => point.y)))
      );
      const width = right - x;
      const height = bottom - y;
      if (width > 0 && height > 0 && width * height <= 65_536) {
        rectangle = { x, y, width, height };
        try {
          before = this.getImageData(x, y, width, height);
        } catch (error) {
          pixelError = error instanceof Error ? error.name : String(error);
        }
      }
    }
    Reflect.apply(nativeDraw, this, [image, ...args]);
    if (before && rectangle) {
      try {
        const after = this.getImageData(
          rectangle.x,
          rectangle.y,
          rectangle.width,
          rectangle.height
        );
        for (let index = 0; index < after.data.length; index += 4) {
          // This exact draw must move a pixel toward the fixture's red colour.
          // Native fade/opacity can blend it with an existing paid-card background.
          if (
            (after.data[index] ?? 0) >= (before.data[index] ?? 0) &&
            (after.data[index + 1] ?? 255) <= (before.data[index + 1] ?? 0) &&
            (after.data[index + 2] ?? 255) <= (before.data[index + 2] ?? 0) &&
            (after.data[index + 3] ?? 0) > 0 &&
            after.data
              .slice(index, index + 3)
              .some((value, offset) => value !== before.data[index + offset])
          ) {
            imagePixelChanged = true;
            pixelBefore = Array.from(before.data.slice(index, index + 4));
            pixelAfter = Array.from(after.data.slice(index, index + 4));
            pixelAlpha = pixelAfter[3] ?? null;
            break;
          }
        }
      } catch (error) {
        pixelError = error instanceof Error ? error.name : String(error);
      }
    }
    const draw: NativeDraw = {
      url,
      sourceType: image instanceof HTMLImageElement ? 'image' : 'derived-canvas',
      pixelAlpha,
      imagePixelChanged,
      pixelBefore,
      pixelAfter,
      pixelError,
      destination: destination.filter((value): value is number => value !== undefined),
      transform: Array.from(this.getTransform().toFloat64Array()),
      canvasDimensions: [this.canvas.width, this.canvas.height],
      sampledRectangle: rectangle ?? null,
    };
    const previousIndex = state.draws.findIndex((candidate) => candidate.url === url);
    if (previousIndex >= 0) {
      const previous = state.draws[previousIndex];
      if (previous && !previous.imagePixelChanged) state.draws[previousIndex] = draw;
    } else if (state.draws.length < maxDraws) state.draws.push(draw);
    else state.drawOverflow++;
  };
  const nativeFillText = canvas.fillText;
  canvas.fillText = function (text: string, x: number, y: number, maxWidth?: number): void {
    Reflect.apply(
      nativeFillText,
      this,
      maxWidth === undefined ? [text, x, y] : [text, x, y, maxWidth]
    );
    if (!text.includes('WIN306_')) return;
    if (state.textDraws.includes(text)) return;
    if (state.textDraws.length < maxDraws) state.textDraws.push(text.slice(0, 120));
    else state.textOverflow++;
  };
  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
    const offscreen = OffscreenCanvasRenderingContext2D.prototype;
    const nativeOffscreenFillText = offscreen.fillText;
    offscreen.fillText = function (text: string, x: number, y: number, maxWidth?: number): void {
      Reflect.apply(
        nativeOffscreenFillText,
        this,
        maxWidth === undefined ? [text, x, y] : [text, x, y, maxWidth]
      );
      if (!text.includes('WIN306_') || state.textDraws.includes(text)) return;
      if (state.textDraws.length < maxDraws) state.textDraws.push(text.slice(0, 120));
      else state.textOverflow++;
    };
  }
  window.ytcfg = {
    data_: {
      INNERTUBE_API_KEY: 'windows-acceptance-key',
      INNERTUBE_CONTEXT_CLIENT_NAME: '1',
      INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
      INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
    },
  };
  window.ytInitialData = {
    currentVideoEndpoint: { watchEndpoint: { videoId: 'windowsMainImageRecovery' } },
    contents: {
      twoColumnWatchNextResults: {
        conversationBar: {
          liveChatRenderer: {
            isReplay: false,
            continuations: [
              {
                timedContinuationData: {
                  continuation: 'windows-main-live',
                  timeoutMs: 30_000,
                },
              },
            ],
          },
        },
      },
    },
  };
}

function describeError(error: unknown): unknown {
  return {
    message: String(error).slice(0, 2_000),
    stack: error instanceof Error ? error.stack?.slice(0, 4_000) : null,
  };
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const state = window.__ytMainImageRecovery;
    if (!state) throw new Error('Main image page prelude is unavailable');
    return {
      workerAttempts: state.workerAttempts,
      workerOverflow: state.workerOverflow,
      sourceBound: state.sourceBound,
      renderFrames: state.renderFrames,
      nativeWorker: state.renderer?.workerManager.workerRef !== null,
      activeIds: state.renderer?.activeMessages.map((entry) => entry.message.id ?? null) ?? [],
      imageEvents: state.imageEvents,
      imageEventOverflow: state.imageEventOverflow,
      draws: state.draws,
      drawOverflow: state.drawOverflow,
      textDraws: state.textDraws,
      textOverflow: state.textOverflow,
    };
  });
}

/** Installed Edge Main fallback: one real Worker constructor failure and native image recovery. */
export async function runMainImageRecoveryFixture({
  context,
  root,
  output,
  extensionId,
}: {
  context: BrowserContext;
  root: string;
  output: string;
  extensionId: string;
}) {
  assert.match(extensionId, /^[a-p]{32}$/);
  const source = await readFile(join(root, 'dist-extension/page-script.js'), 'utf8');
  assert.equal(source.split(ENTRY_MARKER).length, 2, 'Packaged page entry changed');
  assert(
    source.includes('var CanvasRenderer = class CanvasRenderer'),
    'Packaged Main renderer changed'
  );
  const instrumented = source.replace(
    ENTRY_MARKER,
    '\n\tconst mainImageState = window.__ytMainImageRecovery;\n' +
      `\tif (!mainImageState) throw new Error('Main image prelude is unavailable');\n` +
      '\tconst nativeMainFrame = CanvasRenderer.prototype.renderFrame;\n' +
      '\tCanvasRenderer.prototype.renderFrame = function(...args) {\n' +
      '\t\tmainImageState.renderer = this;\n' +
      '\t\tmainImageState.renderFrames++;\n' +
      '\t\treturn nativeMainFrame.apply(this, args);\n' +
      '\t};\n' +
      `\tmainImageState.sourceBound = true;${ENTRY_MARKER}`
  );
  const preview = await readFile(join(root, 'test/visual/preview.html'), 'utf8');
  const html = buildVisibleWatchHtml(preview, 'Main image recovery fixture video');
  const cases = fixtureCases();
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  const byUrl = new Map(cases.map((entry) => [entry.url, entry]));
  const delivered = new Set<string>();
  const imageRequests: Array<{ url: string; status: number | null; kind: AssetKind }> = [];
  let imageRequestOverflow = 0;
  const requestResults = new Map<
    Request,
    { url: string; status: number | null; terminal: string }
  >();
  let requestOverflow = 0;
  const page = await context.newPage();
  const pageErrors: string[] = [];
  let pageErrorOverflow = 0;
  const consoleErrors: Array<{ text: string; url: string }> = [];
  let consoleErrorOverflow = 0;
  page.on('pageerror', (error) => {
    if (pageErrors.length < 10) pageErrors.push(error.name);
    else pageErrorOverflow++;
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (consoleErrors.length < 20)
      consoleErrors.push({ text: message.text().slice(0, 500), url: message.location().url });
    else consoleErrorOverflow++;
  });
  page.on('request', (request) => {
    if (!request.url().startsWith(IMAGE_PREFIX)) return;
    if (requestResults.size < MAX_EVENTS)
      requestResults.set(request, { url: request.url(), status: null, terminal: 'pending' });
    else requestOverflow++;
  });
  page.on('response', (response) => {
    const record = requestResults.get(response.request());
    if (record) record.status = response.status();
  });
  page.on('requestfinished', (request) => {
    const record = requestResults.get(request);
    if (record) record.terminal = 'finished';
  });
  page.on('requestfailed', (request) => {
    const record = requestResults.get(request);
    if (record) record.terminal = request.failure()?.errorText.slice(0, 300) ?? 'failed';
  });
  const routeHandler = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.protocol === 'chrome-extension:' && url.hostname === extensionId)
      return route.continue();
    const image = byUrl.get(url.href);
    if (image) {
      const status = image.plan === 'connectionreset' ? null : image.plan === 'http404' ? 404 : 200;
      if (imageRequests.length < MAX_EVENTS)
        imageRequests.push({ url: url.href, status, kind: image.kind });
      else imageRequestOverflow++;
      if (image.plan === 'connectionreset') return route.abort('connectionreset');
      assert(status !== null);
      return route.fulfill({
        status,
        contentType: image.plan === 'http404' ? 'text/plain' : 'image/png',
        headers: {
          'access-control-allow-origin':
            image.plan === 'cors' ? 'https://cors-denied.example.test' : '*',
          'cache-control': 'no-store',
        },
        body:
          image.plan === 'malformed'
            ? Buffer.from([0, 1, 2, 3])
            : image.plan === 'http404'
              ? Buffer.from('Fixture image not found')
              : RED_PNG,
      });
    }
    if (url.hostname === 'www.youtube.com' && request.resourceType() === 'document')
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (url.hostname === 'www.youtube.com' && url.pathname === '/favicon.ico')
      return route.fulfill({ status: 204 });
    if (
      url.hostname === 'www.youtube.com' &&
      url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat')
    ) {
      const id = url.searchParams.get('windows306');
      const entry = id ? byId.get(id) : undefined;
      const deliver = entry && !delivered.has(entry.id);
      if (deliver) delivered.add(entry.id);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: chatResponse(deliver ? actionFor(entry) : null),
      });
    }
    return route.fulfill({
      status: 403,
      contentType: 'text/plain',
      body: 'Blocked by Main fixture',
    });
  };
  let routeInstalled = false;
  let nativePageProbe: NativePageScriptProbe | undefined;
  let pageScriptProbeProvenance: NativePageScriptProbe['provenance'] | null = null;
  let originalSettings:
    | ReturnType<NonNullable<Window['__ytChatOverlay']>['getSettings']>
    | undefined;
  let primaryError: unknown;
  const caseResults: Array<{
    id: string;
    kind: AssetKind;
    plan: RoutePlan;
    imageEvent: NativeImageEvent;
    routeStatus: number | null;
    networkStatus: number | null;
    networkTerminal: string;
    cacheHit: boolean;
    negativeEmoji: boolean;
    drawnOnOverlay: boolean;
    positivePixel: boolean;
    textObserved: boolean;
  }> = [];
  const execute = async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.route('**/*', routeHandler);
    routeInstalled = true;
    await page.addInitScript(installPagePrelude, {
      imagePrefix: IMAGE_PREFIX,
      maxEvents: MAX_EVENTS,
      maxDraws: MAX_DRAWS,
    });
    nativePageProbe = await installNativePageScriptProbe({
      context,
      root,
      extensionId,
      fixtureUrl: FIXTURE_URL,
      instrumentedSource: instrumented,
    });
    pageScriptProbeProvenance = nativePageProbe.provenance;
    await nativePageProbe.assertReady();
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page
      .locator('#yt-live-chat-overlay canvas')
      .waitFor({ state: 'attached', timeout: 15_000 });
    await nativePageProbe.assertInjected();
    await nativePageProbe.restore();
    nativePageProbe = undefined;
    await page.waitForFunction(
      () => {
        const state = window.__ytMainImageRecovery;
        return state?.sourceBound && state.renderer !== null && state.renderFrames > 0;
      },
      undefined,
      { timeout: 15_000 }
    );
    await page.waitForFunction(() => Boolean(window.__ytChatOverlay?.getSettings), undefined, {
      timeout: 15_000,
    });
    originalSettings = await page.evaluate(() => {
      const app = window.__ytChatOverlay;
      if (!app) throw new Error('Installed Main app is unavailable');
      const settings = structuredClone(app.getSettings());
      app.applySettings({
        danmakuMode: 'top',
        topBottomDurationMs: 2_000,
        showAuthor: { ...settings.showAuthor, normal: true, superChat: true },
        showDebugOverlay: true,
        allowShortTextMessages: true,
        translationEnabled: false,
        depthLayersEnabled: false,
        maxConcurrentMessages: 50,
      });
      return settings;
    });
    await page.waitForFunction(
      () => {
        const settings = window.__ytMainImageRecovery?.renderer?.settings;
        return settings?.danmakuMode === 'top' && settings.topBottomDurationMs === 2_000;
      },
      undefined,
      { timeout: 5_000 }
    );
    const initial = await snapshot(page);
    assert(initial.sourceBound && initial.renderFrames > 0, 'Packaged Main renderer did not run');
    assert.equal(initial.nativeWorker, false, 'Worker remained active after constructor fault');
    assert.equal(initial.workerAttempts.length, 1, 'Exact bridge Worker was not attempted once');
    assert(initial.workerAttempts[0]?.url.startsWith('blob:https://www.youtube.com/'));
    assert.equal(initial.workerAttempts[0]?.type, 'module');
    assert.equal(initial.workerAttempts[0]?.error, 'SecurityError');
    assert.equal(initial.workerOverflow, 0);

    for (const entry of cases) {
      await page.evaluate(async (id) => {
        const response = await fetch(
          `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?windows306=${id}`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
        );
        if (!response.ok) throw new Error('Main fixture chat request failed');
        await response.json();
      }, entry.id);
      assert(delivered.has(entry.id), `Main fixture batch ${entry.id} was not intercepted`);
      const messageId = `WINDOWS306_MAIN_${entry.id.toUpperCase().replaceAll('-', '_')}`;
      await page.waitForFunction(
        ({ url, id, textToken, expectSuccess, kind }) => {
          const state = window.__ytMainImageRecovery;
          const renderer = state?.renderer;
          if (!state || !renderer) return false;
          const manager = renderer.imageFetchManager;
          const cache =
            kind === 'author'
              ? manager.authorPhotoCache
              : kind === 'sticker'
                ? manager.stickerCache
                : manager.emojiCache;
          const event = state.imageEvents.find(
            (candidate) =>
              candidate.url === url && candidate.type === (expectSuccess ? 'load' : 'error')
          );
          const hasMessage = renderer.activeMessages.some((item) => item.message.id === id);
          const textDrawn = state.textDraws.some((text) => text.includes(textToken));
          return Boolean(event && hasMessage && textDrawn && cache.has(url) === expectSuccess);
        },
        {
          url: entry.url,
          id: messageId,
          textToken: entry.textToken,
          expectSuccess: entry.plan === 'png',
          kind: entry.kind,
        },
        { timeout: 15_000 }
      );
      if (entry.plan === 'png') {
        await page.waitForFunction(
          (url) =>
            window.__ytMainImageRecovery?.draws.some(
              (draw) => draw.url === url && draw.imagePixelChanged
            ) === true,
          entry.url,
          { timeout: 15_000 }
        );
      }
      await page
        .locator(`.yt-live-chat-overlay-live-region > p[data-message-id="${messageId}"]`)
        .waitFor({ state: 'attached', timeout: 15_000 });
      const observation = await page.evaluate(
        ({ url, kind, textToken }) => {
          const state = window.__ytMainImageRecovery;
          const manager = state?.renderer?.imageFetchManager;
          if (!state || !manager) throw new Error('Main image manager observation disappeared');
          const cache =
            kind === 'author'
              ? manager.authorPhotoCache
              : kind === 'sticker'
                ? manager.stickerCache
                : manager.emojiCache;
          const event = state.imageEvents.find((candidate) => candidate.url === url);
          const draws = state.draws.filter((draw) => draw.url === url);
          return {
            event,
            cacheHit: cache.has(url),
            negativeEmoji: manager.failedEmojiFetches.has(url),
            drawnOnOverlay: draws.length > 0,
            positivePixel: draws.some((draw) => draw.imagePixelChanged),
            textObserved: state.textDraws.some((text) => text.includes(textToken)),
          };
        },
        { url: entry.url, kind: entry.kind, textToken: entry.textToken }
      );
      assert(observation.event, `Native Image event was not observed for ${entry.id}`);
      assert(observation.textObserved, `Native Main text draw was not observed for ${entry.id}`);
      const imageEvent = observation.event;
      assert.equal(imageEvent.type, entry.plan === 'png' ? 'load' : 'error');
      if (entry.plan === 'png') {
        assert(imageEvent.naturalWidth > 0 && imageEvent.naturalHeight > 0);
        assert(observation.cacheHit && observation.drawnOnOverlay && observation.positivePixel);
      } else {
        assert.equal(observation.cacheHit, false);
        assert.equal(observation.drawnOnOverlay, false);
        if (entry.plan === 'connectionreset') {
          assert.equal(imageEvent.naturalWidth, 0);
          assert.equal(imageEvent.naturalHeight, 0);
        }
      }
      if (entry.id === 'fault-emoji-404')
        assert(observation.negativeEmoji, 'Main failed-emoji suppression was not set');
      const requests = imageRequests.filter((request) => request.url === entry.url);
      assert.equal(requests.length, 1, `Image request identity changed for ${entry.id}`);
      assert.equal(
        requests[0]?.status,
        entry.plan === 'connectionreset' ? null : entry.plan === 'http404' ? 404 : 200
      );
      const network = [...requestResults.values()].filter((request) => request.url === entry.url);
      assert.equal(network.length, 1, `Native request count changed for ${entry.id}`);
      if (entry.plan === 'connectionreset') {
        assert.equal(network[0]?.status, null, 'A connection reset cannot have an HTTP response');
        assert.equal(network[0]?.terminal, 'net::ERR_CONNECTION_RESET');
      } else if (entry.plan === 'cors') {
        // The route serves 200, but CORS rejection may suppress Playwright's
        // response event. The native Image error and exact request still bind it.
        assert(network[0]?.status === null || network[0]?.status === 200);
        assert.equal(network[0]?.terminal, 'net::ERR_FAILED');
      } else {
        assert.equal(network[0]?.status, entry.plan === 'http404' ? 404 : 200);
        assert.equal(network[0]?.terminal, 'finished');
      }
      if (entry.id === 'recovery-author-connection') {
        assert.equal(caseResults.at(-1)?.id, 'fault-author-connection');
        assert.notEqual(
          entry.url,
          cases.find((candidate) => candidate.id === 'fault-author-connection')?.url
        );
        assert(observation.positivePixel, 'Author photo did not recover after connection reset');
      }
      caseResults.push({
        id: entry.id,
        kind: entry.kind,
        plan: entry.plan,
        imageEvent,
        routeStatus: requests[0]?.status ?? null,
        networkStatus: network[0]?.status ?? null,
        networkTerminal: network[0]?.terminal ?? 'unavailable',
        cacheHit: observation.cacheHit,
        negativeEmoji: observation.negativeEmoji,
        drawnOnOverlay: observation.drawnOnOverlay,
        positivePixel: observation.positivePixel,
        textObserved: observation.textObserved,
      });
      // Let this real message retire before the next independent case so
      // lane capacity cannot be mistaken for an image acquisition failure.
      await page.waitForFunction(
        (id) =>
          window.__ytMainImageRecovery?.renderer?.activeMessages.every(
            (item) => item.message.id !== id
          ),
        messageId,
        { timeout: 8_000 }
      );
    }
    const final = await snapshot(page);
    assert.equal(final.imageEventOverflow, 0);
    assert.equal(final.drawOverflow, 0);
    assert.equal(final.textOverflow, 0);
    assert.equal(imageRequestOverflow, 0);
    assert.equal(requestOverflow, 0);
    assert.equal(pageErrors.length, 0, 'Unexpected page script error during Main recovery');
    assert.equal(pageErrorOverflow, 0);
    assert.deepEqual(
      consoleErrors.filter((entry) => !isExpectedFaultConsoleError(entry, cases)),
      [],
      'Unexpected console error outside exact Main image faults'
    );
    assert.equal(consoleErrorOverflow, 0);
    return {
      status: 'passed',
      scope: 'installed Edge extension; real packaged Main Canvas and native HTMLImageElement',
      videoPrerequisite:
        'paused property overridden only in this isolated rendering fixture; no player acceptance claim',
      workerFault: 'one exact extension renderer Worker constructor SecurityError',
      pageScriptProbeProvenance,
      cases: caseResults,
      imageRequests,
      requestResults: [...requestResults.values()],
      native: final,
      pageErrors,
      pageErrorOverflow,
      consoleErrors,
      consoleErrorOverflow,
      gap: 'Does not prove a fresh Worker after a new document, live YouTube image delivery, or every image timeout/TTL boundary',
    };
  };
  let result: Awaited<ReturnType<typeof execute>> | undefined;
  try {
    result = await execute();
  } catch (error) {
    primaryError = error;
    try {
      await writeFile(
        join(output, 'main-image-recovery-failure.json'),
        JSON.stringify(
          {
            status: 'failed',
            failure: describeError(error),
            pageScriptProbeProvenance,
            completedCases: caseResults,
            imageRequests,
            imageRequestOverflow,
            requestResults: [...requestResults.values()],
            requestOverflow,
            pageErrors,
            pageErrorOverflow,
            consoleErrors,
            consoleErrorOverflow,
            native: await snapshot(page).catch((snapshotError) => ({
              unavailable: describeError(snapshotError),
            })),
          },
          null,
          2
        )
      );
    } catch (diagnosticError) {
      primaryError = new AggregateError(
        [error, diagnosticError],
        'Main image fixture and failure diagnostic collection failed'
      );
    }
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    async () => nativePageProbe?.restore(),
    async () => {
      if (originalSettings && !page.isClosed()) {
        await restoreFixtureSettings(context, page, extensionId, originalSettings);
      }
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
        join(output, 'main-image-recovery-cleanup-failure.json'),
        JSON.stringify(
          {
            status: 'failed',
            scenarioError: primaryError ? describeError(primaryError) : null,
            scenarioResult: result ?? null,
            cleanupErrors: cleanupErrors.map(describeError),
          },
          null,
          2
        )
      );
    } catch (diagnosticError) {
      cleanupErrors.push(diagnosticError);
    }
    throw new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      'Main image fixture owned-resource cleanup failed'
    );
  }
  if (primaryError) throw primaryError;
  assert(result, 'Main image fixture completed without a result');
  return result;
}
