// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext } from '@playwright/test';

import {
  installNativePageScriptProbe,
  type NativePageScriptProbe,
} from './native-page-script-probe.ts';
import { buildVisibleWatchHtml } from './visible-watch.ts';

type CanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Rect = { left: number; top: number; right: number; bottom: number };
type InkRun = { text: string; left: number; top: number; width: number; height: number };
type BitmapInk = {
  fill?: { japanese: InkRun | null; [key: string]: unknown };
  stroke?: { japanese: InkRun | null; [key: string]: unknown };
};
type ProbeOptions = {
  worker: boolean;
  tokens: readonly string[];
  forceFallback?: boolean;
  workerPrelude?: string;
  attachProbeSource?: string;
  observeCardPlans?: boolean;
};
type ChatAction = { addChatItemAction: { item: Record<string, unknown> } };
type ScenarioOptions = {
  context: BrowserContext;
  root: string;
  output: string;
  extensionId: string;
  name: string;
  forceFallback: boolean;
  mode: 'scroll' | 'reverse' | 'top' | 'bottom' | 'replay';
  transition?: string;
  comparisonOnly?: boolean;
  spacingOnly?: boolean;
};
type WorkerProbeMessage = {
  id: string;
  height: number;
  text?: string;
  isBacklog?: boolean;
  burstSpeedMultiplier?: number;
  trackDrops?: boolean;
};
type WorkerActive = ActiveRow & {
  startX: number;
  startTime: number;
  pausedDuration: number;
  duration: number;
  laneIndex: number;
  laneSlotCount: number;
  motion?: {
    viewportEntryTime: number;
    actualVelocityPxPerMs: number;
    travelDistancePx: number;
    visibleExitTime: number;
    staggerDelayMs: number;
    isScrolling: boolean;
  };
};
type WorkerRendererProbe = {
  ctx: CanvasContext;
  logicalWidth: number;
  logicalHeight: number;
  laneHeight: number;
  numLanes: number;
  totalPresented?: number;
  laneDensityFactor: number;
  config: {
    danmakuMode: string;
    superChatLayout?: string;
    exitPaddingPx: number;
    reducedMotion: boolean;
    ignoreReducedMotion: boolean;
    laneSpacing: number;
    fontSize: number;
    translationGeneration?: number;
    speedPxPerSec?: number;
    backlogSpeedMultiplier?: number;
    outline?: unknown;
    backgroundColors?: unknown;
    safeTop?: number;
    safeBottom?: number;
    maxConcurrentMessages?: number;
    queueMaxSize?: number;
  } | null;
  pendingQueue: WorkerProbeMessage[];
  activeMessages: WorkerActive[];
  messageById?: Map<string, unknown>;
  imageFetchTasks?: Map<string, unknown>;
  enqueueMessage(message: WorkerProbeMessage): boolean;
  activateMessage(
    message: WorkerProbeMessage,
    frameTime: number,
    placement?: { waitMs?: number; slotCount?: number }
  ): unknown;
  recordDrop(message: WorkerProbeMessage, ...args: unknown[]): unknown;
  checkCollision(...args: unknown[]): boolean;
  findPlacement(...args: unknown[]): unknown;
  drainQueue(...args: unknown[]): unknown;
  renderFrame(...args: unknown[]): unknown;
};
type CanvasProbeMessage = { id: string; isBacklog?: boolean; text?: string };
type CanvasActive = ActiveRow & {
  message: CanvasProbeMessage;
  laneIndex: number;
  slotCount: number;
  startTime: number;
  pausedDuration: number;
  duration: number;
  motion?: {
    durationMs: number;
    actualVelocityPxPerMs: number;
    travelDistancePx: number;
    viewportEntryTime: number;
    visibleExitTime: number;
  };
};
type CanvasObservability = {
  onMessageDropped?: (...args: unknown[]) => unknown;
  onMessagesDropped?: (...args: unknown[]) => unknown;
  getMetrics?: () => { totalPresented?: number; totalPresentationUnknown?: number };
};
type CanvasRendererProbe = {
  ctx: CanvasContext;
  totalPresented?: number;
  pendingQueue: { toArray(): CanvasProbeMessage[]; size: number };
  activeMessages: CanvasActive[];
  imageFetchManager?: { getMetrics?: () => Record<string, unknown> };
  observability?: CanvasObservability;
  overlay: { getDimensions(): { width: number; height: number } | null };
  settings: {
    danmakuMode: string;
    superChatLayout?: string;
    ignoreReducedMotion?: boolean;
    laneSpacing: number;
    fontSize: number;
    safeTop: number;
    safeBottom: number;
    speedPxPerSec: number;
    backlogSpeedMultiplier: number;
    outline: unknown;
    backgroundColors: { normal?: string };
  };
  laneAllocator: { getLaneHeight(): number; getLaneCount(): number };
  currentLaneDensityFactor: number;
  reducedMotion?: boolean;
  enqueueMessage(message: CanvasProbeMessage, ...args: unknown[]): unknown;
  placeQueuedMessage(message: CanvasProbeMessage, ...args: unknown[]): { placed?: boolean } | null;
  drainQueue?(...args: unknown[]): unknown;
  drainQueueAsync?(...args: unknown[]): Promise<unknown>;
  renderFrame(...args: unknown[]): unknown;
};
type ActiveRow = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  startAtEpochMs: number;
  endAtEpochMs: number;
  visibleNow?: boolean;
  isScrolling?: boolean | null;
};
type Draw = {
  id: string;
  frameId: number;
  kind?: string;
  alpha: number;
  backingRatioX?: number;
  backingRatioY?: number;
  rect: Rect | null;
  textSnippet?: string | null;
  japanese?: { text: string; rect: Rect | null } | null;
};
type FrameConfig = {
  renderer?: string;
  mode?: string | null;
  superChatLayout?: string | null;
  fontSize?: number | null;
  laneSpacing?: number | null;
  laneDensityFactor?: number | null;
  safeTop?: number | null;
  safeBottom?: number | null;
  logicalWidth?: number | null;
  logicalHeight?: number | null;
  laneHeight?: number | null;
  backgroundColors?: { normal?: string } | null;
  reducedMotion?: boolean | null;
  ignoreReducedMotion?: boolean | null;
  translationGeneration?: number | null;
  maxConcurrentMessages?: number | null;
  queueMaxSize?: number | null;
  [key: string]: unknown;
};
type RenderFrame = {
  frameId: number;
  startedAtEpochMs: number;
  finishedAtEpochMs: number | null;
  complete: boolean;
  cleared: boolean;
  truncated: boolean;
  failed?: boolean;
  logicalWidth: number | null;
  logicalHeight: number | null;
  backingWidth: number | null;
  backingHeight: number | null;
  backingRatioX: number;
  backingRatioY: number;
  config: FrameConfig;
  active: ActiveRow[];
  draws: Draw[];
  cardPlans: Array<{
    id: string;
    kind: string;
    height: number;
    maxBodyLines: number;
    bodyRows: number;
    bodyY: number | null;
    bodyHeight: number;
    translationRows: number;
    translationY: number | null;
    translationHeight: number;
    borderAlpha: number | null;
    borderStyle: string | null;
  }>;
  lastStroke?: { context: CanvasContext; style: string; alpha: number };
};
type FrameTiming = {
  atEpochMs?: number;
  workMs: number;
  preClearMs?: number | null;
  pendingBefore?: number;
  activeBefore?: number;
  activeAfter?: number;
};
type FrameView = Partial<Omit<RenderFrame, 'config' | 'active' | 'draws'>> & {
  config?: FrameConfig;
  active?: readonly (Partial<ActiveRow> | undefined)[] | null;
  draws?: readonly (Partial<Draw> | undefined)[] | null;
};
type CompleteFrame = RenderFrame & {
  logicalWidth: number;
  logicalHeight: number;
  finishedAtEpochMs: number;
  config: FrameConfig & {
    renderer: string;
    fontSize: number;
    laneSpacing: number;
    laneDensityFactor: number;
    safeTop: number;
    safeBottom: number;
  };
};
type ProbeDisposition = {
  id: string;
  kind: string;
  geometricEntryAtEpochMs?: number | null;
  slotCount?: number | null;
  isScrolling?: boolean | null;
  pendingDepth?: number;
  staggerDelayMs?: number;
  optionalEntryDelayMs?: number | null;
  [key: string]: unknown;
};
type ProbeExact = {
  frames?: FrameTiming[];
  drains?: FrameTiming[];
  dispositions: ProbeDisposition[];
  active?: ActiveRow[];
  activeNow: ActiveRow[];
  pendingNow?: string[];
  queuedNow?: Array<{ id: string; atEpochMs: number }>;
  retained?: Record<string, number | null>;
  config: FrameConfig | null;
  drops: Record<string, number>;
  overflow: number;
  fixtureText?: Record<string, string>;
  presentationCount?: number | null;
  totalPresentationUnknown?: number | null;
  samplesScope?: string;
  [key: string]: unknown;
};
type WorkerExact = ProbeExact & {
  frames: FrameTiming[];
  drains: (FrameTiming & {
    pendingBefore: number;
    pendingAfter: number;
    activeBefore: number;
    activeAfter: number;
    collisionRejects: number;
    placementMisses: number;
  })[];
  active: ActiveRow[];
  collisionRejects: number;
  placementMisses: number;
};
type CanvasExact = ProbeExact & { peaks: { pending: number; active: number } };
type WorkerRecord = {
  ready: boolean;
  stats: Record<string, unknown>[];
  sample: ProbeSample | null;
  worker: Worker;
  flushId?: string | number;
  dueFlushAt?: number;
};
type ProbeSample = {
  frames: FrameTiming[];
  bounds: (Rect & { id: string; atEpochMs: number })[];
  ink: Record<string, unknown>[];
  firstEntry: Record<string, number>;
  ingress: Record<string, number>;
  exact?: ProbeExact;
  latestRenderFrame: RenderFrame | null;
  firstCompleteFrames: Record<string, RenderFrame>;
  measuredPlans?: Record<string, { width: number; height: number; maxBodyLines: number }>;
  overflow: number;
};
type ProbeState = ProbeSample & {
  stats: Record<string, unknown>[];
  workers: WorkerRecord[];
  sourcePrefixed: boolean;
  sourceHooked: boolean;
  ready: boolean;
  canvas: HTMLCanvasElement | OffscreenCanvas | null;
  frameCount: number;
  reportCount: number;
  videoEntry: Record<
    string,
    { atEpochMs: number; videoTimeMs: number; offsetMs: number; videoTimeErrorMs: number }
  >;
  renderFrameId: number;
  currentRenderFrame: RenderFrame | null;
  currentFrame: { startedAt: number; preClearMs: number | null } | null;
  measuredPlans: Record<string, { width: number; height: number; maxBodyLines: number }>;
  requestAtEpochMs?: number;
  flushSequence?: number;
  canvasSourceHooked?: boolean;
  readRegularInsets?: (
    fontSize: number,
    outlineWidthPx: number,
    backgroundVisible: boolean
  ) => unknown;
  beginRenderFrame: (input: {
    ctx: CanvasContext;
    logicalWidth: number | null;
    logicalHeight: number | null;
    config: FrameConfig;
  }) => RenderFrame;
  endRenderFrame: (frame: RenderFrame, active: ActiveRow[]) => void;
};
declare global {
  interface Window {
    __ytPlacementProbe: ProbeState;
    __ytPlacementSetVideoTime: (seconds: number) => void;
    __ytPlacementSetPaused: (paused: boolean) => void;
  }
}

const FIXTURE_URL = 'https://www.youtube.com/watch?v=windows193Placement';
const MIXED_IDS: [string, string] = ['WINDOWS204_MIX_REGULAR', 'WINDOWS204_MIX_PAID'];
const TOKENS = [
  'WINDOWS193_SHORT',
  'WINDOWS193_LONG',
  'WINDOWS193_REVERSE',
  'WINDOWS193_REPLAY_DUE',
  'WINDOWS193_REPLAY_NEXT',
  'WINDOWS193_REPLAY_FUTURE',
  'WINDOWS193_REDUCED',
  'WINDOWS193_OVERRIDE',
  'WINDOWS193_TRANSITION',
  'WINDOWS193_EXPANDED',
  'WINDOWS193_OVERRIDE_OFF',
  'WINDOWS193_SYSTEM_OFF',
  'WINDOWS193_PAID',
  'WINDOWS196_GAP0_A',
  'WINDOWS196_GAP0_B',
  'WINDOWS196_GAP8_A',
  'WINDOWS196_GAP8_B',
  'WINDOWS195_BACKLOG_LONG',
  ...Array.from({ length: 10 }, (_, index) => `WINDOWS196_GAP0_${String(index).padStart(2, '0')}`),
  ...Array.from({ length: 10 }, (_, index) => `WINDOWS196_GAP8_${String(index).padStart(2, '0')}`),
  ...MIXED_IDS,
] as const;
const MAX_SAMPLES = 240;
export const MIXED_PRESSURE_COUNT = 40;
export const MIXED_PRESSURE_CHUNK_SIZE = 4;
export const MIXED_BURST_SETTINGS = Object.freeze({
  burstSampleWindow: 3,
  burstElevatedThreshold: 2,
  burstHighThreshold: 5,
  burstExtremeThreshold: 10,
});

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
  {
    name: 'worker-spacing-speed',
    forceFallback: false,
    mode: 'scroll',
    transition: 'spacing-speed',
  },
  { name: 'main-spacing-speed', forceFallback: true, mode: 'scroll', transition: 'spacing-speed' },
  { name: 'worker-mixed-gap', forceFallback: false, mode: 'top', transition: 'mixed-gap' },
  { name: 'main-mixed-gap', forceFallback: true, mode: 'top', transition: 'mixed-gap' },
] as const);

export function spacingFixtureIds() {
  return {
    gap0: [...TOKENS.slice(13, 15), ...TOKENS.slice(18, 28)],
    gap8: [...TOKENS.slice(15, 17), ...TOKENS.slice(28, 38)],
  };
}

