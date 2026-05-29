// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * RendererShared — utilities shared between renderer subsystems.
 *
 * Extracted from RendererMessageBuilder and Canvas2DRenderer to eliminate
 * duplicate text measurement and dimension estimation logic.
 */

import type { ChatMessage, FontWeight } from '@app-types';
import { DEFAULT_FONT_FAMILY, rendererLayout, spacing } from '@core/design-tokens';
import {
  getFontString,
  measureTextHeight,
  measureTextWidth,
  wrapTextLines,
} from '@core/text-measure';

// ── Text measurement ────────────────────────────────────────────────────────

/** Measure pixel width of all text + emoji content segments. */
function measureContentWidth(message: ChatMessage, font: string, fontSize: number): number {
  let width = 0;
  const emojiWidth = Math.ceil(fontSize * rendererLayout.emojiSize) + spacing.xs;

  if (message.content.length > 0) {
    for (const seg of message.content) {
      if (seg.type === 'text') {
        width += measureTextWidth(seg.content, font);
      } else {
        width += emojiWidth;
      }
    }
  } else if (message.text) {
    width += measureTextWidth(message.text, font);
  }

  return Math.ceil(width);
}

// ── Dimension estimation ────────────────────────────────────────────────────

interface MessageDimensions {
  width: number;
  height: number;
}

/** Estimate message dimensions without DOM reflow. */
export function estimateMessageDimensions(
  message: ChatMessage,
  fontSize: number,
  showAuthor: boolean,
  fontWeight: FontWeight = 'bold',
  fontFamily: string = DEFAULT_FONT_FAMILY,
  maxBodyLines?: { superchat?: number; membership?: number }
): MessageDimensions {
  const font = getFontString(fontSize, fontWeight, fontFamily);

  if (message.kind === 'superchat') {
    return estimateSuperChatDimensions(
      message,
      font,
      fontSize,
      showAuthor,
      fontFamily,
      maxBodyLines?.superchat ?? 5,
      fontWeight
    );
  }
  if (message.kind === 'membership') {
    return estimateMembershipDimensions(message, font, fontSize, maxBodyLines?.membership ?? 3);
  }
  return estimateRegularMessageDimensions(message, font, fontSize, showAuthor, fontFamily);
}

function estimateRegularMessageDimensions(
  message: ChatMessage,
  font: string,
  fontSize: number,
  showAuthor: boolean,
  fontFamily: string
): MessageDimensions {
  const textWidth = measureContentWidth(message, font, fontSize);
  const textHeight = measureTextHeight(font, fontSize);
  const { paddingH, paddingV } = rendererLayout;

  if (!showAuthor || !message.author) {
    return { width: textWidth + paddingH * 2, height: textHeight + paddingV * 2 };
  }

  const authorFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
  const authorFont = getFontString(authorFontSize, 'bold', fontFamily);
  const authorNameWidth = measureTextWidth(message.author, authorFont);
  const authorSectionWidth = rendererLayout.authorPhotoSize + spacing.sm + authorNameWidth;
  const totalWidth = Math.max(authorSectionWidth + paddingH * 2, textWidth + paddingH * 2);
  const photoHeight = rendererLayout.authorPhotoSize;
  const nameHeight = measureTextHeight(authorFont, authorFontSize);
  const authorSectionHeight = Math.max(photoHeight, nameHeight);

  return {
    width: totalWidth,
    height: authorSectionHeight + spacing.xs + textHeight + paddingV * 2,
  };
}

