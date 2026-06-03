// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * RendererWebGL2Shared — pure WebGL2 utility functions shared between
 * the main-thread RendererWebGL2 and the worker RendererWorkerWebGL2.
 *
 * All functions accept state as explicit parameters — no module-level
 * mutable state, no DOM dependencies. This eliminates ~400 lines of
 * near-identical code between the two renderer implementations.
 */

import {
  TRANSLATION_FONT_SCALE,
  TRANSLATION_GAP_PX,
  TRANSLATION_OPACITY_SCALE,
} from '@core/renderer-constants';
import { computeMessageOpacity, type OpacityConfig } from '@core/renderer-shared';
import type { SDFAtlas } from '@core/sdf-atlas';

// ── Constants ────────────────────────────────────────────────────────────────

/** Floats per instance in the instanced attribute buffer */
export const FLOATS_PER_INSTANCE = 9;

/** Maximum instanced draw calls per frame */
export const MAX_INSTANCES = 60_000;

/** Unit quad positions (two triangles, 6 vertices) */
export const QUAD_POS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);

/** Unit quad UV coordinates */
export const QUAD_UV = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);

// ── Shared message interface ─────────────────────────────────────────────────

/**
 * Minimal message shape accepted by the shared build/update functions.
 * Both CanvasMessage (main thread) and ActiveMessage (worker) satisfy this.
 */
export interface SharedMessage {
  x: number;
  y: number;
  width: number;
  height: number;
  startX: number;
  startTime: number;
  duration: number;
  laneIndex: number;
  speedTier: number;
  translatedText?: string | null;
  message: {
    content: Array<{ type: string; content?: string; emoji?: { url?: string } }>;
    authorType: string;
    kind?: string;
    superChat?: { backgroundColor?: string };
  };
}

// ── WebGL2 helpers ───────────────────────────────────────────────────────────

/**
 * Compile + link a WebGL2 shader program from GLSL source strings.
 * Throws with descriptive messages on compile/link failure.
 */
