// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, Route } from '@playwright/test';

import {
  installNativePageScriptProbe,
  type NativePageScriptProbe,
} from './native-page-script-probe.ts';
import { buildVisibleWatchHtml } from './visible-watch.ts';

const FIXTURE_URL = 'https://www.youtube.com/watch?v=windowsWorkerRetirement';
const HELD_URL = 'https://yt3.ggpht.com/windows-worker-retirement-held.png';
const HEALTHY_URL = 'https://yt3.ggpht.com/windows-worker-retirement-healthy.png';
const ENTRY_MARKER = '\n\tmain();\n';
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGP8z8DwnwEJMDGgAcICAIPRAgYCkO9YAAAAAElFTkSuQmCC',
  'base64'
);
const MAX_EVENTS = 32;

type ProbeEvent = {
  phase: string;
  nativeBitmap?: boolean;
  width?: number;
  waiterSettled?: boolean;
  destroyed?: boolean;
  pendingTasks?: number;
  closeCount?: number;
  cacheHasUrl?: boolean;
  oldCacheHasUrl?: boolean;
  failedCached?: boolean;
  pixel?: number[];
  error?: string;
};

type WorkerRecord = {
  worker: Worker;
  url: string;
  createdAtMs: number;
  ready: boolean;
  destroyPosts: number;
  destroyAtMs: number | null;
  acks: number;
  ackAtMs: number | null;
  releaseAtMs: number | null;
  terminations: number;
  terminationAtMs: number | null;
  activeIds: string[];
  statsCount: number;
  events: ProbeEvent[];
  overflow: number;
};

type PageState = {
  workers: WorkerRecord[];
  overflow: number;
  workerSource: string | null;
  restartError: string | null;
  restartComplete: boolean;
};

