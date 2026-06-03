// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * RendererWorkerWebGL2 — OffscreenCanvas-based WebGL2 render loop running in a Web Worker.
 *
 * Offloads WebGL2 SDF rendering from the main thread. The main thread handles
 * DOM observation, API polling, and translation; the worker runs its own rAF
 * loop for rendering, lane allocation, and message lifecycle.
 *
 * ## Protocol
 *
 * Main → Worker:
 *   { type: 'init', canvas: OffscreenCanvas, config: WorkerConfig }
 *   { type: 'resize', width: number, height: number }
 *   { type: 'addMessages', messages: WorkerMessage[] }
 *   { type: 'updateConfig', config: Partial<WorkerConfig> }
 *   { type: 'setPaused', paused: boolean, videoPaused?: boolean }
 *   { type: 'addEmojiImages', images: Array<{ url: string, bitmap: ImageBitmap }> }
 *   { type: 'addAuthorPhotos', photos: Array<{ url: string, bitmap: ImageBitmap }> }
 *   { type: 'setTranslation', messageId: string, text: string }
 *   { type: 'destroy' }
 *
 * Worker → Main:
 *   { type: 'ready' }
 *   { type: 'stats', activeMessages: number, fps: number, drops: number, queueDepth: number }
 *   { type: 'atlasReady' }
 *   { type: 'atlasError', error: string }
 *   { type: 'requestImages', urls: string[] }
 *   { type: 'error', message: string }
 *
 * ## WorkerConfig
 *
 * A minimal subset of OverlaySettings needed by the render loop.
 * The main thread serializes relevant settings into this flat config shape.
 */

/// <reference lib="webworker" />

// ── Imports ──
import { computeOutlineColor } from '@core/color-utils';
import { PriorityBucketQueue } from '@core/priority-bucket-queue';
import { SPEED_TIER, TRANSLATION_FONT_SCALE, TRANSLATION_GAP_PX } from '@core/renderer-constants';
import type { OpacityConfig } from '@core/renderer-shared';
import {
  buildSDFInstances,
  createProgram,
  FLOATS_PER_INSTANCE,
  MAX_INSTANCES,
  setupWebGL2Buffers,
  updateMessagePositions,
  uploadSDFAtlas,
} from '@core/renderer-webgl2-shared';
import {
  ATLAS_CELL_SIZE,
  ATLAS_SIZE,
  GLYPH_RASTER_SIZE,
  SDF_DISTANCE_RANGE,
  type SDFAtlas,
  SDFAtlasGenerator,
} from '@core/sdf-atlas';
import { SDF_FRAGMENT_SHADER, SDF_VERTEX_SHADER } from '@core/sdf-shaders';

// ── Types ──

/** Minimal serializable message format for cross-thread transfer. */
interface WorkerMessage {
  id: string;
  author?: string;
  authorType: string;
  authorPhotoUrl?: string;
  kind: 'text' | 'superchat' | 'membership';
  content: Array<
    { type: 'text'; content: string } | { type: 'emoji'; emojiUrl: string; emojiAlt?: string }
  >;
  isBacklog: boolean;
}

/** Worker configuration subset (sent from main thread). */
interface WorkerConfig {
  fontSize: number;
  fontFamily: string;
  fontWeight: string | number;
  opacity: number;
  fadeDurationMs: number;
  maxMessageAgeMs: number;
  danmakuMode: string;
  scrollDurationMaxMs: number;
  queueMaxSize: number;
  backgroundQueueMax: number;
  outlineWidthPx: number;
  outlineOpacity: number;
  authorColors: Record<string, string>;
  laneSpacing: number;
  safeTop: number;
  safeBottom: number;
  headwayGapRatio: number;
  exitPaddingPx: number;
  speedPxPerSec: number;
  backlogSpeedMultiplier: number;
  depthLayersEnabled: boolean;
  depthFarOpacityMul: number;
  backlogOpacityMultiplier: number;
  showAuthor: boolean;
  superChatOpacity: number;
  translationMode?: string;
  translationEnabled?: boolean;
  [key: string]: unknown;
}

