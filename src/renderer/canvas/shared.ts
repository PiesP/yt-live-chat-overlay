// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Shared Canvas 2D rendering functions usable from both main thread
 * (CanvasRenderingContext2D) and Web Worker (OffscreenCanvasRenderingContext2D).
 *
 * Eliminates ~300+ lines of code duplication between canvas-rendering-shared.ts
 * and renderer-worker.ts.
 */

import type { FontWeight } from '@app-types';
import { EMOJI_ALIAS_PATTERN } from '@chat/message-helpers';
import { computeOutlineColor } from '@renderer/color-utils';
import { OUTLINE_STROKE_SCALE } from '@renderer/constants';
import { getFontString, measureTextHeight, measureTextWidth } from '@renderer/text-measure';
import type { ByteLimitedCache } from '@util/byte-limited-cache';
import { AUTHOR_PHOTO_SHADOW, rendererLayout, spacing } from '@util/design-tokens';

/** A char-wrap segment with pre-computed width. */
interface CharSegment {
  text: string;
  width: number;
}

// ── Types ─────────────────────────────────────────────────────────────────

/** Union type covering both canvas context types for text rendering. */
export type AnyCanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Minimal cache interface for text bitmaps (HTMLCanvasElement or OffscreenCanvas). */
export interface TextBitmapCache {
  get(key: string): CanvasImageSource | undefined;
  set(key: string, value: CanvasImageSource): void;
}

/**
 * Unified content segment type that both ContentSegment (@app-types)
 * and WorkerContentSegment (renderer-worker.ts) structurally satisfy.
 */
export interface SharedContentSegment {
  type: 'text' | 'emoji';
  /** Text content (text segments only). */
  content?: string;
  /** Worker: direct field. Main: seg.emoji.url */
  emojiUrl?: string;
  /** Worker: direct field. Main: seg.emoji.alt */
  emojiAlt?: string;
  /** Main only: seg.emoji.fallbackText. Worker: not needed. */
  emojiFallbackText?: string;
  /** Main only: seg.emoji.url, seg.emoji.fallbackText, seg.emoji.alt. Worker: not used. */
  emoji?: {
    url: string;
    fallbackText?: string;
    alt?: string;
  };
}

/**
 * Convert a ContentSegment (from @app-types) to a SharedContentSegment.
 * This is a structural transformation — the nested `emoji` object is flattened
 * into top-level `emojiUrl`/`emojiAlt` fields for cross-thread compatibility.
 */
function toSharedContentSegment(seg: {
  type: string;
  content?: string;
  emoji?: { url: string; alt: string; fallbackText?: string };
}): SharedContentSegment {
  if (seg.type === 'emoji') {
    const { url, alt, fallbackText } = seg.emoji ?? {};
    const result: SharedContentSegment = { type: 'emoji' };
    if (url !== undefined) result.emojiUrl = url;
    if (alt !== undefined) result.emojiAlt = alt;
    if (fallbackText !== undefined) result.emojiFallbackText = fallbackText;
    return result;
  }
  const result: SharedContentSegment = { type: 'text' };
  if (seg.content !== undefined) result.content = seg.content;
  return result;
}

/**
 * Convert an array of ContentSegments to SharedContentSegments.
 */
export function toSharedContentSegments(segments: readonly unknown[]): SharedContentSegment[] {
  return segments.map((seg) =>
    toSharedContentSegment(
      seg as {
        type: string;
        content?: string;
        emoji?: { url: string; alt: string; fallbackText?: string };
      }
    )
  );
}

/** Piece in a wrapped line — either a text word or an emoji image. */
interface SharedTextPiece {
  type: 'text';
  text: string;
  width: number;
}

interface SharedEmojiPiece {
  type: 'emoji';
  emojiUrl: string;
  emojiAlt?: string;
  emojiFallbackText?: string;
  width: number;
}

export type SharedRenderPiece = SharedTextPiece | SharedEmojiPiece;

/** Content segment shape accepted by getDisplayText. */
interface TextSegmentLike {
  type: string;
  content?: string;
}

/**
 * Extract text-only content from segments, excluding emoji fallbackText.
 *
 * Use this when you need a plain-text rendering fallback — e.g. for
 * lightweight fillText paths (temporal ghost, width estimation) — to
 * avoid accidentally rendering emoji accessibility labels alongside
 * emoji images.
 *
 * @see ChatMessage.text — includes emoji fallbackText, NOT for canvas rendering.
 */
export function getDisplayText(segments: readonly TextSegmentLike[]): string {
  return segments
    .filter((s): s is { type: 'text'; content: string } => s.type === 'text' && !!s.content)
    .map((s) => s.content)
    .join('');
}

// ── Character-level wrapping for oversize words (CJK, URLs, etc.) ──────────

/** Lazy-initialized Intl.Segmenter for grapheme-cluster splitting. */
let _graphemeSegmenter: Intl.Segmenter | undefined;

function getGraphemeSegmenter(): Intl.Segmenter | undefined {
  if (_graphemeSegmenter === undefined) {
    try {
      _graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    } catch {
      _graphemeSegmenter = undefined; // runtime without Intl.Segmenter
    }
  }
  return _graphemeSegmenter;
}

/**
 * Split a string into grapheme clusters for safe per-character processing.
 *
 * Uses Intl.Segmenter when available so that ZWJ sequences, flag emoji,
 * and skin-tone modifiers stay intact.  Falls back to Array.from (code-point
 * iteration) on runtimes without Intl.Segmenter support.
 */
export function splitGraphemeClusters(text: string): string[] {
  const seg = getGraphemeSegmenter();
  if (seg) {
    return Array.from(seg.segment(text), (s) => s.segment);
  }
  return Array.from(text); // code-point fallback
}

