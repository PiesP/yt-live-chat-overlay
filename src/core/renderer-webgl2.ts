// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * RendererWebGL2 — WebGL2 SDF instanced text renderer.
 *
 * Extends RendererBase. Renders all text via GPU-accelerated SDF.
 */

import type { ChatMessage, OverlaySettings } from '@app-types';
import { drawAuthorPhoto, drawRoundRect } from '@core/canvas-rendering-shared';
import { ChannelLanguageMemory } from '@core/channel-language-memory';
import { computeOutlineColor } from '@core/color-utils';
import { rendererLayout, statusBarLayout } from '@core/design-tokens';
import type { LanePlacement } from '@core/lane-allocator';
import { LanguageDetectorService } from '@core/language-detector-service';
import { createLogger } from '@core/logging';
import type { Overlay } from '@core/overlay';
import { PriorityBucketQueue } from '@core/priority-bucket-queue';
import type { ConnectionStatus } from '@core/renderer-base';
import { RendererBase } from '@core/renderer-base';
import type { CanvasMessage } from '@core/renderer-constants';
import {
  CARD_BG_OPACITY_FACTOR,
  SPEED_TIER,
  TRANSLATION_FONT_SCALE,
  TRANSLATION_GAP_PX,
} from '@core/renderer-constants';
import {
  computeMessageOpacity,
  enqueueWithOverflow,
  type OpacityConfig,
} from '@core/renderer-shared';
import {
  buildSDFInstances,
  createProgram,
  FLOATS_PER_INSTANCE,
  MAX_INSTANCES,
  SDF_FRAGMENT_SHADER,
  SDF_VERTEX_SHADER,
  setupWebGL2Buffers,
  TEXTURE_FRAGMENT_SHADER,
  TEXTURE_VERTEX_SHADER,
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
import { getFontString, measureTextWidth } from '@core/text-measure';

const log = createLogger('RendererWebGL2');

export class RendererWebGL2 extends RendererBase {
  private gl!: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private instanceBuffer!: WebGLBuffer;
  private atlasTexture: WebGLTexture | null = null;

  private instanceData = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);
  private instanceCount = 0;

  private atlas: SDFAtlas | null = null;
  private atlasReady = false;
  private atlasGenerating = false;

  // Texture program for emoji + card background rendering
  private textureProgram!: WebGLProgram;
  private u_texViewport: WebGLUniformLocation | null = null;
  private u_texSampler: WebGLUniformLocation | null = null;
  private emojiTextures = new Map<string, WebGLTexture>();
  private solidWhiteTex: WebGLTexture | null = null; // 1x1 white pixel for card backgrounds
  private texQuadCount = 0;
  private texQuadData = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);

  private dpr = 1;
  private cssWidth = 0;
  private cssHeight = 0;

  private messages: CanvasMessage[] = [];
  private animFrameId: number | null = null;

  private readonly pendingQueue = new PriorityBucketQueue();
  private readonly retryQueue: ChatMessage[] = [];

  private _opacityConfig!: OpacityConfig;
  private _ageFadeRate = 0;
  private _invFadeDuration = 0;

  // Canvas2D overlay for card decorations (round rects, author photos)
  private overlay2d!: HTMLCanvasElement;
  private ctx2d!: CanvasRenderingContext2D;
  private authorPhotoCache = new Map<string, HTMLImageElement>();

  // Uniform locations
  private u_viewport!: WebGLUniformLocation | null;
  private u_atlasSize!: WebGLUniformLocation | null;
  private u_cellSize!: WebGLUniformLocation | null;
  private u_distanceRange!: WebGLUniformLocation | null;
  private u_outlineWidth!: WebGLUniformLocation | null;
  private u_outlineColor!: WebGLUniformLocation | null;
  private u_outlineOpacity!: WebGLUniformLocation | null;
  private u_atlas!: WebGLUniformLocation | null;

  private connectionStatus: ConnectionStatus = 'connected';
  private isContextLost = false;

  // ── Language source detection (shared parity with CanvasRenderer) ──
  private languageDetector: LanguageDetectorService | null = null;
  private channelMemory: ChannelLanguageMemory | null = null;
  private sourceDetectionDone = false;
  private sourceSampleBuffer: string[] = [];
  private static readonly SOURCE_SAMPLE_COUNT = 8;

  get laneCount(): number {
    return this.laneAllocator.getLaneCount();
  }

  constructor(overlay: Overlay, settings: OverlaySettings) {
    super(overlay, settings);
    this.dpr = window.devicePixelRatio || 1;
    this._ageFadeRate = 1 / Math.max(1, settings.maxMessageAgeMs);
    this._invFadeDuration = 1 / Math.max(1, settings.fadeDurationMs);
    this.rebuildOpacityConfig();

    // Initialize language detection pipeline for 'auto' source
    if (settings.translationSource === 'auto') {
      this.languageDetector = new LanguageDetectorService();
      this.channelMemory = new ChannelLanguageMemory();
      void this.languageDetector.initialize().catch((err: unknown) => {
        log.debug('LanguageDetector init failed, auto-source unavailable:', err);
        this.languageDetector = null;
      });
    }

    const container = overlay.getContainer();
    const canvas = document.createElement('canvas');
    canvas.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none';
    canvas.setAttribute('aria-hidden', 'true');

    // Probe WebGL2 availability BEFORE inserting DOM elements.
    // If WebGL2 is unavailable, throw before any DOM manipulation so
    // the factory (createRenderer) can cleanly fall back to Canvas2D.
    const probeCtx = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!probeCtx) throw new Error('WebGL2 not supported');

    // Canvas2D overlay for card decorations (round rects, author photos)
    const overlay2d = document.createElement('canvas');
    overlay2d.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1';
    overlay2d.setAttribute('aria-hidden', 'true');

    const ctx2d = overlay2d.getContext('2d');
    if (!ctx2d) throw new Error('Failed to create 2D overlay context');

    // Visually-hidden live region for connection status announcements
    const statusRegion = document.createElement('div');
    statusRegion.setAttribute('aria-live', 'polite');
    statusRegion.setAttribute('role', 'status');
    statusRegion.style.cssText =
      'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';

    // Append DOM elements — only reached after WebGL2 is confirmed.
    if (container) {
      container.appendChild(canvas);
      container.appendChild(overlay2d);
      container.appendChild(statusRegion);
    }

    this.initWebGL2(canvas, overlay2d, ctx2d, statusRegion);
  }

  /**
   * Initialize WebGL2 context, programs, buffers, and atlas.
   * Extracted from constructor so that failures can be caught and cleaned up.
   */
  private initWebGL2(
    canvas: HTMLCanvasElement,
    overlay2d: HTMLCanvasElement,
    ctx2d: CanvasRenderingContext2D,
    _statusRegion: HTMLDivElement
  ): void {
    this.overlay2d = overlay2d;
    this.ctx2d = ctx2d;

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;

    // Context loss handling — prevent default so the browser allows restoration,
    // then reinitialize all GL resources when the context is restored.
    canvas.addEventListener('webglcontextlost', (e: Event) => {
      e.preventDefault();
      this.isContextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.isContextLost = false;
      this.reinitializeGLResources();
      // Restart the render loop if it was stopped during context loss.
      // Without this, if onPause() cancelled the rAF while the context
      // was lost, the loop never restarts after restore — messages
      // accumulate in the pendingQueue but never get rendered.
      if (
        this.animFrameId === null &&
        !this.isPaused &&
        !this.isVideoPaused &&
        (!this.pendingQueue.isEmpty || this.messages.length > 0 || this.retryQueue.length > 0)
      ) {
        this.startRenderLoop();
      }
    });

    this.program = createProgram(gl, SDF_VERTEX_SHADER, SDF_FRAGMENT_SHADER);

    // Create texture program for emoji + card backgrounds
    this.textureProgram = createProgram(gl, TEXTURE_VERTEX_SHADER, TEXTURE_FRAGMENT_SHADER);

    // Cache texture program uniforms
    gl.useProgram(this.textureProgram);
    this.u_texViewport = gl.getUniformLocation(this.textureProgram, 'u_viewport');
    this.u_texSampler = gl.getUniformLocation(this.textureProgram, 'u_texture');
    gl.uniform1i(this.u_texSampler, 0);

    // Create 1x1 white texture for solid-color card backgrounds
    const whiteTex = gl.createTexture();
    if (whiteTex) {
      gl.bindTexture(gl.TEXTURE_2D, whiteTex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([255, 255, 255, 255])
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.solidWhiteTex = whiteTex;
    }

    // Restore SDF program
    gl.useProgram(this.program);

    const buffers = setupWebGL2Buffers(gl, this.instanceData.byteLength);
    this.vao = buffers.vao;
    this.instanceBuffer = buffers.instanceBuffer;

    this.cacheUniforms();
    this.initAtlas();
  }

  private rebuildOpacityConfig(): void {
    const s = this.settings;
    this._opacityConfig = {
      baseOpacity: s.opacity,
      fadeDurationMs: s.fadeDurationMs,
      invFadeDuration: this._invFadeDuration,
      backlogOpacityMultiplier: s.backlogOpacityMultiplier,
      depthLayersEnabled: s.depthLayersEnabled,
      depthFarOpacityMul: s.depthFarOpacityMul,
      ageFadeRate: this._ageFadeRate,
    };
  }

  updateSettings(settings: OverlaySettings, options?: { resetState?: boolean }): void {
    const fontChanged =
      settings.fontFamily !== this.settings.fontFamily ||
      settings.fontWeight !== this.settings.fontWeight ||
      settings.fontSize !== this.settings.fontSize;

    const opacityChanged =
      settings.opacity !== this.settings.opacity ||
      settings.fadeDurationMs !== this.settings.fadeDurationMs ||
      settings.maxMessageAgeMs !== this.settings.maxMessageAgeMs ||
      settings.backlogOpacityMultiplier !== this.settings.backlogOpacityMultiplier ||
      settings.depthLayersEnabled !== this.settings.depthLayersEnabled ||
      settings.depthFarOpacityMul !== this.settings.depthFarOpacityMul;

    super.updateSettings(settings, options);

    if (opacityChanged) {
      this._ageFadeRate = 1 / Math.max(1, settings.maxMessageAgeMs);
      this._invFadeDuration = 1 / Math.max(1, settings.fadeDurationMs);
      this.rebuildOpacityConfig();
    }

    if (fontChanged && this.atlasReady) {
      this.atlasReady = false;
      if (this.atlasTexture) {
        this.gl.deleteTexture(this.atlasTexture);
        this.atlasTexture = null;
      }
      this.atlas = null;
      this.initAtlas().catch((e: unknown) => {
        log.warn('Atlas regeneration failed after font change:', e);
      });
    }
  }

  private cacheUniforms(): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    this.u_viewport = gl.getUniformLocation(this.program, 'u_viewport');
    this.u_atlasSize = gl.getUniformLocation(this.program, 'u_atlasSize');
    this.u_cellSize = gl.getUniformLocation(this.program, 'u_cellSize');
    this.u_distanceRange = gl.getUniformLocation(this.program, 'u_distanceRange');
    this.u_outlineWidth = gl.getUniformLocation(this.program, 'u_outlineWidth');
    this.u_outlineColor = gl.getUniformLocation(this.program, 'u_outlineColor');
    this.u_outlineOpacity = gl.getUniformLocation(this.program, 'u_outlineOpacity');
    this.u_atlas = gl.getUniformLocation(this.program, 'u_atlas');
  }

  private getEmojiTexture(url: string): WebGLTexture | null {
    const cached = this.emojiTextures.get(url);
    if (cached) return cached;
    // Create placeholder + load async
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([200, 200, 200, 255])
    );
    this.emojiTextures.set(url, tex);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };
    img.src = url;
    return tex;
  }

  private loadAuthorPhoto(url: string): HTMLImageElement | undefined {
    const cached = this.authorPhotoCache.get(url);
    if (cached?.complete && cached.naturalWidth > 0) return cached;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    this.authorPhotoCache.set(url, img);
    return undefined; // not loaded yet
  }

  private async initAtlas(): Promise<void> {
    if (this.atlasGenerating) return;
    this.atlasGenerating = true;
    try {
      const newAtlas = await new SDFAtlasGenerator().generate(
        this.settings.fontFamily,
        this.settings.fontWeight
      );
      // Only assign after successful generation — keeps old atlas intact on failure
      this.atlas = newAtlas;
      this.uploadAtlas();
      this.atlasReady = true;
      this.atlasGenerating = false;
      log.info(`Atlas ready: ${this.atlas.glyphs.size} glyphs`);
      // Restart the render loop if there is pending work and we are not paused.
      // This covers the edge case where onResume() was called while the atlas
      // was still regenerating (e.g., context loss during pause + restore
      // before tab resume). Without this, queued messages would sit unrendered
      // until the next addMessage() triggers a 0→1 queue transition.
      if (
        this.animFrameId === null &&
        !this.isPaused &&
        !this.isVideoPaused &&
        (!this.pendingQueue.isEmpty || this.messages.length > 0 || this.retryQueue.length > 0)
      ) {
        this.startRenderLoop();
      }
    } catch (e: unknown) {
      log.warn('Atlas failed:', e);
      this.atlasGenerating = false;
      // Keep old atlas instead of nullifying — prevents permanent context loss
      throw e;
    }
  }

  private uploadAtlas(): void {
    const data = this.atlas?.data;
    if (!data) return;
    const gl = this.gl;
    const tex = uploadSDFAtlas(gl, data, ATLAS_SIZE);
    if (!tex) throw new Error('Failed to create texture');
    if (!this.atlas) return;
    this.atlas.texture = tex;
    this.atlasTexture = tex;
    this.atlas.uploaded = true;
  }

  /**
   * Reinitialize all GPU resources after a WebGL2 context restore.
   * Recreates program, buffers, VAO, and re-generates the SDF atlas.
   */
  private reinitializeGLResources(): void {
    const gl = this.gl;
    this.program = createProgram(gl, SDF_VERTEX_SHADER, SDF_FRAGMENT_SHADER);
    this.textureProgram = createProgram(gl, TEXTURE_VERTEX_SHADER, TEXTURE_FRAGMENT_SHADER);

    gl.useProgram(this.textureProgram);
    this.u_texViewport = gl.getUniformLocation(this.textureProgram, 'u_viewport');
    this.u_texSampler = gl.getUniformLocation(this.textureProgram, 'u_texture');
    gl.uniform1i(this.u_texSampler, 0);

    // Recreate 1x1 white texture
    if (this.solidWhiteTex) gl.deleteTexture(this.solidWhiteTex);
    const whiteTex = gl.createTexture();
    if (whiteTex) {
      gl.bindTexture(gl.TEXTURE_2D, whiteTex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([255, 255, 255, 255])
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.solidWhiteTex = whiteTex;
    }

    gl.useProgram(this.program);
    const buffers = setupWebGL2Buffers(gl, this.instanceData.byteLength);
    this.vao = buffers.vao;
    this.instanceBuffer = buffers.instanceBuffer;
    this.cacheUniforms();

    // Re-generate atlas (async — sets atlasReady when done)
    this.atlasReady = false;
    this.atlasTexture = null;
    this.initAtlas().catch((e: unknown) => {
      log.warn('Atlas regeneration failed after context restore:', e);
    });
  }

  addMessage(message: ChatMessage): void {
    if (!this.isMessageAllowed(message)) return;

    // Auto-detect source language from message samples
    if (
      this.settings.translationSource === 'auto' &&
      this.languageDetector &&
      !this.sourceDetectionDone &&
      message.text?.trim()
    ) {
      this.sourceSampleBuffer.push(message.text);
      if (this.sourceSampleBuffer.length >= RendererWebGL2.SOURCE_SAMPLE_COUNT) {
        void this.performSourceDetection();
      }
    }

    const priority = RendererBase.getMessagePriority(message);
    const result = enqueueWithOverflow(
      this.pendingQueue,
      message,
      priority,
      (reason) => this.observability.onMessageDropped(reason),
      this.settings.queueMaxSize
    );
    if (result === 'dropped') return;
    if (this.pendingQueue.size === 1 && !this.isPaused && !this.isVideoPaused) {
      this.startRenderLoop();
    }
  }

  /** Set translated text for an active message. Searches only placed messages (not the pending queue). */
  setTranslatedText(messageId: string, translatedText: string): void {
    for (const msg of this.messages) {
      if (msg.message.id === messageId) {
        msg.translatedText = translatedText;
        return;
      }
    }
  }

  private createCanvasMessage(msg: ChatMessage): CanvasMessage {
    const fontSize = this.settings.fontSize;
    let lh = Math.ceil(fontSize * 1.4);
    // Add translation height when dual mode is enabled (translation renders below the message)
    if (this.settings.translationEnabled && this.settings.translationMode === 'dual') {
      const transFontSize = Math.round(fontSize * TRANSLATION_FONT_SCALE);
      lh += Math.ceil(transFontSize * 1.2) + TRANSLATION_GAP_PX;
    }
    const font = getFontString(fontSize, this.settings.fontWeight, this.settings.fontFamily);
    const text = Array.isArray(msg.content)
      ? msg.content.map((s) => (s.type === 'text' ? s.content : '')).join('')
      : '';
    const w = text ? measureTextWidth(text, font) : 0;
    return {
      message: msg,
      x: 0,
      y: 0,
      width: Math.max(1, Math.ceil(w)),
      height: lh,
      startX: 0,
      startTime: 0,
      fadeStartTime: 0,
      duration: this.settings.scrollDurationMaxMs,
      invDuration: 1 / this.settings.scrollDurationMaxMs,
      pausedDuration: 0,
      laneIndex: -1,
      staggerDelay: 0,
      speedTier: msg.isBacklog ? 3 : 1,
      translatedText: null,
      slotCount: msg.kind === 'superchat' || msg.kind === 'membership' ? 2 : 1,
      renderMessage: msg,
    };
  }

  protected getQueueLength(): number {
    return this.pendingQueue.size;
  }

  trimBackgroundQueue(): void {
    if (this.pendingQueue.size <= this.settings.backgroundQueueMax) return;
    this.pendingQueue.trim(this.settings.backgroundQueueMax);
  }

  startRenderLoop(): void {
    if (this.animFrameId !== null) return;
    const loop = (t: number) => {
      this.animFrameId = requestAnimationFrame(loop);
      // atlasReady is the only guard needed here: isPaused/isVideoPaused
      // are enforced externally by onPause() cancelling the rAF, so the
      // loop is never Running while paused. atlasReady can flip asynchronously
      // when the atlas finishes generating after context restore.
      if (!this.atlasReady) return;
      this.renderFrame(t);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  private drainQueue(_now: number): void {
    const MAX_SKIP = 3;
    let skipped = 0;
    const dims = this.overlay.getDimensions();
    if (!dims) return;

    const mode = this.settings.danmakuMode;
    const cssW = dims.width;

    while (!this.pendingQueue.isEmpty && skipped < MAX_SKIP) {
      if (this.isAntiBlockActive()) break;
      const msg = this.pendingQueue.dequeue();
      if (!msg) break;
      const canvasMsg = this.createCanvasMessage(msg);
      const speedTier = msg.isBacklog ? SPEED_TIER.BACKLOG : SPEED_TIER.MID;
      const placement: LanePlacement | null = this.laneAllocator.findPlacement(
        canvasMsg.height,
        dims,
        speedTier
      );
      if (!placement) {
        this.retryQueue.push(msg);
        skipped++;
        continue;
      }
      const now2 = performance.now();
      if (mode === 'reverse') {
        canvasMsg.startX = -canvasMsg.width;
      } else if (mode === 'scroll') {
        canvasMsg.startX = cssW;
      } else {
        canvasMsg.startX = (cssW - canvasMsg.width) / 2;
      }
      canvasMsg.x = canvasMsg.startX;
      canvasMsg.y = placement.laneY;
      canvasMsg.laneIndex = placement.laneIndex;
      canvasMsg.startTime = now2;
      canvasMsg.fadeStartTime = now2;
      canvasMsg.staggerDelay = 0;
      this.laneAllocator.commitPlacement(
        placement,
        now2,
        canvasMsg.duration,
        mode === 'scroll' || mode === 'reverse' ? canvasMsg.width : undefined,
        mode === 'scroll' || mode === 'reverse' ? dims.width : undefined,
        speedTier
      );
      this.messages.push(canvasMsg);
      skipped = 0;
    }

    // Refill from retry queue
    if (this.pendingQueue.isEmpty && this.retryQueue.length > 0) {
      this.pendingQueue.refill(this.retryQueue, (m) => RendererBase.getMessagePriority(m));
    }
  }

  private renderFrame(now: number): void {
    if (this.isContextLost) return;
    try {
      const gl = this.gl;
      const dims = this.overlay.getDimensions();
      if (!dims) return;
      if (dims.width !== this.cssWidth || dims.height !== this.cssHeight) {
        this.cssWidth = dims.width;
        this.cssHeight = dims.height;
        this.laneAllocator.reset(dims);
        // Also resize the overlay canvas
        if (this.overlay2d) {
          this.overlay2d.width = Math.ceil(this.cssWidth * this.dpr);
          this.overlay2d.height = Math.ceil(this.cssHeight * this.dpr);
        }
      }
      gl.viewport(0, 0, Math.ceil(this.cssWidth * this.dpr), Math.ceil(this.cssHeight * this.dpr));
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.drainQueue(now);
      this.updateMessages(now);
      this.buildInstances(now);
      if (this.instanceCount > 0 && this.atlasTexture) {
        gl.useProgram(this.program);
        gl.bindVertexArray(this.vao);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
        gl.uniform2f(this.u_viewport, this.cssWidth, this.cssHeight);
        gl.uniform1f(this.u_atlasSize, ATLAS_SIZE);
        gl.uniform1f(this.u_cellSize, ATLAS_CELL_SIZE);
        gl.uniform1f(this.u_distanceRange, SDF_DISTANCE_RANGE);
        gl.uniform1f(this.u_outlineWidth, this.settings.outline.widthPx / SDF_DISTANCE_RANGE);
        const oc = this.getOutlineColor();
        gl.uniform3f(this.u_outlineColor, oc[0], oc[1], oc[2]);
        gl.uniform1f(this.u_outlineOpacity, this.settings.outline.opacity);
        gl.uniform1i(this.u_atlas, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          0,
          this.instanceData.subarray(0, this.instanceCount * FLOATS_PER_INSTANCE)
        );
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCount);
        gl.bindVertexArray(null);
      }

      // Second pass: texture-based emoji + card backgrounds
      if (this.texQuadCount > 0 && this.solidWhiteTex) {
        gl.useProgram(this.textureProgram);
        gl.bindVertexArray(this.vao);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.solidWhiteTex);
        gl.uniform2f(this.u_texViewport, this.cssWidth, this.cssHeight);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          0,
          this.texQuadData.subarray(0, this.texQuadCount * FLOATS_PER_INSTANCE)
        );
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.texQuadCount);
        gl.bindVertexArray(null);
      }

      // Canvas2D overlay: card round-rects + author photos
      if (this.ctx2d) {
        const dpr = this.dpr;
        this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.ctx2d.clearRect(0, 0, this.cssWidth, this.cssHeight);

        for (const msg of this.messages) {
          const elapsed = msg.startTime > 0 ? Math.max(0, now - msg.startTime) : 0;
          const op = computeMessageOpacity(
            msg.message,
            elapsed,
            msg.duration,
            msg.laneIndex >= 0,
            msg.speedTier,
            this._opacityConfig
          );
          if (op <= 0) continue;

          if (msg.message.kind === 'superchat' || msg.message.kind === 'membership') {
            // Round-rect card background (replaces the flat WebGL2 quad)
            const pad = 4;
            const bgColor =
              msg.message.kind === 'superchat'
                ? (msg.message.superChat?.backgroundColor ?? '#ff0000')
                : '#0f0';
            this.ctx2d.globalAlpha = op * CARD_BG_OPACITY_FACTOR;
            this.ctx2d.fillStyle = bgColor;
            drawRoundRect(
              this.ctx2d,
              msg.x - pad,
              msg.y - pad,
              msg.width + pad * 2,
              msg.height + pad * 2,
              6 // corner radius
            );
            this.ctx2d.fill();
            this.ctx2d.globalAlpha = 1;

            // Author photo
            const photoUrl = msg.message.authorPhotoUrl;
            if (photoUrl) {
              const photo = this.loadAuthorPhoto(photoUrl);
              if (photo?.complete && photo.naturalWidth > 0) {
                const photoX = msg.x + rendererLayout.paddingH;
                const photoY = msg.y + rendererLayout.paddingV;
                drawAuthorPhoto(this.ctx2d, photo, photoX, photoY);
              } else if (photo && !photo.complete) {
                // trigger load
                photo.onload = () => {
                  /* photo will appear next frame */
                };
              }
            }
          }
        }

        // Connection status indicator (non-connected states)
        if (this.connectionStatus !== 'connected') {
          this.drawStatusBar();
        }
      }
    } catch (err) {
      log.error('WebGL2 renderFrame error:', err);
    }
  }

  private updateMessages(now: number): void {
    updateMessagePositions(this.messages, this.settings.danmakuMode, this.cssWidth, now);
    // Clean up expired messages to prevent unbounded array growth on long streams
    this.cleanupExpiredMessages(now);
  }

  private cleanupExpiredMessages(now: number): void {
    let writeIdx = 0;
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (!msg) continue;
      const elapsed = msg.startTime > 0 ? Math.max(0, now - msg.startTime) : 0;
      // Keep messages that are still visible (not yet finished scrolling)
      if (elapsed < msg.duration && msg.startTime > 0) {
        this.messages[writeIdx++] = msg;
      }
    }
    this.messages.length = writeIdx;
  }

  private buildInstances(now: number): void {
    const fs = this.settings.fontSize;
    const scale = fs / GLYPH_RASTER_SIZE;

    // Precompute opacity once per message to avoid duplicate computeMessageOpacity
    // calls (buildSDFInstances + emoji loop both needed it)
    const precomputedOpacities = new Map<number, number>();
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (!msg) continue;
      const elapsed = msg.startTime > 0 ? Math.max(0, now - msg.startTime) : 0;
      const op = computeMessageOpacity(
        msg.message,
        elapsed,
        msg.duration,
        msg.laneIndex >= 0,
        msg.speedTier,
        this._opacityConfig
      );
      precomputedOpacities.set(i, op);
    }

    const result = buildSDFInstances(
      this.messages,
      this.atlas,
      this.instanceData,
      MAX_INSTANCES,
      fs,
      scale,
      this.settings.colors,
      this._opacityConfig,
      now,
      this.settings.translationMode,
      this.texQuadData,
      precomputedOpacities
    );
    this.instanceCount = result.instanceCount;
    this.texQuadCount = result.texQuadCount;

    // Emoji rendering via texture pass (main-thread specific — uses getEmojiTexture)
    // Emojis are placed at their actual inline position by iterating content
    // segments in order and tracking a cursor per segment type.
    for (let i = 0; i < this.messages.length; i++) {
      if (this.texQuadCount >= MAX_INSTANCES) break;

      const msg = this.messages[i];
      if (!msg) continue;
      const op = precomputedOpacities.get(i) ?? 0;
      if (op <= 0) continue;

      // Defensive: content may be undefined for malformed messages
      const msgContent = msg.message?.content;
      if (!Array.isArray(msgContent)) continue;

      // Track cursor position per segment to place emojis inline
      let cursorX = msg.x;
      for (const seg of msgContent) {
        if (seg.type === 'text') {
          // Advance cursor past each text character using glyph widths
          const text = seg.content ?? '';
          for (let ci = 0; ci < text.length; ci++) {
            const gi = this.atlas?.glyphs.get(text.codePointAt(ci) ?? 0x20);
            cursorX += (gi?.advanceWidth ?? fs * 0.7) * scale;
          }
        } else if (seg.type === 'emoji') {
          const emojiUrl = seg.emoji?.url;
          if (!emojiUrl) continue;
          const tex = this.getEmojiTexture(emojiUrl);
          if (!tex) continue;
          const eOff = this.texQuadCount * FLOATS_PER_INSTANCE;
          const eSize = fs * 1.2;
          this.texQuadData[eOff + 0] = cursorX;
          this.texQuadData[eOff + 1] = msg.y + (msg.height - eSize) / 2;
          this.texQuadData[eOff + 2] = eSize;
          this.texQuadData[eOff + 3] = eSize;
          this.texQuadData[eOff + 4] = 0;
          this.texQuadData[eOff + 5] = 1;
          this.texQuadData[eOff + 6] = 1;
          this.texQuadData[eOff + 7] = 1;
          this.texQuadData[eOff + 8] = op;
          this.texQuadCount++;
          cursorX += eSize;
        }
      }
    }
  }

  private getOutlineColor(): [number, number, number] {
    const rgba = computeOutlineColor(this.settings.colors.normal || '#ffffff', 1);
    const m = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m)
      return [
        parseInt(m[1] ?? '0', 10) / 255,
        parseInt(m[2] ?? '0', 10) / 255,
        parseInt(m[3] ?? '0', 10) / 255,
      ];
    return [1, 1, 1];
  }

  setStandbyStatus(standby: boolean): void {
    this.setConnectionStatus(standby ? 'standby' : 'connected');
  }

  setConnectionStatus(status: ConnectionStatus): void {
    this.connectionStatus = status;
    // Trigger a render frame so the status indicator appears immediately
    // even if the render loop is idle (no active messages).
    if (status !== 'connected' && this.animFrameId === null) {
      this.startRenderLoop();
    }
  }

  /**
   * Draw a minimal connection status indicator on the Canvas2D overlay.
   * Renders a small pill at the bottom-center of the viewport.
   */
  private drawStatusBar(): void {
    if (!this.ctx2d) return;
    const ctx = this.ctx2d;
    const cfg = statusBarLayout;
    const text = this.connectionStatus.toUpperCase();
    ctx.font = `${cfg.fontSize}px system-ui, sans-serif`;
    const textW = ctx.measureText(text).width;
    const dotR = cfg.dotRadius;
    const dotGap = cfg.dotGap;
    const padX = cfg.paddingX;
    const padY = cfg.paddingY;
    const pillW = padX * 2 + dotR * 2 + dotGap + textW;
    const pillH = cfg.fontSize + padY * 2;
    const x = (this.cssWidth - pillW) / 2;
    const y = this.cssHeight - pillH - cfg.bottomOffset;

    const colors = cfg.colors[this.connectionStatus] ?? cfg.colors.disconnected;

    // Pill background
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = colors.bg;
    drawRoundRect(ctx, x, y, pillW, pillH, cfg.pillRadius);
    ctx.fill();

    // Status dot
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.dot;
    ctx.beginPath();
    ctx.arc(x + padX + dotR, y + pillH / 2, dotR, 0, Math.PI * 2);
    ctx.fill();

    // Status text
    ctx.fillStyle = colors.text;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + padX + dotR * 2 + dotGap, y + pillH / 2);
    ctx.globalAlpha = 1;
  }

  protected onPause(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  protected onResume(): void {
    if (this.atlasReady && !this.isPaused && !this.isVideoPaused) {
      this.startRenderLoop();
    }
  }

  protected applyPausedDuration(ms: number): void {
    for (const m of this.messages) m.startTime += ms;
  }

  protected resetState(): void {
    this.messages.length = 0;
    for (const tex of this.emojiTextures.values()) this.gl.deleteTexture(tex);
    this.emojiTextures.clear();
    this.authorPhotoCache.clear();
  }

  private async performSourceDetection(): Promise<void> {
    if (!this.languageDetector) return;
    try {
      const detected = await this.languageDetector.detectFromSamples(this.sourceSampleBuffer);
      if (detected) {
        const channelKey = ChannelLanguageMemory.keyFromUrl(location.href);
        if (channelKey && this.channelMemory) {
          this.channelMemory.set(channelKey, detected);
        }
        // Note: WebGL2 renderer does not own a TranslationService —
        // the translation is handled externally. We only detect and
        // cache the source language for downstream consumers.
      }
    } catch (err: unknown) {
      log.debug('Source detection failed:', err);
    }
    this.sourceDetectionDone = true;
    this.sourceSampleBuffer = [];
  }

  protected onDestroy(): void {
    if (this.animFrameId !== null) cancelAnimationFrame(this.animFrameId);
    this.messages.length = 0;
    this.pendingQueue.clear();
    this.retryQueue.length = 0;
    this.languageDetector?.destroy();
    this.languageDetector = null;
    // Guard against context loss — calling GL delete methods on a lost
    // context throws INVALID_OPERATION. Skip GPU cleanup; the context
    // will be garbage-collected with its resources.
    if (!this.isContextLost) {
      if (this.atlasTexture) this.gl.deleteTexture(this.atlasTexture);
      this.gl.deleteBuffer(this.instanceBuffer);
      this.gl.deleteVertexArray(this.vao);
      this.gl.deleteProgram(this.program);
      if (this.textureProgram) this.gl.deleteProgram(this.textureProgram);
      if (this.solidWhiteTex) this.gl.deleteTexture(this.solidWhiteTex);
      for (const tex of this.emojiTextures.values()) this.gl.deleteTexture(tex);
    }
    this.emojiTextures.clear();
    // Remove the overlay canvas from DOM
    if (this.overlay2d.parentNode) this.overlay2d.parentNode.removeChild(this.overlay2d);
    this.authorPhotoCache.clear();
    // Remove the WebGL2 canvas from DOM
    const glCanvas = this.gl.canvas as HTMLCanvasElement | undefined;
    if (glCanvas?.parentNode) glCanvas.parentNode.removeChild(glCanvas);
  }
}
