// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const FIXTURE_URL = 'https://www.youtube.com/watch?v=windows193Placement';
const TOKENS = [
  'WINDOWS193_SHORT', 'WINDOWS193_LONG', 'WINDOWS193_REVERSE',
  'WINDOWS193_REPLAY_DUE', 'WINDOWS193_REPLAY_NEXT', 'WINDOWS193_REPLAY_FUTURE',
];
const MAX_SAMPLES = 240;

function installProbeRuntime(options) {
  const MAX_SAMPLES = 240;
  const scope = globalThis;
  const ids = new Set(options.tokens);
  const bitmapIds = new WeakMap();
  const state = {
    frames: [], bounds: [], firstEntry: {}, ingress: {}, stats: [], workers: [],
    sourcePrefixed: false, sourceHooked: false, overflow: 0, ready: false, canvas: null,
    frameCount: 0, reportCount: 0,
  };
  scope.__ytPlacementProbe = state;
  const epochNow = () => performance.timeOrigin + performance.now();
  const tokenIn = (text) => options.tokens.find((token) => String(text).includes(token));
  const overlayContext = (ctx) => options.worker
    ? ctx.canvas === state.canvas
    : Boolean(ctx.canvas?.closest?.('#yt-live-chat-overlay'));
  const recordRect = (ctx, id, x, y, width, height) => {
    if (!id || !overlayContext(ctx) || width <= 0 || height <= 0) return;
    const transform = ctx.getTransform();
    const points = [[x, y], [x + width, y], [x, y + height], [x + width, y + height]]
      .map(([px, py]) => ({
        x: transform.a * px + transform.c * py + transform.e,
        y: transform.b * px + transform.d * py + transform.f,
      }));
    const bound = {
      id, atEpochMs: epochNow(),
      left: Math.min(...points.map((point) => point.x)),
      top: Math.min(...points.map((point) => point.y)),
      right: Math.max(...points.map((point) => point.x)),
      bottom: Math.max(...points.map((point) => point.y)),
    };
    if (state.bounds.length < MAX_SAMPLES) state.bounds.push(bound);
    else state.overflow++;
    const canvasWidth = ctx.canvas.width / Math.max(1, transform.a);
    const canvasHeight = ctx.canvas.height / Math.max(1, transform.d);
    if (bound.right > 0 && bound.left < canvasWidth && bound.bottom > 0 && bound.top < canvasHeight) {
      state.firstEntry[id] ??= bound.atEpochMs;
    }
  };
  const canvasPrototypes = [
    scope.CanvasRenderingContext2D?.prototype,
    scope.OffscreenCanvasRenderingContext2D?.prototype,
  ].filter(Boolean);
  for (const prototype of canvasPrototypes) {
    const nativeFillText = prototype.fillText;
    prototype.fillText = function (text, x, y, ...rest) {
      const id = tokenIn(text);
      if (id && !overlayContext(this)) bitmapIds.set(this.canvas, id);
      if (id && overlayContext(this)) {
        const metrics = this.measureText(text);
        recordRect(this, id, x, y, metrics.width, metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent);
      }
      return nativeFillText.call(this, text, x, y, ...rest);
    };
    const nativeDrawImage = prototype.drawImage;
    prototype.drawImage = function (image, ...args) {
      const id = bitmapIds.get(image);
      if (id && overlayContext(this)) {
        const destination = args.length === 2
          ? [args[0], args[1], image.width, image.height]
          : args.length === 4 ? args : args.slice(4, 8);
        if (destination.length === 4) recordRect(this, id, ...destination);
      }
      return nativeDrawImage.call(this, image, ...args);
    };
    const nativeClearRect = prototype.clearRect;
    prototype.clearRect = function (...args) {
      if (overlayContext(this) && state.currentFrame && state.currentFrame.preClearMs === null) {
        state.currentFrame.preClearMs = performance.now() - state.currentFrame.startedAt;
      }
      return nativeClearRect.call(this, ...args);
    };
  }
  const nativeRaf = scope.requestAnimationFrame.bind(scope);
  scope.requestAnimationFrame = (callback) => nativeRaf((timestamp) => {
    const frame = { startedAt: performance.now(), preClearMs: null };
    state.currentFrame = frame;
    try { callback(timestamp); }
    finally {
      if (frame.preClearMs !== null) {
        state.frameCount++;
        if (state.frames.length < MAX_SAMPLES) {
          state.frames.push({ atEpochMs: epochNow(), workMs: performance.now() - frame.startedAt,
            preClearMs: frame.preClearMs });
        } else state.overflow++;
        if (options.worker && state.frameCount % 30 === 0 && state.reportCount++ < 20) {
          scope.postMessage({ type: 'ytPlacementProbe', sample: {
            frames: state.frames, bounds: state.bounds, firstEntry: state.firstEntry,
            ingress: state.ingress, exact: state.exact, overflow: state.overflow,
          } });
        }
      }
      if (state.currentFrame === frame) state.currentFrame = null;
    }
  });
  if (options.worker) {
    scope.addEventListener('message', (event) => {
      if (event.data?.type === 'init') state.canvas = event.data.canvas;
      if (event.data?.type === 'addMessages') {
        for (const message of event.data.messages ?? []) {
          if (ids.has(message.id)) state.ingress[message.id] ??= epochNow();
        }
      }
      if (event.data?.type === 'ytPlacementFlush') {
        scope.postMessage({ type: 'ytPlacementProbe', sample: {
          frames: state.frames, bounds: state.bounds, firstEntry: state.firstEntry,
          ingress: state.ingress, exact: state.exact, overflow: state.overflow,
        } });
      }
    });
    return;
  }
  if (options.forceFallback) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
      configurable: true,
      value: () => { throw new Error('Acceptance fixture selected the Canvas fallback'); },
    });
  } else {
    const NativeBlob = scope.Blob;
    scope.Blob = new Proxy(NativeBlob, {
      construct(target, args) {
        const [parts, optionsArg] = args;
        if (optionsArg?.type === 'text/javascript' && parts?.length === 1 &&
          typeof parts[0] === 'string' && parts[0].includes('OffscreenCanvas')) {
          state.sourcePrefixed = true;
          const suffix = workerProbeSuffix(parts[0], options.attachProbeSource);
          state.sourceHooked = Boolean(suffix);
          return Reflect.construct(target, [[options.workerPrelude, parts[0], suffix ?? ''], optionsArg]);
        }
        return Reflect.construct(target, args);
      },
    });
  }
  const NativeWorker = scope.Worker;
  scope.Worker = new Proxy(NativeWorker, {
    construct(target, args) {
      const worker = Reflect.construct(target, args);
      const record = { ready: false, stats: [], sample: null, worker };
      state.workers.push(record);
      worker.addEventListener('message', (event) => {
        if (event.data?.type === 'ready') record.ready = true;
        if (event.data?.type === 'stats' && record.stats.length < 60) {
          const { activeMessages, pendingQueueDepth, totalRendered, totalDrops } = event.data;
          record.stats.push({ atEpochMs: epochNow(), activeMessages, pendingQueueDepth,
            totalRendered, totalDrops });
        }
        if (event.data?.type === 'ytPlacementProbe') record.sample = event.data.sample;
      });
      const nativePostMessage = worker.postMessage.bind(worker);
      worker.postMessage = (message, transfer) => {
        if (message?.type === 'addMessages') {
          for (const entry of message.messages ?? []) {
            if (ids.has(entry.id)) state.ingress[entry.id] ??= epochNow();
          }
        }
        if (transfer === undefined) nativePostMessage(message);
        else nativePostMessage(message, transfer);
      };
      return worker;
    },
  });
}

