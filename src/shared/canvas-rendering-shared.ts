// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Shared Canvas 2D rendering functions usable from both main thread
 * (CanvasRenderingContext2D) and Web Worker (OffscreenCanvasRenderingContext2D).
 *
 * Eliminates ~300+ lines of code duplication between canvas-text-renderer.ts
 * and renderer-worker.ts.
 */

import { EMOJI_ALIAS_PATTERN } from '@core/chat-message-helpers';
import { computeOutlineColor } from '@core/color-utils';
import { AUTHOR_PHOTO_SHADOW, rendererLayout, spacing } from '@core/design-tokens';
import { OUTLINE_STROKE_SCALE } from '@core/renderer-constants';

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
export function cacheTextBitmap(
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
export function renderContentSegments(
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
