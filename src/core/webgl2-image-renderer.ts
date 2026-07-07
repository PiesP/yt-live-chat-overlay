// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * WebGL2ImageRenderer — GPU-accelerated image rendering for Canvas2D overlays.
 *
 * Renders images (emoji, badges, author photos, stickers) via instanced quads
 * in a single draw call, reducing CPU-side drawImage overhead at scale.
 *
 * Architecture:
 *   - Separate WebGL2 canvas layered behind the main Canvas2D text layer
 *   - Texture atlas for images (lazy upload on first use per frame)
 *   - Instanced draw via drawArraysInstanced for all images in one call
 *   - Falls back silently to Canvas2D drawImage when WebGL2 is unavailable
 *
 * Usage:
 *   const renderer = new WebGL2ImageRenderer(overlayContainer, dimensions);
 *   renderer.beginFrame();
 *   renderer.addImage(img, x, y, w, h, alpha);
 *   renderer.addImage(img2, x2, y2, w2, h2, alpha2);
 *   renderer.flush();
 */

import { createLogger } from '@core/logging';

const log = createLogger('WebGL2Image');

// ── Shaders ─────────────────────────────────────────────────────────────────

/** Vertex shader: instanced unit quad. Per-instance attributes: position + scale + alpha. */
const VERTEX_SRC = `#version 300 es
layout(location = 0) in vec2 a_pos;       // unit quad vertex (6 verts per quad)
layout(location = 1) in vec4 a_rect;      // per-instance: x, y, w, h in CSS pixels
layout(location = 2) in float a_alpha;    // per-instance: opacity (0-1)
layout(location = 3) in vec4 a_uv;        // per-instance: texcoord bounds (u0,v0,u1,v1)

uniform vec2 u_viewport;                  // canvas width, height in CSS pixels

out vec2 v_uv;
out float v_alpha;

void main() {
  // Map unit quad [-1,1] to screen position [x, x+w], [y, y+h]
  vec2 halfSize = a_rect.zw * 0.5;
  vec2 center = a_rect.xy + halfSize;
  vec2 pos = center + a_pos * halfSize;

  // Convert to NDC
  gl_Position = vec4(
    (pos.x / u_viewport.x) * 2.0 - 1.0,
    1.0 - (pos.y / u_viewport.y) * 2.0,
    0.0, 1.0
  );

  v_uv = mix(a_uv.xy, a_uv.zw, a_pos * 0.5 + 0.5);
  v_alpha = a_alpha;
}
`;

const FRAGMENT_SRC = `#version 300 es
precision mediump float;

in vec2 v_uv;
in float v_alpha;

uniform sampler2D u_texture;

out vec4 outColor;

void main() {
  vec4 texColor = texture(u_texture, v_uv);
  outColor = vec4(texColor.rgb, texColor.a * v_alpha);
}
`;

// ── Constants ───────────────────────────────────────────────────────────────

/** Max instances per draw call (before flushing). */
const MAX_INSTANCES = 1024;

/** Instance data floats per image: x, y, w, h, alpha, u0, v0, u1, v1 = 9 */
const FLOATS_PER_INSTANCE = 9;

/** Unit quad vertices (2 triangles = 6 verts, each 2 floats). */
const UNIT_QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);

// ── Types ───────────────────────────────────────────────────────────────────

// ── Implementation ──────────────────────────────────────────────────────────

