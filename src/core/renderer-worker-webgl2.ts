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
import { rendererLayout } from '@core/design-tokens';
import {
  areSpeedTiersCompatible,
  buildLaneHeap,
  commitPlacementShared,
  computeLaneY,
  computeOccupancyMs as computeOccupancyMsShared,
  type LaneAllocationState,
  resetBatchShared,
  shiftLaneTimersShared,
} from '@core/lane-allocation-shared';
import { createLogger } from '@core/logging';
import { PriorityBucketQueue } from '@core/priority-bucket-queue';
import {
  EPSILON,
  SPEED_TIER,
  TRANSLATION_FONT_SCALE,
  TRANSLATION_GAP_PX,
} from '@core/renderer-constants';
import type { OpacityConfig } from '@core/renderer-shared';
import {
  buildSDFInstances,
  createProgram,
  FLOATS_PER_INSTANCE,
  MAX_INSTANCES,
  SDF_FRAGMENT_SHADER,
  SDF_VERTEX_SHADER,
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

const log = createLogger('RendererWorkerWebGL2');

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
  outlineWidthPx: number;
  outlineOpacity: number;
  authorColors: Record<string, string>;
  laneSpacing: number;
  safeTop: number;
  safeBottom: number;
  backlogSpeedMultiplier: number;
  depthLayersEnabled: boolean;
  depthFarOpacityMul: number;
  backlogOpacityMultiplier: number;
  showAuthor: boolean;
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

// ── WebGL2RenderWorker ──

class WebGL2RenderWorker {
  // Rendering context
  private canvas: OffscreenCanvas | null = null;
  private config: WorkerConfig | null = null;
  private animFrameId: number | null = null;
  private atlasReady = false;
  private isPaused = false;
  private isVideoPaused = false;
  private pausedAt = 0;

  // WebGL state
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private instanceBuffer: WebGLBuffer | null = null;
  private posBuf: WebGLBuffer | null = null;
  private uvBuf: WebGLBuffer | null = null;
  private atlasTexture: WebGLTexture | null = null;
  private instanceCount = 0;
  private atlas: SDFAtlas | null = null;
  private atlasGenerating = false;

  // Uniforms
  private u_viewport: WebGLUniformLocation | null = null;
  private u_atlasSize: WebGLUniformLocation | null = null;
  private u_cellSize: WebGLUniformLocation | null = null;
  private u_distanceRange: WebGLUniformLocation | null = null;
  private u_outlineWidth: WebGLUniformLocation | null = null;
  private u_outlineColor: WebGLUniformLocation | null = null;
  private u_outlineOpacity: WebGLUniformLocation | null = null;
  private u_atlas: WebGLUniformLocation | null = null;
  private opacityConfig: OpacityConfig | null = null;

  // Dimensions
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;

  // Collections
  private readonly activeMessages: ActiveMessage[] = [];
  private readonly instanceData = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);
  private readonly pendingQueue = new PriorityBucketQueue<WorkerMessage>();
  private readonly retryQueue: WorkerMessage[] = [];
  private readonly emojiTextures = new Map<string, WebGLTexture>();
  private readonly authorPhotoTextures = new Map<string, WebGLTexture>();

  // Lane allocator state (shared via LaneAllocationState)
  private readonly laneIndexToHeapIndex = new Map<number, number>();
  private readonly speedTierLanesMap = new Map<number, { tier: number; until: number }>();
  private readonly collidedLanesSet = new Set<number>();
  private laneState: LaneAllocationState = {
    heap: [],
    indexMap: this.laneIndexToHeapIndex,
    numLanes: 0,
    speedTierLanes: this.speedTierLanesMap,
    collidedLanes: this.collidedLanesSet,
  };
  private laneHeight = 0;
  private numLanes = 0;

  // ── Lane allocator methods ──

  private initLanes(height: number): void {
    const cfg = this.config;
    if (!cfg) return;
    const totalPaddingV = rendererLayout.paddingV * 2;
    // Fallback: bounding-box height ≈ fontSize * 1.1 when canvas context is unavailable
    const textHeight = Math.ceil(cfg.fontSize * 1.1);
    this.laneHeight = Math.max(1, textHeight + totalPaddingV + cfg.laneSpacing);
    const usableHeight = height * (1 - cfg.safeTop - cfg.safeBottom);
    this.numLanes = Math.max(1, Math.floor(usableHeight / this.laneHeight));
    this.laneState.numLanes = this.numLanes;

    this.speedTierLanesMap.clear();
    const now = performance.now();
    this.laneState.heap = buildLaneHeap(this.numLanes, now, this.laneIndexToHeapIndex);
  }

  private getSlotAvailableAt(laneIndex: number): number | undefined {
    const heapIdx = this.laneIndexToHeapIndex.get(laneIndex);
    if (heapIdx === undefined || heapIdx >= this.laneState.heap.length) return undefined;
    return this.laneState.heap[heapIdx]?.[1];
  }

  private resetBatch(): void {
    resetBatchShared(this.laneState);
  }

  private findPlacement(
    msgHeight: number,
    speedTier: number
  ): { laneIndex: number; waitMs: number; laneY: number } | null {
    if (this.laneState.heap.length === 0) return null;
    const now = performance.now();
    const slotCount = Math.max(1, Math.ceil(msgHeight / this.laneHeight));
    const result = this.allocateSingleLane(now, speedTier, slotCount);
    if (!result) return null;
    const laneY = computeLaneY(
      result.laneIndex,
      this.cssHeight,
      this.config?.safeTop ?? 0,
      this.laneHeight
    );
    return { ...result, laneY };
  }

  private allocateSingleLane(
    now: number,
    speedTier: number,
    slotCount: number
  ): { laneIndex: number; waitMs: number } | null {
    if (this.laneState.heap.length === 0) return null;
    const maxWaitMs = this.config?.scrollDurationMaxMs ?? 30000;
    let firstBusy: { laneIndex: number; waitMs: number } | null = null;
    let speedMatched: { laneIndex: number; waitMs: number } | null = null;
    let zeroWaitCandidates: number[] | null = null;

    for (let i = 0; i < this.numLanes - slotCount + 1; i++) {
      let tierOk = true;
      for (let s = 0; s < slotCount; s++) {
        const active = this.speedTierLanesMap.get(i + s);
        if (active && active.until > now && !areSpeedTiersCompatible(speedTier, active.tier)) {
          tierOk = false;
          break;
        }
      }
      if (!tierOk) continue;
      if (this.collidedLanesSet.has(i)) continue;

      const avail = this.getSlotAvailableAt(i);
      if (avail === undefined) continue;
      const wait = Math.max(0, Math.ceil(avail - now));
      if (wait > 0) {
        if (!firstBusy) firstBusy = { laneIndex: i, waitMs: wait };
        const active = this.speedTierLanesMap.get(i);
        if ((!speedMatched || wait < speedMatched.waitMs) && active && active.tier === speedTier) {
          speedMatched = { laneIndex: i, waitMs: wait };
        }
        continue;
      }

      if (Math.random() < EPSILON) {
        if (!zeroWaitCandidates) {
          zeroWaitCandidates = [];
          for (let j = i + 1; j < this.numLanes - slotCount + 1; j++) {
            const availJ = this.getSlotAvailableAt(j);
            if (availJ !== undefined && Math.max(0, Math.ceil(availJ - now)) === 0) {
              let jTierOk = true;
              for (let s = 0; s < slotCount; s++) {
                const activeJ = this.speedTierLanesMap.get(j + s);
                if (
                  activeJ &&
                  activeJ.until > now &&
                  !areSpeedTiersCompatible(speedTier, activeJ.tier)
                ) {
                  jTierOk = false;
                  break;
                }
              }
              if (jTierOk) zeroWaitCandidates.push(j);
            }
          }
        }
        if (zeroWaitCandidates.length > 0) continue;
      }
      return { laneIndex: i, waitMs: 0 };
    }

    if (speedMatched && speedMatched.waitMs <= maxWaitMs) return speedMatched;
    // Phase 3: fastest-free (real-time only; backlog returns null)
    if (firstBusy && firstBusy.waitMs <= maxWaitMs && speedTier !== SPEED_TIER.BACKLOG)
      return firstBusy;
    return null;
  }

  private commitPlacement(
    laneIndex: number,
    slotCount: number,
    startTime: number,
    durationMs: number,
    speedTier: number,
    msgWidth?: number
  ): void {
    const cfg = this.config;
    if (!cfg) return;
    const screenWidth = this.cssWidth;
    const occupancyMs = computeOccupancyMsShared(
      durationMs,
      (cfg.exitPaddingPx as number | undefined) ?? 0,
      (cfg.headwayGapRatio as number | undefined) ?? 0.08,
      msgWidth,
      screenWidth
    );
    commitPlacementShared(
      this.laneState,
      laneIndex,
      slotCount,
      startTime,
      occupancyMs,
      durationMs,
      speedTier
    );
  }

  // ── Helpers ──

  private getOutlineColor(): [number, number, number] {
    const cfg = this.config;
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
  private estimateTextWidth(text: string, fontSize: number): number {
    if (!text) return 0;
    // Fallback: average character width ≈ fontSize * 0.6
    return Math.ceil(text.length * fontSize * 0.6);
  }

  private getWorkerMessagePriority(msg: WorkerMessage): number {
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

  private uploadAtlas(): void {
    const glCtx = this.gl;
    const atlasData = this.atlas;
    const data = atlasData?.data;
    if (!glCtx || !data) return;
    if (this.atlasTexture && glCtx) glCtx.deleteTexture(this.atlasTexture);
    const tex = uploadSDFAtlas(glCtx, data, ATLAS_SIZE);
    if (!tex) {
      self.postMessage({ type: 'error', message: 'Failed to create atlas texture' });
      return;
    }
    this.atlasTexture = tex;
    if (atlasData) {
      atlasData.texture = tex;
      atlasData.uploaded = true;
    }
  }

  private async initAtlas(): Promise<void> {
    const cfg = this.config;
    if (!cfg || this.atlasGenerating) return;
    this.atlasGenerating = true;
    try {
      this.atlas = await new SDFAtlasGenerator().generate(cfg.fontFamily, cfg.fontWeight);
      this.uploadAtlas();
      this.atlasReady = true;
      this.atlasGenerating = false;
      self.postMessage({ type: 'atlasReady', glyphCount: this.atlas.glyphs.size });
    } catch (e: unknown) {
      this.atlasGenerating = false;
      self.postMessage({ type: 'atlasError', error: String(e) });
    }
  }

  // ── Render Loop ──

  private drainQueue(_now: number): void {
    const cfg = this.config;
    if (!cfg) return;

    const maxMessages = cfg.queueMaxSize;

    // Initialize lanes on first call or when dimensions change
    if (this.laneState.heap.length === 0) {
      this.initLanes(this.cssHeight);
    }

    this.resetBatch();

    while (!this.pendingQueue.isEmpty) {
      if (this.activeMessages.length >= maxMessages) break;

      const msg = this.pendingQueue.peek();
      if (!msg) break;

      const fontSize = cfg.fontSize;
      let lh = Math.ceil(fontSize * 1.4);
      if (cfg.translationEnabled && cfg.translationMode === 'dual') {
        const transFontSize = Math.round(fontSize * TRANSLATION_FONT_SCALE);
        lh += Math.ceil(transFontSize * 1.2) + TRANSLATION_GAP_PX;
      }
      const msgContent = msg.content;
      if (!Array.isArray(msgContent)) {
        this.pendingQueue.dequeue();
        continue;
      }
      const text = msgContent
        .filter(
          (
            s:
              | { type: string; content: string }
              | { type: string; emojiUrl: string; emojiAlt?: string }
          ): s is { type: 'text'; content: string } => s.type === 'text'
        )
        .map((s) => s.content)
        .join('');
      const w = text ? this.estimateTextWidth(text, fontSize) : 0;

      const speedTier = msg.isBacklog ? SPEED_TIER.BACKLOG : SPEED_TIER.MID;
      const placement = this.findPlacement(lh, speedTier);

      if (!placement) {
        // No lane available — push to retry queue and stop draining
        this.pendingQueue.dequeue();
        this.retryQueue.push(msg);
        continue;
      }

      this.pendingQueue.dequeue();

      const startX =
        cfg.danmakuMode === 'reverse'
          ? -w
          : cfg.danmakuMode === 'scroll'
            ? this.cssWidth
            : (this.cssWidth - w) / 2;

      const now2 = performance.now();

      const active: ActiveMessage = {
        message: msg,
        x: startX,
        y: placement.laneY,
        width: Math.max(1, Math.ceil(w)),
        height: lh,
        startX,
        startTime: now2,
        duration: cfg.scrollDurationMaxMs,
        fadeStartTime: now2,
        laneIndex: placement.laneIndex,
        speedTier,
        translatedText: null,
      };

      this.activeMessages.push(active);
      const slotCount = Math.max(1, Math.ceil(lh / this.laneHeight));
      this.commitPlacement(
        placement.laneIndex,
        slotCount,
        now2,
        cfg.scrollDurationMaxMs,
        speedTier,
        Math.ceil(w)
      );
    }

    // Refill from retry queue
    if (this.pendingQueue.isEmpty && this.retryQueue.length > 0) {
      for (const m of this.retryQueue) {
        this.pendingQueue.enqueue(m, this.getWorkerMessagePriority(m));
      }
      this.retryQueue.length = 0;
    }
  }

  private renderFrame(now: number): void {
    const glCtx = this.gl;
    if (!glCtx || !this.canvas) return;

    glCtx.viewport(0, 0, Math.ceil(this.cssWidth * this.dpr), Math.ceil(this.cssHeight * this.dpr));
    glCtx.clearColor(0, 0, 0, 0);
    glCtx.clear(glCtx.COLOR_BUFFER_BIT);

    this.drainQueue(now);
    updateMessagePositions(
      this.activeMessages,
      this.config?.danmakuMode ?? 'scroll',
      this.cssWidth,
      now
    );
    const result = buildSDFInstances(
      this.activeMessages,
      this.atlas,
      this.instanceData,
      MAX_INSTANCES,
      this.config?.fontSize ?? 16,
      (this.config?.fontSize ?? 16) / GLYPH_RASTER_SIZE,
      this.config?.authorColors ?? {},
      this.opacityConfig,
      now,
      this.config?.translationMode,
      undefined
    );
    this.instanceCount = result.instanceCount;

    if (this.instanceCount > 0 && this.atlasTexture && this.program && this.vao) {
      const cfg = this.config;
      if (!cfg) return;

      glCtx.useProgram(this.program);
      glCtx.bindVertexArray(this.vao);
      glCtx.activeTexture(glCtx.TEXTURE0);
      glCtx.bindTexture(glCtx.TEXTURE_2D, this.atlasTexture);

      if (this.u_viewport) glCtx.uniform2f(this.u_viewport, this.cssWidth, this.cssHeight);
      if (this.u_atlasSize) glCtx.uniform1f(this.u_atlasSize, ATLAS_SIZE);
      if (this.u_cellSize) glCtx.uniform1f(this.u_cellSize, ATLAS_CELL_SIZE);
      if (this.u_distanceRange) glCtx.uniform1f(this.u_distanceRange, SDF_DISTANCE_RANGE);
      if (this.u_outlineWidth)
        glCtx.uniform1f(this.u_outlineWidth, cfg.outlineWidthPx / SDF_DISTANCE_RANGE);
      if (this.u_outlineColor) {
        const oc = this.getOutlineColor();
        glCtx.uniform3f(this.u_outlineColor, oc[0], oc[1], oc[2]);
      }
      if (this.u_outlineOpacity) glCtx.uniform1f(this.u_outlineOpacity, cfg.outlineOpacity);
      if (this.u_atlas) glCtx.uniform1i(this.u_atlas, 0);

      glCtx.bindBuffer(glCtx.ARRAY_BUFFER, this.instanceBuffer);
      glCtx.bufferSubData(
        glCtx.ARRAY_BUFFER,
        0,
        this.instanceData.subarray(0, this.instanceCount * FLOATS_PER_INSTANCE)
      );
      glCtx.drawArraysInstanced(glCtx.TRIANGLES, 0, 6, this.instanceCount);
      glCtx.bindVertexArray(null);
    }
  }

  private startRenderLoop(): void {
    if (this.animFrameId !== null) return;
    const loop = (t: number) => {
      this.animFrameId = self.requestAnimationFrame(loop);
      if (!this.atlasReady || this.isPaused || this.isVideoPaused) return;
      this.renderFrame(t);
    };
    this.animFrameId = self.requestAnimationFrame(loop);
  }

  // ── Message Handlers ──

  handleInit(payload: { canvas: OffscreenCanvas; config: WorkerConfig }): void {
    if (this.canvas !== null) {
      self.postMessage({ type: 'error', message: 'Already initialized' });
      return;
    }

    this.canvas = payload.canvas;
    this.config = payload.config;

    this.dpr = ((payload.config as Record<string, unknown>).dpr as number | undefined) ?? 1;
    this.cssWidth = this.canvas.width / this.dpr;
    this.cssHeight = this.canvas.height / this.dpr;

    // Initialize lanes
    this.initLanes(this.cssHeight);

    const ctx = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!ctx) {
      self.postMessage({ type: 'error', message: 'WebGL2 not supported in worker' });
      return;
    }
    this.gl = ctx;

    // Compile shaders
    this.program = createProgram(ctx, SDF_VERTEX_SHADER, SDF_FRAGMENT_SHADER);

    // VAO + buffers (shared setup)
    try {
      const buffers = setupWebGL2Buffers(ctx, this.instanceData.byteLength);
      this.vao = buffers.vao;
      this.instanceBuffer = buffers.instanceBuffer;
      this.posBuf = buffers.posBuf;
      this.uvBuf = buffers.uvBuf;
    } catch (e: unknown) {
      self.postMessage({ type: 'error', message: `WebGL setup failed: ${String(e)}` });
      return;
    }

    // Cache uniforms
    ctx.useProgram(this.program);
    this.u_viewport = ctx.getUniformLocation(this.program, 'u_viewport');
    this.u_atlasSize = ctx.getUniformLocation(this.program, 'u_atlasSize');
    this.u_cellSize = ctx.getUniformLocation(this.program, 'u_cellSize');
    this.u_distanceRange = ctx.getUniformLocation(this.program, 'u_distanceRange');
    this.u_outlineWidth = ctx.getUniformLocation(this.program, 'u_outlineWidth');
    this.u_outlineColor = ctx.getUniformLocation(this.program, 'u_outlineColor');
    this.u_outlineOpacity = ctx.getUniformLocation(this.program, 'u_outlineOpacity');
    this.u_atlas = ctx.getUniformLocation(this.program, 'u_atlas');

    // Build opacity config
    const cfg = payload.config;
    this.opacityConfig = {
      baseOpacity: cfg.opacity,
      fadeDurationMs: cfg.fadeDurationMs,
      invFadeDuration: 1 / Math.max(1, cfg.fadeDurationMs),
      backlogOpacityMultiplier: cfg.backlogOpacityMultiplier,
      depthLayersEnabled: cfg.depthLayersEnabled,
      depthFarOpacityMul: cfg.depthFarOpacityMul,
      ageFadeRate: 1 / Math.max(1, cfg.maxMessageAgeMs),
    };

    // Start atlas generation (async)
    this.initAtlas();

    // Start render loop
    this.startRenderLoop();

    self.postMessage({ type: 'ready' });
  }

  handleResize(payload: { width: number; height: number }): void {
    if (this.canvas) {
      this.canvas.width = payload.width;
      this.canvas.height = payload.height;
      this.cssWidth = payload.width / this.dpr;
      this.cssHeight = payload.height / this.dpr;
      this.gl?.viewport(0, 0, payload.width, payload.height);
      // Reinitialize lanes when dimensions change
      this.laneState.heap = [];
      this.laneIndexToHeapIndex.clear();
      this.speedTierLanesMap.clear();
      this.collidedLanesSet.clear();
      this.initLanes(this.cssHeight);
    }
  }

  handleAddMessages(payload: { messages: WorkerMessage[] }): void {
    const cfg = this.config;
    if (!cfg) return;
    for (const msg of payload.messages) {
      const priority = this.getWorkerMessagePriority(msg);
      if (this.pendingQueue.size >= cfg.queueMaxSize) {
        const lowest = this.pendingQueue.peekLowest();
        if (lowest) {
          if (priority <= this.getWorkerMessagePriority(lowest)) {
            continue;
          }
        }
        this.pendingQueue.dropLowest();
      }
      this.pendingQueue.enqueue(msg, priority);
    }
  }

  handleUpdateConfig(payload: { config: Partial<WorkerConfig> }): void {
    if (this.config) {
      Object.assign(this.config, payload.config);
      // Rebuild opacity config when opacity/fade settings change
      const cfg = this.config;
      if (
        payload.config.opacity !== undefined ||
        payload.config.fadeDurationMs !== undefined ||
        payload.config.maxMessageAgeMs !== undefined ||
        payload.config.backlogOpacityMultiplier !== undefined ||
        payload.config.depthLayersEnabled !== undefined ||
        payload.config.depthFarOpacityMul !== undefined
      ) {
        this.opacityConfig = {
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
        if (this.atlasReady) {
          this.atlasReady = false;
          if (this.atlasTexture && this.gl) {
            this.gl.deleteTexture(this.atlasTexture);
            this.atlasTexture = null;
          }
          this.atlas = null;
          this.initAtlas().catch((e: unknown) => {
            self.postMessage({ type: 'atlasError', error: String(e) });
          });
        }
      }
    }
  }

  handleSetPaused(payload: { paused: boolean; videoPaused?: boolean }): void {
    const wasPaused = this.isPaused;
    this.isPaused = payload.paused;
    if (payload.videoPaused !== undefined) this.isVideoPaused = payload.videoPaused;

    if (this.isPaused && !wasPaused) {
      this.pausedAt = performance.now();
    }
    if (!this.isPaused && wasPaused) {
      const pauseDuration = performance.now() - this.pausedAt;
      if (pauseDuration > 0 && this.config) {
        const clamped = Math.min(pauseDuration, this.config.maxMessageAgeMs);
        for (const m of this.activeMessages) {
          m.startTime += clamped;
        }
        // Shift lane timers by pause duration using shared helper
        shiftLaneTimersShared(this.laneState, clamped);
      }
    }
  }

  handleEmojiImages(payload: { images: Array<{ url: string; bitmap: ImageBitmap }> }): void {
    if (!this.gl) return;
    for (const { url, bitmap } of payload.images) {
      const tex = this.gl.createTexture();
      if (!tex) continue;
      this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
      this.gl.texImage2D(
        this.gl.TEXTURE_2D,
        0,
        this.gl.RGBA,
        this.gl.RGBA,
        this.gl.UNSIGNED_BYTE,
        bitmap
      );
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
      this.emojiTextures.set(url, tex);
      bitmap.close();
    }
  }

  handleAuthorPhotos(payload: { photos: Array<{ url: string; bitmap: ImageBitmap }> }): void {
    if (!this.gl) return;
    for (const { url, bitmap } of payload.photos) {
      const tex = this.gl.createTexture();
      if (!tex) continue;
      this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
      this.gl.texImage2D(
        this.gl.TEXTURE_2D,
        0,
        this.gl.RGBA,
        this.gl.RGBA,
        this.gl.UNSIGNED_BYTE,
        bitmap
      );
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
      this.authorPhotoTextures.set(url, tex);
      bitmap.close();
    }
  }

  handleTranslation(payload: { messageId: string; text: string }): void {
    for (let i = 0; i < this.activeMessages.length; i++) {
      const msg = this.activeMessages[i];
      if (msg && msg.message.id === payload.messageId) {
        msg.translatedText = payload.text;
        return;
      }
    }
  }

  dispose(): void {
    if (this.animFrameId !== null) cancelAnimationFrame(this.animFrameId);
    this.animFrameId = null;
    this.atlasReady = false;
    this.activeMessages.length = 0;
    this.pendingQueue.clear();
    this.retryQueue.length = 0;
    this.pausedAt = 0;

    // Clear lane allocator state
    this.laneState.heap = [];
    this.laneIndexToHeapIndex.clear();
    this.speedTierLanesMap.clear();
    this.collidedLanesSet.clear();

    if (this.gl) {
      if (this.atlasTexture) this.gl.deleteTexture(this.atlasTexture);
      const g = this.gl;
      this.emojiTextures.forEach((t) => {
        g.deleteTexture(t);
      });
      this.emojiTextures.clear();
      this.authorPhotoTextures.forEach((t) => {
        g.deleteTexture(t);
      });
      this.authorPhotoTextures.clear();
      if (this.instanceBuffer) this.gl.deleteBuffer(this.instanceBuffer);
      if (this.posBuf) this.gl.deleteBuffer(this.posBuf);
      if (this.uvBuf) this.gl.deleteBuffer(this.uvBuf);
      if (this.vao) this.gl.deleteVertexArray(this.vao);
      if (this.program) this.gl.deleteProgram(this.program);
    }

    this.atlasTexture = null;
    this.instanceBuffer = null;
    this.posBuf = null;
    this.uvBuf = null;
    this.vao = null;
    this.program = null;
    this.gl = null;
    this.atlas = null;
    this.canvas = null;
    this.config = null;
    this.opacityConfig = null;
  }
}

// ── Main ──
let worker: WebGL2RenderWorker | null = null;

self.onmessage = (e: MessageEvent) => {
  const { type, ...payload } = e.data as { type: string; [key: string]: unknown };
  switch (type) {
    case 'init': {
      if (worker) worker.dispose();
      worker = new WebGL2RenderWorker();
      worker.handleInit(payload as { canvas: OffscreenCanvas; config: WorkerConfig });
      break;
    }
    case 'resize':
      worker?.handleResize(payload as { width: number; height: number });
      break;
    case 'addMessages':
      worker?.handleAddMessages(payload as { messages: WorkerMessage[] });
      break;
    case 'updateConfig':
      worker?.handleUpdateConfig(payload as { config: Partial<WorkerConfig> });
      break;
    case 'setPaused':
      worker?.handleSetPaused(payload as { paused: boolean; videoPaused?: boolean });
      break;
    case 'addEmojiImages':
      worker?.handleEmojiImages(payload as { images: Array<{ url: string; bitmap: ImageBitmap }> });
      break;
    case 'addAuthorPhotos':
      worker?.handleAuthorPhotos(
        payload as { photos: Array<{ url: string; bitmap: ImageBitmap }> }
      );
      break;
    case 'setTranslation':
      worker?.handleTranslation(payload as { messageId: string; text: string });
      break;
    case 'destroy':
      worker?.dispose();
      worker = null;
      break;
    default:
      log.debug('Unknown message type:', type);
      break;
  }
};
