// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * CanvasTextRenderer — extracted text-rendering utilities from CanvasRenderer.
 *
 * Module-level functions for rendering text segments, wrapped text, emoji,
 * cached bitmaps, and outline strokes on a Canvas2D context.
 */

import type { ChatMessage, ContentSegment, ImageAsset, OverlaySettings } from '@app-types';
import { EMOJI_ALIAS_PATTERN } from '@core/chat-message-helpers';
import { computeOutlineColor } from '@core/color-utils';
import { AUTHOR_PHOTO_SHADOW, rendererLayout, spacing } from '@core/design-tokens';
import { getFontString, measureTextHeight, measureTextWidth } from '@core/text-measure';

// ── Constants ────────────────────────────────────────────────────────────────

const TEXT_BITMAP_CACHE_MAX = 200;

/**
 * Outline stroke scale factor: outline.widthPx is multiplied by this
 * to produce the actual stroke width (matching the visual rendering
 * of bold text with an outline).
 */
const OUTLINE_STROKE_SCALE = 0.85;

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
  const strokeWidth = Math.max(0.5, outline.widthPx * OUTLINE_STROKE_SCALE);
  ctx.save();
  ctx.strokeStyle = computeOutlineColor(textColor, Math.min(1, outline.opacity));
  ctx.lineWidth = strokeWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeText(text, x, y);
  ctx.restore();
}

// ── Segment rendering ───────────────────────────────────────────────────────

function renderSegment(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  fontSize: number,
  settings: OverlaySettings,
  textBitmapCache: Map<string, HTMLCanvasElement>,
  getFontFn: (fontSize: number) => string
): void {
  const outline = settings.outline;
  const font = getFontFn(fontSize);
  const strokeWidth = Math.max(0.5, outline.widthPx * OUTLINE_STROKE_SCALE);
  const strokeColor = computeOutlineColor(color, Math.min(1, outline.opacity));

  // Try bitmap cache first (includes outline rendering)
  if (outline.enabled && outline.widthPx > 0 && outline.opacity > 0) {
    const key = `${font}|${text}|${color}|${Math.round(strokeWidth)}|${strokeColor}`;
    const bitmap = textBitmapCache.get(key);
    if (bitmap) {
      ctx.drawImage(bitmap, x, y);
      return;
    }

    // Cache miss — render to offscreen canvas and cache
    // LRU touch: delete existing key before re-inserting to move it to Map end
    if (textBitmapCache.has(key)) textBitmapCache.delete(key);
    cacheTextBitmap(key, text, font, color, strokeWidth, strokeColor, ctx, textBitmapCache);

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
  strokeTextOutline(ctx, text, x, y, color, settings);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

// ── Content segments (text + emoji) — single-line ────────────────────────────

function renderContentSegments(
  ctx: CanvasRenderingContext2D,
  segments: readonly ContentSegment[],
  startX: number,
  y: number,
  color: string,
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
        // LRU touch: re-insert to move key to end of Map
        emojiCache.delete(seg.emoji.url);
        emojiCache.set(seg.emoji.url, img);
        ctx.drawImage(img, cursorX, y, emojiSize, emojiSize);
      } else if (seg.emoji.fallbackText) {
        renderSegment(
          ctx,
          seg.emoji.fallbackText,
          cursorX,
          y,
          color,
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
          fontSize,
          settings,
          textBitmapCache,
          getFontFn
        );
      }
      cursorX += emojiSize + spacing.xs;
    }
  }
}

// ── Wrapped content segments (text + emoji) ────────────────────────────────

/**
 * Internal piece type for word-wrapping content segments.
 * Each piece is either a word from a text segment or a single emoji.
 */
export type WrappedRenderPiece = TextRenderPiece | EmojiRenderPiece;

export interface TextRenderPiece {
  type: 'text';
  text: string;
  width: number;
}

export interface EmojiRenderPiece {
  type: 'emoji';
  emoji: ImageAsset;
  width: number;
}

/**
 * Build wrapped lines from ContentSegment[] using the same greedy line-fill
 * algorithm as renderWrappedContentSegments, but without any rendering.
 *
 * This is the SSOT for line-breaking logic — used by both the renderer
 * (to produce lines for rendering) and the dimension estimator
 * (to predict line count and max width without a canvas).
 *
 * @returns Built lines and the maximum line width across all lines.
 */
