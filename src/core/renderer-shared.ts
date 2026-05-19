/**
 * RendererShared — utilities shared between CSS and Canvas2D renderers.
 *
 * Extracted from RendererMessageBuilder and Canvas2DRenderer to eliminate
 * duplicate text measurement and dimension estimation logic.
 */

import type { ChatMessage } from '@app-types';
import { rendererLayout, spacing } from '@core/design-tokens';
import { DEFAULT_SETTINGS } from '@core/settings-schema';
import {
  getFontString,
  measureTextHeight,
  measureTextWidth,
  wrapTextLines,
} from '@core/text-measure';

// Derived from DEFAULT_SETTINGS (SSOT) to avoid hardcoded string duplication.
const FONT_FAMILY = DEFAULT_SETTINGS.fontFamily;

// ── Text measurement ────────────────────────────────────────────────────────

/** Measure pixel width of all text + emoji content segments. */
export function measureContentWidth(message: ChatMessage, font: string, fontSize: number): number {
  let width = 0;
  const emojiWidth = Math.ceil(fontSize * rendererLayout.emojiSize) + 4;

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

export interface MessageDimensions {
  width: number;
  height: number;
}

/** Estimate message dimensions without DOM reflow. */
export function estimateMessageDimensions(
  message: ChatMessage,
  fontSize: number,
  showAuthor: boolean,
  fontWeight: 'normal' | 'bold' = 'bold',
  fontFamily: string = FONT_FAMILY
): MessageDimensions {
  const font = getFontString(fontSize, fontWeight, fontFamily);

  if (message.kind === 'superchat') {
    return estimateSuperChatDimensions(message, font, fontSize, true);
  }
  if (message.kind === 'membership') {
    return estimateMembershipDimensions(message, font, fontSize);
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
    return { width: textWidth + paddingH, height: textHeight + paddingV };
  }

  const authorFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
  const authorFont = getFontString(authorFontSize, undefined, fontFamily);
  const authorNameWidth = measureTextWidth(message.author, authorFont);
  const authorSectionWidth = rendererLayout.authorPhotoSize + spacing.sm + authorNameWidth;
  const totalWidth = Math.max(authorSectionWidth + paddingH, textWidth + paddingH);
  const photoHeight = rendererLayout.authorPhotoSize;
  const nameHeight = measureTextHeight(authorFont, authorFontSize);
  const authorSectionHeight = Math.max(photoHeight, nameHeight);

  return {
    width: totalWidth,
    height: authorSectionHeight + spacing.xs + textHeight + paddingV,
  };
}

function estimateSuperChatDimensions(
  message: ChatMessage,
  font: string,
  fontSize: number,
  showAuthor: boolean
): MessageDimensions {
  const { paddingH, paddingV } = rendererLayout.superchat;
  const bodyLineHeight = measureTextHeight(font, fontSize);
  const innerWidth = rendererLayout.superchatMaxWidth - paddingH;

  const wrappedLines = wrapTextLines(message.text, font, Math.max(1, innerWidth));
  const textHeight = Math.ceil(bodyLineHeight * wrappedLines.length);

  let maxLineWidth = 0;
  for (const line of wrappedLines) {
    const w = measureTextWidth(line, font);
    if (w > maxLineWidth) maxLineWidth = w;
  }

  let authorSectionWidth = 0;
  if (showAuthor && message.author) {
    const authorFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
    const authorFont = getFontString(authorFontSize, undefined, FONT_FAMILY);
    const authorNameWidth = measureTextWidth(message.author, authorFont);
    authorSectionWidth = rendererLayout.authorPhotoSize + spacing.sm + authorNameWidth;
  }

  const badgeFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
  const badgeFont = getFontString(badgeFontSize, 'bold', FONT_FAMILY);
  const badgeWidth = Math.ceil(measureTextWidth(message.superChat?.amount ?? '', badgeFont)) + 24;
  const badgeHeight = badgeFontSize + spacing.sm * 2;

  const contentWidth = Math.max(authorSectionWidth, badgeWidth, maxLineWidth);
  const width = Math.max(
    rendererLayout.superchatMinWidth,
    Math.min(rendererLayout.superchatMaxWidth, contentWidth + paddingH)
  );

  const authorHeight = showAuthor ? rendererLayout.authorSectionHeightPx : 0;

  // Sticker height: included so the card fully contains the sticker image
  let stickerHeight = 0;
  if (message.superChat?.sticker) {
    stickerHeight = Math.round(fontSize * rendererLayout.superchatStickerSize) + spacing.xs;
  }

  const contentHeight =
    authorHeight + spacing.xs + badgeHeight + spacing.xs + textHeight + stickerHeight;

  return { width, height: contentHeight + paddingV };
}

function estimateMembershipDimensions(
  message: ChatMessage,
  font: string,
  fontSize: number
): MessageDimensions {
  const textWidth = measureContentWidth(message, font, fontSize);
  const paddingH = spacing.lg * 2;
  const paddingV = spacing.md + spacing.lg;
  const nameHeight = measureTextHeight(font, fontSize);
  const bodyLineHeight = measureTextHeight(font, fontSize);

  const infoHeight = nameHeight;
  const authorGap = spacing.xs;

  const innerWidth = rendererLayout.superchatMaxWidth - paddingH;
  const wrappedLines = wrapTextLines(message.text, font, Math.max(1, innerWidth));
  const bodyLineCount = wrappedLines.length;
  const textHeight = Math.ceil(bodyLineHeight * bodyLineCount);

  // Clamp width to the same bounds as SuperChat for visual consistency
  const width = Math.max(
    rendererLayout.superchatMinWidth,
    Math.min(rendererLayout.superchatMaxWidth, textWidth + paddingH)
  );

  return {
    width,
    height: infoHeight + authorGap + textHeight + paddingV,
  };
}
