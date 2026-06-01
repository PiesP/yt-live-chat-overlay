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
import type { CardConfig } from '@core/card-config';
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
import { getFontString, measureTextHeight } from '@core/text-measure';

// ── SuperChat card ───────────────────────────────────────────────────────────

/** Max cached gradients before LRU eviction. */
const GRADIENT_CACHE_MAX = 100;

/**
 * Get or create a cached linear gradient (top-to-bottom) with alpha stops.
 * Shared by both the legacy renderSuperChatCard and the new config-driven renderPaidCard.
 */
function getCachedGradient(
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
  // LRU eviction on overflow
  if (cache.size >= GRADIENT_CACHE_MAX) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, toRgba(baseColor, topAlpha));
  grad.addColorStop(0.48, toRgba(baseColor, scAlpha));
  grad.addColorStop(1, toRgba(baseColor, bottomAlpha));
  cache.set(key, grad);
  return grad;
}

/** Legacy wrapper — delegates to getCachedGradient. */
function getSuperChatGradient(
  ctx: CanvasRenderingContext2D,
  cache: Map<string, CanvasGradient>,
  baseColor: string,
  h: number,
  topAlpha: number,
  scAlpha: number,
  bottomAlpha: number
): CanvasGradient {
  return getCachedGradient(ctx, cache, baseColor, h, topAlpha, scAlpha, bottomAlpha);
}

// ── Config-driven card sub-renderers (Phase 2) ──────────────────────────────

/**
 * Render the card background: either a gradient or solid fill.
 * When mode is 'gradient', a cached linear gradient is created from the resolved
 * base color and pre-computed alpha values.
 */
function renderCardBackground(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  config: CardConfig,
  gradientCache: Map<string, CanvasGradient>,
  baseColor: string,
  topAlpha: number,
  scAlpha: number,
  bottomAlpha: number
): void {
  if (config.background === 'gradient' && gradientCache) {
    const grad = getCachedGradient(
      ctx,
      gradientCache,
      baseColor,
      h,
      topAlpha,
      scAlpha,
      bottomAlpha
    );
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = grad;
    drawRoundRect(ctx, 0, 0, w, h, config.cardRadius);
    ctx.fill();
    ctx.restore();
  } else if (config.backgroundColor) {
    const bg = config.backgroundColor;
    ctx.fillStyle = `rgba(${bg.r}, ${bg.g}, ${bg.b}, ${config.backgroundAlpha ?? 1})`;
    drawRoundRect(ctx, x, y, w, h, config.cardRadius);
    ctx.fill();
  }
}

/**
 * Render card decoration: accent bar or pulsing border.
 * Accent bar uses a clip-then-fillRect approach; pulsing border animates
 * the border stroke alpha with a sine wave.
 */