declare global {
  interface Window {
    __ytNativeWorkerRetirement?: PageState;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The suffix receives the real packaged WorkerRenderer instance. */
function attachWorkerRetirementProbe(renderer: {
  prefetchImages(urls: string[], cache: { has(url: string): boolean }): Promise<void>;
  emojiCache: { has(url: string): boolean; get(url: string): ImageBitmap | undefined };
  imageFetchTasks: Map<string, unknown>;
  failedImageFetches: Map<string, number>;
  isDestroyed: boolean;
}) {
  if (typeof renderer?.prefetchImages !== 'function') return;
  const nativePost = self.postMessage.bind(self);
  const nativeDecode = self.createImageBitmap.bind(self);
  const nativeClose = ImageBitmap.prototype.close;
  const heldUrl = 'https://yt3.ggpht.com/windows-worker-retirement-held.png';
  const healthyUrl = 'https://yt3.ggpht.com/windows-worker-retirement-healthy.png';
  let armed = false;
  let heldBitmap: ImageBitmap | null = null;
  let resolveDecode: ((bitmap: ImageBitmap) => void) | null = null;
  let heldAck: unknown = null;
  let closeCount = 0;
  let waiterSettled = false;
  let nativeBitmap = false;
  const report = (event: ProbeEvent) => nativePost({ type: 'ytWorkerRetirementProbe', ...event });

  ImageBitmap.prototype.close = function () {
    if (this === heldBitmap) closeCount++;
    Reflect.apply(nativeClose, this, []);
  };
  self.createImageBitmap = async (source: ImageBitmapSource) => {
    if (!armed) return nativeDecode(source);
    armed = false;
    const bitmap = await nativeDecode(source);
    if (heldBitmap) throw new Error('Retirement probe captured multiple bitmaps');
    heldBitmap = bitmap;
    nativeBitmap = bitmap instanceof ImageBitmap && bitmap.width === 4 && bitmap.height === 4;
    report({ phase: 'native-decode-held', nativeBitmap, width: bitmap.width });
    return new Promise<ImageBitmap>((resolve) => {
      resolveDecode = resolve;
    });
  };
  self.postMessage = ((message: unknown, ...args: unknown[]) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'ack' &&
      heldBitmap !== null
    ) {
      if (heldAck !== null) throw new Error('Retirement probe captured duplicate ACK');
      heldAck = message;
      report({
        phase: 'ack-held',
        destroyed: renderer.isDestroyed,
        pendingTasks: renderer.imageFetchTasks.size,
        waiterSettled,
      });
      return;
    }
    Reflect.apply(nativePost, self, [message, ...args]);
  }) as typeof self.postMessage;
  self.addEventListener('message', (event: MessageEvent) => {
    const data = event.data;
    if (data?.type !== 'ytWorkerRetirementCommand') return;
    if (data.phase === 'start') {
      if (armed || heldBitmap || resolveDecode) throw new Error('Probe started twice');
      armed = true;
      void renderer.prefetchImages([heldUrl], renderer.emojiCache).then(() => {
        waiterSettled = true;
        report({
          phase: 'waiter-settled',
          destroyed: renderer.isDestroyed,
          pendingTasks: renderer.imageFetchTasks.size,
        });
      });
      return;
    }
    if (data.phase === 'release') {
      void (async () => {
        if (!heldBitmap || !resolveDecode || !heldAck || !waiterSettled || !nativeBitmap)
          throw new Error('A was released without real decode, destroy and waiter retirement');
        const bitmap = heldBitmap;
        resolveDecode(bitmap);
        resolveDecode = null;
        // The production runImageFetch continuation has now had a task turn.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        report({
          phase: 'late-bitmap-retired',
          nativeBitmap,
          width: bitmap.width,
          closeCount,
          cacheHasUrl: renderer.emojiCache.has(heldUrl),
          failedCached: renderer.failedImageFetches.has(heldUrl),
          pendingTasks: renderer.imageFetchTasks.size,
        });
        ImageBitmap.prototype.close = nativeClose;
        self.createImageBitmap = nativeDecode;
        self.postMessage = nativePost;
        nativePost(heldAck);
        heldAck = null;
      })().catch((error: unknown) => report({ phase: 'release-error', error: String(error) }));
      return;
    }
    if (data.phase === 'healthy') {
      void (async () => {
        await renderer.prefetchImages([healthyUrl], renderer.emojiCache);
        const bitmap = renderer.emojiCache.get(healthyUrl);
        const canvas = new OffscreenCanvas(4, 4);
        const context = canvas.getContext('2d');
        if (!bitmap || !context) throw new Error('B native bitmap draw is unavailable');
        context.drawImage(bitmap, 0, 0);
        report({
          phase: 'healthy',
          cacheHasUrl: renderer.emojiCache.has(healthyUrl),
          oldCacheHasUrl: renderer.emojiCache.has(heldUrl),
          failedCached: renderer.failedImageFetches.has(healthyUrl),
          pendingTasks: renderer.imageFetchTasks.size,
          pixel: Array.from(context.getImageData(0, 0, 1, 1).data),
        });
      })().catch((error: unknown) => report({ phase: 'healthy-error', error: String(error) }));
    }
  });
  report({ phase: 'attached' });
}