export function buildWrappedLines(
  segments: readonly ContentSegment[],
  font: string,
  maxWidth: number,
  emojiSize: number
): { lines: WrappedRenderPiece[][]; maxLineWidth: number } {
  // ── Step 1: Flatten segments into word/emoji pieces ──────────────────
  const pieces: WrappedRenderPiece[] = [];
  for (const seg of segments) {
    if (seg.type === 'text') {
      const words = seg.content.split(/\s+/).filter((w) => w.length > 0);
      for (const word of words) {
        pieces.push({ type: 'text', text: word, width: measureTextWidth(word, font) });
      }
    } else {
      pieces.push({ type: 'emoji', emoji: seg.emoji, width: emojiSize + spacing.xs });
    }
  }

  const lines: WrappedRenderPiece[][] = [];
  if (pieces.length === 0) return { lines, maxLineWidth: 0 };

  // ── Step 2: Greedy line-filling (same algorithm as wrapLine) ─────────
  let currentLine: WrappedRenderPiece[] = [];
  let currentWidth = 0;
  let prevIsText = false;
  const spaceWidth = measureTextWidth(' ', font);
  let maxLineWidth = 0;

  for (const piece of pieces) {
    const gap = prevIsText && piece.type === 'text' ? spaceWidth : 0;
    const needed = gap + piece.width;

    // ── Oversize single word — character-level wrap (CJK, URLs, etc.) ──
    // Must be checked BEFORE the line-overflow guard so that the first
    // piece on an empty line (currentLine.length === 0) is also handled.
    if (piece.type === 'text' && piece.width > maxWidth) {
      // Flush current line if non-empty (same as normal overflow)
      if (currentLine.length > 0) {
        maxLineWidth = Math.max(maxLineWidth, currentWidth);
        lines.push(currentLine);
      }
      const charPieces = wrapCharPieces(piece.text, font, maxWidth);
      if (charPieces.length <= 1) {
        currentLine = [piece];
        currentWidth = piece.width;
        prevIsText = true;
        continue;
      }
      // Push all but the last char piece as their own lines
      for (let i = 0; i < charPieces.length - 1; i++) {
        const cp = charPieces[i] as TextRenderPiece;
        lines.push([cp]);
        maxLineWidth = Math.max(maxLineWidth, cp.width);
      }
      const lastPiece = charPieces[charPieces.length - 1] as TextRenderPiece;
      currentLine = [lastPiece];
      currentWidth = lastPiece.width;
      prevIsText = true;
      continue;
    }

    // ── Normal line overflow (non-oversize piece) ──────────────────────
    if (currentLine.length > 0 && currentWidth + needed > maxWidth) {
      // Start a new line with this piece
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

/**
 * Render ContentSegment[] with word-wrapping, respecting maxWidth and maxLines.
 *
 * Uses {@link buildWrappedLines} for line-breaking (SSOT shared with the
 * dimension estimator), then renders each line via renderSegment (text) or
 * emojiCache (emoji images).
 *
 * @returns The Y position after the last rendered line.
 */
export function renderWrappedContentSegments(
  ctx: CanvasRenderingContext2D,
  segments: readonly ContentSegment[],
  x: number,
  y: number,
  maxWidth: number,
  maxLines: number,
  color: string,
  fontSize: number,
  settings: OverlaySettings,
  textBitmapCache: Map<string, HTMLCanvasElement>,
  emojiCache: Map<string, HTMLImageElement>,
  getFontFn: (fontSize: number) => string
): number {
  if (segments.length === 0) return y;

  const font = getFontFn(fontSize);
  const emojiSize = Math.round(fontSize * rendererLayout.emojiSize);
  const lineHeight = Math.ceil(measureTextHeight(font, fontSize));
  const spaceWidth = measureTextWidth(' ', font);
  const ellipsis = '\u2026';

  const { lines } = buildWrappedLines(segments, font, maxWidth, emojiSize);

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
          settings,
          textBitmapCache,
          getFontFn
        );
        cursorX += piece.width;
      } else {
        // Emoji — same rendering logic as renderContentSegments
        const cached = emojiCache.get(piece.emoji.url);
        const img = cached?.complete && cached.naturalWidth > 0 ? cached : null;
        if (img) {
          // LRU touch: re-insert to move key to end of Map
          emojiCache.delete(piece.emoji.url);
          emojiCache.set(piece.emoji.url, img);
          ctx.drawImage(img, cursorX, cursorY, emojiSize, emojiSize);
        } else if (piece.emoji.fallbackText) {
          renderSegment(
            ctx,
            piece.emoji.fallbackText,
            cursorX,
            cursorY,
            color,
            fontSize,
            settings,
            textBitmapCache,
            getFontFn
          );
        } else if (piece.emoji.alt && !EMOJI_ALIAS_PATTERN.test(piece.emoji.alt)) {
          renderSegment(
            ctx,
            piece.emoji.alt,
            cursorX,
            cursorY,
            color,
            fontSize,
            settings,
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
        settings,
        textBitmapCache,
        getFontFn
      );
    }

    cursorY += lineHeight;
  }

  return cursorY;
}

/**
 * Split a single word into character-level pieces that each fit within maxWidth.
 * Matches the char-wrapping behavior of wrapChars() in text-measure.ts.
 */
function wrapCharPieces(word: string, font: string, maxWidth: number): TextRenderPiece[] {
  const pieces: TextRenderPiece[] = [];
  let current = '';
  let currentWidth = 0;

  for (const ch of word) {
    const chWidth = measureTextWidth(ch, font);
    if (currentWidth + chWidth > maxWidth && current.length > 0) {
      pieces.push({ type: 'text', text: current, width: currentWidth });
      current = ch;
      currentWidth = chWidth;
    } else {
      current += ch;
      currentWidth += chWidth;
    }
  }

  if (current.length > 0) {
    pieces.push({ type: 'text', text: current, width: currentWidth });
  }

  return pieces;
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
  ctx.shadowColor = AUTHOR_PHOTO_SHADOW;
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
  authorPhotoCache: Map<string, HTMLImageElement>,
  textBitmapCache: Map<string, HTMLCanvasElement>,
  getFontFn: (fontSize: number) => string
): number {
  if (!message.author) return startY;

  const prevFont = ctx.font;
  const prevTextBaseline = ctx.textBaseline;

  const fontSize = settings.fontSize;
  const authorFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
  const nameFont = getFontString(authorFontSize, settings.fontWeight, settings.fontFamily);
  const nameHeight = measureTextHeight(nameFont, authorFontSize);
  const sectionHeight = Math.max(rendererLayout.authorPhotoSize, nameHeight);

  const authorPhotoUrl = message.authorPhotoUrl;
  const photo = authorPhotoUrl ? authorPhotoCache.get(authorPhotoUrl) : undefined;
  if (photo?.complete && photo.naturalWidth > 0 && authorPhotoUrl) {
    // LRU touch: re-insert to move key to end of Map
    authorPhotoCache.delete(authorPhotoUrl);
    authorPhotoCache.set(authorPhotoUrl, photo);
    drawAuthorPhoto(ctx, photo, textX, startY);
  }
  const nameX = textX + (photo ? rendererLayout.authorPhotoSize + spacing.xs : 0);
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

  // Use renderSegment with bitmap cache instead of direct fillText+strokeText
  renderSegment(
    ctx,
    displayName,
    nameX,
    nameY,
    color,
    authorFontSize,
    settings,
    textBitmapCache,
    getFontFn
  );

  ctx.font = prevFont;
  ctx.textBaseline = prevTextBaseline;

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

/** Render a regular text message at (x, y) with alpha blending.
 *
 * @param overrideText — when provided (replace translation mode), renders this
 *   text instead of the message's content/text. Author section is still rendered. */
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
  getFontFn: (fontSize: number) => string,
  overrideText?: string | null
): void {
  const fontSize = settings.fontSize;
  const color =
    settings.preserveUserColor && message.userColor
      ? message.userColor
      : settings.colors[message.authorType];

  const prevAlpha = ctx.globalAlpha;
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
      authorPhotoCache,
      textBitmapCache,
      getFontFn
    );
  }

  // In replace translation mode, render the translated text instead of the original.
  if (overrideText) {
    renderSegment(
      ctx,
      overrideText,
      textX,
      textY,
      color,
      fontSize,
      settings,
      textBitmapCache,
      getFontFn
    );
  } else if (message.content.length > 0) {
    renderContentSegments(
      ctx,
      message.content,
      textX,
      textY,
      color,
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
      fontSize,
      settings,
      textBitmapCache,
      getFontFn
    );
  }

  ctx.globalAlpha = prevAlpha;
}
