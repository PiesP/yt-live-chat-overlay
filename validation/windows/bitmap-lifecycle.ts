// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, Route } from '@playwright/test';

import {
  installNativePageScriptProbe,
  type NativePageScriptProbe,
} from './native-page-script-probe.ts';
import { buildVisibleWatchHtml } from './visible-watch.ts';

type BitmapCache = {
  get(key: string): ImageBitmap | undefined;
  set(key: string, value: ImageBitmap): boolean;
  has(key: string): boolean;
  delete(key: string): boolean;
};

type BitmapProbeResult = {
  phase: string;
  owned?: boolean;
  width?: number | null;
  height?: number | null;
  pixel?: number[] | null;
  drawError?: string | null;
  sameReferenceAccepted?: boolean | null;
  aliasErrorType?: string | null;
  aliasOwned?: boolean | null;
  errorType?: string;
};

type BitmapWorkerRecord = {
  worker: Worker;
  ready: boolean;
  attached: boolean;
  results: BitmapProbeResult[];
  overflow: number;
};

declare global {
  interface Window {
    __ytBitmapWorkers: BitmapWorkerRecord[];
    __ytBitmapWorkerOverflow: number;
    __ytBitmapCacheClass: new (
      maxBytes: number,
      sizeOf: (value: ImageBitmap) => number,
      dispose: (value: ImageBitmap) => void
    ) => BitmapCache;
  }
}

const FIXTURE_URL = 'https://www.youtube.com/watch?v=windowsBitmapLifecycle';
const BITMAP_URL = 'https://yt3.ggpht.com/windows-bitmap-lifecycle';
const SELF_FETCH_URL = 'https://yt3.ggpht.com/windows-bitmap-self-fetch.png';
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGP8z8DwnwEJMDGgAcICAIPRAgYCkO9YAAAAAElFTkSuQmCC',
  'base64'
);

