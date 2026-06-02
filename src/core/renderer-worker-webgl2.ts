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
import { SPEED_TIER } from '@core/renderer-constants';
import { computeMessageOpacity, type OpacityConfig } from '@core/renderer-shared';
import {
  ATLAS_CELL_SIZE,
  ATLAS_SIZE,
  GLYPH_RASTER_SIZE,
  SDF_DISTANCE_RANGE,
  type SDFAtlas,
  SDFAtlasGenerator,
} from '@core/sdf-atlas';
import { SDF_FRAGMENT_SHADER, SDF_VERTEX_SHADER } from '@core/sdf-shaders';

// ── Constants ──
const FLOATS_PER_INSTANCE = 9;
const MAX_INSTANCES = 60_000;
const QUAD_POS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
const QUAD_UV = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);

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

// WebGL state
let gl: WebGL2RenderingContext | null = null;
let program: WebGLProgram | null = null;
let vao: WebGLVertexArrayObject | null = null;
let instanceBuffer: WebGLBuffer | null = null;
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

// CSS pixel dimensions (logical)
let cssWidth = 0;
let cssHeight = 0;

// DPR for viewport scaling (default 1, updated from main thread via config)
let dpr = 1;

// ── Helpers ──

function getRenderText(msg: ActiveMessage): string {
  const cfg = config;
  if (msg.translatedText && cfg?.translationMode === 'dual') {
    return msg.message.content.map((s) => (s.type === 'text' ? s.content : ' ')).join('');
  }
  if (msg.translatedText && cfg?.translationMode === 'replace') {
    return msg.translatedText;
  }
  return msg.message.content.map((s) => (s.type === 'text' ? s.content : ' ')).join('');
}

function getMessageColor(msg: ActiveMessage): [number, number, number] {
  const cfg = config;
  const color = cfg?.authorColors[msg.message.authorType] ?? '#ffffff';
  return parseColor(color);
}

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

function parseColor(hex: string): [number, number, number] {
  const h = hex.startsWith('#') ? hex : `#${hex}`;
  return [
    parseInt(h.slice(1, 3), 16) / 255 || 1,
    parseInt(h.slice(3, 5), 16) / 255 || 1,
    parseInt(h.slice(5, 7), 16) / 255 || 1,
  ];
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

function createProgram(vsSrc: string, fsSrc: string): WebGLProgram {
  const glCtx = gl;
  if (!glCtx) throw new Error('WebGL context not initialized');
  const vs = glCtx.createShader(glCtx.VERTEX_SHADER);
  if (!vs) throw new Error('Failed to create vertex shader');
  glCtx.shaderSource(vs, vsSrc);
  glCtx.compileShader(vs);
  if (!glCtx.getShaderParameter(vs, glCtx.COMPILE_STATUS)) {
    const log = glCtx.getShaderInfoLog(vs);
    glCtx.deleteShader(vs);
    throw new Error(`VS: ${log}`);
  }
  const fs = glCtx.createShader(glCtx.FRAGMENT_SHADER);
  if (!fs) throw new Error('Failed to create fragment shader');
  glCtx.shaderSource(fs, fsSrc);
  glCtx.compileShader(fs);
  if (!glCtx.getShaderParameter(fs, glCtx.COMPILE_STATUS)) {
    const log = glCtx.getShaderInfoLog(fs);
    glCtx.deleteShader(fs);
    throw new Error(`FS: ${log}`);
  }
  const p = glCtx.createProgram();
  if (!p) throw new Error('Failed to create program');
  glCtx.attachShader(p, vs);
  glCtx.attachShader(p, fs);
  glCtx.linkProgram(p);
  if (!glCtx.getProgramParameter(p, glCtx.LINK_STATUS)) {
    const log = glCtx.getProgramInfoLog(p);
    glCtx.deleteProgram(p);
    throw new Error(`Link: ${log}`);
  }
  glCtx.deleteShader(vs);
  glCtx.deleteShader(fs);
  return p;
}

function uploadAtlas(): void {
  const glCtx = gl;
  const atlasData = atlas;
  const data = atlasData?.data;
  if (!glCtx || !data) return;
  const tex = glCtx.createTexture();
  if (!tex) {
    self.postMessage({ type: 'error', message: 'Failed to create atlas texture' });
    return;
  }
  glCtx.bindTexture(glCtx.TEXTURE_2D, tex);
  glCtx.texImage2D(
    glCtx.TEXTURE_2D,
    0,
    glCtx.RGBA,
    ATLAS_SIZE,
    ATLAS_SIZE,
    0,
    glCtx.RGBA,
    glCtx.UNSIGNED_BYTE,
    data
  );
  glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_MIN_FILTER, glCtx.LINEAR);
  glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_MAG_FILTER, glCtx.LINEAR);
  glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_WRAP_S, glCtx.CLAMP_TO_EDGE);
  glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_WRAP_T, glCtx.CLAMP_TO_EDGE);
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
    const lh = Math.ceil(fontSize * 1.4);
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