function installProbeRuntime(options: ProbeOptions) {
  const MAX_SAMPLES = 240;
  const scope = globalThis as typeof globalThis & {
    __ytPlacementProbe?: ProbeState;
    postMessage(message: unknown): void;
  };
  const ids = new Set(options.tokens);
  const bitmapIds = new WeakMap<object, string>();
  const bitmapInk = new WeakMap<object, BitmapInk>();
  const frameContexts = new WeakMap<RenderFrame, CanvasContext>();
  const state = {
    frames: [],
    bounds: [],
    ink: [],
    firstEntry: {},
    ingress: {},
    stats: [],
    workers: [],
    sourcePrefixed: false,
    sourceHooked: false,
    overflow: 0,
    ready: false,
    canvas: null,
    frameCount: 0,
    reportCount: 0,
    videoEntry: {},
    renderFrameId: 0,
    latestRenderFrame: null,
    firstCompleteFrames: {},
    currentRenderFrame: null,
    currentFrame: null,
    measuredPlans: {},
  } as unknown as ProbeState;
  scope.__ytPlacementProbe = state;
  const epochNow = () => performance.timeOrigin + performance.now();
  const tokenIn = (text: unknown) => options.tokens.find((token) => String(text).includes(token));
  const overlayContext = (ctx: CanvasContext) =>
    options.worker
      ? ctx.canvas === state.canvas
      : 'closest' in ctx.canvas && Boolean(ctx.canvas.closest('#yt-live-chat-overlay'));
  const japaneseRun = (text: string, ctx: CanvasContext, x: number, y: number) => {
    const match = /[\u3040-\u30ff\u3400-\u9fff]+/u.exec(String(text));
    if (!match) return null;
    const startX = x + ctx.measureText(String(text).slice(0, match.index)).width;
    const metrics = ctx.measureText(match[0]);
    return {
      text: match[0],
      left: startX - (metrics.actualBoundingBoxLeft ?? 0),
      top: y - metrics.actualBoundingBoxAscent,
      width:
        (metrics.actualBoundingBoxLeft ?? 0) + (metrics.actualBoundingBoxRight ?? metrics.width),
      height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
    };
  };
  const transformedRect = (
    ctx: CanvasContext,
    x: number,
    y: number,
    width: number,
    height: number
  ): Rect | null => {
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    const transform = ctx.getTransform();
    const points = (
      [
        [x, y],
        [x + width, y],
        [x, y + height],
        [x + width, y + height],
      ] satisfies [number, number][]
    ).map(([px, py]) => ({
      x: transform.a * px + transform.c * py + transform.e,
      y: transform.b * px + transform.d * py + transform.f,
    }));
    return {
      left: Math.min(...points.map((point) => point.x)),
      top: Math.min(...points.map((point) => point.y)),
      right: Math.max(...points.map((point) => point.x)),
      bottom: Math.max(...points.map((point) => point.y)),
    };
  };
  const logicalRect = (
    rect: Rect | null,
    frame: { backingRatioX: number; backingRatioY: number } | null
  ) =>
    rect && frame && frame.backingRatioX > 0 && frame.backingRatioY > 0
      ? {
          left: rect.left / frame.backingRatioX,
          top: rect.top / frame.backingRatioY,
          right: rect.right / frame.backingRatioX,
          bottom: rect.bottom / frame.backingRatioY,
        }
      : null;
  state.beginRenderFrame = ({ ctx, logicalWidth, logicalHeight, config }) => {
    const backingWidth = ctx?.canvas?.width ?? null;
    const backingHeight = ctx?.canvas?.height ?? null;
    const frame: RenderFrame = {
      frameId: ++state.renderFrameId,
      startedAtEpochMs: epochNow(),
      finishedAtEpochMs: null,
      complete: false,
      cleared: false,
      truncated: false,
      logicalWidth,
      logicalHeight,
      backingWidth,
      backingHeight,
      backingRatioX: Number(backingWidth) / Number(logicalWidth),
      backingRatioY: Number(backingHeight) / Number(logicalHeight),
      config,
      active: [],
      draws: [],
      cardPlans: [],
    };
    if (ctx) frameContexts.set(frame, ctx);
    state.currentRenderFrame = frame;
    return frame;
  };
  state.endRenderFrame = (frame, active) => {
    frame.finishedAtEpochMs = epochNow();
    const ctx = frameContexts.get(frame);
    frame.backingWidth = ctx?.canvas?.width ?? null;
    frame.backingHeight = ctx?.canvas?.height ?? null;
    frame.backingRatioX = Number(frame.backingWidth) / Number(frame.logicalWidth);
    frame.backingRatioY = Number(frame.backingHeight) / Number(frame.logicalHeight);
    frame.complete =
      !frame.failed &&
      frame.cleared &&
      Number.isFinite(frame.backingRatioX) &&
      frame.backingRatioX > 0 &&
      Number.isFinite(frame.backingRatioY) &&
      frame.backingRatioY > 0 &&
      frame.config?.logicalWidth === frame.logicalWidth &&
      frame.config?.logicalHeight === frame.logicalHeight &&
      frame.draws.every(
        (draw) =>
          draw.backingRatioX === frame.backingRatioX && draw.backingRatioY === frame.backingRatioY
      );
    if (active.length > MAX_SAMPLES) frame.truncated = true;
    frame.active = active.slice(0, MAX_SAMPLES);
    delete frame.lastStroke;
    state.latestRenderFrame = frame;
    const width = frame.logicalWidth;
    const height = frame.logicalHeight;
    if (frame.complete && !frame.truncated && width && height) {
      const layout = frame.config.superChatLayout === 'wide' ? 'wide' : 'stacked';
      for (const row of frame.active) {
        if (!row.id.startsWith('WINDOWS380_') || !ids.has(row.id)) continue;
        if (
          row.width <= 0 ||
          row.height <= 0 ||
          row.x >= width ||
          row.x + row.width <= 0 ||
          row.y >= height ||
          row.y + row.height <= 0
        )
          continue;
        const key = `${row.id}|${layout}`;
        if (
          state.firstCompleteFrames[key] ||
          Object.keys(state.firstCompleteFrames).length >= MAX_SAMPLES
        )
          continue;
        const draws = frame.draws.filter((draw) => draw.id === row.id);
        if (
          !draws.some(
            (draw) =>
              draw.alpha > 0 &&
              draw.rect &&
              draw.rect.left < width &&
              draw.rect.right > 0 &&
              draw.rect.top < height &&
              draw.rect.bottom > 0
          )
        )
          continue;
        state.firstCompleteFrames[key] = {
          ...frame,
          active: [row],
          draws,
          cardPlans: frame.cardPlans.filter((plan) => plan.id === row.id),
        };
      }
    }
    if (state.currentRenderFrame === frame) state.currentRenderFrame = null;
  };
  const recordRect = (
    ctx: CanvasContext,
    id: string | undefined,
    x: number,
    y: number,
    width: number,
    height: number,
    kind = 'image',
    ink: (Record<string, unknown> & { japanese?: InkRun | null }) | null = null
  ) => {
    if (!id || !overlayContext(ctx)) return;
    const rect = transformedRect(ctx, x, y, width, height);
    if (!rect) return;
    const bound = { id, atEpochMs: epochNow(), ...rect };
    const frame = state.currentRenderFrame;
    if (frame && frame.draws.length < MAX_SAMPLES) {
      const backingRatioX = ctx.canvas.width / Number(frame.logicalWidth);
      const backingRatioY = ctx.canvas.height / Number(frame.logicalHeight);
      const ratios = { backingRatioX, backingRatioY };
      const japanese = ink?.japanese ?? null;
      frame.draws.push({
        id,
        frameId: frame.frameId,
        kind,
        alpha: ctx.globalAlpha,
        ...ratios,
        rect: logicalRect(rect, ratios),
        textSnippet:
          typeof ink?.textSnippet === 'string'
            ? ink.textSnippet
            : typeof (ink?.sourceInk as BitmapInk | undefined)?.fill?.textSnippet === 'string'
              ? ((ink?.sourceInk as BitmapInk | undefined)?.fill?.textSnippet as string)
              : null,
        japanese: japanese
          ? {
              text: japanese.text,
              rect: logicalRect(
                transformedRect(ctx, japanese.left, japanese.top, japanese.width, japanese.height),
                ratios
              ),
            }
          : null,
      });
    } else if (frame) frame.truncated = true;
    if (ctx.globalAlpha <= 0) return;
    if (state.bounds.length < MAX_SAMPLES) state.bounds.push(bound);
    else state.overflow++;
    if (ink) {
      if (state.ink.length < MAX_SAMPLES) state.ink.push({ ...bound, kind, ...ink });
      else state.overflow++;
    }
    // Bounds and viewport use backing-store pixels after applying the transform.
    const canvasWidth = ctx.canvas.width;
    const canvasHeight = ctx.canvas.height;
    if (
      bound.right > 0 &&
      bound.left < canvasWidth &&
      bound.bottom > 0 &&
      bound.top < canvasHeight
    ) {
      state.firstEntry[id] ??= bound.atEpochMs;
    }
  };
  const canvasPrototypes = [
    scope.CanvasRenderingContext2D?.prototype,
    scope.OffscreenCanvasRenderingContext2D?.prototype,
  ].filter(Boolean);
  for (const prototype of canvasPrototypes) {
    const nativeStroke = prototype.stroke;
    prototype.stroke = function (this: CanvasContext, ...args) {
      const frame = state.currentRenderFrame;
      if (frame && overlayContext(this)) {
        const style = String(this.strokeStyle);
        const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/u.exec(style);
        frame.lastStroke = {
          context: this,
          style,
          alpha: rgba ? Number(rgba[1]) * this.globalAlpha : this.globalAlpha,
        };
      }
      return Reflect.apply(nativeStroke, this, args);
    } as CanvasRenderingContext2D['stroke'];
    const nativeFillText = prototype.fillText;
    prototype.fillText = function (text, x, y, ...rest) {
      const id = tokenIn(text);
      const result = nativeFillText.call(this, text, x, y, ...rest);
      if (id && !overlayContext(this)) {
        bitmapIds.set(this.canvas, id);
        const metrics = this.measureText(text);
        bitmapInk.set(this.canvas, {
          ...bitmapInk.get(this.canvas),
          fill: {
            textSnippet: String(text).slice(0, 128),
            font: this.font,
            left: x - (metrics.actualBoundingBoxLeft ?? 0),
            top: y - metrics.actualBoundingBoxAscent,
            width:
              (metrics.actualBoundingBoxLeft ?? 0) +
              (metrics.actualBoundingBoxRight ?? metrics.width),
            height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
            japanese: (() => {
              const run = japaneseRun(text, this, x, y);
              if (!run) return null;
              const rect = transformedRect(this, run.left, run.top, run.width, run.height);
              return rect
                ? {
                    text: run.text,
                    left: rect.left,
                    top: rect.top,
                    width: rect.right - rect.left,
                    height: rect.bottom - rect.top,
                  }
                : null;
            })(),
          },
        });
      }
      if (id && overlayContext(this)) {
        const metrics = this.measureText(text);
        const left = metrics.actualBoundingBoxLeft ?? 0;
        const right = metrics.actualBoundingBoxRight ?? metrics.width;
        recordRect(
          this,
          id,
          x - left,
          y - metrics.actualBoundingBoxAscent,
          left + right,
          metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
          'fill',
          {
            font: this.font,
            lineWidth: this.lineWidth,
            textSnippet: String(text).slice(0, 128),
            japanese: japaneseRun(text, this, x, y),
          }
        );
      }
      return result;
    };
    const nativeStrokeText = prototype.strokeText;
    prototype.strokeText = function (text, x, y, ...rest) {
      const id = tokenIn(text);
      const result = nativeStrokeText.call(this, text, x, y, ...rest);
      if (id && !overlayContext(this)) {
        const metrics = this.measureText(text);
        const padding = this.lineWidth / 2;
        bitmapInk.set(this.canvas, {
          ...bitmapInk.get(this.canvas),
          stroke: {
            textSnippet: String(text).slice(0, 128),
            font: this.font,
            lineWidth: this.lineWidth,
            left: x - (metrics.actualBoundingBoxLeft ?? 0) - padding,
            top: y - metrics.actualBoundingBoxAscent - padding,
            width:
              (metrics.actualBoundingBoxLeft ?? 0) +
              (metrics.actualBoundingBoxRight ?? metrics.width) +
              padding * 2,
            height:
              metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent + padding * 2,
            japanese: (() => {
              const run = japaneseRun(text, this, x, y);
              if (!run) return null;
              const rect = transformedRect(this, run.left, run.top, run.width, run.height);
              return rect
                ? {
                    text: run.text,
                    left: rect.left,
                    top: rect.top,
                    width: rect.right - rect.left,
                    height: rect.bottom - rect.top,
                  }
                : null;
            })(),
          },
        });
      }
      if (id && overlayContext(this)) {
        const metrics = this.measureText(text);
        const left = metrics.actualBoundingBoxLeft ?? 0;
        const right = metrics.actualBoundingBoxRight ?? metrics.width;
        const padding = this.lineWidth / 2;
        recordRect(
          this,
          id,
          x - left - padding,
          y - metrics.actualBoundingBoxAscent - padding,
          left + right + padding * 2,
          metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent + padding * 2,
          'stroke',
          {
            font: this.font,
            lineWidth: this.lineWidth,
            textSnippet: String(text).slice(0, 128),
            japanese: japaneseRun(text, this, x, y),
          }
        );
      }
      return result;
    };
    const nativeDrawImage = prototype.drawImage;
    prototype.drawImage = function (
      this: CanvasContext,
      image: CanvasImageSource,
      ...args: number[]
    ) {
      const stickerId =
        overlayContext(this) &&
        'width' in image &&
        'height' in image &&
        image.width === 8 &&
        image.height === 4
          ? Object.keys(state.ingress).find(
              (entry) =>
                ids.has(entry) && /^WINDOWS380_(BRIGHT|DARK|DETAILED)_STICKER$/u.test(entry)
            )
          : undefined;
      const id = bitmapIds.get(image) ?? stickerId;
      const result = Reflect.apply(nativeDrawImage, this, [image, ...args]);
      if (
        id &&
        overlayContext(this) &&
        'width' in image &&
        'height' in image &&
        typeof image.width === 'number' &&
        typeof image.height === 'number'
      ) {
        const destination: [number, number, number, number] | null =
          args.length === 2
            ? [Number(args[0]), Number(args[1]), image.width, image.height]
            : args.length === 4
              ? [Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3])]
              : args.length === 8
                ? [Number(args[4]), Number(args[5]), Number(args[6]), Number(args[7])]
                : null;
        if (destination) {
          const sourceInk = bitmapInk.get(image) ?? null;
          const run = sourceInk?.fill?.japanese ?? sourceInk?.stroke?.japanese ?? null;
          const [sourceX, sourceY, sourceWidth, sourceHeight] =
            args.length === 8
              ? [Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3])]
              : [0, 0, image.width, image.height];
          const [destX, destY, destWidth, destHeight] = destination;
          const runLeft = run ? Math.max(run.left, sourceX) : 0;
          const runTop = run ? Math.max(run.top, sourceY) : 0;
          const runRight = run ? Math.min(run.left + run.width, sourceX + sourceWidth) : 0;
          const runBottom = run ? Math.min(run.top + run.height, sourceY + sourceHeight) : 0;
          const japanese =
            run && sourceWidth > 0 && sourceHeight > 0 && runRight > runLeft && runBottom > runTop
              ? {
                  text: run.text,
                  left: destX + ((runLeft - sourceX) * destWidth) / sourceWidth,
                  top: destY + ((runTop - sourceY) * destHeight) / sourceHeight,
                  width: ((runRight - runLeft) * destWidth) / sourceWidth,
                  height: ((runBottom - runTop) * destHeight) / sourceHeight,
                }
              : null;
          recordRect(this, id, ...destination, id === stickerId ? 'sticker-image' : 'bitmap', {
            sourceInk,
            japanese,
          });
        }
      }
      return result;
    } as CanvasRenderingContext2D['drawImage'];
    const nativeClearRect = prototype.clearRect;
    prototype.clearRect = function (...args) {
      const result = nativeClearRect.call(this, ...args);
      const renderFrame = state.currentRenderFrame;
      if (
        overlayContext(this) &&
        renderFrame &&
        args.length >= 4 &&
        args[0] <= 0 &&
        args[1] <= 0 &&
        args[0] + args[2] >= Number(renderFrame.logicalWidth) &&
        args[1] + args[3] >= Number(renderFrame.logicalHeight)
      ) {
        renderFrame.cleared = true;
        renderFrame.draws.length = 0;
      }
      if (overlayContext(this) && state.currentFrame && state.currentFrame.preClearMs === null) {
        state.currentFrame.preClearMs = performance.now() - state.currentFrame.startedAt;
      }
      return result;
    };
  }
  const nativeRaf = scope.requestAnimationFrame.bind(scope);
  scope.requestAnimationFrame = (callback) =>
    nativeRaf((timestamp) => {
      const frame = { startedAt: performance.now(), preClearMs: null };
      state.currentFrame = frame;
      try {
        callback(timestamp);
      } finally {
        if (frame.preClearMs !== null) {
          state.frameCount++;
          if (state.frames.length < MAX_SAMPLES) {
            state.frames.push({
              atEpochMs: epochNow(),
              workMs: performance.now() - frame.startedAt,
              preClearMs: frame.preClearMs,
            });
          } else state.overflow++;
          if (options.worker && state.frameCount % 30 === 0 && state.reportCount++ < 20) {
            scope.postMessage({
              type: 'ytPlacementProbe',
              sample: {
                frames: state.frames,
                bounds: state.bounds,
                ink: state.ink,
                firstEntry: state.firstEntry,
                ingress: state.ingress,
                exact: state.exact,
                latestRenderFrame: state.latestRenderFrame,
                firstCompleteFrames: state.firstCompleteFrames,
                measuredPlans: state.measuredPlans,
                overflow: state.overflow,
              },
            });
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
        if (state.exact.frames) state.exact.frames.length = 0;
        if (state.exact.drains) state.exact.drains.length = 0;
        if (state.exact.active) state.exact.active.length = 0;
        state.exact.samplesScope = 'congestion phase';
      }
      if (event.data?.type === 'ytPlacementResetIssueInk') {
        state.bounds.length = 0;
        state.ink.length = 0;
      }
      if (event.data?.type === 'ytPlacementFlush') {
        scope.postMessage({
          type: 'ytPlacementProbe',
          requestId: event.data.requestId,
          sample: {
            frames: state.frames,
            bounds: state.bounds,
            ink: state.ink,
            firstEntry: state.firstEntry,
            ingress: state.ingress,
            exact: state.exact,
            latestRenderFrame: state.latestRenderFrame,
            firstCompleteFrames: state.firstCompleteFrames,
            measuredPlans: state.measuredPlans,
            overflow: state.overflow,
          },
        });
      }
    });
    return;
  }
  const replayOffsets: Record<string, number> = {
    WINDOWS193_REPLAY_DUE: 10000,
    WINDOWS193_REPLAY_NEXT: 10001,
    WINDOWS193_REPLAY_FUTURE: 11500,
  };
  new MutationObserver(() => {
    for (const element of document.querySelectorAll<HTMLElement>(
      '.yt-live-chat-overlay-live-region > p'
    )) {
      const id = element.dataset.messageId;
      if (id && ids.has(id) && !state.videoEntry[id] && replayOffsets[id] !== undefined) {
        const videoTimeMs =
          (document.querySelector<HTMLVideoElement>('video')?.currentTime ?? NaN) * 1000;
        const offsetMs = replayOffsets[id] ?? NaN;
        state.videoEntry[id] = {
          atEpochMs: epochNow(),
          videoTimeMs,
          offsetMs,
          videoTimeErrorMs: videoTimeMs - offsetMs,
        };
      }
    }
  }).observe(document, { childList: true, subtree: true });
  if (options.forceFallback) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
      configurable: true,
      value: () => {
        throw new Error('Acceptance fixture selected the Canvas fallback');
      },
    });
  } else {
    const NativeBlob = scope.Blob;
    scope.Blob = new Proxy(NativeBlob, {
      construct(target, args) {
        const [parts, optionsArg] = args;
        if (
          optionsArg?.type === 'text/javascript' &&
          parts?.length === 1 &&
          typeof parts[0] === 'string' &&
          parts[0].includes('OffscreenCanvas')
        ) {
          state.sourcePrefixed = true;
          const source = options.observeCardPlans ? instrumentCardPlanCalls(parts[0]) : parts[0];
          const suffix = source
            ? workerProbeSuffix(source, options.attachProbeSource, options.observeCardPlans)
            : null;
          state.sourceHooked = Boolean(suffix);
          return Reflect.construct(target, [
            [options.workerPrelude, source ?? parts[0], suffix ?? ''],
            optionsArg,
          ]);
        }
        return Reflect.construct(target, args);
      },
    });
  }
  const NativeWorker = scope.Worker;
  scope.Worker = new Proxy(NativeWorker, {
    construct(target, args) {
      const worker = Reflect.construct(target, args) as Worker;
      const record: WorkerRecord = { ready: false, stats: [], sample: null, worker };
      state.workers.push(record);
      worker.addEventListener('message', (event) => {
        const data = event.data as {
          type?: string;
          activeMessages?: number;
          pendingQueueDepth?: number;
          totalRendered?: number;
          totalPresented?: number;
          totalDrops?: number;
          sample?: ProbeSample;
          requestId?: string | number;
        } | null;
        if (data?.type === 'ready') record.ready = true;
        if (data?.type === 'stats' && record.stats.length < 60) {
          const { activeMessages, pendingQueueDepth, totalRendered, totalPresented, totalDrops } =
            data;
          record.stats.push({
            atEpochMs: epochNow(),
            activeMessages,
            pendingQueueDepth,
            totalRendered,
            totalPresented,
            totalDrops,
          });
        }
        if (data?.type === 'ytPlacementProbe') {
          record.sample = data.sample ?? null;
          if (data.requestId !== undefined) record.flushId = data.requestId;
        }
      });
      const nativePostMessage = worker.postMessage.bind(worker);
      worker.postMessage = ((
        message: { type?: string; messages?: { id: string }[] },
        transfer?: Transferable[]
      ) => {
        if (message?.type === 'addMessages') {
          for (const entry of message.messages ?? []) {
            if (ids.has(entry.id)) state.ingress[entry.id] ??= epochNow();
          }
        }
        if (transfer === undefined) Reflect.apply(nativePostMessage, worker, [message]);
        else Reflect.apply(nativePostMessage, worker, [message, transfer]);
      }) as Worker['postMessage'];
      return worker;
    },
  });
}

