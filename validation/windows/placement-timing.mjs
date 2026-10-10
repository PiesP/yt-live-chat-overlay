// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const FIXTURE_URL = 'https://www.youtube.com/watch?v=windows193Placement';
const TOKENS = [
  'WINDOWS193_SHORT', 'WINDOWS193_LONG', 'WINDOWS193_REVERSE',
  'WINDOWS193_REPLAY_DUE', 'WINDOWS193_REPLAY_NEXT', 'WINDOWS193_REPLAY_FUTURE',
  'WINDOWS193_REDUCED', 'WINDOWS193_OVERRIDE', 'WINDOWS193_TRANSITION',
  'WINDOWS193_EXPANDED', 'WINDOWS193_OVERRIDE_OFF', 'WINDOWS193_SYSTEM_OFF',
  'WINDOWS193_PAID',
  'WINDOWS196_GAP0_A', 'WINDOWS196_GAP0_B',
  'WINDOWS196_GAP8_A', 'WINDOWS196_GAP8_B',
  'WINDOWS195_BACKLOG_LONG',
  ...Array.from({ length: 10 }, (_, index) => `WINDOWS196_GAP0_${String(index).padStart(2, '0')}`),
];
const MAX_SAMPLES = 240;

export const PLACEMENT_SCENARIOS = Object.freeze([
  { name: 'worker-scroll', forceFallback: false, mode: 'scroll' },
  { name: 'main-reverse', forceFallback: true, mode: 'reverse' },
  { name: 'worker-top', forceFallback: false, mode: 'top' },
  { name: 'worker-bottom', forceFallback: false, mode: 'bottom' },
  { name: 'worker-reduced-toggle', forceFallback: false, mode: 'scroll', transition: 'reduced' },
  { name: 'worker-safe-density', forceFallback: false, mode: 'scroll', transition: 'safe-density' },
  { name: 'worker-congestion', forceFallback: false, mode: 'scroll', transition: 'congestion' },
  { name: 'worker-translation', forceFallback: false, mode: 'scroll', transition: 'translation' },
  { name: 'worker-replay', forceFallback: false, mode: 'replay' },
  { name: 'worker-spacing-speed', forceFallback: false, mode: 'scroll', transition: 'spacing-speed' },
  { name: 'main-spacing-speed', forceFallback: true, mode: 'scroll', transition: 'spacing-speed' },
]);

function installProbeRuntime(options) {
  const MAX_SAMPLES = 240;
  const scope = globalThis;
  const ids = new Set(options.tokens);
  const bitmapIds = new WeakMap();
  const bitmapInk = new WeakMap();
  const state = {
    frames: [], bounds: [], ink: [], firstEntry: {}, ingress: {}, stats: [], workers: [],
    sourcePrefixed: false, sourceHooked: false, overflow: 0, ready: false, canvas: null,
    frameCount: 0, reportCount: 0, videoEntry: {},
  };
  scope.__ytPlacementProbe = state;
  const epochNow = () => performance.timeOrigin + performance.now();
  const tokenIn = (text) => options.tokens.find((token) => String(text).includes(token));
  const overlayContext = (ctx) => options.worker
    ? ctx.canvas === state.canvas
    : Boolean(ctx.canvas?.closest?.('#yt-live-chat-overlay'));
  const recordRect = (ctx, id, x, y, width, height, kind = 'image', ink = null) => {
    if (!id || !overlayContext(ctx) || ctx.globalAlpha === 0 || width <= 0 || height <= 0) return;
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
    if (ink) {
      if (state.ink.length < MAX_SAMPLES) state.ink.push({ ...bound, kind, ...ink });
      else state.overflow++;
    }
    // Bounds and viewport use backing-store pixels after applying the transform.
    const canvasWidth = ctx.canvas.width;
    const canvasHeight = ctx.canvas.height;
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
      if (id && !overlayContext(this)) {
        bitmapIds.set(this.canvas, id);
        const metrics = this.measureText(text);
        bitmapInk.set(this.canvas, { ...bitmapInk.get(this.canvas), fill: { font: this.font,
          left: x - (metrics.actualBoundingBoxLeft ?? 0),
          top: y - metrics.actualBoundingBoxAscent,
          width: (metrics.actualBoundingBoxLeft ?? 0) +
            (metrics.actualBoundingBoxRight ?? metrics.width),
          height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent } });
      }
      if (id && overlayContext(this)) {
        const metrics = this.measureText(text);
        const left = metrics.actualBoundingBoxLeft ?? 0;
        const right = metrics.actualBoundingBoxRight ?? metrics.width;
        recordRect(this, id, x - left,
          y - metrics.actualBoundingBoxAscent, left + right,
          metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent, 'fill',
          { font: this.font, lineWidth: this.lineWidth });
      }
      return nativeFillText.call(this, text, x, y, ...rest);
    };
    const nativeStrokeText = prototype.strokeText;
    prototype.strokeText = function (text, x, y, ...rest) {
      const id = tokenIn(text);
      if (id && !overlayContext(this)) {
        const metrics = this.measureText(text);
        const padding = this.lineWidth / 2;
        bitmapInk.set(this.canvas, { ...bitmapInk.get(this.canvas), stroke: { font: this.font,
          lineWidth: this.lineWidth,
          left: x - (metrics.actualBoundingBoxLeft ?? 0) - padding,
          top: y - metrics.actualBoundingBoxAscent - padding,
          width: (metrics.actualBoundingBoxLeft ?? 0) +
            (metrics.actualBoundingBoxRight ?? metrics.width) + padding * 2,
          height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent + padding * 2 } });
      }
      if (id && overlayContext(this)) {
        const metrics = this.measureText(text);
        const left = metrics.actualBoundingBoxLeft ?? 0;
        const right = metrics.actualBoundingBoxRight ?? metrics.width;
        const padding = this.lineWidth / 2;
        recordRect(this, id, x - left - padding,
          y - metrics.actualBoundingBoxAscent - padding,
          left + right + padding * 2,
          metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent + padding * 2,
          'stroke', { font: this.font, lineWidth: this.lineWidth });
      }
      return nativeStrokeText.call(this, text, x, y, ...rest);
    };
    const nativeDrawImage = prototype.drawImage;
    prototype.drawImage = function (image, ...args) {
      const id = bitmapIds.get(image);
      if (id && overlayContext(this)) {
        const destination = args.length === 2
          ? [args[0], args[1], image.width, image.height]
          : args.length === 4 ? args : args.slice(4, 8);
        if (destination.length === 4) recordRect(this, id, ...destination,
          'bitmap', { sourceInk: bitmapInk.get(image) ?? null });
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
            frames: state.frames, bounds: state.bounds, ink: state.ink, firstEntry: state.firstEntry,
            ingress: state.ingress, exact: state.exact, overflow: state.overflow,
          } });
        }
      }
      if (state.currentFrame === frame) state.currentFrame = null;
    }
  });
  if (options.worker) {
    scope.addEventListener('message', (event) => {
      // Dedicated Worker messages come only from their owner and have an empty origin.
      if (event.origin !== '') return;
      if (event.data?.type === 'init') state.canvas = event.data.canvas;
      if (event.data?.type === 'addMessages') {
        for (const message of event.data.messages ?? []) {
          if (ids.has(message.id)) state.ingress[message.id] ??= epochNow();
        }
      }
      if (event.data?.type === 'ytPlacementResetSamples' && state.exact) {
        state.exact.frames.length = 0;
        state.exact.drains.length = 0;
        state.exact.active.length = 0;
        state.exact.samplesScope = 'congestion phase';
      }
      if (event.data?.type === 'ytPlacementResetIssueInk') {
        state.bounds.length = 0;
        state.ink.length = 0;
      }
      if (event.data?.type === 'ytPlacementFlush') {
        scope.postMessage({ type: 'ytPlacementProbe', requestId: event.data.requestId, sample: {
          frames: state.frames, bounds: state.bounds, ink: state.ink, firstEntry: state.firstEntry,
          ingress: state.ingress, exact: state.exact, overflow: state.overflow,
        } });
      }
    });
    return;
  }
  const replayOffsets = { WINDOWS193_REPLAY_DUE: 10000,
    WINDOWS193_REPLAY_NEXT: 10001, WINDOWS193_REPLAY_FUTURE: 11500 };
  new MutationObserver(() => {
    for (const element of document.querySelectorAll('.yt-live-chat-overlay-live-region > p')) {
      const id = element.dataset.messageId;
      if (ids.has(id) && !state.videoEntry[id] && replayOffsets[id] !== undefined) {
        const videoTimeMs = document.querySelector('video')?.currentTime * 1000;
        state.videoEntry[id] = { atEpochMs: epochNow(), videoTimeMs,
          offsetMs: replayOffsets[id], videoTimeErrorMs: videoTimeMs - replayOffsets[id] };
      }
    }
  }).observe(document, { childList: true, subtree: true });
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
        if (event.data?.type === 'ytPlacementProbe') {
          record.sample = event.data.sample;
          record.flushId = event.data.requestId;
        }
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

