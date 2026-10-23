// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, Page, Route } from '@playwright/test';

import {
  installNativePageScriptProbe,
  type NativePageScriptProbe,
} from './native-page-script-probe.ts';
import { buildVisibleWatchHtml } from './visible-watch.ts';

const FIXTURE_URL = 'https://www.youtube.com/watch?v=windowsRecoveryContinuity';
const IMAGE_PREFIX = 'https://yt3.ggpht.com/windows-continuity-';
const OLD_URL = `${IMAGE_PREFIX}old.png`;
const NEW_URL = `${IMAGE_PREFIX}new.png`;
const AVATAR_URL = `${IMAGE_PREFIX}avatar.png`;
const STICKER_URL = `${IMAGE_PREFIX}sticker.png`;
const ENTRY_MARKER = '\n\tmain();\n';
const ERROR_MARKER = 'windows-continuity-worker-runtime-error';
const CONTROL_ID = 'windows-continuity-control';
const TARGET_ID = 'windows-continuity-target';
const FUTURE_ID = 'windows-continuity-future';
const PAID_ID = 'windows-continuity-paid';
const FILLER_COUNT = 38;
const MAX_EVENTS = 80;
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGP8z8DwnwEJMDGgAcICAIPRAgYCkO9YAAAAAElFTkSuQmCC',
  'base64'
);

type ChatMessage = {
  id: string;
  text: string;
  content: Array<
    | { type: 'text'; content: string }
    | { type: 'emoji'; emoji: { url: string; alt: string; fallbackText?: string } }
  >;
  kind: 'text' | 'superchat';
  timestamp: number;
  author: string;
  authorType: 'normal';
  authorPhotoUrl?: string;
  superChat?: { amount: string; tier: 'blue'; sticker: { url: string; alt: string } };
  actionType: 'add' | 'replace';
};

type Motion = { id: string; startEpochMs: number; durationMs: number };
type WorkerProbeEvent = {
  phase: 'attached' | 'armed' | 'inspection' | 'held' | 'released' | 'probe-error';
  atMs: number;
  activeIds?: string[];
  pendingIds?: string[];
  requestId?: number;
  epoch?: number;
  processedBatchSequence?: number;
  motions?: Motion[];
  error?: string;
};
type WorkerRecord = {
  worker: Worker;
  ready: boolean;
  pongs: number;
  errors: string[];
  destroyPosts: number;
  terminations: number;
  snapshotPosts: Array<{ requestId: number; epoch: number; atMs: number }>;
  snapshotArrivals: Array<{ requestId: number; epoch: number; atMs: number }>;
  events: WorkerProbeEvent[];
  overflow: number;
};
type AcceptedSnapshot = {
  atMs: number;
  activeIds: string[];
  pendingIds: string[];
  processedBatchSequence: number;
  epoch: number;
  messages: Array<{ id: string; activeMotionStartEpochMs: number | null }>;
};
type RendererProbe = {
  addMessage(message: ChatMessage): void;
  fallbackInProgress: boolean;
  fallbackRecoveryFailed: boolean;
  workerManager: {
    isActive: boolean;
    workerRef: Worker | null;
  };
  activeMessages: Array<{ message: ChatMessage; startTime: number }>;
  pendingQueue: { toArray(): ChatMessage[] };
  settings: {
    maxConcurrentMessages: number;
    danmakuMode: string;
    outline: { enabled: boolean };
  };
  canvas: HTMLCanvasElement | null;
};
type Draw = {
  url: string;
  pixelChanged: boolean;
  before: number[] | null;
  after: number[] | null;
  pixelError: string | null;
};
type ContinuityState = {
  workers: WorkerRecord[];
  workerOverflow: number;
  workerSource: string | null;
  renderer: RendererProbe | null;
  sourceBound: boolean;
  mainFrames: number;
  fallbackReasons: string[];
  managerSnapshotStartedAtMs: number | null;
  acceptedSnapshots: AcceptedSnapshot[];
  heldCallback: (() => void) | null;
  transitionError: string | null;
  transitionIngress: string[];
  transitionAtMs: number | null;
  draws: Draw[];
  drawOverflow: number;
  textDraws: string[];
  textOverflow: number;
  imageLoads: Array<{ url: string; currentSrc: string; width: number; height: number }>;
  imageOverflow: number;
};
type Snapshot = {
  workers: Array<{
    ready: boolean;
    pongs: number;
    errors: string[];
    destroyPosts: number;
    terminations: number;
    snapshotPosts: WorkerRecord['snapshotPosts'];
    snapshotArrivals: WorkerRecord['snapshotArrivals'];
    events: WorkerProbeEvent[];
    overflow: number;
  }>;
  workerOverflow: number;
  sourceBound: boolean;
  workerActive: boolean;
  workerPresent: boolean;
  fallbackInProgress: boolean;
  fallbackRecoveryFailed: boolean;
  mainFrames: number;
  fallbackReasons: string[];
  managerSnapshotStartedAtMs: number | null;
  acceptedSnapshots: AcceptedSnapshot[];
  transitionError: string | null;
  transitionIngress: string[];
  transitionAtMs: number | null;
  canvasCount: number;
  active: Array<{ id: string; text: string; startTime: number }>;
  pending: Array<{ id: string; text: string }>;
  draws: Draw[];
  drawOverflow: number;
  textDraws: string[];
  textOverflow: number;
  imageLoads: ContinuityState['imageLoads'];
  imageOverflow: number;
  liveIds: string[];
  timeOrigin: number;
};

