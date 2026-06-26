// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * SDF Atlas Generator
 *
 * Renders glyphs to an OffscreenCanvas, computes the 8SSEDT distance transform,
 * and packs glyphs into a fixed-grid power-of-two RGBA8 texture for WebGL2.
 *
 * Pipeline:
 *   Code points → OffscreenCanvas raster (32px) → 8SSEDT → Pack → WebGL texture
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Glyph raster size in pixels (before SDF padding) */
export const GLYPH_RASTER_SIZE = 32;

/** SDF padding per side — determines the distance field spread */
const SDF_PADDING = 4;

/** Extra padding between cells in the atlas to prevent bleeding */
const ATLAS_CELL_PADDING = 2;

/** Cell size = raster + SDF padding both sides + atlas padding both sides */
export const ATLAS_CELL_SIZE = GLYPH_RASTER_SIZE + (SDF_PADDING + ATLAS_CELL_PADDING) * 2;

/** Distance range in pixels per side (SDF encodes 0..1 mapped to -range..+range) */
export const SDF_DISTANCE_RANGE = SDF_PADDING + GLYPH_RASTER_SIZE * 0.15;

/** Atlas texture size (power of two) */
export const ATLAS_SIZE = 2048;

/** Grid dimension (ATLAS_SIZE / ATLAS_CELL_SIZE = 46 cells per row at 2048/44) */
const ATLAS_GRID_SIZE = Math.floor(ATLAS_SIZE / ATLAS_CELL_SIZE);

/** Max glyphs that fit in the atlas */
const ATLAS_MAX_GLYPHS = ATLAS_GRID_SIZE * ATLAS_GRID_SIZE;

/** Number of glyphs to rasterize per event-loop yield */
const CHUNK_SIZE = 50;

// ── Types ────────────────────────────────────────────────────────────────────

interface GlyphInfo {
  /** Unicode code point */
  codepoint: number;
  /** Linear index in the atlas grid */
  index: number;
  /** Horizontal advance width (CSS px) */
  advanceWidth: number;
  /** Bounding box: distance from origin to left edge */
  bboxLeft: number;
  /** Bounding box: distance from baseline to top */
  bboxTop: number;
  /** Bounding box width */
  bboxWidth: number;
  /** Bounding box height */
  bboxHeight: number;
  /** SDF distance data for packing (transient, cleared after pack) */
  sdfData?: Float32Array;
  /** SDF width */
  sdfWidth?: number;
  /** SDF height */
  sdfHeight?: number;
}

export interface SDFAtlas {
  /** WebGL texture (created by renderer) */
  texture: WebGLTexture | null;
  /** Atlas width/height in texels */
  size: number;
  /** Grid cells per row/column */
  gridSize: number;
  /** Cell size in texels */
  cellSize: number;
  /** Distance range for shader */
  distanceRange: number;
  /** Map from code point → GlyphInfo */
  glyphs: Map<number, GlyphInfo>;
  /** Whether atlas has been uploaded to GPU */
  uploaded: boolean;
  /** Raw RGBA8 pixel data for GPU upload */
  data?: Uint8Array;
}

// ── Code Point Ranges ────────────────────────────────────────────────────────

export function getCodePointRanges(): Array<{ start: number; end: number }> {
  return [
    { start: 0x20, end: 0x7e }, // ASCII printable
    { start: 0x00c0, end: 0x024f }, // Latin Extended
    { start: 0xac00, end: 0xac00 + 724 }, // Korean Hangul (top 724)
    { start: 0x3040, end: 0x309f }, // Hiragana
    { start: 0x30a0, end: 0x30ff }, // Katakana
    { start: 0xff01, end: 0xff5e }, // Fullwidth ASCII
    { start: 0xff65, end: 0xff9f }, // Halfwidth Katakana
    { start: 0x3000, end: 0x303f }, // CJK punctuation
    { start: 0x2018, end: 0x201f }, // Quotes
    { start: 0x2026, end: 0x2026 }, // Ellipsis
    { start: 0x2032, end: 0x2033 }, // Prime
    { start: 0x2190, end: 0x2199 }, // Arrows
    { start: 0x2122, end: 0x2122 }, // Trademark
    { start: 0x00a0, end: 0x00a0 }, // Non-breaking space
    { start: 0xfffd, end: 0xfffd }, // Replacement character
  ];
}

export function collectCodePoints(): number[] {
  const cps: number[] = [];
  for (const range of getCodePointRanges()) {
    for (let cp = range.start; cp <= range.end; cp++) {
      cps.push(cp);
    }
  }
  return [...new Set(cps)].sort((a, b) => a - b);
}

// ── 8SSEDT Distance Transform ────────────────────────────────────────────────

/**
 * Safe Float32Array element access for noUncheckedIndexedAccess mode.
 * Returns 0 for out-of-bounds (acts as infinity for min-comparisons).
 */