/**
 * Reverse the visual order of RTL text (Arabic, Hebrew, etc.) so that
 * Canvas2D fillText() — which always renders left-to-right — produces
 * the correct visual reading order.
 *
 * Canvas2D does not support bidirectional text: Arabic rendered via
 * fillText() appears LTR with isolated glyph forms.  By reversing the
 * character sequence we at least restore correct reading order.
 *
 * ## Known Limitations
 *
 * - **Contextual Arabic shaping** (cursive letter connections) is NOT
 *   supported — this requires a dedicated shaping engine (e.g. HarfBuzz).
 *   Ligatures, diacritic placement, and complex script features are
 *   approximated at best.
 * - **Why not use a shaping engine?** HarfBuzz WASM adds ~2MB to the
 *   bundle, and Canvas2D's fillText() cannot render shaped glyph sequences
 *   anyway (it renders individual code points in order).
 * - **Recommended path for accurate RTL text:** the DOM-based accessibility
 *   pipeline (aria-live region in overlay.ts) leverages the browser's native
 *   bidirectional text rendering. Users needing full Arabic/Hebrew text
 *   fidelity should use screen readers or the planned read panel.
 */
function reverseRtlText(text: string): string {
  // Quick scan: is the first strong character RTL?
  let hasRtl = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    // Hebrew block + Arabic blocks + Syriac + Thaana + NKo
    if ((cp >= 0x0590 && cp <= 0x08ff) || (cp >= 0xfb1d && cp <= 0xfefc)) {
      hasRtl = true;
      break;
    }
    // Skip neutrals (spaces, punctuation, marks) — keep scanning
    // for the first character with strong direction.
    if (/\S/u.test(ch)) break; // first non-space is LTR → bail
  }
  if (!hasRtl) return text;

  // Reverse grapheme clusters so the rightmost glyph appears first on screen.
  return splitGraphemeClusters(text).reverse().join('');
}

/**
 * Truncate text to fit within maxWidth pixels on the given canvas context.
 * Uses grapheme-cluster iteration + binary search for O(log n) measureText
 * calls. Appends ellipsis (…) when truncation occurs.
 *
 * @param text      The text to potentially clip.
 * @param maxWidth  Maximum pixel width allowed.
 * @param ctx       Canvas 2D context (HTML or Offscreen).
 * @returns The original text if it fits, or a grapheme-cluster-accurate
 *          truncated version ending with an ellipsis character.
 */
export function clipTextToWidth(
  text: string,
  maxWidth: number,
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
): string {
  if (!text || maxWidth <= 0) return '';

  const fullWidth = ctx.measureText(text).width;
  if (fullWidth <= maxWidth) return text;

  const graphemes = splitGraphemeClusters(text);
  // Binary search for max grapheme count fitting maxWidth.
  let lo = 0;
  let hi = graphemes.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const candidate = graphemes.slice(0, mid).join('');
    if (ctx.measureText(candidate).width <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  if (lo === 0) return '';
  if (lo === graphemes.length) return text;
  return `${graphemes.slice(0, lo).join('').trimEnd()}\u2026`;
}

/**
 * Split a word that exceeds maxWidth into grapheme-cluster segments.
 *
 * Uses Intl.Segmenter (grapheme granularity) when available so that
 * multi-code-point sequences (ZWJ emoji, flags, skin tones) stay
 * together.  Falls back to code-point iteration on older runtimes.
 * Used as a fallback when a single word is wider than the available width.
 */
function wrapCharSegments(
  word: string,
  maxWidth: number,
  measureTextFn: (text: string) => number
): CharSegment[] {
  const segments: CharSegment[] = [];
  let current = '';
  let currentWidth = 0;

  const chars: string[] = splitGraphemeClusters(word);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const chWidth = measureTextFn(ch);
    if (currentWidth + chWidth > maxWidth && current.length > 0) {
      segments.push({ text: current, width: currentWidth });
      current = ch;
      currentWidth = chWidth;
    } else {
      current += ch;
      currentWidth += chWidth;
    }
  }

  if (current.length > 0) {
    segments.push({ text: current, width: currentWidth });
  }

  return segments;
}

/**
 * Build wrapped lines from content segments using greedy line-fill.
 *
 * This is the SSOT for line-breaking logic — used by both the renderer
 * (to produce lines for rendering) and the dimension estimator
 * (to predict line count and max width without a canvas).
 *
 * @param segments  Content segments (text + emoji) to wrap.
 * @param maxWidth  Maximum width per line in pixels.
 * @param emojiSize Emoji rendering size in pixels.
 * @param measureTextFn Width measurement function (font-aware).
 * @returns Built lines and the maximum line width across all lines.
 */
