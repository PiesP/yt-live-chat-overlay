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
import { rendererLayout, spacing } from '@core/design-tokens';
import { getFontString, measureTextHeight, measureTextWidth } from '@core/text-measure';
import {
  buildWrappedLines,
  drawAuthorPhoto,
  renderContentSegments,
  renderSegment,
  type SharedContentSegment,
} from '@shared/canvas-rendering-shared';

// ── Re-export shared rendering functions so external consumers
//    (canvas-card-renderers.ts, renderer-canvas.ts) can still
//    import them from '@core/canvas-text-renderer'.
export { drawRoundRect, strokeTextOutline } from '@shared/canvas-rendering-shared';

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

// ── Author rendering ────────────────────────────────────────────────────────

/** Draw author photo + name section. Returns the Y offset after the section. */
export function drawAuthorSection(
  ctx: CanvasRenderingContext2D,
  message: ChatMessage,
  textX: number,
  startY: number,
  color: string,
  maxNameWidth: number | undefined,
  settings: OverlaySettings,
  authorPhotoCache: ByteLimitedCache<HTMLImageElement>,
  textBitmapCache: ByteLimitedCache<HTMLCanvasElement>,
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
    settings.outline.widthPx,
    settings.outline.opacity,
    textBitmapCache,
    getFontFn
  );

  ctx.font = prevFont;
  ctx.textBaseline = prevTextBaseline;

  return startY + sectionHeight;
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