export function safeGetF32(arr: Float32Array, i: number, size: number): number {
  return i >= 0 && i < size ? (arr[i] ?? 0) : 1e10;
}

/**
 * Two-pass O(n) Chamfer distance transform (1,2 weight).
 * Produces approximate signed distance field sufficient for glyph rendering.
 *
 * Input: binary alpha buffer (0 = inside glyph, 255 = outside)
 * Output: SDF buffer (0..1, where 0.5 = glyph edge)
 */
export function computeChamferSDF(binary: Uint8Array, width: number, height: number): Float32Array {
  const size = width * height;
  const INF = 1e10;

  // Helper: get binary value (0 or 1)
  const isInside = (i: number): boolean => {
    const v = i >= 0 && i < size ? (binary[i] ?? 0) : 0;
    return v <= 128;
  };

  // Inside distance: 0 inside glyph, INF outside
  const distIn = new Float32Array(size);
  // Outside distance: 0 outside glyph, INF inside
  const distOut = new Float32Array(size);

  for (let i = 0; i < size; i++) {
    const inside = isInside(i);
    distIn[i] = inside ? 0 : INF;
    distOut[i] = inside ? INF : 0;
  }

  // Process both distance fields
  for (const dist of [distIn, distOut]) {
    // First pass: top-left → bottom-right
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const cur = dist[idx] ?? INF;
        if (cur === 0) continue;

        let best = cur;
        if (y > 0) {
          const d = safeGetF32(dist, idx - width, size) + 1;
          if (d < best) best = d;
        }
        if (x > 0) {
          const d = safeGetF32(dist, idx - 1, size) + 1;
          if (d < best) best = d;
        }
        if (y > 0 && x > 0) {
          const d = safeGetF32(dist, idx - width - 1, size) + 2;
          if (d < best) best = d;
        }
        if (y > 0 && x < width - 1) {
          const d = safeGetF32(dist, idx - width + 1, size) + 2;
          if (d < best) best = d;
        }
        dist[idx] = best;
      }
    }

    // Second pass: bottom-right → top-left
    for (let y = height - 1; y >= 0; y--) {
      for (let x = width - 1; x >= 0; x--) {
        const idx = y * width + x;
        const cur = dist[idx] ?? INF;
        if (cur === 0) continue;

        let best = cur;
        if (y < height - 1) {
          const d = safeGetF32(dist, idx + width, size) + 1;
          if (d < best) best = d;
        }
        if (x < width - 1) {
          const d = safeGetF32(dist, idx + 1, size) + 1;
          if (d < best) best = d;
        }
        if (y < height - 1 && x < width - 1) {
          const d = safeGetF32(dist, idx + width + 1, size) + 2;
          if (d < best) best = d;
        }
        if (y < height - 1 && x > 0) {
          const d = safeGetF32(dist, idx + width - 1, size) + 2;
          if (d < best) best = d;
        }
        dist[idx] = best;
      }
    }
  }

  // Combine: SDF = outsideDist - insideDist, normalize to 0..1
  const sdf = new Float32Array(size);
  let maxDist = 0;
  for (let i = 0; i < size; i++) {
    const d = (distOut[i] ?? 0) - (distIn[i] ?? 0);
    if (Math.abs(d) > maxDist) maxDist = Math.abs(d);
  }

  if (maxDist === 0) return sdf;

  for (let i = 0; i < size; i++) {
    const outside = distOut[i] ?? 0;
    const inside = distIn[i] ?? 0;
    sdf[i] = (outside - inside) / (2 * maxDist) + 0.5;
  }

  return sdf;
}

// ── Atlas Generator ──────────────────────────────────────────────────────────

export class SDFAtlasGenerator {
  private canvas: OffscreenCanvas | HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

  constructor() {
    if (typeof OffscreenCanvas !== 'undefined') {
      this.canvas = new OffscreenCanvas(GLYPH_RASTER_SIZE, GLYPH_RASTER_SIZE);
    } else {
      this.canvas = document.createElement('canvas');
      this.canvas.width = GLYPH_RASTER_SIZE;
      this.canvas.height = GLYPH_RASTER_SIZE;
    }
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Failed to create 2D context for SDF atlas');
    this.ctx = ctx;
  }