export function buildWrappedLines(
  segments: readonly SharedContentSegment[],
  maxWidth: number,
  emojiSize: number,
  measureTextFn: (text: string) => number
): { lines: SharedRenderPiece[][]; maxLineWidth: number } {
  // ── Step 1: Flatten segments into word/emoji pieces
  const pieces: SharedRenderPiece[] = [];
  for (const seg of segments) {
    if (seg.type === 'text') {
      const words = (seg.content ?? '').split(/\s+/).filter((w) => w.length > 0);
      for (const word of words) {
        pieces.push({ type: 'text', text: word, width: measureTextFn(word) });
      }
    } else {
      const url = seg.emojiUrl ?? seg.emoji?.url ?? '';
      const alt = seg.emojiAlt ?? seg.emoji?.alt;
      const fallbackText = seg.emojiFallbackText ?? seg.emoji?.fallbackText;
      if (url) {
        pieces.push({
          type: 'emoji',
          emojiUrl: url,
          ...(alt ? { emojiAlt: alt } : {}),
          ...(fallbackText ? { emojiFallbackText: fallbackText } : {}),
          width: emojiSize + spacing.xs,
        });
      }
    }
  }

  const lines: SharedRenderPiece[][] = [];
  if (pieces.length === 0) return { lines, maxLineWidth: 0 };

  // ── Step 2: Greedy line-filling
  let currentLine: SharedRenderPiece[] = [];
  let currentWidth = 0;
  let prevIsText = false;
  const spaceWidth = measureTextFn(' ');
  let maxLineWidth = 0;

  for (const piece of pieces) {
    const gap = prevIsText ? spaceWidth : 0;
    const needed = gap + piece.width;

    // ── Oversize single word — character-level wrap (CJK, URLs, etc.)
    if (piece.type === 'text' && piece.width > maxWidth) {
      if (currentLine.length > 0) {
        maxLineWidth = Math.max(maxLineWidth, currentWidth);
        lines.push(currentLine);
      }
      const charSegs = wrapCharSegments(piece.text, maxWidth, measureTextFn);
      if (charSegs.length <= 1) {
        currentLine = [piece];
        currentWidth = piece.width;
        prevIsText = true;
        continue;
      }
      for (let i = 0; i < charSegs.length - 1; i++) {
        const cs = charSegs[i] as CharSegment;
        lines.push([{ type: 'text', text: cs.text, width: cs.width }]);
        maxLineWidth = Math.max(maxLineWidth, cs.width);
      }
      const lastSeg = charSegs[charSegs.length - 1] as CharSegment;
      currentLine = [{ type: 'text', text: lastSeg.text, width: lastSeg.width }];
      currentWidth = lastSeg.width;
      prevIsText = true;
      continue;
    }

    // ── Normal line overflow
    if (currentLine.length > 0 && currentWidth + needed > maxWidth) {
      maxLineWidth = Math.max(maxLineWidth, currentWidth);
      lines.push(currentLine);
      currentLine = [piece];
      currentWidth = piece.width;
      prevIsText = piece.type === 'text';
      continue;
    }

    if (gap > 0) currentWidth += gap;
    currentLine.push(piece);
    currentWidth += piece.width;
    prevIsText = piece.type === 'text';
  }

  if (currentLine.length > 0) {
    maxLineWidth = Math.max(maxLineWidth, currentWidth);
    lines.push(currentLine);
  }

  return { lines, maxLineWidth };
}

// ── Outline stroke ──────────────────────────────────────────────────────────

/**
 * Draw crisp auto-contrast outline on text using current font and textBaseline.
 * Uses individual outlineWidthPx and outlineOpacity parameters (not a settings
 * object) so the same function works in both main-thread and worker contexts.
 */
export function strokeTextOutline(
  ctx: AnyCanvasContext,
  text: string,
  x: number,
  y: number,
  textColor: string,
  outlineWidthPx: number,
  outlineOpacity: number
): void {
  if (outlineWidthPx <= 0 || outlineOpacity <= 0) return;
  const strokeWidth = Math.max(0.5, outlineWidthPx * OUTLINE_STROKE_SCALE);
  ctx.save();
  ctx.strokeStyle = computeOutlineColor(textColor, Math.min(1, outlineOpacity));
  ctx.lineWidth = strokeWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.miterLimit = 2;
  ctx.strokeText(text, x, y);
  ctx.restore();
}

// ── Round rectangle ─────────────────────────────────────────────────────────

/**
 * Feature-detect whether the context supports the native `roundRect()` API
 * (Canvas2D spec, Chrome 99+, Firefox 112+, Safari 16+).
 *
 * Checked once per unique context instance via WeakSet so that mixed
 * main-thread / worker paths each get correct detection without global state.
 */
const _roundRectCapable = new WeakSet<object>();

function hasRoundRect(ctx: AnyCanvasContext): boolean {
  if (_roundRectCapable.has(ctx)) return true;
  if (typeof (ctx as unknown as Record<string, unknown>).roundRect === 'function') {
    _roundRectCapable.add(ctx);
    return true;
  }
  return false;
}

/** Draw a rounded rectangle path (no fill/stroke — path only).
 *  Uses the native `roundRect()` when available, falls back to `arcTo`
 *  path construction on older browsers. */
