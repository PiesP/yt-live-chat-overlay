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
  fontFamily: string = FONT_FAMILY,
  maxBodyLines?: { superchat?: number; membership?: number }
): MessageDimensions {
  const font = getFontString(fontSize, fontWeight, fontFamily);

  if (message.kind === 'superchat') {
    return estimateSuperChatDimensions(
      message,
      font,
      fontSize,
      true,
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
  const authorFont = getFontString(authorFontSize, undefined, fontFamily);
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
  fontWeight: 'normal' | 'bold' = 'bold'
): MessageDimensions {
  const { paddingH, paddingV } = rendererLayout.superchat;
  const bodyLineHeight = measureTextHeight(font, fontSize);
  const innerWidth = rendererLayout.superchatMaxWidth - paddingH * 2;

  const wrappedLines = wrapTextLines(message.text, font, Math.max(1, innerWidth));
  const textHeight = Math.ceil(bodyLineHeight * Math.min(wrappedLines.length, maxBodyLines));

  let maxLineWidth = 0;
  const linesToMeasure = wrappedLines.slice(0, maxBodyLines);
  for (const line of linesToMeasure) {
    const w = measureTextWidth(line, font);
    if (w > maxLineWidth) maxLineWidth = w;
  }

  let authorSectionWidth = 0;
  let authorSectionHeight = 0;
  if (showAuthor && message.author) {
    const authorFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
    // Use the SAME font construction as renderSuperChat for consistent metrics
    const authorFont = getFontString(authorFontSize, fontWeight, fontFamily);
    const authorNameWidth = measureTextWidth(message.author, authorFont);
    authorSectionWidth = rendererLayout.authorPhotoSize + spacing.sm + authorNameWidth;
    const nameHeight = measureTextHeight(authorFont, authorFontSize);
    authorSectionHeight = Math.max(rendererLayout.authorPhotoSize, nameHeight);
  }

  // Use the SAME font construction as renderSuperChat for the badge
  const badgeFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
  const badgeFont = getFontString(badgeFontSize, 'bold', fontFamily);
  const badgeTextWidth = measureTextWidth(message.superChat?.amount ?? '', badgeFont);
  const badgeWidth = badgeTextWidth + rendererLayout.superchatBadge.paddingH * 2;
  const badgeHeight = badgeFontSize + rendererLayout.superchatBadge.paddingV * 2;

  const contentWidth = Math.max(authorSectionWidth, badgeWidth, maxLineWidth);
  const width = Math.max(
    rendererLayout.superchatMinWidth,
    Math.min(rendererLayout.superchatMaxWidth, contentWidth + paddingH * 2)
  );

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

  const innerWidth = rendererLayout.superchatMaxWidth - paddingH * 2;
  const wrappedLines = wrapTextLines(message.text, font, Math.max(1, innerWidth));
  const bodyLineCount = Math.min(wrappedLines.length, maxBodyLines);
  const textHeight = Math.ceil(bodyLineHeight * bodyLineCount);

  // Clamp width to the same bounds as SuperChat for visual consistency
  const width = Math.max(
    rendererLayout.superchatMinWidth,
    Math.min(rendererLayout.superchatMaxWidth, textWidth + paddingH * 2)
  );

  // Include author-to-body gap when author section is present (matching renderMembership)
  const hasAuthor = message.author !== undefined;
  const authorBodyGap = hasAuthor ? spacing.xs : 0;

  return {
    width,
    height: infoHeight + authorBodyGap + textHeight + paddingV * 2,
  };
}
