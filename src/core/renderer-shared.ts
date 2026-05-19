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
  measureWrappedLineCount,
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
  const paddingH = spacing.md * 2;
  const paddingV = spacing.sm * 2;

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

  // ── Body text: accurate wrapped line count ──
  const innerWidth = rendererLayout.superchatMaxWidth - paddingH;
  const lineCount = measureWrappedLineCount(message.text, font, Math.max(1, innerWidth));
  const textHeight = Math.ceil(bodyLineHeight * lineCount);

  // ── Author section height (matches drawAuthorSection) ──
  const authorHeight = showAuthor ? rendererLayout.authorSectionHeightPx : 0;

  // ── Badge height (amount pill) ──
  const badgeFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
  const badgeHeight = badgeFontSize + spacing.sm * 2;

  // Layout: paddingV + author + xs + badge + xs + text + paddingV
  const contentHeight = authorHeight + spacing.xs + badgeHeight + spacing.xs + textHeight;

  const textWidth = measureContentWidth(message, font, fontSize);

  return {
    width: Math.max(
      rendererLayout.superchatMinWidth,
      Math.min(rendererLayout.superchatMaxWidth, textWidth + paddingH)
    ),
    height: contentHeight + paddingV,
  };
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
  const textHeight = measureTextHeight(font, fontSize);

  // Author name is rendered as text (no photo in membership).
  // Gap after author name matches renderMembership: fontSize + 4,
  // which is approximated by spacing.xs here.
  const infoHeight = nameHeight;
  const authorGap = spacing.xs;

  return {
    width: textWidth + paddingH,
    height: infoHeight + authorGap + textHeight + paddingV,
  };
}