declare global {
  interface Window {
    __ytRecoveryContinuity?: ContinuityState;
  }
}

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Attach only after the exact packaged Worker runtime created its renderer. */
function attachContinuityWorkerProbe(renderer: {
  activeMessages: Array<{ id: string }>;
  pendingQueue: Array<{ id: string }>;
}) {
  if (!renderer || !Array.isArray(renderer.activeMessages) || !Array.isArray(renderer.pendingQueue))
    throw new Error('Packaged Worker renderer shape changed');
  const nativePost = self.postMessage.bind(self);
  let armed = false;
  let held: unknown = null;
  const report = (event: Omit<WorkerProbeEvent, 'atMs'>) =>
    nativePost({ type: 'continuityProbe', ...event, atMs: performance.now() });
  self.postMessage = ((message: unknown, ...transfer: unknown[]) => {
    if (
      armed &&
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'messageSnapshot'
    ) {
      if (held !== null) throw new Error('Native Worker produced duplicate held snapshots');
      held = message;
      const value = message as unknown as {
        requestId: number;
        epoch: number;
        activeMessageIds: string[];
        pendingMessageIds: string[];
        processedBatchSequence: number;
        motionSnapshot?: { activeMotions: Motion[] };
      };
      report({
        phase: 'held',
        requestId: value.requestId,
        epoch: value.epoch,
        processedBatchSequence: value.processedBatchSequence,
        activeIds: value.activeMessageIds.slice(0, 64),
        pendingIds: value.pendingMessageIds.slice(0, 64),
        ...(value.motionSnapshot && {
          motions: value.motionSnapshot.activeMotions
            .slice(0, 64)
            .map(({ id, startEpochMs, durationMs }) => ({ id, startEpochMs, durationMs })),
        }),
      });
      return;
    }
    Reflect.apply(nativePost, self, [message, ...transfer]);
  }) as typeof self.postMessage;
  self.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      !data ||
      typeof data !== 'object' ||
      !('type' in data) ||
      data.type !== 'continuityCommand' ||
      !('phase' in data)
    )
      return;
    if (data.phase === 'inspect') {
      report({
        phase: 'inspection',
        activeIds: renderer.activeMessages.map((message) => message.id).slice(0, 64),
        pendingIds: renderer.pendingQueue.map((message) => message.id).slice(0, 64),
      });
      return;
    }
    if (data.phase === 'hold') {
      if (armed) throw new Error('Native Worker snapshot hold was repeated');
      armed = true;
      report({ phase: 'armed' });
      return;
    }
    if (data.phase === 'crash') {
      if (!armed || held !== null) throw new Error('Worker crash command was out of order');
      // This uncaught Worker error reaches the installed manager's real onerror.
      throw new Error('windows-continuity-worker-runtime-error');
    }
    if (data.phase === 'release') {
      if (!held) {
        report({ phase: 'probe-error', error: 'Release without native snapshot' });
        return;
      }
      const snapshot = held;
      held = null;
      armed = false;
      nativePost(snapshot);
      report({ phase: 'released' });
    }
  });
  report({ phase: 'attached' });
}