export function summarizeSamples(values) {
  const samples = values.filter((value) => Number.isFinite(value) && value >= 0)
    .toSorted((left, right) => left - right);
  if (samples.length === 0) return { count: 0, p50: null, p95: null, max: null };
  return { count: samples.length, p50: samples[Math.ceil(samples.length * 0.5) - 1],
    p95: samples[Math.ceil(samples.length * 0.95) - 1], max: samples.at(-1) };
}

export function workerProbePrelude(tokens = TOKENS) {
  return `;(${installProbeRuntime.toString()})(${JSON.stringify({ worker: true, tokens })});\n`;
}

// The emitted Worker is a classic Blob script. The suffix runs in its lexical
// scope, after the original onmessage assignment. Fail closed on bundle drift.
export function workerProbeSuffix(source, attachProbeSource = attachWorkerRendererProbe.toString()) {
  const handler = /self\.onmessage=([A-Za-z_$][\w$]*)=>\{([A-Za-z_$][\w$]*)\.handleMessage\(\1\)\};?\s*$/.exec(source);
  if (!handler) return null;
  return `\n;(${attachProbeSource})(${handler[2]});\n`;
}

function attachWorkerRendererProbe(renderer) {
  const state = globalThis.__ytPlacementProbe;
  if (!state || !renderer || typeof renderer.drainQueue !== 'function') return;
  const exact = { frames: [], drains: [], dispositions: [], active: [],
    collisionRejects: 0, placementMisses: 0, drops: {}, overflow: 0 };
  state.exact = exact;
  const queuedAt = new Map();
  const epochNow = () => performance.timeOrigin + performance.now();
  const bounded = (list, value) => {
    if (list.length < 240) list.push(value);
    else exact.overflow++;
  };
  const isFixture = (id) => typeof id === 'string' && id.startsWith('WINDOWS193_');
  let inEnqueue = false;
  let inDrain = false;
  const nativeEnqueue = renderer.enqueueMessage;
  renderer.enqueueMessage = function (message) {
    inEnqueue = true;
    try {
      const admitted = nativeEnqueue.call(this, message);
      if (admitted && isFixture(message.id) &&
          this.pendingQueue.some((entry) => entry.id === message.id)) {
        queuedAt.set(message.id, epochNow());
      }
      return admitted;
    } finally { inEnqueue = false; }
  };
  const nativeActivate = renderer.activateMessage;
  renderer.activateMessage = function (message, ...args) {
    const result = nativeActivate.call(this, message, ...args);
    if (isFixture(message.id)) {
      const active = this.activeMessages.find((entry) => entry.id === message.id);
      bounded(exact.dispositions, { id: message.id, kind: 'activated',
        queueResidenceMs: queuedAt.has(message.id) ? epochNow() - queuedAt.get(message.id) : null,
        atEpochMs: epochNow(), laneIndex: active?.laneIndex ?? null,
        startX: active?.startX ?? null, durationMs: active?.duration ?? null });
      queuedAt.delete(message.id);
    }
    return result;
  };
  const nativeDrop = renderer.recordDrop;
  renderer.recordDrop = function (message) {
    const reason = inEnqueue ? 'queue-capacity' : inDrain &&
      message.height > this.numLanes * this.laneHeight ? 'oversize' : 'other';
    exact.drops[reason] = (exact.drops[reason] ?? 0) + 1;
    if (isFixture(message.id)) {
      bounded(exact.dispositions, { id: message.id, kind: 'dropped', reason,
        queueResidenceMs: queuedAt.has(message.id) ? epochNow() - queuedAt.get(message.id) : null,
        atEpochMs: epochNow() });
      queuedAt.delete(message.id);
    }
    return nativeDrop.call(this, message);
  };
  const nativeCollision = renderer.checkCollision;
  renderer.checkCollision = function (...args) {
    const accepted = nativeCollision.apply(this, args);
    if (!accepted && inDrain) exact.collisionRejects++;
    return accepted;
  };
  const nativePlacement = renderer.findPlacement;
  renderer.findPlacement = function (...args) {
    const placement = nativePlacement.apply(this, args);
    if (!placement && inDrain) exact.placementMisses++;
    return placement;
  };
  const nativeDrain = renderer.drainQueue;
  renderer.drainQueue = function (...args) {
    const before = this.pendingQueue.length;
    const activeBefore = this.activeMessages.length;
    const collisionsBefore = exact.collisionRejects;
    const placementBefore = exact.placementMisses;
    const startedAt = performance.now();
    inDrain = true;
    try { return nativeDrain.apply(this, args); }
    finally {
      inDrain = false;
      bounded(exact.drains, { atEpochMs: epochNow(), workMs: performance.now() - startedAt,
        pendingBefore: before, pendingAfter: this.pendingQueue.length,
        activeBefore, activeAfter: this.activeMessages.length,
        collisionRejects: exact.collisionRejects - collisionsBefore,
        placementMisses: exact.placementMisses - placementBefore });
    }
  };
  const nativeFrame = renderer.renderFrame;
  renderer.renderFrame = function (...args) {
    const startedAt = performance.now();
    try { return nativeFrame.apply(this, args); }
    finally {
      bounded(exact.frames, { atEpochMs: epochNow(), workMs: performance.now() - startedAt });
      for (const message of this.activeMessages) {
        if (!isFixture(message.id)) continue;
        bounded(exact.active, { id: message.id, atEpochMs: epochNow(),
          x: message.x, y: message.y, width: message.width, height: message.height,
          laneIndex: message.laneIndex });
      }
    }
  };
}

