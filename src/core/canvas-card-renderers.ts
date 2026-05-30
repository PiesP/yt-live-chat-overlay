// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * CanvasCardRenderers — card rendering functions extracted from CanvasTextRenderer.
 *
 * Renders SuperChat cards, Membership cards, author sections, and rounded
 * rectangle paths on a Canvas2D context.
 */

import type { ChatMessage, OverlaySettings } from '@app-types';
import type { ByteLimitedCache } from '@core/byte-limited-cache';
import {
  drawAuthorSection,
  drawRoundRect,
  renderWrappedContentSegments,
  strokeTextOutline,
} from '@core/canvas-text-renderer';
import { computeReadableTextColor, toRgba } from '@core/color-utils';
import {
  computeSuperChatOpacities,
  colors as designColors,
  rendererLayout,
  resolveSuperChatRgb,
  SUPERCHAT_AMOUNT_BADGE_FILL,
  SUPERCHAT_AMOUNT_BADGE_STROKE,
  spacing,
} from '@core/design-tokens';
import { getFontString } from '@core/text-measure';

// ── SuperChat card ───────────────────────────────────────────────────────────

/** Get or create a cached SuperChat background gradient (relative to origin). */
function getSuperChatGradient(
  ctx: CanvasRenderingContext2D,
  cache: Map<string, CanvasGradient>,
  baseColor: string,
  h: number,
  topAlpha: number,
  scAlpha: number,
  bottomAlpha: number
): CanvasGradient {
  const key = `${baseColor}|${h}|${topAlpha}|${scAlpha}|${bottomAlpha}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, toRgba(baseColor, topAlpha));
  grad.addColorStop(0.48, toRgba(baseColor, scAlpha));
  grad.addColorStop(1, toRgba(baseColor, bottomAlpha));
  cache.set(key, grad);
  return grad;
}

/** Render a SuperChat card at (x, y) with alpha blending. */
export function renderSuperChatCard(
  ctx: CanvasRenderingContext2D,
  message: ChatMessage,
  msgWidth: number,
  msgHeight: number,
  x: number,
  y: number,
  settings: OverlaySettings,
  textBitmapCache: ByteLimitedCache<HTMLCanvasElement>,
  authorPhotoCache: Map<string, HTMLImageElement>,
  stickerCache: Map<string, HTMLImageElement>,
  emojiCache: ByteLimitedCache<HTMLImageElement>,
  getFontFn: (fontSize: number) => string,
  superChatGradientCache: Map<string, CanvasGradient>
): void {
  const superChat = message.superChat;
  if (!superChat) return;

  const fontSize = settings.fontSize;
  const w = msgWidth;
  const h = msgHeight;

  // globalAlpha is set by the caller (opacity-batched outer loop)

  const {
    base: scAlpha,
    top: topAlpha,
    bottom: bottomAlpha,
  } = computeSuperChatOpacities(settings.superChatOpacity);
  const rgb = resolveSuperChatRgb(superChat, designColors.superChat);
  const baseColor = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  const textColor = computeReadableTextColor(baseColor);

  // Background gradient (cached per color/dimension to avoid per-frame allocation)
  const grad = getSuperChatGradient(
    ctx,
    superChatGradientCache,
    baseColor,
    h,
    topAlpha,
    scAlpha,
    bottomAlpha
  );
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = grad;
  drawRoundRect(ctx, 0, 0, w, h, rendererLayout.superchatCardRadius);
  ctx.fill();
  // Left accent bar (relative to translated origin)
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, rendererLayout.superchatAccentBarWidth, h);
  ctx.restore();

  const scPad = rendererLayout.superchat;
  const textX = x + scPad.paddingH;
  let contentY = y + scPad.paddingV;

  // Author section
  if (settings.showAuthor.superChat && message.author) {
    const nameMaxWidth = w - scPad.paddingH * 2;
    contentY = drawAuthorSection(
      ctx,
      message,
      textX,
      contentY,
      textColor,
      nameMaxWidth,
      settings,
      authorPhotoCache,
      textBitmapCache,
      getFontFn
    );
  }

  // Amount badge pill
  const badgeY = contentY + spacing.xs;
  const badgeFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
  const badgeHeight = badgeFontSize + rendererLayout.superchatBadge.paddingV * 2;
  ctx.font = getFontString(badgeFontSize, 'bold', settings.fontFamily);
  const badgeTextWidth = Math.ceil(ctx.measureText(superChat.amount).width);
  const badgeWidth = badgeTextWidth + rendererLayout.superchatBadge.paddingH * 2;

  drawRoundRect(ctx, textX, badgeY, badgeWidth, badgeHeight, rendererLayout.superchatBadge.radius);
  ctx.fillStyle = SUPERCHAT_AMOUNT_BADGE_FILL;
  ctx.fill();
  ctx.strokeStyle = SUPERCHAT_AMOUNT_BADGE_STROKE;
  ctx.lineWidth = rendererLayout.superchatBadgeStrokeWidth;
  ctx.stroke();

  ctx.textBaseline = 'middle';
  strokeTextOutline(
    ctx,
    superChat.amount,
    textX + rendererLayout.superchatBadge.paddingH,
    badgeY + badgeHeight / 2,
    textColor,
    settings
  );
  ctx.fillStyle = textColor;
  ctx.fillText(
    superChat.amount,
    textX + rendererLayout.superchatBadge.paddingH,
    badgeY + badgeHeight / 2
  );
  ctx.textBaseline = 'top';

  // Body text (content segments with emoji support)
  let textBottomY = badgeY + badgeHeight;
  if (message.content.length > 0) {
    const bodyMaxWidth = w - scPad.paddingH * 2;
    textBottomY = renderWrappedContentSegments(
      ctx,
      message.content,
      textX,
      textBottomY + spacing.xs,
      bodyMaxWidth,
      settings.superChatMaxBodyLines,
      textColor,
      fontSize,
      settings,
      textBitmapCache,
      emojiCache,
      getFontFn
    );
  }

  // Sticker
  if (superChat.sticker) {
    const cached = stickerCache.get(superChat.sticker.url);
    const stickerImg = cached?.complete && cached.naturalWidth > 0 ? cached : null;
    if (stickerImg) {
      const maxStickerSize = Math.round(fontSize * rendererLayout.superchatStickerSize);
      const stickerY = textBottomY + spacing.xs;
      const availableHeight = y + h - scPad.paddingV - stickerY;
      const stickerSize = Math.max(0, Math.min(maxStickerSize, availableHeight));
      if (stickerSize > 0) {
        ctx.drawImage(stickerImg, textX, stickerY, stickerSize, stickerSize);
      }
    }
  }
}

/** Render a Membership card at (x, y) with alpha blending. */
export function renderMembershipCard(
  ctx: CanvasRenderingContext2D,
  message: ChatMessage,
  msgWidth: number,
  msgHeight: number,
  x: number,
  y: number,
  elapsed: number,
  settings: OverlaySettings,
  textBitmapCache: ByteLimitedCache<HTMLCanvasElement>,
  authorPhotoCache: Map<string, HTMLImageElement>,
  emojiCache: ByteLimitedCache<HTMLImageElement>,
  getFontFn: (fontSize: number) => string
): void {
  const fontSize = settings.fontSize;
  const w = msgWidth;
  const h = msgHeight;
  const mem = designColors.membership;

  // globalAlpha is set by the caller (opacity-batched outer loop)

  ctx.fillStyle = `rgba(${mem.background.r}, ${mem.background.g}, ${mem.background.b}, ${mem.backgroundAlpha})`;
  drawRoundRect(ctx, x, y, w, h, rendererLayout.membershipCardRadius);
  ctx.fill();

  const pulse = Math.sin((elapsed / 1000) * Math.PI) * mem.borderAlphaAmplitude + mem.borderAlpha;
  ctx.strokeStyle = `rgba(${mem.background.r}, ${mem.background.g}, ${mem.background.b}, ${pulse})`;
  ctx.lineWidth = rendererLayout.membershipBorderWidth;
  ctx.stroke();

  const padH = rendererLayout.membership.paddingH;
  const padV = rendererLayout.membership.paddingV;
  const textX = x + padH;
  let textY = y + padV;

  if (message.author) {
    const nameMaxWidth = w - padH * 2;
    textY = drawAuthorSection(
      ctx,
      message,
      textX,
      textY,
      designColors.membership.text,
      nameMaxWidth,
      settings,
      authorPhotoCache,
      textBitmapCache,
      getFontFn
    );
  }

  if (message.content.length > 0) {
    const bodyMaxWidth = w - padH * 2;
    const bodyY = message.author ? textY + spacing.xs : textY;
    renderWrappedContentSegments(
      ctx,
      message.content,
      textX,
      bodyY,
      bodyMaxWidth,
      settings.membershipMaxBodyLines,
      designColors.membership.text,
      fontSize,
      settings,
      textBitmapCache,
      emojiCache,
      getFontFn
    );
  }
}