export function createProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string
): WebGLProgram {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  if (!vs) throw new Error('Failed to create vertex shader');
  gl.shaderSource(vs, vsSrc);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(vs);
    gl.deleteShader(vs);
    throw new Error(`VS: ${info}`);
  }
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  if (!fs) throw new Error('Failed to create fragment shader');
  gl.shaderSource(fs, fsSrc);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(fs);
    gl.deleteShader(fs);
    throw new Error(`FS: ${info}`);
  }
  const p = gl.createProgram();
  if (!p) throw new Error('Failed to create program');
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`Link: ${info}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return p;
}

/** Buffers returned from setupWebGL2Buffers */
export interface WebGL2Buffers {
  vao: WebGLVertexArrayObject;
  instanceBuffer: WebGLBuffer;
  posBuf: WebGLBuffer;
  uvBuf: WebGLBuffer;
}

/**
 * Set up the shared VAO with position + UV vertex buffers and
 * the instanced attribute buffer. Enables vertex attrib arrays 0–6
 * with divisor 1 for instance-rate attributes 2–6.
 *
 * Leaves VAO unbound on return; the caller should manage bind state.
 */
export function setupWebGL2Buffers(
  gl: WebGL2RenderingContext,
  instanceDataByteLength: number
): WebGL2Buffers {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('Failed to create VAO');
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

  const instanceBuffer = gl.createBuffer();
  if (!instanceBuffer) throw new Error('Failed to create instance buffer');
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, instanceDataByteLength, gl.DYNAMIC_DRAW);

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

  return { vao, instanceBuffer, posBuf, uvBuf };
}

/**
 * Upload SDF atlas pixel data to a new WebGL2 texture.
 * Returns the texture (owned by the caller) or null on failure.
 */
export function uploadSDFAtlas(
  gl: WebGL2RenderingContext,
  atlasData: Uint8Array,
  atlasSize: number
): WebGLTexture | null {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    atlasSize,
    atlasSize,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    atlasData
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

// ── SDF instance building ────────────────────────────────────────────────────

/**
 * Build SDF glyph instances + optional card-background texture quads.
 *
 * Iterates over active messages, computes per-glyph instance data for
 * the SDF shader, and optionally writes card-background quads to texQuadData.
 *
 * @returns updated instanceCount and texQuadCount
 */
export function buildSDFInstances(
  messages: readonly SharedMessage[],
  atlas: SDFAtlas | null,
  instanceData: Float32Array,
  maxInstances: number,
  fontSize: number,
  glyphScale: number,
  authorColors: Record<string, string>,
  opacityConfig: OpacityConfig | null,
  now: number,
  translationMode: string | undefined,
  texQuadData?: Float32Array
): { instanceCount: number; texQuadCount: number } {
  let instanceCount = 0;
  let texQuadCount = 0;

  if (!opacityConfig) return { instanceCount, texQuadCount };

  for (const msg of messages) {
    if (instanceCount >= maxInstances) break;

    const elapsed = msg.startTime > 0 ? Math.max(0, now - msg.startTime) : 0;
    const op = computeMessageOpacity(
      // computeMessageOpacity expects a minimal shape; SharedMessage.message satisfies it
      msg.message as Parameters<typeof computeMessageOpacity>[0],
      elapsed,
      msg.duration,
      msg.laneIndex >= 0,
      msg.speedTier,
      opacityConfig
    );
    if (op <= 0) continue;

    const text = getRenderText(msg, translationMode);
    if (!text) continue;

    let cx = msg.x;
    for (let ci = 0; ci < text.length; ci++) {
      if (instanceCount >= maxInstances) break;
      const cp = text.codePointAt(ci) ?? 0x20;
      const gi = atlas?.glyphs.get(cp);
      const off = instanceCount * FLOATS_PER_INSTANCE;
      const c = getMessageColor(msg, authorColors);
      instanceData[off + 0] = cx;
      instanceData[off + 1] = msg.y;
      instanceData[off + 2] = fontSize * 0.7;
      instanceData[off + 3] = fontSize * 1.4;
      instanceData[off + 4] = gi?.index ?? atlas?.glyphs.get(0xfffd)?.index ?? 0;
      instanceData[off + 5] = c[0];
      instanceData[off + 6] = c[1];
      instanceData[off + 7] = c[2];
      instanceData[off + 8] = op;
      instanceCount++;
      cx += (gi?.advanceWidth ?? fontSize * 0.7) * glyphScale;
    }

    // Dual translation mode: render translated text below original
    if (translationMode === 'dual' && msg.translatedText) {
      let tx = msg.x;
      const transFontSize = fontSize * TRANSLATION_FONT_SCALE;
      const ty = msg.y + msg.height + TRANSLATION_GAP_PX;
      const tOpacity = op * TRANSLATION_OPACITY_SCALE;
      for (let ci = 0; ci < msg.translatedText.length; ci++) {
        if (instanceCount >= maxInstances) break;
        const cp = msg.translatedText.codePointAt(ci) ?? 0x20;
        const giDual = atlas?.glyphs.get(cp);
        const offDual = instanceCount * FLOATS_PER_INSTANCE;
        const cDual = getMessageColor(msg, authorColors);
        instanceData[offDual + 0] = tx;
        instanceData[offDual + 1] = ty;
        instanceData[offDual + 2] = transFontSize;
        instanceData[offDual + 3] = transFontSize;
        instanceData[offDual + 4] = giDual?.index ?? atlas?.glyphs.get(0xfffd)?.index ?? 0;
        instanceData[offDual + 5] = cDual[0];
        instanceData[offDual + 6] = cDual[1];
        instanceData[offDual + 7] = cDual[2];
        instanceData[offDual + 8] = tOpacity;
        instanceCount++;
        tx += (giDual?.advanceWidth ?? transFontSize * 0.7) * glyphScale;
      }
    }

    // Card background quad for paid messages (texture pass)
    if (texQuadData) {
      const kind = msg.message.kind;
      if (kind === 'superchat' || kind === 'membership') {
        const bgColor = parseColor(
          kind === 'superchat' ? (msg.message.superChat?.backgroundColor ?? '#ff0000') : '#0f0'
        );
        const pad = 4;
        const bgOff = texQuadCount * FLOATS_PER_INSTANCE;
        texQuadData[bgOff + 0] = msg.x - pad;
        texQuadData[bgOff + 1] = msg.y - pad;
        texQuadData[bgOff + 2] = msg.width + pad * 2;
        texQuadData[bgOff + 3] = msg.height + pad * 2;
        texQuadData[bgOff + 4] = 0;
        texQuadData[bgOff + 5] = bgColor[0];
        texQuadData[bgOff + 6] = bgColor[1];
        texQuadData[bgOff + 7] = bgColor[2];
        texQuadData[bgOff + 8] = op * 0.85;
        texQuadCount++;
      }
    }
  }

  return { instanceCount, texQuadCount };
}

// ── Text + color helpers ─────────────────────────────────────────────────────

/**
 * Extract the renderable text from a message, respecting translation mode.
 *
 * - 'dual': always render original text (translation rendered separately)
 * - 'replace': use translated text when available
 * - default/other: use original text
 */
export function getRenderText(
  msg: {
    translatedText?: string | null;
    message: { content: Array<{ type: string; content?: string }> };
  },
  translationMode: string | undefined
): string {
  if (msg.translatedText && translationMode === 'dual') {
    return msg.message.content.map((s) => (s.type === 'text' ? (s.content ?? '') : ' ')).join('');
  }
  if (msg.translatedText && translationMode === 'replace') {
    return msg.translatedText;
  }
  return msg.message.content.map((s) => (s.type === 'text' ? (s.content ?? '') : ' ')).join('');
}

/**
 * Look up the author type's color from the authorColors map,
 * returning the parsed [r, g, b] triplet in 0–1 range.
 */
export function getMessageColor(
  msg: { message: { authorType: string } },
  authorColors: Record<string, string>
): [number, number, number] {
  const color = authorColors[msg.message.authorType] ?? '#ffffff';
  return parseColor(color);
}

/**
 * Parse a hex color string (with or without leading '#') to a
 * normalized [r, g, b] triplet where each channel is 0–1.
 */
export function parseColor(hex: string): [number, number, number] {
  const h = hex.startsWith('#') ? hex : `#${hex}`;
  return [
    parseInt(h.slice(1, 3), 16) / 255 || 1,
    parseInt(h.slice(3, 5), 16) / 255 || 1,
    parseInt(h.slice(5, 7), 16) / 255 || 1,
  ];
}

// ── Message position update ──────────────────────────────────────────────────

/**
 * Update the x position of each message based on its progress through
 * the animation timeline. Removes messages whose progress >= 1.
 *
 * Mutates the array in place (compaction) and returns the new length.
 *
 * Movement per mode:
 * - 'scroll': right-to-left  (x = startX - progress × travel)
 * - 'reverse': left-to-right (x = startX + progress × travel)
 * - 'top' / 'bottom': fixed  (x = startX)
 */
export function updateMessagePositions(
  messages: SharedMessage[],
  mode: string,
  cssWidth: number,
  now: number
): number {
  let wi = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.laneIndex >= 0) {
      const progress = (now - m.startTime) / m.duration;
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
    if (wi !== i) {
      messages[wi] = m;
    }
    wi++;
  }
  if (wi < messages.length) {
    messages.length = wi;
  }
  return messages.length;
}
