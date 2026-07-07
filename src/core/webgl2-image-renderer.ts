// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * WebGL2ImageRenderer — GPU-accelerated glow effects via OffscreenCanvas.
 *
 * Renders glow effects on a WebGL2-backed OffscreenCanvas, then composites
 * the result onto the main Canvas2D context via drawImage().  No DOM canvas
 * element — avoids z-index stacking issues entirely.
 *
 * Architecture:
 *   - OffscreenCanvas with WebGL2 context (GPU-side, no DOM)
 *   - Instanced quad rendering for glow rects
 *   - beginFrame → addGlow → flush → getResult() pipeline
 *   - Result drawn onto Canvas2D via ctx.drawImage(result, 0, 0) BEFORE text
 *
 * Falls back silently when WebGL2 is unavailable (isEnabled = false).
 */

import { createLogger } from '@core/logging';

const log = createLogger('WebGL2Image');

// ── Shaders ─────────────────────────────────────────────────────────────────

const VERTEX_SRC = `#version 300 es
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_rect;
layout(location = 2) in float a_alpha;

uniform vec2 u_viewport;

out float v_alpha;

void main() {
  vec2 halfSize = a_rect.zw * 0.5;
  vec2 center = a_rect.xy + halfSize;
  vec2 pos = center + a_pos * halfSize;
  gl_Position = vec4(
    (pos.x / u_viewport.x) * 2.0 - 1.0,
    1.0 - (pos.y / u_viewport.y) * 2.0,
    0.0, 1.0
  );
  v_alpha = a_alpha;
}
`;

const FRAGMENT_SRC = `#version 300 es
precision mediump float;

in float v_alpha;
uniform vec4 u_color;

out vec4 outColor;

void main() {
  outColor = vec4(u_color.rgb, u_color.a * v_alpha);
}
`;

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_INSTANCES = 256;
const FLOATS_PER_INSTANCE = 5; // x, y, w, h, alpha

const UNIT_QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);

// ── Types ───────────────────────────────────────────────────────────────────

interface GlowInstance {
  x: number;
  y: number;
  w: number;
  h: number;
  /** CSS color string, e.g. "rgba(100,150,200,0.5)" */
  color: string;
  alpha: number;
}

// ── Implementation ──────────────────────────────────────────────────────────

export class WebGL2ImageRenderer {
  private offscreen: OffscreenCanvas | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uniformViewport: WebGLUniformLocation | null = null;
  private uniformColor: WebGLUniformLocation | null = null;

  private readonly instanceData = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);
  private readonly queue: GlowInstance[] = [];
  private enabled = false;
  private width = 0;
  private height = 0;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;

    try {
      const offscreen = new OffscreenCanvas(width, height);
      const gl = offscreen.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: false,
        antialias: false,
      });

      if (!gl) {
        log.warn('WebGL2 unavailable for OffscreenCanvas');
        return;
      }

      this.offscreen = offscreen;
      this.gl = gl;
      this.initGL(gl);
      this.enabled = true;
    } catch (err: unknown) {
      log.debug('WebGL2 OffscreenCanvas init failed:', err);
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  resize(width: number, height: number): void {
    if (!this.enabled || !this.offscreen) return;
    this.width = width;
    this.height = height;
    this.offscreen.width = width;
    this.offscreen.height = height;
  }

  destroy(): void {
    const { gl } = this;
    if (gl) {
      if (this.program) gl.deleteProgram(this.program);
      if (this.vao) gl.deleteVertexArray(this.vao);
    }
    this.gl = null;
    this.offscreen = null;
    this.enabled = false;
  }

  // ── Per-Frame API ──────────────────────────────────────────────────────

  /** Begin a new frame — clear the offscreen canvas. */
  beginFrame(): void {
    if (!this.enabled || !this.gl) return;
    const gl = this.gl;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao!);

    this.queue.length = 0;
  }

  /** Queue a glow rectangle. Color is parsed and batched by color key. */
  addGlow(x: number, y: number, w: number, h: number, color: string, multiplier: number): void {
    if (!this.enabled || multiplier <= 0 || w <= 0 || h <= 0) return;

    // Parse alpha from color string, apply multiplier
    const match = color.match(/[\d.]+\)$/);
    let baseAlpha = 1;
    if (match) {
      const parts = color.slice(0, -1).split(',');
      const last = parseFloat(parts[parts.length - 1]!.trim());
      if (!Number.isNaN(last)) baseAlpha = last;
    }

    const alpha = Math.min(1, baseAlpha * multiplier);
    if (alpha <= 0.001) return;

    this.queue.push({ x, y, w, h, color, alpha });
  }

  /**
   * Render all queued glow instances and return the result as an OffscreenCanvas
   * suitable for ctx.drawImage(). Returns null if no glow content was rendered.
   */
  flush(): OffscreenCanvas | null {
    if (!this.enabled || !this.gl || this.queue.length === 0) return null;
    const gl = this.gl;

    // Group by color to batch draw calls
    const byColor = new Map<string, GlowInstance[]>();
    for (const g of this.queue) {
      // Normalize color: strip alpha suffix, use only rgb part for batching
      const rgbKey = g.color.replace(/,\s*[\d.]+\s*\)$/, ')');
      let group = byColor.get(rgbKey);
      if (!group) {
        group = [];
        byColor.set(rgbKey, group);
      }
      group.push(g);
    }

    // Render each color group
    for (const [rgbKey, instances] of byColor) {
      // Upload instances to buffer
      let count = 0;
      for (const g of instances) {
        if (count >= MAX_INSTANCES) {
          this.drawInstances(gl, count);
          count = 0;
        }
        const off = count * FLOATS_PER_INSTANCE;
        const d = this.instanceData;
        d[off + 0] = g.x;
        d[off + 1] = g.y;
        d[off + 2] = g.w;
        d[off + 3] = g.h;
        d[off + 4] = g.alpha;
        count++;
      }
      if (count > 0) {
        // Parse color for the uniform
        const match = rgbKey.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (match) {
          gl.uniform4f(
            this.uniformColor,
            parseInt(match[1]!, 10) / 255,
            parseInt(match[2]!, 10) / 255,
            parseInt(match[3]!, 10) / 255,
            1.0
          );
        }
        gl.uniform2f(this.uniformViewport, this.width, this.height);
        this.drawInstances(gl, count);
      }
    }

    return this.offscreen;
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private initGL(gl: WebGL2RenderingContext): void {
    const vs = this.compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fs = this.compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`WebGL program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;
    this.uniformViewport = gl.getUniformLocation(program, 'u_viewport');
    this.uniformColor = gl.getUniformLocation(program, 'u_color');

    // VAO + static vertex buffer (unit quad)
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Instance buffer (dynamic)
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);

    const stride = FLOATS_PER_INSTANCE * 4;

    // a_rect (vec4)
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 1, gl.FLOAT, false, stride, i * 4);
      gl.vertexAttribDivisor(1 + i, 1);
    }

    // a_alpha
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(5, 1);

    this.vao = vao;
  }

  private compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const msg = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader compile failed: ${msg}`);
    }
    return shader;
  }

  private drawInstances(gl: WebGL2RenderingContext, count: number): void {
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData, 0, count * FLOATS_PER_INSTANCE);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
  }
}
