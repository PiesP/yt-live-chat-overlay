// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, Request, Route } from '@playwright/test';

import {
  installNativePageScriptProbe,
  type NativePageScriptProbe,
} from './native-page-script-probe.ts';
import { buildVisibleWatchHtml } from './visible-watch.ts';
import {
  installWorkerRedirectTransport,
  type WorkerRedirectTransport,
} from './worker-redirect-transport.ts';

type BitmapCache = {
  get(key: string): ImageBitmap | undefined;
  set(key: string, value: ImageBitmap): boolean;
  has(key: string): boolean;
  delete(key: string): boolean;
};

type BitmapProbeResult = {
  phase: string;
  id?: string;
  target?: 'emoji' | 'author' | 'sticker';
  owned?: boolean;
  width?: number | null;
  height?: number | null;
  pixel?: number[] | null;
  drawError?: string | null;
  sameReferenceAccepted?: boolean | null;
  aliasErrorType?: string | null;
  aliasOwned?: boolean | null;
  errorType?: string;
  fetchAttempts?: number;
  responseStatus?: number | null;
  finalUrl?: string | null;
  fetchErrorType?: string | null;
  decodeAttempts?: number;
  decodeSuccesses?: number;
  decodeFailures?: number;
  failedCached?: boolean;
  fetchEvents?: Array<{ event: string; at: number; detail?: string }>;
  fetchEventOverflow?: number;
};

type BitmapWorkerRecord = {
  worker: Worker;
  sourceUrl: string;
  ready: boolean;
  attached: boolean;
  results: BitmapProbeResult[];
  overflow: number;
};

type ImageRoutePlan =
  | { kind: 'png' | 'cors' | 'malformed' | 'truncated' | 'html' | 'empty' }
  | { kind: 'http'; status: number }
  | { kind: 'abort' }
  | { kind: 'redirect'; location: string };

type ImageRouteRecord = { url: string; kind: ImageRoutePlan['kind']; status: number | null };
type RequestObservation = {
  id: number;
  url: string;
  method: string;
  resourceType: string;
  redirectedFrom: string | null;
  startedAt: number;
  responseStatus: number | null;
  terminal: 'finished' | 'failed' | null;
  terminalAt: number | null;
  errorText: string | null;
};
type RequestFailure = { id: number | null; url: string; errorText: string };
type RouteCompletion = {
  url: string;
  kind: ImageRoutePlan['kind'];
  startedAt: number;
  settledAt: number | null;
  outcome: 'fulfilled' | 'rejected' | null;
  error: string | null;
};

/** Accept a CDP abort only when this exact routed request has independent completion proof. */
export function isCompletedRoutedBitmapFailure({
  failure,
  failures,
  observations,
  routes,
  completions,
  probes,
  noOverflow,
}: {
  failure: RequestFailure;
  failures: RequestFailure[];
  observations: RequestObservation[];
  routes: ImageRouteRecord[];
  completions: RouteCompletion[];
  probes: Array<{ id: string; url: string; result: BitmapProbeResult }>;
  noOverflow: boolean;
}): boolean {
  if (!noOverflow || failure.errorText !== 'net::ERR_ABORTED' || failure.id === null) return false;
  const sameFailure = failures.filter((item) => item.id === failure.id && item.url === failure.url);
  const sameRequest = observations.filter(
    (item) => item.id === failure.id && item.url === failure.url
  );
  if (
    sameFailure.length !== 1 ||
    sameRequest.length !== 1 ||
    observations.filter((item) => item.id === failure.id || item.url === failure.url).length !== 1
  )
    return false;
  const request = sameRequest[0];
  if (
    !request ||
    request.method !== 'GET' ||
    request.resourceType !== 'fetch' ||
    request.redirectedFrom !== null ||
    request.responseStatus !== 200 ||
    request.terminal !== 'failed' ||
    request.terminalAt === null ||
    request.errorText !== failure.errorText
  )
    return false;
  const matchingRoutes = routes.filter((route) => route.url === failure.url);
  const matchingCompletions = completions.filter((completion) => completion.url === failure.url);
  const matchingProbes = probes.filter((probe) => probe.url === failure.url);
  if (
    matchingRoutes.length !== 1 ||
    matchingRoutes[0]?.kind !== 'png' ||
    matchingRoutes[0].status !== 200 ||
    matchingCompletions.length !== 1 ||
    matchingCompletions[0]?.kind !== 'png' ||
    matchingCompletions[0].outcome !== 'fulfilled' ||
    matchingCompletions[0].settledAt === null ||
    matchingCompletions[0].error !== null ||
    matchingProbes.length !== 1
  )
    return false;
  const result = matchingProbes[0]?.result;
  if (
    !result ||
    result.phase !== 'acquire' ||
    result.id !== matchingProbes[0]?.id ||
    result.errorType !== undefined ||
    result.fetchAttempts !== 1 ||
    result.responseStatus !== 200 ||
    result.finalUrl !== failure.url ||
    result.fetchErrorType !== null ||
    result.decodeAttempts !== 1 ||
    result.decodeSuccesses !== 1 ||
    result.decodeFailures !== 0 ||
    result.failedCached !== false ||
    result.owned !== true ||
    result.width !== 4 ||
    result.height !== 4 ||
    result.drawError !== null ||
    result.fetchEventOverflow !== 0 ||
    result.pixel?.length !== 4 ||
    result.pixel[0] !== 255 ||
    result.pixel[1] !== 0 ||
    result.pixel[2] !== 0 ||
    result.pixel[3] !== 255
  )
    return false;
  // The probe logs only transition events, so an extra abort, cancel, or error cannot hide.
  return (
    result.fetchEvents?.map(({ event, detail }) => `${event}:${detail ?? ''}`).join('|') ===
    'fetch-start:|signal-state:active|fetch-response:200|body-reader:|body-read-done:|decode-start:|decode-success:'
  );
}

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
const IMAGE_CASE_PREFIX = 'https://yt3.ggpht.com/windows-bitmap-issue306-';
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGP8z8DwnwEJMDGgAcICAIPRAgYCkO9YAAAAAElFTkSuQmCC',
  'base64'
);

