// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * CanvasTextRenderer — extracted text-rendering utilities from CanvasRenderer.
 *
 * Module-level functions for rendering text segments, wrapped text, emoji,
 * cached bitmaps, and outline strokes on a Canvas2D context.
 */

import type { ContentSegment, OverlaySettings } from '@app-types';
import type { ByteLimitedCache } from '@core/byte-limited-cache';
import { EMOJI_ALIAS_PATTERN } from '@core/chat-message-helpers';
import { rendererLayout } from '@core/design-tokens';
import { measureTextHeight, measureTextWidth } from '@core/text-measure';
import {
  buildWrappedLines,
  renderSegment,
  type SharedContentSegment,
} from '@shared/canvas-rendering-shared';

// ── Re-export shared rendering functions so external consumers
//    (canvas-card-renderers.ts, renderer-canvas.ts) can still
//    import them from '@core/canvas-text-renderer'.
export {
  drawAuthorSection,
  drawRoundRect,
  type RegularMessageLike,
  type RegularMessageRenderConfig,
  renderRegularMessage,
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
