// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * RendererWebGL2 — WebGL2 SDF instanced text renderer.
 *
 * Extends RendererBase. Renders all text via GPU-accelerated SDF.
 */

import type { ChatMessage, OverlaySettings } from '@app-types';
import { drawRoundRect } from '@core/canvas-text-renderer';
import { computeOutlineColor } from '@core/color-utils';
import { rendererLayout } from '@core/design-tokens';
import type { LanePlacement } from '@core/lane-allocator';
import { createLogger } from '@core/logging';
import type { Overlay } from '@core/overlay';
import { PriorityBucketQueue } from '@core/priority-bucket-queue';
import { RendererBase } from '@core/renderer-base';
import type { CanvasMessage } from '@core/renderer-constants';
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
import { getFontString, measureTextWidth } from '@core/text-measure';
import { TEXTURE_FRAGMENT_SHADER, TEXTURE_VERTEX_SHADER } from '@core/webgl2-texture-shaders';
import { drawAuthorPhoto } from '@shared/canvas-rendering-shared';

const log = createLogger('RendererWebGL2');

const FLOATS_PER_INSTANCE = 9;
const MAX_INSTANCES = 60_000;
const QUAD_POS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
const QUAD_UV = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);

export class RendererWebGL2 extends RendererBase {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private instanceBuffer: WebGLBuffer;
  private atlasTexture: WebGLTexture | null = null;