export function summarizeSamples(values: (number | null | undefined)[]) {
  const samples = values
    .filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
    )
    .toSorted((left, right) => left - right);
  if (samples.length === 0) return { count: 0, p50: null, p95: null, max: null };
  return {
    count: samples.length,
    p50: samples[Math.ceil(samples.length * 0.5) - 1],
    p95: samples[Math.ceil(samples.length * 0.95) - 1],
    max: samples.at(-1),
  };
}

export function summarizeExactWorkerProbe(
  selected:
    | {
        exact?:
          | {
              frames?: { workMs: number }[];
              drains?: { workMs: number }[];
              dispositions?: unknown[];
              active?: unknown[];
            }
          | undefined;
      }
    | null
    | undefined,
  renderer: string
) {
  if (renderer !== 'worker' || !selected?.exact) {
    return { exactWorkerFrameMs: null, exactWorkerDrainMs: null, exactWorker: null };
  }
  const exact = selected.exact;
  assert(
    exact.frames && exact.drains && exact.dispositions && exact.active,
    'Incomplete exact Worker sample'
  );
  return {
    exactWorkerFrameMs: summarizeSamples(exact.frames.map((frame) => frame.workMs)),
    exactWorkerDrainMs: summarizeSamples(exact.drains.map((drain) => drain.workMs)),
    exactWorker: {
      ...exact,
      dispositions: exact.dispositions.slice(0, MAX_SAMPLES),
      active: exact.active.slice(0, MAX_SAMPLES),
    },
  };
}

export function findOverlappingActivePair(
  messages: (Pick<ActiveRow, 'id' | 'x' | 'y' | 'width' | 'height'> & { visibleNow?: boolean })[],
  width: number,
  height: number
) {
  const visible = messages.filter(
    (item) =>
      item.x < width &&
      item.x + item.width > 0 &&
      item.y < height &&
      item.y + item.height > 0 &&
      item.visibleNow !== false
  );
  for (let left = 0; left < visible.length; left++) {
    for (let right = left + 1; right < visible.length; right++) {
      const a = visible[left];
      const b = visible[right];
      if (!a || !b) continue;
      if (
        a.x < b.x + b.width - 1 &&
        b.x < a.x + a.width - 1 &&
        a.y < b.y + b.height - 1 &&
        b.y < a.y + a.height - 1
      ) {
        return [a.id, b.id];
      }
    }
  }
  return null;
}

/** Smallest sampled allocation-origin distance; adjacent lane occupancy is not established. */
export function measureAllocationRowPitch(
  messages: { id?: string; y: number; height: number }[],
  prefix = 'WINDOWS196_GAP0_'
) {
  const ys = messages
    .filter(
      (entry) =>
        entry.id?.startsWith(prefix) && Number.isFinite(entry.y) && Number.isFinite(entry.height)
    )
    .map((entry) => entry.y)
    .toSorted((a, b) => a - b);
  const pitches = ys
    .slice(1)
    .map((y, index) => y - (ys[index] ?? y))
    .filter((pitch) => pitch > 0);
  return pitches.length ? Math.min(...pitches) : null;
}

/** Sampled row origins in one completed frame, not proven adjacency or a historical ink join. */
export function measureVisibleRowPitch(
  frame: FrameView | null | undefined,
  prefix = 'WINDOWS196_GAP0_'
) {
  const result: {
    pitchPx: number | null;
    status: string;
    reason: string | null;
    frameId: number | null;
    includedIds: string[];
    excluded: { id: string; reason: string }[];
    unknownIds: string[];
    japaneseVisibleIds: string[];
    japaneseVisibleRowOriginsPx: number[];
  } = {
    pitchPx: null,
    status: 'unknown',
    reason: null,
    frameId: frame?.frameId ?? null,
    includedIds: [],
    excluded: [],
    unknownIds: [],
    japaneseVisibleIds: [],
    japaneseVisibleRowOriginsPx: [],
  };
  const unknown = (reason: string, id?: string) => {
    result.reason = reason;
    if (id) result.unknownIds.push(id);
    return result;
  };
  if (
    !frame ||
    !Number.isSafeInteger(frame.frameId) ||
    Number(frame.frameId) <= 0 ||
    frame.complete !== true ||
    frame.truncated !== false ||
    !Number.isFinite(frame.startedAtEpochMs) ||
    !Number.isFinite(frame.finishedAtEpochMs) ||
    Number(frame.finishedAtEpochMs) < Number(frame.startedAtEpochMs) ||
    !Number.isFinite(frame.logicalWidth) ||
    Number(frame.logicalWidth) <= 0 ||
    !Number.isFinite(frame.logicalHeight) ||
    Number(frame.logicalHeight) <= 0 ||
    !Number.isFinite(frame.backingRatioX) ||
    Number(frame.backingRatioX) <= 0 ||
    !Number.isFinite(frame.backingRatioY) ||
    Number(frame.backingRatioY) <= 0 ||
    !['main', 'worker'].includes(frame.config?.renderer ?? '') ||
    !Number.isFinite(frame.config?.fontSize) ||
    !Number.isFinite(frame.config?.laneSpacing) ||
    !Array.isArray(frame.active) ||
    !Array.isArray(frame.draws)
  ) {
    return unknown('incomplete_or_unsupported_frame');
  }
  const measuredFrame = frame as CompleteFrame;
  const intersects = (rect: Rect | null | undefined): rect is Rect =>
    Boolean(
      rect &&
      [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite) &&
      rect.right > rect.left &&
      rect.bottom > rect.top &&
      rect.left < measuredFrame.logicalWidth &&
      rect.right > 0 &&
      rect.top < measuredFrame.logicalHeight &&
      rect.bottom > 0
    );
  const tracked = measuredFrame.active.filter(
    (row) => typeof row?.id === 'string' && row.id.startsWith(prefix)
  );
  const ids = new Set();
  const unmatchedDraw = measuredFrame.draws.find(
    (draw) =>
      typeof draw?.id === 'string' &&
      draw.id.startsWith(prefix) &&
      !tracked.some((row) => row.id === draw.id)
  );
  if (unmatchedDraw) return unknown('draw_without_active_row', unmatchedDraw.id);
  const visible = [];
  const japaneseRows = new Set<number>();
  for (const row of tracked) {
    if (ids.has(row.id)) return unknown('duplicate_active_id', row.id);
    ids.add(row.id);
    if (
      ![row.x, row.y, row.width, row.height, row.startAtEpochMs, row.endAtEpochMs].every(
        Number.isFinite
      ) ||
      row.width <= 0 ||
      row.height <= 0 ||
      row.endAtEpochMs <= row.startAtEpochMs
    )
      return unknown('invalid_active_geometry_or_time', row.id);
    if (measuredFrame.finishedAtEpochMs < row.startAtEpochMs) {
      result.excluded.push({ id: row.id, reason: 'future' });
      continue;
    }
    if (measuredFrame.startedAtEpochMs >= row.endAtEpochMs) {
      result.excluded.push({ id: row.id, reason: 'expired' });
      continue;
    }
    if (
      measuredFrame.startedAtEpochMs < row.startAtEpochMs ||
      measuredFrame.finishedAtEpochMs >= row.endAtEpochMs
    )
      return unknown('eligibility_changed_during_frame', row.id);
    const rowRect = {
      left: row.x,
      top: row.y,
      right: row.x + row.width,
      bottom: row.y + row.height,
    };
    if (!intersects(rowRect)) {
      result.excluded.push({ id: row.id, reason: 'offscreen_row' });
      continue;
    }
    const draws = measuredFrame.draws.filter((draw) => draw?.id === row.id);
    if (draws.some((draw) => draw.frameId !== measuredFrame.frameId)) {
      return unknown('draw_frame_mismatch', row.id);
    }
    if (draws.length === 0) {
      result.excluded.push({ id: row.id, reason: 'no_current_frame_draw' });
      continue;
    }
    if (
      draws.some(
        (draw) =>
          !Number.isFinite(draw.alpha) ||
          draw.alpha < 0 ||
          draw.alpha > 1 ||
          !draw.rect ||
          ![draw.rect.left, draw.rect.top, draw.rect.right, draw.rect.bottom].every(Number.isFinite)
      )
    )
      return unknown('invalid_draw_geometry_or_alpha', row.id);
    if (draws.every((draw) => draw.alpha <= 0)) {
      result.excluded.push({ id: row.id, reason: 'zero_alpha' });
      continue;
    }
    const painted = draws.filter(
      (draw): draw is Draw & { rect: Rect } => draw.alpha > 0 && intersects(draw.rect)
    );
    if (
      painted.some(
        (draw) =>
          draw.rect.left >= rowRect.right ||
          draw.rect.right <= rowRect.left ||
          draw.rect.top >= rowRect.bottom ||
          draw.rect.bottom <= rowRect.top
      )
    )
      return unknown('draw_row_mismatch', row.id);
    if (painted.length === 0) {
      result.excluded.push({ id: row.id, reason: 'offscreen_draw' });
      continue;
    }
    visible.push(row);
    result.includedIds.push(row.id);
    if (painted.some((draw) => draw.japanese?.text && intersects(draw.japanese.rect))) {
      result.japaneseVisibleIds.push(row.id);
      japaneseRows.add(row.y);
    }
  }
  result.japaneseVisibleRowOriginsPx = [...japaneseRows].toSorted((a, b) => a - b);
  const ys = [...new Set(visible.map((row) => row.y))].toSorted((a, b) => a - b);
  const pitches = ys
    .slice(1)
    .map((y, index) => y - (ys[index] ?? y))
    .filter((pitch) => pitch > 0);
  if (pitches.length === 0) {
    result.status = 'insufficient';
    result.reason = 'fewer_than_two_distinct_visible_rows';
    return result;
  }
  result.status = 'measured';
  result.pitchPx = Math.min(...pitches);
  return result;
}

/** Content-rectangle clearance of both fixture rows painted in one completed frame. */
export function measureMixedHeightClearance(frame: FrameView | null | undefined) {
  const result: {
    status: string;
    reason: string | null;
    frameId: number | null;
    observedLaneDensityFactor: number | null;
    paintedIds: string[];
    heightsPx: number[];
    pairs: { ids: string[]; gapPx: number }[];
    minimumGapPx: number | null;
  } = {
    status: 'unknown',
    reason: null,
    frameId: frame?.frameId ?? null,
    observedLaneDensityFactor: frame?.config?.laneDensityFactor ?? null,
    paintedIds: [],
    heightsPx: [],
    pairs: [],
    minimumGapPx: null,
  };
  const unknown = (reason: string) => {
    result.reason = reason;
    return result;
  };
  if (
    !frame ||
    !Number.isSafeInteger(frame.frameId) ||
    Number(frame.frameId) <= 0 ||
    frame.complete !== true ||
    frame.truncated !== false ||
    !Number.isFinite(frame.startedAtEpochMs) ||
    !Number.isFinite(frame.finishedAtEpochMs) ||
    Number(frame.finishedAtEpochMs) < Number(frame.startedAtEpochMs) ||
    !Number.isFinite(frame.logicalWidth) ||
    Number(frame.logicalWidth) <= 0 ||
    !Number.isFinite(frame.logicalHeight) ||
    Number(frame.logicalHeight) <= 0 ||
    !Number.isFinite(frame.backingRatioX) ||
    Number(frame.backingRatioX) <= 0 ||
    !Number.isFinite(frame.backingRatioY) ||
    Number(frame.backingRatioY) <= 0 ||
    !['main', 'worker'].includes(frame.config?.renderer ?? '') ||
    frame.config?.mode !== 'top' ||
    frame.config?.laneSpacing !== 8 ||
    !Number.isFinite(frame.config?.laneDensityFactor) ||
    !Number.isFinite(frame.config.safeTop) ||
    !Number.isFinite(frame.config.safeBottom) ||
    Number(frame.config?.safeTop) < 0 ||
    Number(frame.config?.safeBottom) < 0 ||
    Number(frame.config?.safeTop) + Number(frame.config?.safeBottom) >= 1 ||
    !Array.isArray(frame.active) ||
    !Array.isArray(frame.draws)
  ) {
    return unknown('incomplete_or_unsupported_frame');
  }
  const measuredFrame = frame as CompleteFrame;
  if (measuredFrame.config.laneDensityFactor !== 0.5) return unknown('wrong_lane_density');
  const intersects = (rect: Rect | null | undefined): rect is Rect =>
    Boolean(
      rect &&
      [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite) &&
      rect.right > rect.left &&
      rect.bottom > rect.top &&
      rect.left < measuredFrame.logicalWidth &&
      rect.right > 0 &&
      rect.top < measuredFrame.logicalHeight &&
      rect.bottom > 0
    );
  const rows: { id: string; rect: Rect }[] = [];
  for (const id of MIXED_IDS) {
    const matches = measuredFrame.active.filter((row) => row?.id === id);
    if (matches.length !== 1) {
      result.status = 'insufficient';
      result.reason = `missing_or_duplicate_active_${id}`;
      return result;
    }
    const row = matches[0];
    if (!row) return unknown('missing_active_row');
    if (
      ![row.x, row.y, row.width, row.height, row.startAtEpochMs, row.endAtEpochMs].every(
        Number.isFinite
      ) ||
      row.width <= 0 ||
      row.height <= 0 ||
      row.endAtEpochMs <= row.startAtEpochMs
    )
      return unknown('invalid_active_geometry_or_time');
    if (
      measuredFrame.finishedAtEpochMs < row.startAtEpochMs ||
      measuredFrame.startedAtEpochMs >= row.endAtEpochMs
    ) {
      result.status = 'insufficient';
      result.reason = `not_time_eligible_${id}`;
      return result;
    }
    if (
      measuredFrame.startedAtEpochMs < row.startAtEpochMs ||
      measuredFrame.finishedAtEpochMs >= row.endAtEpochMs
    )
      return unknown('eligibility_changed_during_frame');
    const rect = { left: row.x, top: row.y, right: row.x + row.width, bottom: row.y + row.height };
    if (!intersects(rect)) {
      result.status = 'insufficient';
      result.reason = `offscreen_${id}`;
      return result;
    }
    const safeTop = measuredFrame.logicalHeight * measuredFrame.config.safeTop;
    const safeBottom = measuredFrame.logicalHeight * (1 - measuredFrame.config.safeBottom);
    if (rect.top + 1e-6 < safeTop || rect.bottom > safeBottom + 1e-6) {
      result.status = 'violation';
      result.reason = `content_outside_safe_zone_${id}`;
      return result;
    }
    const draws = measuredFrame.draws.filter((draw) => draw?.id === id);
    if (
      draws.some(
        (draw) =>
          draw.frameId !== measuredFrame.frameId ||
          !Number.isFinite(draw.alpha) ||
          draw.alpha < 0 ||
          draw.alpha > 1 ||
          !draw.rect ||
          ![draw.rect.left, draw.rect.top, draw.rect.right, draw.rect.bottom].every(Number.isFinite)
      )
    )
      return unknown('invalid_or_mismatched_draw');
    if (
      !draws.some(
        (draw) =>
          draw.alpha > 0 &&
          intersects(draw.rect) &&
          draw.rect !== null &&
          draw.rect.left < rect.right &&
          draw.rect.right > rect.left &&
          draw.rect.top < rect.bottom &&
          draw.rect.bottom > rect.top
      )
    ) {
      result.status = 'insufficient';
      result.reason = `no_current_frame_positive_alpha_draw_${id}`;
      return result;
    }
    rows.push({ id, rect });
    result.paintedIds.push(id);
    result.heightsPx.push(row.height);
  }
  if (result.heightsPx[0] === result.heightsPx[1]) {
    result.status = 'insufficient';
    result.reason = 'equal_measured_heights';
    return result;
  }
  const [a, b] = rows;
  if (!a || !b) return unknown('missing_painted_row');
  if (a.rect.left >= b.rect.right || b.rect.left >= a.rect.right) {
    result.status = 'insufficient';
    result.reason = 'horizontal_lane_sharing';
    return result;
  }
  const gapPx = a.rect.top <= b.rect.top ? b.rect.top - a.rect.bottom : a.rect.top - b.rect.bottom;
  result.pairs.push({ ids: [a.id, b.id], gapPx });
  result.minimumGapPx = gapPx;
  result.status = gapPx + 1e-6 >= measuredFrame.config.laneSpacing ? 'measured' : 'violation';
  result.reason = result.status === 'violation' ? 'content_clearance_below_lane_gap' : null;
  return result;
}

/** Accept one phase's available observations, without inferring adjacency across cohorts. */
export function assertSpacingPhase(
  snapshot: {
    renderFrame?: FrameView | null;
    exact?: {
      config?: { laneSpacing?: number | null } | null;
      activeNow: { id?: string; y: number; height: number }[];
    } | null;
  } | null,
  prefix: string,
  laneSpacing: number,
  renderer: string
) {
  const visibleRowPitch = measureVisibleRowPitch(snapshot?.renderFrame, prefix);
  assert(
    visibleRowPitch.status === 'measured' &&
      visibleRowPitch.japaneseVisibleRowOriginsPx.length >= 2,
    `No complete frame with two visible Japanese rows: ${JSON.stringify(visibleRowPitch)}`
  );
  assert.equal(
    snapshot?.renderFrame?.config?.renderer,
    renderer,
    'Spacing frame came from the wrong renderer'
  );
  assert.equal(
    snapshot?.renderFrame?.config?.laneSpacing,
    laneSpacing,
    'Spacing frame did not use the phase Lane Gap'
  );
  assert.equal(
    snapshot?.exact?.config?.laneSpacing,
    laneSpacing,
    'Spacing snapshot did not use the phase Lane Gap'
  );
  const allocationPitchPx = measureAllocationRowPitch(snapshot?.exact?.activeNow ?? [], prefix);
  assert(allocationPitchPx !== null, 'Spacing fixture did not allocate distinct regular rows');
  // Spread placement and surviving reservations can change the sampled lane separation.
  // Exact option correctness belongs to the controlled adjacent-row source test.
  return { allocationPitchPx, visibleRowPitch };
}