// This suffix receives the real WorkerRenderer instance from the packaged Blob.
// The existing addMessages receiver performs insertion before these probes run.
function attachWorkerBitmapProbe(renderer: {
  handleMessage: (event: MessageEvent) => void;
  emojiCache: BitmapCache;
  prefetchImages: (urls: string[], cache: BitmapCache) => Promise<void>;
}) {
  if (typeof renderer?.handleMessage !== 'function') return;
  self.postMessage({ type: 'ytBitmapProbeAttached' });
  let retained: ImageBitmap | undefined;
  self.addEventListener('message', async (event) => {
    if (event.data?.type !== 'ytBitmapProbe') return;
    const { phase, url } = event.data;
    try {
      const cache = renderer.emojiCache;
      if (phase === 'self-fetch-before') {
        await renderer.prefetchImages([url], cache);
      }
      if (phase === 'before') retained = cache.get(url);
      if (phase === 'self-fetch-before') retained = cache.get(url);
      if (phase === 'after') cache.delete(url);
      if (phase === 'self-fetch-after') cache.delete(url);
      let sameReferenceAccepted = null;
      let aliasErrorType = null;
      let aliasOwned = null;
      if (phase === 'before' || phase === 'self-fetch-before') {
        if (!retained) throw new Error('Worker bitmap was not cached');
        sameReferenceAccepted = cache.set(url, retained);
        try {
          cache.set(`${url}#alias`, retained);
        } catch (error) {
          aliasErrorType = error instanceof Error ? error.name : typeof error;
        }
        aliasOwned = cache.has(`${url}#alias`);
      }
      const canvas = new OffscreenCanvas(4, 4);
      const ctx = canvas.getContext('2d');
      if (!ctx || !retained) throw new Error('Worker bitmap context unavailable');
      let drawError = null;
      let pixel = null;
      try {
        ctx.drawImage(retained, 0, 0);
        pixel = Array.from(ctx.getImageData(0, 0, 1, 1).data);
      } catch (error) {
        drawError = error instanceof Error ? error.name : String(error);
      }
      self.postMessage({
        type: 'ytBitmapProbeResult',
        phase,
        owned: cache.has(url),
        width: retained?.width ?? null,
        height: retained?.height ?? null,
        pixel,
        drawError,
        sameReferenceAccepted,
        aliasErrorType,
        aliasOwned,
      });
    } catch (error) {
      self.postMessage({
        type: 'ytBitmapProbeResult',
        phase,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  });
}

/** Installed Edge: verify real ImageBitmap cleanup in the compiled cache and renderer Worker. */
export async function runBitmapLifecycleFixture({
  context,
  root,
  extensionId,
}: {
  context: BrowserContext;
  root: string;
  extensionId: string;
}) {
  const source = await readFile(join(root, 'dist-extension/page-script.js'), 'utf8');
  const marker = '\n\tmain();\n';
  assert(
    source.includes('var ResizableByteLimitedCache = class {') && source.split(marker).length === 2,
    'Packaged cache or page entry changed'
  );
  const instrumented = source.replace(
    marker,
    `\n\twindow.__ytBitmapCacheClass = ResizableByteLimitedCache;${marker}`
  );
  const preview = await readFile(join(root, 'test/visual/preview.html'), 'utf8');
  const html = buildVisibleWatchHtml(preview, 'Bitmap lifecycle fixture video');
  const page = await context.newPage();
  const pageErrors: string[] = [];
  let pageErrorOverflow = 0;
  page.on('pageerror', (error) => {
    if (pageErrors.length < 10) pageErrors.push(error.name);
    else pageErrorOverflow++;
  });
  const consoleErrors: string[] = [];
  let consoleErrorOverflow = 0;
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (consoleErrors.length < 10) consoleErrors.push(message.text().slice(0, 200));
    else consoleErrorOverflow++;
  });
  let selfFetchRequests = 0;
  const selfFetchRoute = (route: Route) => {
    selfFetchRequests++;
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' },
      body: RED_PNG,
    });
  };
  let routeRegistered = false;
  let nativePageProbe: NativePageScriptProbe | undefined;
  let pageScriptProbeProvenance: NativePageScriptProbe['provenance'] | null = null;
  try {
    await context.route(SELF_FETCH_URL, selfFetchRoute);
    routeRegistered = true;
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.href === SELF_FETCH_URL) return selfFetchRoute(route);
      if (url.protocol === 'chrome-extension:' && url.hostname === extensionId)
        return route.continue();
      if (url.hostname === 'www.youtube.com' && route.request().resourceType() === 'document') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: html });
      }
      if (url.hostname === 'www.youtube.com' && url.pathname === '/favicon.ico') {
        return route.fulfill({ status: 204 });
      }
      if (
        url.hostname === 'www.youtube.com' &&
        url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat')
      ) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          json: {
            continuationContents: {
              liveChatContinuation: {
                actions: [],
                continuations: [
                  {
                    timedContinuationData: {
                      continuation: 'windows-bitmap-next',
                      timeoutMs: 30_000,
                    },
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
        body: 'Blocked by bitmap fixture',
      });
    });
    await page.addInitScript((probeSource: string) => {
      window.__ytBitmapWorkers = [];
      window.__ytBitmapWorkerOverflow = 0;
      Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
        configurable: true,
        get: () => false,
      });
      const NativeBlob = window.Blob;
      window.Blob = new Proxy(NativeBlob, {
        construct(target, args) {
          const [parts, options] = args;
          if (
            options?.type === 'text/javascript' &&
            parts?.length === 1 &&
            typeof parts[0] === 'string' &&
            parts[0].includes('OffscreenCanvas')
          ) {
            const match =
              /self\.onmessage=([A-Za-z_$][\w$]*)=>\{([A-Za-z_$][\w$]*)\.handleMessage\(\1\)\};?\s*$/.exec(
                parts[0]
              );
            if (!match) throw new Error('Packaged Worker handler changed');
            const suffix = `\n;(${probeSource})(${match[2]});\n`;
            return Reflect.construct(target, [[parts[0], suffix], options]);
          }
          return Reflect.construct(target, args);
        },
      });
      const NativeWorker = window.Worker;
      window.Worker = new Proxy(NativeWorker, {
        construct(target, args) {
          const worker = Reflect.construct(target, args);
          const record: BitmapWorkerRecord = {
            worker,
            ready: false,
            attached: false,
            results: [],
            overflow: 0,
          };
          if (window.__ytBitmapWorkers.length < 4) window.__ytBitmapWorkers.push(record);
          else window.__ytBitmapWorkerOverflow++;
          worker.addEventListener('message', (event: MessageEvent) => {
            if (event.data?.type === 'ready') record.ready = true;
            if (event.data?.type === 'ytBitmapProbeAttached') record.attached = true;
            if (event.data?.type === 'ytBitmapProbeResult') {
              if (record.results.length < 4) record.results.push(event.data);
              else record.overflow++;
            }
          });
          return worker;
        },
      });
      window.ytcfg = {
        data_: {
          INNERTUBE_API_KEY: 'windows-acceptance-key',
          INNERTUBE_CONTEXT_CLIENT_NAME: '1',
          INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
          INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
        },
      };
      window.ytInitialData = {
        currentVideoEndpoint: { watchEndpoint: { videoId: 'windowsBitmapLifecycle' } },
        contents: {
          twoColumnWatchNextResults: {
            conversationBar: {
              liveChatRenderer: {
                isReplay: false,
                continuations: [
                  {
                    timedContinuationData: {
                      continuation: 'windows-bitmap-live',
                      timeoutMs: 30_000,
                    },
                  },
                ],
              },
            },
          },
        },
      };
    }, attachWorkerBitmapProbe.toString());
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
    await page.waitForFunction(() => typeof window.__ytBitmapCacheClass === 'function');
    await nativePageProbe.restore();
    nativePageProbe = undefined;
    await page.waitForFunction(
      () => window.__ytBitmapWorkers.some((record) => record.ready && record.attached),
      undefined,
      { timeout: 15_000 }
    );

    const main = await page.evaluate(async () => {
      const source = new OffscreenCanvas(4, 4);
      const sourceCtx = source.getContext('2d');
      if (!sourceCtx) throw new Error('Main bitmap context unavailable');
      sourceCtx.fillStyle = '#ff0000';
      sourceCtx.fillRect(0, 0, 4, 4);
      const bitmap = await createImageBitmap(source);
      const cache = new window.__ytBitmapCacheClass(
        1024,
        (value) => value.width * value.height * 4,
        (value) => value.close()
      );
      if (!cache.set('main', bitmap)) throw new Error('Compiled cache rejected the main bitmap');
      const sameReferenceAccepted = cache.set('main', bitmap);
      let aliasErrorType = null;
      try {
        cache.set('main-alias', bitmap);
      } catch (error) {
        aliasErrorType = error instanceof Error ? error.name : String(error);
      }
      const draw = new OffscreenCanvas(4, 4).getContext('2d');
      if (!draw) throw new Error('Main bitmap draw context unavailable');
      const cached = cache.get('main');
      if (!cached) throw new Error('Main bitmap was not cached');
      draw.drawImage(cached, 0, 0);
      const before = {
        owned: cache.has('main'),
        width: bitmap.width,
        height: bitmap.height,
        pixel: Array.from(draw.getImageData(0, 0, 1, 1).data),
        sameReferenceAccepted,
        aliasErrorType,
        aliasOwned: cache.has('main-alias'),
      };
      cache.delete('main');
      let drawError = null;
      try {
        draw.drawImage(bitmap, 0, 0);
      } catch (error) {
        drawError = error instanceof Error ? error.name : String(error);
      }
      return {
        before,
        after: { owned: cache.has('main'), width: bitmap.width, height: bitmap.height, drawError },
      };
    });

    const sender = await page.evaluate(async (url) => {
      const source = new OffscreenCanvas(4, 4);
      const ctx = source.getContext('2d');
      if (!ctx) throw new Error('Sender bitmap context unavailable');
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, 4, 4);
      const bitmap = await createImageBitmap(source);
      const record = window.__ytBitmapWorkers.find((entry) => entry.ready && entry.attached);
      if (!record) throw new Error('Bitmap Worker was not attached');
      record.worker.postMessage(
        { type: 'addMessages', messages: [], imageData: [{ url, bitmap, target: 'emoji' }] },
        [bitmap]
      );
      record.worker.postMessage({ type: 'ytBitmapProbe', phase: 'before', url });
      return { widthAfterTransfer: bitmap.width, heightAfterTransfer: bitmap.height };
    }, BITMAP_URL);
    await page.waitForFunction(
      () =>
        window.__ytBitmapWorkers.some((record) =>
          record.results.some((result) => result.phase === 'before')
        ),
      undefined,
      { timeout: 15_000 }
    );
    await page.evaluate((url: string) => {
      const record = window.__ytBitmapWorkers.find((entry) => entry.ready && entry.attached);
      if (!record) throw new Error('Bitmap Worker was not attached');
      record.worker.postMessage({ type: 'ytBitmapProbe', phase: 'after', url });
    }, BITMAP_URL);
    await page.waitForFunction(
      () =>
        window.__ytBitmapWorkers.some((record) =>
          record.results.some((result) => result.phase === 'after')
        ),
      undefined,
      { timeout: 15_000 }
    );
    await page.evaluate((url: string) => {
      const record = window.__ytBitmapWorkers.find((entry) => entry.ready && entry.attached);
      if (!record) throw new Error('Bitmap Worker was not attached');
      record.worker.postMessage({ type: 'ytBitmapProbe', phase: 'self-fetch-before', url });
    }, SELF_FETCH_URL);
    await page.waitForFunction(
      () =>
        window.__ytBitmapWorkers.some((record) =>
          record.results.some((result) => result.phase === 'self-fetch-before')
        ),
      undefined,
      { timeout: 15_000 }
    );
    await page.evaluate((url: string) => {
      const record = window.__ytBitmapWorkers.find((entry) => entry.ready && entry.attached);
      if (!record) throw new Error('Bitmap Worker was not attached');
      record.worker.postMessage({ type: 'ytBitmapProbe', phase: 'self-fetch-after', url });
    }, SELF_FETCH_URL);
    await page.waitForFunction(
      () =>
        window.__ytBitmapWorkers.some((record) =>
          record.results.some((result) => result.phase === 'self-fetch-after')
        ),
      undefined,
      { timeout: 15_000 }
    );
    const worker = await page.evaluate(() => {
      const record = window.__ytBitmapWorkers.find((entry) => entry.ready && entry.attached);
      if (!record) throw new Error('Bitmap Worker was not attached');
      return record.results;
    });
    const probeOverflow = await page.evaluate(() => ({
      workers: window.__ytBitmapWorkerOverflow,
      results: window.__ytBitmapWorkers.reduce((sum, record) => sum + record.overflow, 0),
    }));

    assert.deepEqual(main.before.pixel, [255, 0, 0, 255]);
    assert.equal(main.before.owned, true);
    assert.equal(main.before.width, 4);
    assert.equal(main.before.height, 4);
    assert.equal(main.before.sameReferenceAccepted, true);
    assert.equal(main.before.aliasErrorType, 'TypeError');
    assert.equal(main.before.aliasOwned, false);
    assert.equal(main.after.owned, false);
    assert.equal(main.after.width, 0);
    assert.equal(main.after.height, 0);
    assert(main.after.drawError, 'Released main bitmap remained drawable');
    assert.equal(sender.widthAfterTransfer, 0);
    assert.equal(sender.heightAfterTransfer, 0);
    assert.deepEqual(
      worker.map((result) => result.phase),
      ['before', 'after', 'self-fetch-before', 'self-fetch-after']
    );
    const [before, after, selfFetchBefore, selfFetchAfter] = worker;
    assert(before && after && selfFetchBefore && selfFetchAfter);
    assert.deepEqual(before.pixel, [255, 0, 0, 255]);
    assert.equal(before.owned, true);
    assert.equal(before.width, 4);
    assert.equal(before.height, 4);
    assert.equal(before.sameReferenceAccepted, true);
    assert.equal(before.aliasErrorType, 'TypeError');
    assert.equal(before.aliasOwned, false);
    assert.equal(after.owned, false);
    assert.equal(after.width, 0);
    assert.equal(after.height, 0);
    assert(after.drawError, 'Released Worker bitmap remained drawable');
    assert.deepEqual(selfFetchBefore.pixel, [255, 0, 0, 255]);
    assert.equal(selfFetchBefore.owned, true);
    assert.equal(selfFetchBefore.width, 4);
    assert.equal(selfFetchBefore.height, 4);
    assert.equal(selfFetchBefore.sameReferenceAccepted, true);
    assert.equal(selfFetchBefore.aliasErrorType, 'TypeError');
    assert.equal(selfFetchBefore.aliasOwned, false);
    assert.equal(selfFetchAfter.owned, false);
    assert.equal(selfFetchAfter.width, 0);
    assert.equal(selfFetchAfter.height, 0);
    assert(selfFetchAfter.drawError, 'Released self-fetched bitmap remained drawable');
    assert.equal(selfFetchRequests, 1);
    assert.deepEqual(pageErrors, []);
    assert.equal(pageErrorOverflow, 0);
    assert.deepEqual(consoleErrors, []);
    assert.equal(consoleErrorOverflow, 0);
    assert.deepEqual(probeOverflow, { workers: 0, results: 0 });
    return {
      status: 'passed',
      source: 'compiled extension page/Worker cache',
      transferScope: 'defensive existing receiver protocol; no production imageData sender',
      main,
      selfFetchScope: 'direct call to compiled WorkerRenderer.prefetchImages with routed image',
      sender,
      worker,
      selfFetchRequests,
      pageErrors,
      pageErrorOverflow,
      consoleErrors,
      consoleErrorOverflow,
      probeOverflow,
      pageScriptProbeProvenance,
    };
  } finally {
    try {
      if (nativePageProbe) await nativePageProbe.restore();
    } finally {
      try {
        await page.close();
      } finally {
        if (routeRegistered) await context.unroute(SELF_FETCH_URL, selfFetchRoute);
      }
    }
  }
}