  private instanceData = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);
  private instanceCount = 0;

  private atlas: SDFAtlas | null = null;
  private atlasReady = false;
  private atlasGenerating = false;

  // Texture program for emoji + card background rendering
  private textureProgram: WebGLProgram;
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
  private overlay2d: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D;
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

  get laneCount(): number {
    return this.laneAllocator.getLaneCount();
  }

  constructor(overlay: Overlay, settings: OverlaySettings) {
    super(overlay, settings);
    this.dpr = window.devicePixelRatio || 1;
    this._ageFadeRate = 1 / Math.max(1, settings.maxMessageAgeMs);
    this._invFadeDuration = 1 / Math.max(1, settings.fadeDurationMs);
    this.rebuildOpacityConfig();

    const container = overlay.getContainer();
    const canvas = document.createElement('canvas');
    canvas.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none';
    if (container) container.appendChild(canvas);

    // Canvas2D overlay for card decorations (round rects, author photos)
    const overlay2d = document.createElement('canvas');
    overlay2d.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1';
    if (container) container.appendChild(overlay2d);
    const ctx2d = overlay2d.getContext('2d');
    if (!ctx2d) throw new Error('Failed to create 2D overlay context');
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

    this.program = this.createProgram(SDF_VERTEX_SHADER, SDF_FRAGMENT_SHADER);

    // Create texture program for emoji + card backgrounds
    this.textureProgram = this.createProgram(TEXTURE_VERTEX_SHADER, TEXTURE_FRAGMENT_SHADER);

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

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to create VAO');
    this.vao = vao;
    gl.bindVertexArray(vao);

    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_POS, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_UV, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

    const instBuf = gl.createBuffer();
    if (!instBuf) throw new Error('Failed to create instance buffer');
    this.instanceBuffer = instBuf;
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);

    const stride = FLOATS_PER_INSTANCE * 4;
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 3, gl.FLOAT, false, stride, 20);
    gl.vertexAttribDivisor(5, 1);
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 1, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(6, 1);

    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

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
        log.error('Atlas regeneration failed after font change:', e);
      });
    }
  }

  private createProgram(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    if (!vs) throw new Error('Failed to create vertex shader');
    gl.shaderSource(vs, vsSrc);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      const i = gl.getShaderInfoLog(vs);
      gl.deleteShader(vs);
      throw new Error(`VS: ${i}`);
    }
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!fs) throw new Error('Failed to create fragment shader');
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      const i = gl.getShaderInfoLog(fs);
      gl.deleteShader(fs);
      throw new Error(`FS: ${i}`);
    }
    const p = gl.createProgram();
    if (!p) throw new Error('Failed to create program');
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const i = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error(`Link: ${i}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return p;
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
    if (cached) return cached;
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
      this.atlas = await new SDFAtlasGenerator().generate(
        this.settings.fontFamily,
        this.settings.fontWeight
      );
      this.uploadAtlas();
      this.atlasReady = true;
      this.atlasGenerating = false;
      log.info(`Atlas ready: ${this.atlas.glyphs.size} glyphs`);
    } catch (e: unknown) {
      log.error('Atlas failed:', e);
      this.atlasGenerating = false;
      throw e;
    }
  }

  private uploadAtlas(): void {
    const data = this.atlas?.data;
    if (!data) return;
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      ATLAS_SIZE,
      ATLAS_SIZE,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (!this.atlas) return;
    this.atlas.texture = tex;
    this.atlasTexture = tex;
    this.atlas.uploaded = true;
  }

  addMessage(message: ChatMessage): void {
    if (!this.isMessageAllowed(message)) return;
    const priority = RendererBase.getMessagePriority(message);
    if (this.pendingQueue.size >= this.settings.queueMaxSize) {
      const lowest = this.pendingQueue.peekLowest();
      if (lowest && priority <= RendererBase.getMessagePriority(lowest)) {
        this.observability.onMessageDropped('queue_priority');
        return;
      }
      this.pendingQueue.dropLowest();
      this.observability.onMessageDropped('queue_replaced');
    }
    this.pendingQueue.enqueue(message, priority);
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
    const lh = Math.ceil(fontSize * 1.4);
    const font = getFontString(fontSize, this.settings.fontWeight, this.settings.fontFamily);
    const text = msg.content.map((s) => (s.type === 'text' ? s.content : '')).join('');
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
      if (!this.atlasReady || this.isPaused || this.isVideoPaused) return;
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
      this.overlay2d.width = Math.ceil(this.cssWidth * dpr);
      this.overlay2d.height = Math.ceil(this.cssHeight * dpr);
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
          this.ctx2d.globalAlpha = op * 0.85;
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
    }
  }

  private updateMessages(now: number): void {
    let wi = 0;
    const mode = this.settings.danmakuMode;
    const cssW = this.cssWidth;
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i] as CanvasMessage;
      if (m.laneIndex >= 0) {
        const progress = (now - m.startTime) / m.duration;
        if (progress >= 1) continue;
        switch (mode) {
          case 'scroll':
            m.x = m.startX - progress * (cssW + m.width);
            break;
          case 'reverse':
            m.x = m.startX + progress * (cssW + m.width) - m.width;
            break;
          case 'top':
          case 'bottom':
            m.x = m.startX;
            break;
        }
      }
      if (wi !== i) this.messages[wi] = m;
      wi++;
    }
    if (wi < this.messages.length) this.messages.length = wi;
  }

  private buildInstances(now: number): void {
    this.instanceCount = 0;
    this.texQuadCount = 0;
    const fs = this.settings.fontSize;
    const scale = this.settings.fontSize / GLYPH_RASTER_SIZE;
    for (const msg of this.messages) {
      if (this.instanceCount >= MAX_INSTANCES) break;
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
      const text = this.getRenderText(msg);
      if (!text) continue;
      let cx = msg.x;
      for (let ci = 0; ci < text.length; ci++) {
        if (this.instanceCount >= MAX_INSTANCES) break;
        const gi = this.atlas?.glyphs.get(text.codePointAt(ci) ?? 0x20);
        const off = this.instanceCount * FLOATS_PER_INSTANCE;
        const c = this.getMessageColor(msg);
        this.instanceData[off + 0] = cx;
        this.instanceData[off + 1] = msg.y;
        this.instanceData[off + 2] = fs * 0.7;
        this.instanceData[off + 3] = fs * 1.4;
        this.instanceData[off + 4] = gi?.index ?? this.atlas?.glyphs.get(0xfffd)?.index ?? 0;
        this.instanceData[off + 5] = c[0];
        this.instanceData[off + 6] = c[1];
        this.instanceData[off + 7] = c[2];
        this.instanceData[off + 8] = op;
        this.instanceCount++;
        cx += (gi?.advanceWidth ?? this.settings.fontSize * 0.7) * scale;
      }

      // Dual translation mode: render translated text above original
      if (this.settings.translationMode === 'dual' && msg.translatedText) {
        let tx = msg.x;
        const ty = msg.y - fs * 1.2; // above original
        const tOpacity = op * 0.7; // slightly dimmer
        for (let ci = 0; ci < msg.translatedText.length; ci++) {
          if (this.instanceCount >= MAX_INSTANCES) break;
          const cp = msg.translatedText.codePointAt(ci) ?? 0x20;
          const gi = this.atlas?.glyphs.get(cp);
          const off = this.instanceCount * FLOATS_PER_INSTANCE;
          const c = this.getMessageColor(msg);
          this.instanceData[off + 0] = tx;
          this.instanceData[off + 1] = ty;
          this.instanceData[off + 2] = fs * 0.7;
          this.instanceData[off + 3] = fs * 1.2;
          this.instanceData[off + 4] = gi?.index ?? this.atlas?.glyphs.get(0xfffd)?.index ?? 0;
          this.instanceData[off + 5] = c[0];
          this.instanceData[off + 6] = c[1];
          this.instanceData[off + 7] = c[2];
          this.instanceData[off + 8] = tOpacity;
          this.instanceCount++;
          tx += (gi?.advanceWidth ?? this.settings.fontSize * 0.7) * scale;
        }
      }

      // Card background for paid messages
      if (msg.message.kind === 'superchat' || msg.message.kind === 'membership') {
        const bgColor = this.parseColor(
          msg.message.kind === 'superchat'
            ? (msg.message.superChat?.backgroundColor ?? '#ff0000')
            : '#0f0'
        );
        const pad = 4;
        const bgOff = this.texQuadCount * FLOATS_PER_INSTANCE;
        this.texQuadData[bgOff + 0] = msg.x - pad;
        this.texQuadData[bgOff + 1] = msg.y - pad;
        this.texQuadData[bgOff + 2] = msg.width + pad * 2;
        this.texQuadData[bgOff + 3] = msg.height + pad * 2;
        this.texQuadData[bgOff + 4] = 0;
        this.texQuadData[bgOff + 5] = bgColor[0];
        this.texQuadData[bgOff + 6] = bgColor[1];
        this.texQuadData[bgOff + 7] = bgColor[2];
        this.texQuadData[bgOff + 8] = op * 0.85;
        this.texQuadCount++;
      }

      // Emoji rendering via texture pass
      for (const seg of msg.message.content) {
        if (seg.type !== 'emoji') continue;
        const emojiUrl = seg.emoji?.url;
        if (!emojiUrl) continue;
        const tex = this.getEmojiTexture(emojiUrl);
        if (!tex) continue;
        const eOff = this.texQuadCount * FLOATS_PER_INSTANCE;
        const eSize = fs * 1.2;
        this.texQuadData[eOff + 0] = cx;
        this.texQuadData[eOff + 1] = msg.y + (msg.height - eSize) / 2;
        this.texQuadData[eOff + 2] = eSize;
        this.texQuadData[eOff + 3] = eSize;
        this.texQuadData[eOff + 4] = 0;
        this.texQuadData[eOff + 5] = 1;
        this.texQuadData[eOff + 6] = 1;
        this.texQuadData[eOff + 7] = 1;
        this.texQuadData[eOff + 8] = op;
        this.texQuadCount++;
        cx += eSize;
      }
    }
  }

  private getRenderText(msg: CanvasMessage): string {
    // In dual mode, render the original text in the main loop — translated text is rendered above separately.
    if (msg.translatedText && this.settings.translationMode === 'dual') {
      return msg.message.content.map((s) => (s.type === 'text' ? s.content : ' ')).join('');
    }
    // In replace mode, use translated text; otherwise use original.
    return msg.translatedText && this.settings.translationMode === 'replace'
      ? msg.translatedText
      : msg.message.content.map((s) => (s.type === 'text' ? s.content : ' ')).join('');
  }

  private getMessageColor(msg: CanvasMessage): [number, number, number] {
    return this.parseColor(this.settings.colors[msg.message.authorType] || '#ffffff');
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

  private parseColor(hex: string): [number, number, number] {
    return [
      parseInt(hex.slice(1, 3), 16) / 255 || 1,
      parseInt(hex.slice(3, 5), 16) / 255 || 1,
      parseInt(hex.slice(5, 7), 16) / 255 || 1,
    ];
  }

  protected onPause(): void {}
  protected onResume(): void {}
  protected applyPausedDuration(ms: number): void {
    for (const m of this.messages) m.startTime += ms;
  }
  protected resetState(): void {
    this.messages.length = 0;
    for (const tex of this.emojiTextures.values()) this.gl.deleteTexture(tex);
    this.emojiTextures.clear();
    this.authorPhotoCache.clear();
  }

  protected onDestroy(): void {
    if (this.animFrameId !== null) cancelAnimationFrame(this.animFrameId);
    if (this.atlasTexture) this.gl.deleteTexture(this.atlasTexture);
    this.gl.deleteBuffer(this.instanceBuffer);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.program);
    if (this.textureProgram) this.gl.deleteProgram(this.textureProgram);
    if (this.solidWhiteTex) this.gl.deleteTexture(this.solidWhiteTex);
    for (const tex of this.emojiTextures.values()) this.gl.deleteTexture(tex);
    this.emojiTextures.clear();
    // Remove the overlay canvas from DOM
    if (this.overlay2d.parentNode) this.overlay2d.parentNode.removeChild(this.overlay2d);
    this.authorPhotoCache.clear();
  }
}
