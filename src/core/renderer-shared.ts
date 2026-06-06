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
import { SPEED_TIER } from '@core/renderer-constants';
import { DEFAULT_SETTINGS } from '@core/settings-schema';
import { getFontString, measureTextHeight, measureTextWidth } from '@core/text-measure';
import { buildWrappedLines, type SharedContentSegment } from '@shared/canvas-rendering-shared';

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
  maxBodyLines?: { superchat?: number; membership?: number },
  showSuperChatAmount?: boolean
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
      showSuperChatAmount
    );
  }
  if (message.kind === 'membership') {
    return estimateMembershipDimensions(
      message,
      font,
      fontSize,
      maxBodyLines?.membership ?? DEFAULT_SETTINGS.membershipMaxBodyLines
    );
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
  fontWeight: FontWeight = 'bold',
  showSuperChatAmount: boolean = true
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

  let badgeWidth = 0;
  let badgeHeight = 0;
  if (showSuperChatAmount) {
    const badgeFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
    const badgeFont = getFontString(badgeFontSize, 'bold', fontFamily);
    const badgeTextWidth = measureTextWidth(message.superChat?.amount ?? '', badgeFont);
    badgeWidth = badgeTextWidth + rendererLayout.superchatBadge.paddingH * 2;
    badgeHeight = badgeFontSize + rendererLayout.superchatBadge.paddingV * 2;
  }

  const emojiSize = Math.round(fontSize * rendererLayout.emojiSize);

  // Pass 1: build wrapped lines at max inner width to determine max line width.
  // Uses buildWrappedLines (SSOT with renderWrappedContentSegments) so that
  // emoji segments are measured with the same piece widths as rendering.
  const maxInnerWidth = rendererLayout.superchatMaxWidth - paddingH * 2;
  const pass1Result = buildWrappedLines(
    message.content as unknown as SharedContentSegment[],
    Math.max(1, maxInnerWidth),
    emojiSize,
    (t: string) => measureTextWidth(t, font)
  );
  const maxLineWidth = pass1Result.maxLineWidth;

  // Determine card width from the widest element
  const contentWidth = Math.max(authorSectionWidth, badgeWidth, maxLineWidth);
  const width = Math.max(
    rendererLayout.superchatMinWidth,
    Math.min(rendererLayout.superchatMaxWidth, contentWidth + paddingH * 2)
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
      message.content as unknown as SharedContentSegment[],
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
    stickerHeight = Math.round(fontSize * rendererLayout.superchatStickerSize) + spacing.xs;
  }

  const badgeSectionHeight = showSuperChatAmount ? spacing.xs + badgeHeight + spacing.xs : 0;
  const contentHeight = authorSectionHeight + badgeSectionHeight + textHeight + stickerHeight;

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

  // Membership header height (if present)
  let headerHeight = 0;
  if (message.membershipHeader) {
    const headerFontSize = Math.round(fontSize * 0.8);
    headerHeight = measureTextHeight(font, headerFontSize) + spacing.xs;
  }

  // Re-build wrapped lines at the actual card inner width so line count matches
  // what renderMembership will produce. Uses buildWrappedLines (SSOT with
  // renderWrappedContentSegments) for consistent emoji piece widths.
  const actualInnerWidth = Math.max(1, width - paddingH * 2);
  const emojiSize = Math.round(fontSize * rendererLayout.emojiSize);
  const passResult = buildWrappedLines(
    message.content as unknown as SharedContentSegment[],
    actualInnerWidth,
    emojiSize,
    (t: string) => measureTextWidth(t, font)
  );
  const bodyLineCount = Math.min(passResult.lines.length, maxBodyLines);
  // Per-line rounding matches the renderer (rounds each line individually).
  const textHeight = Math.ceil(bodyLineHeight) * bodyLineCount;

  // Include author-to-body gap when author section is present (matching renderMembership)
  const hasAuthor = message.author !== undefined;
  const authorBodyGap = hasAuthor ? spacing.xs : 0;

  return { width, height: headerHeight + infoHeight + authorBodyGap + textHeight + paddingV * 2 };
}

// ── Opacity computation (shared between main-thread and worker renderers) ──

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
 * Create an OpacityConfig from raw settings fields.
 * Centralizes the derived-value computation (invFadeDuration, ageFadeRate)
 * so the 3 render paths (Canvas2D main, Canvas2D worker, WebGL2 worker)
 * use the same calculation.
 */
export function createOpacityConfig(opts: {
  opacity: number;
  fadeDurationMs: number;
  maxMessageAgeMs: number;
  backlogOpacityMultiplier: number;
  depthLayersEnabled: boolean;
  depthFarOpacityMul: number;
}): OpacityConfig {
  return {
    baseOpacity: opts.opacity,
    fadeDurationMs: opts.fadeDurationMs,
    invFadeDuration: 1 / Math.max(1, opts.fadeDurationMs),
    backlogOpacityMultiplier: opts.backlogOpacityMultiplier,
    depthLayersEnabled: opts.depthLayersEnabled,
    depthFarOpacityMul: opts.depthFarOpacityMul,
    ageFadeRate: 1 / Math.max(1, opts.maxMessageAgeMs),
  };
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
  message: ChatMessage,
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

  if (message.isBacklog) opacity *= config.backlogOpacityMultiplier;

  if (config.depthLayersEnabled && speedTier === SPEED_TIER.FAR) {
    opacity *= config.depthFarOpacityMul;
  }

  const ageRatio = Math.min(1, elapsed * config.ageFadeRate);
  opacity *= Math.max(0, 1 - ageRatio);

  return opacity;
}