function updateMessages(now: number): void {
  const cfg = config;
  if (!cfg) return;

  const mode = cfg.danmakuMode;
  let wi = 0;
  for (let i = 0; i < activeMessages.length; i++) {
    const m = activeMessages[i];
    if (!m) continue;
    if (m.laneIndex >= 0) {
      const elapsed = now - m.startTime;
      const progress = elapsed / m.duration;
      if (progress >= 1) continue;
      switch (mode) {
        case 'scroll':
          m.x = m.startX - progress * (cssWidth + m.width);
          break;
        case 'reverse':
          m.x = m.startX + progress * (cssWidth + m.width);
          break;
        case 'top':
        case 'bottom':
          m.x = m.startX;
          break;
      }
    }
    if (wi !== i) activeMessages[wi] = m;
    wi++;
  }
  if (wi < activeMessages.length) activeMessages.length = wi;
}

function buildInstances(now: number): void {
  instanceCount = 0;
  const cfg = config;
  if (!cfg || !atlas) return;

  const fs = cfg.fontSize;
  const scale = fs / GLYPH_RASTER_SIZE;
  const opCfg = opacityConfig;
  if (!opCfg) return;

  for (let mi = 0; mi < activeMessages.length; mi++) {
    if (instanceCount >= MAX_INSTANCES) break;

    const msg = activeMessages[mi];
    if (!msg) continue;

    const elapsed = msg.startTime > 0 ? Math.max(0, now - msg.startTime) : 0;
    // computeMessageOpacity expects ChatMessage; cast via unknown
    const op = computeMessageOpacity(
      msg.message as unknown as Parameters<typeof computeMessageOpacity>[0],
      elapsed,
      msg.duration,
      msg.laneIndex >= 0,
      msg.speedTier,
      opCfg
    );
    if (op <= 0) continue;

    const text = getRenderText(msg);
    if (!text) continue;

    let cx = msg.x;
    for (let ci = 0; ci < text.length; ci++) {
      if (instanceCount >= MAX_INSTANCES) break;
      const cp = text.codePointAt(ci) ?? 0x20;
      const gi = atlas.glyphs.get(cp);
      const off = instanceCount * FLOATS_PER_INSTANCE;
      const c = getMessageColor(msg);
      instanceData[off + 0] = cx;
      instanceData[off + 1] = msg.y;
      instanceData[off + 2] = fs * 0.7;
      instanceData[off + 3] = fs * 1.4;
      instanceData[off + 4] = gi?.index ?? atlas.glyphs.get(0xfffd)?.index ?? 0;
      instanceData[off + 5] = c[0];
      instanceData[off + 6] = c[1];
      instanceData[off + 7] = c[2];
      instanceData[off + 8] = op;
      instanceCount++;
      cx += (gi?.advanceWidth ?? fs * 0.7) * scale;
    }

    // Dual translation mode: render translated text above original
    if (cfg.translationMode === 'dual' && msg.translatedText) {
      let tx = msg.x;
      const ty = msg.y - fs * 1.2;
      const tOpacity = op * 0.7;
      for (let ci = 0; ci < msg.translatedText.length; ci++) {
        if (instanceCount >= MAX_INSTANCES) break;
        const cp = msg.translatedText.codePointAt(ci) ?? 0x20;
        const giDual = atlas.glyphs.get(cp);
        const offDual = instanceCount * FLOATS_PER_INSTANCE;
        const cDual = getMessageColor(msg);
        instanceData[offDual + 0] = tx;
        instanceData[offDual + 1] = ty;
        instanceData[offDual + 2] = fs * 0.7;
        instanceData[offDual + 3] = fs * 1.2;
        instanceData[offDual + 4] = giDual?.index ?? atlas.glyphs.get(0xfffd)?.index ?? 0;
        instanceData[offDual + 5] = cDual[0];
        instanceData[offDual + 6] = cDual[1];
        instanceData[offDual + 7] = cDual[2];
        instanceData[offDual + 8] = tOpacity;
        instanceCount++;
        tx += (giDual?.advanceWidth ?? fs * 0.7) * scale;
      }
    }
  }
}