export function summarizeExactWorkerProbe(selected, renderer) {
  if (renderer !== 'worker' || !selected?.exact) {
    return { exactWorkerFrameMs: null, exactWorkerDrainMs: null, exactWorker: null };
  }
  const exact = selected.exact;
  return {
    exactWorkerFrameMs: summarizeSamples(exact.frames.map((frame) => frame.workMs)),
    exactWorkerDrainMs: summarizeSamples(exact.drains.map((drain) => drain.workMs)),
    exactWorker: { ...exact, dispositions: exact.dispositions.slice(0, MAX_SAMPLES),
      active: exact.active.slice(0, MAX_SAMPLES) },
  };
}

export function findOverlappingActivePair(messages, width, height) {
  const visible = messages.filter((item) => item.x < width && item.x + item.width > 0 &&
    item.y < height && item.y + item.height > 0 && item.visibleNow !== false);
  for (let left = 0; left < visible.length; left++) {
    for (let right = left + 1; right < visible.length; right++) {
      const a = visible[left];
      const b = visible[right];
      if (a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 &&
          a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1) {
        return [a.id, b.id];
      }
    }
  }
  return null;
}

export function measureClosestRowPitch(messages, prefix = 'WINDOWS196_GAP0_') {
  const ys = messages.filter((entry) => entry.id?.startsWith(prefix) &&
    Number.isFinite(entry.y) && Number.isFinite(entry.height))
    .map((entry) => entry.y).toSorted((a, b) => a - b);
  const pitches = ys.slice(1).map((y, index) => y - ys[index]).filter((pitch) => pitch > 0);
  return pitches.length ? Math.min(...pitches) : null;
}

export function assertBacklogMotion(disposition, renderer, comparisonOnly = false) {
  assert(disposition?.kind === 'activated' && disposition.isBacklog === true,
    'Long parser-ingress message was not activated as Backlog');
  assert(disposition.width > 1870, 'Backlog text did not produce unclamped travel geometry');
  assert(renderer === 'worker' || renderer === 'main', 'Unknown renderer for Backlog motion');
  const burstMultiplier = disposition.burstSpeedMultiplier;
  assert((renderer === 'main' && burstMultiplier === null) ||
    (Number.isFinite(burstMultiplier) && burstMultiplier > 1),
  'Worker did not receive a finite burst multiplier above one');
  assert(disposition.durationMs > 5000 && disposition.durationMs < 30000,
    'Backlog duration was clamped, so this cannot verify speed policy');
  assert(Number.isFinite(disposition.travelDistancePx) &&
    Number.isFinite(disposition.actualVelocityPxPerMs), 'Committed motion fields are unavailable');
  const expectedVelocity = 250 * 2 / 1000;
  if (!comparisonOnly) {
    assert(Math.abs(disposition.actualVelocityPxPerMs - expectedVelocity) < 0.002,
      'Backlog motion acquired an extra burst multiplier');
    assert(Math.abs(disposition.durationMs - disposition.travelDistancePx / expectedVelocity) < 25,
      'Backlog duration does not match the selected nominal speed');
  }
}