function estimateSuperChatDimensions(
  message: ChatMessage,
  font: string,
  fontSize: number,
  showAuthor: boolean,
  fontFamily: string,
  maxBodyLines: number,
  fontWeight: FontWeight = 'bold'
): MessageDimensions {
  const { paddingH, paddingV } = rendererLayout.superchat;
  const bodyLineHeight = measureTextHeight(font, fontSize);

  let authorSectionWidth = 0;
  let authorSectionHeight = 0;
  if (showAuthor && message.author) {
    const authorFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
    const authorFont = getFontString(authorFontSize, fontWeight, fontFamily);
    const rawNameWidth = measureTextWidth(message.author, authorFont);
    const authorNameWidth = Math.min(rawNameWidth, rendererLayout.authorNameMaxWidth);
    authorSectionWidth = rendererLayout.authorPhotoSize + spacing.sm + authorNameWidth;
    const nameHeight = measureTextHeight(authorFont, authorFontSize);
    authorSectionHeight = Math.max(rendererLayout.authorPhotoSize, nameHeight);
  }

  const badgeFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
  const badgeFont = getFontString(badgeFontSize, 'bold', fontFamily);
  const badgeTextWidth = measureTextWidth(message.superChat?.amount ?? '', badgeFont);
  const badgeWidth = badgeTextWidth + rendererLayout.superchatBadge.paddingH * 2;
  const badgeHeight = badgeFontSize + rendererLayout.superchatBadge.paddingV * 2;

  // Pass 1: measure text at max inner width to get max line width
  const maxInnerWidth = rendererLayout.superchatMaxWidth - paddingH * 2;
  const pass1Lines = wrapTextLines(message.text, font, Math.max(1, maxInnerWidth));
  let maxLineWidth = 0;
  for (const line of pass1Lines.slice(0, maxBodyLines)) {
    const w = measureTextWidth(line, font);
    if (w > maxLineWidth) maxLineWidth = w;
  }

  // Determine card width from the widest element
  const contentWidth = Math.max(authorSectionWidth, badgeWidth, maxLineWidth);
  const width = Math.max(
    rendererLayout.superchatMinWidth,
    Math.min(rendererLayout.superchatMaxWidth, contentWidth + paddingH * 2)
  );

  // Pass 2: re-wrap text at the actual card inner width so line count
  // matches what renderSuperChat will produce. Without this, a card clamped
  // to superchatMinWidth (or narrowed by content) would estimate fewer lines
  // than actually rendered, causing text to overflow the background.
  const actualInnerWidth = Math.max(1, width - paddingH * 2);
  const wrappedLines = wrapTextLines(message.text, font, actualInnerWidth);
  const lineCount = Math.min(wrappedLines.length, maxBodyLines);
  // Per-line rounding matches the renderer, which rounds each line's
  // height individually via Math.ceil(measureTextHeight(...)).
  const lineHeight = Math.ceil(bodyLineHeight);
  const textHeight = lineHeight * lineCount;

  let stickerHeight = 0;
  if (message.superChat?.sticker) {
    stickerHeight = Math.round(fontSize * rendererLayout.superchatStickerSize) + spacing.xs;
  }

  const contentHeight =
    authorSectionHeight + spacing.xs + badgeHeight + spacing.xs + textHeight + stickerHeight;

  return { width, height: contentHeight + paddingV * 2 };
}

function estimateMembershipDimensions(
  message: ChatMessage,
  font: string,
  fontSize: number,
  maxBodyLines: number
): MessageDimensions {
  const textWidth = measureContentWidth(message, font, fontSize);
  const { paddingH, paddingV } = rendererLayout.membership;
  const nameHeight = measureTextHeight(font, fontSize);
  const bodyLineHeight = measureTextHeight(font, fontSize);

  const infoHeight = nameHeight;

  // Clamp width to the same bounds as SuperChat for visual consistency
  const width = Math.max(
    rendererLayout.superchatMinWidth,
    Math.min(rendererLayout.superchatMaxWidth, textWidth + paddingH * 2)
  );

  // Re-wrap text at the actual card inner width so line count matches
  // what renderMembership will produce (same 2-pass pattern as superchat).
  const actualInnerWidth = Math.max(1, width - paddingH * 2);
  const wrappedLines = wrapTextLines(message.text, font, actualInnerWidth);
  const bodyLineCount = Math.min(wrappedLines.length, maxBodyLines);
  // Per-line rounding matches the renderer (rounds each line individually).
  const textHeight = Math.ceil(bodyLineHeight) * bodyLineCount;

  // Include author-to-body gap when author section is present (matching renderMembership)
  const hasAuthor = message.author !== undefined;
  const authorBodyGap = hasAuthor ? spacing.xs : 0;

  return {
    width,
    height: infoHeight + authorBodyGap + textHeight + paddingV * 2,
  };
}