function installPagePrelude({
  probeSource,
  maxEvents,
}: {
  probeSource: string;
  maxEvents: number;
}): void {
  const state: PageState = {
    workers: [],
    overflow: 0,
    workerSource: null,
    restartError: null,
    restartComplete: false,
  };
  window.__ytNativeWorkerRetirement = state;
  // This isolated fixture supplies a playing prerequisite; it is not a player test.
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
        if (!match) throw new Error('Packaged Worker handler shape changed');
        if (
          parts[0].length > 262_144 ||
          (state.workerSource !== null && state.workerSource !== parts[0])
        )
          throw new Error('Packaged Worker source changed between instances');
        state.workerSource = parts[0];
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
      const record: WorkerRecord = {
        worker,
        url: String(args[0]),
        createdAtMs: performance.now(),
        ready: false,
        destroyPosts: 0,
        destroyAtMs: null,
        acks: 0,
        ackAtMs: null,
        releaseAtMs: null,
        terminations: 0,
        terminationAtMs: null,
        activeIds: [],
        statsCount: 0,
        events: [],
        overflow: 0,
      };
      if (state.workers.length < 3) state.workers.push(record);
      else state.overflow++;
      const post = worker.postMessage.bind(worker);
      worker.postMessage = ((message: unknown, ...transfer: unknown[]) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'destroy'
        ) {
          record.destroyPosts++;
          record.destroyAtMs = performance.now();
        }
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'ytWorkerRetirementCommand' &&
          'phase' in message &&
          message.phase === 'release'
        )
          record.releaseAtMs = performance.now();
        Reflect.apply(post, worker, [message, ...transfer]);
      }) as typeof worker.postMessage;
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => {
        record.terminations++;
        record.terminationAtMs = performance.now();
        terminate();
      };
      worker.addEventListener('message', (event: MessageEvent) => {
        if (event.data?.type === 'ready') record.ready = true;
        if (event.data?.type === 'stats') {
          record.statsCount++;
          record.activeIds = Array.isArray(event.data.activeMessageIds)
            ? event.data.activeMessageIds.slice(0, 8)
            : [];
        }
        if (event.data?.type === 'ack') {
          record.acks++;
          record.ackAtMs = performance.now();
        }
        if (event.data?.type === 'ytWorkerRetirementProbe') {
          if (record.events.length < maxEvents) record.events.push(event.data);
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
    currentVideoEndpoint: { watchEndpoint: { videoId: 'windowsWorkerRetirement' } },
    contents: {
      twoColumnWatchNextResults: {
        conversationBar: {
          liveChatRenderer: {
            isReplay: false,
            continuations: [
              {
                timedContinuationData: {
                  continuation: 'windows-worker-retirement-live',
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

/** Native Worker A decode retirement while a supported runtime restart creates B. */
export async function runNativeWorkerRetirementFixture({
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
  const workerSource = await readFile(join(root, 'dist-extension/workers/renderer.js'), 'utf8');
  assert.equal(source.split(ENTRY_MARKER).length, 2, 'Packaged page entry changed');
  const instrumented = source.replace(
    ENTRY_MARKER,
    `\n\twindow.__ytWorkerRetirementSource = true;${ENTRY_MARKER}`
  );
  const preview = await readFile(join(root, 'test/visual/preview.html'), 'utf8');
  const html = buildVisibleWatchHtml(preview, 'Worker retirement fixture video').replace(
    '<div id="chat">',
    '<div id="chat" class="ytd-live-chat-frame" style="min-height:1px">'
  );
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  let errorOverflow = 0;
  const requestCounts = { held: 0, healthy: 0 };
  const route = (request: Route) => {
    const url = new URL(request.request().url());
    if (url.protocol === 'chrome-extension:' && url.hostname === extensionId)
      return request.continue();
    if (url.href === FIXTURE_URL && request.request().resourceType() === 'document')
      return request.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (url.href === HELD_URL || url.href === HEALTHY_URL) {
      if (url.href === HELD_URL) requestCounts.held++;
      else requestCounts.healthy++;
      return request.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
        body: RED_PNG,
      });
    }
    if (url.hostname === 'www.youtube.com' && url.pathname === '/favicon.ico')
      return request.fulfill({ status: 204 });
    if (
      url.hostname === 'www.youtube.com' &&
      url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat')
    )
      return request.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          continuationContents: {
            liveChatContinuation: {
              actions: [],
              continuations: [
                {
                  timedContinuationData: {
                    continuation: 'windows-worker-retirement-next',
                    timeoutMs: 30_000,
                  },
                },
              ],
            },
          },
        },
      });
    return request.fulfill({ status: 403, body: 'Blocked by Worker retirement fixture' });
  };
  page.on('pageerror', (error) => {
    if (pageErrors.length < 10) pageErrors.push(errorText(error).slice(0, 200));
    else errorOverflow++;
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (consoleErrors.length < 10) consoleErrors.push(message.text().slice(0, 200));
    else errorOverflow++;
  });
  let pageRouteRegistered = false;
  let imageRouteRegistered = false;
  let probe: NativePageScriptProbe | undefined;
  let probeProvenance: NativePageScriptProbe['provenance'] | null = null;
  let primaryError: unknown;
  let result: Record<string, unknown> | undefined;
  const observations = async () =>
    page.evaluate(() => {
      const state = window.__ytNativeWorkerRetirement;
      return {
        overflow: state?.overflow ?? null,
        restartError: state?.restartError ?? null,
        restartComplete: state?.restartComplete ?? false,
        workers:
          state?.workers.map((worker) => ({
            ready: worker.ready,
            createdAtMs: worker.createdAtMs,
            destroyPosts: worker.destroyPosts,
            destroyAtMs: worker.destroyAtMs,
            acks: worker.acks,
            ackAtMs: worker.ackAtMs,
            releaseAtMs: worker.releaseAtMs,
            terminations: worker.terminations,
            terminationAtMs: worker.terminationAtMs,
            activeIds: worker.activeIds,
            statsCount: worker.statsCount,
            events: worker.events,
            overflow: worker.overflow,
          })) ?? [],
        liveIds: Array.from(
          document.querySelectorAll('#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p'),
          (node) => node.getAttribute('data-message-id')
        ).slice(0, 8),
        canvasCount: document.querySelectorAll('#yt-live-chat-overlay canvas').length,
      };
    });
  try {
    await context.route('**/windows-worker-retirement-*.png', route);
    imageRouteRegistered = true;
    await page.route('**/*', route);
    pageRouteRegistered = true;
    await page.addInitScript(installPagePrelude, {
      probeSource: attachWorkerRetirementProbe.toString(),
      maxEvents: MAX_EVENTS,
    });
    probe = await installNativePageScriptProbe({
      context,
      root,
      extensionId,
      fixtureUrl: FIXTURE_URL,
      instrumentedSource: instrumented,
    });
    probeProvenance = probe.provenance;
    await probe.assertReady();
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page
      .locator('#yt-live-chat-overlay canvas')
      .waitFor({ state: 'attached', timeout: 15_000 });
    await probe.assertInjected();
    await probe.restore();
    probe = undefined;
    await page.waitForFunction(
      () =>
        window.__ytNativeWorkerRetirement?.workers[0]?.ready &&
        window.__ytNativeWorkerRetirement.workers[0]?.events.some(
          (event) => event.phase === 'attached'
        ),
      undefined,
      { timeout: 15_000 }
    );
    const observedWorkerSha256 = await page.evaluate(async () => {
      const bundled = window.__ytNativeWorkerRetirement?.workerSource;
      if (!bundled) throw new Error('Packaged Worker Blob source was not observed');
      return Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bundled))),
        (byte) => byte.toString(16).padStart(2, '0')
      ).join('');
    });
    assert.equal(
      observedWorkerSha256,
      sha256(workerSource),
      'Installed Worker Blob did not contain the exact packaged source'
    );
    await page.evaluate(() =>
      window.__ytNativeWorkerRetirement?.workers[0]?.worker.postMessage({
        type: 'ytWorkerRetirementCommand',
        phase: 'start',
      })
    );
    await page.waitForFunction(
      () =>
        window.__ytNativeWorkerRetirement?.workers[0]?.events.some(
          (event) => event.phase === 'native-decode-held'
        ),
      undefined,
      { timeout: 8_000 }
    );
    const held = await observations();
    assert.equal(
      held.workers[0]?.events.find((event) => event.phase === 'native-decode-held')?.nativeBitmap,
      true
    );
    await page.evaluate(() => {
      const app = window.__ytChatOverlay;
      if (!app) throw new Error('Installed app is unavailable for supported restart');
      void app
        .restartRuntime()
        .then(() => {
          if (window.__ytNativeWorkerRetirement)
            window.__ytNativeWorkerRetirement.restartComplete = true;
        })
        .catch((error: unknown) => {
          if (window.__ytNativeWorkerRetirement)
            window.__ytNativeWorkerRetirement.restartError = String(error).slice(0, 200);
        });
    });
    const releaseHandle = await page.waitForFunction(
      () => {
        const workers = window.__ytNativeWorkerRetirement?.workers;
        const a = workers?.[0];
        if (!a || a.destroyAtMs === null) return false;
        const elapsedMs = performance.now() - a.destroyAtMs;
        if (a.terminations > 0) return { status: 'terminated-before-release', elapsedMs };
        // Reserve 150 ms for the native decode continuation and real ACK.
        if (elapsedMs >= 350) return { status: 'deadline-expired', elapsedMs };
        const ack = a.events.find((event) => event.phase === 'ack-held');
        const waiter = a.events.find((event) => event.phase === 'waiter-settled');
        if (workers?.length !== 2 || a.destroyPosts !== 1 || !ack || !waiter) return false;
        if (ack.pendingTasks !== 0 || waiter.destroyed !== true)
          return { status: 'retirement-precondition-failed', elapsedMs };
        // Detection and release run in one page task. No Playwright RPC may
        // consume A's remaining safety window between these operations.
        a.worker.postMessage({ type: 'ytWorkerRetirementCommand', phase: 'release' });
        return {
          status: 'released',
          elapsedMs,
          aTerminations: a.terminations,
          aPendingTasks: ack.pendingTasks,
          waiterDestroyed: waiter.destroyed,
          bCreatedAtMs: workers[1]?.createdAtMs ?? null,
          releaseAtMs: a.releaseAtMs,
        };
      },
      undefined,
      { timeout: 1_000, polling: 10 }
    );
    const releaseGuard = (await releaseHandle.jsonValue()) as {
      status: string;
      elapsedMs: number;
      aTerminations?: number;
      aPendingTasks?: number;
      waiterDestroyed?: boolean;
      bCreatedAtMs?: number | null;
      releaseAtMs?: number | null;
    };
    await releaseHandle.dispose();
    assert.equal(
      releaseGuard.status,
      'released',
      `A release guard did not meet its safety deadline: ${releaseGuard.status}`
    );
    assert(releaseGuard.elapsedMs >= 0 && releaseGuard.elapsedMs < 350);
    assert.equal(releaseGuard.aTerminations, 0);
    assert.equal(releaseGuard.aPendingTasks, 0);
    assert.equal(releaseGuard.waiterDestroyed, true);
    assert(releaseGuard.bCreatedAtMs !== null && releaseGuard.bCreatedAtMs !== undefined);
    assert(releaseGuard.releaseAtMs !== null && releaseGuard.releaseAtMs !== undefined);
    await page.waitForFunction(
      () =>
        window.__ytNativeWorkerRetirement?.workers[0]?.events.some(
          (event) => event.phase === 'late-bitmap-retired' || event.phase === 'release-error'
        ),
      undefined,
      { timeout: 1_000 }
    );
    const afterRelease = await observations();
    const retired = afterRelease.workers[0]?.events.find(
      (event) => event.phase === 'late-bitmap-retired'
    );
    assert(retired, 'A did not retire its real late bitmap');
    assert.equal(retired.closeCount, 1);
    assert.equal(retired.width, 0);
    assert.equal(retired.cacheHasUrl, false);
    assert.equal(retired.failedCached, false);
    assert.equal(retired.pendingTasks, 0);
    await page.waitForFunction(
      () =>
        window.__ytNativeWorkerRetirement?.workers[0]?.terminations === 1 &&
        window.__ytNativeWorkerRetirement.workers[1]?.ready,
      undefined,
      { timeout: 8_000 }
    );
    await page.evaluate(() =>
      window.__ytNativeWorkerRetirement?.workers[1]?.worker.postMessage({
        type: 'ytWorkerRetirementCommand',
        phase: 'healthy',
      })
    );
    await page.waitForFunction(
      () =>
        window.__ytNativeWorkerRetirement?.workers[1]?.events.some(
          (event) => event.phase === 'healthy' || event.phase === 'healthy-error'
        ),
      undefined,
      { timeout: 8_000 }
    );
    await page.waitForFunction(
      // The supported public handle intentionally hides App internals. Its
      // restart Promise resolves after session reconciliation; the DOM control
      // below independently proves that the replacement source is receiving.
      () => window.__ytNativeWorkerRetirement?.restartComplete === true,
      undefined,
      { timeout: 8_000 }
    );
    await page.evaluate(() => {
      const items = document.querySelector('yt-live-chat-item-list-renderer #items');
      if (!items) throw new Error('Installed chat DOM is unavailable');
      const item = document.createElement('yt-live-chat-text-message-renderer');
      item.id = 'windows-worker-retirement-b';
      const author = document.createElement('span');
      author.id = 'author-name';
      author.textContent = 'Healthy B';
      const message = document.createElement('span');
      message.id = 'message';
      message.textContent = 'Healthy Worker B';
      item.append(author, message);
      items.append(item);
    });
    await page.waitForFunction(
      () =>
        Array.from(
          document.querySelectorAll('#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p')
        ).some((node) => node.getAttribute('data-message-id') === 'windows-worker-retirement-b'),
      undefined,
      { timeout: 8_000 }
    );
    await page.waitForFunction(
      () =>
        window.__ytNativeWorkerRetirement?.workers[1]?.activeIds.includes(
          'windows-worker-retirement-b'
        ),
      undefined,
      { timeout: 8_000 }
    );
    const final = await observations();
    assert.equal(final.workers.length, 2);
    assert.equal(final.overflow, 0);
    assert.equal(final.restartError, null);
    assert.equal(final.restartComplete, true);
    assert.equal(final.workers[0]?.destroyPosts, 1);
    assert.equal(final.workers[0]?.acks, 1);
    assert.equal(final.workers[0]?.terminations, 1);
    const ackAt = final.workers[0]?.ackAtMs;
    const destroyAt = final.workers[0]?.destroyAtMs;
    const releaseAt = final.workers[0]?.releaseAtMs;
    const terminationAt = final.workers[0]?.terminationAtMs;
    assert(destroyAt !== null && destroyAt !== undefined);
    assert(releaseAt !== null && releaseAt !== undefined);
    assert(ackAt !== null && ackAt !== undefined);
    assert(terminationAt !== null && terminationAt !== undefined);
    assert(
      final.workers[1]?.createdAtMs !== undefined &&
        final.workers[1].createdAtMs <= releaseAt &&
        releaseAt <= ackAt,
      'B was not constructed before A late decode and ACK release'
    );
    assert(
      ackAt >= destroyAt && ackAt - destroyAt < 500,
      'A late ACK missed the existing 500 ms safety window'
    );
    assert(
      terminationAt >= ackAt && terminationAt - ackAt < 100,
      'A termination was not tied to its actual late ACK'
    );
    assert.equal(final.workers[1]?.terminations, 0);
    assert.equal(
      final.workers[1]?.events.find((event) => event.phase === 'healthy')?.cacheHasUrl,
      true
    );
    assert.equal(
      final.workers[1]?.events.find((event) => event.phase === 'healthy')?.failedCached,
      false
    );
    assert.equal(
      final.workers[1]?.events.find((event) => event.phase === 'healthy')?.oldCacheHasUrl,
      false,
      'A asset appeared in B cache'
    );
    assert.deepEqual(
      final.workers[1]?.events.find((event) => event.phase === 'healthy')?.pixel,
      [255, 0, 0, 255],
      'B did not draw its native decoded bitmap'
    );
    assert(final.liveIds.includes('windows-worker-retirement-b'));
    assert(final.workers[1]?.activeIds.includes('windows-worker-retirement-b'));
    assert.equal(final.canvasCount, 1);
    assert(final.workers.every((worker) => worker.overflow === 0));
    assert.deepEqual(requestCounts, { held: 1, healthy: 1 }, 'Unexpected image requests');
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
    assert.equal(errorOverflow, 0);
    result = {
      status: 'passed',
      scope:
        'installed Edge extension; supported same-page App.restartRuntime; native bitmap decode and Worker A/B ownership',
      exclusions: [
        'SPA A→B→A',
        'actual late Worker error',
        'production media placement in B',
        '499/501 ms timer boundaries',
      ],
      packagedPageScriptSha256: sha256(source),
      packagedWorkerSha256: observedWorkerSha256,
      workerProbeFunctionSha256: sha256(attachWorkerRetirementProbe.toString()),
      pageScriptProbeProvenance: probeProvenance,
      releaseGuard,
      final,
      requestCounts,
      pageErrors,
      consoleErrors,
      errorOverflow,
    };
  } catch (error) {
    primaryError = error;
    try {
      await writeFile(
        join(output, 'native-worker-retirement-failure.json'),
        JSON.stringify(
          {
            status: 'failed',
            error: errorText(error),
            observations: await observations(),
            requestCounts,
            pageErrors,
            consoleErrors,
            errorOverflow,
          },
          null,
          2
        )
      );
    } catch (diagnosticError) {
      primaryError = new AggregateError(
        [error, diagnosticError],
        'Worker retirement failed and diagnostics could not be retained'
      );
    }
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    async () => probe?.restore(),
    async () => pageRouteRegistered && page.unroute('**/*', route),
    async () =>
      imageRouteRegistered && context.unroute('**/windows-worker-retirement-*.png', route),
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
        join(output, 'native-worker-retirement-cleanup-failure.json'),
        JSON.stringify(
          {
            status: 'failed',
            primaryError: primaryError ? errorText(primaryError) : null,
            cleanupErrors: cleanupErrors.map(errorText),
          },
          null,
          2
        )
      );
    } catch (sidecarError) {
      cleanupErrors.push(sidecarError);
    }
    throw new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      'Worker retirement fixture cleanup failed'
    );
  }
  if (primaryError) throw primaryError;
  assert(result);
  return result;
}