export function drawRoundRect(
  ctx: AnyCanvasContext,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  if (hasRoundRect(ctx)) {
    // Native path — single call replaces the 9 arcTo operations.
    // roundRect() does NOT call beginPath() internally, so the caller
    // (or this function) must do so — this is handled above.
    void (ctx as CanvasRenderingContext2D).roundRect(x, y, w, h, r);
    // With native roundRect, the path is open by default and does NOT
    // need closePath() for fill/stroke to work.  The arcTo path below
    // calls closePath() explicitly for visual parity; for roundRect the
    // implicit closure when filling/stroking is sufficient.
    return;
  }

  // Legacy arcTo fallback (9 path operations)
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// ── Text bitmap cache ──────────────────────────────────────────────────────

/**
 * Render text with outline to an OffscreenCanvas and store in bitmap cache.
 *
 * Uses OffscreenCanvas (available in both main thread and worker) and
 * actualBoundingBox metrics for accurate sizing. Does NOT handle LRU eviction
 * — the caller's cache implementation is responsible for that.
 */
function cacheTextBitmap(
  key: string,
  text: string,
  font: string,
  fontSize: number,
  fillColor: string,
  strokeWidth: number,
  strokeColor: string,
  ctx: AnyCanvasContext,
  textBitmapCache: TextBitmapCache,
  letterSpacing = '0px'
): void {
  if (!ctx) return;

  ctx.save();
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const bbWidth =
    Math.abs(metrics.actualBoundingBoxLeft) + Math.abs(metrics.actualBoundingBoxRight);
  const textWidth = bbWidth > 0 ? Math.ceil(bbWidth) : Math.ceil(metrics.width);
  // Canvas2D measureText() does NOT account for letterSpacing, wordSpacing,
  // or textRendering — it measures based on font + text content only.
  // When letterSpacing > 0, the actual rendered text is wider by
  // (graphemeCount - 1) × letterSpacingPx.  Add this contribution to
  // prevent the rightmost character from being clipped by the bitmap edge.
  const lsPx = parseFloat(letterSpacing) || 0;
  const lsExtraWidth = lsPx > 0 ? Math.ceil(Math.max(0, [...text].length - 1) * lsPx) : 0;
  const width = textWidth + Math.ceil(strokeWidth) + 2 + lsExtraWidth;
  const ascent = Math.abs(metrics.actualBoundingBoxAscent) || Math.ceil(fontSize * 0.8);
  const descent = Math.abs(metrics.actualBoundingBoxDescent) || Math.ceil(fontSize * 0.2);
  const height = ascent + descent + Math.ceil(strokeWidth) + 2;
  ctx.restore();

  // Detect DPR from context transform so bitmap resolution matches the
  // canvas backing store. Without this, a 1x bitmap drawn on a 2x canvas
  // via drawImage() gets browser-upscaled → blurry cached text.
  const dpr = ctx.getTransform().a || 1;

  const offscreen: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(Math.ceil(width * dpr), Math.ceil(height * dpr))
      : (() => {
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(width * dpr);
          canvas.height = Math.ceil(height * dpr);
          return canvas;
        })();
  const offCtx = offscreen.getContext('2d');
  if (!offCtx) return;

  // Scale so CSS-coordinate drawing commands map to the full DPR buffer
  offCtx.scale(dpr, dpr);
  offCtx.font = font;
  offCtx.textBaseline = 'top';
  offCtx.letterSpacing = letterSpacing;
  offCtx.textRendering = 'optimizeLegibility';
  offCtx.fontKerning = 'auto'; // enable kerning for cached bitmap quality
  offCtx.strokeStyle = strokeColor;
  offCtx.lineWidth = strokeWidth;
  offCtx.lineJoin = 'round';
  offCtx.lineCap = 'round';
  offCtx.miterLimit = 2;
  offCtx.strokeText(text, strokeWidth / 2 + 1, strokeWidth / 2 + 1);
  offCtx.fillStyle = fillColor;
  offCtx.fillText(text, strokeWidth / 2 + 1, strokeWidth / 2 + 1);

  textBitmapCache.set(key, offscreen);
}

// ── Segment rendering ───────────────────────────────────────────────────────

/**
 * Draw a DPR-scaled bitmap at CSS-pixel coordinates.
 *
 * Bitmaps created by cacheTextBitmap are rendered at device resolution
 * (natural pixels = CSS size × DPR).  When drawn via drawImage(img, x, y)
 * without explicit dimensions, the image's natural pixel count is interpreted
 * as coordinate-system units — which causes a 2× oversize on DPR-scaled
 * canvases.  This helper divides the bitmap dimensions by the context's DPR
 * so the bitmap occupies the correct CSS-pixel area regardless of pixel
 * density.
 */
function drawBitmapAtCssSize(
  ctx: AnyCanvasContext,
  bitmap: CanvasImageSource,
  x: number,
  y: number
): void {
  let bw = 0;
  let bh = 0;
  if (
    (typeof HTMLCanvasElement !== 'undefined' && bitmap instanceof HTMLCanvasElement) ||
    bitmap instanceof OffscreenCanvas
  ) {
    bw = bitmap.width;
    bh = bitmap.height;
  }
  if (bw <= 0 || bh <= 0) {
    ctx.drawImage(bitmap, x, y); // fallback for non-canvas sources
    return;
  }
  const dpr = ctx.getTransform().a || 1;
  ctx.drawImage(bitmap, x, y, bw / dpr, bh / dpr);
}

/**
 * Render a single text segment with outline bitmap caching.
 *
 * @param outlineWidthPx  Outline width in pixels (0 = no outline)
 * @param outlineOpacity  Outline opacity (0-1)
 * @param textBitmapCache Generic bitmap cache (Map or ByteLimitedCache)
 */
export function renderSegment(
  ctx: AnyCanvasContext,
  text: string,
  x: number,
  y: number,
  color: string,
  fontSize: number,
  outlineWidthPx: number,
  outlineOpacity: number,
  textBitmapCache: TextBitmapCache,
  getFontFn: (fontSize: number) => string,
  letterSpacing = '0px'
): void {
  // Reverse RTL text so Canvas2D fillText (always LTR) produces correct
  // visual reading order for Arabic, Hebrew, etc.
  const displayText = reverseRtlText(text);

  const font = getFontFn(fontSize);
  const strokeWidth = Math.max(0.5, outlineWidthPx * OUTLINE_STROKE_SCALE);
  const strokeColor = computeOutlineColor(color, Math.min(1, outlineOpacity));
  // Normalize to 'dark'/'light' — computeOutlineColor only returns black or
  // white variations.  Using the class instead of the full rgba string prevents
  // cache fragmentation from opacity-only differences (e.g. rgba(0,0,0,0.8)
  // vs rgba(0,0,0,0.6) are the same visual outline class).
  const outlineClass = strokeColor.startsWith('rgba(0, 0, 0') ? 'dark' : 'light';

  // Try bitmap cache first (includes outline rendering)
  if (outlineWidthPx > 0 && outlineOpacity > 0 && displayText.length >= 3) {
    const key = `${font}|${displayText}|${color}|${Math.round(strokeWidth)}|${outlineClass}|${letterSpacing}`;
    const bitmap = textBitmapCache.get(key);
    if (bitmap) {
      drawBitmapAtCssSize(ctx, bitmap, x, y);
      return;
    }

    // Cache miss — render to offscreen canvas and cache
    cacheTextBitmap(
      key,
      displayText,
      font,
      fontSize,
      color,
      strokeWidth,
      strokeColor,
      ctx,
      textBitmapCache,
      letterSpacing
    );

    // Immediately use the freshly cached bitmap to avoid fallthrough overhead
    const freshBitmap = textBitmapCache.get(key);
    if (freshBitmap) {
      drawBitmapAtCssSize(ctx, freshBitmap, x, y);
      return;
    }
  }

  // Fallback: direct fillText + strokeText
  ctx.save();
  ctx.font = font;
  ctx.textBaseline = 'top';
  ctx.textRendering = 'optimizeSpeed';
  ctx.fontKerning = 'none'; // disable kerning for speed
  ctx.letterSpacing = letterSpacing;
  strokeTextOutline(ctx, displayText, x, y, color, outlineWidthPx, outlineOpacity);
  ctx.fillStyle = color;
  ctx.fillText(displayText, x, y);
  ctx.restore();
}

// ── Text bitmap key computation (extracted for reuse) ───────────────────────

// ── Text bitmap pre-warming ─────────────────────────────────────────────────

/**
 * Pre-render text bitmaps before they enter the render loop.
 *
 * When called during drainQueue (outside the draw hot path), this populates
 * the bitmap cache for all text segments in a message so that renderSegment
 * always gets a cache hit during the per-frame draw stage.  Eliminates the
 * synchronous OffscreenCanvas fillText/strokeText cost from the render loop
 * — especially impactful during chat bursts where dozens of unique texts
 * arrive simultaneously.
 *
 * @param segments        Content segments, or a plain string for override-text modes
 * @param textBitmapCache The same cache used by renderSegment
 * @param ctx             A context for measurement and DPR detection
 */
export function warmTextBitmapCache(
  segments: readonly SharedContentSegment[] | string,
  fontSize: number,
  fontWeight: string,
  fontFamily: string,
  color: string,
  outlineWidthPx: number,
  outlineOpacity: number,
  textBitmapCache: TextBitmapCache,
  ctx: AnyCanvasContext,
  letterSpacing?: string
): void {
  if (outlineWidthPx <= 0 || outlineOpacity <= 0) return;

  const strokeWidth = Math.max(0.5, outlineWidthPx * OUTLINE_STROKE_SCALE);
  const strokeColor = computeOutlineColor(color, Math.min(1, outlineOpacity));
  const keyLetterSpacing = letterSpacing ?? '0px';

  const warmSingle = (text: string, ls: string): void => {
    const displayText = reverseRtlText(text);
    if (displayText.length < 3) return; // min length for bitmap caching
    const font = getFontString(fontSize, fontWeight as FontWeight, fontFamily);
    const outlineClass = strokeColor.startsWith('rgba(0, 0, 0') ? 'dark' : 'light';
    const key = `${font}|${displayText}|${color}|${Math.round(strokeWidth)}|${outlineClass}|${ls}`;
    if (textBitmapCache.get(key)) return; // already cached

    cacheTextBitmap(
      key,
      displayText,
      font,
      fontSize,
      color,
      strokeWidth,
      strokeColor,
      ctx,
      textBitmapCache,
      ls
    );
  };

  if (typeof segments === 'string') {
    warmSingle(segments, keyLetterSpacing);
  } else {
    for (const seg of segments) {
      if (seg.type === 'text' && seg.content) {
        warmSingle(seg.content, keyLetterSpacing);
      }
    }
  }
}

// ── Content segments (text + emoji) — single-line ────────────────────────────

/**
 * Normalize emoji fields from a SharedContentSegment.
 */
function resolveEmojiFields(seg: SharedContentSegment): {
  emojiUrl: string;
  emojiAlt: string | undefined;
  emojiFallbackText: string | undefined;
} {
  const emojiUrl = seg.emojiUrl || seg.emoji?.url || '';
  const emojiAlt = seg.emojiAlt || seg.emoji?.alt;
  const emojiFallbackText = seg.emojiFallbackText || seg.emoji?.fallbackText;
  return { emojiUrl, emojiAlt, emojiFallbackText };
}

/**
 * Render content segments (text + emoji) in a single line.
 *
 * @param ctx             Canvas context (main thread or worker)
 * @param segments        Content segments (ContentSegment or WorkerContentSegment)
 * @param startX          Starting X position
 * @param y               Y position (top of text)
 * @param color           Text color
 * @param fontSize        Font size in px
 * @param outlineWidthPx  Outline width in pixels
 * @param outlineOpacity  Outline opacity (0-1)
 * @param textBitmapCache Text bitmap cache (Map or ByteLimitedCache)
 * @param emojiCache      Emoji image cache (stores CanvasImageSource)
 * @param getFontFn       Function to resolve font string from fontSize
 * @param measureTextFn   Function to measure single-line text width (cached in worker, measureTextWidth in main)
 * @param getEmojiImg     Function to retrieve a ready emoji image from cache by URL (returns null if not ready)
 */
function renderContentSegments(
  ctx: AnyCanvasContext,
  segments: readonly SharedContentSegment[],
  startX: number,
  y: number,
  color: string,
  fontSize: number,
  outlineWidthPx: number,
  outlineOpacity: number,
  textBitmapCache: TextBitmapCache,
  getFontFn: (fontSize: number) => string,
  measureTextFn: (text: string) => number,
  getEmojiImg: (url: string) => CanvasImageSource | null,
  letterSpacing = '0px'
): void {
  let cursorX = startX;
  const emojiSize = Math.round(fontSize * rendererLayout.emojiSize);
  const font = getFontFn(fontSize);
  const textHeight = measureTextHeight(font, fontSize);
  const emojiY = y + Math.round((textHeight - emojiSize) / 2);

  for (const seg of segments) {
    if (seg.type === 'text' && seg.content) {
      renderSegment(
        ctx,
        seg.content,
        cursorX,
        y,
        color,
        fontSize,
        outlineWidthPx,
        outlineOpacity,
        textBitmapCache,
        getFontFn,
        letterSpacing
      );
      cursorX += measureTextFn(seg.content);
    } else {
      const { emojiUrl, emojiAlt, emojiFallbackText } = resolveEmojiFields(seg);
      const img = emojiUrl ? getEmojiImg(emojiUrl) : null;
      if (img) {
        ctx.drawImage(img, cursorX, emojiY, emojiSize, emojiSize);
      } else if (emojiFallbackText) {
        renderSegment(
          ctx,
          emojiFallbackText,
          cursorX,
          y,
          color,
          fontSize,
          outlineWidthPx,
          outlineOpacity,
          textBitmapCache,
          getFontFn
        );
      } else if (emojiAlt && !EMOJI_ALIAS_PATTERN.test(emojiAlt)) {
        renderSegment(
          ctx,
          emojiAlt,
          cursorX,
          y,
          color,
          fontSize,
          outlineWidthPx,
          outlineOpacity,
          textBitmapCache,
          getFontFn
        );
      }
      cursorX += emojiSize + spacing.xs;
    }
  }
}

// ── Author rendering ────────────────────────────────────────────────────────

/** Cache author photos pre-composited with drop shadows so that per-frame
 *  `ctx.shadowBlur` (expensive GPU blur pass, may fall back to software
 *  rasterization) is only paid once per unique photo.  Keyed by the photo
 *  object itself so cleanup is automatic when the image is evicted from
 *  the caller's ByteLimitedCache. */
const _photoShadowCache = new WeakMap<object, OffscreenCanvas>();

/** Pad around the photo for shadow overflow (blur=4 + offset=1 ≈ 5px). */
const AUTHOR_PHOTO_SHADOW_PAD = 5;

/** Total canvas size for the shadow-precomposed photo. */
const AUTHOR_PHOTO_CANVAS_SIZE = rendererLayout.authorPhotoSize + AUTHOR_PHOTO_SHADOW_PAD * 2;

/** Draw an author photo with drop-shadow — first frame renders to offscreen
 *  canvas and caches; subsequent frames draw from cache (no shadowBlur). */
function drawAuthorPhoto(
  ctx: AnyCanvasContext,
  photo: CanvasImageSource,
  x: number,
  y: number
): void {
  const dpr = ctx.getTransform().a || 1;
  const photoSize = rendererLayout.authorPhotoSize;
  const totalSize = AUTHOR_PHOTO_CANVAS_SIZE;

  // Try the pre-composited cache first — avoids per-frame shadowBlur
  const cached = _photoShadowCache.get(photo);
  if (cached) {
    ctx.drawImage(
      cached,
      x - AUTHOR_PHOTO_SHADOW_PAD,
      y - AUTHOR_PHOTO_SHADOW_PAD,
      totalSize,
      totalSize
    );
    return;
  }

  // First encounter — render to offscreen with shadow, cache, then draw
  const offscreen = new OffscreenCanvas(Math.ceil(totalSize * dpr), Math.ceil(totalSize * dpr));
  const octx = offscreen.getContext('2d');
  if (!octx) {
    // Fallback: direct shadowBlur on main context (should never happen)
    ctx.save();
    ctx.shadowColor = AUTHOR_PHOTO_SHADOW;
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.drawImage(photo, x, y, photoSize, photoSize);
    ctx.restore();
    return;
  }
  octx.scale(dpr, dpr);
  octx.shadowColor = AUTHOR_PHOTO_SHADOW;
  octx.shadowBlur = 4;
  octx.shadowOffsetX = 1;
  octx.shadowOffsetY = 1;
  octx.drawImage(photo, AUTHOR_PHOTO_SHADOW_PAD, AUTHOR_PHOTO_SHADOW_PAD, photoSize, photoSize);

  _photoShadowCache.set(photo, offscreen);

  // Draw the freshly created cached version
  ctx.drawImage(
    offscreen,
    x - AUTHOR_PHOTO_SHADOW_PAD,
    y - AUTHOR_PHOTO_SHADOW_PAD,
    totalSize,
    totalSize
  );
}

/**
 * Runtime type guard for CanvasImageSource.
 * Checks the properties that all CanvasImageSource implementations have
 * (HTMLImageElement, HTMLCanvasElement, ImageBitmap, etc).
 */
function isCanvasImageSource(value: unknown): value is CanvasImageSource {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    (typeof obj.width === 'number' || typeof obj.naturalWidth === 'number') &&
    (typeof obj.height === 'number' || typeof obj.naturalHeight === 'number')
  );
}