export class WebGL2ImageRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uniformViewport: WebGLUniformLocation | null = null;
  private uniformTexture: WebGLUniformLocation | null = null;

  private readonly instanceData = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);
  private textureMap = new Map<CanvasImageSource, WebGLTexture>();
  private currentTexture: WebGLTexture | null = null;
  private instanceCount = 0;
  private enabled = false;
  private width = 0;
  private height = 0;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  constructor(container: HTMLElement, width: number, height: number) {
    this.width = width;
    this.height = height;

    const canvas = document.createElement('canvas');
    canvas.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1;background:transparent';
    canvas.width = width;
    canvas.height = height;
    container.appendChild(canvas);
    this.canvas = canvas;

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      desynchronized: true,
    });

    if (!gl) {
      log.warn('WebGL2 unavailable — image rendering falls back to Canvas2D');
      return;
    }
    this.gl = gl;

    try {
      this.initGL(gl);
      this.enabled = true;
    } catch (err: unknown) {
      log.warn('WebGL2 init failed:', err);
      canvas.remove();
      this.canvas = null;
      this.gl = null;
    }
  }

  /** Whether WebGL2 image rendering is active. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Resize the WebGL2 backing store. */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    if (this.canvas) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /** Release all GPU resources. */
  destroy(): void {
    const { gl, canvas } = this;
    if (gl) {
      for (const tex of this.textureMap.values()) {
        gl.deleteTexture(tex);
      }
      this.textureMap.clear();
      if (this.program) gl.deleteProgram(this.program);
      if (this.vao) gl.deleteVertexArray(this.vao);
    }
    if (canvas) canvas.remove();
    this.gl = null;
    this.canvas = null;
    this.enabled = false;
  }

  // ── Per-Frame API ──────────────────────────────────────────────────────

  /** Begin a new frame — clear the WebGL canvas and instance buffer. */
  beginFrame(): void {
    if (!this.enabled || !this.gl) return;
    const gl = this.gl;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas?.width ?? this.width, this.canvas?.height ?? this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao!);
    gl.uniform2f(this.uniformViewport, this.width, this.height);
    gl.uniform1i(this.uniformTexture, 0);

    this.instanceCount = 0;
  }

  /**
   * Queue an image for GPU rendering. Images with the same source are batched
   * together; a new draw call occurs when the source changes or the buffer fills.
   */
  addImage(image: CanvasImageSource, x: number, y: number, w: number, h: number, alpha = 1): void {
    if (!this.enabled || !this.gl) return;
    if (alpha <= 0 || w <= 0 || h <= 0) return;

    // Flush if image source changed (different texture)
    if (this.currentTexture && this.currentTexture !== this.textureMap.get(image)) {
      this.flushDraw();
    }

    // Upload texture on first use this frame
    if (!this.textureMap.has(image)) {
      this.uploadTexture(image);
    }
    this.currentTexture = this.textureMap.get(image) ?? null;

    // Flush if buffer full
    if (this.instanceCount >= MAX_INSTANCES) {
      this.flushDraw();
    }

    const offset = this.instanceCount * FLOATS_PER_INSTANCE;
    const d = this.instanceData;
    // Clip rectangle is in CSS pixels; full-image UVs
    d[offset + 0] = Math.floor(x);
    d[offset + 1] = Math.floor(y);
    d[offset + 2] = Math.floor(w);
    d[offset + 3] = Math.floor(h);
    d[offset + 4] = alpha;
    d[offset + 5] = 0; // u0
    d[offset + 6] = 0; // v0
    d[offset + 7] = 1; // u1
    d[offset + 8] = 1; // v1
    this.instanceCount++;
  }

  /** Render all queued images and prepare for the next frame. */
  flush(): void {
    if (!this.enabled || !this.gl) return;
    this.flushDraw();
  }

  /**
   * Render a blurred glow rectangle behind an element (e.g., membership card glow).
   * Renders a solid-color rect with an additional blurred copy for the glow effect.
   */
  addGlow(x: number, y: number, w: number, h: number, color: string, alpha: number): void {
    if (!this.enabled || !this.gl) return;

    // Create a 1×1 pixel texture with the glow color (lazy upload)
    const colorKey = `glow:${color}`;
    let tex = this.textureMap.get(colorKey as unknown as CanvasImageSource);
    if (!tex) {
      tex = this.gl.createTexture()!;
      this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
      // Parse rgba string to pixel data
      const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (!match) return;
      const r = parseInt(match[1]!, 10);
      const g = parseInt(match[2]!, 10);
      const b = parseInt(match[3]!, 10);
      const a = match[4] ? parseFloat(match[4]) : 1;
      const pixel = new Uint8Array([r, g, b, Math.round(a * 255)]);
      this.gl.texImage2D(
        this.gl.TEXTURE_2D,
        0,
        this.gl.RGBA,
        1,
        1,
        0,
        this.gl.RGBA,
        this.gl.UNSIGNED_BYTE,
        pixel
      );
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
      this.textureMap.set(colorKey as unknown as CanvasImageSource, tex);
    }

    // Expand rect for glow spread
    const spread = 8;
    this.addImage(
      colorKey as unknown as CanvasImageSource,
      x - spread,
      y - spread,
      w + spread * 2,
      h + spread * 2,
      alpha
    );
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private initGL(gl: WebGL2RenderingContext): void {
    // Compile shaders
    const vs = this.compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fs = this.compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const logMsg = gl.getProgramInfoLog(program);
      throw new Error(`WebGL program link failed: ${logMsg}`);
    }
    this.program = program;
    this.uniformViewport = gl.getUniformLocation(program, 'u_viewport');
    this.uniformTexture = gl.getUniformLocation(program, 'u_texture');

    // VAO + vertex buffer (unit quad — static, reused for all instances)
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Instance buffer (dynamic — updated per frame)
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);

    // a_rect (vec4): x, y, w, h — 4 floats starting at attribute 1
    // Uses 4 consecutive attribute locations
    const rectStride = FLOATS_PER_INSTANCE * 4; // 36 bytes per instance
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 1, gl.FLOAT, false, rectStride, i * 4);
      gl.vertexAttribDivisor(1 + i, 1);
    }

    // a_alpha (float): offset = 4 floats = 16 bytes
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, rectStride, 16);
    gl.vertexAttribDivisor(5, 1);

    // a_uv (vec4): u0, v0, u1, v1 — offset = 5 floats = 20 bytes
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(6 + i);
      gl.vertexAttribPointer(6 + i, 1, gl.FLOAT, false, rectStride, 20 + i * 4);
      gl.vertexAttribDivisor(6 + i, 1);
    }

    this.vao = vao;
  }

  private compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const logMsg = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader compile failed: ${logMsg}`);
    }
    return shader;
  }

  private uploadTexture(image: CanvasImageSource): void {
    const gl = this.gl!;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image as HTMLCanvasElement);
    this.textureMap.set(image, tex);
  }

  private flushDraw(): void {
    if (this.instanceCount === 0) return;
    const gl = this.gl!;

    // Bind the current texture
    if (this.currentTexture) {
      gl.bindTexture(gl.TEXTURE_2D, this.currentTexture);
    }

    // Upload instance data
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.instanceData,
      0,
      this.instanceCount * FLOATS_PER_INSTANCE
    );

    // Draw all instances in one call
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCount);

    this.instanceCount = 0;
  }
}