export function assertBacklogReflow(before, after, id) {
  assert(after?.config?.logicalWidth > before?.config?.logicalWidth &&
    after.config.logicalHeight > before.config.logicalHeight,
  'Fixture video geometry did not grow during resize');
  assert.equal(before.config.fontSize, 32);
  assert.equal(after.config.fontSize, 32, 'Reflow changed the configured 32px font');
  assert(after.activeNow.some((entry) => entry.id === id),
    'Backlog message disappeared during resize and spacing reflow');
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
  const exact = { frames: [], drains: [], dispositions: [], active: [], activeNow: [], config: null,
    collisionRejects: 0, placementMisses: 0, drops: {}, overflow: 0 };
  state.exact = exact;
  const queuedAt = new Map();
  const epochNow = () => performance.timeOrigin + performance.now();
  const bounded = (list, value) => {
    if (list.length < 240) list.push(value);
    else exact.overflow++;
  };
  const isFixture = (id) => typeof id === 'string' && /^WINDOWS(193|195|196)_/.test(id);
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
      const geometricEntryAtEpochMs = active?.motion
          ? performance.timeOrigin + active.motion.viewportEntryTime
          : (() => {
            if (!active || !this.config || !Number.isFinite(this.logicalWidth) ||
              ![active.startX, active.startTime, active.pausedDuration, active.duration, active.width,
                this.config.exitPaddingPx].every(Number.isFinite)) return null;
            const reverse = this.config?.danmakuMode === 'reverse';
            const fixed = this.config?.danmakuMode === 'top' || this.config?.danmakuMode === 'bottom' ||
              (this.config?.reducedMotion && !this.config?.ignoreReducedMotion);
            const endX = reverse ? this.logicalWidth + this.config.exitPaddingPx
              : -active.width - this.config.exitPaddingPx;
            const velocity = Math.abs(endX - active.startX) / active.duration;
            const distance = fixed ? 0 : reverse ? Math.max(0, -active.startX - active.width)
              : Math.max(0, active.startX - this.logicalWidth);
            return performance.timeOrigin + active.startTime + active.pausedDuration +
              (distance === 0 ? 0 : distance / velocity);
          })();
      const placementWaitMs = args[1]?.waitMs ?? 0;
      bounded(exact.dispositions, { id: message.id, kind: 'activated',
        queueResidenceMs: queuedAt.has(message.id) ? epochNow() - queuedAt.get(message.id) : null,
        atEpochMs: epochNow(), laneIndex: active?.laneIndex ?? null,
        startX: active?.startX ?? null, durationMs: active?.duration ?? null,
        width: active?.width ?? null, height: active?.height ?? null,
        y: active?.y ?? null, laneHeight: this.laneHeight,
        laneSpacing: this.config?.laneSpacing ?? null,
        fontSize: this.config?.fontSize ?? null,
        slotCount: active?.laneSlotCount ?? args[1]?.slotCount ?? null,
        isBacklog: message.isBacklog === true,
        burstSpeedMultiplier: message.burstSpeedMultiplier ?? null,
        actualVelocityPxPerMs: active?.motion?.actualVelocityPxPerMs ?? null,
        travelDistancePx: active?.motion?.travelDistancePx ?? null,
        visibleExitAtEpochMs: active?.motion ? performance.timeOrigin + active.motion.visibleExitTime : null,
        pendingDepth: this.pendingQueue.length,
        staggerDelayMs: active?.motion?.staggerDelayMs ??
          Math.max(0, active.startTime - args[0] - placementWaitMs),
        isScrolling: active?.motion?.isScrolling ?? null,
        geometricEntryAtEpochMs, placementWaitMs,
        optionalEntryDelayMs: geometricEntryAtEpochMs === null ? null
          : geometricEntryAtEpochMs - performance.timeOrigin - args[0] - placementWaitMs,
        geometricEntryProvenance: active?.motion ? 'committed motion plan' : 'committed baseline path' });
      queuedAt.delete(message.id);
    }
    return result;
  };
  const nativeDrop = renderer.recordDrop;
  renderer.recordDrop = function (message, ...args) {
    const reason = typeof args[0] === 'string' ? args[0] : inEnqueue ? 'queue-capacity'
      : inDrain && message.height > this.numLanes * this.laneHeight ? 'oversize' : 'other';
    if (message.trackDrops !== false) exact.drops[reason] = (exact.drops[reason] ?? 0) + 1;
    if (isFixture(message.id)) {
      bounded(exact.dispositions, { id: message.id, kind: 'dropped', reason, tracked: message.trackDrops !== false,
        queueResidenceMs: queuedAt.has(message.id) ? epochNow() - queuedAt.get(message.id) : null,
        atEpochMs: epochNow() });
      queuedAt.delete(message.id);
    }
    return nativeDrop.call(this, message, ...args);
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
      exact.config = { mode: this.config?.danmakuMode ?? null,
        reducedMotion: this.config?.reducedMotion ?? null,
        ignoreReducedMotion: this.config?.ignoreReducedMotion ?? null,
        translationGeneration: this.config?.translationGeneration ?? null,
        fontSize: this.config?.fontSize ?? null, laneSpacing: this.config?.laneSpacing ?? null,
        speedPxPerSec: this.config?.speedPxPerSec ?? null,
        backlogSpeedMultiplier: this.config?.backlogSpeedMultiplier ?? null,
        outline: this.config?.outline ?? null,
        backgroundColors: this.config?.backgroundColors ?? null,
        safeTop: this.config?.safeTop ?? null, safeBottom: this.config?.safeBottom ?? null,
        maxConcurrentMessages: this.config?.maxConcurrentMessages ?? null,
        queueMaxSize: this.config?.queueMaxSize ?? null,
        logicalWidth: this.logicalWidth, logicalHeight: this.logicalHeight,
        laneHeight: this.laneHeight, laneCount: this.numLanes };
      exact.activeNow = this.activeMessages.filter((message) => isFixture(message.id))
        .slice(0, 100).map((message) => ({ id: message.id, atEpochMs: epochNow(),
          x: message.x, y: message.y, width: message.width, height: message.height,
          slotCount: message.laneSlotCount, durationMs: message.duration,
          actualVelocityPxPerMs: message.motion?.actualVelocityPxPerMs ?? null,
          laneIndex: message.laneIndex, isScrolling: message.motion?.isScrolling ?? null,
          startAtEpochMs: performance.timeOrigin + message.startTime + message.pausedDuration,
          visibleNow: performance.now() >= message.startTime + message.pausedDuration &&
            performance.now() < message.startTime + message.pausedDuration + message.duration }));
      if (exact.frames.length % 10 === 0) {
        for (const message of exact.activeNow) bounded(exact.active, message);
      }
    }
  };
}

// The installed extension page script is executed intact inside its normal
// closure. This additive probe is inserted immediately before its app entry.
// A changed bundle shape is an acceptance failure, never a silent fallback.
export function instrumentCanvasPageScript(source, probeSource = attachCanvasRendererProbe.toString()) {
  const marker = '\n\tmain();\n';
  if (!source.includes('var CanvasRenderer = class CanvasRenderer extends RendererBase {') ||
      !source.includes('function getRegularCardInsets(') ||
      source.split(marker).length !== 2) return null;
  return source.replace(marker, `\n\t;(${probeSource})(CanvasRenderer, getRegularCardInsets);${marker}`);
}

function attachCanvasRendererProbe(Renderer, getRegularCardInsets) {
  const state = globalThis.__ytPlacementProbe;
  if (!state || typeof Renderer?.prototype?.placeQueuedMessage !== 'function' ||
      typeof getRegularCardInsets !== 'function') return;
  state.canvasSourceHooked = true;
  state.readRegularInsets = (fontSize, outlineWidthPx, backgroundVisible) =>
    getRegularCardInsets(fontSize, outlineWidthPx, false, backgroundVisible);
  const exact = { dispositions: [], activeNow: [], config: null, peaks: { pending: 0, active: 0 },
    drops: {},
    overflow: 0 };
  state.exact = exact;
  const queuedAt = new Map();
  const bounded = (value) => {
    if (exact.dispositions.length < 240) exact.dispositions.push(value);
    else exact.overflow++;
  };
  const isFixture = (id) => typeof id === 'string' && /^WINDOWS(193|195|196)_/.test(id);
  const nativeEnqueue = Renderer.prototype.enqueueMessage;
  Renderer.prototype.enqueueMessage = function (message, ...args) {
    const result = nativeEnqueue.call(this, message, ...args);
    if (isFixture(message.id) && this.pendingQueue.toArray().some((entry) => entry.id === message.id)) {
      queuedAt.set(message.id, performance.timeOrigin + performance.now());
    }
    exact.peaks.pending = Math.max(exact.peaks.pending, this.pendingQueue.size);
    return result;
  };
  const nativePlace = Renderer.prototype.placeQueuedMessage;
  Renderer.prototype.placeQueuedMessage = function (message, ...args) {
    const result = nativePlace.call(this, message, ...args);
    if (isFixture(message.id) && result?.placed) {
      const active = this.activeMessages.find((entry) => entry.message?.id === message.id);
      const motion = active?.motion;
      bounded({ id: message.id, kind: 'activated', atEpochMs: performance.timeOrigin + performance.now(),
        isBacklog: message.isBacklog === true, laneIndex: active?.laneIndex ?? null,
        burstSpeedMultiplier: null,
        laneSpacing: this.settings.laneSpacing, fontSize: this.settings.fontSize,
        width: active?.width ?? null, height: active?.height ?? null, y: active?.y ?? null,
        laneHeight: this.laneAllocator.getLaneHeight(), slotCount: active?.slotCount ?? null,
        durationMs: motion?.durationMs ?? null,
        actualVelocityPxPerMs: motion?.actualVelocityPxPerMs ?? null,
        travelDistancePx: motion?.travelDistancePx ?? null,
        queueResidenceMs: queuedAt.has(message.id)
          ? performance.timeOrigin + performance.now() - queuedAt.get(message.id) : null,
        geometricEntryAtEpochMs: motion ? performance.timeOrigin + motion.viewportEntryTime : null,
        visibleExitAtEpochMs: motion ? performance.timeOrigin + motion.visibleExitTime : null,
        pendingDepth: this.pendingQueue.size });
      queuedAt.delete(message.id);
    }
    return result;
  };
  const nativeFrame = Renderer.prototype.renderFrame;
  const observed = new WeakSet();
  Renderer.prototype.renderFrame = function (...args) {
    if (this.observability && !observed.has(this.observability)) {
      observed.add(this.observability);
      for (const [method, countIndex] of [['onMessageDropped', 1], ['onMessagesDropped', 0]]) {
        const native = this.observability[method];
        if (typeof native !== 'function') continue;
        this.observability[method] = (...dropArgs) => {
          const reason = dropArgs[1 - countIndex] ?? 'other';
          const count = countIndex === 0 ? dropArgs[0] : 1;
          exact.drops[reason] = (exact.drops[reason] ?? 0) + count;
          return native.apply(this.observability, dropArgs);
        };
      }
    }
    try { return nativeFrame.apply(this, args); }
    finally {
      exact.peaks.pending = Math.max(exact.peaks.pending, this.pendingQueue.size);
      exact.peaks.active = Math.max(exact.peaks.active, this.activeMessages.length);
      const dims = this.overlay.getDimensions();
      exact.config = { fontSize: this.settings.fontSize, laneSpacing: this.settings.laneSpacing,
        speedPxPerSec: this.settings.speedPxPerSec,
        backlogSpeedMultiplier: this.settings.backlogSpeedMultiplier,
        outline: this.settings.outline, backgroundColors: this.settings.backgroundColors,
        logicalWidth: dims?.width ?? null, logicalHeight: dims?.height ?? null,
        laneHeight: this.laneAllocator.getLaneHeight(), laneCount: this.laneAllocator.getLaneCount() };
      exact.activeNow = this.activeMessages.filter((entry) => isFixture(entry.message?.id))
        .slice(0, 100).map((entry) => ({ id: entry.message.id, x: entry.x, y: entry.y,
          width: entry.width, height: entry.height, laneIndex: entry.laneIndex,
          slotCount: entry.slotCount, durationMs: entry.motion?.durationMs ?? null,
          actualVelocityPxPerMs: entry.motion?.actualVelocityPxPerMs ?? null }));
    }
  };
}