/**
 * Draw author photo + name section. Returns the Y offset after the section.
 *
 * This is the SSOT for author rendering — used by both main-thread renderers
 * (canvas-rendering-shared.ts, canvas-card-renderers.ts) and the Web Worker
 * (renderer-worker.ts).
 *
 * @param ctx          Any canvas context (CanvasRenderingContext2D or OffscreenCanvasRenderingContext2D)
 * @param message      Minimal message with optional author name and photo URL
 * @param textX        X position for the section
 * @param startY       Starting Y position
 * @param color        Text color for the author name
 * @param maxNameWidth Max allowed width for the author name (undefined = no truncation)
 * @param authorFontSize Font size for the author name in px
 * @param fontWeight   Font weight ('normal' | 'bold')
 * @param fontFamily   CSS font-family stack
 * @param outlineWidthPx Outline width in pixels (0 = no outline)
 * @param outlineOpacity Outline opacity (0-1)
 * @param getPhoto     Callback to retrieve a cached photo by URL (returns T or undefined/null)
 * @param isValidPhoto Callback to check if a cached photo is valid and ready to draw
 * @param textBitmapCache Text bitmap cache for outline rendering
 * @param getFontFn    Function to resolve a CSS font string from fontSize
 * @returns The Y position after the section (for chaining)
 */
