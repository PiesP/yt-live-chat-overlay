// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * CanvasTextRenderer — extracted text-rendering utilities from CanvasRenderer.
 *
 * Module-level functions for rendering text segments, wrapped text, emoji,
 * cached bitmaps, and outline strokes on a Canvas2D context.
 */

import type { ChatMessage, ContentSegment, OverlaySettings } from '@app-types';
import type { ByteLimitedCache } from '@core/byte-limited-cache';
import { EMOJI_ALIAS_PATTERN } from '@core/chat-message-helpers';
import { rendererLayout } from '@core/design-tokens';
import { measureTextHeight, measureTextWidth } from '@core/text-measure';
import {
  buildWrappedLines,
  drawAuthorSection,
  renderContentSegments,
  renderSegment,
  type SharedContentSegment,
} from '@shared/canvas-rendering-shared';

// ── Re-export shared rendering functions so external consumers
//    (canvas-card-renderers.ts, renderer-canvas.ts) can still
//    import them from '@core/canvas-text-renderer'.
export {
  drawAuthorSection,
  drawRoundRect,
  strokeTextOutline,
} from '@shared/canvas-rendering-shared';

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
  textBitmapCache: ByteLimitedCache<HTMLCanvasElement>,
  emojiCache: ByteLimitedCache<HTMLImageElement>,
  getFontFn: (fontSize: number) => string
): number {
  if (segments.length === 0) return y;

  const font = getFontFn(fontSize);
  const emojiSize = Math.round(fontSize * rendererLayout.emojiSize);
  const lineHeight = Math.ceil(measureTextHeight(font, fontSize));
  const spaceWidth = measureTextWidth(' ', font);
  const ellipsis = '\u2026';

  const { lines } = buildWrappedLines(
    segments as readonly SharedContentSegment[],
    maxWidth,
    emojiSize,
    (t: string) => measureTextWidth(t, font)
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
          settings.outline.widthPx,
          settings.outline.opacity,
          textBitmapCache,
          getFontFn
        );
        cursorX += piece.width;
      } else {
        // Emoji — same rendering logic as renderContentSegments
        const cached = emojiCache.get(piece.emojiUrl);
        const img = cached?.complete && cached.naturalWidth > 0 ? cached : null;
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
            settings.outline.widthPx,
            settings.outline.opacity,
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
        settings.outline.widthPx,
        settings.outline.opacity,
        textBitmapCache,
        getFontFn
      );
    }

    cursorY += lineHeight;
  }

  return cursorY;
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
  settings: OverlaySettings,
  textBitmapCache: ByteLimitedCache<HTMLCanvasElement>,
  emojiCache: ByteLimitedCache<HTMLImageElement>,
  authorPhotoCache: ByteLimitedCache<HTMLImageElement>,
  getFontFn: (fontSize: number) => string,
  overrideText?: string | null
): void {
  const fontSize = settings.fontSize;
  const color =
    settings.preserveUserColor && message.userColor
      ? message.userColor
      : settings.colors[message.authorType];

  // globalAlpha is set by the caller (opacity-batched outer loop)
  const showAuthor = settings.showAuthor[message.authorType];
  const textX = x + rendererLayout.paddingH;
  let textY = y + rendererLayout.paddingV;
  if (showAuthor && message.author) {
    const authorFontSize = Math.round(settings.fontSize * rendererLayout.authorFontScale);
    textY = drawAuthorSection(
      ctx,
      message,
      textX,
      textY,
      color,
      undefined,
      authorFontSize,
      settings.fontWeight,
      settings.fontFamily,
      settings.outline.widthPx,
      settings.outline.opacity,
      (url: string) => authorPhotoCache.get(url),
      (photo: unknown) =>
        (photo as HTMLImageElement)?.complete === true &&
        (photo as HTMLImageElement).naturalWidth > 0,
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
      settings.outline.widthPx,
      settings.outline.opacity,
      textBitmapCache,
      getFontFn
    );
  } else if (message.content.length > 0) {
    const font = getFontFn(fontSize);
    renderContentSegments(
      ctx,
      message.content,
      textX,
      textY,
      color,
      fontSize,
      settings.outline.widthPx,
      settings.outline.opacity,
      textBitmapCache,
      getFontFn,
      (text: string) => measureTextWidth(text, font),
      (url: string) => {
        const cached = emojiCache.get(url);
        return cached?.complete && cached.naturalWidth > 0 ? cached : null;
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
      settings.outline.widthPx,
      settings.outline.opacity,
      textBitmapCache,
      getFontFn
    );
  }
}