export function assertBacklogMotion(
  disposition: unknown,
  renderer: string,
  comparisonOnly = false
) {
  const motion = disposition as {
    kind: string;
    isBacklog: boolean;
    width: number;
    burstSpeedMultiplier: number | null;
    durationMs: number;
    travelDistancePx: number;
    actualVelocityPxPerMs: number;
  } | null;
  assert(
    motion?.kind === 'activated' && motion.isBacklog === true,
    'Long parser-ingress message was not activated as Backlog'
  );
  assert(motion.width > 1870, 'Backlog text did not produce unclamped travel geometry');
  assert(renderer === 'worker' || renderer === 'main', 'Unknown renderer for Backlog motion');
  const burstMultiplier = motion.burstSpeedMultiplier;
  assert(
    (renderer === 'main' && burstMultiplier === null) ||
      (Number.isFinite(burstMultiplier) && burstMultiplier !== null && burstMultiplier > 1),
    'Worker did not receive a finite burst multiplier above one'
  );
  assert(
    motion.durationMs > 5000 && motion.durationMs < 30000,
    'Backlog duration was clamped, so this cannot verify speed policy'
  );
  assert(
    Number.isFinite(motion.travelDistancePx) && Number.isFinite(motion.actualVelocityPxPerMs),
    'Committed motion fields are unavailable'
  );
  const expectedVelocity = (250 * 2) / 1000;
  if (!comparisonOnly) {
    assert(
      Math.abs(motion.actualVelocityPxPerMs - expectedVelocity) < 0.002,
      'Backlog motion acquired an extra burst multiplier'
    );
    assert(
      Math.abs(motion.durationMs - motion.travelDistancePx / expectedVelocity) < 25,
      'Backlog duration does not match the selected nominal speed'
    );
  }
}

export function assertBacklogReflow(before: unknown, after: unknown, id: string) {
  const previous = before as {
    config: { logicalWidth: number; logicalHeight: number; fontSize: number };
  } | null;
  const next = after as {
    config: { logicalWidth: number; logicalHeight: number; fontSize: number };
    activeNow: { id: string }[];
  } | null;
  assert(
    next?.config?.logicalWidth !== undefined &&
      previous?.config?.logicalWidth !== undefined &&
      next.config.logicalWidth > previous.config.logicalWidth &&
      next.config.logicalHeight > previous.config.logicalHeight,
    'Fixture video geometry did not grow during resize'
  );
  assert.equal(previous.config.fontSize, 32);
  assert.equal(next.config.fontSize, 32, 'Reflow changed the configured 32px font');
  assert(
    next.activeNow.some((entry) => entry.id === id),
    'Backlog message disappeared during resize and spacing reflow'
  );
}

export function workerProbePrelude(tokens: readonly string[] = TOKENS) {
  return `;(${installProbeRuntime.toString()})(${JSON.stringify({ worker: true, tokens })});\n`;
}

export function canvasProbePrelude({
  tokens = TOKENS,
  forceFallback = false,
  workerPrelude = workerProbePrelude(tokens),
  observeCardPlans = false,
}: {
  tokens?: readonly string[];
  forceFallback?: boolean;
  workerPrelude?: string;
  observeCardPlans?: boolean;
} = {}) {
  return (
    `const observePaidPlan = ${observePaidPlan.toString()};\n` +
    `const instrumentCardPlanCalls = ${instrumentCardPlanCalls.toString()};\n` +
    `const workerProbeSuffix = ${workerProbeSuffix.toString()};\n` +
    `;(${installProbeRuntime.toString()})(${JSON.stringify({
      worker: false,
      tokens,
      forceFallback,
      workerPrelude,
      attachProbeSource: attachWorkerRendererProbe.toString(),
      observeCardPlans,
    })});`
  );
}

// The emitted Worker is a classic Blob script. The suffix runs in its lexical
// scope, after the original onmessage assignment. Fail closed on bundle drift.
export function workerProbeSuffix(
  source: string,
  attachProbeSource = attachWorkerRendererProbe.toString(),
  observeCardPlans = false
) {
  const handler =
    /self\.onmessage=([A-Za-z_$][\w$]*)=>\{([A-Za-z_$][\w$]*)\.handleMessage\(\1\)\};?\s*$/.exec(
      source
    );
  if (!handler) return null;
  if (observeCardPlans && !source.includes('__ytObservePaidPlan(')) return null;
  return (
    `\n;(${attachProbeSource})(${handler[2]});\n` +
    (observeCardPlans ? `\nvar __ytObservePaidPlan = ${observePaidPlan.toString()};\n` : '')
  );
}

/** Observe the production shared plan after its own measurement and before drawing. */
function observePaidPlan<
  T extends {
    height: number;
    body?: { lines: unknown[]; height: number };
    translation?: { lines: unknown[]; height: number };
    bodyY?: number;
    translationY?: number;
  },
>(
  prepare: (input: unknown) => T,
  input: {
    kind?: string;
    content?: Array<{ content?: string }>;
    context?: CanvasContext;
    maxBodyLines?: number;
  }
): T {
  const plan = prepare(input);
  const state = (globalThis as typeof globalThis & { __ytPlacementProbe?: ProbeState })
    .__ytPlacementProbe;
  const frame = state?.currentRenderFrame;
  const id = /WINDOWS380_[A-Z0-9_]+/u.exec(
    input.content?.map((part) => part.content ?? '').join(' ') ?? ''
  )?.[0];
  if (
    state &&
    id &&
    (Object.hasOwn(state.measuredPlans, id) || Object.keys(state.measuredPlans).length < 128)
  )
    state.measuredPlans[id] = {
      width: (plan as T & { width?: number }).width ?? 0,
      height: plan.height,
      maxBodyLines: input.maxBodyLines ?? 0,
    };
  if (frame && id && frame.cardPlans.length < 24) {
    const border = frame.lastStroke?.context === input.context ? frame.lastStroke : null;
    if (border) delete frame.lastStroke;
    frame.cardPlans.push({
      id,
      kind: input.kind ?? 'unknown',
      height: plan.height,
      maxBodyLines: input.maxBodyLines ?? 0,
      bodyRows: plan.body?.lines.length ?? 0,
      bodyY: plan.bodyY ?? null,
      bodyHeight: plan.body?.height ?? 0,
      translationRows: plan.translation?.lines.length ?? 0,
      translationY: plan.translationY ?? null,
      translationHeight: plan.translation?.height ?? 0,
      borderAlpha: border?.alpha ?? null,
      borderStyle: border?.style ?? null,
    });
  }
  return plan;
}

