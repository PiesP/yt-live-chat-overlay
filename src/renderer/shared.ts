// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * RendererShared — utilities shared between renderer subsystems.
 *
 * Extracted from RendererMessageBuilder and Canvas2DRenderer to eliminate
 * duplicate text measurement and dimension estimation logic.
 */

import type { ChatMessage, FontWeight, TranslationMode } from '@app-types';
import {
  buildWrappedLines,
  measureEmojiAdvanceWidth,
  measureTextAdvanceWidth,
  toSharedContentSegments,
} from '@renderer/canvas/shared';
import { MEMBERSHIP_CARD_CONFIG, SUPERCHAT_CARD_CONFIG } from '@renderer/card-config';
import { SPEED_TIER, TRANSLATION_FONT_SCALE, TRANSLATION_GAP_PX } from '@renderer/constants';
import {
  getAuthorPhotoSlotWidth,
  getAuthorRowHeight,
  getPaidCardWidthBounds,
  getRegularCardInsets,
} from '@renderer/layout/card-layout';
import { RendererBase } from '@renderer/renderer-base';
import { getFontString, measureTextHeight, measureTextWidth } from '@renderer/text-measure';
import { DEFAULT_SETTINGS } from '@settings/schema';
import { DEFAULT_FONT_FAMILY, rendererLayout, spacing } from '@util/design-tokens';
import type { HighFirstPriorityBucketQueue } from '@util/priority-bucket-queue';

// ── Text measurement ────────────────────────────────────────────────────────