function messageAction(id, text) {
  return { addChatItemAction: { item: { liveChatTextMessageRenderer: {
    id, authorName: { simpleText: 'Fixture viewer' }, message: { runs: [{ text }] },
  } } } };
}

function chatResponse(actions) {
  return { continuationContents: { liveChatContinuation: { actions, continuations: [
    { timedContinuationData: { continuation: 'windows193-next', timeoutMs: 30_000 } },
  ] } } };
}

function replayResponse(actions, continuation = 'windows193-seek') {
  return { continuationContents: { liveChatContinuation: { actions,
    continuations: [{ playerSeekContinuationData: { continuation } }],
  } } };
}

async function runScenario({ context, root, output, extensionId, forceFallback, mode }) {
  const page = await context.newPage();
  const requested = [];
  let originalSettings;
  let fixtureDelivered = false;
  let replayRequests = 0;
  const replay = mode === 'replay';
  const replayObservations = {};
  const ids = replay ? TOKENS.slice(3) : mode === 'reverse' ? [TOKENS[2]] : TOKENS.slice(0, 2);
  const paidId = `windows193-paid-${mode}`;
  const actions = ids.map((id) => messageAction(id, id === TOKENS[1] ? `${id}_${'W'.repeat(100)}` : id));
  if (!replay) actions.push({ addChatItemAction: { item: { liveChatPaidMessageRenderer: {
    id: paidId, authorName: { simpleText: 'Fixture donor' },
    purchaseAmountText: { simpleText: '$5.00' },
    message: { simpleText: 'Bounded paid-card fixture' },
  } } } });
  const replayActions = replay ? [10_000, 10_001, 11_500].map((offsetMs, index) => ({
    replayChatItemAction: { videoOffsetTimeMsec: offsetMs, actions: [actions[index]] },
  })) : [];
  const preview = await readFile(join(root, 'test/visual/preview.html'), 'utf8');
  const html = preview.replace(
    '<div class="player-inner">Video Player Placeholder</div>',
    '<video aria-label="Placement fixture video" style="width:100%;height:100%"></video>',
  ).replace('</body>', '<div id="chat"><yt-live-chat-item-list-renderer><div id="items"></div></yt-live-chat-item-list-renderer></div></body>');
  assert.notEqual(html, preview, 'Placement fixture video was not installed');
  const workerPrelude = workerProbePrelude();
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'chrome-extension:' && url.hostname === extensionId) return route.continue();
      if (replay && url.hostname === 'www.youtube.com' &&
        url.pathname === '/youtubei/v1/live_chat/get_live_chat_replay') {
        replayRequests++;
        return route.fulfill({ status: 200, contentType: 'application/json',
          json: replayResponse(replayRequests === 2 ? replayActions : []) });
      }
      if (url.hostname === 'www.youtube.com' && url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat')) {
        const deliver = url.searchParams.has('windows193') && !fixtureDelivered;
        if (deliver) fixtureDelivered = true;
        return route.fulfill({ status: 200, contentType: 'application/json',
          json: chatResponse(deliver ? actions : []) });
      }
      if (url.hostname === 'www.youtube.com' && route.request().resourceType() === 'document') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: html });
      }
      return route.fulfill({ status: 403, contentType: 'text/plain', body: 'Blocked by placement fixture' });
    });
    await page.addInitScript({ content: `const workerProbeSuffix = ${workerProbeSuffix.toString()};\n;(${installProbeRuntime.toString()})(${JSON.stringify({
      worker: false, tokens: TOKENS, forceFallback, workerPrelude,
      attachProbeSource: attachWorkerRendererProbe.toString(),
    })});` });
    await page.addInitScript((isReplay) => {
      const playback = { time: 10, paused: false };
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
        configurable: true, get: () => playback.time, set: (value) => { playback.time = value; },
      });
      Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
        configurable: true, get: () => playback.paused,
      });
      window.__ytPlacementSetVideoTime = (seconds) => { playback.time = seconds; };
      window.ytcfg = { data_: { INNERTUBE_API_KEY: 'windows-acceptance-key',
        INNERTUBE_CONTEXT_CLIENT_NAME: '1', INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
        INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } } } };
      window.ytInitialData = { currentVideoEndpoint: { watchEndpoint: { videoId: 'windows193Placement' } },
        contents: { twoColumnWatchNextResults: { conversationBar: { liveChatRenderer: {
          isReplay, continuations: [isReplay
            ? { playerSeekContinuationData: { continuation: 'windows193-initial' } }
            : { timedContinuationData: { continuation: 'windows193-live', timeoutMs: 30_000 } }],
        } } } } };
    }, replay);
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('#yt-live-chat-overlay canvas').waitFor({ state: 'attached', timeout: 15_000 });
    await page.waitForFunction(() => Boolean(window.__ytChatOverlay?.getSettings), undefined,
      { timeout: 15_000 });
    originalSettings = await page.evaluate((danmakuMode) => {
      const settings = window.__ytChatOverlay.getSettings();
      window.__ytChatOverlay.applySettings({ danmakuMode,
        outline: { ...settings.outline, enabled: false }, showDebugOverlay: true });
      return { danmakuMode: settings.danmakuMode, outline: settings.outline,
        showDebugOverlay: settings.showDebugOverlay };
    }, replay ? 'scroll' : mode);
    await page.waitForFunction((worker) => {
      const status = document.querySelector('#yt-chat-overlay-debug')?.textContent ?? '';
      return status.includes('Render:') && status.includes('Render: n/a') === worker;
    }, !forceFallback, { timeout: 15_000 });
    await page.waitForTimeout(300);
    if (replay) {
      await page.waitForFunction(() => document.querySelector(
        '.yt-live-chat-overlay-live-region > p[data-message-id="WINDOWS193_REPLAY_DUE"]',
      ), undefined, { timeout: 15_000 });
      assert(replayRequests >= 2, 'Replay player-seek fixture was not requested');
      const futureAtDue = await page.locator(
        '.yt-live-chat-overlay-live-region > p[data-message-id^="WINDOWS193_REPLAY_"]',
      ).evaluateAll((elements) => elements.map((element) => element.dataset.messageId));
      replayObservations.at10000 = futureAtDue;
      assert.deepEqual(futureAtDue, [TOKENS[3]], 'A prefetched replay message appeared before video time');
      await page.evaluate(() => window.__ytPlacementSetVideoTime(10.001));
      await page.waitForFunction(() => document.querySelector(
        '.yt-live-chat-overlay-live-region > p[data-message-id="WINDOWS193_REPLAY_NEXT"]',
      ), undefined, { timeout: 10_000 });
      replayObservations.at10001 = await page.locator(
        '.yt-live-chat-overlay-live-region > p[data-message-id^="WINDOWS193_REPLAY_"]',
      ).evaluateAll((elements) => elements.map((element) => element.dataset.messageId));
      assert.deepEqual(replayObservations.at10001.toSorted(), [TOKENS[3], TOKENS[4]].toSorted(),
        'A replay message appeared before 11500ms');
      await page.evaluate(() => window.__ytPlacementSetVideoTime(11.5));
    } else {
      await page.evaluate(async () => {
        window.__ytPlacementProbe.requestAtEpochMs = performance.timeOrigin + performance.now();
        const response = await fetch('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?windows193=1', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        if (!response.ok) throw new Error('Placement fixture request failed');
        await response.json();
      });
      assert(fixtureDelivered, 'Scoped placement API fixture was not intercepted');
    }
    requested.push(...ids, ...(replay ? [] : [paidId]));
    await page.waitForFunction((expected) => expected.every((id) =>
      [...document.querySelectorAll('.yt-live-chat-overlay-live-region > p')]
        .some((element) => element.dataset.messageId === id)), requested, { timeout: 15_000 });
    if (replay) replayObservations.at11500 = await page.locator(
      '.yt-live-chat-overlay-live-region > p[data-message-id^="WINDOWS193_REPLAY_"]',
    ).evaluateAll((elements) => elements.map((element) => element.dataset.messageId));
    await page.waitForFunction(({ expected, worker }) => {
      const probe = window.__ytPlacementProbe;
      const firstEntry = worker ? probe.workers.find((record) => record.ready)?.sample?.firstEntry
        : probe.firstEntry;
      return expected.every((id) => Number.isFinite(firstEntry?.[id]));
    }, { expected: ids, worker: !forceFallback }, { timeout: 10_000 });
    const screenshot = `placement-${forceFallback ? 'main' : 'worker'}-${mode}.png`;
    await page.screenshot({ path: join(output, screenshot), animations: 'disabled' });
    await page.evaluate(() => {
      for (const record of window.__ytPlacementProbe.workers) {
        record.worker.postMessage({ type: 'ytPlacementFlush' });
      }
    });
    await page.waitForTimeout(100);
    const raw = await page.evaluate(() => {
      const probe = window.__ytPlacementProbe;
      return { sourcePrefixed: probe.sourcePrefixed, sourceHooked: probe.sourceHooked,
        requestAtEpochMs: probe.requestAtEpochMs,
        frames: probe.frames, bounds: probe.bounds, firstEntry: probe.firstEntry,
        ingress: probe.ingress, overflow: probe.overflow,
        workers: probe.workers.map(({ ready, stats, sample }) => ({ ready, stats, sample })) };
    });
    const selected = forceFallback ? raw : raw.workers.find((worker) => worker.ready)?.sample;
    assert(forceFallback || raw.sourcePrefixed, 'Packaged Worker source was not instrumented');
    assert(forceFallback || raw.sourceHooked, 'Packaged Worker renderer shape changed');
    assert(forceFallback || raw.workers.some((worker) => worker.ready), 'Real Worker did not become ready');
    assert(selected && selected.frames.length > 0, 'No overlay frames were observed');
    assert(forceFallback || selected.exact?.drains?.length > 0, 'No exact Worker drains were observed');
    const ingress = forceFallback ? { ...Object.fromEntries(ids.map((id) => [id, raw.requestAtEpochMs])) }
      : raw.ingress;
    const firstEntryLatencyMs = Object.fromEntries(ids.map((id) => [id,
      selected.firstEntry[id] !== undefined && ingress[id] !== undefined
        ? selected.firstEntry[id] - ingress[id] : null]));
    return { renderer: forceFallback ? 'main' : 'worker', mode, ids: requested,
      replayRequests: replay ? replayRequests : null,
      replayBoundaries: replay ? replayObservations : null,
      sourcePrefixed: raw.sourcePrefixed, sourceHooked: raw.sourceHooked,
      workerReady: raw.workers.some((worker) => worker.ready),
      firstEntryLatencyMs, firstEntryAtEpochMs: selected.firstEntry,
      frameWorkMs: summarizeSamples(selected.frames.map((frame) => frame.workMs)),
      preClearWorkMs: summarizeSamples(selected.frames.map((frame) => frame.preClearMs)),
      exactWorkerFrameMs: selected.exact
        ? summarizeSamples(selected.exact.frames.map((frame) => frame.workMs)) : null,
      exactWorkerDrainMs: selected.exact
        ? summarizeSamples(selected.exact.drains.map((drain) => drain.workMs)) : null,
      exactWorker: selected.exact ? { ...selected.exact,
        dispositions: selected.exact.dispositions.slice(0, MAX_SAMPLES),
        active: selected.exact.active.slice(0, MAX_SAMPLES),
      } : null,
      bounds: selected.bounds.slice(0, MAX_SAMPLES),
      queueStats: raw.workers.flatMap((worker) => worker.stats),
      sampleOverflow: selected.overflow,
      screenshot,
    };
  } finally {
    if (originalSettings && !page.isClosed()) {
      await page.evaluate((settings) => window.__ytChatOverlay?.applySettings(settings),
        originalSettings).catch(() => {});
    }
    await page.close();
  }
}

/** Installed Edge: run the same application/parser paths with Worker and forced Canvas fallback. */
export async function runPlacementTimingFixture({ context, root, output, extensionId }) {
  const scenarios = [];
  for (const scenario of [
    { forceFallback: false, mode: 'scroll' },
    { forceFallback: true, mode: 'reverse' },
    { forceFallback: false, mode: 'replay' },
  ]) {
    try {
      scenarios.push({ status: 'passed',
        ...await runScenario({ context, root, output, extensionId, ...scenario }) });
    } catch (error) {
      scenarios.push({ status: 'failed', renderer: scenario.forceFallback ? 'main' : 'worker',
        mode: scenario.mode, errorType: error instanceof Error ? error.name : typeof error,
        assertion: error instanceof assert.AssertionError ? error.message.slice(0, 300) : null });
    }
  }
  return { status: scenarios.every((scenario) => scenario.status === 'passed') ? 'passed' : 'failed',
    scenarios, geometryScope: 'text-ink rectangles',
    preClearScope: 'frame work before first overlay clear, including drain and cleanup' };
}