  /**
   * Generate the complete SDF atlas asynchronously.
   * Yields to the event loop every CHUNK_SIZE glyphs to prevent main thread freeze.
   */
  async generate(
    fontFamily: string,
    fontWeight: string | number = 400,
    onProgress?: (completed: number, total: number) => void
  ): Promise<SDFAtlas> {
    const codePoints = collectCodePoints();
    const total = Math.min(codePoints.length, ATLAS_MAX_GLYPHS);
    const atlas: SDFAtlas = {
      texture: null,
      size: ATLAS_SIZE,
      gridSize: ATLAS_GRID_SIZE,
      cellSize: ATLAS_CELL_SIZE,
      distanceRange: SDF_DISTANCE_RANGE,
      glyphs: new Map(),
      uploaded: false,
    };

    const atlasData = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
    const fontStr = `${fontWeight} ${GLYPH_RASTER_SIZE}px "${fontFamily}"`;

    for (let i = 0; i < total; i++) {
      const cp = codePoints[i];
      if (cp === undefined) continue;
      const glyphInfo = this.rasterizeGlyph(cp, fontStr, i);

      if (glyphInfo) {
        atlas.glyphs.set(cp, glyphInfo);
        this.packGlyph(atlasData, glyphInfo, i);
      }

      if (i % CHUNK_SIZE === 0) {
        onProgress?.(i, total);
        // Yield to the scheduler to keep the UI responsive.
        // scheduler.yield() is the modern API; fall back to setTimeout for older engines.
        if ('scheduler' in globalThis) {
          await (globalThis as { scheduler: { yield: () => Promise<void> } }).scheduler.yield();
        } else {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }

    onProgress?.(total, total);

    // Store raw data for upload
    atlas.data = atlasData;

    return atlas;
  }

  private rasterizeGlyph(
    codepoint: number,
    font: string,
    index: number
  ): (GlyphInfo & { sdfData: Float32Array; sdfWidth: number; sdfHeight: number }) | null {
    const ctx = this.ctx;
    const w = GLYPH_RASTER_SIZE;
    const h = GLYPH_RASTER_SIZE;

    ctx.clearRect(0, 0, w, h);
    ctx.font = font;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#fff';

    const char = String.fromCodePoint(codepoint);
    const metrics = ctx.measureText(char);

    // Skip zero-width glyphs
    if (metrics.width === 0 && codepoint > 0x20) {
      ctx.fillText(char, 0, 0);
      const imageData = ctx.getImageData(0, 0, w, h);
      let hasPixel = false;
      for (let p = 3; p < imageData.data.length; p += 4) {
        if ((imageData.data[p] ?? 0) > 0) {
          hasPixel = true;
          break;
        }
      }
      if (!hasPixel) return null;
    }

    const x = Math.max(0, (w - metrics.width) / 2);
    const y = Math.max(0, (h - GLYPH_RASTER_SIZE) / 2);
    ctx.fillText(char, x, y);

    // Compute SDF
    const imageData = ctx.getImageData(0, 0, w, h);
    const binary = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      binary[i] = imageData.data[i * 4 + 3] ?? 0;
    }

    const sdf = computeChamferSDF(binary, w, h);

    return {
      codepoint,
      index,
      advanceWidth: Math.max(1, Math.ceil(metrics.width)),
      bboxLeft: Math.abs(metrics.actualBoundingBoxLeft) || 0,
      bboxTop: Math.abs(metrics.actualBoundingBoxAscent) || 0,
      bboxWidth: Math.ceil(metrics.width) || 1,
      bboxHeight: GLYPH_RASTER_SIZE,
      sdfData: sdf,
      sdfWidth: w,
      sdfHeight: h,
    };
  }

  private packGlyph(
    atlasData: Uint8Array,
    glyph: GlyphInfo & { sdfData: Float32Array; sdfWidth: number; sdfHeight: number },
    gridIndex: number
  ): void {
    const gridSize = ATLAS_GRID_SIZE;
    const col = gridIndex % gridSize;
    const row = Math.floor(gridIndex / gridSize);

    const cellX = col * ATLAS_CELL_SIZE + ATLAS_CELL_PADDING;
    const cellY = row * ATLAS_CELL_SIZE + ATLAS_CELL_PADDING;

    const sdfW = glyph.sdfWidth ?? GLYPH_RASTER_SIZE;
    const sdfH = glyph.sdfHeight ?? GLYPH_RASTER_SIZE;
    const offsetX = cellX + Math.floor((ATLAS_CELL_SIZE - ATLAS_CELL_PADDING * 2 - sdfW) / 2);
    const offsetY = cellY + Math.floor((ATLAS_CELL_SIZE - ATLAS_CELL_PADDING * 2 - sdfH) / 2);

    const sdfData = glyph.sdfData;
    if (!sdfData) return;

    for (let y = 0; y < sdfH; y++) {
      for (let x = 0; x < sdfW; x++) {
        const atlasPx = (offsetY + y) * ATLAS_SIZE + (offsetX + x);
        const sdfVal = Math.round((sdfData[y * sdfW + x] ?? 0.5) * 255);
        const base = atlasPx * 4;
        atlasData[base + 0] = sdfVal;
        atlasData[base + 1] = sdfVal;
        atlasData[base + 2] = sdfVal;
        atlasData[base + 3] = 255;
      }
    }
  }
}