/** Active message tracked in the render loop. */
interface ActiveMessage {
  message: WorkerMessage;
  x: number;
  y: number;
  width: number;
  height: number;
  startX: number;
  startTime: number;
  duration: number;
  fadeStartTime: number;
  laneIndex: number;
  speedTier: number;
  translatedText?: string | null;
}

// ── State ──
let canvas: OffscreenCanvas | null = null;
let config: WorkerConfig | null = null;
const activeMessages: ActiveMessage[] = [];
let animFrameId: number | null = null;
let atlasReady = false;
let isPaused = false;
let isVideoPaused = false;
let pausedAt = 0;

// WebGL state
let gl: WebGL2RenderingContext | null = null;
let program: WebGLProgram | null = null;
let vao: WebGLVertexArrayObject | null = null;
let instanceBuffer: WebGLBuffer | null = null;
let posBuf: WebGLBuffer | null = null;
let uvBuf: WebGLBuffer | null = null;
let atlasTexture: WebGLTexture | null = null;
const instanceData = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);
let instanceCount = 0;
let atlas: SDFAtlas | null = null;
let atlasGenerating = false;
let u_viewport: WebGLUniformLocation | null = null;
let u_atlasSize: WebGLUniformLocation | null = null;
let u_cellSize: WebGLUniformLocation | null = null;
let u_distanceRange: WebGLUniformLocation | null = null;
let u_outlineWidth: WebGLUniformLocation | null = null;
let u_outlineColor: WebGLUniformLocation | null = null;
let u_outlineOpacity: WebGLUniformLocation | null = null;
let u_atlas: WebGLUniformLocation | null = null;
let opacityConfig: OpacityConfig | null = null;
const pendingQueue = new PriorityBucketQueue();
const retryQueue: WorkerMessage[] = [];
const emojiTextures = new Map<string, WebGLTexture>();
const authorPhotoTextures = new Map<string, WebGLTexture>();

// CSS pixel dimensions (logical)
let cssWidth = 0;
let cssHeight = 0;

// DPR for viewport scaling (default 1, updated from main thread via config)
let dpr = 1;

// ── Helpers ──

function getOutlineColor(): [number, number, number] {
  const cfg = config;
  const outColor = computeOutlineColor(
    cfg?.authorColors.normal ?? '#ffffff',
    cfg?.outlineOpacity ?? 1
  );
  // computeOutlineColor returns rgba(...); parse the numeric components
  const match = outColor.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (match) {
    const [, r = '0', g = '0', b = '0'] = match;
    return [parseInt(r, 10) / 255, parseInt(g, 10) / 255, parseInt(b, 10) / 255];
  }
  return [0, 0, 0];
}

/** Estimate text width without DOM access (OffscreenCanvas not always needed). */
function estimateTextWidth(text: string, fontSize: number): number {
  if (!text) return 0;
  // Fallback: average character width ≈ fontSize * 0.6
  return Math.ceil(text.length * fontSize * 0.6);
}

function getWorkerMessagePriority(msg: WorkerMessage): number {
  switch (msg.kind) {
    case 'superchat':
      return 200;
    case 'membership':
      return 100;
    default:
      return msg.isBacklog ? -50 : 0;
  }
}

// ── WebGL Setup ──

function uploadAtlas(): void {
  const glCtx = gl;
  const atlasData = atlas;
  const data = atlasData?.data;
  if (!glCtx || !data) return;
  if (atlasTexture && glCtx) glCtx.deleteTexture(atlasTexture);
  const tex = uploadSDFAtlas(glCtx, data, ATLAS_SIZE);
  if (!tex) {
    self.postMessage({ type: 'error', message: 'Failed to create atlas texture' });
    return;
  }
  atlasTexture = tex;
  if (atlasData) {
    atlasData.texture = tex;
    atlasData.uploaded = true;
  }
}

