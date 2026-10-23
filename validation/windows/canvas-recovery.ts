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
const IMAGE_PREFIX = 'https://yt3.ggpht.com/windows-canvas-recovery-';
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGP8z8DwnwEJMDGgAcICAIPRAgYCkO9YAAAAAElFTkSuQmCC',
  'base64'
);
const MAX_RECORDS = 32;
type Variant = 'main-context-restored' | 'worker-replacement-retry';
type RendererProbe = {
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  workerManager: {
    isActive: boolean;
    workerRef: Worker | null;
    activeMessageCount: number;
    isAlive(): boolean;
  };
  fallbackInProgress: boolean;
  fallbackRecoveryFailed: boolean;
  fallbackIngressQueue: { size: number };
  pendingQueue: { size: number; toArray(): Array<{ id?: string }> };
  activeMessages: Array<{ message: { id?: string } }>;
  imageFetchManager: { authorPhotoCache: { has(url: string): boolean } };
  settings: { danmakuMode: string; topBottomDurationMs: number; queueMaxSize: number };
  addMessage(message: {
    id: string;
    text: string;
    content: Array<{ type: 'text'; content: string }>;
    kind: 'text';
    timestamp: number;
    authorType: 'normal';
    authorPhotoUrl: string;
  }): void;
  fallbackToMainThread(reason: string): void;
};
type ProbeState = {
  imagePrefix: string;
  renderer: RendererProbe | null;
  initialCanvas: HTMLCanvasElement | null;
  initialApp: Window['__ytChatOverlay'] | null;
  rendererIdentityChanges: number;
  restorationCalls: number;
  sourceBound: boolean;
  frames: number;
  workerAttempts: number;
  replacementNulls: number;
  nullNextReplacement: boolean;
  faultOriginalCanvas: HTMLCanvasElement | null;
  fallbackReasons: string[];
  textDraws: string[];
  imageDraws: Array<{ url: string; width: number; height: number; transform: number[] }>;
  overflow: number;
};

declare global {
  interface Window {
    __ytCanvasRecovery?: ProbeState;
  }
}