function installPagePrelude({
  probeSource,
  imagePrefix,
  maxEvents,
}: {
  probeSource: string;
  imagePrefix: string;
  maxEvents: number;
}): void {
  const state: ContinuityState = {
    workers: [],
    workerOverflow: 0,
    workerSource: null,
    renderer: null,
    sourceBound: false,
    mainFrames: 0,
    fallbackReasons: [],
    managerSnapshotStartedAtMs: null,
    acceptedSnapshots: [],
    heldCallback: null,
    transitionError: null,
    transitionIngress: [],
    transitionAtMs: null,
    draws: [],
    drawOverflow: 0,
    textDraws: [],
    textOverflow: 0,
    imageLoads: [],
    imageOverflow: 0,
  };
  window.__ytRecoveryContinuity = state;
  // This isolated fixture supplies playback eligibility, not player evidence.
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
        if (
          !match ||
          parts[0].length > 262_144 ||
          (state.workerSource !== null && state.workerSource !== parts[0])
        )
          throw new Error('Packaged Worker source changed');
        state.workerSource = parts[0];
        return Reflect.construct(target, [
          [parts[0], `\n;(${probeSource})(${match[2]});\n`],
          options,
        ]);
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
        ready: false,
        pongs: 0,
        errors: [],
        destroyPosts: 0,
        terminations: 0,
        snapshotPosts: [],
        snapshotArrivals: [],
        events: [],
        overflow: 0,
      };
      if (state.workers.length < 3) state.workers.push(record);
      else state.workerOverflow++;
      const post = worker.postMessage.bind(worker);
      worker.postMessage = ((message: unknown, ...transfer: unknown[]) => {
        if (typeof message === 'object' && message !== null && 'type' in message) {
          if (message.type === 'destroy') record.destroyPosts++;
          if (message.type === 'snapshotMessages') {
            if (record.snapshotPosts.length < 4)
              record.snapshotPosts.push({
                requestId: Number('requestId' in message ? message.requestId : NaN),
                epoch: Number('epoch' in message ? message.epoch : NaN),
                atMs: performance.now(),
              });
            else record.overflow++;
          }
        }
        Reflect.apply(post, worker, [message, ...transfer]);
      }) as typeof worker.postMessage;
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => {
        record.terminations++;
        terminate();
      };
      worker.addEventListener('error', (event: ErrorEvent) => {
        if (record.errors.length < 4) record.errors.push(event.message.slice(0, 180));
        else record.overflow++;
      });
      worker.addEventListener('message', (event: MessageEvent) => {
        if (event.data?.type === 'ready') record.ready = true;
        if (event.data?.type === 'pong') record.pongs++;
        if (event.data?.type === 'messageSnapshot') {
          if (record.snapshotArrivals.length < 4)
            record.snapshotArrivals.push({
              requestId: Number(event.data.requestId),
              epoch: Number(event.data.epoch),
              atMs: performance.now(),
            });
          else record.overflow++;
        }
        if (event.data?.type !== 'continuityProbe') return;
        const entry = event.data as WorkerProbeEvent;
        if (record.events.length < maxEvents) record.events.push(entry);
        else record.overflow++;
        if (entry.phase === 'held' && state.heldCallback) {
          try {
            state.heldCallback();
          } catch (error) {
            state.transitionError = String(error).slice(0, 500);
            // An error here deliberately leaves the actual snapshot held;
            // the manager's bounded timeout must still retire its request.
          }
        }
      });
      return worker;
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
        this.addEventListener(
          'load',
          () => {
            const entry = {
              url,
              currentSrc: this.currentSrc,
              width: this.naturalWidth,
              height: this.naturalHeight,
            };
            if (state.imageLoads.length < maxEvents) state.imageLoads.push(entry);
            else state.imageOverflow++;
          },
          { once: true }
        );
      }
      Reflect.apply(nativeSetSrc, this, [value]);
    },
  });
  const derivedUrls = new WeakMap<object, string>();
  const sourceUrl = (image: CanvasImageSource): string | null => {
    if (image instanceof HTMLImageElement) return image.currentSrc || image.src;
    return typeof image === 'object' && image !== null ? (derivedUrls.get(image) ?? null) : null;
  };
  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
    const proto = OffscreenCanvasRenderingContext2D.prototype;
    const draw = proto.drawImage;
    proto.drawImage = function (image: CanvasImageSource, ...args: number[]): void {
      Reflect.apply(draw, this, [image, ...args]);
      const url = sourceUrl(image);
      if (url?.startsWith(imagePrefix)) derivedUrls.set(this.canvas, url);
    };
  }
  const canvas = CanvasRenderingContext2D.prototype;
  const draw = canvas.drawImage;
  canvas.drawImage = function (image: CanvasImageSource, ...args: number[]): void {
    const url = sourceUrl(image);
    const overlay = this.canvas.closest('#yt-live-chat-overlay') !== null;
    if (!url?.startsWith(imagePrefix) || !overlay) {
      Reflect.apply(draw, this, [image, ...args]);
      if (url?.startsWith(imagePrefix)) derivedUrls.set(this.canvas, url);
      return;
    }
    const width =
      image instanceof HTMLImageElement
        ? image.naturalWidth
        : image instanceof HTMLCanvasElement || image instanceof OffscreenCanvas
          ? image.width
          : 0;
    const height =
      image instanceof HTMLImageElement
        ? image.naturalHeight
        : image instanceof HTMLCanvasElement || image instanceof OffscreenCanvas
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
    let before: number[] | null = null;
    let after: number[] | null = null;
    let pixelError: string | null = null;
    let point: { x: number; y: number } | null = null;
    if (destination.length === 4 && destination.every((value) => typeof value === 'number')) {
      const [dx = 0, dy = 0, dw = 0, dh = 0] = destination;
      const transform = this.getTransform();
      const cx = dx + dw / 2;
      const cy = dy + dh / 2;
      const x = Math.floor(transform.a * cx + transform.c * cy + transform.e);
      const y = Math.floor(transform.b * cx + transform.d * cy + transform.f);
      if (x >= 0 && y >= 0 && x < this.canvas.width && y < this.canvas.height) {
        point = { x, y };
        try {
          before = Array.from(this.getImageData(x, y, 1, 1).data);
        } catch (error) {
          pixelError = String(error).slice(0, 160);
        }
      }
    }
    Reflect.apply(draw, this, [image, ...args]);
    if (point && before) {
      try {
        after = Array.from(this.getImageData(point.x, point.y, 1, 1).data);
      } catch (error) {
        pixelError = String(error).slice(0, 160);
      }
    }
    const observation = {
      url,
      before,
      after,
      pixelError,
      pixelChanged:
        before !== null && after !== null && after.some((value, index) => value !== before[index]),
    };
    const previousIndex = state.draws.findIndex((entry) => entry.url === url);
    if (previousIndex >= 0) {
      if (!state.draws[previousIndex]?.pixelChanged) state.draws[previousIndex] = observation;
    } else if (state.draws.length < maxEvents) state.draws.push(observation);
    else state.drawOverflow++;
  };
  const nativeFill = canvas.fillText;
  canvas.fillText = function (text: string, x: number, y: number, maxWidth?: number): void {
    Reflect.apply(nativeFill, this, maxWidth === undefined ? [text, x, y] : [text, x, y, maxWidth]);
    if (
      this.canvas.closest('#yt-live-chat-overlay') === null ||
      !text.includes('WIN306_') ||
      state.textDraws.includes(text)
    )
      return;
    if (state.textDraws.length < maxEvents) state.textDraws.push(text.slice(0, 120));
    else state.textOverflow++;
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
    currentVideoEndpoint: { watchEndpoint: { videoId: 'windowsRecoveryContinuity' } },
    contents: {
      twoColumnWatchNextResults: {
        conversationBar: {
          liveChatRenderer: {
            isReplay: false,
            continuations: [
              {
                timedContinuationData: {
                  continuation: 'windows-continuity-live',
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

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const state = window.__ytRecoveryContinuity;
    if (!state) throw new Error('Continuity page prelude disappeared');
    const renderer = state.renderer;
    return {
      workers: state.workers.map((record) => ({
        ready: record.ready,
        pongs: record.pongs,
        errors: [...record.errors],
        destroyPosts: record.destroyPosts,
        terminations: record.terminations,
        snapshotPosts: [...record.snapshotPosts],
        snapshotArrivals: [...record.snapshotArrivals],
        events: [...record.events],
        overflow: record.overflow,
      })),
      workerOverflow: state.workerOverflow,
      sourceBound: state.sourceBound,
      workerActive: renderer?.workerManager.isActive ?? false,
      workerPresent: Boolean(renderer && renderer.workerManager.workerRef !== null),
      fallbackInProgress: renderer?.fallbackInProgress ?? false,
      fallbackRecoveryFailed: renderer?.fallbackRecoveryFailed ?? false,
      mainFrames: state.mainFrames,
      fallbackReasons: [...state.fallbackReasons],
      managerSnapshotStartedAtMs: state.managerSnapshotStartedAtMs,
      acceptedSnapshots: [...state.acceptedSnapshots],
      transitionError: state.transitionError,
      transitionIngress: [...state.transitionIngress],
      transitionAtMs: state.transitionAtMs,
      canvasCount: document.querySelectorAll('#yt-live-chat-overlay canvas').length,
      active:
        renderer?.activeMessages.map((entry) => ({
          id: entry.message.id ?? '',
          text: entry.message.text,
          startTime: entry.startTime,
        })) ?? [],
      pending:
        renderer?.pendingQueue.toArray().map((entry) => ({
          id: entry.id ?? '',
          text: entry.text,
        })) ?? [],
      draws: [...state.draws],
      drawOverflow: state.drawOverflow,
      textDraws: [...state.textDraws],
      textOverflow: state.textOverflow,
      imageLoads: [...state.imageLoads],
      imageOverflow: state.imageOverflow,
      liveIds: Array.from(
        document.querySelectorAll('#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p'),
        (node) => node.getAttribute('data-message-id') ?? ''
      ).slice(-64),
      timeOrigin: performance.timeOrigin,
    };
  });
}

function appendDomControl(page: Page): Promise<void> {
  return page.evaluate(() => {
    const items = document.querySelector('yt-live-chat-item-list-renderer #items');
    if (!items) throw new Error('Owned chat DOM is unavailable');
    const renderer = document.createElement('yt-live-chat-text-message-renderer');
    renderer.id = 'windows-continuity-source-control';
    const author = document.createElement('span');
    author.id = 'author-name';
    author.textContent = 'Fixture control';
    const message = document.createElement('span');
    message.id = 'message';
    message.textContent = 'Native continuity source control';
    renderer.append(author, message);
    items.append(renderer);
  });
}

/** Installed Worker runtime error followed by the real bounded snapshot recovery path. */
export async function runRecoveryContinuityFixture({
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
  const pageSource = await readFile(join(root, 'dist-extension/page-script.js'), 'utf8');
  const workerSource = await readFile(join(root, 'dist-extension/workers/renderer.js'), 'utf8');
  assert.equal(pageSource.split(ENTRY_MARKER).length, 2);
  assert(pageSource.includes('var CanvasRenderer = class CanvasRenderer'));
  const instrumented = pageSource.replace(
    ENTRY_MARKER,
    `\n\tconst continuityState = window.__ytRecoveryContinuity;\n` +
      `\tif (!continuityState) throw new Error('Continuity prelude missing');\n` +
      `\tcontinuityState.sourceBound = true;\n` +
      `\tconst originalContinuityAdd = CanvasRenderer.prototype.addMessage;\n` +
      `\tCanvasRenderer.prototype.addMessage = function(message) {\n` +
      `\t\tcontinuityState.renderer = this;\n` +
      `\t\treturn originalContinuityAdd.call(this, message);\n` +
      `\t};\n` +
      `\tconst originalContinuityFallback = CanvasRenderer.prototype.fallbackToMainThread;\n` +
      `\tCanvasRenderer.prototype.fallbackToMainThread = function(reason) {\n` +
      `\t\tcontinuityState.fallbackReasons.push(reason);\n` +
      `\t\tconst manager = this.workerManager;\n` +
      `\t\tconst originalSnapshotMessages = manager.snapshotMessages;\n` +
      `\t\tconst originalTakeSnapshotMessages = manager.takeSnapshotMessages;\n` +
      `\t\tif (typeof originalSnapshotMessages !== 'function' || typeof originalTakeSnapshotMessages !== 'function') throw new Error('Packaged manager snapshot seam changed');\n` +
      `\t\tmanager.snapshotMessages = function(...args) {\n` +
      `\t\t\tcontinuityState.managerSnapshotStartedAtMs = performance.now();\n` +
      `\t\t\treturn originalSnapshotMessages.apply(this, args);\n` +
      `\t\t};\n` +
      `\t\tmanager.takeSnapshotMessages = function(...args) {\n` +
      `\t\t\tconst messages = originalTakeSnapshotMessages.apply(this, args);\n` +
      `\t\t\tcontinuityState.acceptedSnapshots.push({\n` +
      `\t\t\t\tatMs: performance.now(), activeIds: [...args[0]], pendingIds: [...args[1]],\n` +
      `\t\t\t\tprocessedBatchSequence: args[2], epoch: args[5],\n` +
      `\t\t\t\tmessages: messages.map((entry) => ({ id: entry.message.id, activeMotionStartEpochMs: entry.activeMotion?.startEpochMs ?? null })),\n` +
      `\t\t\t});\n` +
      `\t\t\treturn messages;\n` +
      `\t\t};\n` +
      `\t\treturn originalContinuityFallback.call(this, reason);\n` +
      `\t};\n` +
      `\tconst originalContinuityFrame = CanvasRenderer.prototype.renderFrame;\n` +
      `\tCanvasRenderer.prototype.renderFrame = function(...args) {\n` +
      `\t\tif (!this.workerManager.isActive) continuityState.mainFrames++;\n` +
      `\t\treturn originalContinuityFrame.apply(this, args);\n` +
      `\t};${ENTRY_MARKER}`
  );
  const preview = await readFile(join(root, 'test/visual/preview.html'), 'utf8');
  const html = buildVisibleWatchHtml(preview, 'Worker continuity fixture video').replace(
    '<div id="chat">',
    '<div id="chat" class="ytd-live-chat-frame" style="min-height:1px">'
  );
  const page = await context.newPage();
  const routeCounts = { document: 0, chat: 0, old: 0, newer: 0, avatar: 0, sticker: 0 };
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  let errorOverflow = 0;
  let routeRegistered = false;
  let contextRouteRegistered = false;
  let probe: NativePageScriptProbe | undefined;
  let probeProvenance: NativePageScriptProbe['provenance'] | null = null;
  let originalSettings:
    | ReturnType<NonNullable<Window['__ytChatOverlay']>['getSettings']>
    | undefined;
  let primaryError: unknown;
  let scenarioError: unknown;
  let result: Record<string, unknown> | undefined;
  let current: Snapshot | null = null;
  const states: Snapshot[] = [];
  const cleanup: Record<string, unknown> = {};
  page.on('pageerror', (error) => {
    if (pageErrors.length < 10) pageErrors.push(errorText(error).slice(0, 200));
    else errorOverflow++;
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (consoleErrors.length < 10) consoleErrors.push(message.text().slice(0, 200));
    else errorOverflow++;
  });
  const route = (request: Route) => {
    const url = new URL(request.request().url());
    if (url.protocol === 'chrome-extension:' && url.hostname === extensionId)
      return request.continue();
    if (url.href === FIXTURE_URL && request.request().resourceType() === 'document') {
      routeCounts.document++;
      return request.fulfill({ status: 200, contentType: 'text/html', body: html });
    }
    if (url.href.startsWith(IMAGE_PREFIX) && url.pathname.endsWith('.png')) {
      const key =
        url.href === OLD_URL
          ? 'old'
          : url.href === NEW_URL
            ? 'newer'
            : url.href === AVATAR_URL
              ? 'avatar'
              : url.href === STICKER_URL
                ? 'sticker'
                : null;
      if (key === null) return request.fulfill({ status: 403, body: 'Unknown fixture image' });
      routeCounts[key]++;
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
    ) {
      routeCounts.chat++;
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
                    continuation: 'windows-continuity-next',
                    timeoutMs: 30_000,
                  },
                },
              ],
            },
          },
        },
      });
    }
    return request.fulfill({ status: 403, body: 'Blocked by continuity fixture' });
  };
  try {
    await context.route('**/windows-continuity-*.png', route);
    contextRouteRegistered = true;
    await page.route('**/*', route);
    routeRegistered = true;
    await page.addInitScript(installPagePrelude, {
      probeSource: attachContinuityWorkerProbe.toString(),
      imagePrefix: IMAGE_PREFIX,
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
    await page.waitForFunction(() => Boolean(window.__ytChatOverlay?.getSettings), undefined, {
      timeout: 15_000,
    });
    originalSettings = await page.evaluate(() => {
      const app = window.__ytChatOverlay;
      if (!app) throw new Error('Installed app disappeared');
      const settings = structuredClone(app.getSettings());
      app.applySettings({
        danmakuMode: 'top',
        topBottomDurationMs: 4_000,
        maxConcurrentMessages: 30,
        authorRateLimit: 'off',
        allowShortTextMessages: true,
        translationEnabled: false,
        depthLayersEnabled: false,
        outline: { ...settings.outline, enabled: false },
        showAuthor: { ...settings.showAuthor, normal: true, superChat: true },
      });
      return settings;
    });
    await appendDomControl(page);
    await page.waitForFunction(
      () => {
        const state = window.__ytRecoveryContinuity;
        const renderer = state?.renderer;
        return (
          state?.sourceBound &&
          renderer?.workerManager.isActive === true &&
          renderer.workerManager.workerRef !== null &&
          renderer.settings.maxConcurrentMessages === 30 &&
          renderer.settings.danmakuMode === 'top' &&
          renderer.settings.outline.enabled === false &&
          state.workers.some(
            (worker) =>
              worker.worker === renderer.workerManager.workerRef &&
              worker.ready &&
              worker.pongs > 0 &&
              worker.events.some((event) => event.phase === 'attached')
          )
        );
      },
      undefined,
      { timeout: 15_000 }
    );
    const workerSha = await page.evaluate(async () => {
      const bundled = window.__ytRecoveryContinuity?.workerSource;
      if (!bundled) throw new Error('Installed Worker Blob was not captured');
      return Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bundled))),
        (byte) => byte.toString(16).padStart(2, '0')
      ).join('');
    });
    assert.equal(workerSha, sha256(workerSource), 'Installed Worker prefix differs from package');
    const initial = await snapshot(page);
    states.push(initial);
    assert.equal(initial.fallbackReasons.length, 0);
    assert.equal(initial.canvasCount, 1);
    assert.equal(initial.workerOverflow, 0);

    await page.evaluate(
      ({ controlId, targetId, futureId, fillerCount, oldUrl }) => {
        const state = window.__ytRecoveryContinuity;
        const renderer = state?.renderer;
        if (!renderer?.workerManager.isActive || !renderer.workerManager.workerRef)
          throw new Error('Healthy packaged Worker is not current');
        const text = (id: string, value: string): ChatMessage => ({
          id,
          text: value,
          content: [{ type: 'text', content: value }],
          kind: 'text',
          timestamp: Date.now(),
          author: id,
          authorType: 'normal',
          actionType: 'add',
        });
        renderer.addMessage(text(controlId, 'WIN306_CONTROL'));
        renderer.addMessage({
          ...text(targetId, 'WIN306_OLD'),
          content: [
            { type: 'text', content: 'WIN306_OLD' },
            { type: 'emoji', emoji: { url: oldUrl, alt: 'old', fallbackText: ':old:' } },
          ],
        });
        for (let index = 0; index < fillerCount; index++)
          renderer.addMessage(text(`windows-continuity-filler-${index}`, `FILLER_${index}`));
        renderer.addMessage(text(futureId, 'WIN306_FUTURE'));
      },
      {
        controlId: CONTROL_ID,
        targetId: TARGET_ID,
        futureId: FUTURE_ID,
        fillerCount: FILLER_COUNT,
        oldUrl: OLD_URL,
      }
    );
    await page.evaluate(async () => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const state = window.__ytRecoveryContinuity;
        const worker = state?.renderer?.workerManager.workerRef;
        if (!worker || !state.renderer?.workerManager.isActive)
          throw new Error('Current Worker disappeared while establishing ownership');
        worker.postMessage({ type: 'continuityCommand', phase: 'inspect' });
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        if (
          state.workers.some((record) =>
            record.events.some(
              (event) =>
                event.phase === 'inspection' &&
                event.activeIds?.includes('windows-continuity-target') &&
                event.activeIds?.includes('windows-continuity-control') &&
                event.pendingIds?.includes('windows-continuity-future')
            )
          )
        )
          return;
      }
      throw new Error('Packaged Worker did not own active and pending fixture messages');
    });
    const workerOwned = await snapshot(page);
    states.push(workerOwned);
    assert.equal(workerOwned.workerActive, true);
    assert.equal(workerOwned.fallbackReasons.length, 0);
    assert(routeCounts.old > 0, 'Worker never requested the old active image');

    await page.evaluate(
      ({ targetId, paidId, newUrl, avatarUrl, stickerUrl }) => {
        const state = window.__ytRecoveryContinuity;
        const renderer = state?.renderer;
        const worker = renderer?.workerManager.workerRef;
        if (!state || !renderer || !worker) throw new Error('Worker transition prerequisite lost');
        state.heldCallback = () => {
          if (
            !renderer.fallbackInProgress ||
            renderer.workerManager.isActive ||
            renderer.workerManager.workerRef !== worker
          )
            throw new Error('Actual fallback did not own the held snapshot');
          state.transitionAtMs = performance.now();
          const replacement: ChatMessage = {
            id: targetId,
            text: 'WIN306_NEW',
            content: [
              { type: 'text', content: 'WIN306_NEW' },
              { type: 'emoji', emoji: { url: newUrl, alt: 'new', fallbackText: ':new:' } },
            ],
            kind: 'text',
            timestamp: Date.now(),
            author: 'Replacement',
            authorType: 'normal',
            authorPhotoUrl: avatarUrl,
            actionType: 'replace',
          };
          const paid: ChatMessage = {
            id: paidId,
            text: 'WIN306_PAID',
            content: [{ type: 'text', content: 'WIN306_PAID' }],
            kind: 'superchat',
            timestamp: Date.now(),
            author: 'Paid donor',
            authorType: 'normal',
            authorPhotoUrl: avatarUrl,
            superChat: {
              amount: '5.00',
              tier: 'blue',
              sticker: { url: stickerUrl, alt: 'sticker' },
            },
            actionType: 'add',
          };
          renderer.addMessage(replacement);
          renderer.addMessage(paid);
          state.transitionIngress.push(targetId, paidId);
          worker.postMessage({ type: 'continuityCommand', phase: 'release' });
          state.heldCallback = null;
        };
        worker.postMessage({ type: 'continuityCommand', phase: 'hold' });
      },
      {
        targetId: TARGET_ID,
        paidId: PAID_ID,
        newUrl: NEW_URL,
        avatarUrl: AVATAR_URL,
        stickerUrl: STICKER_URL,
      }
    );
    await page.waitForFunction(
      () =>
        window.__ytRecoveryContinuity?.workers.some((worker) =>
          worker.events.some((event) => event.phase === 'armed')
        ) === true,
      undefined,
      { timeout: 5_000 }
    );
    await page.evaluate(() => {
      const state = window.__ytRecoveryContinuity;
      const worker = state?.renderer?.workerManager.workerRef;
      if (!worker) throw new Error('Current Worker disappeared before error');
      worker.postMessage({ type: 'continuityCommand', phase: 'crash' });
    });
    await page.waitForFunction(
      () => {
        const state = window.__ytRecoveryContinuity;
        return (
          state?.transitionError !== null ||
          (state?.fallbackReasons.length === 1 &&
            state.workers.some((worker) => worker.events.some((event) => event.phase === 'held')) &&
            state.workers.some((worker) =>
              worker.events.some((event) => event.phase === 'released')
            ) &&
            state.acceptedSnapshots.length === 1)
        );
      },
      undefined,
      { timeout: 6_000 }
    );
    const held = await snapshot(page);
    states.push(held);
    assert.equal(held.transitionError, null, 'Transition injection failed');
    assert.deepEqual(held.fallbackReasons, ['worker-load-error']);
    assert(
      held.workers.some(
        (worker) => worker.errors.length === 1 && worker.errors[0]?.includes(ERROR_MARKER)
      ),
      'Actual Worker error was not observed'
    );
    assert.deepEqual(held.transitionIngress, [TARGET_ID, PAID_ID]);
    const nativeHeld = held.workers
      .flatMap((worker) => worker.events)
      .find((event) => event.phase === 'held');
    const nativeReleased = held.workers
      .flatMap((worker) => worker.events)
      .find((event) => event.phase === 'released');
    const nativeWorker = held.workers.find((worker) =>
      worker.events.some((event) => event.phase === 'held')
    );
    assert(nativeHeld && nativeReleased, 'Actual Worker snapshot was not held and released');
    assert(nativeWorker, 'Snapshot did not belong to an observed packaged Worker');
    assert(nativeHeld.activeIds?.includes(CONTROL_ID));
    assert(nativeHeld.activeIds?.includes(TARGET_ID));
    assert(nativeHeld.pendingIds?.includes(FUTURE_ID));
    assert(nativeHeld.motions?.some((motion) => motion.id === CONTROL_ID));
    assert(Number.isSafeInteger(nativeHeld.requestId) && (nativeHeld.requestId ?? 0) > 0);
    assert(Number.isSafeInteger(nativeHeld.epoch) && (nativeHeld.epoch ?? -1) >= 0);
    const requestPost = nativeWorker.snapshotPosts.find(
      (entry) => entry.requestId === nativeHeld.requestId && entry.epoch === nativeHeld.epoch
    );
    const nativeArrival = nativeWorker.snapshotArrivals.find(
      (entry) => entry.requestId === nativeHeld.requestId && entry.epoch === nativeHeld.epoch
    );
    const accepted = held.acceptedSnapshots[0];
    const snapshotStartedAtMs = held.managerSnapshotStartedAtMs;
    assert(
      requestPost && nativeArrival && accepted && snapshotStartedAtMs !== null,
      'Packaged manager did not request, receive, and accept the same Worker snapshot'
    );
    assert.equal(nativeWorker.snapshotPosts.length, 1);
    assert.equal(nativeWorker.snapshotArrivals.length, 1);
    assert.equal(held.acceptedSnapshots.length, 1);
    assert(snapshotStartedAtMs <= requestPost.atMs && requestPost.atMs <= nativeArrival.atMs);
    assert(requestPost.atMs <= accepted.atMs);
    assert(
      nativeArrival.atMs - snapshotStartedAtMs < 250,
      'Native response arrived after the manager snapshot deadline'
    );
    assert(
      accepted.atMs - snapshotStartedAtMs < 250,
      'Packaged manager accepted the Worker snapshot after its deadline'
    );
    assert.deepEqual(accepted.activeIds, nativeHeld.activeIds);
    assert.deepEqual(accepted.pendingIds, nativeHeld.pendingIds);
    assert.equal(accepted.processedBatchSequence, nativeHeld.processedBatchSequence);
    assert.equal(accepted.epoch, nativeHeld.epoch);
    assert(
      accepted.messages.some(
        (entry) =>
          entry.id === CONTROL_ID &&
          entry.activeMotionStartEpochMs ===
            nativeHeld.motions?.find((motion) => motion.id === CONTROL_ID)?.startEpochMs
      ),
      'Manager did not use the native active-motion snapshot'
    );
    assert(
      accepted.messages.some((entry) => entry.id === FUTURE_ID),
      'Manager did not accept the native pending snapshot'
    );
    assert(
      nativeReleased.atMs - nativeHeld.atMs < 250,
      'Held Worker snapshot release took too long'
    );

    await page.waitForFunction(
      () => {
        const state = window.__ytRecoveryContinuity;
        const renderer = state?.renderer;
        return (
          renderer &&
          !renderer.fallbackInProgress &&
          !renderer.fallbackRecoveryFailed &&
          !renderer.workerManager.isActive &&
          renderer.workerManager.workerRef === null &&
          state.mainFrames > 0 &&
          renderer.canvas?.isConnected === true &&
          renderer.activeMessages.some((entry) => entry.message.id === 'windows-continuity-control')
        );
      },
      undefined,
      { timeout: 8_000 }
    );
    const recovered = await snapshot(page);
    states.push(recovered);
    assert.equal(recovered.canvasCount, 1);
    assert.equal(recovered.workerPresent, false);
    assert.equal(recovered.workerActive, false);
    assert.equal(recovered.fallbackRecoveryFailed, false);
    assert.equal(recovered.active.filter((entry) => entry.id === CONTROL_ID).length, 1);
    const control = recovered.active.find((entry) => entry.id === CONTROL_ID);
    const motion = nativeHeld.motions?.find((entry) => entry.id === CONTROL_ID);
    assert(control && motion);
    assert(
      Math.abs(control.startTime + recovered.timeOrigin - motion.startEpochMs) < 500,
      'Validated active motion lost its original timeline'
    );
    assert.equal(
      recovered.active.filter((entry) => entry.id === TARGET_ID && entry.text === 'WIN306_OLD')
        .length,
      0,
      'Old same-ID snapshot won'
    );
    assert.equal(
      recovered.pending.filter((entry) => entry.id === TARGET_ID && entry.text === 'WIN306_OLD')
        .length,
      0
    );
    assert(
      [...recovered.active, ...recovered.pending].some(
        (entry) => entry.id === TARGET_ID && entry.text === 'WIN306_NEW'
      )
    );
    assert(
      [...recovered.active, ...recovered.pending].some((entry) => entry.id === FUTURE_ID),
      'Worker future message was lost during fallback'
    );

    await page.waitForFunction(
      ({ newUrl, avatarUrl, stickerUrl }) => {
        const state = window.__ytRecoveryContinuity;
        if (!state) return false;
        const drawn = (url: string) =>
          state.draws.some(
            (entry) => entry.url === url && entry.pixelChanged && entry.pixelError === null
          );
        return (
          state.textDraws.some((text) => text.includes('WIN306_NEW')) &&
          state.textDraws.some((text) => text.includes('WIN306_PAID')) &&
          state.textDraws.some((text) => text.includes('WIN306_FUTURE')) &&
          drawn(newUrl) &&
          drawn(avatarUrl) &&
          drawn(stickerUrl)
        );
      },
      { newUrl: NEW_URL, avatarUrl: AVATAR_URL, stickerUrl: STICKER_URL },
      { timeout: 25_000 }
    );
    const final = await snapshot(page);
    states.push(final);
    assert.equal(final.transitionError, null);
    assert.equal(final.drawOverflow, 0);
    assert.equal(final.textOverflow, 0);
    assert.equal(final.imageOverflow, 0);
    assert.equal(final.workerOverflow, 0);
    assert(final.workers.every((worker) => worker.overflow === 0));
    assert.equal(
      final.draws.some((draw) => draw.url === OLD_URL),
      false,
      'Retired image was drawn by Main after same-ID replacement'
    );
    assert.equal(
      final.textDraws.some((text) => text.includes('WIN306_OLD')),
      false
    );
    assert(
      final.imageLoads.some(
        (image) =>
          image.url === NEW_URL &&
          image.currentSrc === NEW_URL &&
          image.width === 4 &&
          image.height === 4
      )
    );
    assert(final.imageLoads.some((image) => image.url === AVATAR_URL && image.width === 4));
    assert(final.imageLoads.some((image) => image.url === STICKER_URL && image.width === 4));
    assert(routeCounts.newer > 0 && routeCounts.avatar > 0 && routeCounts.sticker > 0);
    assert.equal(final.fallbackReasons.length, 1);
    assert(final.workers.some((worker) => worker.destroyPosts === 1 && worker.terminations === 1));
    assert.equal(routeCounts.document, 1);
    assert(routeCounts.chat > 0);
    assert.equal(errorOverflow, 0);
    assert(
      pageErrors.every((error) => error.includes(ERROR_MARKER)),
      'Unexpected page error during Worker fallback'
    );
    assert(
      consoleErrors.every((error) => error.includes(ERROR_MARKER)),
      'Unexpected console error during Worker fallback'
    );
    result = {
      status: 'passed',
      scope:
        'installed Chrome extension Worker runtime error; actual bounded snapshot and Main fallback with current ingress and image draws',
      fixtureUrl: FIXTURE_URL,
      probeProvenance,
      workerSha,
      routeCounts,
      states,
      pageErrors,
      consoleErrors,
      errorOverflow,
      limitations: [
        'fixture-created Worker error, not physical GPU failure',
        'one timely native snapshot; delayed and malformed variants retain module evidence',
        'player playback supplied as a prerequisite, not player acceptance',
      ],
    };
  } catch (error) {
    primaryError = error;
    scenarioError = error;
    try {
      current = await snapshot(page);
    } catch {
      /* Page may not have loaded. */
    }
  }
  const cleanupErrors: unknown[] = [];
  try {
    if (originalSettings) {
      cleanup.settingsRestored = await page.evaluate((settings) => {
        const app = window.__ytChatOverlay;
        if (!app) throw new Error('Installed app disappeared before settings restoration');
        app.applySettings(settings);
        return true;
      }, originalSettings);
    }
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
    if (routeRegistered) await page.unroute('**/*', route);
    cleanup.pageRouteRemoved = true;
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (contextRouteRegistered) await context.unroute('**/windows-continuity-*.png', route);
    cleanup.imageRouteRemoved = true;
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
    try {
      await writeFile(
        join(output, 'recovery-continuity-cleanup-failure.json'),
        JSON.stringify(
          {
            status: 'failed',
            primaryError: primaryError ? errorText(primaryError) : null,
            cleanup,
          },
          null,
          2
        )
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    primaryError = primaryError
      ? new AggregateError([primaryError, ...cleanupErrors], 'Continuity and cleanup failed')
      : new AggregateError(cleanupErrors, 'Continuity cleanup failed');
  }
  if (primaryError) {
    try {
      await writeFile(
        join(output, 'recovery-continuity-failure.json'),
        JSON.stringify(
          {
            status: 'failed',
            error: errorText(primaryError),
            scenarioError: scenarioError ? errorText(scenarioError) : null,
            probeProvenance,
            routeCounts,
            states,
            current,
            pageErrors,
            consoleErrors,
            errorOverflow,
            cleanup,
          },
          null,
          2
        )
      );
    } catch (error) {
      throw new AggregateError([primaryError, error], 'Continuity failure receipt write failed');
    }
    throw primaryError;
  }
  assert(result);
  result.cleanup = cleanup;
  return result;
}