async function initAtlas(): Promise<void> {
  const cfg = config;
  if (!cfg || atlasGenerating) return;
  atlasGenerating = true;
  try {
    atlas = await new SDFAtlasGenerator().generate(cfg.fontFamily, cfg.fontWeight);
    uploadAtlas();
    atlasReady = true;
    atlasGenerating = false;
    self.postMessage({ type: 'atlasReady', glyphCount: atlas.glyphs.size });
  } catch (e: unknown) {
    atlasGenerating = false;
    self.postMessage({ type: 'atlasError', error: String(e) });
  }
}

// ── Render Loop ──

function drainQueue(_now: number): void {
  const cfg = config;
  if (!cfg) return;

  const maxMessages = cfg.queueMaxSize;
  let yCursor = cfg.safeTop;

  while (!pendingQueue.isEmpty) {
    if (activeMessages.length >= maxMessages) break;

    // biome-ignore lint/suspicious/noExplicitAny: PriorityBucketQueue typed for ChatMessage; WorkerMessage is serializable subset
    const raw = pendingQueue.dequeue() as any as WorkerMessage | undefined;
    if (!raw) break;

    const msg = raw as WorkerMessage;
    const fontSize = cfg.fontSize;
    let lh = Math.ceil(fontSize * 1.4);
    // Add translation height when dual mode is enabled (translation renders below the message)
    if (cfg.translationEnabled && cfg.translationMode === 'dual') {
      const transFontSize = Math.round(fontSize * TRANSLATION_FONT_SCALE);
      lh += Math.ceil(transFontSize * 1.2) + TRANSLATION_GAP_PX;
    }
    const text = msg.content.map((s) => (s.type === 'text' ? s.content : '')).join('');
    const w = text ? estimateTextWidth(text, fontSize) : 0;

    const startX =
      cfg.danmakuMode === 'reverse'
        ? -w
        : cfg.danmakuMode === 'scroll'
          ? cssWidth
          : (cssWidth - w) / 2;
    const speedTier = msg.isBacklog ? SPEED_TIER.BACKLOG : SPEED_TIER.MID;
    const now2 = performance.now();

    const active: ActiveMessage = {
      message: msg,
      x: startX,
      y: yCursor,
      width: Math.max(1, Math.ceil(w)),
      height: lh,
      startX,
      startTime: now2,
      duration: cfg.scrollDurationMaxMs,
      fadeStartTime: now2,
      laneIndex: 0,
      speedTier,
      translatedText: null,
    };

    activeMessages.push(active);

    // Simple vertical stacking
    yCursor += lh + cfg.laneSpacing;
    if (yCursor + lh > cssHeight - cfg.safeBottom) break;
  }

  // Refill from retry queue
  if (pendingQueue.isEmpty && retryQueue.length > 0) {
    for (const m of retryQueue) {
      // biome-ignore lint/suspicious/noExplicitAny: PriorityBucketQueue typed for ChatMessage; WorkerMessage is serializable subset
      (pendingQueue as any).enqueue(m, getWorkerMessagePriority(m));
    }
    retryQueue.length = 0;
  }
}

