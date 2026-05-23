/**
 * CanvasTextRenderer — extracted text-rendering utilities from CanvasRenderer.
 *
 * Module-level functions for rendering text segments, wrapped text, emoji,
 * cached bitmaps, and outline strokes on a Canvas2D context.
 */

import type { ChatMessage, ContentSegment, OverlaySettings } from '@app-types';
import { EMOJI_ALIAS_PATTERN } from '@core/chat-message-helpers';
import { computeOutlineColor, rendererLayout } from '@core/design-tokens';
import {
  getFontString,
  measureTextHeight,
  measureTextWidth,
  wrapTextLines,
} from '@core/text-measure';

// ── Constants ────────────────────────────────────────────────────────────────

const TEXT_BITMAP_CACHE_MAX = 200;

// ── Text bitmap cache ──────────────────────────────────────────────────────

/**
 * Render text with outline to an offscreen canvas and store in bitmap cache.
 */
function cacheTextBitmap(
  key: string,
  text: string,
  font: string,
  fillColor: string,
  strokeWidth: number,
  strokeColor: string,
  ctx: CanvasRenderingContext2D,
  textBitmapCache: Map<string, HTMLCanvasElement>
): void {
  if (!ctx) return;

  ctx.save();
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const bbWidth =
    Math.abs(metrics.actualBoundingBoxLeft) + Math.abs(metrics.actualBoundingBoxRight);
  const textWidth = bbWidth > 0 ? Math.ceil(bbWidth) : Math.ceil(metrics.width);
  const width = textWidth + Math.ceil(strokeWidth) + 2;
  const mgMetrics = ctx.measureText('Mg');
  const ascent = mgMetrics.actualBoundingBoxAscent ?? mgMetrics.fontBoundingBoxAscent ?? 0;
  const descent = mgMetrics.actualBoundingBoxDescent ?? mgMetrics.fontBoundingBoxDescent ?? 0;
  const height = Math.ceil(ascent) + Math.ceil(descent) + Math.ceil(strokeWidth) + 2;
  ctx.restore();

  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
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

  if (textBitmapCache.size > TEXT_BITMAP_CACHE_MAX) {
    const oldestKey = textBitmapCache.keys().next().value;
    if (oldestKey !== undefined) textBitmapCache.delete(oldestKey);
  }
}

// ── Outline stroke ──────────────────────────────────────────────────────────

/** Draw crisp auto-contrast outline on text using current font and textBaseline. */
export function strokeTextOutline(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  textColor: string,
  settings: OverlaySettings
): void {
  const outline = settings.outline;
  if (!outline.enabled || outline.widthPx <= 0 || outline.opacity <= 0) return;
  const strokeWidth = Math.max(0.5, outline.widthPx * 0.85);
  ctx.save();
  ctx.strokeStyle = computeOutlineColor(textColor, Math.min(1, outline.opacity));
  ctx.lineWidth = strokeWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeText(text, x, y);
  ctx.restore();
}

// ── Segment rendering ───────────────────────────────────────────────────────

export function renderSegment(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  alpha: number,
  fontSize: number,
  settings: OverlaySettings,
  textBitmapCache: Map<string, HTMLCanvasElement>,
  getFontFn: (fontSize: number) => string
): void {
  const outline = settings.outline;
  const font = getFontFn(fontSize);
  const strokeWidth = Math.max(0.5, outline.widthPx * 0.85);
  const strokeColor = computeOutlineColor(color, Math.min(1, outline.opacity));

  // Try bitmap cache first (includes outline rendering)
  if (outline.enabled && outline.widthPx > 0 && outline.opacity > 0) {
    const key = `${font}|${text}|${color}|${strokeWidth.toFixed(1)}|${strokeColor}`;
    const bitmap = textBitmapCache.get(key);
    if (bitmap) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(bitmap, x, y);
      ctx.restore();
      return;
    }

    // Cache miss — render to offscreen canvas and cache
    cacheTextBitmap(key, text, font, color, strokeWidth, strokeColor, ctx, textBitmapCache);
  }

  // Fallback: direct fillText + strokeText
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = font;
  ctx.textBaseline = 'top';
  strokeTextOutline(ctx, text, x, y, color, settings);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