function renderCardDecoration(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  elapsed: number,
  config: CardConfig,
  message: ChatMessage,
  _baseColor: string
): void {
  if (config.decoration === 'accentBar' && config.accentBar) {
    const barColorRaw = config.accentBar.color;
    const barRgb = typeof barColorRaw === 'function' ? barColorRaw(message) : barColorRaw;
    ctx.save();
    ctx.translate(x, y);
    drawRoundRect(ctx, 0, 0, w, h, config.cardRadius);
    ctx.clip();
    ctx.fillStyle = `rgb(${barRgb.r}, ${barRgb.g}, ${barRgb.b})`;
    ctx.fillRect(0, 0, config.accentBar.width, h);
    ctx.restore();
  } else if (config.decoration === 'pulsingBorder' && config.pulsingBorder) {
    const pb = config.pulsingBorder;
    const pulse = Math.sin((elapsed / 1000) * Math.PI) * pb.amplitude + pb.baseAlpha;
    ctx.save();
    drawRoundRect(ctx, x, y, w, h, config.cardRadius);
    ctx.strokeStyle = `rgba(${pb.borderRgb.r}, ${pb.borderRgb.g}, ${pb.borderRgb.b}, ${pulse})`;
    ctx.lineWidth = pb.borderWidth;
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Render a header tag (e.g. membership tier/duration) with ellipsis truncation.
 * Uses strokeTextOutline + fillText with the configured headerTag color.
 * @returns The Y position after the header (including marginBottom).
 */
function renderCardHeaderTag(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  maxWidth: number,
  config: CardConfig,
  settings: OverlaySettings,
  _textBitmapCache: ByteLimitedCache<HTMLCanvasElement>,
  getFontFn: (fontSize: number) => string
): number {
  if (!config.headerTag) return y;
  const headerFontSize = Math.round(settings.fontSize * config.headerTag.fontSizeScale);
  const headerFont = getFontFn(headerFontSize);
  ctx.font = headerFont;
  ctx.textBaseline = 'top';

  let displayText = text;
  if (ctx.measureText(displayText).width > maxWidth) {
    while (displayText.length > 0 && ctx.measureText(`${displayText}…`).width > maxWidth) {
      displayText = displayText.slice(0, -1);
    }
    displayText += '…';
  }

  const tagY = y + (config.headerTag.marginTop ?? 0);
  strokeTextOutline(
    ctx,
    displayText,
    x,
    tagY,
    config.headerTag.color,
    settings.outline.widthPx,
    settings.outline.opacity
  );
  ctx.fillStyle = config.headerTag.color;
  ctx.fillText(displayText, x, tagY);

  const headerHeight = measureTextHeight(headerFont, headerFontSize);
  return tagY + headerHeight + (config.headerTag.marginBottom ?? 0);
}

/**
 * Render an amount badge pill (e.g. SuperChat amount) with rounded rectangle,
 * fill/stroke, and centered text.
 * @returns The Y position after the badge.
 */
function renderCardBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  fontSize: number,
  config: CardConfig,
  settings: OverlaySettings,
  _textBitmapCache2: ByteLimitedCache<HTMLCanvasElement>,
  getFontFn: (fontSize: number) => string
): number {
  if (!config.badge) return y;
  const badge = config.badge;
  const badgeFontSize = Math.round(fontSize * 0.7);
  ctx.font = getFontFn(badgeFontSize);
  const badgeTextWidth = Math.ceil(ctx.measureText(text).width);
  const badgeWidth = badgeTextWidth + badge.paddingH * 2;
  const badgeHeight = badgeFontSize + badge.paddingV * 2;

  drawRoundRect(ctx, x, y, badgeWidth, badgeHeight, badge.radius);
  ctx.fillStyle = badge.fillColor;
  ctx.fill();
  ctx.strokeStyle = badge.strokeColor;
  ctx.lineWidth = badge.strokeWidth;
  ctx.stroke();

  ctx.textBaseline = 'middle';
  strokeTextOutline(
    ctx,
    text,
    x + badge.paddingH,
    y + badgeHeight / 2,
    '#ffffff',
    settings.outline.widthPx,
    settings.outline.opacity
  );
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x + badge.paddingH, y + badgeHeight / 2);
  ctx.textBaseline = 'top';

  return y + badgeHeight;
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
  authorPhotoCache: ByteLimitedCache<HTMLImageElement>,
  stickerCache: ByteLimitedCache<HTMLImageElement>,
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
  // Background card with rounded corners
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = grad;
  drawRoundRect(ctx, 0, 0, w, h, rendererLayout.superchatCardRadius);
  ctx.fill();
  ctx.restore();

  // Left accent bar — clipped to card's rounded corners
  ctx.save();
  ctx.translate(x, y);
  drawRoundRect(ctx, 0, 0, w, h, rendererLayout.superchatCardRadius);
  ctx.clip();
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

  // Amount badge pill (conditionally rendered)
  let bodyStartY = contentY;
  if (settings.showSuperChatAmount) {
    const badgeY = contentY + spacing.xs;
    const badgeFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
    const badgeHeight = badgeFontSize + rendererLayout.superchatBadge.paddingV * 2;
    ctx.font = getFontString(badgeFontSize, settings.fontWeight, settings.fontFamily);
    const badgeTextWidth = Math.ceil(ctx.measureText(superChat.amount).width);
    const badgeWidth = badgeTextWidth + rendererLayout.superchatBadge.paddingH * 2;

    drawRoundRect(
      ctx,
      textX,
      badgeY,
      badgeWidth,
      badgeHeight,
      rendererLayout.superchatBadge.radius
    );
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
      settings.outline.widthPx,
      settings.outline.opacity
    );
    ctx.fillStyle = textColor;
    ctx.fillText(
      superChat.amount,
      textX + rendererLayout.superchatBadge.paddingH,
      badgeY + badgeHeight / 2
    );
    ctx.textBaseline = 'top';

    bodyStartY = badgeY + badgeHeight;
  }

  // Body text (content segments with emoji support)
  let textBottomY = bodyStartY;
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
  authorPhotoCache: ByteLimitedCache<HTMLImageElement>,
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
  ctx.strokeStyle = `rgba(${mem.borderRgb.r}, ${mem.borderRgb.g}, ${mem.borderRgb.b}, ${pulse})`;
  ctx.lineWidth = rendererLayout.membershipBorderWidth;
  ctx.stroke();

  const padH = rendererLayout.membership.paddingH;
  const padV = rendererLayout.membership.paddingV;
  const textX = x + padH;
  let textY = y + padV;

  // Membership tier/duration header tag
  if (message.membershipHeader) {
    const headerFontSize = Math.round(fontSize * 0.8);
    const headerFont = getFontFn(headerFontSize);
    ctx.font = headerFont;
    ctx.textBaseline = 'top';
    const headerMaxWidth = w - padH * 2;
    let displayText = message.membershipHeader;
    if (ctx.measureText(displayText).width > headerMaxWidth) {
      // Manual ellipsis truncation
      while (displayText.length > 0 && ctx.measureText(`${displayText}…`).width > headerMaxWidth) {
        displayText = displayText.slice(0, -1);
      }
      displayText += '…';
    }
    strokeTextOutline(
      ctx,
      displayText,
      textX,
      textY,
      designColors.membership.headerText,
      settings.outline.widthPx,
      settings.outline.opacity
    );
    ctx.fillStyle = designColors.membership.headerText;
    ctx.fillText(displayText, textX, textY);
    const headerHeight = measureTextHeight(headerFont, headerFontSize);
    textY += headerHeight + spacing.xs;
  }

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