function renderFrame(now: number): void {
  const glCtx = gl;
  if (!glCtx || !canvas) return;

  glCtx.viewport(0, 0, Math.ceil(cssWidth * dpr), Math.ceil(cssHeight * dpr));
  glCtx.clearColor(0, 0, 0, 0);
  glCtx.clear(glCtx.COLOR_BUFFER_BIT);

  drainQueue(now);
  updateMessages(now);
  buildInstances(now);

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
  program = createProgram(SDF_VERTEX_SHADER, SDF_FRAGMENT_SHADER);

  // VAO + buffers
  const v = ctx.createVertexArray();
  if (!v) {
    self.postMessage({ type: 'error', message: 'Failed to create VAO' });
    return;
  }
  vao = v;
  ctx.bindVertexArray(v);

  // Position buffer
  const posBuf = ctx.createBuffer();
  ctx.bindBuffer(ctx.ARRAY_BUFFER, posBuf);
  ctx.bufferData(ctx.ARRAY_BUFFER, QUAD_POS, ctx.STATIC_DRAW);
  ctx.enableVertexAttribArray(0);
  ctx.vertexAttribPointer(0, 2, ctx.FLOAT, false, 0, 0);

  // UV buffer
  const uvBuf = ctx.createBuffer();
  ctx.bindBuffer(ctx.ARRAY_BUFFER, uvBuf);
  ctx.bufferData(ctx.ARRAY_BUFFER, QUAD_UV, ctx.STATIC_DRAW);
  ctx.enableVertexAttribArray(1);
  ctx.vertexAttribPointer(1, 2, ctx.FLOAT, false, 0, 0);

  // Instance buffer
  const instBuf = ctx.createBuffer();
  if (!instBuf) {
    self.postMessage({ type: 'error', message: 'Failed to create instance buffer' });
    return;
  }
  instanceBuffer = instBuf;
  ctx.bindBuffer(ctx.ARRAY_BUFFER, instBuf);
  ctx.bufferData(ctx.ARRAY_BUFFER, instanceData.byteLength, ctx.DYNAMIC_DRAW);

  const stride = FLOATS_PER_INSTANCE * 4;
  ctx.enableVertexAttribArray(2);
  ctx.vertexAttribPointer(2, 2, ctx.FLOAT, false, stride, 0);
  ctx.vertexAttribDivisor(2, 1);
  ctx.enableVertexAttribArray(3);
  ctx.vertexAttribPointer(3, 2, ctx.FLOAT, false, stride, 8);
  ctx.vertexAttribDivisor(3, 1);
  ctx.enableVertexAttribArray(4);
  ctx.vertexAttribPointer(4, 1, ctx.FLOAT, false, stride, 16);
  ctx.vertexAttribDivisor(4, 1);
  ctx.enableVertexAttribArray(5);
  ctx.vertexAttribPointer(5, 3, ctx.FLOAT, false, stride, 20);
  ctx.vertexAttribDivisor(5, 1);
  ctx.enableVertexAttribArray(6);
  ctx.vertexAttribPointer(6, 1, ctx.FLOAT, false, stride, 32);
  ctx.vertexAttribDivisor(6, 1);

  ctx.bindVertexArray(null);
  ctx.enable(ctx.BLEND);
  ctx.blendFunc(ctx.ONE, ctx.ONE_MINUS_SRC_ALPHA);

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
  isPaused = payload.paused;
  if (payload.videoPaused !== undefined) isVideoPaused = payload.videoPaused;
}

function handleEmojiImages(_payload: {
  images: Array<{ url: string; bitmap: ImageBitmap }>;
}): void {
  void _payload;
  // Phase 3: upload ImageBitmaps to WebGL textures
}

function handleAuthorPhotos(_payload: {
  photos: Array<{ url: string; bitmap: ImageBitmap }>;
}): void {
  void _payload;
  // Phase 3: upload ImageBitmaps to WebGL textures
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

  if (gl) {
    if (atlasTexture) gl.deleteTexture(atlasTexture);
    if (instanceBuffer) gl.deleteBuffer(instanceBuffer);
    if (vao) gl.deleteVertexArray(vao);
    if (program) gl.deleteProgram(program);
  }

  atlasTexture = null;
  instanceBuffer = null;
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
  }
};