// ── Content segments (text + emoji) ─────────────────────────────────────────

export function renderContentSegments(
  ctx: CanvasRenderingContext2D,
  segments: readonly ContentSegment[],
  startX: number,
  y: number,
  color: string,
  alpha: number,
  fontSize: number,
  settings: OverlaySettings,
  textBitmapCache: Map<string, HTMLCanvasElement>,
  emojiCache: Map<string, HTMLImageElement>,
  getFontFn: (fontSize: number) => string
): void {
  let cursorX = startX;
  const emojiSize = Math.round(fontSize * rendererLayout.emojiSize);

  for (const seg of segments) {
    if (seg.type === 'text') {
      renderSegment(
        ctx,
        seg.content,
        cursorX,
        y,
        color,
        alpha,
        fontSize,
        settings,
        textBitmapCache,
        getFontFn
      );
      cursorX += measureTextWidth(seg.content, getFontFn(fontSize));
    } else {
      const cached = emojiCache.get(seg.emoji.url);
      const img = cached?.complete && cached.naturalWidth > 0 ? cached : null;
      if (img) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.drawImage(img, cursorX, y, emojiSize, emojiSize);
        ctx.restore();
      } else if (seg.emoji.fallbackText) {
        renderSegment(
          ctx,
          seg.emoji.fallbackText,
          cursorX,
          y,
          color,
          alpha,
          fontSize,
          settings,
          textBitmapCache,
          getFontFn
        );
      } else if (seg.emoji.alt && !EMOJI_ALIAS_PATTERN.test(seg.emoji.alt)) {
        renderSegment(
          ctx,
          seg.emoji.alt,
          cursorX,
          y,
          color,
          alpha,
          fontSize,
          settings,
          textBitmapCache,
          getFontFn
        );
      }
      cursorX += emojiSize + 4;
    }
  }
}

// ── Wrapped text rendering ──────────────────────────────────────────────────

/**
 * Render text with word-wrapping, respecting `maxWidth` and `maxLines`.
 *
 * Uses the same `wrapTextLines()` algorithm as the dimension estimator so
 * rendered output always matches the predicted layout.
 *
 * @returns The Y position after the last rendered line.
 */
export function renderWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  maxLines: number,
  color: string,
  alpha: number,
  fontSize: number,
  settings: OverlaySettings,
  textBitmapCache: Map<string, HTMLCanvasElement>,
  getFontFn: (fontSize: number) => string
): number {
  const font = getFontFn(fontSize);
  const allLines = wrapTextLines(text, font, maxWidth);
  const lineHeight = Math.ceil(measureTextHeight(font, fontSize));
  const lines = allLines.length > maxLines ? allLines.slice(0, maxLines) : allLines;

  let cursorY = y;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const isLastLine = i === lines.length - 1;
    const isTruncated = isLastLine && allLines.length > maxLines;

    const renderText = isTruncated ? `${line}\u2026` : line;
    renderSegment(
      ctx,
      renderText,
      x,
      cursorY,
      color,
      alpha,
      fontSize,
      settings,
      textBitmapCache,
      getFontFn
    );
    cursorY += lineHeight;
  }

  return cursorY;
}

// ── Author rendering ────────────────────────────────────────────────────────

/** Draw an author photo with shadow effects. */
function drawAuthorPhoto(
  ctx: CanvasRenderingContext2D,
  photo: HTMLImageElement,
  x: number,
  y: number
): void {
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;
  ctx.drawImage(photo, x, y, rendererLayout.authorPhotoSize, rendererLayout.authorPhotoSize);
  ctx.restore();
}