function renderFrame(now: number): void {
  const glCtx = gl;
  if (!glCtx || !canvas) return;

  glCtx.viewport(0, 0, Math.ceil(cssWidth * dpr), Math.ceil(cssHeight * dpr));
  glCtx.clearColor(0, 0, 0, 0);
  glCtx.clear(glCtx.COLOR_BUFFER_BIT);

  drainQueue(now);
  updateMessagePositions(activeMessages, config?.danmakuMode ?? 'scroll', cssWidth, now);
  const result = buildSDFInstances(
    activeMessages,
    atlas,
    instanceData,
    MAX_INSTANCES,
    config?.fontSize ?? 16,
    (config?.fontSize ?? 16) / GLYPH_RASTER_SIZE,
    config?.authorColors ?? {},
    opacityConfig,
    now,
    config?.translationMode,
    undefined
  );
  instanceCount = result.instanceCount;

  if (instanceCount > 0 && atlasTexture && program && vao) {
    const cfg = config;
    if (!cfg) return;

    glCtx.useProgram(program);
    glCtx.bindVertexArray(vao);
    glCtx.activeTexture(glCtx.TEXTURE0);
    glCtx.bindTexture(glCtx.TEXTURE_2D, atlasTexture);

    if (u_viewport) glCtx.uniform2f(u_viewport, cssWidth, cssHeight);
    if (u_atlasSize) glCtx.uniform1f(u_atlasSize, ATLAS_SIZE);
    if (u_cellSize) glCtx.uniform1f(u_cellSize, ATLAS_CELL_SIZE);
    if (u_distanceRange) glCtx.uniform1f(u_distanceRange, SDF_DISTANCE_RANGE);
    if (u_outlineWidth) glCtx.uniform1f(u_outlineWidth, cfg.outlineWidthPx / SDF_DISTANCE_RANGE);
    if (u_outlineColor) {
      const oc = getOutlineColor();
      glCtx.uniform3f(u_outlineColor, oc[0], oc[1], oc[2]);
    }
    if (u_outlineOpacity) glCtx.uniform1f(u_outlineOpacity, cfg.outlineOpacity);
    if (u_atlas) glCtx.uniform1i(u_atlas, 0);

    glCtx.bindBuffer(glCtx.ARRAY_BUFFER, instanceBuffer);
    glCtx.bufferSubData(
      glCtx.ARRAY_BUFFER,
      0,
      instanceData.subarray(0, instanceCount * FLOATS_PER_INSTANCE)
    );
    glCtx.drawArraysInstanced(glCtx.TRIANGLES, 0, 6, instanceCount);
    glCtx.bindVertexArray(null);
  }
}

function startRenderLoop(): void {
  if (animFrameId !== null) return;
  const loop = (t: number) => {
    animFrameId = self.requestAnimationFrame(loop);
    if (!atlasReady || isPaused || isVideoPaused) return;
    renderFrame(t);
  };
  animFrameId = self.requestAnimationFrame(loop);
}

// ── Message Handlers ──

function handleInit(payload: { canvas: OffscreenCanvas; config: WorkerConfig }): void {
  if (canvas !== null) {
    self.postMessage({ type: 'error', message: 'Already initialized' });
    return;
  }

  canvas = payload.canvas;
  config = payload.config;

  dpr = ((payload.config as Record<string, unknown>).dpr as number | undefined) ?? 1;
  cssWidth = canvas.width / dpr;
  cssHeight = canvas.height / dpr;

  const ctx = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
  });
  if (!ctx) {
    self.postMessage({ type: 'error', message: 'WebGL2 not supported in worker' });
    return;
  }
  gl = ctx;

  // Compile shaders
  program = createProgram(ctx, SDF_VERTEX_SHADER, SDF_FRAGMENT_SHADER);

  // VAO + buffers (shared setup)
  try {
    const buffers = setupWebGL2Buffers(ctx, instanceData.byteLength);
    vao = buffers.vao;
    instanceBuffer = buffers.instanceBuffer;
    posBuf = buffers.posBuf;
    uvBuf = buffers.uvBuf;
  } catch (e: unknown) {
    self.postMessage({ type: 'error', message: `WebGL setup failed: ${String(e)}` });
    return;
  }

  // Cache uniforms
  ctx.useProgram(program);
  u_viewport = ctx.getUniformLocation(program, 'u_viewport');
  u_atlasSize = ctx.getUniformLocation(program, 'u_atlasSize');
  u_cellSize = ctx.getUniformLocation(program, 'u_cellSize');
  u_distanceRange = ctx.getUniformLocation(program, 'u_distanceRange');
  u_outlineWidth = ctx.getUniformLocation(program, 'u_outlineWidth');
  u_outlineColor = ctx.getUniformLocation(program, 'u_outlineColor');
  u_outlineOpacity = ctx.getUniformLocation(program, 'u_outlineOpacity');
  u_atlas = ctx.getUniformLocation(program, 'u_atlas');

  // Build opacity config
  const cfg = payload.config;
  opacityConfig = {
    baseOpacity: cfg.opacity,
    fadeDurationMs: cfg.fadeDurationMs,
    invFadeDuration: 1 / Math.max(1, cfg.fadeDurationMs),
    backlogOpacityMultiplier: cfg.backlogOpacityMultiplier,
    depthLayersEnabled: cfg.depthLayersEnabled,
    depthFarOpacityMul: cfg.depthFarOpacityMul,
    ageFadeRate: 1 / Math.max(1, cfg.maxMessageAgeMs),
  };

  // Start atlas generation (async)
  initAtlas();

  // Start render loop
  startRenderLoop();

  self.postMessage({ type: 'ready' });
}