export function drawAuthorSection<T>(
  ctx: AnyCanvasContext,
  message: { author?: string; authorPhotoUrl?: string },
  textX: number,
  startY: number,
  color: string,
  maxNameWidth: number | undefined,
  authorFontSize: number,
  fontWeight: string,
  fontFamily: string,
  outlineWidthPx: number,
  outlineOpacity: number,
  getPhoto: (url: string) => T | undefined | null,
  isValidPhoto: (photo: T) => boolean,
  textBitmapCache: TextBitmapCache,
  getFontFn: (fontSize: number) => string
): number {
  if (!message.author) return startY;

  const prevFont = ctx.font;
  const prevTextBaseline = ctx.textBaseline;

  const nameFont = getFontString(authorFontSize, fontWeight as FontWeight, fontFamily);
  ctx.font = nameFont;
  // Measure text height directly from the context (compatible with both
  // CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D).
  const nameMetrics = ctx.measureText('Mg');
  const ascent = Math.max(0, nameMetrics.actualBoundingBoxAscent);
  const descent = Math.max(0, nameMetrics.actualBoundingBoxDescent);
  const nameHeight = Math.ceil(ascent + descent);
  const sectionHeight = Math.max(rendererLayout.authorPhotoSize, nameHeight);

  // Author photo (if available and valid)
  const authorPhotoUrl = message.authorPhotoUrl;
  let hasPhoto = false;
  if (authorPhotoUrl) {
    const photo = getPhoto(authorPhotoUrl);
    if (photo != null && isValidPhoto(photo) && isCanvasImageSource(photo)) {
      drawAuthorPhoto(ctx, photo as CanvasImageSource, textX, startY);
      hasPhoto = true;
    }
  }
  const nameX = textX + (hasPhoto ? rendererLayout.authorPhotoSize + spacing.xs : 0);
  const nameY = startY + Math.max(0, Math.floor((sectionHeight - nameHeight) / 2));

  // Truncate author name with ellipsis if it exceeds the allowed width
  let displayName = message.author;
  if (maxNameWidth !== undefined && maxNameWidth > 0) {
    ctx.font = nameFont;
    ctx.textBaseline = 'top';
    const nameWidth = ctx.measureText(displayName).width;
    if (nameWidth > maxNameWidth) {
      const ellipsis = '\u2026';
      const ellipsisWidth = ctx.measureText(ellipsis).width;
      // Guard: if the ellipsis character alone exceeds maxNameWidth
      // (extremely narrow container), skip rendering the name entirely.
      if (ellipsisWidth >= maxNameWidth) {
        ctx.font = prevFont;
        ctx.textBaseline = prevTextBaseline;
        return startY + sectionHeight;
      }
      // Binary search for optimal grapheme-cluster-safe truncation point.
      // Uses grapheme clusters (via existing splitGraphemeClusters) so that
      // surrogate pairs and ZWJ sequences in emoji author names are never
      // split mid-glyph by a raw String.slice().
      const graphemes = splitGraphemeClusters(displayName);
      let lo = 0;
      let hi = graphemes.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const testText = graphemes.slice(0, mid).join('') + ellipsis;
        const testWidth = ctx.measureText(testText).width;
        if (testWidth <= maxNameWidth) lo = mid + 1;
        else hi = mid;
      }
      displayName = graphemes.slice(0, Math.max(0, lo - 1)).join('') + ellipsis;
    }
  }

  renderSegment(
    ctx,
    displayName,
    nameX,
    nameY,
    color,
    authorFontSize,
    outlineWidthPx,
    outlineOpacity,
    textBitmapCache,
    getFontFn
  );

  ctx.font = prevFont;
  ctx.textBaseline = prevTextBaseline;

  return startY + sectionHeight;
}

