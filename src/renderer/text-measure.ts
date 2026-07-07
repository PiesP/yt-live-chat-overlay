// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Shared Canvas-based text measurement for dimension estimation.
 *
 * Uses a single hidden canvas context so callers can measure text without
 * DOM reflow or creating their own context.
 *
 * Width measurement uses `actualBoundingBoxLeft + actualBoundingBoxRight`
 * instead of `TextMetrics.width` (advance width) to capture glyph
 * overshoot (e.g. italic fonts, CJK characters that extend beyond the
 * advance width). Height uses `actualBoundingBoxAscent + Descent` for
 * the tightest fit around rendered glyphs.
 */

import type { FontWeight } from '@app-types';
import { DEFAULT_FONT_FAMILY } from '@util/design-tokens';

let measureCtx: CanvasRenderingContext2D | null | false = null;

/** Callback invoked with wall-clock milliseconds each time measureTextWidth() performs a real measurement (not a cache hit). */
let textMeasureCallback: ((ms: number) => void) | null = null;

/**
 * Install a callback to receive text-measurement timing data.
 * Used by the observability layer to track text measurement cost per frame.
 */
export function setTextMeasureCallback(cb: ((ms: number) => void) | null): void {
  textMeasureCallback = cb;
}

/** Two-level LRU cache for measureTextWidth. Outer key: font, inner key: text. */
const widthCache = new Map<string, Map<string, number>>();
let totalCacheEntries = 0;
const WIDTH_CACHE_MAX = 1000;
/** How many entries to evict at once from the oldest font group (10% of cap). */
const WIDTH_CACHE_EVICT_BATCH = Math.floor(WIDTH_CACHE_MAX * 0.1);

/**
 * Cache for font ascent/descent metrics measured against "Mg".
 * Keyed by font string — same font always produces identical ascent/descent,
 * so caching avoids redundant ctx.measureText("Mg") calls in measureTextHeight
 * and bitmap generation hot paths.
 *
 * NOTE: Intentionally duplicated in renderer-worker.ts (worker variant).
 * The worker uses OffscreenCanvasRenderingContext2D and cannot share the
 * main-thread canvas context.
 */
const fontMetricsCache = new Map<string, { ascent: number; descent: number }>();

/**
 * Compute the bounding-box width from a TextMetrics object.
 *
 * Uses `actualBoundingBoxLeft + actualBoundingBoxRight` so that glyph
 * overshoot (common with italic fonts and some CJK glyphs) is included.
 * Falls back to `TextMetrics.width` when the bounding-box API returns
 * zeros (empty or whitespace-only strings).
 *
 * Shared between main-thread (text-measure.ts) and worker (renderer-worker.ts)
 * to ensure consistent measurement across both contexts.
 */
export function measureBoundingBoxWidth(m: TextMetrics): number {
  const bbWidth = Math.abs(m.actualBoundingBoxLeft) + Math.abs(m.actualBoundingBoxRight);
  return bbWidth > 0 ? Math.ceil(bbWidth) : Math.ceil(m.width);
}

/** Character-width estimate multiplier for CSP-restricted environments (no canvas). */
const CSP_WIDTH_FACTOR = 0.6;
/** Line-height fallback factor when font bounding-box metrics are unavailable. */
const HEIGHT_FALLBACK_FACTOR = 1.1;

function getCtx(): CanvasRenderingContext2D | null {
  if (measureCtx === false) return null;
  if (!measureCtx) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 0;
      canvas.height = 0;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        measureCtx = false;
        return null;
      }
      measureCtx = ctx;
    } catch {
      measureCtx = false;
      return null;
    }
  }
  return measureCtx;
}

/**
 * Clear the text measurement caches.
 * Call when settings change (font, fontSize) to avoid stale entries.
 */
export function clearTextMeasurementCaches(): void {
  widthCache.clear();
  totalCacheEntries = 0;
  fontMetricsCache.clear();
}

/**
 * Measure the full bounding-box width of a text string.
 *
 * Uses `actualBoundingBoxLeft + actualBoundingBoxRight` so that glyph
 * overshoot (common with italic fonts and some CJK glyphs) is included.
 * Falls back to `TextMetrics.width` when the bounding-box API returns
 * zeros (empty or whitespace-only strings).
 *
 * Results are cached in an LRU cache (max 500 entries) for performance
 * in hot paths like the Canvas2D render loop.
 */
/** Width of the space character ' ' for each font (cached). */
const spaceWidthCache = new Map<string, number>();