function handleResize(payload: { width: number; height: number }): void {
  if (canvas) {
    canvas.width = payload.width;
    canvas.height = payload.height;
    cssWidth = payload.width / dpr;
    cssHeight = payload.height / dpr;
    gl?.viewport(0, 0, payload.width, payload.height);
  }
}

function handleAddMessages(payload: { messages: WorkerMessage[] }): void {
  const cfg = config;
  if (!cfg) return;
  for (const msg of payload.messages) {
    const priority = getWorkerMessagePriority(msg);
    if (pendingQueue.size >= cfg.queueMaxSize) {
      const lowest = pendingQueue.peekLowest();
      if (lowest) {
        const lowestMsg = lowest as unknown as WorkerMessage;
        if (priority <= getWorkerMessagePriority(lowestMsg)) {
          continue;
        }
      }
      pendingQueue.dropLowest();
    }
    // biome-ignore lint/suspicious/noExplicitAny: PriorityBucketQueue typed for ChatMessage; WorkerMessage is serializable subset
    (pendingQueue as any).enqueue(msg, priority);
  }
}

function handleUpdateConfig(payload: { config: Partial<WorkerConfig> }): void {
  if (config) {
    Object.assign(config, payload.config);
    // Rebuild opacity config when opacity/fade settings change
    const cfg = config;
    if (
      payload.config.opacity !== undefined ||
      payload.config.fadeDurationMs !== undefined ||
      payload.config.maxMessageAgeMs !== undefined ||
      payload.config.backlogOpacityMultiplier !== undefined ||
      payload.config.depthLayersEnabled !== undefined ||
      payload.config.depthFarOpacityMul !== undefined
    ) {
      opacityConfig = {
        baseOpacity: cfg.opacity,
        fadeDurationMs: cfg.fadeDurationMs,
        invFadeDuration: 1 / Math.max(1, cfg.fadeDurationMs),
        backlogOpacityMultiplier: cfg.backlogOpacityMultiplier,
        depthLayersEnabled: cfg.depthLayersEnabled,
        depthFarOpacityMul: cfg.depthFarOpacityMul,
        ageFadeRate: 1 / Math.max(1, cfg.maxMessageAgeMs),
      };
    }
    if (payload.config.fontFamily !== undefined || payload.config.fontWeight !== undefined) {
      // Trigger atlas regeneration
      if (atlasReady) {
        atlasReady = false;
        if (atlasTexture && gl) {
          gl.deleteTexture(atlasTexture);
          atlasTexture = null;
        }
        atlas = null;
        initAtlas().catch((e: unknown) => {
          self.postMessage({ type: 'atlasError', error: String(e) });
        });
      }
    }
  }
}

