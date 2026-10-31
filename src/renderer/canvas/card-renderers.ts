// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * CanvasCardRenderers — card rendering functions extracted from CanvasTextRenderer.
 *
 * Renders SuperChat cards, Membership cards, author sections, and rounded
 * rectangle paths on a Canvas2D context.
 */
import type { ChatMessage, OverlaySettings } from '@app-types';
import type { ResizableByteLimitedCache } from '@piesp/browser-core/util';
import { resolveTextDirection } from '@renderer/canvas/bidi-layout';
import { type GradientCache, getCachedGradient } from '@renderer/canvas/gradient-utils';
import {
  drawAuthorSection,
  drawRoundRect,
  renderSegment,
  renderWrappedContentSegments,
  splitGraphemeClusters,
} from '@renderer/canvas/shared';
import { type CardConfig, resolveCardBorderAlpha } from '@renderer/card-config';
import { computeOutlineColor, computeReadableTextColor } from '@renderer/color-utils';
import { preparePaidCardPlan } from '@renderer/layout/paid-card-plan';
import { getFontString, measureTextHeight } from '@renderer/text-measure';
import { rendererLayout } from '@util/design-tokens';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Draw a path with only the LEFT corners rounded; RIGHT corners are sharp.
 * Follows the same beginPath/arcTo pattern as drawRoundRect but omits
 * right-side curves. Useful for accent bars and similar left-edge-only
 * decorative elements.
 */