function cardPlanFunctionName(source: string): string | null {
  const minified =
    /function ([A-Za-z_$][\w$]*)\(e\)\{let t=Math\.max\(1,e\.width-e\.paddingH\*2\),n=e\.showAuthor/u.exec(
      source
    );
  const name = source.includes('preparePaidCardPlan({') ? 'preparePaidCardPlan' : minified?.[1];
  if (!name) return null;
  const call = `${name}({`;
  const count = source.split(call).length - 1;
  if (
    count < 1 ||
    count > 6 ||
    source.includes('__ytObservePaidPlan') ||
    source.includes('__ytOriginalPaidPlan')
  )
    return null;
  return name;
}

export function instrumentCardPlanCalls(source: string): string | null {
  const name = cardPlanFunctionName(source);
  if (!name) return null;
  const call = `${name}({`;
  return source.replaceAll(call, `__ytObservePaidPlan(${name}, {`);
}

function attachWorkerRendererProbe(renderer: WorkerRendererProbe) {
  const state = (globalThis as typeof globalThis & { __ytPlacementProbe?: ProbeState })
    .__ytPlacementProbe;
  if (!state || !renderer || typeof renderer.drainQueue !== 'function') return;
  const exact: WorkerExact = {
    frames: [],
    drains: [],
    dispositions: [],
    active: [],
    activeNow: [],
    config: null,
    collisionRejects: 0,
    placementMisses: 0,
    drops: {},
    overflow: 0,
    fixtureText: {},
    // Worker has confirmed first-draw accounting but no attribution-unknown counter.
    totalPresentationUnknown: null,
  };
  state.exact = exact;
  const queuedAt = new Map<string, number>();
  const epochNow = () => performance.timeOrigin + performance.now();
  const bounded = <T>(list: T[], value: T) => {
    if (list.length < 240) list.push(value);
    else exact.overflow++;
  };
  const isFixture = (id: unknown): id is string =>
    typeof id === 'string' && /^WINDOWS(193|195|196|204|380)_/.test(id);
  let inEnqueue = false;
  let inDrain = false;
  const nativeEnqueue = renderer.enqueueMessage;
  renderer.enqueueMessage = function (message) {
    inEnqueue = true;
    try {
      const admitted = nativeEnqueue.call(this, message);
      if (
        /^WINDOWS380_(COMBINING|MODIFIER|ZWJ)$/.test(message.id) &&
        typeof message.text === 'string'
      ) {
        exact.fixtureText ??= {};
        exact.fixtureText[message.id] = message.text.slice(0, 512);
      }
      if (
        admitted &&
        isFixture(message.id) &&
        this.pendingQueue.some((entry) => entry.id === message.id)
      ) {
        queuedAt.set(message.id, epochNow());
      }
      exact.pendingNow = this.pendingQueue.slice(0, 128).map((entry) => entry.id);
      exact.queuedNow = [...queuedAt].slice(0, 128).map(([id, atEpochMs]) => ({ id, atEpochMs }));
      exact.retained = {
        pending: this.pendingQueue.length,
        active: this.activeMessages.length,
        indexed: this.messageById?.size ?? null,
        imageFetchTasks: this.imageFetchTasks?.size ?? null,
      };
      return admitted;
    } finally {
      inEnqueue = false;
    }
  };
  const nativeActivate = renderer.activateMessage;
  renderer.activateMessage = function (message, ...args) {
    const result = nativeActivate.call(this, message, ...args);
    if (isFixture(message.id)) {
      const active = this.activeMessages.find((entry) => entry.id === message.id);
      const geometricEntryAtEpochMs = active?.motion
        ? performance.timeOrigin + active.motion.viewportEntryTime
        : (() => {
            if (
              !active ||
              !this.config ||
              !Number.isFinite(this.logicalWidth) ||
              ![
                active.startX,
                active.startTime,
                active.pausedDuration,
                active.duration,
                active.width,
                this.config.exitPaddingPx,
              ].every(Number.isFinite)
            )
              return null;
            const reverse = this.config?.danmakuMode === 'reverse';
            const fixed =
              this.config?.danmakuMode === 'top' ||
              this.config?.danmakuMode === 'bottom' ||
              (this.config?.reducedMotion && !this.config?.ignoreReducedMotion);
            const endX = reverse
              ? this.logicalWidth + this.config.exitPaddingPx
              : -active.width - this.config.exitPaddingPx;
            const velocity = Math.abs(endX - active.startX) / active.duration;
            const distance = fixed
              ? 0
              : reverse
                ? Math.max(0, -active.startX - active.width)
                : Math.max(0, active.startX - this.logicalWidth);
            return (
              performance.timeOrigin +
              active.startTime +
              active.pausedDuration +
              (distance === 0 ? 0 : distance / velocity)
            );
          })();
      const placementWaitMs = args[1]?.waitMs ?? 0;
      if (!active) throw new Error('Activated fixture has no active renderer message');
      bounded(exact.dispositions, {
        id: message.id,
        kind: 'activated',
        queueResidenceMs: queuedAt.has(message.id)
          ? epochNow() - (queuedAt.get(message.id) ?? epochNow())
          : null,
        atEpochMs: epochNow(),
        laneIndex: active?.laneIndex ?? null,
        startX: active?.startX ?? null,
        durationMs: active?.duration ?? null,
        width: active?.width ?? null,
        height: active?.height ?? null,
        y: active?.y ?? null,
        laneHeight: this.laneHeight,
        laneSpacing: this.config?.laneSpacing ?? null,
        fontSize: this.config?.fontSize ?? null,
        slotCount: active?.laneSlotCount ?? args[1]?.slotCount ?? null,
        isBacklog: message.isBacklog === true,
        burstSpeedMultiplier: message.burstSpeedMultiplier ?? null,
        actualVelocityPxPerMs: active?.motion?.actualVelocityPxPerMs ?? null,
        travelDistancePx: active?.motion?.travelDistancePx ?? null,
        visibleExitAtEpochMs: active?.motion
          ? performance.timeOrigin + active.motion.visibleExitTime
          : null,
        pendingDepth: this.pendingQueue.length,
        staggerDelayMs:
          active?.motion?.staggerDelayMs ??
          Math.max(0, active.startTime - args[0] - placementWaitMs),
        isScrolling: active?.motion?.isScrolling ?? null,
        geometricEntryAtEpochMs,
        placementWaitMs,
        optionalEntryDelayMs:
          geometricEntryAtEpochMs === null
            ? null
            : geometricEntryAtEpochMs - performance.timeOrigin - args[0] - placementWaitMs,
        geometricEntryProvenance: active?.motion
          ? 'committed motion plan'
          : 'committed baseline path',
      });
      queuedAt.delete(message.id);
    }
    return result;
  };
  const nativeDrop = renderer.recordDrop;
  renderer.recordDrop = function (message, ...args) {
    const reason =
      typeof args[0] === 'string'
        ? args[0]
        : inEnqueue
          ? 'queue-capacity'
          : inDrain && message.height > this.numLanes * this.laneHeight
            ? 'oversize'
            : 'other';
    if (message.trackDrops !== false) exact.drops[reason] = (exact.drops[reason] ?? 0) + 1;
    if (isFixture(message.id)) {
      bounded(exact.dispositions, {
        id: message.id,
        kind: 'dropped',
        reason,
        tracked: message.trackDrops !== false,
        queueResidenceMs: queuedAt.has(message.id)
          ? epochNow() - (queuedAt.get(message.id) ?? epochNow())
          : null,
        atEpochMs: epochNow(),
      });
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
    try {
      return nativeDrain.apply(this, args);
    } finally {
      inDrain = false;
      bounded(exact.drains, {
        atEpochMs: epochNow(),
        workMs: performance.now() - startedAt,
        pendingBefore: before,
        pendingAfter: this.pendingQueue.length,
        activeBefore,
        activeAfter: this.activeMessages.length,
        collisionRejects: exact.collisionRejects - collisionsBefore,
        placementMisses: exact.placementMisses - placementBefore,
      });
    }
  };
  const nativeFrame = renderer.renderFrame;
  renderer.renderFrame = function (...args) {
    const startedAt = performance.now();
    const beforeActive = this.activeMessages.filter((message) => isFixture(message.id));
    const frame = state.beginRenderFrame({
      ctx: this.ctx,
      logicalWidth: this.logicalWidth,
      logicalHeight: this.logicalHeight,
      config: {
        renderer: 'worker',
        fontSize: this.config?.fontSize ?? null,
        laneSpacing: this.config?.laneSpacing ?? null,
      },
    });
    let successful = false;
    try {
      const result = nativeFrame.apply(this, args);
      successful = true;
      return result;
    } finally {
      bounded(exact.frames, { atEpochMs: epochNow(), workMs: performance.now() - startedAt });
      exact.config = {
        mode: this.config?.danmakuMode ?? null,
        superChatLayout: this.config?.superChatLayout ?? null,
        reducedMotion: this.config?.reducedMotion ?? null,
        ignoreReducedMotion: this.config?.ignoreReducedMotion ?? null,
        translationGeneration: this.config?.translationGeneration ?? null,
        fontSize: this.config?.fontSize ?? null,
        laneSpacing: this.config?.laneSpacing ?? null,
        laneDensityFactor: this.laneDensityFactor,
        speedPxPerSec: this.config?.speedPxPerSec ?? null,
        backlogSpeedMultiplier: this.config?.backlogSpeedMultiplier ?? null,
        outline: this.config?.outline ?? null,
        backgroundColors: this.config?.backgroundColors ?? null,
        safeTop: this.config?.safeTop ?? null,
        safeBottom: this.config?.safeBottom ?? null,
        maxConcurrentMessages: this.config?.maxConcurrentMessages ?? null,
        queueMaxSize: this.config?.queueMaxSize ?? null,
        logicalWidth: this.logicalWidth,
        logicalHeight: this.logicalHeight,
        laneHeight: this.laneHeight,
        laneCount: this.numLanes,
      };
      exact.presentationCount =
        typeof this.totalPresented === 'number' ? this.totalPresented : null;
      const activeSet = new Set(this.activeMessages);
      for (const message of beforeActive) {
        if (
          !activeSet.has(message) &&
          performance.now() >= message.startTime + message.pausedDuration + message.duration
        )
          bounded(exact.dispositions, {
            id: message.id,
            kind: 'completed',
            reason: 'expired-duration',
            atEpochMs: epochNow(),
          });
      }
      const active = this.activeMessages.filter((message) => isFixture(message.id));
      exact.activeNow = active.slice(0, 100).map((message) => ({
        id: message.id,
        atEpochMs: epochNow(),
        x: message.x,
        y: message.y,
        width: message.width,
        height: message.height,
        slotCount: message.laneSlotCount,
        durationMs: message.duration,
        actualVelocityPxPerMs: message.motion?.actualVelocityPxPerMs ?? null,
        laneIndex: message.laneIndex,
        isScrolling: message.motion?.isScrolling ?? null,
        startAtEpochMs: performance.timeOrigin + message.startTime + message.pausedDuration,
        endAtEpochMs:
          performance.timeOrigin + message.startTime + message.pausedDuration + message.duration,
        visibleNow:
          performance.now() >= message.startTime + message.pausedDuration &&
          performance.now() < message.startTime + message.pausedDuration + message.duration,
      }));
      exact.pendingNow = this.pendingQueue.slice(0, 128).map((message) => message.id);
      exact.queuedNow = [...queuedAt].slice(0, 128).map(([id, atEpochMs]) => ({ id, atEpochMs }));
      exact.retained = {
        pending: this.pendingQueue.length,
        active: this.activeMessages.length,
        indexed: this.messageById?.size ?? null,
        imageFetchTasks: this.imageFetchTasks?.size ?? null,
      };
      frame.failed = !successful;
      frame.config = { ...frame.config, ...exact.config };
      state.endRenderFrame(
        frame,
        active.map((message) => ({
          id: message.id,
          x: message.x,
          y: message.y,
          width: message.width,
          height: message.height,
          startAtEpochMs: performance.timeOrigin + message.startTime + message.pausedDuration,
          endAtEpochMs:
            performance.timeOrigin + message.startTime + message.pausedDuration + message.duration,
        }))
      );
      if (exact.frames.length % 10 === 0) {
        for (const message of exact.activeNow) bounded(exact.active, message);
      }
    }
  };
}

// The installed extension page script is executed intact inside its normal
// closure. This additive probe is inserted immediately before its app entry.
// A changed bundle shape is an acceptance failure, never a silent fallback.
export function instrumentCanvasPageScript(
  source: string,
  probeSource = attachCanvasRendererProbe.toString(),
  observeCardPlans = false
) {
  const marker = '\n\tmain();\n';
  if (
    !source.includes('var CanvasRenderer = class CanvasRenderer extends RendererBase {') ||
    !source.includes('function getRegularCardInsets(') ||
    source.split(marker).length !== 2
  )
    return null;
  const cardPlanName = observeCardPlans ? cardPlanFunctionName(source) : null;
  if (observeCardPlans && !cardPlanName) return null;
  return source.replace(
    marker,
    `\n\t;(${probeSource})(CanvasRenderer, getRegularCardInsets);` +
      (observeCardPlans
        ? `\n\tvar __ytOriginalPaidPlan = ${cardPlanName};` +
          `\n\tvar __ytObservePaidPlan = ${observePaidPlan.toString()};` +
          `\n\t${cardPlanName} = function(input) { return __ytObservePaidPlan(__ytOriginalPaidPlan, input); };`
        : '') +
      marker
  );
}

function attachCanvasRendererProbe(
  Renderer: { prototype: CanvasRendererProbe },
  getRegularCardInsets: (
    fontSize: number,
    outlineWidthPx: number,
    drawOutline: boolean,
    backgroundVisible: boolean
  ) => unknown
) {
  const state = (globalThis as typeof globalThis & { __ytPlacementProbe?: ProbeState })
    .__ytPlacementProbe;
  if (
    !state ||
    typeof Renderer?.prototype?.placeQueuedMessage !== 'function' ||
    typeof getRegularCardInsets !== 'function'
  )
    return;
  state.canvasSourceHooked = true;
  state.readRegularInsets = (fontSize, outlineWidthPx, backgroundVisible) =>
    getRegularCardInsets(fontSize, outlineWidthPx, false, backgroundVisible);
  const exact: CanvasExact = {
    dispositions: [],
    drains: [],
    activeNow: [],
    config: null,
    peaks: { pending: 0, active: 0 },
    drops: {},
    overflow: 0,
    fixtureText: {},
    totalPresentationUnknown: null,
  };
  state.exact = exact;
  const queuedAt = new Map<string, number>();
  const bounded = (value: ProbeDisposition) => {
    if (exact.dispositions.length < 240) exact.dispositions.push(value);
    else exact.overflow++;
  };
  const isFixture = (id: unknown): id is string =>
    typeof id === 'string' && /^WINDOWS(193|195|196|204|380)_/.test(id);
  const nativeEnqueue = Renderer.prototype.enqueueMessage;
  Renderer.prototype.enqueueMessage = function (message, ...args) {
    const before = this.pendingQueue.toArray();
    const priorDrop = this.observability?.onMessageDropped;
    let dropReason: string | null = null;
    if (priorDrop && this.observability)
      this.observability.onMessageDropped = (...dropArgs) => {
        dropReason = typeof dropArgs[0] === 'string' ? dropArgs[0] : null;
        return priorDrop.apply(this.observability, dropArgs);
      };
    if (isFixture(message.id)) {
      state.ingress ??= {};
      state.ingress[message.id] ??= performance.timeOrigin + performance.now();
    }
    let result: unknown;
    try {
      result = nativeEnqueue.call(this, message, ...args);
    } finally {
      if (priorDrop && this.observability) this.observability.onMessageDropped = priorDrop;
    }
    const after = this.pendingQueue.toArray();
    const afterIds = new Set(after.map((entry) => entry.id));
    for (const prior of before) {
      if (isFixture(prior.id) && !afterIds.has(prior.id)) {
        bounded({
          id: prior.id,
          kind: 'dropped',
          reason: dropReason ?? 'queue_replaced',
          atEpochMs: performance.timeOrigin + performance.now(),
          queueResidenceMs: queuedAt.has(prior.id)
            ? performance.timeOrigin + performance.now() - (queuedAt.get(prior.id) ?? 0)
            : null,
        });
        queuedAt.delete(prior.id);
      }
    }
    if (isFixture(message.id) && !afterIds.has(message.id))
      bounded({
        id: message.id,
        kind: 'dropped',
        reason: dropReason ?? 'unattributed',
        atEpochMs: performance.timeOrigin + performance.now(),
        queueResidenceMs: null,
      });
    if (
      /^WINDOWS380_(COMBINING|MODIFIER|ZWJ)$/.test(message.id) &&
      typeof message.text === 'string'
    ) {
      exact.fixtureText ??= {};
      exact.fixtureText[message.id] = message.text.slice(0, 512);
    }
    if (
      isFixture(message.id) &&
      this.pendingQueue.toArray().some((entry) => entry.id === message.id)
    ) {
      queuedAt.set(message.id, performance.timeOrigin + performance.now());
    }
    exact.pendingNow = this.pendingQueue
      .toArray()
      .slice(0, 128)
      .map((entry) => entry.id);
    exact.queuedNow = [...queuedAt].slice(0, 128).map(([id, atEpochMs]) => ({ id, atEpochMs }));
    exact.retained = {
      pending: this.pendingQueue.size,
      active: this.activeMessages.length,
      indexed: null,
      imageFetchTasks: null,
    };
    exact.peaks.pending = Math.max(exact.peaks.pending, this.pendingQueue.size);
    return result;
  };
  const nativePlace = Renderer.prototype.placeQueuedMessage;
  Renderer.prototype.placeQueuedMessage = function (message, ...args) {
    const result = nativePlace.call(this, message, ...args);
    if (isFixture(message.id) && result?.placed) {
      const active = this.activeMessages.find((entry) => entry.message?.id === message.id);
      const motion = active?.motion;
      bounded({
        id: message.id,
        kind: 'activated',
        atEpochMs: performance.timeOrigin + performance.now(),
        isBacklog: message.isBacklog === true,
        laneIndex: active?.laneIndex ?? null,
        burstSpeedMultiplier: null,
        laneSpacing: this.settings.laneSpacing,
        fontSize: this.settings.fontSize,
        width: active?.width ?? null,
        height: active?.height ?? null,
        y: active?.y ?? null,
        laneHeight: this.laneAllocator.getLaneHeight(),
        slotCount: active?.slotCount ?? null,
        durationMs: motion?.durationMs ?? null,
        actualVelocityPxPerMs: motion?.actualVelocityPxPerMs ?? null,
        travelDistancePx: motion?.travelDistancePx ?? null,
        queueResidenceMs: queuedAt.has(message.id)
          ? performance.timeOrigin +
            performance.now() -
            (queuedAt.get(message.id) ?? performance.timeOrigin + performance.now())
          : null,
        geometricEntryAtEpochMs: motion ? performance.timeOrigin + motion.viewportEntryTime : null,
        visibleExitAtEpochMs: motion ? performance.timeOrigin + motion.visibleExitTime : null,
        pendingDepth: this.pendingQueue.size,
      });
      queuedAt.delete(message.id);
    }
    return result;
  };
  const drainMethods = Renderer.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  for (const method of ['drainQueue', 'drainQueueAsync'] as const) {
    const native = drainMethods[method];
    if (typeof native !== 'function') continue;
    drainMethods[method] = function (this: CanvasRendererProbe, ...args: unknown[]) {
      const startedAt = performance.now();
      const before = this.pendingQueue.size;
      const activeBefore = this.activeMessages.length;
      const record = () => {
        if (!exact.drains) return;
        if (exact.drains.length < 240)
          exact.drains.push({
            atEpochMs: performance.timeOrigin + performance.now(),
            workMs: performance.now() - startedAt,
            pendingBefore: before,
            activeBefore,
            activeAfter: this.activeMessages.length,
          });
        else exact.overflow++;
      };
      let result: unknown;
      try {
        result = Reflect.apply(native, this, args);
      } catch (error) {
        record();
        throw error;
      }
      if (result && typeof (result as Promise<unknown>).finally === 'function')
        return (result as Promise<unknown>).finally(record);
      record();
      return result;
    };
  }
  const nativeFrame = Renderer.prototype.renderFrame;
  const observed = new WeakSet();
  Renderer.prototype.renderFrame = function (...args) {
    const beforeActive = this.activeMessages.filter((entry) => isFixture(entry.message?.id));
    if (this.observability && !observed.has(this.observability)) {
      const observability = this.observability;
      observed.add(observability);
      const dropMethods: ['onMessageDropped' | 'onMessagesDropped', 0 | 1][] = [
        ['onMessageDropped', 1],
        ['onMessagesDropped', 0],
      ];
      for (const [method, countIndex] of dropMethods) {
        const native = observability[method];
        if (typeof native !== 'function') continue;
        observability[method] = (...dropArgs: unknown[]) => {
          const reason = (dropArgs[1 - countIndex] ?? 'other') as string;
          const count = countIndex === 0 ? (dropArgs[0] as number) : 1;
          exact.drops[reason] = (exact.drops[reason] ?? 0) + count;
          return native.apply(observability, dropArgs);
        };
      }
    }
    const dimsBefore = this.overlay.getDimensions();
    const frame = state.beginRenderFrame({
      ctx: this.ctx,
      logicalWidth: dimsBefore?.width ?? null,
      logicalHeight: dimsBefore?.height ?? null,
      config: {
        renderer: 'main',
        fontSize: this.settings.fontSize,
        laneSpacing: this.settings.laneSpacing,
      },
    });
    let successful = false;
    try {
      const result = nativeFrame.apply(this, args);
      successful = true;
      return result;
    } finally {
      exact.peaks.pending = Math.max(exact.peaks.pending, this.pendingQueue.size);
      exact.peaks.active = Math.max(exact.peaks.active, this.activeMessages.length);
      const dims = this.overlay.getDimensions();
      exact.config = {
        mode: this.settings.danmakuMode,
        superChatLayout: this.settings.superChatLayout ?? null,
        reducedMotion: this.reducedMotion ?? null,
        ignoreReducedMotion: this.settings.ignoreReducedMotion ?? null,
        fontSize: this.settings.fontSize,
        laneSpacing: this.settings.laneSpacing,
        laneDensityFactor: this.currentLaneDensityFactor,
        safeTop: this.settings.safeTop,
        safeBottom: this.settings.safeBottom,
        speedPxPerSec: this.settings.speedPxPerSec,
        backlogSpeedMultiplier: this.settings.backlogSpeedMultiplier,
        outline: this.settings.outline,
        backgroundColors: this.settings.backgroundColors,
        logicalWidth: dims?.width ?? null,
        logicalHeight: dims?.height ?? null,
        laneHeight: this.laneAllocator.getLaneHeight(),
        laneCount: this.laneAllocator.getLaneCount(),
      };
      const presentationMetrics = this.observability?.getMetrics?.();
      const presented = presentationMetrics?.totalPresented ?? this.totalPresented;
      exact.presentationCount = typeof presented === 'number' ? presented : null;
      exact.totalPresentationUnknown =
        typeof presentationMetrics?.totalPresentationUnknown === 'number'
          ? presentationMetrics.totalPresentationUnknown
          : null;
      const activeSet = new Set(this.activeMessages);
      for (const entry of beforeActive) {
        if (
          !activeSet.has(entry) &&
          performance.now() >= entry.startTime + entry.pausedDuration + entry.duration
        )
          bounded({
            id: entry.message.id,
            kind: 'completed',
            reason: 'expired-duration',
            atEpochMs: performance.timeOrigin + performance.now(),
          });
      }
      const active = this.activeMessages.filter((entry) => isFixture(entry.message?.id));
      exact.activeNow = active.slice(0, 100).map((entry) => ({
        id: entry.message.id,
        x: entry.x,
        y: entry.y,
        width: entry.width,
        height: entry.height,
        laneIndex: entry.laneIndex,
        slotCount: entry.slotCount,
        durationMs: entry.motion?.durationMs ?? null,
        actualVelocityPxPerMs: entry.motion?.actualVelocityPxPerMs ?? null,
        startAtEpochMs: performance.timeOrigin + entry.startTime + entry.pausedDuration,
        endAtEpochMs:
          performance.timeOrigin + entry.startTime + entry.pausedDuration + entry.duration,
      }));
      exact.pendingNow = this.pendingQueue
        .toArray()
        .slice(0, 128)
        .map((entry) => entry.id);
      exact.queuedNow = [...queuedAt].slice(0, 128).map(([id, atEpochMs]) => ({ id, atEpochMs }));
      exact.retained = {
        pending: this.pendingQueue.size,
        active: this.activeMessages.length,
        indexed: null,
        imageFetchTasks: null,
      };
      frame.failed = !successful;
      frame.config = { ...frame.config, ...exact.config };
      state.endRenderFrame(
        frame,
        active.map((entry) => ({
          id: entry.message.id,
          x: entry.x,
          y: entry.y,
          width: entry.width,
          height: entry.height,
          startAtEpochMs: performance.timeOrigin + entry.startTime + entry.pausedDuration,
          endAtEpochMs:
            performance.timeOrigin + entry.startTime + entry.pausedDuration + entry.duration,
        }))
      );
    }
  };
}

function messageAction(id: string, text: string) {
  return {
    addChatItemAction: {
      item: {
        liveChatTextMessageRenderer: {
          id,
          authorName: { simpleText: `Fixture viewer ${id}` },
          message: { runs: [{ text: text.includes(id) ? text : `${id} ${text}` }] },
        },
      },
    },
  };
}

function applyFixtureSettings(
  settings: Parameters<NonNullable<Window['__ytChatOverlay']>['applySettings']>[0]
) {
  const app = window.__ytChatOverlay;
  if (!app) throw new Error('Placement runtime settings are unavailable');
  app.applySettings(settings);
}

export function mixedPressureBatches(phase: string) {
  return Array.from({ length: MIXED_PRESSURE_COUNT / MIXED_PRESSURE_CHUNK_SIZE }, (_, chunk) => ({
    key: `${phase}-${chunk}`,
    actions: Array.from({ length: MIXED_PRESSURE_CHUNK_SIZE }, (_, offset) => {
      const index = chunk * MIXED_PRESSURE_CHUNK_SIZE + offset;
      return messageAction(
        `WINDOWS204_PRESSURE_${phase}_${String(index).padStart(2, '0')}`,
        'Bounded placement pressure'
      );
    }),
  }));
}

function chatResponse(actions: ChatAction[]) {
  return {
    continuationContents: {
      liveChatContinuation: {
        actions,
        continuations: [
          { timedContinuationData: { continuation: 'windows193-next', timeoutMs: 30_000 } },
        ],
      },
    },
  };
}

function replayResponse(
  actions: {
    replayChatItemAction: { videoOffsetTimeMsec: number; actions: (ChatAction | undefined)[] };
  }[],
  continuation = 'windows193-seek'
) {
  return {
    continuationContents: {
      liveChatContinuation: {
        actions,
        continuations: [{ playerSeekContinuationData: { continuation } }],
      },
    },
  };
}

async function runScenario({
  context,
  root,
  output,
  extensionId,
  name,
  forceFallback,
  mode,
  transition,
  comparisonOnly = false,
  spacingOnly = false,
}: ScenarioOptions) {
  const page = await context.newPage();
  const requested: string[] = [];
  let originalSettings:
    | Parameters<NonNullable<Window['__ytChatOverlay']>['applySettings']>[0]
    | undefined;
  const deliveredBatches = new Set<string>();
  const phaseObservations: Record<string, unknown>[] = [];
  let replayRequests = 0;
  const replay = mode === 'replay';
  const spacingSpeed = transition === 'spacing-speed';
  const mixedGap = transition === 'mixed-gap';
  const hasMixedConfig = (
    config: FrameConfig | null | undefined
  ): config is FrameConfig & {
    mode: 'top';
    fontSize: 34;
    laneSpacing: 8;
    safeTop: 0.1;
    safeBottom: 0.15;
  } =>
    config?.mode === 'top' &&
    config?.fontSize === 34 &&
    config?.laneSpacing === 8 &&
    config?.safeTop === 0.1 &&
    config?.safeBottom === 0.15;
  const replayObservations: { at10000?: string[]; at10001?: string[]; at11500?: string[] } = {};
  const ids = replay
    ? TOKENS.slice(3, 6)
    : mixedGap
      ? [MIXED_IDS[0]]
      : spacingSpeed
        ? spacingFixtureIds().gap0
        : mode === 'reverse'
          ? [TOKENS[2]]
          : TOKENS.slice(0, 2);
  const paidId = mixedGap ? MIXED_IDS[1] : 'WINDOWS193_PAID';
  assert(
    ids.every((id): id is string => typeof id === 'string') && typeof paidId === 'string',
    'Placement fixture token is unavailable'
  );
  const drawnIds = replay ? ids : spacingSpeed ? ids.slice(0, 2) : [...ids, paidId];
  const actions: ChatAction[] = ids.map((id) =>
    messageAction(
      id,
      spacingSpeed
        ? `東京の夜空にコメントが流れます ${id}`
        : id === TOKENS[1]
          ? `${id}_${'W'.repeat(100)}`
          : id
    )
  );
  if (!replay && !spacingSpeed)
    actions.push({
      addChatItemAction: {
        item: {
          liveChatPaidMessageRenderer: {
            id: paidId,
            authorName: { simpleText: 'Fixture donor' },
            purchaseAmountText: { simpleText: '$5.00' },
            message: { simpleText: paidId },
          },
        },
      },
    });
  const replayActions = replay
    ? [10_000, 10_001, 11_500].map((offsetMs, index) => ({
        replayChatItemAction: { videoOffsetTimeMsec: offsetMs, actions: [actions[index]] },
      }))
    : [];
  const batches = new Map<string, ChatAction[]>([
    ['1', actions],
    [
      '2',
      spacingSpeed
        ? spacingFixtureIds().gap8.map((id) =>
            messageAction(id, `東京の夜空にコメントが流れます ${id}`)
          )
        : transition === 'congestion'
          ? Array.from({ length: 50 }, (_, index) =>
              messageAction(
                `WINDOWS193_LOAD_${String(index).padStart(2, '0')}`,
                'Bounded congestion fixture'
              )
            )
          : [
              messageAction(
                transition === 'reduced' ? TOKENS[6] : TOKENS[8],
                'Bounded transition fixture'
              ),
            ],
    ],
    [
      '3',
      spacingSpeed
        ? Array.from({ length: 51 }, (_, index) => {
            const id =
              index === 14 ? TOKENS[17] : `WINDOWS195_LOAD_${String(index).padStart(2, '0')}`;
            return messageAction(
              id,
              index === 14
                ? `${id} ${'東京の夜空をゆっくり流れるコメント'.repeat(5)}`
                : `${id} バックログ`
            );
          })
        : [
            messageAction(
              transition === 'reduced' ? TOKENS[7] : TOKENS[9],
              'Bounded second transition fixture'
            ),
          ],
    ],
    [
      '4',
      spacingSpeed
        ? Array.from({ length: 4 }, (_, index) =>
            messageAction(
              `WINDOWS195_BURST_${String(index).padStart(2, '0')}`,
              'Bounded live burst'
            )
          )
        : [messageAction(TOKENS[10], 'Reduced-motion override disabled')],
    ],
    ['5', [messageAction(TOKENS[11], 'System reduced motion disabled')]],
  ]);
  if (mixedGap) {
    for (const phase of ['2', '3', '4', '5']) batches.delete(phase);
    for (const phase of ['2', '4', '5']) {
      for (const batch of mixedPressureBatches(phase)) batches.set(batch.key, batch.actions);
    }
  }
  const preview = await readFile(join(root, 'test/visual/preview.html'), 'utf8');
  let html = buildVisibleWatchHtml(preview, 'Placement fixture video');
  if (mixedGap)
    html = html
      .replace(
        '</style>',
        '#movie_player:fullscreen { width: 100vw; height: 100vh; aspect-ratio: auto; }\n</style>'
      )
      .replace('</body>', '<button id="placement-fullscreen">Full screen</button></body>');
  const workerPrelude = workerProbePrelude();
  const canvasScript =
    spacingSpeed || mixedGap
      ? instrumentCanvasPageScript(
          await readFile(join(root, 'dist-extension/page-script.js'), 'utf8')
        )
      : null;
  if (spacingSpeed || mixedGap) assert(canvasScript, 'Packaged Canvas page script shape changed');
  let nativePageProbe: NativePageScriptProbe | undefined;
  let pageScriptProbeProvenance: NativePageScriptProbe['provenance'] | null = null;
  const screenshot = `placement-${name}.png`;
  let screenshotCaptured = false;
  const sendBatch = async (batch: string | string[]) => {
    const keys = Array.isArray(batch) ? batch : [batch];
    await page.evaluate(async (keys) => {
      for (const key of keys) {
        if (key === '1') {
          if (!window.__ytPlacementProbe) throw new Error('Placement probe is unavailable');
          window.__ytPlacementProbe.requestAtEpochMs = performance.timeOrigin + performance.now();
        }
        const response = await fetch(
          `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?windows193=${key}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }
        );
        if (!response.ok) throw new Error('Placement fixture request failed');
        await response.json();
      }
    }, keys);
    for (const key of keys) {
      assert(deliveredBatches.has(key), `Scoped placement batch ${key} was not intercepted`);
    }
  };
  const sendPressure = (phase: string) =>
    sendBatch(mixedPressureBatches(phase).map((batch) => batch.key));
  const workerSnapshot = async () => {
    // Flush observes the preceding frame; let queued settings reach that frame first.
    await page.waitForTimeout(50);
    const requestId = await page.evaluate(() => {
      const probe = window.__ytPlacementProbe;
      if (!probe) throw new Error('Placement probe is unavailable');
      const id = (probe.flushSequence ?? 0) + 1;
      probe.flushSequence = id;
      for (const record of probe.workers)
        record.worker.postMessage({ type: 'ytPlacementFlush', requestId: id });
      return id;
    });
    await page.waitForFunction(
      (id) =>
        window.__ytPlacementProbe?.workers.some((record) => record.ready && record.flushId === id),
      requestId,
      { timeout: 5000 }
    );
    const exact = await page.evaluate(
      () => window.__ytPlacementProbe?.workers.find((record) => record.ready)?.sample?.exact ?? null
    );
    assert(
      exact?.config &&
        Array.isArray(exact.drains) &&
        Array.isArray(exact.frames) &&
        typeof exact.config.logicalWidth === 'number' &&
        typeof exact.config.logicalHeight === 'number',
      'Exact Worker placement snapshot is unavailable'
    );
    return exact as WorkerExact & {
      config: FrameConfig & { logicalWidth: number; logicalHeight: number };
    };
  };
  const waitForWorkerEntry = (id: string) =>
    page.waitForFunction(
      (messageId) =>
        Number.isFinite(
          window.__ytPlacementProbe?.workers.find((record) => record.ready)?.sample?.firstEntry?.[
            messageId
          ]
        ),
      id,
      { timeout: 10_000 }
    );
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
      const overlay = document.querySelector<HTMLCanvasElement>('#yt-live-chat-overlay canvas');
      const settings = window.__ytChatOverlay?.getSettings?.();
      const insets =
        settings &&
        probe.readRegularInsets?.(
          settings.fontSize,
          settings.outline.enabled ? settings.outline.widthPx : 0,
          false
        );
      return {
        sourcePrefixed: probe.sourcePrefixed,
        sourceHooked: probe.sourceHooked,
        canvasSourceHooked: probe.canvasSourceHooked,
        regularInsets: insets ?? null,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        video: video ? { x: video.x, y: video.y, width: video.width, height: video.height } : null,
        canvas: overlay ? { width: overlay.width, height: overlay.height } : null,
        requestAtEpochMs: probe.requestAtEpochMs,
        videoEntry: probe.videoEntry,
        frames: probe.frames,
        bounds: probe.bounds,
        ink: probe.ink,
        exact: probe.exact,
        latestRenderFrame: probe.latestRenderFrame,
        firstEntry: probe.firstEntry,
        ingress: probe.ingress,
        overflow: probe.overflow,
        workers: probe.workers.map(({ ready, stats, sample }) => ({ ready, stats, sample })),
      };
    });
  };
  const mixedSnapshot = async () => {
    if (!forceFallback) await workerSnapshot();
    const raw = await captureProbe();
    const selected = forceFallback ? raw : raw?.workers.find((record) => record.ready)?.sample;
    assert(
      raw?.canvasSourceHooked && selected?.exact,
      'Packaged mixed-height renderer probe did not attach'
    );
    return { ...selected, exact: selected.exact };
  };
  const probeResult = (raw: Awaited<ReturnType<typeof captureProbe>>) => {
    const selected =
      raw && (forceFallback ? raw : raw.workers.find((worker) => worker.ready)?.sample);
    const ingress = forceFallback
      ? Object.fromEntries(drawnIds.map((id) => [id, raw?.requestAtEpochMs]))
      : (raw?.ingress ?? {});
    return {
      renderer: forceFallback ? 'main' : 'worker',
      name,
      mode,
      phases: phaseObservations,
      ids: requested,
      replayRequests: replay ? replayRequests : null,
      replayBoundaries: replay ? replayObservations : null,
      deliveredBatches: [...deliveredBatches],
      sourcePrefixed: raw?.sourcePrefixed ?? false,
      sourceHooked: raw?.sourceHooked ?? false,
      canvasSourceHooked: raw?.canvasSourceHooked ?? false,
      comparisonOnly,
      regularInsets: raw?.regularInsets ?? null,
      viewport: raw?.viewport ?? null,
      video: raw?.video ?? null,
      canvas: raw?.canvas ?? null,
      workerReady: raw?.workers.some((worker) => worker.ready) ?? false,
      firstEntryLatencyMs: Object.fromEntries(
        drawnIds.map((id) => [
          id,
          selected?.firstEntry?.[id] !== undefined && ingress[id] !== undefined
            ? selected.firstEntry[id] - ingress[id]
            : null,
        ])
      ),
      firstEntryAtEpochMs: selected?.firstEntry ?? {},
      firstEntryScope:
        'first sampled nonzero-alpha text draw touching the viewport; includes fade and frame quantization',
      geometryUnits: 'backing-store pixels',
      replayVideoTime: raw?.videoEntry ?? {},
      geometricEntryLatencyMs: Object.fromEntries(
        (selected?.exact?.dispositions ?? [])
          .filter(
            (entry) =>
              entry.kind === 'activated' &&
              typeof entry.geometricEntryAtEpochMs === 'number' &&
              Number.isFinite(entry.geometricEntryAtEpochMs)
          )
          .map((entry) => [
            entry.id,
            ingress[entry.id] === undefined || entry.geometricEntryAtEpochMs == null
              ? null
              : entry.geometricEntryAtEpochMs - (ingress[entry.id] ?? 0),
          ])
      ),
      frameWorkMs: summarizeSamples(selected?.frames?.map((frame) => frame.workMs) ?? []),
      preClearWorkMs: summarizeSamples(selected?.frames?.map((frame) => frame.preClearMs) ?? []),
      ...summarizeExactWorkerProbe(selected, forceFallback ? 'main' : 'worker'),
      bounds: selected?.bounds?.slice(0, MAX_SAMPLES) ?? [],
      ink: selected?.ink?.slice(0, MAX_SAMPLES) ?? [],
      latestRenderFrame: selected?.latestRenderFrame ?? null,
      exactCanvas: forceFallback ? (selected?.exact ?? null) : null,
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
      if (url.protocol === 'chrome-extension:' && url.hostname === extensionId)
        return route.continue();
      if (
        replay &&
        url.hostname === 'www.youtube.com' &&
        url.pathname === '/youtubei/v1/live_chat/get_live_chat_replay'
      ) {
        replayRequests++;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          json: replayResponse(replayRequests === 2 ? replayActions : []),
        });
      }
      if (
        url.hostname === 'www.youtube.com' &&
        url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat')
      ) {
        const batch = url.searchParams.get('windows193');
        const deliver = batch && batches.has(batch) && !deliveredBatches.has(batch);
        if (deliver) deliveredBatches.add(batch);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          json: chatResponse(deliver ? (batches.get(batch) ?? []) : []),
        });
      }
      if (url.hostname === 'www.youtube.com' && route.request().resourceType() === 'document') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: html });
      }
      return route.fulfill({
        status: 403,
        contentType: 'text/plain',
        body: 'Blocked by placement fixture',
      });
    });
    await page.addInitScript({ content: canvasProbePrelude({ forceFallback, workerPrelude }) });
    await page.addInitScript((isReplay) => {
      const playback = { time: 10, paused: false };
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
        configurable: true,
        get: () => playback.time,
        set: (value) => {
          playback.time = value;
        },
      });
      Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
        configurable: true,
        get: () => playback.paused,
      });
      window.__ytPlacementSetVideoTime = (seconds) => {
        playback.time = seconds;
      };
      window.__ytPlacementSetPaused = (paused) => {
        playback.paused = paused;
        document.querySelector('video')?.dispatchEvent(new Event(paused ? 'pause' : 'play'));
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
        currentVideoEndpoint: { watchEndpoint: { videoId: 'windows193Placement' } },
        contents: {
          twoColumnWatchNextResults: {
            conversationBar: {
              liveChatRenderer: {
                isReplay,
                continuations: [
                  isReplay
                    ? { playerSeekContinuationData: { continuation: 'windows193-initial' } }
                    : {
                        timedContinuationData: {
                          continuation: 'windows193-live',
                          timeoutMs: 30_000,
                        },
                      },
                ],
              },
            },
          },
        },
      };
    }, replay);
    if (canvasScript) {
      nativePageProbe = await installNativePageScriptProbe({
        context,
        root,
        extensionId,
        fixtureUrl: FIXTURE_URL,
        instrumentedSource: canvasScript,
      });
      pageScriptProbeProvenance = nativePageProbe.provenance;
      await nativePageProbe.assertReady();
    }
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page
      .locator('#yt-live-chat-overlay canvas')
      .waitFor({ state: 'attached', timeout: 15_000 });
    if (nativePageProbe) {
      await nativePageProbe.assertInjected();
      await page.waitForFunction(() => window.__ytPlacementProbe.canvasSourceHooked === true);
      await nativePageProbe.restore();
      nativePageProbe = undefined;
    }
    await page.waitForFunction(() => Boolean(window.__ytChatOverlay?.getSettings), undefined, {
      timeout: 15_000,
    });
    originalSettings = await page.evaluate(
      ({ danmakuMode, spacingSpeed, mixedGap, mixedBurstSettings }) => {
        const app = window.__ytChatOverlay;
        if (!app) throw new Error('Placement runtime settings are unavailable');
        const settings = app.getSettings();
        const overrides = {
          danmakuMode,
          outline: { ...settings.outline, enabled: spacingSpeed, widthPx: 2, opacity: 0.7 },
          showDebugOverlay: true,
          fontSize: mixedGap ? 34 : 32,
          laneSpacing: mixedGap ? 8 : 0,
          safeTop: mixedGap ? 0.1 : 0,
          safeBottom: mixedGap ? 0.15 : 0,
          maxConcurrentMessages: 300,
          queueMaxSize: 200,
          ignoreReducedMotion: false,
          translationEnabled: false,
        };
        if (spacingSpeed)
          Object.assign(overrides, {
            backgroundColors: { ...settings.backgroundColors, normal: '#00000000' },
            showAuthor: { ...settings.showAuthor, normal: false },
            depthLayersEnabled: false,
            speedPxPerSec: 250,
            backlogSpeedMultiplier: 2,
            backlogMaxRate: 50,
            scrollDurationMinMs: 5000,
            scrollDurationMaxMs: 30000,
            staggerMaxDelayMs: 0,
            staggerMediumDelayMs: 0,
          });
        if (mixedGap)
          Object.assign(overrides, {
            topBottomDurationMs: 30000,
            ...mixedBurstSettings,
            staggerMaxDelayMs: 0,
            staggerMediumDelayMs: 0,
          });
        const previous = structuredClone(
          Object.fromEntries(
            [
              ...Object.keys(overrides),
              ...(spacingSpeed
                ? [
                    'burstElevatedThreshold',
                    'burstHighThreshold',
                    'burstExtremeThreshold',
                    'speedBoostThreshold',
                  ]
                : []),
            ].map((key) => [key, (settings as unknown as Record<string, unknown>)[key]])
          )
        );
        app.applySettings(overrides);
        return previous;
      },
      {
        danmakuMode: mode === 'replay' ? 'scroll' : mode,
        spacingSpeed,
        mixedGap,
        mixedBurstSettings: MIXED_BURST_SETTINGS,
      }
    );
    await page.waitForFunction(
      (worker) => {
        const status = document.querySelector('#yt-chat-overlay-debug')?.textContent ?? '';
        return status.includes('Render:') && status.includes('Render: n/a') === worker;
      },
      !forceFallback,
      { timeout: 15_000 }
    );
    await page.waitForTimeout(300);
    if (mixedGap) {
      let configured: Awaited<ReturnType<typeof mixedSnapshot>> | undefined;
      for (let attempt = 0; attempt < 40; attempt++) {
        configured = await mixedSnapshot();
        if (hasMixedConfig(configured.exact.config)) break;
        await page.waitForTimeout(200);
      }
      assert(
        configured && hasMixedConfig(configured.exact.config),
        `Mixed-height settings did not reach the renderer before ingress: ${JSON.stringify({
          config: configured?.exact.config,
          frameConfig: configured?.latestRenderFrame?.config,
          complete: configured?.latestRenderFrame?.complete,
        })}`
      );
      phaseObservations.push({
        phase: 'configured-safe-zone',
        config: configured.exact.config,
        frameId: configured.latestRenderFrame?.frameId ?? null,
      });
    }
    if (replay) {
      await page.waitForFunction(
        () =>
          document.querySelector(
            '.yt-live-chat-overlay-live-region > p[data-message-id="WINDOWS193_REPLAY_DUE"]'
          ),
        undefined,
        { timeout: 15_000 }
      );
      assert(replayRequests >= 2, 'Replay player-seek fixture was not requested');
      const futureAtDue = await page
        .locator('.yt-live-chat-overlay-live-region > p[data-message-id^="WINDOWS193_REPLAY_"]')
        .evaluateAll((elements) =>
          elements
            .map((element) => element.getAttribute('data-message-id'))
            .filter((id): id is string => id !== null)
        );
      replayObservations.at10000 = futureAtDue;
      assert.deepEqual(
        futureAtDue,
        [TOKENS[3]],
        'A prefetched replay message appeared before video time'
      );
      await page.evaluate(() => window.__ytPlacementSetVideoTime(10.001));
      await page.waitForFunction(
        () =>
          document.querySelector(
            '.yt-live-chat-overlay-live-region > p[data-message-id="WINDOWS193_REPLAY_NEXT"]'
          ),
        undefined,
        { timeout: 10_000 }
      );
      replayObservations.at10001 = await page
        .locator('.yt-live-chat-overlay-live-region > p[data-message-id^="WINDOWS193_REPLAY_"]')
        .evaluateAll((elements) =>
          elements
            .map((element) => element.getAttribute('data-message-id'))
            .filter((id): id is string => id !== null)
        );
      assert.deepEqual(
        replayObservations.at10001?.toSorted(),
        [TOKENS[3], TOKENS[4]].toSorted(),
        'A replay message appeared before 11500ms'
      );
      await page.evaluate(() => window.__ytPlacementSetVideoTime(11.5));
    } else {
      await sendBatch('1');
    }
    requested.push(...ids, ...(replay || spacingSpeed ? [] : [paidId]));
    await page.waitForFunction(
      ({ expected, boundedStream }) => {
        const accessibleIds = new Set(
          [...document.querySelectorAll<HTMLElement>('.yt-live-chat-overlay-live-region > p')].map(
            (element) => element.dataset.messageId
          )
        );
        // Each renderer mirrors at most ten active messages per update. The
        // twelve-message stream is retained in the routed parser batch; selected
        // messages are independently verified by canvas paint below.
        return boundedStream
          ? expected.filter((id) => accessibleIds.has(id)).length >= 2
          : expected.every((id) => accessibleIds.has(id));
      },
      { expected: requested, boundedStream: spacingSpeed },
      { timeout: 15_000 }
    );
    if (replay)
      replayObservations.at11500 = await page
        .locator('.yt-live-chat-overlay-live-region > p[data-message-id^="WINDOWS193_REPLAY_"]')
        .evaluateAll((elements) =>
          elements
            .map((element) => element.getAttribute('data-message-id'))
            .filter((id): id is string => id !== null)
        );
    await page.waitForFunction(
      ({ expected, worker }) => {
        const probe = window.__ytPlacementProbe;
        const firstEntry = worker
          ? probe.workers.find((record) => record.ready)?.sample?.firstEntry
          : probe.firstEntry;
        return expected.every((id) => Number.isFinite(firstEntry?.[id]));
      },
      { expected: drawnIds, worker: !forceFallback },
      { timeout: 10_000 }
    );

    if (mixedGap) {
      const initial = await mixedSnapshot();
      assert(
        hasMixedConfig(initial.exact.config) && hasMixedConfig(initial.latestRenderFrame?.config),
        'Mixed-height focus rows did not use the configured font and safe zone'
      );
      assert(
        MIXED_IDS.every((id) => initial.exact.activeNow.some((entry) => entry.id === id)),
        'Mixed-height fixture rows were not both active before reflow'
      );
      phaseObservations.push({
        phase: 'initial',
        config: initial.exact.config,
        active: initial.exact.activeNow.filter((entry) => MIXED_IDS.includes(entry.id)),
      });
      const waitForClearance = async (
        phase: string,
        priorFrameId: number,
        acceptsConfig: (config: FrameConfig | null) => boolean
      ) => {
        let clearance: ReturnType<typeof measureMixedHeightClearance> | undefined;
        for (let attempt = 0; attempt < 40; attempt++) {
          const selected = await mixedSnapshot();
          const frame = selected.latestRenderFrame;
          if (!frame || frame.frameId <= priorFrameId) {
            await page.waitForTimeout(200);
            continue;
          }
          clearance = measureMixedHeightClearance(frame);
          const config = selected.exact.config;
          if (
            !hasMixedConfig(config) ||
            !hasMixedConfig(frame.config) ||
            !acceptsConfig(config) ||
            !acceptsConfig(frame.config)
          ) {
            await page.waitForTimeout(200);
            continue;
          }
          if (clearance.status === 'violation') {
            assert.fail(`${phase} content clearance violated: ${JSON.stringify(clearance)}`);
          }
          if (clearance.status === 'measured' && selected.exact.config?.laneDensityFactor === 0.5) {
            assert.equal(selected.exact.config.laneSpacing, 8);
            assert.equal(selected.exact.config.mode, 'top');
            phaseObservations.push({
              phase,
              clearance,
              renderFrame: selected.latestRenderFrame,
              config: selected.exact.config,
              active: selected.exact.activeNow.filter((entry) => MIXED_IDS.includes(entry.id)),
              dispositions: selected.exact.dispositions.filter((entry) =>
                MIXED_IDS.includes(entry.id)
              ),
            });
            return { ...selected, exact: { ...selected.exact, config }, latestRenderFrame: frame };
          }
          await page.waitForTimeout(200);
        }
        assert.fail(
          `${phase} lacked two painted mixed-height rows at density 0.5: ${JSON.stringify(clearance)}`
        );
      };
      await sendPressure('2');
      const dense = await waitForClearance(
        'density-reflow',
        initial.latestRenderFrame?.frameId ?? 0,
        (config) => Number(config?.laneHeight) < Number(initial.exact.config?.laneHeight)
      );
      assert(
        Number(dense.exact.config.laneHeight) < Number(initial.exact.config?.laneHeight),
        'Parser-driven burst did not shrink the lane grid'
      );
      await page.locator('.player-wrapper').evaluate((element) => {
        element.style.maxWidth = '1000px';
      });
      await page.setViewportSize({ width: 1100, height: 700 });
      await sendPressure('4');
      const resized = await waitForClearance(
        'resize-reflow',
        dense.latestRenderFrame.frameId,
        (config) => Number(config?.logicalWidth) > Number(dense.exact.config.logicalWidth)
      );
      assert(
        Number(resized.exact.config.logicalWidth) > Number(dense.exact.config.logicalWidth),
        'Fixture video did not grow on resize'
      );
      await page.locator('#placement-fullscreen').evaluate((element) => {
        element.addEventListener('click', () =>
          document.querySelector('#movie_player')?.requestFullscreen()
        );
      });
      await page.locator('#placement-fullscreen').click();
      await page.waitForFunction(
        () => document.fullscreenElement?.id === 'movie_player',
        undefined,
        { timeout: 5000 }
      );
      await sendPressure('5');
      const fullscreen = await waitForClearance(
        'fullscreen-reflow',
        resized.latestRenderFrame.frameId,
        (config) => Number(config?.logicalHeight) > Number(resized.exact.config.logicalHeight)
      );
      assert(
        Number(fullscreen.exact.config.logicalHeight) > Number(resized.exact.config.logicalHeight),
        'Actual fullscreen did not expand the overlay'
      );
    }

    if (spacingSpeed) {
      const issueSnapshot = async () => {
        if (!forceFallback) await workerSnapshot();
        const raw = await captureProbe();
        const selected = forceFallback ? raw : raw?.workers.find((record) => record.ready)?.sample;
        assert(
          raw?.canvasSourceHooked && selected?.exact?.config,
          'Packaged renderer probe did not attach'
        );
        assert.equal(
          selected.exact.config?.backgroundColors?.normal,
          '#00000000',
          'Japanese fixture did not keep a transparent normal background'
        );
        return {
          exact: { ...selected.exact, config: selected.exact.config },
          ink: selected.ink ?? [],
          renderFrame: selected.latestRenderFrame ?? null,
          regularInsets: raw.regularInsets,
          stats: forceFallback
            ? selected.exact.peaks
            : raw.workers.flatMap((record) => record.stats),
        };
      };
      const visibleGap = async (prefix: string, laneSpacing: number) => {
        let snapshot: Awaited<ReturnType<typeof issueSnapshot>> | undefined;
        let visibleRowPitch: ReturnType<typeof measureVisibleRowPitch> | undefined;
        for (let attempt = 0; attempt < 40; attempt++) {
          snapshot = await issueSnapshot();
          visibleRowPitch = measureVisibleRowPitch(snapshot.renderFrame, prefix);
          if (
            visibleRowPitch.status === 'measured' &&
            visibleRowPitch.japaneseVisibleRowOriginsPx.length >= 2
          ) {
            return {
              snapshot,
              ...assertSpacingPhase(
                snapshot,
                prefix,
                laneSpacing,
                forceFallback ? 'main' : 'worker'
              ),
            };
          }
          await page.waitForTimeout(250);
        }
        assert.fail(
          `No complete frame with two visible Japanese rows: ${JSON.stringify(visibleRowPitch)}`
        );
      };
      const {
        snapshot: gap0,
        visibleRowPitch: gap0Visible,
        allocationPitchPx: gap0Pitch,
      } = await visibleGap('WINDOWS196_GAP0_', 0);
      await page.screenshot({
        path: join(output, `placement-${name}-gap0.png`),
        animations: 'disabled',
      });
      phaseObservations.push({
        phase: 'gap0',
        allocationPitchPx: gap0Pitch,
        visibleRowPitch: gap0Visible,
        renderFrame: gap0.renderFrame,
        active: gap0.exact.activeNow,
        config: gap0.exact.config,
        dispositions: gap0.exact.dispositions,
        ink: gap0.ink,
        regularInsets: gap0.regularInsets,
        queue: gap0.stats,
      });
      await page.evaluate(() => {
        const probe = window.__ytPlacementProbe;
        probe.bounds.length = 0;
        probe.ink.length = 0;
        for (const record of probe.workers)
          record.worker.postMessage({ type: 'ytPlacementResetIssueInk' });
      });
      await page.evaluate(() => {
        const app = window.__ytChatOverlay;
        if (!app) throw new Error('Placement runtime settings are unavailable');
        app.applySettings({ laneSpacing: 8 });
      });
      await page.waitForTimeout(350);
      await sendBatch('2');
      const {
        snapshot: gap8,
        visibleRowPitch: gap8Visible,
        allocationPitchPx: gap8Pitch,
      } = await visibleGap('WINDOWS196_GAP8_', 8);
      await page.screenshot({
        path: join(output, `placement-${name}-gap8.png`),
        animations: 'disabled',
      });
      if (!comparisonOnly) {
        const regular = gap0.exact.dispositions.filter(
          (entry) => entry.kind === 'activated' && entry.id.startsWith('WINDOWS196_GAP0_')
        );
        assert(
          regular.length >= 2 && regular.every((entry) => entry.slotCount === 1),
          'Compact transparent regular comments reserved extra baseline rows'
        );
      }
      phaseObservations.push({
        phase: 'gap8',
        allocationPitchPx: gap8Pitch,
        visibleRowPitch: gap8Visible,
        renderFrame: gap8.renderFrame,
        active: gap8.exact.activeNow,
        config: gap8.exact.config,
        dispositions: gap8.exact.dispositions,
        ink: gap8.ink,
        regularInsets: gap8.regularInsets,
        queue: gap8.stats,
      });
      if (spacingOnly) {
        await page.screenshot({ path: join(output, screenshot), animations: 'disabled' });
        screenshotCaptured = true;
        const raw = await captureProbe();
        assert(
          raw?.canvasSourceHooked &&
            (forceFallback ||
              (raw.sourcePrefixed &&
                raw.sourceHooked &&
                raw.workers.some((worker) => worker.ready))),
          'Packaged renderer source probe was not attached'
        );
        return { status: 'passed', ...probeResult(raw) };
      }

      await page.evaluate(() => {
        const app = window.__ytChatOverlay;
        if (!app) throw new Error('Placement runtime settings are unavailable');
        app.applySettings({
          burstElevatedThreshold: 2,
          // Keep the elevated speed stimulus without changing the lane grid.
          // High/extreme density reflow has its own capacity/drop contract.
          burstHighThreshold: 100,
          burstExtremeThreshold: 200,
          speedBoostThreshold: 2,
        });
      });
      await sendBatch('3'); // >50 parsed chat actions take the production Backlog path.
      await sendBatch('4'); // Ordinary live ingress raises the real burst detector.
      let backlog: Awaited<ReturnType<typeof issueSnapshot>> | undefined;
      for (let attempt = 0; attempt < 30; attempt++) {
        backlog = await issueSnapshot();
        if (
          backlog.exact.dispositions.some(
            (entry) => entry.id === TOKENS[17] && entry.kind === 'activated'
          )
        )
          break;
        await page.waitForTimeout(900);
      }
      assert(backlog, 'Long parser-ingress Backlog snapshot is unavailable');
      assert(
        backlog.exact.dispositions.some(
          (entry) => entry.id === TOKENS[17] && entry.kind === 'activated'
        ),
        'Long parser-ingress Backlog message did not activate within 30 seconds'
      );
      const long = backlog.exact.dispositions.find(
        (entry) => entry.id === TOKENS[17] && entry.kind === 'activated'
      );
      assertBacklogMotion(long, forceFallback ? 'main' : 'worker', comparisonOnly);
      assert.equal(
        backlog.exact.config.laneDensityFactor,
        1,
        'Spacing/speed fixture did not isolate burst lane-density changes'
      );
      phaseObservations.push({
        phase: 'backlog-burst',
        motion: long,
        config: backlog.exact.config,
        queue: backlog.stats,
        dispositions: backlog.exact.dispositions.filter((entry) =>
          entry.id.startsWith('WINDOWS195_')
        ),
      });
      await page.evaluate(() => window.__ytPlacementSetPaused(true));
      const pauseStart = await issueSnapshot();
      await page.waitForTimeout(450);
      const paused = await issueSnapshot();
      const atPauseStart = pauseStart.exact.activeNow.find((entry) => entry.id === TOKENS[17]);
      const atPauseEnd = paused.exact.activeNow.find((entry) => entry.id === TOKENS[17]);
      assert(
        atPauseStart && atPauseEnd && Math.abs(atPauseStart.x - atPauseEnd.x) < 2,
        'Backlog progress advanced during video pause'
      );
      await page.evaluate(() => window.__ytPlacementSetPaused(false));
      await page.waitForTimeout(350);
      const resumed = await issueSnapshot();
      assert(
        resumed.exact.activeNow.some((entry) => entry.id === TOKENS[17]),
        'Backlog message was lost on video resume'
      );
      phaseObservations.push({
        phase: 'pause-resume',
        pauseStart: atPauseStart,
        paused: atPauseEnd,
        resumed: resumed.exact.activeNow.filter((entry) => entry.id === TOKENS[17]),
      });
      await page.locator('.player-wrapper').evaluate((element) => {
        element.style.maxWidth = '1000px';
      });
      await page.setViewportSize({ width: 1100, height: 700 });
      await page.waitForFunction(
        ({ width, height }) => {
          const video = document.querySelector('video')?.getBoundingClientRect();
          return video && video.width > Number(width) && video.height > Number(height);
        },
        { width: resumed.exact.config.logicalWidth, height: resumed.exact.config.logicalHeight },
        { timeout: 5000 }
      );
      const grown = await issueSnapshot();
      assert.equal(resumed.exact.config.laneDensityFactor, 1);
      assert.equal(grown.exact.config.laneDensityFactor, 1);
      assertBacklogReflow(resumed.exact, grown.exact, TOKENS[17]);
      phaseObservations.push({
        phase: 'resize-expanded',
        config: grown.exact.config,
        active: grown.exact.activeNow.filter((entry) => entry.id === TOKENS[17]),
      });
      if (!forceFallback) {
        await page.evaluate(() => {
          const record = window.__ytPlacementProbe.workers.find((entry) => entry.ready);
          if (!record) throw new Error('Renderer Worker is unavailable for recovery');
          record.worker.dispatchEvent(
            new ErrorEvent('error', { message: 'Acceptance recovery trigger' })
          );
        });
        await page.waitForFunction(
          () => {
            const status = document.querySelector('#yt-chat-overlay-debug')?.textContent ?? '';
            return status.includes('Render:') && !status.includes('Render: n/a');
          },
          undefined,
          { timeout: 15_000 }
        );
        const recovered = await captureProbe();
        assert(
          recovered?.canvasSourceHooked && recovered.exact?.config,
          'Worker failure did not recover into the instrumented Canvas'
        );
        assert(
          recovered.exact.activeNow.some((entry) => entry.id === TOKENS[17]),
          'Backlog message was lost during Worker-to-Canvas recovery'
        );
        phaseObservations.push({
          phase: 'worker-recovery',
          config: recovered.exact.config,
          active: recovered.exact.activeNow.filter((entry) => entry.id === TOKENS[17]),
        });
      }
      await page.locator('#yt-chat-overlay-settings-button').click({ force: true });
      const modal = page.locator('#yt-chat-overlay-settings-backdrop');
      await modal.waitFor({ state: 'visible' });
      const disclosure = modal.locator('.yt-chat-overlay-settings-disclosure').first();
      if ((await disclosure.getAttribute('open')) === null)
        await disclosure.locator('summary').click();
      const slider = modal.locator('input[name="laneSpacing-slider"]');
      await slider.focus();
      await slider.press('Home');
      const previewState = () =>
        page.locator('.yt-chat-overlay-settings-font-preview-text').evaluate((element) => ({
          rows: element.dataset.previewRows ?? null,
          rowHeight: Number(element.dataset.previewRowHeight),
          rowPitch: Number(element.dataset.previewRowPitch),
        }));
      const previewZero = await previewState();
      for (let step = 0; step < 8; step++) await slider.press('ArrowRight');
      assert.equal(await modal.locator('input[name="laneSpacing"]').inputValue(), '8');
      if (!comparisonOnly)
        await page.waitForFunction(
          (before) => {
            const element = document.querySelector<HTMLElement>(
              '.yt-chat-overlay-settings-font-preview-text'
            );
            return (
              element?.dataset.previewRows === '2' &&
              Number(element.dataset.previewRowPitch) > before
            );
          },
          previewZero.rowPitch,
          { timeout: 5000 }
        );
      const previewEight = await previewState();
      if (!comparisonOnly) {
        assert.equal(
          previewZero.rows,
          '2',
          'Settings preview did not draw two representative rows'
        );
        assert.equal(previewEight.rows, '2');
        assert(
          previewEight.rowPitch > previewZero.rowPitch,
          'Settings preview did not respond to Lane Gap'
        );
      }
      await modal.locator('button[data-action="close"]').last().click();
      await modal.waitFor({ state: 'hidden' });
      await page.locator('#yt-chat-overlay-settings-button').click({ force: true });
      await modal.waitFor({ state: 'visible' });
      if ((await disclosure.getAttribute('open')) === null)
        await disclosure.locator('summary').click();
      assert.equal(
        await modal.locator('input[name="laneSpacing"]').inputValue(),
        '8',
        'Saved Lane Gap was not restored on settings reopen'
      );
      await page.keyboard.press('Escape');
      await modal.waitFor({ state: 'hidden' });
      const storageWorker = context
        .serviceWorkers()
        .find((worker) => worker.url().startsWith(`chrome-extension://${extensionId}/`));
      assert(
        storageWorker,
        'Installed extension background worker is unavailable for storage readback'
      );
      let storedLaneSpacing = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        const saved = await storageWorker.evaluate(
          async () =>
            (
              await (
                globalThis as typeof globalThis & {
                  chrome: {
                    storage: { local: { get(key: string): Promise<Record<string, string>> } };
                  };
                }
              ).chrome.storage.local.get('yt-live-chat-overlay-settings')
            )['yt-live-chat-overlay-settings']
        );
        storedLaneSpacing = saved ? JSON.parse(saved).laneSpacing : null;
        if (storedLaneSpacing === 8) break;
        await page.waitForTimeout(100);
      }
      assert.equal(storedLaneSpacing, 8, 'Lane Gap was not persisted in extension storage');
      phaseObservations.push({
        phase: 'settings-ui',
        previewZero,
        previewEight,
        reopenedLaneSpacing: 8,
        storedLaneSpacing: 8,
        closeActions: ['Done', 'Escape'],
      });
    }

    if (transition === 'reduced') {
      const baseline = await workerSnapshot();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForFunction(
        () =>
          window.__ytPlacementProbe.workers.find((record) => record.ready)?.sample?.exact?.config
            ?.reducedMotion === true,
        undefined,
        { timeout: 10_000 }
      );
      await sendBatch('2');
      await page.waitForFunction(
        (id) =>
          document.querySelector(`.yt-live-chat-overlay-live-region > p[data-message-id="${id}"]`),
        TOKENS[6]
      );
      await waitForWorkerEntry(TOKENS[6]);
      const reduced = await workerSnapshot();
      assert.equal(reduced.config.reducedMotion, true);
      assert(
        reduced.dispositions.some((entry) => entry.id === TOKENS[6] && entry.isScrolling === false),
        'Reduced-motion message was not activated in fixed mode'
      );
      await page.evaluate(applyFixtureSettings, { ignoreReducedMotion: true });
      const override = await workerSnapshot();
      assert.equal(override.config.ignoreReducedMotion, true);
      assert(
        override.activeNow.some((entry) => entry.id === TOKENS[6] && entry.isScrolling === true),
        'Reduced-motion override did not restore scrolling'
      );
      await page.evaluate(applyFixtureSettings, { ignoreReducedMotion: false });
      const restored = await workerSnapshot();
      assert.equal(restored.config.ignoreReducedMotion, false);
      assert(
        restored.activeNow.some((entry) => entry.id === TOKENS[6] && entry.isScrolling === false),
        'Disabling override did not restore reduced motion'
      );
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.waitForFunction(
        () =>
          window.__ytPlacementProbe.workers.find((record) => record.ready)?.sample?.exact?.config
            ?.reducedMotion === false,
        undefined,
        { timeout: 10_000 }
      );
      const systemOff = await workerSnapshot();
      assert.equal(systemOff.config.reducedMotion, false);
      assert(
        systemOff.activeNow.some((entry) => entry.id === TOKENS[6] && entry.isScrolling === true),
        'System reduced-motion off did not restore scrolling'
      );
      for (const state of [reduced, override, restored, systemOff]) {
        assert.equal(
          findOverlappingActivePair(
            state.activeNow,
            state.config.logicalWidth,
            state.config.logicalHeight
          ),
          null,
          'Visible messages overlapped during a live reduced-motion transition'
        );
      }
      phaseObservations.push(
        { phase: 'initial', config: baseline.config },
        { phase: 'reduced', config: reduced.config },
        { phase: 'override', config: override.config },
        { phase: 'override-off', config: restored.config },
        { phase: 'system-off', config: systemOff.config }
      );
    }
    if (transition === 'safe-density') {
      const baseline = await workerSnapshot();
      await page.setViewportSize({ width: 800, height: 600 });
      await page.evaluate(applyFixtureSettings, {
        safeTop: 0.15,
        safeBottom: 0.25,
        fontSize: 40,
        laneSpacing: 10,
        maxConcurrentMessages: 30,
      });
      await sendBatch('2');
      await page.waitForFunction(
        (id) =>
          document.querySelector(`.yt-live-chat-overlay-live-region > p[data-message-id="${id}"]`),
        TOKENS[8]
      );
      await waitForWorkerEntry(TOKENS[8]);
      const compact = await workerSnapshot();
      assert(
        compact.config.logicalWidth < baseline.config.logicalWidth,
        'Active Worker viewport did not shrink'
      );
      assert.equal(compact.config.safeTop, 0.15);
      assert.equal(compact.config.safeBottom, 0.25);
      assert.equal(compact.config.maxConcurrentMessages, 30);
      const active = compact.activeNow.filter((entry) => entry.id === TOKENS[8]);
      assert(active.length > 0, 'Safe-zone transition produced no active geometry');
      assert(
        active.some(
          (entry) =>
            entry.y >= compact.config.logicalHeight * 0.15 &&
            entry.y + entry.height <= compact.config.logicalHeight * 0.75
        ),
        'Transition message escaped the shrunken safe zone'
      );
      assert.equal(
        findOverlappingActivePair(
          compact.activeNow,
          compact.config.logicalWidth,
          compact.config.logicalHeight
        ),
        null,
        'Messages overlapped after safe-zone and density shrink'
      );
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.evaluate(applyFixtureSettings, {
        safeTop: 0,
        safeBottom: 0,
        fontSize: 32,
        laneSpacing: 0,
        maxConcurrentMessages: 300,
      });
      await sendBatch('3');
      await page.waitForFunction(
        (id) =>
          document.querySelector(`.yt-live-chat-overlay-live-region > p[data-message-id="${id}"]`),
        TOKENS[9]
      );
      await waitForWorkerEntry(TOKENS[9]);
      const expanded = await workerSnapshot();
      assert(
        expanded.config.logicalWidth > compact.config.logicalWidth,
        'Active Worker viewport did not expand'
      );
      assert.equal(expanded.config.safeTop, 0);
      assert.equal(expanded.config.safeBottom, 0);
      assert(
        expanded.activeNow.some((entry) => entry.id === TOKENS[9]),
        'Expanded safe zone produced no active geometry'
      );
      assert.equal(
        findOverlappingActivePair(
          expanded.activeNow,
          expanded.config.logicalWidth,
          expanded.config.logicalHeight
        ),
        null,
        'Messages overlapped after safe-zone expansion'
      );
      phaseObservations.push(
        { phase: 'initial', config: baseline.config },
        { phase: 'compact', config: compact.config, active: active.at(-1) },
        {
          phase: 'expanded',
          config: expanded.config,
          active: expanded.activeNow.filter((entry) => entry.id === TOKENS[9]).at(-1),
        }
      );
    }
    if (transition === 'congestion') {
      await page.evaluate(applyFixtureSettings, {
        maxConcurrentMessages: 30,
        queueMaxSize: 50,
        fontSize: 16,
        laneSpacing: 0,
        safeTop: 0,
        safeBottom: 0,
        staggerMaxDelayMs: 200,
        staggerMediumDelayMs: 80,
      });
      await workerSnapshot();
      await page.evaluate(() => {
        const record = window.__ytPlacementProbe.workers.find((entry) => entry.ready);
        if (!record) throw new Error('Renderer Worker is unavailable for sample reset');
        record.worker.postMessage({ type: 'ytPlacementResetSamples' });
      });
      await sendBatch('2');
      await page.waitForTimeout(500);
      const congested = await workerSnapshot();
      const peakPending = Math.max(0, ...congested.drains.map((drain) => drain.pendingBefore ?? 0));
      assert.equal(congested.config.maxConcurrentMessages, 30);
      assert.equal(congested.config.queueMaxSize, 50);
      assert(peakPending >= 50, `No-stagger pressure was not reached: pending ${peakPending}`);
      assert(
        congested.dispositions.some(
          (entry) =>
            entry.kind === 'activated' &&
            (entry.pendingDepth ?? 0) >= 50 &&
            entry.staggerDelayMs === 0 &&
            Math.abs(entry.optionalEntryDelayMs ?? Infinity) < 1
        ),
        'Queue pressure did not remove both temporal and geometric entry delay'
      );
      assert(congested.drains.every((drain) => (drain.activeAfter ?? Infinity) <= 30));
      phaseObservations.push({
        phase: 'congested',
        config: congested.config,
        peakPending,
        zeroStaggerActivations: congested.dispositions.filter(
          (entry) =>
            entry.kind === 'activated' &&
            (entry.pendingDepth ?? 0) >= 50 &&
            entry.staggerDelayMs === 0
        ).length,
      });
    }
    if (transition === 'translation') {
      const before = await workerSnapshot();
      const active = before.activeNow.find((entry) => entry.id === TOKENS[0]);
      assert(active, 'Translation fixture message has no active geometry');
      await page.evaluate(applyFixtureSettings, { translationEnabled: true });
      const enabled = await workerSnapshot();
      assert(Number.isInteger(enabled.config.translationGeneration));
      await page.evaluate(
        ({ id, width, height, generation }) => {
          const record = window.__ytPlacementProbe.workers.find((entry) => entry.ready);
          if (!record) throw new Error('Renderer Worker is unavailable for translation');
          record.worker.postMessage({
            type: 'updateTranslation',
            id,
            translatedText: 'Fixture translation only',
            width,
            height,
            translationHeight: 32,
            translationGeneration: generation,
          });
        },
        {
          id: TOKENS[0],
          width: active.width + 80,
          height: active.height + 32,
          generation: enabled.config.translationGeneration,
        }
      );
      await page.waitForFunction(
        ({ id, width }) =>
          window.__ytPlacementProbe.workers
            .find((record) => record.ready)
            ?.sample?.exact?.activeNow?.some((entry) => entry.id === id && entry.width >= width),
        { id: TOKENS[0], width: active.width + 80 },
        { timeout: 10_000 }
      );
      const translated = await workerSnapshot();
      const translatedActive = translated.activeNow.find((entry) => entry.id === TOKENS[0]);
      assert(
        translatedActive &&
          translatedActive.width >= active.width + 80 &&
          translatedActive.height >= active.height + 32,
        'Injected production translation protocol did not reflow active geometry'
      );
      await page.evaluate(applyFixtureSettings, { translationEnabled: false });
      const disabled = await workerSnapshot();
      await page.evaluate(
        ({ id, width, height, generation }) => {
          const record = window.__ytPlacementProbe.workers.find((entry) => entry.ready);
          if (!record) throw new Error('Renderer Worker is unavailable for translation');
          record.worker.postMessage({
            type: 'updateTranslation',
            id,
            translatedText: null,
            width,
            height,
            translationHeight: 0,
            translationGeneration: generation,
          });
        },
        {
          id: TOKENS[0],
          width: active.width,
          height: active.height,
          generation: disabled.config.translationGeneration,
        }
      );
      await page.waitForFunction(
        ({ id, width, height }) =>
          window.__ytPlacementProbe.workers
            .find((record) => record.ready)
            ?.sample?.exact?.activeNow?.some(
              (entry) => entry.id === id && entry.width === width && entry.height === height
            ),
        { id: TOKENS[0], width: active.width, height: active.height },
        { timeout: 10_000 }
      );
      const reverted = await workerSnapshot();
      phaseObservations.push(
        { phase: 'before', active },
        {
          phase: 'translated',
          config: translated.config,
          active: translatedActive,
          provenance: 'test-injected production Worker protocol',
        },
        {
          phase: 'translation-off',
          config: reverted.config,
          active: reverted.activeNow.find((entry) => entry.id === TOKENS[0]),
        }
      );
    }
    await page.screenshot({ path: join(output, screenshot), animations: 'disabled' });
    screenshotCaptured = true;
    const raw = await captureProbe();
    assert(raw, 'Placement probe capture is unavailable');
    const selected = forceFallback ? raw : raw.workers.find((worker) => worker.ready)?.sample;
    assert(forceFallback || raw.sourcePrefixed, 'Packaged Worker source was not instrumented');
    assert(forceFallback || raw.sourceHooked, 'Packaged Worker renderer shape changed');
    assert(
      forceFallback || raw.workers.some((worker) => worker.ready),
      'Real Worker did not become ready'
    );
    assert(selected && selected.frames.length > 0, 'No overlay frames were observed');
    assert(
      forceFallback || (selected.exact?.drains?.length ?? 0) > 0,
      'No exact Worker drains were observed'
    );
    if (mode === 'top' || mode === 'bottom') {
      const exact = selected.exact;
      const config = exact?.config;
      assert(
        config &&
          typeof config.logicalWidth === 'number' &&
          typeof config.logicalHeight === 'number',
        'Placement geometry dimensions are unavailable'
      );
      assert.equal(config.mode, mode);
      assert(
        exact.activeNow.some((entry) => ids.includes(entry.id)),
        `No ${mode} message remained active for placement geometry`
      );
      assert.equal(
        findOverlappingActivePair(exact.activeNow, config.logicalWidth, config.logicalHeight),
        null,
        `${mode} active messages overlapped`
      );
    }
    return { status: 'passed', pageScriptProbeProvenance, ...probeResult(raw) };
  } catch (error) {
    if (!screenshotCaptured && !page.isClosed()) {
      screenshotCaptured = await page
        .screenshot({ path: join(output, screenshot), animations: 'disabled', timeout: 3000 })
        .then(
          () => true,
          () => false
        );
    }
    const raw = await captureProbe().catch(() => null);
    return {
      status: 'failed',
      pageScriptProbeProvenance,
      ...probeResult(raw),
      errorType: error instanceof Error ? error.name : typeof error,
      errorMessage:
        error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400),
      assertion: error instanceof assert.AssertionError ? error.message.slice(0, 300) : null,
    };
  } finally {
    try {
      if (nativePageProbe) await nativePageProbe.restore();
    } finally {
      if (mixedGap && !page.isClosed()) {
        await page
          .evaluate(() => document.fullscreenElement && document.exitFullscreen())
          .catch(() => {});
      }
      if (originalSettings && !page.isClosed()) {
        await page
          .evaluate((settings) => window.__ytChatOverlay?.applySettings(settings), originalSettings)
          .catch(() => {});
        await page.waitForTimeout(350).catch(() => {});
      }
      await page.close();
    }
  }
}

/** Installed Edge: run the same application/parser paths with Worker and forced Canvas fallback. */
export async function runPlacementTimingFixture({
  context,
  root,
  output,
  extensionId,
  comparisonOnly = false,
  selectedScenarios,
  spacingOnly = false,
}: {
  context: BrowserContext;
  root: string;
  output: string;
  extensionId: string;
  comparisonOnly?: boolean;
  selectedScenarios?: string[];
  spacingOnly?: boolean;
}) {
  assert.equal(typeof comparisonOnly, 'boolean');
  assert.equal(typeof spacingOnly, 'boolean');
  assert(
    selectedScenarios === undefined ||
      (Array.isArray(selectedScenarios) &&
        selectedScenarios.length > 0 &&
        new Set(selectedScenarios).size === selectedScenarios.length &&
        selectedScenarios.every((name) =>
          PLACEMENT_SCENARIOS.some((scenario) => scenario.name === name)
        )),
    'Selected placement scenario names must be unique known names'
  );
  assert(
    !spacingOnly ||
      selectedScenarios?.every((name) =>
        ['worker-spacing-speed', 'main-spacing-speed'].includes(name)
      ),
    'Spacing-only execution requires explicit spacing scenario names'
  );
  const selected =
    selectedScenarios === undefined
      ? PLACEMENT_SCENARIOS
      : PLACEMENT_SCENARIOS.filter((scenario) => selectedScenarios.includes(scenario.name));
  const scenarios = [];
  for (const scenario of selected) {
    try {
      scenarios.push(
        await runScenario({
          context,
          root,
          output,
          extensionId,
          comparisonOnly,
          spacingOnly,
          ...scenario,
        })
      );
    } catch (error) {
      scenarios.push({
        status: 'failed',
        renderer: scenario.forceFallback ? 'main' : 'worker',
        name: scenario.name,
        mode: scenario.mode,
        errorType: error instanceof Error ? error.name : typeof error,
        errorMessage:
          error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400),
        assertion: error instanceof assert.AssertionError ? error.message.slice(0, 300) : null,
      });
    }
  }
  const commentDisplayMatrix =
    selectedScenarios === undefined && !spacingOnly
      ? await (
          await import('./comment-display-matrix.ts')
        ).runCommentDisplayMatrix({
          context,
          root,
          output,
          extensionId,
          mode: comparisonOnly ? 'baseline' : 'candidate',
        })
      : null;
  return {
    status:
      scenarios.every((scenario) => scenario.status === 'passed') &&
      (commentDisplayMatrix === null ||
        commentDisplayMatrix.status === 'passed' ||
        (comparisonOnly && commentDisplayMatrix.status === 'observed'))
        ? 'passed'
        : 'failed',
    scenarios,
    commentDisplayMatrix,
    comparisonOnly,
    selectedScenarios: selected.map((scenario) => scenario.name),
    spacingOnly,
    geometryScope: 'historical ink rectangles and complete-frame visible row pitch',
    preClearScope: 'frame work before first overlay clear, including drain and cleanup',
  };
}