// ── Regular message rendering (shared between main-thread and worker) ────────

/** Minimal message shape consumed by renderRegularMessage. */
export interface RegularMessageLike {
  author?: string;
  authorPhotoUrl?: string;
  content: readonly unknown[];
  text: string;
}

/** Font, outline, and display config derived from settings. */
export interface RegularMessageRenderConfig {
  showAuthor: boolean;
  fontSize: number;
  fontWeight: string;
  fontFamily: string;
  color: string;
  outlineWidthPx: number;
  outlineOpacity: number;
}

/**
 * Render a regular text message at (x, y) with author section and content.
 *
 * Per-frame globalAlpha is set by the caller (opacity-batched outer loop).
 *
 * @param message      Message with author, content, text fields.
 * @param config       Font/outline/display settings derived from user config.
 * @param overrideText When provided (replace translation mode), renders this
 *                     text instead of the message content.
 */
export function renderRegularMessage(
  ctx: AnyCanvasContext,
  message: RegularMessageLike,
  x: number,
  y: number,
  config: RegularMessageRenderConfig,
  textBitmapCache: TextBitmapCache,
  getEmojiImage: (url: string) => unknown,
  isValidEmoji: (img: unknown) => boolean,
  authorPhotoCache: { get(url: string): unknown },
  isValidAuthorPhoto: (photo: unknown) => boolean,
  getFontFn: (fontSize: number) => string,
  measureTextFn: (text: string) => number,
  overrideText?: string | null,
  letterSpacing = '0px'
): void {
  const { showAuthor, fontSize, fontWeight, fontFamily, color, outlineWidthPx, outlineOpacity } =
    config;
  const textX = x + rendererLayout.paddingH;
  let textY = y;

  if (showAuthor && message.author) {
    const authorFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
    textY = drawAuthorSection(
      ctx,
      message,
      textX,
      textY,
      color,
      undefined,
      authorFontSize,
      fontWeight,
      fontFamily,
      outlineWidthPx,
      outlineOpacity,
      (url: string) => authorPhotoCache.get(url),
      isValidAuthorPhoto,
      textBitmapCache,
      getFontFn
    );
  }

  if (overrideText) {
    renderSegment(
      ctx,
      overrideText,
      textX,
      textY,
      color,
      fontSize,
      outlineWidthPx,
      outlineOpacity,
      textBitmapCache,
      getFontFn,
      letterSpacing
    );
  } else if (message.content.length > 0) {
    renderContentSegments(
      ctx,
      toSharedContentSegments(message.content),
      textX,
      textY,
      color,
      fontSize,
      outlineWidthPx,
      outlineOpacity,
      textBitmapCache,
      getFontFn,
      measureTextFn,
      (url: string) => {
        const img = getEmojiImage(url);
        return img != null && isValidEmoji(img) ? (img as CanvasImageSource) : null;
      },
      letterSpacing
    );
  } else if (message.text.length > 0) {
    renderSegment(
      ctx,
      message.text,
      textX,
      textY,
      color,
      fontSize,
      outlineWidthPx,
      outlineOpacity,
      textBitmapCache,
      getFontFn,
      letterSpacing
    );
  }
}