export function drawLeftRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  // Top edge (left to right, sharp top-right corner)
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w, y);
  // Right edge (straight down, sharp bottom-right corner)
  ctx.lineTo(x + w, y + h);
  // Bottom edge (right to left, up to bottom-left curve start)
  ctx.lineTo(x + r, y + h);
  // Bottom-left curve
  ctx.arcTo(x, y + h, x, y + h - r, r);
  // Left edge (up)
  ctx.lineTo(x, y + r);
  // Top-left curve
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// ── SuperChat card ───────────────────────────────────────────────────────────

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
  gradientCache: GradientCache,
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
    ctx.save();
    const bg = config.backgroundColor;
    ctx.fillStyle = `rgba(${bg.r}, ${bg.g}, ${bg.b}, ${config.backgroundAlpha ?? 1})`;
    drawRoundRect(ctx, x, y, w, h, config.cardRadius);
    ctx.fill();
    ctx.restore();
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
  _baseColor: string,
  reducedMotion: boolean
): void {
  if (config.decoration === 'accentBar' && config.accentBar) {
    const barColorRaw = config.accentBar.color;
    const barRgb = typeof barColorRaw === 'function' ? barColorRaw(message) : barColorRaw;
    const barWidth = config.accentBar.width;
    ctx.fillStyle = `rgb(${barRgb.r}, ${barRgb.g}, ${barRgb.b})`;
    drawLeftRoundedRect(ctx, x, y, barWidth, h, config.cardRadius);
    ctx.fill();
  } else if (config.decoration === 'pulsingBorder' && config.pulsingBorder) {
    const pb = config.pulsingBorder;
    const pulse = resolveCardBorderAlpha(elapsed, pb, reducedMotion);
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
  _textBitmapCache: ResizableByteLimitedCache<HTMLCanvasElement>,
  getFontFn: (fontSize: number) => string
): number {
  if (!config.headerTag) return y;
  const headerFontSize = Math.round(settings.fontSize * config.headerTag.fontSizeScale);
  const headerFont = getFontFn(headerFontSize);
  ctx.font = headerFont;
  ctx.textBaseline = 'top';

  let displayText = text;
  if (ctx.measureText(displayText).width > maxWidth) {
    const clusters = splitGraphemeClusters(displayText);
    let lo = 0,
      hi = clusters.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (ctx.measureText(`${clusters.slice(0, mid).join('')}…`).width > maxWidth) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    displayText = lo > 0 ? `${clusters.slice(0, lo - 1).join('')}…` : '';
  }

  const tagY = y + (config.headerTag.marginTop ?? 0);
  // Route through renderSegment for bitmap caching (fixes #9)
  if (displayText)
    renderSegment(
      ctx,
      displayText,
      x,
      tagY,
      config.headerTag.color,
      headerFontSize,
      settings.outline.enabled ? settings.outline.widthPx : 0,
      settings.outline.enabled ? settings.outline.opacity : 0,
      _textBitmapCache,
      getFontFn
    );

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
  _textBitmapCache2: ResizableByteLimitedCache<HTMLCanvasElement>,
  reservedWidth: number,
  foreground: string
): number {
  if (!config.badge) return y;
  const badge = config.badge;
  ctx.save();
  const badgeFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
  const badgeFont = getFontString(badgeFontSize, 'bold', settings.fontFamily);
  ctx.font = badgeFont;
  const badgeTextWidth = Math.ceil(ctx.measureText(text).width);
  const badgeWidth = Math.min(reservedWidth, badgeTextWidth + badge.paddingH * 2);
  const badgeHeight = badgeFontSize + badge.paddingV * 2;

  drawRoundRect(ctx, x, y, badgeWidth, badgeHeight, badge.radius);
  ctx.fillStyle = badge.fillColor;
  ctx.fill();
  ctx.strokeStyle = badge.strokeColor;
  ctx.lineWidth = badge.strokeWidth;
  ctx.stroke();

  // renderSegment always uses textBaseline='top' (bitmap cache + fallback),
  // so we must compute the Y coordinate for top-aligned text that is
  // visually centered within the badge rectangle.
  const textHeight = measureTextHeight(badgeFont, badgeFontSize);
  const textY = y + (badgeHeight - textHeight) / 2;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.direction = resolveTextDirection(text);
  ctx.fillStyle = foreground;
  const textWidth = Math.max(0, badgeWidth - badge.paddingH * 2);
  if (settings.outline.enabled && settings.outline.widthPx > 0) {
    ctx.strokeStyle = computeOutlineColor(foreground, settings.outline.opacity);
    ctx.lineWidth = settings.outline.widthPx;
    ctx.strokeText(text, x + badge.paddingH, textY, textWidth);
  }
  ctx.fillText(text, x + badge.paddingH, textY, textWidth);
  ctx.restore();

  return y + badgeHeight;
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
  textBitmapCache: ResizableByteLimitedCache<HTMLCanvasElement>,
  authorPhotoCache: ResizableByteLimitedCache<HTMLImageElement>,
  stickerCache: ResizableByteLimitedCache<HTMLImageElement>,
  emojiCache: ResizableByteLimitedCache<HTMLImageElement>,
  getFontFn: (fontSize: number) => string,
  gradientCache: GradientCache,
  translatedText?: string | null,
  reducedMotion = false
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
  renderCardDecoration(ctx, x, y, w, h, elapsed, config, message, baseColor, reducedMotion);

  // 3. Content layout
  const padH = config.padding.horizontal;
  const padV = config.padding.vertical;
  const textX = x + padH;
  const showAuthor =
    typeof config.authorSection.show === 'function'
      ? config.authorSection.show(message, settings)
      : config.authorSection.show;
  const plan = preparePaidCardPlan({
    kind: message.kind === 'superchat' ? 'superchat' : 'membership',
    width: w,
    fontSize,
    fontWeight: settings.fontWeight,
    fontFamily: settings.fontFamily,
    paddingH: padH,
    paddingV: padV,
    author: message.author,
    authorPhotoUrl: message.authorPhotoUrl,
    showAuthor,
    amount: message.superChat?.amount,
    showAmount: settings.showSuperChatAmount,
    membershipHeader: message.membershipHeader,
    content: message.content,
    translatedText,
    maxBodyLines:
      message.kind === 'superchat'
        ? settings.superChatMaxBodyLines
        : settings.membershipMaxBodyLines,
    outlineWidthPx: settings.outline.enabled ? settings.outline.widthPx : 0,
    wide: settings.superChatLayout === 'wide',
    sticker: !!message.superChat?.sticker,
    measure: (text, font, direction) => {
      const previous = ctx.font;
      const previousDirection = ctx.direction;
      ctx.font = font;
      ctx.direction = direction ?? 'ltr';
      const width = ctx.measureText(text).width;
      ctx.font = previous;
      ctx.direction = previousDirection;
      return width;
    },
    context: ctx,
  });

  // 4. Author section (name + photo) — rendered first so name appears above amount/duration
  if (plan.authorY !== undefined) {
    drawAuthorSection(
      ctx,
      message,
      textX,
      y + plan.authorY,
      textColor,
      plan.authorMaxWidth,
      Math.round(settings.fontSize * rendererLayout.authorFontScale),
      settings.fontWeight,
      settings.fontFamily,
      settings.outline.enabled ? settings.outline.widthPx : 0,
      settings.outline.enabled ? settings.outline.opacity : 0,
      authorPhotoCache,
      isReadyHtmlImage,
      textBitmapCache,
      getFontFn
    );
  }

  // 5. Header tag (tier name / membership duration)
  if (config.headerTag?.getText && plan.headerY !== undefined) {
    const headerText = config.headerTag.getText(message);
    if (headerText) {
      const headerMaxWidth = w - padH * 2;
      renderCardHeaderTag(
        ctx,
        textX,
        y + plan.headerY,
        headerText,
        headerMaxWidth,
        config,
        settings,
        textBitmapCache,
        getFontFn
      );
    }
  }

  // 6. Badge (amount pill) — respects showSuperChatAmount setting
  if (config.badge?.getText && plan.amountY !== undefined && plan.amountX !== undefined) {
    const badgeText = config.badge.getText(message);
    if (badgeText) {
      renderCardBadge(
        ctx,
        x + plan.amountX,
        y + plan.amountY,
        badgeText,
        fontSize,
        config,
        settings,
        textBitmapCache,
        plan.amountWidth,
        textColor
      );
    }
  }

  // 7. Body text (capture bottom Y for sticker placement)
  if (plan.bodyY !== undefined && plan.body) {
    const bodyMaxWidth = w - padH * 2;
    renderWrappedContentSegments(
      ctx,
      message.content,
      textX,
      y + plan.bodyY,
      bodyMaxWidth,
      plan.body.lines.length,
      textColor,
      fontSize,
      settings.outline.enabled ? settings.outline.widthPx : 0,
      settings.outline.enabled ? settings.outline.opacity : 0,
      textBitmapCache,
      emojiCache as ResizableByteLimitedCache<CanvasImageSource>,
      getFontFn,
      undefined,
      plan.body
    );
  }

  if (plan.translationY !== undefined && plan.translation && translatedText) {
    const translationSize = Math.max(1, Math.round(fontSize * 0.85));
    const translationFont = getFontString(translationSize, 'normal', settings.fontFamily);
    renderWrappedContentSegments(
      ctx,
      [{ type: 'text', content: translatedText }],
      textX,
      y + plan.translationY,
      plan.innerWidth,
      plan.translation.lines.length,
      textColor,
      translationSize,
      settings.outline.enabled ? settings.outline.widthPx : 0,
      settings.outline.enabled ? settings.outline.opacity : 0,
      textBitmapCache,
      emojiCache as ResizableByteLimitedCache<CanvasImageSource>,
      () => translationFont,
      undefined,
      plan.translation
    );
  }

  // 8. Sticker
  if (config.sticker?.getUrl) {
    const stickerUrl = config.sticker.getUrl(message);
    if (stickerUrl) {
      const cached = stickerCache.get(stickerUrl);
      const stickerImg = cached?.complete && cached.naturalWidth > 0 ? cached : null;
      if (stickerImg) {
        const maxStickerSize = Math.round(fontSize * config.sticker.sizeScale);
        const stickerY = y + (plan.stickerY ?? 0);
        const availableHeight = y + h - padV - stickerY;
        const stickerSize = Math.max(
          0,
          Math.min(maxStickerSize, plan.stickerSize, availableHeight)
        );
        if (stickerSize > 0) {
          const scale = Math.min(
            stickerSize / stickerImg.naturalWidth,
            stickerSize / stickerImg.naturalHeight
          );
          ctx.drawImage(
            stickerImg,
            textX,
            stickerY,
            stickerImg.naturalWidth * scale,
            stickerImg.naturalHeight * scale
          );
        }
      }
    }
  }
}

function isReadyHtmlImage(photo: HTMLImageElement): boolean {
  return photo.complete && photo.naturalWidth > 0;
}
