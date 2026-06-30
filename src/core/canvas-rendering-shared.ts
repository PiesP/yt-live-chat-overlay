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
import type { ByteLimitedCache } from '@core/byte-limited-cache';
import { EMOJI_ALIAS_PATTERN } from '@core/chat-message-helpers';
import { computeOutlineColor } from '@core/color-utils';
import { AUTHOR_PHOTO_SHADOW, rendererLayout, spacing } from '@core/design-tokens';
import { OUTLINE_STROKE_SCALE } from '@core/renderer-constants';
import { getFontString, measureTextHeight, measureTextWidth } from '@core/text-measure';

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
export function toSharedContentSegment(seg: {
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
  width: number;
}

export type SharedRenderPiece = SharedTextPiece | SharedEmojiPiece;

// ── Character-level wrapping for oversize words (CJK, URLs, etc.) ──────────

/**
 * Split a word that exceeds maxWidth into character-level segments.
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

  for (const ch of word) {
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
      if (url) {
        pieces.push({
          type: 'emoji',
          emojiUrl: url,
          ...(alt ? { emojiAlt: alt } : {}),
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
    const gap = prevIsText && piece.type === 'text' ? spaceWidth : 0;
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
  ctx.strokeText(text, x, y);
  ctx.restore();
}

// ── Round rectangle ─────────────────────────────────────────────────────────

/** Draw a rounded rectangle path (no fill/stroke — path only). */
export function drawRoundRect(
  ctx: AnyCanvasContext,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
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
  textBitmapCache: TextBitmapCache
): void {
  if (!ctx) return;

  ctx.save();
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const bbWidth =
    Math.abs(metrics.actualBoundingBoxLeft) + Math.abs(metrics.actualBoundingBoxRight);
  const textWidth = bbWidth > 0 ? Math.ceil(bbWidth) : Math.ceil(metrics.width);
  const width = textWidth + Math.ceil(strokeWidth) + 2;
  const ascent = Math.abs(metrics.actualBoundingBoxAscent) || Math.ceil(fontSize * 0.8);
  const descent = Math.abs(metrics.actualBoundingBoxDescent) || Math.ceil(fontSize * 0.2);
  const height = ascent + descent + Math.ceil(strokeWidth) + 2;
  ctx.restore();

  const offscreen: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : (() => {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          return canvas;
        })();
  const offCtx = offscreen.getContext('2d');
  if (!offCtx) return;

  offCtx.font = font;
  offCtx.textBaseline = 'top';
  offCtx.textRendering = 'optimizeSpeed';
  offCtx.strokeStyle = strokeColor;
  offCtx.lineWidth = strokeWidth;
  offCtx.lineJoin = 'round';
  offCtx.lineCap = 'round';
  offCtx.strokeText(text, strokeWidth / 2 + 1, strokeWidth / 2 + 1);
  offCtx.fillStyle = fillColor;
  offCtx.fillText(text, strokeWidth / 2 + 1, strokeWidth / 2 + 1);

  textBitmapCache.set(key, offscreen);
}

// ── Segment rendering ───────────────────────────────────────────────────────

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
  getFontFn: (fontSize: number) => string
): void {
  const font = getFontFn(fontSize);
  const strokeWidth = Math.max(0.5, outlineWidthPx * OUTLINE_STROKE_SCALE);
  const strokeColor = computeOutlineColor(color, Math.min(1, outlineOpacity));

  // Try bitmap cache first (includes outline rendering)
  if (outlineWidthPx > 0 && outlineOpacity > 0 && text.length >= 3) {
    const key = `${font}|${text}|${color}|${Math.round(strokeWidth)}|${strokeColor}`;
    const bitmap = textBitmapCache.get(key);
    if (bitmap) {
      ctx.drawImage(bitmap, x, y);
      return;
    }

    // Cache miss — render to offscreen canvas and cache
    cacheTextBitmap(
      key,
      text,
      font,
      fontSize,
      color,
      strokeWidth,
      strokeColor,
      ctx,
      textBitmapCache
    );

    // Immediately use the freshly cached bitmap to avoid fallthrough overhead
    const freshBitmap = textBitmapCache.get(key);
    if (freshBitmap) {
      ctx.drawImage(freshBitmap, x, y);
      return;
    }
  }

  // Fallback: direct fillText + strokeText
  ctx.save();
  ctx.font = font;
  ctx.textBaseline = 'top';
  ctx.textRendering = 'optimizeSpeed';
  strokeTextOutline(ctx, text, x, y, color, outlineWidthPx, outlineOpacity);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
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
  getEmojiImg: (url: string) => CanvasImageSource | null
): void {
  let cursorX = startX;
  const emojiSize = Math.round(fontSize * rendererLayout.emojiSize);

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
        getFontFn
      );
      cursorX += measureTextFn(seg.content);
    } else {
      const { emojiUrl, emojiAlt, emojiFallbackText } = resolveEmojiFields(seg);
      const img = emojiUrl ? getEmojiImg(emojiUrl) : null;
      if (img) {
        ctx.drawImage(img, cursorX, y, emojiSize, emojiSize);
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

/** Draw an author photo with shadow effects. */
export function drawAuthorPhoto(
  ctx: AnyCanvasContext,
  photo: CanvasImageSource,
  x: number,
  y: number
): void {
  ctx.save();
  ctx.shadowColor = AUTHOR_PHOTO_SHADOW;
  ctx.shadowBlur = 4;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;
  ctx.drawImage(photo, x, y, rendererLayout.authorPhotoSize, rendererLayout.authorPhotoSize);
  ctx.restore();
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
      // Binary search for optimal truncation point (O(log n) instead of O(n))
      let lo = 0;
      let hi = displayName.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const testWidth = ctx.measureText(displayName.slice(0, mid) + ellipsis).width;
        if (testWidth <= maxNameWidth) lo = mid + 1;
        else hi = mid;
      }
      displayName = displayName.slice(0, Math.max(0, lo - 1)) + ellipsis;
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
  overrideText?: string | null
): void {
  const { showAuthor, fontSize, fontWeight, fontFamily, color, outlineWidthPx, outlineOpacity } =
    config;
  const textX = x + rendererLayout.paddingH;
  let textY = y + rendererLayout.paddingV;

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
      getFontFn
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
      }
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
      getFontFn
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

    for (const piece of line) {
      // Space gap between text words
      if (prevText && piece.type === 'text') {
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
        // Emoji — same rendering logic as renderContentSegments
        const cached = piece.emojiUrl ? emojiCache.get(piece.emojiUrl) : undefined;
        const img = cached && 'naturalWidth' in cached && cached.naturalWidth > 0 ? cached : null;
        if (img) {
          ctx.drawImage(img, cursorX, cursorY, emojiSize, emojiSize);
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