function prelude({
  variant,
  videoId,
  imagePrefix,
  maxRecords,
}: {
  variant: Variant;
  videoId: string;
  imagePrefix: string;
  maxRecords: number;
}): void {
  const state: ProbeState = {
    imagePrefix,
    renderer: null,
    initialCanvas: null,
    initialApp: null,
    rendererIdentityChanges: 0,
    restorationCalls: 0,
    sourceBound: false,
    frames: 0,
    workerAttempts: 0,
    replacementNulls: 0,
    nullNextReplacement: false,
    faultOriginalCanvas: null,
    fallbackReasons: [],
    textDraws: [],
    imageDraws: [],
    overflow: 0,
  };
  window.__ytCanvasRecovery = state;
  // This isolated rendering page has no player stream. It does not establish
  // player acceptance; only the production Canvas and Worker are under test.
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get: () => false,
  });
  if (variant === 'main-context-restored') {
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
  }
  const nativeGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    ...args
  ): RenderingContext | null {
    if (
      state.nullNextReplacement &&
      args[0] === '2d' &&
      this.closest('#yt-live-chat-overlay') &&
      this !== state.faultOriginalCanvas
    ) {
      state.nullNextReplacement = false;
      state.replacementNulls++;
      return null;
    }
    return Reflect.apply(nativeGetContext, this, args) as RenderingContext | null;
  } as typeof HTMLCanvasElement.prototype.getContext;
  const nativeFillText = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (
    text: string,
    x: number,
    y: number,
    maxWidth?: number
  ): void {
    Reflect.apply(
      nativeFillText,
      this,
      maxWidth === undefined ? [text, x, y] : [text, x, y, maxWidth]
    );
    if (!text.startsWith('WIN306_CANVAS_') || !this.canvas.closest('#yt-live-chat-overlay')) return;
    if (state.textDraws.includes(text)) return;
    if (state.textDraws.length < maxRecords) state.textDraws.push(text);
    else state.overflow++;
  };
  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
    const nativeOffscreenFillText = OffscreenCanvasRenderingContext2D.prototype.fillText;
    OffscreenCanvasRenderingContext2D.prototype.fillText = function (
      text: string,
      x: number,
      y: number,
      maxWidth?: number
    ): void {
      Reflect.apply(
        nativeOffscreenFillText,
        this,
        maxWidth === undefined ? [text, x, y] : [text, x, y, maxWidth]
      );
      if (!text.startsWith('WIN306_CANVAS_') || state.textDraws.includes(text)) return;
      if (state.textDraws.length < maxRecords) state.textDraws.push(text);
      else state.overflow++;
    };
  }
  const derivedUrls = new WeakMap<object, string>();
  const sourceUrl = (image: CanvasImageSource): string | null => {
    if (image instanceof HTMLImageElement) return image.currentSrc || image.src || null;
    return typeof image === 'object' && image !== null ? (derivedUrls.get(image) ?? null) : null;
  };
  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
    const nativeOffscreenDraw = OffscreenCanvasRenderingContext2D.prototype.drawImage;
    OffscreenCanvasRenderingContext2D.prototype.drawImage = function (
      image: CanvasImageSource,
      ...args: number[]
    ): void {
      Reflect.apply(nativeOffscreenDraw, this, [image, ...args]);
      const url = sourceUrl(image);
      if (url?.startsWith(imagePrefix)) derivedUrls.set(this.canvas, url);
    };
  }
  const nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (
    image: CanvasImageSource,
    ...args: number[]
  ): void {
    Reflect.apply(nativeDrawImage, this, [image, ...args]);
    const url = sourceUrl(image);
    if (url?.startsWith(imagePrefix) && !this.canvas.closest('#yt-live-chat-overlay'))
      derivedUrls.set(this.canvas, url);
    if (!url?.startsWith(imagePrefix)) return;
    if (!this.canvas.closest('#yt-live-chat-overlay')) return;
    if (state.imageDraws.some((entry) => entry.url === url)) return;
    const matrix = this.getTransform();
    if (state.imageDraws.length < maxRecords)
      state.imageDraws.push({
        url,
        width: this.canvas.width,
        height: this.canvas.height,
        transform: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f],
      });
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
    currentVideoEndpoint: { watchEndpoint: { videoId } },
    contents: {
      twoColumnWatchNextResults: {
        conversationBar: {
          liveChatRenderer: {
            isReplay: false,
            continuations: [
              { timedContinuationData: { continuation: 'windows-canvas-next', timeoutMs: 30_000 } },
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

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const state = window.__ytCanvasRecovery;
    const renderer = state?.renderer;
    if (!state || !renderer) throw new Error('Packaged Canvas renderer was not captured');
    const canvas = renderer.canvas;
    const transform = renderer.ctx?.getTransform();
    return {
      sourceBound: state.sourceBound,
      appPinned: window.__ytChatOverlay === state.initialApp,
      canvasPinned: canvas === state.initialCanvas,
      oldCanvasConnected: state.initialCanvas?.isConnected ?? null,
      rendererIdentityChanges: state.rendererIdentityChanges,
      restorationCalls: state.restorationCalls,
      frames: state.frames,
      workerAttempts: state.workerAttempts,
      workerActive: renderer.workerManager.isActive,
      workerPresent: renderer.workerManager.workerRef !== null,
      workerAlive: renderer.workerManager.isAlive(),
      workerActiveCount: renderer.workerManager.activeMessageCount,
      fallbackInProgress: renderer.fallbackInProgress,
      fallbackRecoveryFailed: renderer.fallbackRecoveryFailed,
      fallbackIngressSize: renderer.fallbackIngressQueue.size,
      pendingIds: renderer.pendingQueue
        .toArray()
        .map((entry) => entry.id ?? null)
        .slice(0, 32),
      pendingSize: renderer.pendingQueue.size,
      activeIds: renderer.activeMessages.map((entry) => entry.message.id ?? null).slice(0, 32),
      queueMaxSize: renderer.settings.queueMaxSize,
      canvasCount: document.querySelectorAll('#yt-live-chat-overlay canvas').length,
      canvasConnected: canvas?.isConnected ?? false,
      canvasWidth: canvas?.width ?? null,
      canvasHeight: canvas?.height ?? null,
      cssWidth: canvas?.getBoundingClientRect().width ?? null,
      cssHeight: canvas?.getBoundingClientRect().height ?? null,
      dpr: devicePixelRatio,
      transform: transform
        ? [transform.a, transform.b, transform.c, transform.d, transform.e, transform.f]
        : null,
      replacementNulls: state.replacementNulls,
      fallbackReasons: state.fallbackReasons,
      textDraws: state.textDraws,
      imageDraws: state.imageDraws,
      overflow: state.overflow,
    };
  });
}

function assertDpr(state: Awaited<ReturnType<typeof snapshot>>): void {
  assert(state.canvasConnected && state.canvasCount === 1);
  assert(state.cssWidth !== null && state.cssWidth > 0);
  assert(state.cssHeight !== null && state.cssHeight > 0);
  assert(state.canvasWidth !== null && state.canvasWidth > 0);
  assert(state.canvasHeight !== null && state.canvasHeight > 0);
  assert(Math.abs(state.canvasWidth / state.cssWidth - state.dpr) < 0.05);
  assert(Math.abs(state.canvasHeight / state.cssHeight - state.dpr) < 0.05);
  const scaleX = state.transform?.[0];
  const scaleY = state.transform?.[3];
  assert(typeof scaleX === 'number' && Math.abs(scaleX - state.dpr) < 0.05);
  assert(typeof scaleY === 'number' && Math.abs(scaleY - state.dpr) < 0.05);
}

async function sendAndObserve(page: Page, id: string): Promise<void> {
  await page.evaluate((value) => {
    const renderer = window.__ytCanvasRecovery?.renderer;
    if (!renderer) throw new Error('Canvas renderer disappeared');
    const text = `WIN306_CANVAS_${value}`;
    renderer.addMessage({
      id: value,
      text,
      content: [{ type: 'text', content: text }],
      kind: 'text',
      timestamp: Date.now(),
      authorType: 'normal',
      authorPhotoUrl: `${window.__ytCanvasRecovery?.imagePrefix}${value}.png`,
    });
  }, id);
  await page.waitForFunction(
    (value) => {
      const state = window.__ytCanvasRecovery;
      return Boolean(
        state?.textDraws.includes(`WIN306_CANVAS_${value}`) &&
        state.renderer?.imageFetchManager.authorPhotoCache.has(
          `${state.imagePrefix}${value}.png`
        ) &&
        state.imageDraws.some((draw) => draw.url === `${state.imagePrefix}${value}.png`)
      );
    },
    id,
    { timeout: 12_000 }
  );
}

async function runVariant({
  context,
  root,
  output,
  extensionId,
  variant,
  source,
  preview,
}: {
  context: BrowserContext;
  root: string;
  output: string;
  extensionId: string;
  variant: Variant;
  source: string;
  preview: string;
}) {
  const videoId = variant === 'main-context-restored' ? 'windowsCanvasMain' : 'windowsCanvasWorker';
  const fixtureUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const instrumented = source.replace(
    ENTRY_MARKER,
    `\n\tconst recoveryState = window.__ytCanvasRecovery;\n` +
      `\tif (!recoveryState) throw new Error('Canvas recovery prelude unavailable');\n` +
      `\tconst nativeRecoveryFrame = CanvasRenderer.prototype.renderFrame;\n` +
      `\tCanvasRenderer.prototype.renderFrame = function(...args) {\n` +
      `\t\tif (recoveryState.renderer && recoveryState.renderer !== this) recoveryState.rendererIdentityChanges++;\n` +
      `\t\trecoveryState.renderer = this; recoveryState.frames++;\n` +
      `\t\treturn nativeRecoveryFrame.apply(this, args);\n` +
      `\t};\n` +
      `\tconst nativeRecoveryFallback = CanvasRenderer.prototype.fallbackToMainThread;\n` +
      `\tCanvasRenderer.prototype.fallbackToMainThread = function(reason) {\n` +
      `\t\tif (recoveryState.fallbackReasons.length < ${MAX_RECORDS}) recoveryState.fallbackReasons.push(reason);\n` +
      `\t\telse recoveryState.overflow++;\n` +
      `\t\treturn nativeRecoveryFallback.call(this, reason);\n` +
      `\t};\n` +
      `\tconst nativeRecoveryRestored = CanvasRenderer.prototype.handleContextRestored;\n` +
      `\tCanvasRenderer.prototype.handleContextRestored = function(...args) {\n` +
      `\t\trecoveryState.restorationCalls++;\n` +
      `\t\treturn nativeRecoveryRestored.apply(this, args);\n` +
      `\t};\n` +
      `\trecoveryState.sourceBound = true;${ENTRY_MARKER}`
  );
  const html = buildVisibleWatchHtml(preview, 'Canvas recovery fixture video');
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  let errorOverflow = 0;
  const imageRequests: string[] = [];
  page.on('pageerror', (error) => {
    if (pageErrors.length < 10) pageErrors.push(error.name);
    else errorOverflow++;
  });
  page.on('console', (entry) => {
    if (entry.type() !== 'error') return;
    if (consoleErrors.length < 10) consoleErrors.push(entry.text().slice(0, 300));
    else errorOverflow++;
  });
  const routeHandler = async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:' && url.hostname === extensionId)
      return route.continue();
    if (url.href.startsWith(IMAGE_PREFIX)) {
      if (imageRequests.length < MAX_RECORDS) imageRequests.push(url.href);
      else errorOverflow++;
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
        body: RED_PNG,
      });
    }
    if (url.href === fixtureUrl && route.request().resourceType() === 'document')
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (url.hostname === 'www.youtube.com' && url.pathname === '/favicon.ico')
      return route.fulfill({ status: 204 });
    if (
      url.hostname === 'www.youtube.com' &&
      url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat')
    )
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          continuationContents: {
            liveChatContinuation: {
              actions: [],
              continuations: [
                {
                  timedContinuationData: { continuation: 'windows-canvas-next', timeoutMs: 30_000 },
                },
              ],
            },
          },
        },
      });
    return route.fulfill({ status: 403, body: 'Blocked by Canvas recovery fixture' });
  };
  let routeInstalled = false;
  let probe: NativePageScriptProbe | undefined;
  let originalSettings:
    | ReturnType<NonNullable<Window['__ytChatOverlay']>['getSettings']>
    | undefined;
  let primaryError: unknown;
  let result: Record<string, unknown> | undefined;
  let provenance: NativePageScriptProbe['provenance'] | null = null;
  let stage = 'preflight';
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.route('**/*', routeHandler);
    routeInstalled = true;
    await page.addInitScript(prelude, {
      variant,
      videoId,
      imagePrefix: IMAGE_PREFIX,
      maxRecords: MAX_RECORDS,
    });
    probe = await installNativePageScriptProbe({
      context,
      root,
      extensionId,
      fixtureUrl,
      instrumentedSource: instrumented,
    });
    provenance = probe.provenance;
    await probe.assertReady();
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page
      .locator('#yt-live-chat-overlay canvas')
      .waitFor({ state: 'attached', timeout: 15_000 });
    await probe.assertInjected();
    await probe.restore();
    probe = undefined;
    await page.waitForFunction(() => {
      const state = window.__ytCanvasRecovery;
      return state?.sourceBound && state.renderer !== null && state.frames > 0;
    });
    await page.waitForFunction(() => Boolean(window.__ytChatOverlay?.getSettings));
    originalSettings = await page.evaluate(() => {
      const app = window.__ytChatOverlay;
      if (!app) throw new Error('Installed app is unavailable');
      const settings = structuredClone(app.getSettings());
      app.applySettings({
        danmakuMode: 'top',
        topBottomDurationMs: 5_000,
        showAuthor: { ...settings.showAuthor, normal: true },
        allowShortTextMessages: true,
        translationEnabled: false,
        depthLayersEnabled: false,
        maxConcurrentMessages: 50,
      });
      return settings;
    });
    await page.waitForFunction(() => {
      const settings = window.__ytCanvasRecovery?.renderer?.settings;
      return settings?.danmakuMode === 'top' && settings.topBottomDurationMs === 5_000;
    });
    await page.evaluate(() => {
      const state = window.__ytCanvasRecovery;
      if (!state?.renderer?.canvas || !window.__ytChatOverlay)
        throw new Error('Canvas or installed app was lost before pinning');
      state.initialCanvas = state.renderer.canvas;
      state.initialApp = window.__ytChatOverlay;
    });
    stage = 'healthy';
    const initial = await snapshot(page);
    assert(initial.sourceBound && initial.canvasCount === 1);
    assert(initial.appPinned && initial.canvasPinned);
    assert.equal(initial.rendererIdentityChanges, 0);
    assert.equal(initial.workerActive, variant === 'worker-replacement-retry');
    assert.equal(initial.workerAttempts, variant === 'main-context-restored' ? 1 : 0);
    if (variant === 'main-context-restored') {
      assertDpr(initial);
      await sendAndObserve(page, 'main-before');
      stage = 'synthetic-context-loss';
      const loss = await page.evaluate(() => {
        const renderer = window.__ytCanvasRecovery?.renderer;
        const canvas = renderer?.canvas;
        if (!canvas || !renderer?.ctx) throw new Error('Healthy Main context missing');
        const event = new Event('contextlost', { cancelable: true });
        canvas.dispatchEvent(event);
        return { synthetic: !event.isTrusted, defaultPrevented: event.defaultPrevented };
      });
      assert.deepEqual(loss, { synthetic: true, defaultPrevented: true });
      assert.equal(
        await page.evaluate(() => window.__ytCanvasRecovery?.renderer?.ctx === null),
        true,
        'Main context loss did not stop the renderer'
      );
      await page.evaluate(() => {
        const renderer = window.__ytCanvasRecovery?.renderer;
        if (!renderer) throw new Error('Renderer unavailable during loss');
        renderer.addMessage({
          id: 'main-after',
          text: 'WIN306_CANVAS_main-after',
          content: [{ type: 'text', content: 'WIN306_CANVAS_main-after' }],
          kind: 'text',
          timestamp: Date.now(),
          authorType: 'normal',
          authorPhotoUrl: `${window.__ytCanvasRecovery?.imagePrefix}main-after.png`,
        });
      });
      const lost = await snapshot(page);
      assert.equal(lost.textDraws.includes('WIN306_CANVAS_main-after'), false);
      assert(lost.pendingSize <= lost.queueMaxSize);
      stage = 'synthetic-context-restoration';
      const reset = await page.evaluate(() => {
        const canvas = window.__ytCanvasRecovery?.renderer?.canvas;
        if (!canvas) throw new Error('Main canvas disappeared before restore');
        const backingWidth = canvas.width;
        canvas.width = backingWidth; // Native Canvas 2D state reset.
        const before = canvas.getContext('2d')?.getTransform().a ?? null;
        canvas.dispatchEvent(new Event('contextrestored'));
        return { before, synthetic: true };
      });
      assert.equal(reset.before, 1);
      const restored = await snapshot(page);
      assertDpr(restored);
      assert.equal(restored.workerActive, false);
      assert(restored.appPinned && restored.canvasPinned);
      assert.equal(restored.restorationCalls, 1);
      assert.equal(restored.fallbackReasons.length, 0);
      await page.waitForFunction(
        () => window.__ytCanvasRecovery?.textDraws.includes('WIN306_CANVAS_main-after') === true
      );
      await sendAndObserve(page, 'main-recovered');
      const final = await snapshot(page);
      assertDpr(final);
      assert(final.appPinned && final.canvasPinned);
      assert.equal(final.rendererIdentityChanges, 0);
      assert(final.imageDraws.some((draw) => draw.url === `${IMAGE_PREFIX}main-recovered.png`));
      result = { variant, initial, loss, lost, reset, restored, final };
    } else {
      assert.equal(initial.workerPresent, true);
      const baselineImage = page.waitForResponse(
        (response) =>
          response.url() === `${IMAGE_PREFIX}worker-before.png` && response.status() === 200,
        { timeout: 12_000 }
      );
      await Promise.all([
        baselineImage,
        page.evaluate(() => {
          const state = window.__ytCanvasRecovery;
          if (!state?.renderer) throw new Error('Healthy Worker renderer disappeared');
          state.renderer.addMessage({
            id: 'worker-before',
            text: 'WIN306_CANVAS_worker-before',
            content: [{ type: 'text', content: 'WIN306_CANVAS_worker-before' }],
            kind: 'text',
            timestamp: Date.now(),
            authorType: 'normal',
            authorPhotoUrl: `${state.imagePrefix}worker-before.png`,
          });
        }),
      ]);
      await page.waitForFunction(
        () => {
          const worker = window.__ytCanvasRecovery?.renderer?.workerManager;
          return Boolean(
            worker?.isActive &&
            worker.activeMessageCount > 0 &&
            document.querySelector(
              '#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p[data-message-id="worker-before"]'
            )
          );
        },
        undefined,
        { timeout: 12_000 }
      );
      const beforeFault = await snapshot(page);
      assert(imageRequests.includes(`${IMAGE_PREFIX}worker-before.png`));
      stage = 'synthetic-worker-context-lost-and-null-replacement';
      const trigger = await page.evaluate(() => {
        const state = window.__ytCanvasRecovery;
        const canvas = state?.renderer?.canvas;
        const worker = state?.renderer?.workerManager.workerRef;
        if (!state || !canvas || !worker) throw new Error('Active Worker canvas missing');
        state.faultOriginalCanvas = canvas;
        state.nullNextReplacement = true;
        const event = new MessageEvent('message', { data: { type: 'contextLost' } });
        worker.dispatchEvent(event);
        const detectedDead = state.renderer?.workerManager.isAlive() === false;
        if (detectedDead) state.renderer?.fallbackToMainThread('worker-dead');
        return { synthetic: !event.isTrusted, detectedDead };
      });
      assert.deepEqual(trigger, { synthetic: true, detectedDead: true });
      await page.waitForFunction(() => {
        const renderer = window.__ytCanvasRecovery?.renderer;
        return renderer?.fallbackRecoveryFailed && !renderer.fallbackInProgress;
      });
      const failed = await snapshot(page);
      assert.equal(failed.workerPresent, false);
      assert.equal(failed.replacementNulls, 1);
      assert.equal(failed.restorationCalls, 0);
      assert(failed.appPinned && !failed.canvasPinned && !failed.oldCanvasConnected);
      assert.equal(failed.fallbackReasons[0], 'worker-dead');
      assert.equal(failed.canvasCount, 1);
      assert.equal(failed.textDraws.length, 0);
      stage = 'bounded-failed-state-and-retry';
      await page.evaluate(() => {
        const renderer = window.__ytCanvasRecovery?.renderer;
        if (!renderer) throw new Error('Renderer unavailable in failed state');
        renderer.addMessage({
          id: 'worker-retained',
          text: 'WIN306_CANVAS_worker-retained',
          content: [{ type: 'text', content: 'WIN306_CANVAS_worker-retained' }],
          kind: 'text',
          timestamp: Date.now(),
          authorType: 'normal',
          authorPhotoUrl: `${window.__ytCanvasRecovery?.imagePrefix}worker-retained.png`,
        });
      });
      const held = await snapshot(page);
      assert.equal(held.fallbackIngressSize, 1);
      assert(held.fallbackIngressSize <= held.queueMaxSize);
      assert.equal(held.textDraws.length, 0);
      await page.evaluate(() => {
        const renderer = window.__ytCanvasRecovery?.renderer;
        if (!renderer) throw new Error('Renderer unavailable for retry');
        renderer.fallbackToMainThread('fixture-canvas-retry');
      });
      await page.waitForFunction(() => {
        const renderer = window.__ytCanvasRecovery?.renderer;
        return (
          renderer &&
          !renderer.fallbackInProgress &&
          !renderer.fallbackRecoveryFailed &&
          renderer.ctx !== null &&
          renderer.canvas?.isConnected
        );
      });
      const recovered = await snapshot(page);
      assertDpr(recovered);
      assert(recovered.appPinned && !recovered.canvasPinned && !recovered.oldCanvasConnected);
      assert.equal(recovered.canvasCount, 1);
      assert.equal(recovered.workerPresent, false);
      assert.equal(recovered.fallbackIngressSize, 0);
      assert.deepEqual(recovered.fallbackReasons, ['worker-dead', 'fixture-canvas-retry']);
      await page.waitForFunction(
        () =>
          window.__ytCanvasRecovery?.textDraws.includes('WIN306_CANVAS_worker-retained') === true
      );
      stage = 'healthy-after-retry';
      await sendAndObserve(page, 'worker-recovered');
      const final = await snapshot(page);
      assertDpr(final);
      assert.equal(final.canvasCount, 1);
      assert.equal(final.replacementNulls, 1);
      assert.equal(final.rendererIdentityChanges, 0);
      assert.equal(
        final.textDraws.filter((text) => text === 'WIN306_CANVAS_worker-retained').length,
        1
      );
      assert(final.imageDraws.some((draw) => draw.url === `${IMAGE_PREFIX}worker-recovered.png`));
      result = { variant, initial, beforeFault, trigger, failed, held, recovered, final };
    }
    const final = await snapshot(page);
    assert.equal(final.overflow, 0);
    assert.equal(errorOverflow, 0);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
    assert(imageRequests.length > 0 && imageRequests.length <= MAX_RECORDS);
    result = {
      status: 'passed',
      ...result,
      pageScriptProbeProvenance: provenance,
      imageRequests,
      pageErrors,
      consoleErrors,
      evidenceBoundary:
        'Synthetic Main Canvas events and Worker contextLost protocol event in installed Edge; no physical GPU or driver reset claim',
      videoPrerequisite: 'Paused property overridden only in this isolated renderer fixture',
    };
  } catch (error) {
    primaryError = error;
    try {
      await writeFile(
        join(output, `canvas-recovery-${variant}-failure.json`),
        JSON.stringify(
          {
            status: 'failed',
            variant,
            stage,
            failure: describe(error),
            provenance,
            imageRequests,
            pageErrors,
            consoleErrors,
            errorOverflow,
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
        'Canvas recovery and failure receipt failed'
      );
    }
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    async () => probe?.restore(),
    async () => {
      if (originalSettings && !page.isClosed())
        await page.evaluate((settings) => {
          const app = window.__ytChatOverlay;
          if (!app) throw new Error('Canvas settings runtime was lost');
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
        join(output, `canvas-recovery-${variant}-cleanup-failure.json`),
        JSON.stringify(
          {
            status: 'failed',
            scenarioError: primaryError ? describe(primaryError) : null,
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
      `Canvas recovery ${variant} owned-resource cleanup failed`
    );
  }
  if (primaryError) throw primaryError;
  assert(result, `Canvas recovery ${variant} returned no result`);
  return result;
}

/** Source-bound installed-browser Canvas2D restoration and Worker fallback fixture. */
export async function runCanvasRecoveryFixture({
  context,
  root,
  output,
  extensionId,
}: {
  context: BrowserContext;
  root: string;
  output: string;
  extensionId: string;
}): Promise<{ status: 'passed'; scenarios: unknown[] }> {
  assert.match(extensionId, /^[a-p]{32}$/);
  const source = await readFile(join(root, 'dist-extension/page-script.js'), 'utf8');
  assert.equal(source.split(ENTRY_MARKER).length, 2, 'Packaged page entry changed');
  assert(source.includes('var CanvasRenderer = class CanvasRenderer'), 'Packaged renderer changed');
  const preview = await readFile(join(root, 'test/visual/preview.html'), 'utf8');
  const scenarios = [];
  for (const variant of ['main-context-restored', 'worker-replacement-retry'] as const)
    scenarios.push(
      await runVariant({ context, root, output, extensionId, variant, source, preview })
    );
  return { status: 'passed', scenarios };
}