export function measureTextWidth(text: string, font: string): number {
  // Fast path for space character (called frequently in wrapLine/buildWrappedLines)
  if (text === ' ') {
    const cached = spaceWidthCache.get(font);
    if (cached !== undefined) return cached;
  }
  // Two-level lookup: outer key = font, inner key = text
  const fontCache = widthCache.get(font);
  if (fontCache) {
    const cached = fontCache.get(text);
    if (cached !== undefined) return cached;
  }

  const ctx = getCtx();
  if (!ctx) {
    // CSP-restricted environment — fall back to character-count estimate
    const match = font.match(/(\d+)px/);
    const capture = match?.[1];
    const fontSize = capture ? Number.parseInt(capture, 10) : 16;
    return Math.ceil(text.length * fontSize * CSP_WIDTH_FACTOR);
  }
  ctx.font = font;
  const t0 = textMeasureCallback ? performance.now() : 0;
  const m = ctx.measureText(text);
  if (textMeasureCallback) {
    textMeasureCallback(performance.now() - t0);
  }
  const width = measureBoundingBoxWidth(m);

  // LRU eviction: when total entries exceeds the limit, evict the oldest
  // entries from the oldest font group (partial eviction — 10% at a time
  // instead of dropping entire font groups, which caused cascade misses).
  while (totalCacheEntries >= WIDTH_CACHE_MAX) {
    const oldestFont = widthCache.keys().next().value;
    if (oldestFont === undefined) break;
    const entries = widthCache.get(oldestFont);
    if (!entries || entries.size === 0) {
      widthCache.delete(oldestFont);
      continue;
    }
    // Evict up to EVICT_BATCH entries from this font group
    let evicted = 0;
    for (const key of entries.keys()) {
      entries.delete(key);
      totalCacheEntries--;
      evicted++;
      if (evicted >= WIDTH_CACHE_EVICT_BATCH && entries.size > 0) break;
    }
    // If the font group is now empty, remove it from the outer map
    if (entries.size === 0) widthCache.delete(oldestFont);
  }

  // Populate space-width cache for this font (avoids repeated measureText calls)
  if (text === ' ') {
    spaceWidthCache.set(font, width);
    return width;
  }

  // Insert into two-level cache
  let innerCache = widthCache.get(font);
  if (!innerCache) {
    innerCache = new Map<string, number>();
    widthCache.set(font, innerCache);
  }
  innerCache.set(text, width);
  totalCacheEntries++;

  return width;
}

/**
 * Retrieve ascent/descent metrics for a font, cached by font string.
 *
 * Uses "Mg" as the representative string — capital M gives a reliable ascent
 * and lowercase g gives a reliable descent. Results are cached because the
 * same font string always produces identical metrics regardless of fontSize.
 *
 * Fallback: fontSize-based estimate when the bounding-box API is unavailable.
 */
function getFontMetrics(font: string, fontSize: number): { ascent: number; descent: number } {
  const cached = fontMetricsCache.get(font);
  if (cached) return cached;

  const ctx = getCtx();
  if (!ctx) {
    const fallback = Math.ceil(fontSize * HEIGHT_FALLBACK_FACTOR) / 2;
    return { ascent: fallback, descent: fallback };
  }

  ctx.font = font;
  const m = ctx.measureText('Mg');
  const ascent = m.actualBoundingBoxAscent ?? m.fontBoundingBoxAscent ?? 0;
  const descent = m.actualBoundingBoxDescent ?? m.fontBoundingBoxDescent ?? 0;

  const metrics = {
    ascent: Math.ceil(ascent),
    descent: Math.ceil(descent),
  };
  fontMetricsCache.set(font, metrics);
  return metrics;
}

/**
 * Measure the full bounding-box height of the font's rendered glyphs.
 *
 * Uses the cached font metrics (ascent + descent) measured against "Mg".
 * Falls back to a fontSize-based estimate when the bounding-box API is
 * unavailable (very old browsers).
 */
export function measureTextHeight(font: string, fontSize: number): number {
  const metrics = getFontMetrics(font, fontSize);
  if (metrics.ascent > 0 && metrics.descent > 0) {
    return metrics.ascent + metrics.descent;
  }
  return Math.ceil(fontSize * HEIGHT_FALLBACK_FACTOR);
}

/**
 * Build a CSS font shorthand string for Canvas2D rendering.
 *
 * Normalizes the weight token: `'bold'` stays as the keyword `'bold'`,
 * everything else (including `'normal'`) maps to the numeric `'400'`.
 * Both are valid CSS `font-weight` values and produce identical rendering.
 *
 * @param sizePx     - Font size in pixels.
 * @param weight     - Font weight token (`'bold'` or `'normal'`).
 * @param fontFamily - CSS font-family stack (defaults to `DEFAULT_FONT_FAMILY`).
 */
export function getFontString(
  sizePx: number,
  weight: FontWeight = 'bold',
  fontFamily: string = DEFAULT_FONT_FAMILY
): string {
  return `${weight === 'bold' ? 'bold' : '400'} ${sizePx}px ${fontFamily}`;
}