// ── Wrapped content segments (text + emoji) ────────────────────────────────

/**
 * Render ContentSegment[] with word-wrapping, respecting maxWidth and maxLines.
 *
 * Uses {@link buildWrappedLines} for line-breaking (SSOT shared with the
 * dimension estimator), then renders each line via renderSegment (text) or
 * emojiCache (emoji images).
 *
 * @returns The Y position after the last rendered line.
 */
export function renderWrappedContentSegments<
  TTextBitmapCache extends TextBitmapCache,
  TEmojiCache extends ByteLimitedCache<CanvasImageSource>,
>(
  ctx: AnyCanvasContext,
  segments: readonly SharedContentSegment[],
  x: number,
  y: number,
  maxWidth: number,
  maxLines: number,
  color: string,
  fontSize: number,
  outlineWidthPx: number,
  outlineOpacity: number,
  textBitmapCache: TTextBitmapCache,
  emojiCache: TEmojiCache,
  getFontFn: (fontSize: number) => string
): number {
  if (segments.length === 0) return y;

  const font = getFontFn(fontSize);
  const emojiSize = Math.round(fontSize * rendererLayout.emojiSize);
  const lineHeight = Math.ceil(measureTextHeight(font, fontSize));
  const spaceWidth = measureTextWidth(' ', font);
  const ellipsis = '\u2026';

  const { lines } = buildWrappedLines(segments, maxWidth, emojiSize, (t: string) =>
    measureTextWidth(t, font)
  );

  // ── Render lines (up to maxLines) ────────────────────────────────────
  const renderLines = lines.length > maxLines ? lines.slice(0, maxLines) : lines;
  const isTruncated = lines.length > maxLines;
  let cursorY = y;

  for (let li = 0; li < renderLines.length; li++) {
    const line = renderLines[li];
    if (!line) continue;
    const isLastLine = li === renderLines.length - 1;
    const needsEllipsis = isLastLine && isTruncated;
    let cursorX = x;
    let prevText = false;
    const emojiLineY = cursorY + Math.round((lineHeight - emojiSize) / 2);

    for (const piece of line) {
      if (prevText) {
        cursorX += spaceWidth;
      }
      prevText = piece.type === 'text';

      if (piece.type === 'text') {
        renderSegment(
          ctx,
          piece.text,
          cursorX,
          cursorY,
          color,
          fontSize,
          outlineWidthPx,
          outlineOpacity,
          textBitmapCache,
          getFontFn
        );
        cursorX += piece.width;
      } else {
        // Emoji — same rendering logic as renderContentSegments.
        // Dual type check: HTMLImageElement has naturalWidth, ImageBitmap has width.
        const cached = piece.emojiUrl ? emojiCache.get(piece.emojiUrl) : undefined;
        const img =
          cached != null &&
          (('naturalWidth' in cached && cached.naturalWidth > 0) ||
            ('width' in cached && (cached as { width: number }).width > 0))
            ? cached
            : null;
        if (img) {
          ctx.drawImage(img, cursorX, emojiLineY, emojiSize, emojiSize);
        } else if (piece.emojiFallbackText) {
          renderSegment(
            ctx,
            piece.emojiFallbackText,
            cursorX,
            cursorY,
            color,
            fontSize,
            outlineWidthPx,
            outlineOpacity,
            textBitmapCache,
            getFontFn
          );
        } else if (piece.emojiAlt && !EMOJI_ALIAS_PATTERN.test(piece.emojiAlt)) {
          renderSegment(
            ctx,
            piece.emojiAlt,
            cursorX,
            cursorY,
            color,
            fontSize,
            outlineWidthPx,
            outlineOpacity,
            textBitmapCache,
            getFontFn
          );
        }
        cursorX += piece.width;
      }
    }

    // Append ellipsis if this line was truncated
    if (needsEllipsis) {
      renderSegment(
        ctx,
        ellipsis,
        cursorX,
        cursorY,
        color,
        fontSize,
        outlineWidthPx,
        outlineOpacity,
        textBitmapCache,
        getFontFn
      );
    }

    cursorY += lineHeight;
  }

  return cursorY;
}