/** Draw author photo + name section. Returns the Y offset after the section. */
export function drawAuthorSection(
  ctx: CanvasRenderingContext2D,
  message: ChatMessage,
  textX: number,
  startY: number,
  color: string,
  maxNameWidth: number | undefined,
  settings: OverlaySettings,
  authorPhotoCache: Map<string, HTMLImageElement>
): number {
  if (!message.author) return startY;

  const fontSize = settings.fontSize;
  const authorFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
  const nameFont = getFontString(authorFontSize, settings.fontWeight, settings.fontFamily);
  const nameHeight = measureTextHeight(nameFont, authorFontSize);
  const sectionHeight = Math.max(rendererLayout.authorPhotoSize, nameHeight);

  const photo = message.authorPhotoUrl ? authorPhotoCache.get(message.authorPhotoUrl) : undefined;
  if (photo?.complete && photo.naturalWidth > 0) {
    drawAuthorPhoto(ctx, photo, textX, startY);
  }
  const nameX = textX + (photo ? rendererLayout.authorPhotoSize + 4 : 0);
  const nameY = startY + Math.max(0, Math.floor((sectionHeight - nameHeight) / 2));

  // Truncate author name with ellipsis if it exceeds the allowed width
  let displayName = message.author;
  if (maxNameWidth !== undefined && maxNameWidth > 0) {
    ctx.font = nameFont;
    ctx.textBaseline = 'top';
    let nameWidth = ctx.measureText(displayName).width;
    if (nameWidth > maxNameWidth) {
      const ellipsis = '\u2026';
      const ellipsisWidth = ctx.measureText(ellipsis).width;
      while (displayName.length > 0 && nameWidth + ellipsisWidth > maxNameWidth) {
        displayName = displayName.slice(0, -1);
        nameWidth = ctx.measureText(displayName).width;
      }
      displayName += ellipsis;
    }
  }

  ctx.font = nameFont;
  ctx.textBaseline = 'top';
  strokeTextOutline(ctx, displayName, nameX, nameY, color, settings);
  ctx.fillStyle = color;
  ctx.fillText(displayName, nameX, nameY);
  return startY + sectionHeight;
}

/** Draw a rounded rectangle path (no fill/stroke — path only). */
export function drawRoundRect(
  ctx: CanvasRenderingContext2D,
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

// ── Message card rendering ───────────────────────────────────────────────

/** Render a regular text message at (x, y) with alpha blending. */
export function renderRegularMessage(
  ctx: CanvasRenderingContext2D,
  message: ChatMessage,
  x: number,
  y: number,
  alpha: number,
  settings: OverlaySettings,
  textBitmapCache: Map<string, HTMLCanvasElement>,
  emojiCache: Map<string, HTMLImageElement>,
  authorPhotoCache: Map<string, HTMLImageElement>,
  getFontFn: (fontSize: number) => string
): void {
  const fontSize = settings.fontSize;
  const color =
    settings.preserveUserColor && message.userColor
      ? message.userColor
      : settings.colors[message.authorType];

  ctx.save();
  ctx.globalAlpha = alpha;

  const showAuthor = settings.showAuthor[message.authorType];
  const textX = x + rendererLayout.paddingH;
  let textY = y + rendererLayout.paddingV;
  if (showAuthor && message.author) {
    textY = drawAuthorSection(
      ctx,
      message,
      textX,
      textY,
      color,
      undefined,
      settings,
      authorPhotoCache
    );
  }

  if (message.content.length > 0) {
    renderContentSegments(
      ctx,
      message.content,
      textX,
      textY,
      color,
      1,
      fontSize,
      settings,
      textBitmapCache,
      emojiCache,
      getFontFn
    );
  } else if (message.text.length > 0) {
    renderSegment(
      ctx,
      message.text,
      textX,
      textY,
      color,
      1,
      fontSize,
      settings,
      textBitmapCache,
      getFontFn
    );
  }

  ctx.restore();
}
