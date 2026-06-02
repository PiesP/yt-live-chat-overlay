// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * RendererWebGL2 — WebGL2 SDF instanced text renderer.
 *
 * Extends RendererBase. Renders all text via GPU-accelerated SDF.
 */

import type { ChatMessage, OverlaySettings } from '@app-types';
import { computeOutlineColor } from '@core/color-utils';
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
  SDF_DISTANCE_RANGE,
  type SDFAtlas,
  SDFAtlasGenerator,
} from '@core/sdf-atlas';
import { SDF_FRAGMENT_SHADER, SDF_VERTEX_SHADER } from '@core/sdf-shaders';

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

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;

    this.program = this.createProgram(SDF_VERTEX_SHADER, SDF_FRAGMENT_SHADER);

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

  private createCanvasMessage(msg: ChatMessage): CanvasMessage {
    const fontSize = this.settings.fontSize;
    const lh = Math.ceil(fontSize * 1.4);
    let w = 0;
    for (const seg of msg.content) {
      if (seg.type === 'text') w += seg.content.length * fontSize * 0.7;
    }
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

    const isScrolling =
      this.settings.danmakuMode === 'scroll' || this.settings.danmakuMode === 'reverse';

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
      canvasMsg.startX = isScrolling
        ? this.settings.danmakuMode === 'scroll'
          ? dims.width
          : -canvasMsg.width
        : Math.max(0, Math.floor((dims.width - canvasMsg.width) / 2));
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
        isScrolling ? canvasMsg.width : undefined,
        isScrolling ? dims.width : undefined,
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
  }

  private updateMessages(now: number): void {
    let wi = 0;
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i] as CanvasMessage;
      if (m.laneIndex >= 0) {
        const p = (now - m.startTime) / m.duration;
        if (p >= 1) continue;
        m.x = m.startX - p * (this.cssWidth + m.width);
      }
      if (wi !== i) this.messages[wi] = m;
      wi++;
    }
    if (wi < this.messages.length) this.messages.length = wi;
  }

  private buildInstances(now: number): void {
    this.instanceCount = 0;
    const fs = this.settings.fontSize;
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
        cx += gi?.advanceWidth ?? fs * 0.7;
      }
    }
  }

  private getRenderText(msg: CanvasMessage): string {
    return msg.translatedText && this.settings.translationMode === 'dual'
      ? msg.translatedText
      : msg.message.content.map((s) => (s.type === 'text' ? s.content : ' ')).join('');
  }

  private getMessageColor(msg: CanvasMessage): [number, number, number] {
    return this.parseColor(this.settings.colors[msg.message.authorType] || '#ffffff');
  }
  private getOutlineColor(): [number, number, number] {
    return this.parseColor(computeOutlineColor(this.settings.colors.normal || '#ffffff', 1));
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
  }

  protected onDestroy(): void {
    if (this.animFrameId !== null) cancelAnimationFrame(this.animFrameId);
    if (this.atlasTexture) this.gl.deleteTexture(this.atlasTexture);
    this.gl.deleteBuffer(this.instanceBuffer);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.program);
  }
}