function describeFailure(error: unknown, depth = 0): unknown {
  if (depth >= 4) return 'Nested error depth limit';
  return {
    error: String(error).slice(0, 2_000),
    stack: error instanceof Error ? error.stack?.slice(0, 4_000) : null,
    ...(error instanceof AggregateError
      ? { errors: error.errors.slice(0, 8).map((nested) => describeFailure(nested, depth + 1)) }
      : {}),
  };
}

// This suffix receives the real WorkerRenderer instance from the packaged Blob.
// The existing addMessages receiver performs insertion before these probes run.
function attachWorkerBitmapProbe(renderer: {
  handleMessage: (event: MessageEvent) => void;
  emojiCache: BitmapCache;
  authorPhotoCache: BitmapCache;
  stickerCache: BitmapCache;
  failedImageFetches: Map<string, number>;
  prefetchImages: (urls: string[], cache: BitmapCache) => Promise<void>;
}) {
  if (typeof renderer?.handleMessage !== 'function') return;
  self.postMessage({ type: 'ytBitmapProbeAttached' });
  let retained: ImageBitmap | undefined;
  self.addEventListener('message', async (event) => {
    if (event.data?.type !== 'ytBitmapProbe') return;
    const { phase, url, id, target } = event.data;
    try {
      if (phase === 'acquire' || phase === 'release') {
        const cache =
          target === 'author'
            ? renderer.authorPhotoCache
            : target === 'sticker'
              ? renderer.stickerCache
              : renderer.emojiCache;
        const globals = self as unknown as {
          fetch: typeof fetch;
          createImageBitmap: (source: Blob) => Promise<ImageBitmap>;
        };
        const nativeFetch = globals.fetch;
        const nativeCreateImageBitmap = globals.createImageBitmap;
        let fetchAttempts = 0;
        let responseStatus: number | null = null;
        let finalUrl: string | null = null;
        let fetchErrorType: string | null = null;
        let decodeAttempts = 0;
        let decodeSuccesses = 0;
        let decodeFailures = 0;
        const fetchEvents: NonNullable<BitmapProbeResult['fetchEvents']> = [];
        let fetchEventOverflow = 0;
        const recordFetchEvent = (entry: (typeof fetchEvents)[number]) => {
          if (fetchEvents.length < 32) fetchEvents.push(entry);
          else fetchEventOverflow++;
        };
        if (phase === 'acquire') {
          const observedStreams = new WeakSet<ReadableStream>();
          const observedReaders = new WeakSet<ReadableStreamDefaultReader>();
          const nativeGetReader = ReadableStream.prototype.getReader;
          const nativeGetReaderDescriptor = Object.getOwnPropertyDescriptor(
            ReadableStream.prototype,
            'getReader'
          );
          if (!nativeGetReaderDescriptor) throw new Error('Native stream reader unavailable');
          const nativeStreamCancel = ReadableStream.prototype.cancel;
          const nativeRead = ReadableStreamDefaultReader.prototype.read;
          const nativeReaderCancel = ReadableStreamDefaultReader.prototype.cancel;
          const signalCleanups: Array<() => void> = [];
          Object.defineProperty(ReadableStream.prototype, 'getReader', {
            configurable: true,
            writable: true,
            value: function (this: ReadableStream, ...args: unknown[]) {
              const reader = Reflect.apply(nativeGetReader, this, args);
              if (observedStreams.has(this)) {
                observedReaders.add(reader);
                recordFetchEvent({ event: 'body-reader', at: Date.now() });
              }
              return reader;
            },
          });
          ReadableStream.prototype.cancel = function (...args) {
            const observed = observedStreams.has(this);
            if (observed) recordFetchEvent({ event: 'body-cancel', at: Date.now() });
            const operation = Reflect.apply(nativeStreamCancel, this, args);
            if (observed)
              void operation.then(
                () => recordFetchEvent({ event: 'body-cancel-done', at: Date.now() }),
                (error: unknown) =>
                  recordFetchEvent({
                    event: 'body-cancel-error',
                    at: Date.now(),
                    detail: error instanceof Error ? error.name : typeof error,
                  })
              );
            return operation;
          };
          ReadableStreamDefaultReader.prototype.read = function (...args) {
            const observed = observedReaders.has(this);
            const operation = Reflect.apply(nativeRead, this, args);
            if (observed)
              void operation.then(
                (result) => {
                  if (result.done) recordFetchEvent({ event: 'body-read-done', at: Date.now() });
                },
                (error: unknown) => {
                  recordFetchEvent({
                    event: 'body-read-error',
                    at: Date.now(),
                    detail: error instanceof Error ? error.name : typeof error,
                  });
                }
              );
            return operation;
          };
          ReadableStreamDefaultReader.prototype.cancel = function (...args) {
            const observed = observedReaders.has(this);
            if (observed) recordFetchEvent({ event: 'body-reader-cancel', at: Date.now() });
            const operation = Reflect.apply(nativeReaderCancel, this, args);
            if (observed)
              void operation.then(
                () => recordFetchEvent({ event: 'body-reader-cancel-done', at: Date.now() }),
                (error: unknown) =>
                  recordFetchEvent({
                    event: 'body-reader-cancel-error',
                    at: Date.now(),
                    detail: error instanceof Error ? error.name : typeof error,
                  })
              );
            return operation;
          };
          globals.fetch = async (input, init) => {
            fetchAttempts++;
            const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
            recordFetchEvent({ event: 'fetch-start', at: Date.now() });
            if (signal) {
              const onAbort = () => recordFetchEvent({ event: 'signal-abort', at: Date.now() });
              recordFetchEvent({
                event: 'signal-state',
                at: Date.now(),
                detail: signal.aborted ? 'aborted' : 'active',
              });
              signal.addEventListener('abort', onAbort);
              signalCleanups.push(() => signal.removeEventListener('abort', onAbort));
            }
            try {
              const response = await nativeFetch.call(self, input, init);
              responseStatus = response.status;
              finalUrl = response.url;
              recordFetchEvent({
                event: 'fetch-response',
                at: Date.now(),
                detail: String(response.status),
              });
              if (response.body) observedStreams.add(response.body);
              return response;
            } catch (error) {
              fetchErrorType = error instanceof Error ? error.name : typeof error;
              recordFetchEvent({ event: 'fetch-error', at: Date.now(), detail: fetchErrorType });
              throw error;
            }
          };
          globals.createImageBitmap = async (source) => {
            decodeAttempts++;
            recordFetchEvent({ event: 'decode-start', at: Date.now() });
            try {
              const bitmap = await nativeCreateImageBitmap.call(self, source);
              decodeSuccesses++;
              recordFetchEvent({ event: 'decode-success', at: Date.now() });
              return bitmap;
            } catch (error) {
              decodeFailures++;
              recordFetchEvent({
                event: 'decode-error',
                at: Date.now(),
                detail: error instanceof Error ? error.name : typeof error,
              });
              throw error;
            }
          };
          try {
            await renderer.prefetchImages([url], cache);
          } finally {
            for (const cleanup of signalCleanups) cleanup();
            globals.fetch = nativeFetch;
            globals.createImageBitmap = nativeCreateImageBitmap;
            Object.defineProperty(ReadableStream.prototype, 'getReader', nativeGetReaderDescriptor);
            ReadableStream.prototype.cancel = nativeStreamCancel;
            ReadableStreamDefaultReader.prototype.read = nativeRead;
            ReadableStreamDefaultReader.prototype.cancel = nativeReaderCancel;
          }
        }
        const bitmap = cache.get(url);
        if (phase === 'release') cache.delete(url);
        const canvas = new OffscreenCanvas(4, 4);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Worker image acquisition context unavailable');
        let drawError: string | null = null;
        let pixel: number[] | null = null;
        if (bitmap) {
          try {
            ctx.drawImage(bitmap, 0, 0);
            pixel = Array.from(ctx.getImageData(0, 0, 1, 1).data);
          } catch (error) {
            drawError = error instanceof Error ? error.name : String(error);
          }
        }
        self.postMessage({
          type: 'ytBitmapProbeResult',
          phase,
          id,
          target,
          owned: cache.has(url),
          width: bitmap?.width ?? null,
          height: bitmap?.height ?? null,
          pixel,
          drawError,
          fetchAttempts,
          responseStatus,
          finalUrl,
          fetchErrorType,
          decodeAttempts,
          decodeSuccesses,
          decodeFailures,
          failedCached: renderer.failedImageFetches.has(url),
          fetchEvents,
          fetchEventOverflow,
        });
        return;
      }
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
  output,
  extensionId,
}: {
  context: BrowserContext;
  root: string;
  output: string;
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
  const consoleErrors: Array<{ text: string; url: string }> = [];
  let consoleErrorOverflow = 0;
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (consoleErrors.length < 20)
      consoleErrors.push({ text: message.text().slice(0, 250), url: message.location().url });
    else consoleErrorOverflow++;
  });
  const requestObservations = new Map<Request, RequestObservation>();
  let requestObservationOverflow = 0;
  page.on('request', (request) => {
    if (!request.url().includes('/windows-bitmap-')) return;
    if (requestObservations.size >= 64) {
      requestObservationOverflow++;
      return;
    }
    requestObservations.set(request, {
      id: requestObservations.size + 1,
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      redirectedFrom: request.redirectedFrom()?.url() ?? null,
      startedAt: Date.now(),
      responseStatus: null,
      terminal: null,
      terminalAt: null,
      errorText: null,
    });
  });
  page.on('response', (response) => {
    const observation = requestObservations.get(response.request());
    if (observation) observation.responseStatus = response.status();
  });
  page.on('requestfinished', (request) => {
    const observation = requestObservations.get(request);
    if (!observation) return;
    observation.terminal = 'finished';
    observation.terminalAt = Date.now();
  });
  const requestFailures: RequestFailure[] = [];
  let requestFailureOverflow = 0;
  page.on('requestfailed', (request) => {
    const observation = requestObservations.get(request);
    if (observation) {
      observation.terminal = 'failed';
      observation.terminalAt = Date.now();
      observation.errorText = request.failure()?.errorText ?? 'unknown';
    }
    if (requestFailures.length < 20)
      requestFailures.push({
        id: observation?.id ?? null,
        url: request.url(),
        errorText: request.failure()?.errorText ?? 'unknown',
      });
    else requestFailureOverflow++;
  });
  const imageRoutes = new Map<string, ImageRoutePlan>();
  const imageRequests: ImageRouteRecord[] = [];
  let imageRequestOverflow = 0;
  const routeCompletions: RouteCompletion[] = [];
  let routeCompletionOverflow = 0;
  const observeRouteCompletion = (
    url: string,
    kind: ImageRoutePlan['kind'],
    startedAt: number,
    operation: Promise<void>
  ) => {
    if (routeCompletions.length >= 64) {
      routeCompletionOverflow++;
      return operation;
    }
    const record: RouteCompletion = {
      url,
      kind,
      startedAt,
      settledAt: null,
      outcome: null,
      error: null,
    };
    routeCompletions.push(record);
    void operation.then(
      () => {
        record.settledAt = Date.now();
        record.outcome = 'fulfilled';
      },
      (error: unknown) => {
        record.settledAt = Date.now();
        record.outcome = 'rejected';
        record.error = error instanceof Error ? error.name : typeof error;
      }
    );
    return operation;
  };
  const imageRoute = (route: Route) => {
    const url = route.request().url();
    const plan = imageRoutes.get(url);
    assert(plan, `Unplanned image route: ${url}`);
    const startedAt = Date.now();
    const status = plan.kind === 'http' ? plan.status : plan.kind === 'redirect' ? 302 : 200;
    if (imageRequests.length < 64)
      imageRequests.push({ url, kind: plan.kind, status: plan.kind === 'abort' ? null : status });
    else imageRequestOverflow++;
    if (plan.kind === 'abort')
      return observeRouteCompletion(url, plan.kind, startedAt, route.abort('failed'));
    if (plan.kind === 'redirect') {
      return observeRouteCompletion(
        url,
        plan.kind,
        startedAt,
        route.fulfill({
          status,
          headers: {
            location: plan.location,
            'access-control-allow-origin': '*',
            'cache-control': 'no-store',
          },
        })
      );
    }
    if (plan.kind === 'http') {
      return observeRouteCompletion(
        url,
        plan.kind,
        startedAt,
        route.fulfill({
          status,
          contentType: 'text/plain',
          headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
          body: 'Image fixture HTTP failure',
        })
      );
    }
    const body =
      plan.kind === 'empty'
        ? Buffer.alloc(0)
        : plan.kind === 'html'
          ? Buffer.from('<html></html>')
          : plan.kind === 'malformed'
            ? Buffer.from([0, 1, 2, 3])
            : plan.kind === 'truncated'
              ? RED_PNG.subarray(0, 12)
              : RED_PNG;
    return observeRouteCompletion(
      url,
      plan.kind,
      startedAt,
      route.fulfill({
        status,
        contentType: plan.kind === 'html' ? 'text/html' : 'image/png',
        headers:
          plan.kind === 'cors'
            ? {
                // Playwright fills a missing ACAO header with the request origin.
                'access-control-allow-origin': 'https://cors-denied.example.test',
                'cache-control': 'no-store',
              }
            : { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
        body,
      })
    );
  };
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
  let imageRouteRegistered = false;
  let nativePageProbe: NativePageScriptProbe | undefined;
  let pageScriptProbeProvenance: NativePageScriptProbe['provenance'] | null = null;
  let primaryError: unknown;
  let redirectTransport: WorkerRedirectTransport | undefined;
  const execute = async () => {
    await context.route(SELF_FETCH_URL, selfFetchRoute);
    routeRegistered = true;
    await context.route('**/windows-bitmap-issue306-*', imageRoute);
    imageRouteRegistered = true;
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.href === SELF_FETCH_URL) return selfFetchRoute(route);
      if (imageRoutes.has(url.href)) return imageRoute(route);
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
            sourceUrl: String(args[0]),
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
              if (record.results.length < 64) record.results.push(event.data);
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
    const probeImage = async (
      id: string,
      phase: 'acquire' | 'release',
      target: 'emoji' | 'author' | 'sticker',
      url: string
    ): Promise<BitmapProbeResult> => {
      await page.evaluate(
        (command) => {
          const record = window.__ytBitmapWorkers.find((entry) => entry.ready && entry.attached);
          if (!record) throw new Error('Bitmap Worker was not attached');
          record.worker.postMessage({ type: 'ytBitmapProbe', ...command });
        },
        { id, phase, target, url }
      );
      await page.waitForFunction(
        ({ id: expectedId, phase: expectedPhase }) =>
          window.__ytBitmapWorkers.some((record) =>
            record.results.some(
              (result) => result.id === expectedId && result.phase === expectedPhase
            )
          ),
        { id, phase },
        { timeout: 8_000 }
      );
      const result = await page.evaluate(
        ({ id: expectedId, phase: expectedPhase }) => {
          const record = window.__ytBitmapWorkers.find((entry) => entry.ready && entry.attached);
          return record?.results.find(
            (item) => item.id === expectedId && item.phase === expectedPhase
          );
        },
        { id, phase }
      );
      assert(result, `Missing Worker image result for ${id}/${phase}`);
      assert.equal(result.errorType, undefined, `${id}/${phase}: ${result.errorType}`);
      assert.equal(result.target, target);
      return result;
    };
    const assertDrawn = (result: BitmapProbeResult, id: string) => {
      assert.equal(result.owned, true, `${id}: image absent from its target cache`);
      assert.deepEqual(result.pixel, [255, 0, 0, 255], `${id}: decoded image not drawn red`);
      assert.equal(result.width, 4);
      assert.equal(result.height, 4);
      assert.equal(result.drawError, null);
      assert.equal(result.failedCached, false);
    };
    const assertReleased = (result: BitmapProbeResult, id: string) => {
      assert.equal(result.owned, false, `${id}: cache retained released image`);
      assert.equal(result.width, 0);
      assert.equal(result.height, 0);
      assert(result.drawError, `${id}: released bitmap remained drawable`);
    };
    const controls: Array<{
      target: 'emoji' | 'author' | 'sticker';
      url: string;
      acquired: BitmapProbeResult;
      released: BitmapProbeResult;
    }> = [];
    for (const target of ['emoji', 'author', 'sticker'] as const) {
      const id = `control-${target}`;
      const url = `${IMAGE_CASE_PREFIX}${id}.png`;
      imageRoutes.set(url, { kind: 'png' });
      const requestStart = imageRequests.length;
      const acquired = await probeImage(id, 'acquire', target, url);
      assert.deepEqual(imageRequests.slice(requestStart), [{ url, kind: 'png', status: 200 }]);
      assert.equal(acquired.fetchAttempts, 1);
      assert.equal(acquired.responseStatus, 200);
      assert.equal(acquired.finalUrl, url);
      assert.equal(acquired.decodeAttempts, 1);
      assert.equal(acquired.decodeSuccesses, 1);
      assert.equal(acquired.decodeFailures, 0);
      assertDrawn(acquired, id);
      const released = await probeImage(id, 'release', target, url);
      assertReleased(released, id);
      controls.push({ target, url, acquired, released });
    }

    const finalUrls = [
      'https://yt4.ggpht.com/windows-bitmap-issue306-redirect-allowed-final.png',
      'https://example.test/windows-bitmap-issue306-redirect-offhost-final.png',
    ];
    const workerUrl = await page.evaluate(() => {
      const worker = window.__ytBitmapWorkers.find((entry) => entry.ready && entry.attached);
      if (!worker) throw new Error('Exact bitmap Worker is unavailable for redirects');
      return worker.sourceUrl;
    });
    redirectTransport = await installWorkerRedirectTransport({
      context,
      page,
      workerUrl,
      finalUrls,
      bodyBase64: RED_PNG.toString('base64'),
      onRequest: (url) => {
        assert.equal(imageRoutes.get(url)?.kind, 'png', 'Unplanned Worker redirect final response');
        if (imageRequests.length < 64) imageRequests.push({ url, kind: 'png', status: 200 });
        else imageRequestOverflow++;
      },
    });
    const faultKinds = [
      'http-401',
      'http-403',
      'http-404',
      'http-429',
      'http-503',
      'malformed',
      'truncated',
      'html',
      'empty',
      'abort',
      'cors',
      'redirect-allowed',
      'redirect-offhost',
    ] as const;
    const targets = ['emoji', 'author', 'sticker'] as const;
    const expectedConsoleFaultUrls = new Set<string>();
    const expectedRequestFailures = new Map<string, string>();
    const cases: Array<{
      id: string;
      target: 'emoji' | 'author' | 'sticker';
      faultUrl: string;
      routed: ImageRouteRecord[];
      fault: BitmapProbeResult;
      faultRelease: BitmapProbeResult | undefined;
      recoveryUrl: string;
      recovery: BitmapProbeResult;
      recoveryRelease: BitmapProbeResult;
    }> = [];
    for (const [index, kind] of faultKinds.entries()) {
      const id = kind;
      const target = targets[index % targets.length];
      assert(target);
      const faultUrl = `${IMAGE_CASE_PREFIX}${id}.png`;
      const recoveryUrl = `${IMAGE_CASE_PREFIX}${id}-recovery.png`;
      const redirectUrl =
        kind === 'redirect-allowed'
          ? `https://yt4.ggpht.com/windows-bitmap-issue306-${id}-final.png`
          : kind === 'redirect-offhost'
            ? `https://example.test/windows-bitmap-issue306-${id}-final.png`
            : null;
      if (kind.startsWith('http-')) {
        imageRoutes.set(faultUrl, { kind: 'http', status: Number(kind.slice(5)) });
        expectedConsoleFaultUrls.add(faultUrl);
        // Production explicitly cancels rejected HTTP response bodies.
        expectedRequestFailures.set(faultUrl, 'net::ERR_ABORTED');
      } else if (redirectUrl) {
        imageRoutes.set(faultUrl, { kind: 'redirect', location: redirectUrl });
        imageRoutes.set(redirectUrl, { kind: 'png' });
        if (kind === 'redirect-offhost') {
          // Playwright's Worker event can retain the original request URL
          // while native Response.url names the final redirected response.
          expectedRequestFailures.set(faultUrl, 'net::ERR_ABORTED');
          expectedRequestFailures.set(redirectUrl, 'net::ERR_ABORTED');
        }
      } else if (
        kind === 'malformed' ||
        kind === 'truncated' ||
        kind === 'html' ||
        kind === 'empty' ||
        kind === 'abort' ||
        kind === 'cors'
      ) {
        imageRoutes.set(faultUrl, { kind });
      } else {
        assert.fail(`Unsupported image fault kind: ${kind}`);
      }
      if (kind === 'abort' || kind === 'cors') {
        expectedConsoleFaultUrls.add(faultUrl);
        expectedRequestFailures.set(faultUrl, 'net::ERR_FAILED');
      }
      imageRoutes.set(recoveryUrl, { kind: 'png' });

      const requestStart = imageRequests.length;
      const fault = await probeImage(id, 'acquire', target, faultUrl);
      redirectTransport.assertHealthy();
      const routed = imageRequests.slice(requestStart);
      assert.deepEqual(
        routed.map((request) => request.url),
        redirectUrl ? [faultUrl, redirectUrl] : [faultUrl],
        `${id}: unexpected routed request sequence`
      );
      assert.deepEqual(
        routed.map((request) => request.status),
        redirectUrl
          ? [302, 200]
          : [kind.startsWith('http-') ? Number(kind.slice(5)) : kind === 'abort' ? null : 200],
        `${id}: unexpected routed response status`
      );
      assert.equal(fault.fetchAttempts, 1, `${id}: Worker did not call fetch once`);
      assert.equal(
        fault.responseStatus,
        kind.startsWith('http-')
          ? Number(kind.slice(5))
          : kind === 'abort' || kind === 'cors'
            ? null
            : 200,
        `${id}: unexpected fetch response status`
      );
      assert.equal(
        fault.finalUrl,
        kind === 'abort' || kind === 'cors' ? null : (redirectUrl ?? faultUrl)
      );
      const permitted = kind === 'redirect-allowed';
      const decodeFault = ['malformed', 'truncated', 'html', 'empty'].includes(kind);
      assert.equal(
        fault.decodeAttempts,
        decodeFault || permitted ? 1 : 0,
        `${id}: decode boundary`
      );
      assert.equal(fault.decodeSuccesses, permitted ? 1 : 0);
      assert.equal(fault.decodeFailures, decodeFault ? 1 : 0);
      if (kind === 'abort' || kind === 'cors') assert(fault.fetchErrorType);
      else assert.equal(fault.fetchErrorType, null);
      let faultRelease: BitmapProbeResult | undefined;
      if (permitted) {
        assertDrawn(fault, id);
        faultRelease = await probeImage(id, 'release', target, faultUrl);
        assertReleased(faultRelease, id);
      } else {
        assert.equal(fault.owned, false, `${id}: failed image reached cache`);
        assert.equal(fault.pixel, null);
        assert.equal(fault.failedCached, true, `${id}: failure not retained by retry policy`);
      }

      const recoveryStart = imageRequests.length;
      const recovery = await probeImage(`${id}-recovery`, 'acquire', target, recoveryUrl);
      assert.deepEqual(imageRequests.slice(recoveryStart), [
        { url: recoveryUrl, kind: 'png', status: 200 },
      ]);
      assert.equal(recovery.fetchAttempts, 1);
      assert.equal(recovery.responseStatus, 200);
      assert.equal(recovery.finalUrl, recoveryUrl);
      assert.equal(recovery.decodeAttempts, 1);
      assert.equal(recovery.decodeSuccesses, 1);
      assert.equal(recovery.decodeFailures, 0);
      assertDrawn(recovery, `${id}-recovery`);
      const recoveryRelease = await probeImage(`${id}-recovery`, 'release', target, recoveryUrl);
      assertReleased(recoveryRelease, `${id}-recovery`);
      cases.push({
        id,
        target,
        faultUrl,
        routed,
        fault,
        faultRelease,
        recoveryUrl,
        recovery,
        recoveryRelease,
      });
    }
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
      worker.slice(0, 4).map((result) => result.phase),
      ['before', 'after', 'self-fetch-before', 'self-fetch-after']
    );
    assert.equal(worker.length, 4 + controls.length * 2 + cases.length * 3 + 1);
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
    assert.deepEqual(
      consoleErrors.filter(
        (message) =>
          !Array.from(expectedConsoleFaultUrls).some(
            (url) => message.url === url || message.text.includes(url)
          )
      ),
      [],
      'Unexpected browser console error outside exact image fault URLs'
    );
    assert.equal(consoleErrorOverflow, 0);
    const completedProbes = [
      ...controls.map(({ target, url, acquired }) => ({
        id: `control-${target}`,
        url,
        result: acquired,
      })),
      ...cases.map(({ id, recoveryUrl, recovery }) => ({
        id: `${id}-recovery`,
        url: recoveryUrl,
        result: recovery,
      })),
    ];
    const noObservationOverflow =
      requestFailureOverflow === 0 &&
      requestObservationOverflow === 0 &&
      imageRequestOverflow === 0 &&
      routeCompletionOverflow === 0 &&
      probeOverflow.workers === 0 &&
      probeOverflow.results === 0 &&
      pageErrorOverflow === 0 &&
      consoleErrorOverflow === 0;
    assert.deepEqual(
      requestFailures.filter(
        (failure) =>
          expectedRequestFailures.get(failure.url) !== failure.errorText &&
          !isCompletedRoutedBitmapFailure({
            failure,
            failures: requestFailures,
            observations: [...requestObservations.values()],
            routes: imageRequests,
            completions: routeCompletions,
            probes: completedProbes,
            noOverflow: noObservationOverflow,
          })
      ),
      [],
      'Unexpected network failure outside exact injected faults or completed routed bitmaps'
    );
    assert.equal(requestFailureOverflow, 0);
    assert.equal(requestObservationOverflow, 0);
    assert.equal(imageRequestOverflow, 0);
    assert.equal(routeCompletionOverflow, 0);
    assert.equal(imageRequests.length, 31);
    redirectTransport.assertHealthy();
    assert.deepEqual(redirectTransport.binding.terminalRequests, finalUrls);
    assert.deepEqual(probeOverflow, { workers: 0, results: 0 });
    return {
      status: 'passed',
      source: 'compiled extension page/Worker cache',
      transferScope: 'defensive existing receiver protocol; no production imageData sender',
      main,
      selfFetchScope: 'direct call to compiled WorkerRenderer.prefetchImages with routed image',
      sender,
      worker: worker.slice(0, 4),
      imageAcquisition: {
        scope:
          'same packaged WorkerRenderer self-fetch, native decode/cache/draw in installed Edge',
        drawScope:
          'cached production bitmap on probe-created OffscreenCanvas; production message placement/draw is separate',
        negativeCacheRetry: 'not run; each recovery uses a distinct URL within the active TTL',
        controls,
        cases,
        imageRequests,
        imageRequestOverflow,
        routeCompletions,
        routeCompletionOverflow,
        redirectTransport: redirectTransport.binding,
        requestFailures,
        requestFailureOverflow,
        requestObservations: [...requestObservations.values()],
        requestObservationOverflow,
      },
      selfFetchRequests,
      pageErrors,
      pageErrorOverflow,
      consoleErrors,
      consoleErrorOverflow,
      probeOverflow,
      pageScriptProbeProvenance,
    };
  };
  let result: Awaited<ReturnType<typeof execute>> | undefined;
  try {
    result = await execute();
  } catch (error) {
    primaryError = error;
    try {
      const workerObservations = await page.evaluate(() =>
        window.__ytBitmapWorkers.map((worker) => ({
          ready: worker.ready,
          attached: worker.attached,
          results: worker.results,
          overflow: worker.overflow,
        }))
      );
      await writeFile(
        join(output, 'bitmap-lifecycle-failure.json'),
        JSON.stringify(
          {
            status: 'failed',
            error: String(error),
            failure: describeFailure(error),
            pageScriptProbeProvenance,
            imageRequests,
            imageRequestOverflow,
            routeCompletions,
            routeCompletionOverflow,
            workerObservations,
            pageErrors,
            pageErrorOverflow,
            consoleErrors,
            consoleErrorOverflow,
            requestFailures,
            requestFailureOverflow,
            requestObservations: [...requestObservations.values()],
            requestObservationOverflow,
          },
          null,
          2
        )
      );
    } catch (diagnosticError) {
      primaryError = new AggregateError(
        [error, diagnosticError],
        'Bitmap fixture and failure diagnostic collection failed'
      );
    }
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    async () => redirectTransport?.close(),
    async () => nativePageProbe?.restore(),
    async () => page.close(),
    async () => {
      if (imageRouteRegistered) await context.unroute('**/windows-bitmap-issue306-*', imageRoute);
    },
    async () => {
      if (routeRegistered) await context.unroute(SELF_FETCH_URL, selfFetchRoute);
    },
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
        join(output, 'bitmap-lifecycle-cleanup-failure.json'),
        JSON.stringify(
          {
            status: 'failed',
            scenarioError: primaryError ? String(primaryError) : null,
            scenarioResult: result ?? null,
            cleanupErrors: cleanupErrors.map((error) => describeFailure(error)),
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
      'Bitmap fixture owned-resource cleanup failed'
    );
  }
  if (primaryError) throw primaryError;
  assert(result, 'Bitmap fixture completed without a result');
  return result;
}