function messageAction(id, text) {
  return { addChatItemAction: { item: { liveChatTextMessageRenderer: {
    id, authorName: { simpleText: `Fixture viewer ${id}` }, message: { runs: [{ text: text.includes(id) ? text : `${id} ${text}` }] },
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

async function runScenario({ context, root, output, extensionId, name, forceFallback, mode,
  transition, comparisonOnly = false }) {
  const page = await context.newPage();
  const requested = [];
  let originalSettings;
  const deliveredBatches = new Set();
  const phaseObservations = [];
  let replayRequests = 0;
  const replay = mode === 'replay';
  const spacingSpeed = transition === 'spacing-speed';
  const replayObservations = {};
  const ids = replay ? TOKENS.slice(3, 6) : spacingSpeed ? [...TOKENS.slice(13, 15), ...TOKENS.slice(18)]
    : mode === 'reverse' ? [TOKENS[2]] : TOKENS.slice(0, 2);
  const paidId = 'WINDOWS193_PAID';
  const drawnIds = replay ? ids : spacingSpeed ? ids.slice(0, 2) : [...ids, paidId];
  const actions = ids.map((id) => messageAction(id, spacingSpeed
    ? `${id} 東京の夜空にコメントが流れます` : id === TOKENS[1] ? `${id}_${'W'.repeat(100)}` : id));
  if (!replay && !spacingSpeed) actions.push({ addChatItemAction: { item: { liveChatPaidMessageRenderer: {
    id: paidId, authorName: { simpleText: 'Fixture donor' },
    purchaseAmountText: { simpleText: '$5.00' },
    message: { simpleText: paidId },
  } } } });
  const replayActions = replay ? [10_000, 10_001, 11_500].map((offsetMs, index) => ({
    replayChatItemAction: { videoOffsetTimeMsec: offsetMs, actions: [actions[index]] },
  })) : [];
  const batches = new Map([
    ['1', actions],
    ['2', spacingSpeed ? TOKENS.slice(15, 17).map((id) => messageAction(id,
      `${id} 東京の夜空にコメントが流れます`)) : transition === 'congestion'
      ? Array.from({ length: 50 }, (_, index) => messageAction(
        `WINDOWS193_LOAD_${String(index).padStart(2, '0')}`, 'Bounded congestion fixture'))
      : [messageAction(transition === 'reduced' ? TOKENS[6] : TOKENS[8],
        'Bounded transition fixture')]],
    ['3', spacingSpeed ? Array.from({ length: 51 }, (_, index) => {
      const id = index === 14 ? TOKENS[17] : `WINDOWS195_LOAD_${String(index).padStart(2, '0')}`;
      return messageAction(id, index === 14
        ? `${id} ${'東京の夜空をゆっくり流れるコメント'.repeat(5)}`
        : `${id} バックログ`);
    }) : [messageAction(transition === 'reduced' ? TOKENS[7] : TOKENS[9],
      'Bounded second transition fixture')]],
    ['4', spacingSpeed ? Array.from({ length: 4 }, (_, index) => messageAction(
      `WINDOWS195_BURST_${String(index).padStart(2, '0')}`, 'Bounded live burst'))
      : [messageAction(TOKENS[10], 'Reduced-motion override disabled')]],
    ['5', [messageAction(TOKENS[11], 'System reduced motion disabled')]],
  ]);
  const preview = await readFile(join(root, 'test/visual/preview.html'), 'utf8');
  const html = preview.replace(
    '<div class="player-inner">Video Player Placeholder</div>',
    '<video aria-label="Placement fixture video" style="width:100%;height:100%"></video>',
  ).replace('</body>', '<div id="chat"><yt-live-chat-item-list-renderer><div id="items"></div></yt-live-chat-item-list-renderer></div></body>');
  assert.notEqual(html, preview, 'Placement fixture video was not installed');
  const workerPrelude = workerProbePrelude();
  const canvasScript = spacingSpeed
    ? instrumentCanvasPageScript(await readFile(join(root, 'dist-extension/page-script.js'), 'utf8'))
    : null;
  if (spacingSpeed) assert(canvasScript, 'Packaged Canvas page script shape changed');
  const screenshot = `placement-${name}.png`;
  let screenshotCaptured = false;
  const sendBatch = async (batch) => {
    await page.evaluate(async (key) => {
      if (key === '1') {
        window.__ytPlacementProbe.requestAtEpochMs = performance.timeOrigin + performance.now();
      }
      const response = await fetch(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?windows193=${key}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      if (!response.ok) throw new Error('Placement fixture request failed');
      await response.json();
    }, batch);
    assert(deliveredBatches.has(batch), `Scoped placement batch ${batch} was not intercepted`);
  };
  const workerSnapshot = async () => {
    // Flush observes the preceding frame; let queued settings reach that frame first.
    await page.waitForTimeout(50);
    const requestId = await page.evaluate(() => {
      const probe = window.__ytPlacementProbe;
      const id = (probe.flushSequence ?? 0) + 1;
      probe.flushSequence = id;
      for (const record of probe.workers) record.worker.postMessage({ type: 'ytPlacementFlush', requestId: id });
      return id;
    });
    await page.waitForFunction((id) => window.__ytPlacementProbe.workers
      .some((record) => record.ready && record.flushId === id), requestId, { timeout: 5000 });
    return page.evaluate(() => window.__ytPlacementProbe.workers
      .find((record) => record.ready)?.sample?.exact ?? null);
  };
  const waitForWorkerEntry = (id) => page.waitForFunction((messageId) =>
    Number.isFinite(window.__ytPlacementProbe.workers.find((record) => record.ready)
      ?.sample?.firstEntry?.[messageId]), id, { timeout: 10_000 });
  const captureProbe = async () => {
    if (page.isClosed()) return null;
    await page.evaluate(() => {
      for (const record of window.__ytPlacementProbe?.workers ?? []) {
        record.worker.postMessage({ type: 'ytPlacementFlush' });
      }
    });
    await page.waitForTimeout(100);
    return page.evaluate(() => {
      const probe = window.__ytPlacementProbe;
      if (!probe) return null;
      const video = document.querySelector('video')?.getBoundingClientRect();
      const overlay = document.querySelector('#yt-live-chat-overlay canvas');
      const settings = window.__ytChatOverlay?.getSettings?.();
      const insets = settings && probe.readRegularInsets?.(settings.fontSize,
        settings.outline.enabled ? settings.outline.widthPx : 0, false);
      return { sourcePrefixed: probe.sourcePrefixed, sourceHooked: probe.sourceHooked,
        canvasSourceHooked: probe.canvasSourceHooked,
        regularInsets: insets ?? null,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        video: video ? { x: video.x, y: video.y, width: video.width, height: video.height } : null,
        canvas: overlay ? { width: overlay.width, height: overlay.height } : null,
        requestAtEpochMs: probe.requestAtEpochMs, videoEntry: probe.videoEntry,
        frames: probe.frames, bounds: probe.bounds, ink: probe.ink, exact: probe.exact,
        firstEntry: probe.firstEntry,
        ingress: probe.ingress, overflow: probe.overflow,
        workers: probe.workers.map(({ ready, stats, sample }) => ({ ready, stats, sample })) };
    });
  };
  const probeResult = (raw) => {
    const selected = raw && (forceFallback ? raw : raw.workers.find((worker) => worker.ready)?.sample);
    const ingress = forceFallback ? Object.fromEntries(drawnIds.map((id) => [id, raw?.requestAtEpochMs]))
      : raw?.ingress ?? {};
    return { renderer: forceFallback ? 'main' : 'worker', name, mode,
      phases: phaseObservations, ids: requested,
      replayRequests: replay ? replayRequests : null,
      replayBoundaries: replay ? replayObservations : null,
      deliveredBatches: [...deliveredBatches],
      sourcePrefixed: raw?.sourcePrefixed ?? false, sourceHooked: raw?.sourceHooked ?? false,
      canvasSourceHooked: raw?.canvasSourceHooked ?? false, comparisonOnly,
      regularInsets: raw?.regularInsets ?? null,
      viewport: raw?.viewport ?? null, video: raw?.video ?? null, canvas: raw?.canvas ?? null,
      workerReady: raw?.workers.some((worker) => worker.ready) ?? false,
      firstEntryLatencyMs: Object.fromEntries(drawnIds.map((id) => [id,
        selected?.firstEntry?.[id] !== undefined && ingress[id] !== undefined
          ? selected.firstEntry[id] - ingress[id] : null])),
      firstEntryAtEpochMs: selected?.firstEntry ?? {},
      firstEntryScope: 'first sampled nonzero-alpha text draw touching the viewport; includes fade and frame quantization',
      geometryUnits: 'backing-store pixels',
      replayVideoTime: raw?.videoEntry ?? {},
      geometricEntryLatencyMs: Object.fromEntries((selected?.exact?.dispositions ?? [])
        .filter((entry) => entry.kind === 'activated' && Number.isFinite(entry.geometricEntryAtEpochMs))
        .map((entry) => [entry.id, ingress[entry.id] === undefined ? null
          : entry.geometricEntryAtEpochMs - ingress[entry.id]])),
      frameWorkMs: summarizeSamples(selected?.frames?.map((frame) => frame.workMs) ?? []),
      preClearWorkMs: summarizeSamples(selected?.frames?.map((frame) => frame.preClearMs) ?? []),
      ...summarizeExactWorkerProbe(selected, forceFallback ? 'main' : 'worker'),
      bounds: selected?.bounds?.slice(0, MAX_SAMPLES) ?? [],
      ink: selected?.ink?.slice(0, MAX_SAMPLES) ?? [],
      exactCanvas: forceFallback ? selected?.exact ?? null : null,
      queueStats: raw?.workers.flatMap((worker) => worker.stats) ?? [],
      sampleOverflow: selected?.overflow ?? null,
      screenshot: screenshotCaptured ? screenshot : null,
    };
  };
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (canvasScript && url.protocol === 'chrome-extension:' &&
          url.hostname === extensionId && url.pathname === '/page-script.js') {
        return route.fulfill({ status: 200, contentType: 'text/javascript', body: canvasScript });
      }
      if (url.protocol === 'chrome-extension:' && url.hostname === extensionId) return route.continue();
      if (replay && url.hostname === 'www.youtube.com' &&
        url.pathname === '/youtubei/v1/live_chat/get_live_chat_replay') {
        replayRequests++;
        return route.fulfill({ status: 200, contentType: 'application/json',
          json: replayResponse(replayRequests === 2 ? replayActions : []) });
      }
      if (url.hostname === 'www.youtube.com' && url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat')) {
        const batch = url.searchParams.get('windows193');
        const deliver = batch && batches.has(batch) && !deliveredBatches.has(batch);
        if (deliver) deliveredBatches.add(batch);
        return route.fulfill({ status: 200, contentType: 'application/json',
          json: chatResponse(deliver ? batches.get(batch) : []) });
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
      window.__ytPlacementSetPaused = (paused) => {
        playback.paused = paused;
        document.querySelector('video')?.dispatchEvent(new Event(paused ? 'pause' : 'play'));
      };
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
    originalSettings = await page.evaluate(({ danmakuMode, spacingSpeed }) => {
      const settings = window.__ytChatOverlay.getSettings();
      const overrides = { danmakuMode,
        outline: { ...settings.outline, enabled: spacingSpeed, widthPx: 2, opacity: 0.7 },
        showDebugOverlay: true,
        fontSize: 32, laneSpacing: 0, safeTop: 0, safeBottom: 0,
        maxConcurrentMessages: 300, queueMaxSize: 200,
        ignoreReducedMotion: false, translationEnabled: false };
      if (spacingSpeed) Object.assign(overrides, {
        backgroundColors: { ...settings.backgroundColors, normal: '#00000000' },
        showAuthor: { ...settings.showAuthor, normal: false },
        depthLayersEnabled: false, speedPxPerSec: 250, backlogSpeedMultiplier: 2,
        backlogMaxRate: 50,
        scrollDurationMinMs: 5000, scrollDurationMaxMs: 30000,
        staggerMaxDelayMs: 0, staggerMediumDelayMs: 0,
      });
      const previous = structuredClone(Object.fromEntries([
        ...Object.keys(overrides), ...(spacingSpeed
          ? ['burstElevatedThreshold', 'burstHighThreshold', 'burstExtremeThreshold',
            'speedBoostThreshold'] : []),
      ].map((key) => [key, settings[key]])));
      window.__ytChatOverlay.applySettings(overrides);
      return previous;
    }, { danmakuMode: replay ? 'scroll' : mode, spacingSpeed });
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
      await sendBatch('1');
    }
    requested.push(...ids, ...(replay || spacingSpeed ? [] : [paidId]));
    await page.waitForFunction(({ expected, boundedStream }) => {
      const accessibleIds = new Set([...document.querySelectorAll(
        '.yt-live-chat-overlay-live-region > p')].map((element) => element.dataset.messageId));
      // Each renderer mirrors at most ten active messages per update. The
      // twelve-message stream is retained in the routed parser batch; selected
      // messages are independently verified by canvas paint below.
      return boundedStream
        ? expected.filter((id) => accessibleIds.has(id)).length >= 2
        : expected.every((id) => accessibleIds.has(id));
    }, { expected: requested, boundedStream: spacingSpeed }, { timeout: 15_000 });
    if (replay) replayObservations.at11500 = await page.locator(
      '.yt-live-chat-overlay-live-region > p[data-message-id^="WINDOWS193_REPLAY_"]',
    ).evaluateAll((elements) => elements.map((element) => element.dataset.messageId));
    await page.waitForFunction(({ expected, worker }) => {
      const probe = window.__ytPlacementProbe;
      const firstEntry = worker ? probe.workers.find((record) => record.ready)?.sample?.firstEntry
        : probe.firstEntry;
      return expected.every((id) => Number.isFinite(firstEntry?.[id]));
    }, { expected: drawnIds, worker: !forceFallback }, { timeout: 10_000 });

    if (spacingSpeed) {
      const issueSnapshot = async () => {
        if (!forceFallback) await workerSnapshot();
        const raw = await captureProbe();
        const selected = forceFallback ? raw : raw?.workers.find((record) => record.ready)?.sample;
        assert(raw?.canvasSourceHooked && selected?.exact, 'Packaged renderer probe did not attach');
        assert.equal(selected.exact.config?.backgroundColors?.normal, '#00000000',
          'Japanese fixture did not keep a transparent normal background');
        return { exact: selected.exact, ink: selected.ink ?? [],
          regularInsets: raw.regularInsets,
          stats: forceFallback ? selected.exact.peaks : raw.workers.flatMap((record) => record.stats) };
      };
      const gap0 = await issueSnapshot();
      await page.screenshot({ path: join(output, `placement-${name}-gap0.png`), animations: 'disabled' });
      const gap0Pitch = measureClosestRowPitch(gap0.exact.activeNow);
      assert(gap0Pitch !== null, 'Gap-zero fixture did not activate distinct regular rows');
      phaseObservations.push({ phase: 'gap0', pitchPx: gap0Pitch,
        active: gap0.exact.activeNow, config: gap0.exact.config,
        dispositions: gap0.exact.dispositions, ink: gap0.ink,
        regularInsets: gap0.regularInsets, queue: gap0.stats });
      await page.evaluate(() => {
        const probe = window.__ytPlacementProbe;
        probe.bounds.length = 0;
        probe.ink.length = 0;
        for (const record of probe.workers) record.worker.postMessage({ type: 'ytPlacementResetIssueInk' });
      });
      await page.evaluate(() => window.__ytChatOverlay.applySettings({ laneSpacing: 8 }));
      await page.waitForTimeout(350);
      await sendBatch('2');
      await page.waitForFunction((id) => [...document.querySelectorAll(
        '.yt-live-chat-overlay-live-region > p')].some((element) => element.dataset.messageId === id),
      TOKENS[15], { timeout: 10_000 });
      const gap8 = await issueSnapshot();
      await page.screenshot({ path: join(output, `placement-${name}-gap8.png`), animations: 'disabled' });
      const gap8Pitch = measureClosestRowPitch(gap8.exact.activeNow);
      assert(gap8Pitch !== null, 'Gap-eight fixture lost the ordinary row sample');
      assert.equal(gap8.exact.config.laneSpacing, 8);
      if (!comparisonOnly) {
        assert(gap8Pitch >= gap0Pitch, 'Increasing Lane Gap reduced the actual regular row pitch');
        const regular = gap0.exact.dispositions.filter((entry) =>
          entry.kind === 'activated' && entry.id.startsWith('WINDOWS196_GAP0_'));
        assert(regular.length >= 2 && regular.every((entry) => entry.slotCount === 1),
          'Compact transparent regular comments reserved extra baseline rows');
      }
      phaseObservations.push({ phase: 'gap8', pitchPx: gap8Pitch,
        active: gap8.exact.activeNow, config: gap8.exact.config,
        dispositions: gap8.exact.dispositions, ink: gap8.ink,
        regularInsets: gap8.regularInsets, queue: gap8.stats });

      await page.evaluate(() => window.__ytChatOverlay.applySettings({
        burstElevatedThreshold: 2, burstHighThreshold: 5,
        burstExtremeThreshold: 10, speedBoostThreshold: 2,
      }));
      await sendBatch('3'); // >50 parsed chat actions take the production Backlog path.
      await sendBatch('4'); // Ordinary live ingress raises the real burst detector.
      let backlog;
      for (let attempt = 0; attempt < 30; attempt++) {
        backlog = await issueSnapshot();
        if (backlog.exact.dispositions.some((entry) =>
          entry.id === TOKENS[17] && entry.kind === 'activated')) break;
        await page.waitForTimeout(900);
      }
      assert(backlog.exact.dispositions.some((entry) =>
        entry.id === TOKENS[17] && entry.kind === 'activated'),
      'Long parser-ingress Backlog message did not activate within 30 seconds');
      const long = backlog.exact.dispositions.find((entry) => entry.id === TOKENS[17]
        && entry.kind === 'activated');
      assertBacklogMotion(long, forceFallback ? 'main' : 'worker', comparisonOnly);
      phaseObservations.push({ phase: 'backlog-burst', motion: long,
        config: backlog.exact.config, queue: backlog.stats,
        dispositions: backlog.exact.dispositions.filter((entry) => entry.id.startsWith('WINDOWS195_')) });
      await page.evaluate(() => window.__ytPlacementSetPaused(true));
      const pauseStart = await issueSnapshot();
      await page.waitForTimeout(450);
      const paused = await issueSnapshot();
      const atPauseStart = pauseStart.exact.activeNow.find((entry) => entry.id === TOKENS[17]);
      const atPauseEnd = paused.exact.activeNow.find((entry) => entry.id === TOKENS[17]);
      assert(atPauseStart && atPauseEnd && Math.abs(atPauseStart.x - atPauseEnd.x) < 2,
        'Backlog progress advanced during video pause');
      await page.evaluate(() => window.__ytPlacementSetPaused(false));
      await page.waitForTimeout(350);
      const resumed = await issueSnapshot();
      assert(resumed.exact.activeNow.some((entry) => entry.id === TOKENS[17]),
        'Backlog message was lost on video resume');
      phaseObservations.push({ phase: 'pause-resume',
        pauseStart: atPauseStart, paused: atPauseEnd,
        resumed: resumed.exact.activeNow.filter((entry) => entry.id === TOKENS[17]) });
      await page.evaluate(() => window.__ytChatOverlay.applySettings({ laneSpacing: 0 }));
      await page.locator('.player-wrapper').evaluate((element) => {
        element.style.maxWidth = '1000px';
      });
      await page.setViewportSize({ width: 1100, height: 700 });
      await page.waitForTimeout(350);
      const reflow = await issueSnapshot();
      assertBacklogReflow(resumed.exact, reflow.exact, TOKENS[17]);
      phaseObservations.push({ phase: 'reflow', config: reflow.exact.config,
        active: reflow.exact.activeNow.filter((entry) => entry.id === TOKENS[17]) });
      if (!forceFallback) {
        await page.evaluate(() => {
          const record = window.__ytPlacementProbe.workers.find((entry) => entry.ready);
          record.worker.dispatchEvent(new ErrorEvent('error', { message: 'Acceptance recovery trigger' }));
        });
        await page.waitForFunction(() => {
          const status = document.querySelector('#yt-chat-overlay-debug')?.textContent ?? '';
          return status.includes('Render:') && !status.includes('Render: n/a');
        }, undefined, { timeout: 15_000 });
        const recovered = await captureProbe();
        assert(recovered?.canvasSourceHooked && recovered.exact?.config,
          'Worker failure did not recover into the instrumented Canvas');
        assert(recovered.exact.activeNow.some((entry) => entry.id === TOKENS[17]),
          'Backlog message was lost during Worker-to-Canvas recovery');
        phaseObservations.push({ phase: 'worker-recovery', config: recovered.exact.config,
          active: recovered.exact.activeNow.filter((entry) => entry.id === TOKENS[17]) });
      }
      await page.locator('#yt-chat-overlay-settings-button').click({ force: true });
      const modal = page.locator('#yt-chat-overlay-settings-backdrop');
      await modal.waitFor({ state: 'visible' });
      const disclosure = modal.locator('.yt-chat-overlay-settings-disclosure').first();
      if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').click();
      const slider = modal.locator('input[name="laneSpacing-slider"]');
      await slider.focus();
      await slider.press('Home');
      const previewState = () => page.locator('.yt-chat-overlay-settings-font-preview-text')
        .evaluate((element) => ({ rows: element.dataset.previewRows ?? null,
          rowHeight: Number(element.dataset.previewRowHeight),
          rowPitch: Number(element.dataset.previewRowPitch) }));
      const previewZero = await previewState();
      for (let step = 0; step < 8; step++) await slider.press('ArrowRight');
      assert.equal(await modal.locator('input[name="laneSpacing"]').inputValue(), '8');
      if (!comparisonOnly) await page.waitForFunction((before) => {
        const element = document.querySelector('.yt-chat-overlay-settings-font-preview-text');
        return element?.dataset.previewRows === '2' &&
          Number(element.dataset.previewRowPitch) > before;
      }, previewZero.rowPitch, { timeout: 5000 });
      const previewEight = await previewState();
      if (!comparisonOnly) {
        assert.equal(previewZero.rows, '2', 'Settings preview did not draw two representative rows');
        assert.equal(previewEight.rows, '2');
        assert(previewEight.rowPitch > previewZero.rowPitch,
          'Settings preview did not respond to Lane Gap');
      }
      await modal.locator('button[data-action="close"]').last().click();
      await modal.waitFor({ state: 'hidden' });
      await page.locator('#yt-chat-overlay-settings-button').click({ force: true });
      await modal.waitFor({ state: 'visible' });
      if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').click();
      assert.equal(await modal.locator('input[name="laneSpacing"]').inputValue(), '8',
        'Saved Lane Gap was not restored on settings reopen');
      await page.keyboard.press('Escape');
      await modal.waitFor({ state: 'hidden' });
      const storageWorker = context.serviceWorkers().find((worker) =>
        worker.url().startsWith(`chrome-extension://${extensionId}/`));
      assert(storageWorker, 'Installed extension background worker is unavailable for storage readback');
      let storedLaneSpacing = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        const saved = await storageWorker.evaluate(async () =>
          (await chrome.storage.local.get('yt-live-chat-overlay-settings'))['yt-live-chat-overlay-settings']);
        storedLaneSpacing = saved ? JSON.parse(saved).laneSpacing : null;
        if (storedLaneSpacing === 8) break;
        await page.waitForTimeout(100);
      }
      assert.equal(storedLaneSpacing, 8, 'Lane Gap was not persisted in extension storage');
      phaseObservations.push({ phase: 'settings-ui', previewZero, previewEight,
        reopenedLaneSpacing: 8, storedLaneSpacing: 8, closeActions: ['Done', 'Escape'] });
    }

    if (transition === 'reduced') {
      const baseline = await workerSnapshot();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForFunction(() => window.__ytPlacementProbe.workers.find((record) => record.ready)
        ?.sample?.exact?.config?.reducedMotion === true, undefined, { timeout: 10_000 });
      await sendBatch('2');
      await page.waitForFunction((id) => document.querySelector(
        `.yt-live-chat-overlay-live-region > p[data-message-id="${id}"]`), TOKENS[6]);
      await waitForWorkerEntry(TOKENS[6]);
      const reduced = await workerSnapshot();
      assert.equal(reduced.config.reducedMotion, true);
      assert(reduced.dispositions.some((entry) => entry.id === TOKENS[6] && entry.isScrolling === false),
        'Reduced-motion message was not activated in fixed mode');
      await page.evaluate(() => window.__ytChatOverlay.applySettings({ ignoreReducedMotion: true }));
      const override = await workerSnapshot();
      assert.equal(override.config.ignoreReducedMotion, true);
      assert(override.activeNow.some((entry) => entry.id === TOKENS[6] && entry.isScrolling === true),
        'Reduced-motion override did not restore scrolling');
      await page.evaluate(() => window.__ytChatOverlay.applySettings({ ignoreReducedMotion: false }));
      const restored = await workerSnapshot();
      assert.equal(restored.config.ignoreReducedMotion, false);
      assert(restored.activeNow.some((entry) => entry.id === TOKENS[6] &&
        entry.isScrolling === false), 'Disabling override did not restore reduced motion');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.waitForFunction(() => window.__ytPlacementProbe.workers.find((record) => record.ready)
        ?.sample?.exact?.config?.reducedMotion === false, undefined, { timeout: 10_000 });
      const systemOff = await workerSnapshot();
      assert.equal(systemOff.config.reducedMotion, false);
      assert(systemOff.activeNow.some((entry) => entry.id === TOKENS[6] &&
        entry.isScrolling === true), 'System reduced-motion off did not restore scrolling');
      for (const state of [reduced, override, restored, systemOff]) {
        assert.equal(findOverlappingActivePair(state.activeNow,
          state.config.logicalWidth, state.config.logicalHeight), null,
        'Visible messages overlapped during a live reduced-motion transition');
      }
      phaseObservations.push({ phase: 'initial', config: baseline.config },
        { phase: 'reduced', config: reduced.config }, { phase: 'override', config: override.config },
        { phase: 'override-off', config: restored.config },
        { phase: 'system-off', config: systemOff.config });
    }
    if (transition === 'safe-density') {
      const baseline = await workerSnapshot();
      await page.setViewportSize({ width: 800, height: 600 });
      await page.evaluate(() => window.__ytChatOverlay.applySettings({ safeTop: 0.15,
        safeBottom: 0.25, fontSize: 40, laneSpacing: 10, maxConcurrentMessages: 30 }));
      await sendBatch('2');
      await page.waitForFunction((id) => document.querySelector(
        `.yt-live-chat-overlay-live-region > p[data-message-id="${id}"]`), TOKENS[8]);
      await waitForWorkerEntry(TOKENS[8]);
      const compact = await workerSnapshot();
      assert(compact.config.logicalWidth < baseline.config.logicalWidth,
        'Active Worker viewport did not shrink');
      assert.equal(compact.config.safeTop, 0.15);
      assert.equal(compact.config.safeBottom, 0.25);
      assert.equal(compact.config.maxConcurrentMessages, 30);
      const active = compact.activeNow.filter((entry) => entry.id === TOKENS[8]);
      assert(active.length > 0, 'Safe-zone transition produced no active geometry');
      assert(active.some((entry) => entry.y >= compact.config.logicalHeight * 0.15 &&
        entry.y + entry.height <= compact.config.logicalHeight * 0.75),
      'Transition message escaped the shrunken safe zone');
      assert.equal(findOverlappingActivePair(compact.activeNow,
        compact.config.logicalWidth, compact.config.logicalHeight), null,
      'Messages overlapped after safe-zone and density shrink');
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.evaluate(() => window.__ytChatOverlay.applySettings({ safeTop: 0,
        safeBottom: 0, fontSize: 32, laneSpacing: 0, maxConcurrentMessages: 300 }));
      await sendBatch('3');
      await page.waitForFunction((id) => document.querySelector(
        `.yt-live-chat-overlay-live-region > p[data-message-id="${id}"]`), TOKENS[9]);
      await waitForWorkerEntry(TOKENS[9]);
      const expanded = await workerSnapshot();
      assert(expanded.config.logicalWidth > compact.config.logicalWidth,
        'Active Worker viewport did not expand');
      assert.equal(expanded.config.safeTop, 0);
      assert.equal(expanded.config.safeBottom, 0);
      assert(expanded.activeNow.some((entry) => entry.id === TOKENS[9]),
        'Expanded safe zone produced no active geometry');
      assert.equal(findOverlappingActivePair(expanded.activeNow,
        expanded.config.logicalWidth, expanded.config.logicalHeight), null,
      'Messages overlapped after safe-zone expansion');
      phaseObservations.push({ phase: 'initial', config: baseline.config },
        { phase: 'compact', config: compact.config, active: active.at(-1) },
        { phase: 'expanded', config: expanded.config,
          active: expanded.activeNow.filter((entry) => entry.id === TOKENS[9]).at(-1) });
    }
    if (transition === 'congestion') {
      await page.evaluate(() => window.__ytChatOverlay.applySettings({ maxConcurrentMessages: 30,
        queueMaxSize: 50, fontSize: 16, laneSpacing: 0, safeTop: 0, safeBottom: 0,
        staggerMaxDelayMs: 200, staggerMediumDelayMs: 80 }));
      await workerSnapshot();
      await page.evaluate(() => window.__ytPlacementProbe.workers.find((record) => record.ready)
        .worker.postMessage({ type: 'ytPlacementResetSamples' }));
      await sendBatch('2');
      await page.waitForTimeout(500);
      const congested = await workerSnapshot();
      const peakPending = Math.max(0, ...congested.drains.map((drain) => drain.pendingBefore));
      assert.equal(congested.config.maxConcurrentMessages, 30);
      assert.equal(congested.config.queueMaxSize, 50);
      assert(peakPending >= 50, `No-stagger pressure was not reached: pending ${peakPending}`);
      assert(congested.dispositions.some((entry) => entry.kind === 'activated' &&
        entry.pendingDepth >= 50 && entry.staggerDelayMs === 0 &&
        Math.abs(entry.optionalEntryDelayMs) < 1),
      'Queue pressure did not remove both temporal and geometric entry delay');
      assert(congested.drains.every((drain) => drain.activeAfter <= 30));
      phaseObservations.push({ phase: 'congested', config: congested.config, peakPending,
        zeroStaggerActivations: congested.dispositions.filter((entry) =>
          entry.kind === 'activated' && entry.pendingDepth >= 50 &&
          entry.staggerDelayMs === 0).length });
    }
    if (transition === 'translation') {
      const before = await workerSnapshot();
      const active = before.activeNow.find((entry) => entry.id === TOKENS[0]);
      assert(active, 'Translation fixture message has no active geometry');
      await page.evaluate(() => window.__ytChatOverlay.applySettings({ translationEnabled: true }));
      const enabled = await workerSnapshot();
      assert(Number.isInteger(enabled.config.translationGeneration));
      await page.evaluate(({ id, width, height, generation }) => {
        const record = window.__ytPlacementProbe.workers.find((entry) => entry.ready);
        record.worker.postMessage({ type: 'updateTranslation', id,
          translatedText: 'Fixture translation only', width, height,
          translationHeight: 32, translationGeneration: generation });
      }, { id: TOKENS[0], width: active.width + 80, height: active.height + 32,
        generation: enabled.config.translationGeneration });
      await page.waitForFunction(({ id, width }) => window.__ytPlacementProbe.workers
        .find((record) => record.ready)?.sample?.exact?.activeNow
        ?.some((entry) => entry.id === id && entry.width >= width),
      { id: TOKENS[0], width: active.width + 80 }, { timeout: 10_000 });
      const translated = await workerSnapshot();
      const translatedActive = translated.activeNow.find((entry) => entry.id === TOKENS[0]);
      assert(translatedActive && translatedActive.width >= active.width + 80 &&
        translatedActive.height >= active.height + 32,
      'Injected production translation protocol did not reflow active geometry');
      await page.evaluate(() => window.__ytChatOverlay.applySettings({ translationEnabled: false }));
      const disabled = await workerSnapshot();
      await page.evaluate(({ id, width, height, generation }) => {
        const record = window.__ytPlacementProbe.workers.find((entry) => entry.ready);
        record.worker.postMessage({ type: 'updateTranslation', id, translatedText: null,
          width, height, translationHeight: 0, translationGeneration: generation });
      }, { id: TOKENS[0], width: active.width, height: active.height,
        generation: disabled.config.translationGeneration });
      await page.waitForFunction(({ id, width, height }) => window.__ytPlacementProbe.workers
        .find((record) => record.ready)?.sample?.exact?.activeNow
        ?.some((entry) => entry.id === id && entry.width === width && entry.height === height),
      { id: TOKENS[0], width: active.width, height: active.height }, { timeout: 10_000 });
      const reverted = await workerSnapshot();
      phaseObservations.push({ phase: 'before', active },
        { phase: 'translated', config: translated.config, active: translatedActive,
          provenance: 'test-injected production Worker protocol' },
        { phase: 'translation-off', config: reverted.config,
          active: reverted.activeNow.find((entry) => entry.id === TOKENS[0]) });
    }
    await page.screenshot({ path: join(output, screenshot), animations: 'disabled' });
    screenshotCaptured = true;
    const raw = await captureProbe();
    const selected = forceFallback ? raw : raw.workers.find((worker) => worker.ready)?.sample;
    assert(forceFallback || raw.sourcePrefixed, 'Packaged Worker source was not instrumented');
    assert(forceFallback || raw.sourceHooked, 'Packaged Worker renderer shape changed');
    assert(forceFallback || raw.workers.some((worker) => worker.ready), 'Real Worker did not become ready');
    assert(selected && selected.frames.length > 0, 'No overlay frames were observed');
    assert(forceFallback || selected.exact?.drains?.length > 0, 'No exact Worker drains were observed');
    if (mode === 'top' || mode === 'bottom') {
      assert.equal(selected.exact.config.mode, mode);
      assert(selected.exact.activeNow.some((entry) => ids.includes(entry.id)),
        `No ${mode} message remained active for placement geometry`);
      assert.equal(findOverlappingActivePair(selected.exact.activeNow,
        selected.exact.config.logicalWidth, selected.exact.config.logicalHeight), null,
      `${mode} active messages overlapped`);
    }
    return { status: 'passed', ...probeResult(raw) };
  } catch (error) {
    if (!screenshotCaptured && !page.isClosed()) {
      screenshotCaptured = await page.screenshot({ path: join(output, screenshot),
        animations: 'disabled', timeout: 3000 }).then(() => true, () => false);
    }
    const raw = await captureProbe().catch(() => null);
    return { status: 'failed', ...probeResult(raw),
      errorType: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400),
      assertion: error instanceof assert.AssertionError ? error.message.slice(0, 300) : null };
  } finally {
    if (originalSettings && !page.isClosed()) {
      await page.evaluate((settings) => window.__ytChatOverlay?.applySettings(settings),
        originalSettings).catch(() => {});
      await page.waitForTimeout(350).catch(() => {});
    }
    await page.close();
  }
}

/** Installed Edge: run the same application/parser paths with Worker and forced Canvas fallback. */
export async function runPlacementTimingFixture({ context, root, output, extensionId,
  comparisonOnly = false }) {
  assert.equal(typeof comparisonOnly, 'boolean');
  const scenarios = [];
  for (const scenario of PLACEMENT_SCENARIOS) {
    try {
      scenarios.push(await runScenario({ context, root, output, extensionId,
        comparisonOnly, ...scenario }));
    } catch (error) {
      scenarios.push({ status: 'failed', renderer: scenario.forceFallback ? 'main' : 'worker',
        name: scenario.name, mode: scenario.mode,
        errorType: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400),
        assertion: error instanceof assert.AssertionError ? error.message.slice(0, 300) : null });
    }
  }
  return { status: scenarios.every((scenario) => scenario.status === 'passed') ? 'passed' : 'failed',
    scenarios, comparisonOnly, geometryScope: 'drawn text and outlined ink rectangles',
    preClearScope: 'frame work before first overlay clear, including drain and cleanup' };
}