// ── Config-driven unified paid card renderer (Phase 2) ─────────────────────

/**
 * Render a paid card (SuperChat or Membership) driven entirely by a
 * {@link CardConfig}. The config controls background, decoration, header
 * tag, badge, author section, body text, and sticker rendering.
 *
 * All state (colors, dimensions, decoration mode) is read from the config
 * rather than hard-coded, making this a single renderer for both card types.
 */
export function renderPaidCard(
  ctx: CanvasRenderingContext2D,
  message: ChatMessage,
  msgWidth: number,
  msgHeight: number,
  x: number,
  y: number,
  elapsed: number,
  config: CardConfig,
  settings: OverlaySettings,
  textBitmapCache: ByteLimitedCache<HTMLCanvasElement>,
  authorPhotoCache: ByteLimitedCache<HTMLImageElement>,
  stickerCache: ByteLimitedCache<HTMLImageElement>,
  emojiCache: ByteLimitedCache<HTMLImageElement>,
  getFontFn: (fontSize: number) => string,
  gradientCache: Map<string, CanvasGradient>
): void {
  const fontSize = settings.fontSize;
  const w = msgWidth;
  const h = msgHeight;

  // Resolve base colour from config
  const rgb = config.resolveColor(message);
  const baseColor = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  const textColor =
    config.textColor === 'auto' ? computeReadableTextColor(baseColor) : config.textColor;

  // Compute gradient opacities if background is gradient
  let topAlpha = 1;
  let scAlpha = 1;
  let bottomAlpha = 1;
  if (config.background === 'gradient' && config.backgroundGradient) {
    const bg = config.backgroundGradient;
    scAlpha = Math.min(1, Math.max(bg.minOpacity, settings.superChatOpacity));
    topAlpha = Math.min(1, scAlpha + bg.topBoost);
    bottomAlpha = Math.max(bg.minOpacity, scAlpha - bg.bottomReduction);
  }

  // 1. Background
  renderCardBackground(
    ctx,
    x,
    y,
    w,
    h,
    config,
    gradientCache,
    baseColor,
    topAlpha,
    scAlpha,
    bottomAlpha
  );

  // 2. Decoration
  renderCardDecoration(ctx, x, y, w, h, elapsed, config, message, baseColor);

  // 3. Content layout
  const padH = config.padding.horizontal;
  const padV = config.padding.vertical;
  const textX = x + padH;
  let cursorY = y + padV;

  // 4. Header tag
  if (config.headerTag?.enabled && config.headerTag.getText) {
    const headerText = config.headerTag.getText(message);
    if (headerText) {
      const headerMaxWidth = w - padH * 2;
      cursorY = renderCardHeaderTag(
        ctx,
        textX,
        cursorY,
        headerText,
        headerMaxWidth,
        config,
        settings,
        textBitmapCache,
        getFontFn
      );
    }
  }

  // 5. Author section
  const showAuthor =
    typeof config.authorSection.show === 'function'
      ? config.authorSection.show(message, settings)
      : config.authorSection.show;
  if (showAuthor && message.author) {
    cursorY = drawAuthorSection(
      ctx,
      message,
      textX,
      cursorY,
      textColor,
      config.authorSection.nameMaxWidth,
      settings,
      authorPhotoCache,
      textBitmapCache,
      getFontFn
    );
  }

  // 6. Badge (amount pill)
  if (config.badge?.enabled && config.badge.getText) {
    const badgeText = config.badge.getText(message);
    if (badgeText) {
      cursorY = renderCardBadge(
        ctx,
        textX,
        cursorY,
        badgeText,
        fontSize,
        config,
        settings,
        textBitmapCache,
        getFontFn
      );
    }
  }

  // 7. Body text (capture bottom Y for sticker placement)
  let textBottomY = cursorY;
  if (message.content.length > 0) {
    const bodyMaxWidth = w - padH * 2;
    const bodyMaxLines =
      config.body.maxLines === 'fromSettings'
        ? message.kind === 'superchat'
          ? settings.superChatMaxBodyLines
          : settings.membershipMaxBodyLines
        : config.body.maxLines;
    textBottomY = renderWrappedContentSegments(
      ctx,
      message.content,
      textX,
      cursorY + config.body.marginTop,
      bodyMaxWidth,
      bodyMaxLines,
      textColor,
      fontSize,
      settings,
      textBitmapCache,
      emojiCache,
      getFontFn
    );
  }

  // 8. Sticker
  if (config.sticker?.enabled && config.sticker.getUrl) {
    const stickerUrl = config.sticker.getUrl(message);
    if (stickerUrl) {
      const cached = stickerCache.get(stickerUrl);
      const stickerImg = cached?.complete && cached.naturalWidth > 0 ? cached : null;
      if (stickerImg) {
        const maxStickerSize = Math.round(fontSize * config.sticker.sizeScale);
        const stickerY = textBottomY + (config.sticker.marginTop ?? 0);
        const availableHeight = y + h - padV - stickerY;
        const stickerSize = Math.max(0, Math.min(maxStickerSize, availableHeight));
        if (stickerSize > 0) {
          ctx.drawImage(stickerImg, textX, stickerY, stickerSize, stickerSize);
        }
      }
    }
  }
}