/** Measure pixel width of all text + emoji content segments. */
function measureContentWidth(
  message: ChatMessage,
  font: string,
  fontSize: number,
  letterSpacing: string
): number {
  let width = 0;
  const emojiSize = Math.round(fontSize * rendererLayout.emojiSize);
  const measureText = (text: string): number => measureTextWidth(text, font);

  if (message.content.length > 0) {
    for (const seg of message.content) {
      if (seg.type === 'text') {
        width += measureTextAdvanceWidth(seg.content, measureText, letterSpacing);
      } else {
        width += measureEmojiAdvanceWidth(seg, emojiSize, measureText, letterSpacing);
      }
    }
  } else if (message.text) {
    width += measureTextAdvanceWidth(message.text, measureText, letterSpacing);
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
  maxBodyLines?: { superchat?: number; membership?: number },
  showSuperChatAmount?: boolean,
  letterSpacing = '0px',
  outlineWidthPx = 0,
  availableWidth?: number,
  minimumPaidCardWidth?: number
): MessageDimensions {
  const font = getFontString(fontSize, fontWeight, fontFamily);

  if (message.kind === 'superchat') {
    return estimateSuperChatDimensions(
      message,
      font,
      fontSize,
      showAuthor,
      fontFamily,
      maxBodyLines?.superchat ?? DEFAULT_SETTINGS.superChatMaxBodyLines,
      fontWeight,
      showSuperChatAmount,
      availableWidth,
      minimumPaidCardWidth
    );
  }
  if (message.kind === 'membership') {
    return estimateMembershipDimensions(
      message,
      font,
      fontSize,
      maxBodyLines?.membership ?? DEFAULT_SETTINGS.membershipMaxBodyLines,
      fontWeight,
      fontFamily,
      availableWidth,
      minimumPaidCardWidth
    );
  }
  return estimateRegularMessageDimensions(
    message,
    font,
    fontSize,
    showAuthor,
    fontWeight,
    fontFamily,
    letterSpacing,
    outlineWidthPx
  );
}

function estimateRegularMessageDimensions(
  message: ChatMessage,
  font: string,
  fontSize: number,
  showAuthor: boolean,
  fontWeight: FontWeight,
  fontFamily: string,
  letterSpacing: string,
  outlineWidthPx: number
): MessageDimensions {
  const textWidth = measureContentWidth(message, font, fontSize, letterSpacing);
  const textHeight = Math.max(
    measureTextHeight(font, fontSize),
    message.content.some((segment) => segment.type === 'emoji')
      ? Math.round(fontSize * rendererLayout.emojiSize)
      : 0
  );
  const insets = getRegularCardInsets(
    fontSize,
    outlineWidthPx,
    showAuthor && !!message.author && !!message.authorPhotoUrl
  );

  if (!showAuthor || !message.author) {
    return {
      width: textWidth + insets.horizontal * 2,
      height: textHeight + insets.vertical * 2,
    };
  }

  const authorFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
  const authorFont = getFontString(authorFontSize, fontWeight, fontFamily);
  const authorNameWidth = measureTextWidth(message.author, authorFont);
  const authorSectionWidth = getAuthorPhotoSlotWidth(message.authorPhotoUrl) + authorNameWidth;
  const totalWidth = Math.max(authorSectionWidth, textWidth) + insets.horizontal * 2;
  const nameHeight = measureTextHeight(authorFont, authorFontSize);
  const authorSectionHeight = getAuthorRowHeight(nameHeight, message.authorPhotoUrl);

  return {
    width: totalWidth,
    height: insets.vertical * 2 + authorSectionHeight + spacing.xs + textHeight,
  };
}

function estimateSuperChatDimensions(
  message: ChatMessage,
  font: string,
  fontSize: number,
  showAuthor: boolean,
  fontFamily: string,
  maxBodyLines: number,
  fontWeight: FontWeight = 'bold',
  showSuperChatAmount: boolean = true,
  availableWidth?: number,
  minimumWidth?: number
): MessageDimensions {
  const { paddingH, paddingV } = rendererLayout.superchat;
  const bodyLineHeight = measureTextHeight(font, fontSize);
  const widthBounds = getPaidCardWidthBounds(fontSize, availableWidth);

  let authorSectionWidth = 0;
  let authorSectionHeight = 0;
  if (showAuthor && message.author) {
    const authorFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
    const authorFont = getFontString(authorFontSize, fontWeight, fontFamily);
    const rawNameWidth = measureTextWidth(message.author, authorFont);
    const photoSlotWidth = getAuthorPhotoSlotWidth(message.authorPhotoUrl);
    const maxNameWidth = Math.max(1, widthBounds.max - paddingH * 2 - photoSlotWidth);
    const authorNameWidth = Math.min(rawNameWidth, rendererLayout.authorNameMaxWidth, maxNameWidth);
    authorSectionWidth = photoSlotWidth + authorNameWidth;
    const nameHeight = measureTextHeight(authorFont, authorFontSize);
    authorSectionHeight = getAuthorRowHeight(nameHeight, message.authorPhotoUrl);
  }

  let badgeWidth = 0;
  let badgeHeight = 0;
  const badgeText = message.superChat?.amount ?? '';
  if (showSuperChatAmount && badgeText) {
    const badgeFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
    const badgeFont = getFontString(badgeFontSize, 'bold', fontFamily);
    const badgeTextWidth = measureTextWidth(badgeText, badgeFont);
    badgeWidth = badgeTextWidth + rendererLayout.superchatBadge.paddingH * 2;
    badgeHeight = badgeFontSize + rendererLayout.superchatBadge.paddingV * 2;
  }

  const emojiSize = Math.round(fontSize * rendererLayout.emojiSize);

  // Pass 1: build wrapped lines at max inner width to determine max line width.
  // Uses buildWrappedLines (SSOT with renderWrappedContentSegments) so that
  // emoji segments are measured with the same piece widths as rendering.
  const maxInnerWidth = Math.max(1, widthBounds.max - paddingH * 2);
  const pass1Result = buildWrappedLines(
    toSharedContentSegments(message.content),
    Math.max(1, maxInnerWidth),
    emojiSize,
    (t: string) => measureTextWidth(t, font)
  );
  const maxLineWidth = pass1Result.maxLineWidth;

  // Determine card width from the widest element
  const contentWidth = Math.max(authorSectionWidth, badgeWidth, maxLineWidth);
  const width = Math.min(
    widthBounds.max,
    Math.max(widthBounds.min, minimumWidth ?? 0, contentWidth + paddingH * 2)
  );

  // Pass 2: re-wrap at actual card inner width to get line count.
  // Skip when Pass 1 already covers the worst case:
  //  - Card is at maxWidth → same inner width as Pass 1.
  //  - Content fits in 0-1 lines → line count won't change at narrower width.
  const pass1LineCount = pass1Result.lines.length;
  const actualInnerWidth = Math.max(1, width - paddingH * 2);
  let lineCount: number;
  if (actualInnerWidth === maxInnerWidth || pass1LineCount <= 1) {
    lineCount = Math.min(pass1LineCount, maxBodyLines);
  } else {
    const pass2Result = buildWrappedLines(
      toSharedContentSegments(message.content),
      actualInnerWidth,
      emojiSize,
      (t: string) => measureTextWidth(t, font)
    );
    lineCount = Math.min(pass2Result.lines.length, maxBodyLines);
  }
  // Per-line rounding matches the renderer, which rounds each line's
  // height individually via Math.ceil(measureTextHeight(...)).
  const lineHeight = Math.ceil(bodyLineHeight);
  const textHeight = lineHeight * lineCount;

  let stickerHeight = 0;
  if (message.superChat?.sticker) {
    stickerHeight =
      Math.round(fontSize * rendererLayout.superchatStickerSize) +
      (SUPERCHAT_CARD_CONFIG.sticker?.marginTop ?? 0);
  }

  const badgeSectionHeight = badgeHeight > 0 ? spacing.xs + badgeHeight : 0;
  const bodySectionHeight = lineCount > 0 ? SUPERCHAT_CARD_CONFIG.body.marginTop + textHeight : 0;
  const contentHeight =
    authorSectionHeight + badgeSectionHeight + bodySectionHeight + stickerHeight;

  return { width, height: contentHeight + paddingV * 2 };
}

function estimateMembershipDimensions(
  message: ChatMessage,
  font: string,
  fontSize: number,
  maxBodyLines: number,
  fontWeight: FontWeight,
  fontFamily: string,
  availableWidth?: number,
  minimumWidth?: number
): MessageDimensions {
  const { paddingH, paddingV } = rendererLayout.membership;
  const bodyLineHeight = measureTextHeight(font, fontSize);
  const widthBounds = getPaidCardWidthBounds(fontSize, availableWidth);

  let authorSectionWidth = 0;
  let authorSectionHeight = 0;
  if (message.author) {
    const authorFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
    const authorFont = getFontString(authorFontSize, fontWeight, fontFamily);
    const photoSlotWidth = getAuthorPhotoSlotWidth(message.authorPhotoUrl);
    const maxNameWidth = Math.max(1, widthBounds.max - paddingH * 2 - photoSlotWidth);
    const authorNameWidth = Math.min(
      measureTextWidth(message.author, authorFont),
      rendererLayout.authorNameMaxWidth,
      maxNameWidth
    );
    authorSectionWidth = photoSlotWidth + authorNameWidth;
    authorSectionHeight = getAuthorRowHeight(
      measureTextHeight(authorFont, authorFontSize),
      message.authorPhotoUrl
    );
  }

  // Membership header height (if present)
  let headerHeight = 0;
  let headerWidth = 0;
  if (message.membershipHeader) {
    const headerFontSize = Math.round(fontSize * 0.8);
    const headerFont = getFontString(headerFontSize, fontWeight, fontFamily);
    headerHeight = measureTextHeight(headerFont, headerFontSize);
    headerWidth = Math.min(measureTextWidth(message.membershipHeader, headerFont), widthBounds.max);
  }

  const emojiSize = Math.round(fontSize * rendererLayout.emojiSize);
  const maxInnerWidth = Math.max(1, widthBounds.max - paddingH * 2);
  const pass1Result = buildWrappedLines(
    toSharedContentSegments(message.content),
    maxInnerWidth,
    emojiSize,
    (text: string) => measureTextWidth(text, font)
  );
  const contentWidth = Math.max(authorSectionWidth, headerWidth, pass1Result.maxLineWidth);
  const width = Math.min(
    widthBounds.max,
    Math.max(widthBounds.min, minimumWidth ?? 0, contentWidth + paddingH * 2)
  );

  // Re-build wrapped lines at the actual card inner width so line count matches
  // what renderMembership will produce. Uses buildWrappedLines (SSOT with
  // renderWrappedContentSegments) for consistent emoji piece widths.
  const actualInnerWidth = Math.max(1, width - paddingH * 2);
  const passResult = buildWrappedLines(
    toSharedContentSegments(message.content),
    actualInnerWidth,
    emojiSize,
    (t: string) => measureTextWidth(t, font)
  );
  const bodyLineCount = Math.min(passResult.lines.length, maxBodyLines);
  // Per-line rounding matches the renderer (rounds each line individually).
  const textHeight = Math.ceil(bodyLineHeight) * bodyLineCount;

  // Include author-to-body gap when author section is present (matching renderMembership)
  const headerSectionHeight =
    headerHeight > 0
      ? (MEMBERSHIP_CARD_CONFIG.headerTag?.marginTop ?? 0) +
        headerHeight +
        (MEMBERSHIP_CARD_CONFIG.headerTag?.marginBottom ?? 0)
      : 0;
  const bodySectionHeight =
    bodyLineCount > 0 ? MEMBERSHIP_CARD_CONFIG.body.marginTop + textHeight : 0;

  return {
    width,
    height: paddingV * 2 + authorSectionHeight + headerSectionHeight + bodySectionHeight,
  };
}

export interface MessageDimensionOptions {
  fontSize: number;
  showAuthor: boolean;
  fontWeight?: FontWeight;
  fontFamily?: string;
  maxBodyLines?: { superchat?: number; membership?: number };
  showSuperChatAmount?: boolean;
  letterSpacing?: string;
  outlineWidthPx?: number;
  availableWidth?: number;
}

export interface TranslatedMessageDimensions extends MessageDimensions {
  /** Height of the translated text block only; excludes the inter-section gap. */
  translationHeight: number;
}

/** Estimate final geometry after an asynchronous translation becomes visible. */
export function estimateTranslatedMessageDimensions(
  message: ChatMessage,
  translatedText: string | null,
  mode: TranslationMode,
  options: MessageDimensionOptions
): TranslatedMessageDimensions {
  const {
    fontSize,
    showAuthor,
    fontWeight = 'bold',
    fontFamily = DEFAULT_FONT_FAMILY,
    maxBodyLines,
    showSuperChatAmount,
    letterSpacing = '0px',
    outlineWidthPx = 0,
    availableWidth,
  } = options;
  const estimate = (candidate: ChatMessage, minimumPaidCardWidth?: number): MessageDimensions =>
    estimateMessageDimensions(
      candidate,
      fontSize,
      showAuthor,
      fontWeight,
      fontFamily,
      maxBodyLines,
      showSuperChatAmount,
      letterSpacing,
      outlineWidthPx,
      availableWidth,
      minimumPaidCardWidth
    );
  const base = estimate(message);
  if (!translatedText || (mode === 'dual' && translatedText === message.text)) {
    return { ...base, translationHeight: 0 };
  }

  const translatedMessage: ChatMessage = {
    ...message,
    text: translatedText,
    content: [{ type: 'text', content: translatedText }],
  };
  if (mode === 'replace') {
    return { ...estimate(translatedMessage), translationHeight: 0 };
  }

  const translationFontSize = Math.max(1, Math.round(fontSize * TRANSLATION_FONT_SCALE));
  const translationFont = getFontString(translationFontSize, 'normal', fontFamily);
  const translationLineHeight = Math.ceil(measureTextHeight(translationFont, translationFontSize));
  const translationTextWidth = measureTextWidth(translatedText, translationFont);

  if (message.kind === 'text') {
    const insets = getRegularCardInsets(
      fontSize,
      outlineWidthPx,
      showAuthor && !!message.author && !!message.authorPhotoUrl
    );
    return {
      width: Math.max(base.width, Math.ceil(translationTextWidth) + insets.horizontal * 2),
      height: base.height + TRANSLATION_GAP_PX + translationLineHeight,
      translationHeight: translationLineHeight,
    };
  }

  const padding =
    message.kind === 'superchat' ? rendererLayout.superchat : rendererLayout.membership;
  const widthBounds = getPaidCardWidthBounds(fontSize, availableWidth);
  const desiredWidth = Math.min(
    widthBounds.max,
    Math.max(base.width, Math.ceil(translationTextWidth) + padding.paddingH * 2)
  );
  const primary = estimate(message, desiredWidth);
  const innerWidth = Math.max(1, primary.width - padding.paddingH * 2);
  const wrapped = buildWrappedLines(
    [{ type: 'text', content: translatedText }],
    innerWidth,
    Math.round(translationFontSize * rendererLayout.emojiSize),
    (text: string) => measureTextWidth(text, translationFont)
  );
  const maxLines =
    message.kind === 'superchat'
      ? (maxBodyLines?.superchat ?? DEFAULT_SETTINGS.superChatMaxBodyLines)
      : (maxBodyLines?.membership ?? DEFAULT_SETTINGS.membershipMaxBodyLines);
  const translationHeight = Math.min(wrapped.lines.length, maxLines) * translationLineHeight;

  return {
    width: primary.width,
    height: primary.height + TRANSLATION_GAP_PX + translationHeight,
    translationHeight,
  };
}

// ── Opacity computation (shared between main-thread and worker renderers) ──

/**
 * Compute the age fade rate multiplier (1 / maxMessageAgeMs).
 * Clamped to a minimum denominator of 1 to prevent division by zero.
 */
export function computeAgeFadeRate(maxMessageAgeMs: number): number {
  return 1 / Math.max(1, maxMessageAgeMs);
}

/**
 * Compute the inverse fade duration (1 / fadeDurationMs).
 * Returns 0 if fadeDurationMs is 0 (fade disabled).
 */
export function computeInvFadeDuration(fadeDurationMs: number): number {
  return fadeDurationMs > 0 ? 1 / Math.max(1, fadeDurationMs) : 0;
}

export interface OpacityConfig {
  baseOpacity: number;
  fadeDurationMs: number;
  invFadeDuration: number;
  backlogOpacityMultiplier: number;
  depthLayersEnabled: boolean;
  depthFarOpacityMul: number;
  ageFadeRate: number;
}

/**
 * Compute per-frame message opacity using a 6-stage composition:
 *  1. Base opacity from settings
 *  2. Fade-in (first N ms, fixed modes only)
 *  3. Fade-out (last N ms, all modes; scrolling: fade-out only)
 *  4. Backlog dimming
 *  5. Far depth layer dimming
 *  6. Age fade-out (gradual fade toward maxMessageAgeMs)
 */
export function computeMessageOpacity(
  isBacklog: boolean,
  elapsed: number,
  duration: number,
  isScrolling: boolean,
  speedTier: number,
  config: OpacityConfig
): number {
  let opacity = config.baseOpacity;

  if (config.fadeDurationMs > 0) {
    if (isScrolling) {
      const remaining = duration - elapsed;
      if (remaining < config.fadeDurationMs) {
        opacity *= Math.max(0, remaining * config.invFadeDuration);
      }
    } else {
      if (elapsed < config.fadeDurationMs) {
        opacity *= elapsed * config.invFadeDuration;
      }
      if (elapsed > duration - config.fadeDurationMs) {
        opacity *= Math.max(0, (duration - elapsed) * config.invFadeDuration);
      }
    }
  }

  if (isBacklog) opacity *= config.backlogOpacityMultiplier;

  if (config.depthLayersEnabled && speedTier === SPEED_TIER.FAR) {
    opacity *= config.depthFarOpacityMul;
  }

  const ageRatio = isScrolling ? Math.min(1, elapsed * config.ageFadeRate) : 0;
  opacity *= Math.max(0, 1 - ageRatio);

  return opacity;
}

/**
 * Enqueue a message into a priority-bucket queue with overflow displacement.
 *
 * When the queue is at capacity, the new message displaces the lowest-priority
 * entry if it has higher priority. Otherwise the new message is dropped.
 *
 * Returns 'enqueued' on success, 'dropped' if the message was rejected,
 * or 'replaced' if the new message displaced a lower-priority entry.
 */
export function enqueueWithOverflow(
  queue: HighFirstPriorityBucketQueue<ChatMessage>,
  message: ChatMessage,
  priority: number,
  onDrop: (reason: 'queue_priority' | 'queue_replaced') => void,
  maxSize: number
): 'enqueued' | 'dropped' | 'replaced' {
  if (queue.size >= maxSize) {
    const lowest = queue.peekLowest();
    if (lowest && priority <= RendererBase.getMessagePriority(lowest)) {
      onDrop('queue_priority');
      return 'dropped';
    }
    queue.dropLowest();
    onDrop('queue_replaced');
    queue.enqueue(message, priority);
    return 'replaced';
  }
  queue.enqueue(message, priority);
  return 'enqueued';
}