function handleSetPaused(payload: { paused: boolean; videoPaused?: boolean }): void {
  const wasPaused = isPaused;
  isPaused = payload.paused;
  if (payload.videoPaused !== undefined) isVideoPaused = payload.videoPaused;

  if (isPaused && !wasPaused) {
    pausedAt = performance.now();
  }
  if (!isPaused && wasPaused) {
    const pauseDuration = performance.now() - pausedAt;
    if (pauseDuration > 0 && config) {
      const clamped = Math.min(pauseDuration, config.maxMessageAgeMs);
      for (const m of activeMessages) {
        m.startTime += clamped;
      }
    }
  }
}

function handleEmojiImages(payload: { images: Array<{ url: string; bitmap: ImageBitmap }> }): void {
  if (!gl) return;
  for (const { url, bitmap } of payload.images) {
    const tex = gl.createTexture();
    if (!tex) continue;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    emojiTextures.set(url, tex);
    bitmap.close();
  }
}

function handleAuthorPhotos(payload: {
  photos: Array<{ url: string; bitmap: ImageBitmap }>;
}): void {
  if (!gl) return;
  for (const { url, bitmap } of payload.photos) {
    const tex = gl.createTexture();
    if (!tex) continue;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    authorPhotoTextures.set(url, tex);
    bitmap.close();
  }
}

function handleTranslation(payload: { messageId: string; text: string }): void {
  for (let i = 0; i < activeMessages.length; i++) {
    const msg = activeMessages[i];
    if (msg && msg.message.id === payload.messageId) {
      msg.translatedText = payload.text;
      return;
    }
  }
}

function handleDestroy(): void {
  if (animFrameId !== null) cancelAnimationFrame(animFrameId);
  animFrameId = null;
  atlasReady = false;
  activeMessages.length = 0;
  pendingQueue.clear();
  retryQueue.length = 0;
  pausedAt = 0;

  if (gl) {
    if (atlasTexture) gl.deleteTexture(atlasTexture);
    const g = gl;
    emojiTextures.forEach((t) => {
      g.deleteTexture(t);
    });
    emojiTextures.clear();
    authorPhotoTextures.forEach((t) => {
      g.deleteTexture(t);
    });
    authorPhotoTextures.clear();
    if (instanceBuffer) gl.deleteBuffer(instanceBuffer);
    if (posBuf) gl.deleteBuffer(posBuf);
    if (uvBuf) gl.deleteBuffer(uvBuf);
    if (vao) gl.deleteVertexArray(vao);
    if (program) gl.deleteProgram(program);
  }

  atlasTexture = null;
  instanceBuffer = null;
  posBuf = null;
  uvBuf = null;
  vao = null;
  program = null;
  gl = null;
  atlas = null;
  canvas = null;
  config = null;
  opacityConfig = null;
}

// ── Main ──
self.onmessage = (e: MessageEvent) => {
  const { type, ...payload } = e.data as { type: string; [key: string]: unknown };
  switch (type) {
    case 'init':
      handleInit(payload as { canvas: OffscreenCanvas; config: WorkerConfig });
      break;
    case 'resize':
      handleResize(payload as { width: number; height: number });
      break;
    case 'addMessages':
      handleAddMessages(payload as { messages: WorkerMessage[] });
      break;
    case 'updateConfig':
      handleUpdateConfig(payload as { config: Partial<WorkerConfig> });
      break;
    case 'setPaused':
      handleSetPaused(payload as { paused: boolean; videoPaused?: boolean });
      break;
    case 'addEmojiImages':
      handleEmojiImages(payload as { images: Array<{ url: string; bitmap: ImageBitmap }> });
      break;
    case 'addAuthorPhotos':
      handleAuthorPhotos(payload as { photos: Array<{ url: string; bitmap: ImageBitmap }> });
      break;
    case 'setTranslation':
      handleTranslation(payload as { messageId: string; text: string });
      break;
    case 'destroy':
      handleDestroy();
      break;
    default:
      console.debug('[WebGL2 Worker] Unknown message type:', type);
      break;
  }
};
