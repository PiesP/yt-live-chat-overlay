// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * RendererWorker — OffscreenCanvas-based render loop running in a Web Worker.
 *
 * Offloads Canvas 2D rendering from the main thread. The main thread handles
 * DOM observation, API polling, and translation; the worker runs its own rAF
 * loop for rendering, lane allocation, and message lifecycle.
 *
 * ## Protocol
 *
 * Main → Worker:
 *   { type: 'init', canvas: OffscreenCanvas, config: WorkerConfig }
 *   { type: 'resize', width: number, height: number, dpr: number }
 *   { type: 'addMessages', messages: WorkerMessage[] }
 *   { type: 'updateConfig', config: Partial<WorkerConfig> }
 *   { type: 'setPaused', paused: boolean }
 *   { type: 'snapshotMessages', requestId: number }
 *   { type: 'destroy' }
 *
 * Worker → Main:
 *   { type: 'stats', activeMessages: number, drops: number }
 *
 * ## WorkerConfig
 *
 * A minimal subset of OverlaySettings needed by the render loop.
 * The main thread serializes relevant settings into this flat config shape.
 */

/// <reference lib="webworker" />

import type { FontWeight } from '@app-types';
import { EMOJI_CACHE_MAX_ENTRIES, getStickerCacheBytes } from '@media/cache-limits';
import { isAllowedImageUrl } from '@media/image-url-validation';
import { getCachedGradient } from '@renderer/canvas/gradient-utils';
import { computePulseAlpha } from '@renderer/canvas/lut-helpers';
import {
  addMessageToLaneIndex,
  fastRandom,
  removeMessageFromLaneIndex,
} from '@renderer/canvas/pipeline-utils';
import {
  drawAuthorSection,
  drawRoundRect,
  getDisplayText,
  getSafeTextHeight,
  type RegularMessageRenderConfig,
  renderRegularMessage,
  renderSegment,
  renderWrappedContentSegments,
  splitGraphemeClusters,
  strokeTextOutline,
  type TextBitmapCache,
  warmTextBitmapCache,
} from '@renderer/canvas/shared';
import { getSpeedTier } from '@renderer/canvas/speed-tier';
import type { CardConfigWorker } from '@renderer/card-config';
import { desaturateColor } from '@renderer/color-utils';
import {
  ANTI_BLOCK_FREE_RATIO,
  ANTI_BLOCK_MAX_DURATION_MS,
  ANTI_BLOCK_PRIORITY_THRESHOLD,
  EMOJI_FETCH_TIMEOUT_DEFAULT_MS,
  FAR_LAYER_DESATURATION_FACTOR,
  GRADIENT_CACHE_MAX,
  IDLE_GRACE_PERIOD_MS,
  OPACITY_BUCKET_COUNT as OPACITY_BUCKETS,
  SPEED_TIER,
  TRANSLATION_FONT_SCALE,
  TRANSLATION_OPACITY_SCALE,
} from '@renderer/constants';
import { getAuthorNameMaxWidth, getRegularCardInsets } from '@renderer/layout/card-layout';
import {
  buildLaneHeap,
  commitPlacementShared,
  computeBaseHeadwayPx,
  computeLaneY,
  computeOccupancyMs as computeOccupancyMsShared,
  findPlacementShared,
  type LaneAllocationState,
  resetBatchShared,
  shiftLaneTimersShared,
} from '@renderer/layout/lane-shared';
import type { LaneSelectionStrategy } from '@renderer/layout/lane-shared';
import { computeMessageMotionPlan } from '@renderer/layout/message-schedule';
import {
  computeAgeFadeRate,
  computeInvFadeDuration,
  computeMessageOpacity,
  type OpacityConfig,
} from '@renderer/shared';
import { getFontString, measureBoundingBoxWidth } from '@renderer/text-measure';
import { DEFAULT_SETTINGS } from '@settings/defaults';
import { ResizableByteLimitedCache } from '@util/byte-limited-cache';
import {
  computeScrollDuration,
  DEFAULT_FONT_FAMILY,
  DEFAULT_TEXT_COLOR,
  rendererLayout,
  spacing,
} from '@util/design-tokens';
import { MapCompatibleLruMap } from '@util/lru-map';
import { isValidControlMessage } from './protocol-guards';

import type { ActiveMessage, WorkerConfig, WorkerContentSegment, WorkerMessage } from './types';

// ── Worker-specific constants ──────────────────────────────────────────────

/** Sticker image cache — lazily initialized during worker init. */
let stickerCache: ResizableByteLimitedCache<ImageBitmap> | null = null;

function isAvailableImage(image: unknown): boolean {
  return image != null;
}

function measureTextHeight(
  fontSize: number,
  font: string,
  ctx?: OffscreenCanvasRenderingContext2D
): number {
  if (ctx) {
    ctx.font = font;
    const m = ctx.measureText('Mg');
    const ascent = Math.max(0, m.actualBoundingBoxAscent);
    const descent = Math.max(0, m.actualBoundingBoxDescent);
    if (ascent > 0 && descent > 0) return Math.ceil(ascent + descent);
  }
  return Math.ceil(fontSize * 1.1);
}

// ── Config-driven paid card renderer (worker variant) ────────────────────────

/**
 * Render a paid card (SuperChat or Membership) driven entirely by a
 * CardConfigWorker. Mirrors the main-thread renderPaidCard but uses worker-safe
 * types (OffscreenCanvasRenderingContext2D, ResizableByteLimitedCache<ImageBitmap>).
 *
 * All colours, dimensions, and flags are pre-resolved in the CardConfigWorker
 * — no callbacks or settings lookups needed.
 */
function renderPaidCardWorker(
  ctx: OffscreenCanvasRenderingContext2D,
  message: ActiveMessage,
  content: readonly WorkerContentSegment[],
  msgWidth: number,
  msgHeight: number,
  x: number,
  y: number,
  elapsed: number,
  card: CardConfigWorker,
  fontSize: number,
  fontWeight: string,
  fontFamily: string,
  outlineWidthPx: number,
  outlineOpacity: number,
  textBitmapCache: TextBitmapCache,
  authorPhotoCache: ResizableByteLimitedCache<ImageBitmap>,
  emojiCache: ResizableByteLimitedCache<ImageBitmap>,
  getFontFn: (fontSize: number) => string,
  gradientCache: Map<string, CanvasGradient>,
  /** Configurable SuperChat opacity from settings, clamped to [0.35, 1]. */
  superChatOpacity: number
): void {
  const w = msgWidth;
  const h = msgHeight;

  // ── 1. Resolve base colour ────────────────────────────────────────────
  const rgb = card.resolveColorRgb;
  const baseColor = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  const textColor = card.textColor;

  // Compute gradient opacities if background is gradient
  // scAlpha is declared here (with default 1) and reassigned inside the
  // gradient block below. A separate `if` with the same condition reads it,
  // so TS needs definite assignment outside the first `if`.
  let topAlpha = 1;
  let scAlpha = 1;
  let bottomAlpha = 1;
  if (card.background === 'gradient' && card.backgroundGradient) {
    const bg = card.backgroundGradient;
    scAlpha = Math.min(1, Math.max(bg.minOpacity, superChatOpacity));
    topAlpha = Math.min(1, scAlpha + bg.topBoost);
    bottomAlpha = Math.max(bg.minOpacity, scAlpha - bg.bottomReduction);
  }

  // ── 2. Background ─────────────────────────────────────────────────────
  if (card.background === 'gradient' && card.backgroundGradient) {
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
    drawRoundRect(ctx, 0, 0, w, h, card.cardRadius);
    ctx.fill();
    ctx.restore();
  } else if (card.backgroundColor) {
    const bg = card.backgroundColor;
    ctx.save();
    ctx.fillStyle = `rgba(${bg.r}, ${bg.g}, ${bg.b}, ${card.backgroundAlpha ?? 1})`;
    drawRoundRect(ctx, x, y, w, h, card.cardRadius);
    ctx.fill();
    ctx.restore();
  }

  // ── 3. Decoration ─────────────────────────────────────────────────────
  if (card.decoration === 'accentBar' && card.accentBar) {
    const barRgb = card.accentBar.color;
    ctx.save();
    ctx.fillStyle = `rgb(${barRgb.r}, ${barRgb.g}, ${barRgb.b})`;
    // Dedicated left-rounded rect — avoids ctx.clip() which forces save/restore
    // and recomputes the rasterizer clip mask.
    ctx.beginPath();
    ctx.moveTo(x + card.cardRadius, y);
    ctx.lineTo(x + card.accentBar.width, y);
    ctx.lineTo(x + card.accentBar.width, y + h);
    ctx.lineTo(x + card.cardRadius, y + h);
    ctx.arcTo(x, y + h, x, y + h - card.cardRadius, card.cardRadius);
    ctx.lineTo(x, y + card.cardRadius);
    ctx.arcTo(x, y, x + card.cardRadius, y, card.cardRadius);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else if (card.decoration === 'pulsingBorder' && card.pulsingBorder) {
    const pb = card.pulsingBorder;
    const pulse = computePulseAlpha(elapsed, pb.baseAlpha, pb.amplitude);
    ctx.save();
    drawRoundRect(ctx, x, y, w, h, card.cardRadius);
    ctx.strokeStyle = `rgba(${pb.borderRgb.r}, ${pb.borderRgb.g}, ${pb.borderRgb.b}, ${pulse})`;
    ctx.lineWidth = pb.borderWidth;
    ctx.stroke();
    ctx.restore();
  }

  // ── 4. Content layout ─────────────────────────────────────────────────
  const padH = card.padding.horizontal;
  const padV = card.padding.vertical;
  const textX = x + padH;
  let cursorY = y + padV;

  // ── 5. Author section (name + photo) — rendered first so name appears above amount/duration
  if (card.authorShow && message.author) {
    const authorNameMaxWidth = getAuthorNameMaxWidth(
      w - padH * 2,
      card.authorNameMaxWidth,
      message.authorPhotoUrl
    );
    cursorY = drawAuthorSection(
      ctx,
      message,
      textX,
      cursorY,
      textColor,
      authorNameMaxWidth,
      Math.round(fontSize * rendererLayout.authorFontScale),
      fontWeight,
      fontFamily,
      outlineWidthPx,
      outlineOpacity,
      authorPhotoCache,
      isAvailableImage,
      textBitmapCache,
      getFontFn
    );
  }

  // ── 6. Header tag (tier name / membership duration)
  if (card.headerTagEnabled && message.membershipHeader) {
    const headerFontSize = Math.round(fontSize * card.headerTagFontSizeScale);
    const headerFont = getFontString(headerFontSize, fontWeight as FontWeight, fontFamily);
    ctx.save();
    ctx.font = headerFont;
    ctx.textBaseline = 'top';
    const headerMaxWidth = w - padH * 2;
    let displayText = message.membershipHeader;
    if (ctx.measureText(displayText).width > headerMaxWidth) {
      const graphemes = splitGraphemeClusters(displayText);
      let lo = 0,
        hi = graphemes.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (ctx.measureText(`${graphemes.slice(0, mid).join('')}…`).width > headerMaxWidth) {
          hi = mid;
        } else {
          lo = mid + 1;
        }
      }
      displayText = lo > 0 ? `${graphemes.slice(0, lo - 1).join('')}…` : '…';
    }
    strokeTextOutline(
      ctx,
      displayText,
      textX,
      cursorY + card.headerTagMarginTop,
      card.headerTagColor,
      outlineWidthPx,
      outlineOpacity
    );
    ctx.fillStyle = card.headerTagColor;
    ctx.fillText(displayText, textX, cursorY + card.headerTagMarginTop);
    ctx.restore();
    const headerHeight = measureTextHeight(headerFontSize, headerFont, ctx);
    cursorY += headerHeight + card.headerTagMarginTop + card.headerTagMarginBottom;
  }

  // ── 7. Badge (amount pill) — respects showSuperChatAmount setting
  if (card.badgeEnabled && card.showBadgeAmount && message.superChatAmount) {
    cursorY += spacing.xs;
    const badgeFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
    const badgeFont = getFontString(badgeFontSize, 'bold' as FontWeight, fontFamily);
    ctx.font = badgeFont;
    const badgeTextWidth = Math.ceil(ctx.measureText(message.superChatAmount).width);
    const badgeWidth = badgeTextWidth + card.badgePaddingH * 2;
    const badgeHeight = badgeFontSize + card.badgePaddingV * 2;

    drawRoundRect(ctx, textX, cursorY, badgeWidth, badgeHeight, card.badgeRadius);
    const prevFillStyle = ctx.fillStyle;
    const prevStrokeStyle = ctx.strokeStyle;
    const prevLineWidth = ctx.lineWidth;
    ctx.fillStyle = card.badgeFillColor;
    ctx.fill();
    ctx.strokeStyle = card.badgeStrokeColor;
    ctx.lineWidth = card.badgeStrokeWidth;
    ctx.stroke();

    ctx.textBaseline = 'middle';
    strokeTextOutline(
      ctx,
      message.superChatAmount,
      textX + card.badgePaddingH,
      cursorY + badgeHeight / 2,
      DEFAULT_TEXT_COLOR,
      outlineWidthPx,
      outlineOpacity
    );
    ctx.fillStyle = DEFAULT_TEXT_COLOR;
    ctx.fillText(message.superChatAmount, textX + card.badgePaddingH, cursorY + badgeHeight / 2);
    ctx.textBaseline = 'top';
    ctx.fillStyle = prevFillStyle;
    ctx.strokeStyle = prevStrokeStyle;
    ctx.lineWidth = prevLineWidth;

    cursorY += badgeHeight;
  }

  // ── 8. Body text ──────────────────────────────────────────────────────
  let textBottomY = cursorY;
  if (content.length > 0) {
    const bodyMaxWidth = w - padH * 2;
    textBottomY = renderWrappedContentSegments(
      ctx,
      content,
      textX,
      cursorY + card.bodyMarginTop,
      bodyMaxWidth,
      card.bodyMaxLines,
      textColor,
      fontSize,
      outlineWidthPx,
      outlineOpacity,
      textBitmapCache,
      emojiCache as ResizableByteLimitedCache<CanvasImageSource>,
      getFontFn
    );
  }

  // ── 9. Sticker (skip if no URL — worker doesn't have sticker cache) ────
  if (card.stickerEnabled && message.superChatStickerUrl) {
    // Sticker images are handled via the main thread's imageData transfer.
    // Render if available in stickerCache.
    const stickerImg = stickerCache?.get(message.superChatStickerUrl);
    if (stickerImg) {
      const maxStickerSize = Math.round(fontSize * card.stickerSizeScale);
      const stickerY = textBottomY + (card.stickerMarginTop ?? 0);
      const availableHeight = y + h - padV - stickerY;
      const stickerSize = Math.max(0, Math.min(maxStickerSize, availableHeight));
      if (stickerSize > 0) {
        ctx.drawImage(stickerImg, textX, stickerY, stickerSize, stickerSize);
      }
    }
  }
}

export class WorkerRenderer {
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private canvas: OffscreenCanvas | null = null;
  private config: WorkerConfig | null = null;
  private animFrameId: number | null = null;
  private isDestroyed = false;
  private isPaused = false;
  private isUserPaused = false;
  private pauseStartTime = 0;
  private antiBlockStartTime = 0;
  private invFadeMs = 0;
  private ageFadeRate = 0;
  private opacityConfig: OpacityConfig | null = null;
  private boundGetFont: (fontSize: number) => string = (fs: number) =>
    getFontString(fs, 'bold' as FontWeight, DEFAULT_FONT_FAMILY);
  private readonly boundMeasureTextCached = (text: string): number => this.measureTextCached(text);
  private translationFontSize = 1;
  private readonly boundGetTranslationFont = (): string =>
    getFontString(
      this.translationFontSize,
      'normal',
      this.config?.fontFamily ?? DEFAULT_FONT_FAMILY
    );

  /** Compute effective font size scaled to current viewport height. */
  private getEffectiveFontSize(): number {
    if (!this.config || this.logicalHeight <= 0) return this.config?.fontSize ?? 32;
    const { fontSize, fontBaseViewportHeight, fontMinSize, fontMaxSize } = this.config;
    const scaled = Math.round(fontSize * (this.logicalHeight / fontBaseViewportHeight));
    return Math.max(fontMinSize, Math.min(fontMaxSize, scaled));
  }

  private static TEXT_MEASURE_CACHE_MAX = 500;
  /** Pre-computed exponential distribution table for stagger delay (256 entries).
   *  Each entry = -ln(1 - (i+0.5)/256), yielding a positive exponential sample.
   *  Indexed by floor(Math.random() * 256) — avoids per-message Math.log calls. */
  private static readonly STAGGER_EXP_TABLE: Float64Array = (() => {
    const t = new Float64Array(256);
    for (let i = 0; i < 256; i++) {
      t[i] = -Math.log(1 - (i + 0.5) / 256);
    }
    return t;
  })();
  private textMeasureCache = new Map<string, number>();
  private fontMetricsCache = new Map<string, { height: number }>();
  private activeMessages: ActiveMessage[] = [];
  private activeMessagesByLane = new Map<number, ActiveMessage[]>();
  private pendingQueue: WorkerMessage[] = [];
  private pendingQueueSortNeeded = false;
  private laneHeap: [number, number][] = [];
  private laneIndexToHeapIndex = new Map<number, number>();
  private laneHeight = 0;
  private numLanes = 0;
  /** Current lane density factor — updated via 'laneDensity' protocol message. */
  private laneDensityFactor = 1.0;
  private speedTierLanes = new Map<number, { tier: number; until: number }>();
  private collidedLanes = new Set<number>();
  private totalDrops = 0;
  private textBitmapCache!: ResizableByteLimitedCache<OffscreenCanvas>;
  private emojiCache!: ResizableByteLimitedCache<ImageBitmap>;
  private authorPhotoCache!: ResizableByteLimitedCache<ImageBitmap>;
  private stickerCache!: ResizableByteLimitedCache<ImageBitmap>;
  private superChatGradientCache = new MapCompatibleLruMap<string, CanvasGradient>(
    GRADIENT_CACHE_MAX
  );
  private readonly messageById = new Map<string, WorkerMessage | ActiveMessage>();
  private fetching = new Set<string>();
  private readonly fetchControllers = new Set<AbortController>();
  private fetchGeneration = 0;
  private farOpacityBuckets: ActiveMessage[][] = Array.from({ length: OPACITY_BUCKETS }, () => []);
  private midOpacityBuckets: ActiveMessage[][] = Array.from({ length: OPACITY_BUCKETS }, () => []);
  private nearOpacityBuckets: ActiveMessage[][] = Array.from({ length: OPACITY_BUCKETS }, () => []);
  private readonly tierOpacityBuckets = [
    this.farOpacityBuckets,
    this.midOpacityBuckets,
    this.nearOpacityBuckets,
  ];
  private readonly expiredMessagesScratch: ActiveMessage[] = [];
  private readonly regularRenderConfig: RegularMessageRenderConfig = {
    showAuthor: true,
    fontSize: 1,
    fontWeight: 'bold',
    fontFamily: DEFAULT_FONT_FAMILY,
    color: DEFAULT_TEXT_COLOR,
    outlineWidthPx: 0,
    outlineOpacity: 0,
    backgroundColor: '#00000000',
    messageWidth: 0,
    messageHeight: 0,
  };
  private statsFrameCounter = 0;
  private idleSince: number | null = null;

  /** CSS-pixel dimensions (not DPR-multiplied). Set by init/resize handlers. */
  private logicalWidth = 0;
  private logicalHeight = 0;

  handleMessage(e: MessageEvent): void {
    try {
      // Runtime guard: validate control message before any state mutation.
      // Malformed messages (null, arrays, primitives, unknown discriminants,
      // missing required fields) are silently ignored.
      if (!isValidControlMessage(e.data)) return;

      try {
        const data = e.data as Record<string, unknown>;
        const type = data.type as string;
        switch (type) {
          case 'init': {
            this.config = data.config as WorkerConfig;
            this.canvas = data.canvas as OffscreenCanvas;
            this.ctx = this.canvas.getContext('2d', { alpha: true, desynchronized: true });
            if (!this.ctx) {
              self.postMessage({ type: 'error', error: 'Failed to get 2D context' });
              return;
            }
            const dpr = data.dpr as number;
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            this.emojiCache = new ResizableByteLimitedCache<ImageBitmap>(
              (this.config.emojiCacheMb ?? 4) * 1_000_000,
              WorkerRenderer.estimateBitmapBytes,
              (b) => b.close(),
              EMOJI_CACHE_MAX_ENTRIES
            );
            this.authorPhotoCache = new ResizableByteLimitedCache<ImageBitmap>(
              (this.config.photoCacheMb ?? 4) * 1_000_000,
              WorkerRenderer.estimateBitmapBytes,
              (b) => b.close()
            );
            stickerCache = this.stickerCache = new ResizableByteLimitedCache<ImageBitmap>(
              getStickerCacheBytes(this.config.stickerCacheMb ?? 4),
              WorkerRenderer.estimateBitmapBytes,
              (b) => b.close()
            );
            this.textBitmapCache = new ResizableByteLimitedCache<OffscreenCanvas>(
              (this.config.textCacheMb ?? 4) * 1_000_000,
              (canvas) => canvas.width * canvas.height * 4
            );
            this.recomputeConfigDerived();
            // Set logical dimensions BEFORE initLanes so that
            // getEffectiveFontSize() can scale the font to the viewport.
            this.logicalWidth = data.width as number;
            this.logicalHeight = data.height as number;
            this.initLanes(data.width as number, data.height as number);
            this.startRenderLoop();
            self.postMessage({ type: 'ready' });
            break;
          }
          case 'resize': {
            if (!this.canvas || !this.ctx) break;
            const newDpr = data.dpr as number;
            const cssW = data.width as number;
            const cssH = data.height as number;
            this.canvas.width = cssW * newDpr;
            this.canvas.height = cssH * newDpr;
            this.ctx.setTransform(newDpr, 0, 0, newDpr, 0, 0);
            this.logicalWidth = cssW;
            this.logicalHeight = cssH;
            this.initLanes(cssW, cssH);
            this.reflowActiveMessages();
            break;
          }
          case 'addMessages': {
            const msgs = data.messages as WorkerMessage[];
            const imageData = data.imageData as
              | Array<{ url: string; bitmap: ImageBitmap; target: string }>
              | undefined;
            if (imageData) {
              for (const item of imageData) {
                const { url, bitmap, target } = item;
                if (!url || !bitmap) continue;
                const cache =
                  target === 'author'
                    ? this.authorPhotoCache
                    : target === 'sticker'
                      ? this.stickerCache
                      : this.emojiCache;
                cache.set(url, bitmap);
              }
            }
            for (const m of msgs) this.enqueueMessage(m);
            break;
          }
          case 'updateConfig':
            if (this.config) {
              const prevMode = this.config.danmakuMode;
              const nextConfig = data.config as Partial<WorkerConfig>;
              const geometryChanged =
                (nextConfig.fontSize !== undefined &&
                  nextConfig.fontSize !== this.config.fontSize) ||
                (nextConfig.fontWeight !== undefined &&
                  nextConfig.fontWeight !== this.config.fontWeight) ||
                (nextConfig.fontFamily !== undefined &&
                  nextConfig.fontFamily !== this.config.fontFamily) ||
                (nextConfig.laneSpacing !== undefined &&
                  nextConfig.laneSpacing !== this.config.laneSpacing) ||
                (nextConfig.safeTop !== undefined && nextConfig.safeTop !== this.config.safeTop) ||
                (nextConfig.safeBottom !== undefined &&
                  nextConfig.safeBottom !== this.config.safeBottom);
              Object.assign(this.config, nextConfig);
              this.recomputeConfigDerived();
              this.textMeasureCache.clear();
              this.fontMetricsCache.clear();
              this.textBitmapCache.clear();
              // Preserve decoded image caches across ordinary settings
              // updates. Clearing them for opacity/translation/timing changes
              // makes visible emoji, avatars, and stickers disappear until a
              // new fetch completes. resize() still evicts when a cache limit
              // is actually reduced.
              if (nextConfig && 'emojiCacheMb' in nextConfig) {
                this.emojiCache.resize((this.config.emojiCacheMb ?? 4) * 1_000_000);
              }
              if (nextConfig && 'photoCacheMb' in nextConfig) {
                this.authorPhotoCache.resize((this.config.photoCacheMb ?? 4) * 1_000_000);
              }
              if (nextConfig && 'stickerCacheMb' in nextConfig) {
                this.stickerCache.resize(getStickerCacheBytes(this.config.stickerCacheMb ?? 4));
              }
              if (nextConfig && 'textCacheMb' in nextConfig) {
                this.textBitmapCache.resize((this.config.textCacheMb ?? 4) * 1_000_000);
              }
              this.superChatGradientCache.clear();
              if (geometryChanged && this.canvas) {
                this.initLanes(this.logicalWidth, this.logicalHeight);
                this.reflowActiveMessages();
              }
              // Issue 4: When danmakuMode changes, active messages have positions
              // computed for the old mode — reflow them into the new mode layout
              // instead of clearing state (which loses all active messages).
              // The worker's reflowActiveMessages() recomputes startX, x, and
              // duration based on this.config.danmakuMode, matching the main
              // thread Canvas2D behavior.
              if (
                data.config &&
                (data.config as WorkerConfig).danmakuMode !== undefined &&
                (data.config as WorkerConfig).danmakuMode !== prevMode
              ) {
                this.reflowActiveMessages();
              }
            }
            break;
          case 'setPaused': {
            const shouldPause = data.paused as boolean;
            if (shouldPause && !this.isPaused) {
              if (this.animFrameId !== null) {
                cancelAnimationFrame(this.animFrameId);
                this.animFrameId = null;
              }
              this.pauseStartTime = performance.now();
              this.isPaused = true;
            } else if (!shouldPause && this.isPaused) {
              const now = performance.now();
              let pausedMs = Math.max(0, now - this.pauseStartTime);
              for (const msg of this.activeMessages) {
                const elapsedBeforePause = now - pausedMs - msg.startTime;
                const remainingDisplay = msg.duration - elapsedBeforePause;
                const capped = Math.max(
                  0,
                  Math.min(pausedMs, Math.max(0, remainingDisplay) + 1000)
                );
                msg.pausedDuration += capped;
              }
              pausedMs = Math.min(
                pausedMs,
                (this.config?.maxMessageAgeMs ?? DEFAULT_SETTINGS.maxMessageAgeMs) * 2
              );
              WorkerRenderer.shiftLaneTimers(this.laneState, pausedMs);
              this.isPaused = false;
              this.pauseStartTime = 0;
              if (this.animFrameId === null && !this.isDestroyed) {
                this.startRenderLoop();
              }
            } else {
              this.isPaused = shouldPause;
            }
            break;
          }
          case 'updateTranslation': {
            const msgId = data.id as string;
            const translatedText = data.translatedText as string | null;
            const width = data.width as number;
            const height = data.height as number;
            const translationHeight = data.translationHeight as number;
            const msg = this.messageById.get(msgId);
            if (msg) {
              msg.translatedText = translatedText;
              msg.translationHeight = translationHeight;
              if ('laneArrayIndices' in msg) {
                this.applyActiveMessageGeometry(msg, width, height);
                if (translatedText) {
                  msg.translatedContent = [{ type: 'text', content: translatedText }];
                } else {
                  delete msg.translatedContent;
                }
                this.reflowActiveMessages();
              } else {
                msg.width = width;
                msg.height = height;
              }
            }
            break;
          }
          case 'setUserPaused':
            this.isUserPaused = (data.paused as boolean) ?? false;
            // Restart render loop if unpausing while not otherwise paused
            if (!this.isUserPaused && !this.isPaused && !this.isDestroyed) {
              if (this.animFrameId === null) {
                this.startRenderLoop();
              }
            }
            break;
          case 'snapshotMessages':
            self.postMessage({
              type: 'messageSnapshot',
              requestId: data.requestId,
              messageIds: [...this.messageById.keys()],
            });
            break;
          case 'destroy':
            this.handleDestroy();
            break;
          case 'clearState':
            this.handleClearState();
            break;
          case 'laneDensity':
            this.laneDensityFactor = (data as { factor: number }).factor;
            if (this.canvas && this.config) {
              this.initLanes(this.logicalWidth, this.logicalHeight);
              this.reflowActiveMessages();
            }
            break;
          case 'ping':
            self.postMessage({ type: 'pong' });
            break;
        }
      } catch (err) {
        self.postMessage({
          type: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      self.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  private recomputeConfigDerived(): void {
    if (!this.config) return;
    const c = this.config;
    this.invFadeMs = computeInvFadeDuration(c.fadeDurationMs);
    this.ageFadeRate = computeAgeFadeRate(c.maxMessageAgeMs);
    this.boundGetFont = (fontSize: number): string =>
      getFontString(fontSize, c.fontWeight, c.fontFamily);
    this.opacityConfig = {
      baseOpacity: c.opacity,
      fadeDurationMs: c.fadeDurationMs,
      invFadeDuration: this.invFadeMs,
      backlogOpacityMultiplier: c.backlogOpacityMultiplier,
      depthLayersEnabled: c.depthLayersEnabled,
      depthFarOpacityMul: c.depthFarOpacityMul,
      ageFadeRate: this.ageFadeRate,
    };
  }

  private measureTextCached(text: string): number {
    if (!this.ctx) return 0;
    let w = this.textMeasureCache.get(text);
    if (w === undefined) {
      const m = this.ctx.measureText(text);
      w = measureBoundingBoxWidth(m);
      if (this.textMeasureCache.size >= WorkerRenderer.TEXT_MEASURE_CACHE_MAX) {
        const oldestKey = this.textMeasureCache.keys().next().value;
        if (oldestKey !== undefined) this.textMeasureCache.delete(oldestKey);
      }
      this.textMeasureCache.set(text, w);
    }
    return w;
  }

  private getFontFromConfig(fontSize: number): string {
    if (!this.config) return `${fontSize}px sans-serif`;
    return getFontString(fontSize, this.config.fontWeight, this.config.fontFamily);
  }

  private measureTextHeight(fontSize: number): number {
    if (!this.ctx) return Math.ceil(fontSize * 1.1);
    const font = this.getFontFromConfig(fontSize);
    let metrics = this.fontMetricsCache.get(font);
    if (!metrics) {
      this.ctx.font = font;
      const m = this.ctx.measureText('Mg');
      metrics = { height: getSafeTextHeight(m, fontSize) };
      this.fontMetricsCache.set(font, metrics);
    }
    return metrics.height;
  }

  private static estimateBitmapBytes(bitmap: ImageBitmap): number {
    return bitmap.width * bitmap.height * 4;
  }

  private enqueueMessage(msg: WorkerMessage): void {
    const maxSize = this.config?.queueMaxSize ?? 200;
    if (this.pendingQueue.length >= maxSize) {
      let minIdx = 0;
      for (let i = 1; i < this.pendingQueue.length; i++) {
        if ((this.pendingQueue[i]?.priority ?? 0) < (this.pendingQueue[minIdx]?.priority ?? 0)) {
          minIdx = i;
        }
      }
      if (msg.priority > (this.pendingQueue[minIdx]?.priority ?? 0)) {
        // Replace the lowest-priority entry.  Clean up the evicted
        // entry from messageById and register the new one so
        // translation results can be matched.
        const evicted = this.pendingQueue[minIdx];
        if (evicted) this.messageById.delete(evicted.id);
        this.pendingQueue[minIdx] = msg;
        this.messageById.set(msg.id, msg);
      }
      return;
    }
    this.pendingQueue.push(msg);
    this.messageById.set(msg.id, msg);
    this.pendingQueueSortNeeded = true;
    if (this.animFrameId === null && !this.isDestroyed) {
      this.startRenderLoop();
    }
  }

  private startRenderLoop(): void {
    if (this.animFrameId !== null) return;
    const frame = (_t: number): void => {
      if (this.isDestroyed) return;
      this.renderFrame();
      if (this.activeMessages.length === 0 && this.pendingQueue.length === 0) {
        const now = performance.now();
        if (this.idleSince === null) {
          this.idleSince = now;
        } else if (now - this.idleSince >= IDLE_GRACE_PERIOD_MS) {
          this.animFrameId = null;
          this.idleSince = null;
          return;
        }
      } else {
        this.idleSince = null;
      }
      this.animFrameId = requestAnimationFrame(frame);
    };
    this.animFrameId = requestAnimationFrame(frame);
  }

  private handleDestroy(): void {
    this.isDestroyed = true;
    this.fetchGeneration++;
    for (const controller of this.fetchControllers) controller.abort();
    this.fetchControllers.clear();
    this.fetching.clear();
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.ctx = null;
    this.canvas = null;
    this.activeMessages.length = 0;
    this.activeMessagesByLane.clear();
    this.pendingQueue.length = 0;
    this.textBitmapCache.clear();
    this.emojiCache.clear();
    this.authorPhotoCache.clear();
    this.stickerCache.clear();
    this.superChatGradientCache.clear();
    this.messageById.clear();
    // Acknowledge the destroy request so the main thread can terminate
    // without waiting for the 500ms safety timeout.
    self.postMessage({ type: 'ack' });
  }

  /**
   * Clear renderer state for a fresh restart (used by performOverlayRefresh).
   * Resets active messages, pending queue, and lane allocator while
   * preserving caches (text bitmaps, emoji, author photos, etc.).
   */
  private handleClearState(): void {
    this.activeMessages.length = 0;
    this.activeMessagesByLane.clear();
    this.pendingQueue.length = 0;
    this.messageById.clear();
    // Rebuild lane allocator from existing dimensions (numLanes/laneHeight
    // are preserved from the last initLanes/resize call).
    const now = performance.now();
    this.laneHeap = buildLaneHeap(this.numLanes, now, this.laneIndexToHeapIndex);
    this.speedTierLanes.clear();
    this.collidedLanes.clear();
  }

  private get laneState(): LaneAllocationState {
    return {
      heap: this.laneHeap,
      indexMap: this.laneIndexToHeapIndex,
      numLanes: this.numLanes,
      speedTierLanes: this.speedTierLanes,
      collidedLanes: this.collidedLanes,
    };
  }

  /** Reposition active messages and restore their lane reservations after resize. */
  private reflowActiveMessages(): void {
    if (!this.config || this.numLanes <= 0) return;
    const now = performance.now();
    this.activeMessagesByLane.clear();

    for (const msg of this.activeMessages) {
      const requestedSlots = Math.max(1, Math.ceil(msg.height / this.laneHeight));
      const slotCount = Math.min(requestedSlots, this.numLanes);
      const laneIndex = Math.min(msg.laneIndex, Math.max(0, this.numLanes - slotCount));
      msg.laneIndex = laneIndex;
      msg.laneSlotCount = slotCount;
      msg.laneArrayIndices.length = 0;
      msg.y =
        computeLaneY(laneIndex, this.logicalHeight, this.config.safeTop ?? 0, this.laneHeight) +
        Math.floor((slotCount * this.laneHeight - msg.height) / 2);

      const elapsed = Math.max(0, now - msg.startTime - msg.pausedDuration);
      const progress = Math.min(1, elapsed * msg.invDuration);
      const isScrolling =
        this.config.danmakuMode === 'scroll' || this.config.danmakuMode === 'reverse';
      let duration = this.config.topBottomDurationMs;
      if (isScrolling) {
        let speed = this.config.speedPxPerSec;
        if (msg.speedTier === SPEED_TIER.FAR) {
          speed = Math.max(30, speed * this.config.depthFarSpeedMul);
        } else if (msg.speedTier === SPEED_TIER.NEAR) {
          speed *= this.config.depthNearSpeedMul;
        } else if (msg.speedTier === SPEED_TIER.BACKLOG) {
          speed *= this.config.backlogSpeedMultiplier;
        }
        const totalDistance = this.logicalWidth + msg.width + this.config.exitPaddingPx;
        duration = computeScrollDuration(
          totalDistance,
          speed,
          this.config.scrollDurationMinMs,
          this.config.scrollDurationMaxMs,
          this.config.exitPaddingPx
        );
      }
      if (msg.authorType === 'moderator' || msg.authorType === 'owner') {
        duration *= this.config.modOwnerDurationMultiplier;
      }
      msg.duration = duration;
      msg.invDuration = 1 / Math.max(1, duration);
      msg.startTime = now - msg.pausedDuration - progress * duration;
      if (isScrolling) {
        if (this.config.danmakuMode === 'scroll') {
          msg.startX = this.logicalWidth;
          msg.x = msg.startX - progress * (msg.startX + msg.width + this.config.exitPaddingPx);
        } else {
          msg.startX = -msg.width;
          msg.x =
            msg.startX + progress * (this.logicalWidth - msg.startX + this.config.exitPaddingPx);
        }
      } else {
        msg.x = (this.logicalWidth - msg.width) / 2;
      }

      addMessageToLaneIndex(this.activeMessagesByLane, msg, slotCount);

      const remainingDuration = Math.max(1, duration * (1 - progress));
      this.commitPlacement(
        laneIndex,
        slotCount,
        now,
        remainingDuration,
        msg.speedTier,
        isScrolling ? msg.width : undefined
      );
    }
  }

  /** Apply asynchronous geometry without jumping the message along its scroll path. */
  private applyActiveMessageGeometry(msg: ActiveMessage, width: number, height: number): void {
    if (!this.config) {
      msg.width = width;
      msg.height = height;
      return;
    }
    const isScrolling =
      this.config.danmakuMode === 'scroll' || this.config.danmakuMode === 'reverse';
    if (isScrolling) {
      const now = performance.now();
      let speed = this.config.speedPxPerSec;
      if (msg.speedTier === SPEED_TIER.FAR) {
        speed = Math.max(30, speed * this.config.depthFarSpeedMul);
      } else if (msg.speedTier === SPEED_TIER.NEAR) {
        speed *= this.config.depthNearSpeedMul;
      } else if (msg.speedTier === SPEED_TIER.BACKLOG) {
        speed *= this.config.backlogSpeedMultiplier;
      }
      const totalDistance = this.logicalWidth + width + this.config.exitPaddingPx;
      let duration = computeScrollDuration(
        totalDistance,
        speed,
        this.config.scrollDurationMinMs,
        this.config.scrollDurationMaxMs,
        this.config.exitPaddingPx
      );
      if (msg.authorType === 'moderator' || msg.authorType === 'owner') {
        duration *= this.config.modOwnerDurationMultiplier;
      }
      const progress =
        this.config.danmakuMode === 'scroll'
          ? (this.logicalWidth - msg.x) / Math.max(1, totalDistance)
          : (msg.x + width) / Math.max(1, totalDistance);
      msg.duration = duration;
      msg.invDuration = 1 / Math.max(1, duration);
      msg.startTime = now - msg.pausedDuration - Math.max(0, Math.min(1, progress)) * duration;
    }
    msg.width = width;
    msg.height = height;
  }

  private initLanes(_width: number, height: number): void {
    if (!this.config || !this.ctx) return;
    const textHeight = this.measureTextHeight(this.getEffectiveFontSize());
    const rawLaneHeight = Math.max(1, textHeight + this.config.laneSpacing);
    this.laneHeight = Math.max(1, Math.round(rawLaneHeight * this.laneDensityFactor));
    const usableHeight = height * (1 - this.config.safeTop - this.config.safeBottom);
    this.numLanes = Math.max(1, Math.floor(usableHeight / this.laneHeight));
    const now = performance.now();
    this.laneHeap = buildLaneHeap(this.numLanes, now, this.laneIndexToHeapIndex);
    this.speedTierLanes.clear();
  }

  private static resetBatch(state: LaneAllocationState, now: number): void {
    resetBatchShared(state, now);
  }

  private findPlacement(
    msgHeight: number,
    speedTier: number,
    now: number,
    strategy: LaneSelectionStrategy
  ): {
    laneIndex: number;
    waitMs: number;
    laneY: number;
    slotCount: number;
    verticalOffset: number;
  } | null {
    if (this.laneHeap.length === 0) return null;
    const maxWaitMs = this.config?.scrollDurationMaxMs ?? DEFAULT_SETTINGS.scrollDurationMaxMs;
    const result = findPlacementShared(
      this.laneState,
      now,
      msgHeight,
      this.laneHeight,
      maxWaitMs,
      speedTier,
      Math.random,
      strategy
    );
    if (!result) return null;
    const slotCount = Math.max(1, Math.ceil(msgHeight / this.laneHeight));
    const laneY = computeLaneY(
      result.laneIndex,
      this.logicalHeight,
      this.config?.safeTop ?? 0,
      this.laneHeight
    );
    const verticalOffset = Math.floor((slotCount * this.laneHeight - msgHeight) / 2);
    return { ...result, laneY, slotCount, verticalOffset };
  }

  private commitPlacement(
    laneIndex: number,
    slotCount: number,
    startTime: number,
    durationMs: number,
    speedTier: number,
    msgWidth?: number,
    entryOffsetPx = 0
  ): void {
    if (!this.config) return;
    const screenWidth = this.logicalWidth || 1920;
    const occupancyMs = computeOccupancyMsShared(
      durationMs,
      this.config.exitPaddingPx,
      this.config.headwayGapRatio,
      msgWidth,
      screenWidth,
      entryOffsetPx
    );
    commitPlacementShared(
      this.laneState,
      laneIndex,
      slotCount,
      startTime,
      occupancyMs,
      durationMs,
      speedTier
    );
  }

  private static shiftLaneTimers(state: LaneAllocationState, ms: number): void {
    shiftLaneTimersShared(state, ms);
  }

  private activateMessage(
    msg: WorkerMessage,
    now: number,
    placement: {
      laneIndex: number;
      waitMs: number;
      laneY: number;
      slotCount: number;
      verticalOffset: number;
    },
    batchIndex: number,
    previousStaggerDelayMs: number,
    speedTier: number,
    screenWidth: number,
    _screenHeight: number
  ): number {
    if (!this.config) return previousStaggerDelayMs;
    const mode = this.config.danmakuMode;
    let speed = this.config.speedPxPerSec;
    if (msg.burstSpeedMultiplier && msg.burstSpeedMultiplier > 1) speed *= msg.burstSpeedMultiplier;
    switch (speedTier) {
      case SPEED_TIER.FAR:
        speed = Math.max(30, speed * this.config.depthFarSpeedMul);
        break;
      case SPEED_TIER.NEAR:
        speed *= this.config.depthNearSpeedMul;
        break;
      case SPEED_TIER.BACKLOG:
        speed *= this.config.backlogSpeedMultiplier;
        break;
    }
    const durationMultiplier =
      msg.authorType === 'moderator' || msg.authorType === 'owner'
        ? this.config.modOwnerDurationMultiplier
        : 1;
    const motion = computeMessageMotionPlan({
      mode,
      now,
      batchIndex,
      previousStaggerDelayMs,
      queueDepth: this.pendingQueue.length,
      staggerSample: WorkerRenderer.STAGGER_EXP_TABLE[(fastRandom() * 256) >>> 0]!,
      maxStaggerDelayMs: this.config.staggerMaxDelayMs,
      mediumStaggerDelayMs: this.config.staggerMediumDelayMs,
      placementWaitMs: placement.waitMs,
      screenWidth,
      messageWidth: msg.width,
      velocityPxPerSec: speed,
      scrollDurationMinMs: this.config.scrollDurationMinMs,
      scrollDurationMaxMs: this.config.scrollDurationMaxMs,
      exitPaddingPx: this.config.exitPaddingPx,
      topBottomDurationMs: this.config.topBottomDurationMs,
      durationMultiplier,
    });
    const slotCount = placement.slotCount;
    const laneY = placement.laneY + placement.verticalOffset;
    const authorColor =
      this.config.preserveUserColor && msg.userColor
        ? msg.userColor
        : (msg.authorType && this.config.authorColors[msg.authorType]) ||
          this.config.color ||
          DEFAULT_TEXT_COLOR;
    const am: ActiveMessage = {
      id: msg.id,
      x: motion.startX,
      y: laneY,
      startX: motion.startX,
      width: msg.width,
      height: msg.height,
      fadeStartTime: motion.startTime,
      startTime: motion.startTime,
      duration: motion.durationMs,
      invDuration: 1 / Math.max(1, motion.durationMs),
      pausedDuration: 0,
      laneIndex: placement.laneIndex,
      laneSlotCount: slotCount,
      laneArrayIndices: [],
      speedTier,
      text: msg.text,
      color: authorColor,
      ghostText: getDisplayText(msg.content ?? []),
      content: msg.content ?? [],
    };
    if (msg.authorType !== undefined) am.authorType = msg.authorType;
    if (msg.kind !== undefined) am.kind = msg.kind;
    if (msg.translatedText !== undefined) {
      am.translatedText = msg.translatedText;
      if (msg.translatedText) {
        am.translatedContent = [{ type: 'text', content: msg.translatedText }];
      }
    }
    if (msg.translationHeight !== undefined) am.translationHeight = msg.translationHeight;
    if (msg.author !== undefined) am.author = msg.author;
    if (msg.authorPhotoUrl !== undefined) am.authorPhotoUrl = msg.authorPhotoUrl;
    if (msg.superChatAmount !== undefined) am.superChatAmount = msg.superChatAmount;
    if (msg.superChatStickerUrl !== undefined) am.superChatStickerUrl = msg.superChatStickerUrl;
    if (msg.membershipHeader !== undefined) am.membershipHeader = msg.membershipHeader;
    if (msg.cardConfigWorker !== undefined) am.cardConfigWorker = msg.cardConfigWorker;
    this.commitPlacement(
      placement.laneIndex,
      slotCount,
      motion.startTime,
      motion.durationMs,
      speedTier,
      motion.isScrolling ? msg.width : undefined,
      motion.horizontalStaggerPx
    );
    this.activeMessages.push(am);
    // Register in per-lane index for O(lanes) collision checks (Issue 7).
    addMessageToLaneIndex(this.activeMessagesByLane, am, slotCount);
    this.messageById.set(msg.id, am);
    if (msg.content) {
      const emojiUrls: string[] = [];
      for (const seg of msg.content) {
        if (seg.type === 'emoji' && seg.emojiUrl) emojiUrls.push(seg.emojiUrl);
      }
      if (emojiUrls.length > 0) void this.prefetchImages(emojiUrls, this.emojiCache);
    }
    if (msg.authorPhotoUrl) void this.prefetchImages([msg.authorPhotoUrl], this.authorPhotoCache);
    if (msg.superChatStickerUrl)
      void this.prefetchImages([msg.superChatStickerUrl], this.stickerCache);
    return motion.staggerDelayMs;
  }

  private renderFrame(): void {
    if (!this.ctx || !this.canvas || !this.config || this.isPaused || this.isUserPaused) return;

    // Detect OffscreenCanvas context loss (GPU driver reset, etc.).
    // Signal the main thread so it can fall back to main-thread rendering.
    // OffscreenCanvasRenderingContext2D.isContextLost() is available in
    // Chrome 130+ and Firefox 135+.
    try {
      if (typeof this.ctx.isContextLost === 'function' && this.ctx.isContextLost()) {
        self.postMessage({ type: 'contextLost' });
        return;
      }
    } catch {
      self.postMessage({ type: 'contextLost' });
      return;
    }

    const cfg = this.config;
    const now = performance.now();
    const width = this.logicalWidth;
    const height = this.logicalHeight;
    // Anti-block gate: check if drainQueue should run
    let shouldDrain = true;
    if (this.pendingQueue.length > 0) {
      let occupiedCount = 0;
      for (let h = 0; h < this.laneHeap.length; h++) {
        const entry = this.laneHeap[h];
        if (entry && entry[1] > now) occupiedCount++;
      }
      const laneUtilization = occupiedCount / Math.max(1, this.numLanes);
      if (laneUtilization >= 1 - ANTI_BLOCK_FREE_RATIO) {
        if (!cfg.isReplayMode) {
          if (this.antiBlockStartTime === 0) {
            this.antiBlockStartTime = now;
          }
          const front = this.pendingQueue[0];
          const forceDrain = now - this.antiBlockStartTime >= ANTI_BLOCK_MAX_DURATION_MS;
          if (forceDrain) {
            this.antiBlockStartTime = now;
          }
          const highPriorityFront = front ? front.priority >= ANTI_BLOCK_PRIORITY_THRESHOLD : false;
          shouldDrain = forceDrain || highPriorityFront;
        } else {
          this.antiBlockStartTime = 0;
        }
      } else {
        this.antiBlockStartTime = 0;
      }
    }
    if (shouldDrain) {
      WorkerRenderer.resetBatch(this.laneState, now);
      this.drainQueue(now, width, height);
    }
    // ── Merged cleanup + pre-scan (single pass) ──────────────────────
    for (const bucket of this.farOpacityBuckets) bucket.length = 0;
    for (const bucket of this.midOpacityBuckets) bucket.length = 0;
    for (const bucket of this.nearOpacityBuckets) bucket.length = 0;
    const mode = this.config.danmakuMode;
    const isScrolling = mode === 'scroll' || mode === 'reverse';
    const strokeWidth =
      this.config.outlineWidthPx > 0 && this.config.outlineOpacity > 0
        ? this.config.outlineWidthPx
        : 0;
    let writeIdx = 0;
    this.expiredMessagesScratch.length = 0;
    for (let i = 0; i < this.activeMessages.length; i++) {
      const msg = this.activeMessages[i];
      if (!msg) continue;
      const elapsed = now - msg.startTime - msg.pausedDuration;
      // Expired: remove via skip (don't write to writeIdx position)
      if (elapsed >= msg.duration) {
        this.messageById.delete(msg.id);
        this.expiredMessagesScratch.push(msg);
        continue;
      }
      // Keep message (in-place compaction)
      this.activeMessages[writeIdx++] = msg;
      // Still in stagger delay — keep but skip rendering
      if (elapsed < 0) continue;
      // ── Render pre-compute ──
      // Save previous position for temporal frame blending (FAR-tier motion blur)
      if (msg.speedTier === SPEED_TIER.FAR) {
        msg._prevX = msg.x;
        msg._prevY = msg.y;
      }
      const progress = Math.min(1, Math.max(0, elapsed * msg.invDuration));
      const isReducedMotionActive = this.config.reducedMotion && !this.config.ignoreReducedMotion;
      if (mode === 'scroll') {
        if (!isReducedMotionActive) {
          msg.x = msg.startX - progress * (msg.startX + msg.width + this.config.exitPaddingPx);
        } else {
          msg.x = Math.max(0, (this.logicalWidth - msg.width) / 2);
        }
      } else if (mode === 'reverse') {
        if (!isReducedMotionActive) {
          msg.x =
            msg.startX + progress * (this.logicalWidth - msg.startX + this.config.exitPaddingPx);
        } else {
          msg.x = Math.max(0, (this.logicalWidth - msg.width) / 2);
        }
      }
      const fadeElapsed = now - msg.fadeStartTime - msg.pausedDuration;
      const opacity = this.opacityConfig
        ? computeMessageOpacity(
            msg.speedTier === SPEED_TIER.BACKLOG,
            fadeElapsed,
            msg.duration,
            isScrolling,
            msg.speedTier,
            this.opacityConfig
          )
        : 0;
      if (opacity <= 0) continue;
      const bucketIndex = Math.min(
        OPACITY_BUCKETS - 1,
        Math.round(opacity * (OPACITY_BUCKETS - 1))
      );
      msg._frameElapsed = elapsed;
      // Route to the correct speed-tier bucket for z-order rendering
      if (msg.speedTier === SPEED_TIER.FAR) {
        this.farOpacityBuckets[bucketIndex]?.push(msg);
      } else if (msg.speedTier === SPEED_TIER.NEAR) {
        this.nearOpacityBuckets[bucketIndex]?.push(msg);
      } else {
        this.midOpacityBuckets[bucketIndex]?.push(msg);
      }
    }
    this.activeMessages.length = writeIdx;
    for (const expired of this.expiredMessagesScratch) {
      removeMessageFromLaneIndex(this.activeMessagesByLane, expired, expired.laneSlotCount);
    }
    // ── Clear canvas ────────────────────────────────────────────────
    this.ctx.clearRect(0, 0, this.logicalWidth, this.logicalHeight);
    if (writeIdx === 0) {
      this.statsFrameCounter++;
      if (this.statsFrameCounter >= 60) {
        this.statsFrameCounter = 0;
        self.postMessage({
          type: 'stats',
          activeMessages: 0,
          drops: this.totalDrops,
          pendingQueueDepth: this.pendingQueue.length,
          activeMessageIds: [],
          pendingMessageIds: [],
        });
      }
      return;
    }
    this.ctx.textBaseline = 'top';
    const getFont = this.boundGetFont;
    // Render FAR → MID → NEAR for correct z-order
    for (const tierBucket of this.tierOpacityBuckets) {
      for (let bucketIndex = 0; bucketIndex < OPACITY_BUCKETS; bucketIndex++) {
        const entries = tierBucket[bucketIndex];
        if (!entries || entries.length === 0) continue;
        this.ctx.globalAlpha = bucketIndex / (OPACITY_BUCKETS - 1);
        try {
          for (const msg of entries) {
            let renderColor = msg.colorOverride || msg.color;
            if (msg.speedTier === SPEED_TIER.FAR && !msg.colorOverride) {
              renderColor = desaturateColor(renderColor, FAR_LAYER_DESATURATION_FACTOR);
              msg.colorOverride = renderColor;
            }
            const sx = Math.floor(msg.x);
            if (sx + msg.width <= 0) continue;
            const sy = Math.floor(msg.y);

            // Temporal frame blending: render ghost at previous position for FAR-tier
            if (
              this.config.motionBlurEnabled &&
              !(this.config.reducedMotion && !this.config.ignoreReducedMotion) &&
              msg.speedTier === SPEED_TIER.FAR &&
              !msg.cardConfigWorker &&
              msg._prevX !== undefined &&
              msg._prevY !== undefined
            ) {
              const ghostAlpha = this.ctx.globalAlpha * this.config.motionBlurAlpha;
              if (ghostAlpha > 0.001) {
                this.ctx.save();
                this.ctx.globalAlpha = ghostAlpha;
                const ghostFont = getFont(this.getEffectiveFontSize());
                this.ctx.font = ghostFont;
                this.ctx.textRendering = 'optimizeSpeed';
                this.ctx.fontKerning = 'none';
                this.ctx.fillStyle = renderColor;
                // Build ghost text from text segments only — skip emoji fallbackText
                if (msg.ghostText) {
                  this.ctx.fillText(
                    msg.ghostText,
                    Math.floor(msg._prevX) + rendererLayout.paddingH,
                    Math.floor(msg._prevY)
                  );
                }
                this.ctx.restore();
              }
            }
            if (msg.cardConfigWorker) {
              const paidContent =
                cfg.translationEnabled && cfg.translationMode === 'replace' && msg.translatedText
                  ? (msg.translatedContent ?? msg.content)
                  : msg.content;
              this.ctx.save();
              try {
                renderPaidCardWorker(
                  this.ctx,
                  msg,
                  paidContent,
                  msg.width,
                  msg.height,
                  sx,
                  sy,
                  msg._frameElapsed!,
                  msg.cardConfigWorker,
                  cfg.fontSize,
                  cfg.fontWeight,
                  cfg.fontFamily,
                  strokeWidth,
                  cfg.outlineOpacity,
                  this.textBitmapCache,
                  this.authorPhotoCache,
                  this.emojiCache,
                  getFont,
                  this.superChatGradientCache,
                  cfg.superChatOpacity
                );
              } finally {
                this.ctx.restore();
              }
            } else {
              const overrideText =
                cfg.translationEnabled && cfg.translationMode === 'replace' && msg.translatedText
                  ? msg.translatedText
                  : null;
              const regularConfig = this.regularRenderConfig;
              regularConfig.showAuthor = cfg.showAuthor[msg.authorType ?? 'normal'] ?? true;
              regularConfig.fontSize = cfg.fontSize;
              regularConfig.fontWeight = cfg.fontWeight;
              regularConfig.fontFamily = cfg.fontFamily;
              regularConfig.color = renderColor;
              regularConfig.outlineWidthPx = strokeWidth;
              regularConfig.outlineOpacity = cfg.outlineOpacity;
              regularConfig.backgroundColor =
                cfg.backgroundColors[msg.authorType ?? 'normal'] ?? '#00000000';
              regularConfig.messageWidth = msg.width;
              regularConfig.messageHeight = msg.height;
              renderRegularMessage(
                this.ctx,
                msg,
                sx,
                sy,
                regularConfig,
                this.textBitmapCache,
                this.emojiCache,
                isAvailableImage,
                this.authorPhotoCache,
                isAvailableImage,
                getFont,
                this.boundMeasureTextCached,
                overrideText,
                msg.speedTier === SPEED_TIER.FAR ? '1px' : undefined
              );
            }
            if (
              cfg.translationEnabled &&
              cfg.translationMode === 'dual' &&
              msg.translatedText &&
              msg.translatedText !== msg.text
            ) {
              const translationFontSize = Math.round(cfg.fontSize * TRANSLATION_FONT_SCALE);
              this.translationFontSize = translationFontSize;
              const translationColor = msg.authorType
                ? cfg.authorColors[msg.authorType] || renderColor
                : renderColor;
              const translationHeight = msg.translationHeight ?? translationFontSize;
              const paidPadding =
                msg.kind === 'superchat' ? rendererLayout.superchat : rendererLayout.membership;
              const regularInsets = getRegularCardInsets(
                cfg.fontSize,
                strokeWidth,
                (cfg.showAuthor[msg.authorType ?? 'normal'] ?? true) &&
                  !!msg.author &&
                  !!msg.authorPhotoUrl
              );
              const paddingH = msg.cardConfigWorker
                ? paidPadding.paddingH
                : regularInsets.horizontal;
              const paddingV = msg.cardConfigWorker ? paidPadding.paddingV : regularInsets.vertical;
              const translationY = sy + msg.height - paddingV - translationHeight;
              this.ctx.save();
              try {
                this.ctx.globalAlpha =
                  (bucketIndex / (OPACITY_BUCKETS - 1)) * TRANSLATION_OPACITY_SCALE;
                if (msg.cardConfigWorker) {
                  renderWrappedContentSegments(
                    this.ctx,
                    [{ type: 'text', content: msg.translatedText }],
                    sx + paddingH,
                    Math.floor(translationY),
                    Math.max(1, msg.width - paddingH * 2),
                    msg.kind === 'superchat'
                      ? cfg.superChatMaxBodyLines
                      : cfg.membershipMaxBodyLines,
                    translationColor,
                    translationFontSize,
                    strokeWidth,
                    cfg.outlineOpacity,
                    this.textBitmapCache,
                    this.emojiCache as ResizableByteLimitedCache<CanvasImageSource>,
                    this.boundGetTranslationFont
                  );
                } else {
                  renderSegment(
                    this.ctx,
                    msg.translatedText,
                    sx + paddingH,
                    Math.floor(translationY),
                    translationColor,
                    translationFontSize,
                    strokeWidth,
                    cfg.outlineOpacity,
                    this.textBitmapCache,
                    this.boundGetTranslationFont
                  );
                }
              } finally {
                this.ctx.restore();
              }
            }
          }
        } finally {
          this.ctx.globalAlpha = 1;
        }
      }
    }
    this.statsFrameCounter++;
    if (this.statsFrameCounter >= 60) {
      this.statsFrameCounter = 0;
      self.postMessage({
        type: 'stats',
        activeMessages: this.activeMessages.length,
        drops: this.totalDrops,
        pendingQueueDepth: this.pendingQueue.length,
        activeMessageIds: this.activeMessages.map((msg) => msg.id),
        pendingMessageIds: this.pendingQueue.map((msg) => msg.id),
      });
    }

    // ── Live region mirror: send structured text alternatives to main thread ──
    // Runs every 30 frames (~500ms at 60fps) to keep the aria-live region
    // updated with current visible messages for screen reader access.
    // Mirrors the main-thread renderer's mirrorVisibleMessages() behaviour.
    if (this.statsFrameCounter % 30 === 0) {
      const maxSnippets = 10;
      const count = Math.min(this.activeMessages.length, maxSnippets);
      if (count > 0) {
        const messages: Array<{
          id: string;
          text: string;
          kind: 'text' | 'superchat' | 'membership';
          author?: string;
          superChatAmount?: string;
          membershipHeader?: string;
        }> = [];
        const start = this.activeMessages.length - count;
        for (let i = start; i < this.activeMessages.length; i++) {
          const msg = this.activeMessages[i];
          if (!msg || (!msg.text && !msg.author)) continue;
          const kind = msg.kind === 'superchat' || msg.kind === 'membership' ? msg.kind : 'text';
          messages.push({
            id: msg.id,
            text: msg.text,
            kind,
            ...(msg.author !== undefined ? { author: msg.author } : {}),
            ...(msg.superChatAmount !== undefined ? { superChatAmount: msg.superChatAmount } : {}),
            ...(msg.membershipHeader !== undefined
              ? { membershipHeader: msg.membershipHeader }
              : {}),
          });
        }
        if (messages.length > 0) {
          self.postMessage({ type: 'liveRegionSnippets', messages });
        }
      }
    }
  }

  private checkCollision(
    placement: {
      laneIndex: number;
      waitMs: number;
      laneY: number;
      slotCount: number;
      verticalOffset: number;
    },
    newMsgHeight: number,
    _newSpeedTier: number,
    now: number,
    screenWidth: number
  ): boolean {
    if (!this.config) return true;
    const mode = this.config.danmakuMode;
    const isScrolling = mode === 'scroll' || mode === 'reverse';
    const newTop = placement.laneY + placement.verticalOffset;
    const newBottom = newTop + newMsgHeight;

    // Issue 7: Lane-scoped collision scan via activeMessagesByLane.
    // Scan the new message's lanes ± 1 for adjacent overlap, instead of
    // iterating all active messages (O(n) → O(lanes · avgMsgsPerLane)).
    const adjacentMessages: ActiveMessage[] = [];
    const scanStart = placement.laneIndex - 1;
    const scanEnd = placement.laneIndex + placement.slotCount;
    for (let li = scanStart; li <= scanEnd; li++) {
      const laneMsgs = this.activeMessagesByLane.get(li);
      if (laneMsgs) {
        for (const m of laneMsgs) adjacentMessages.push(m);
      }
    }

    // Scan newest-first for early collision exit
    for (let i = adjacentMessages.length - 1; i >= 0; i--) {
      const active = adjacentMessages[i];
      if (!active) continue;
      const activeElapsed = now - active.startTime - active.pausedDuration;
      if (activeElapsed < 0) continue;
      if (active.y + active.height <= newTop || active.y >= newBottom) continue;
      if (isScrolling) {
        const headwayPx = computeBaseHeadwayPx(active.width, this.config.headwayGapRatio);
        const activeProgress = Math.min(1, Math.max(0, activeElapsed * active.invDuration));
        if (mode === 'scroll') {
          if (
            active.startX -
              activeProgress * (active.startX + active.width + this.config.exitPaddingPx) +
              active.width >
            screenWidth - headwayPx
          ) {
            this.markCollidedLanes(placement.laneIndex, placement.slotCount);
            return false;
          }
        } else {
          // reverse mode: messages enter from left, travel right.
          // Collision: the active message's LEFT edge must have cleared
          // the left-side entry zone (+ headway gap) before a new message
          // can enter the same lane.
          const activeX =
            active.startX +
            activeProgress * (screenWidth - active.startX + this.config.exitPaddingPx);
          if (activeX < headwayPx) {
            this.markCollidedLanes(placement.laneIndex, placement.slotCount);
            return false;
          }
        }
      } else {
        if (activeElapsed < active.duration) {
          this.markCollidedLanes(placement.laneIndex, placement.slotCount);
          return false;
        }
      }
    }
    return true;
  }

  /** Issue 6: Mark all lanes occupied by a multi-slot message, not just the start lane. */
  private markCollidedLanes(startLane: number, slotCount: number): void {
    for (let slot = 0; slot < slotCount; slot++) {
      this.collidedLanes.add(startLane + slot);
    }
  }

  private drainQueue(now: number, width: number, height: number): void {
    if (!this.config) return;
    if (this.pendingQueueSortNeeded && this.pendingQueue.length > 0) {
      this.pendingQueue.sort((a, b) => b.priority - a.priority);
      this.pendingQueueSortNeeded = false;
    }
    let batchIndex = 0;
    let staggerCursorMs = 0;
    const committed = new Set<WorkerMessage>();
    let skipCount = 0;
    const MAX_CONSECUTIVE_SKIPS = 16;
    for (let i = 0; i < this.pendingQueue.length; i++) {
      const entry = this.pendingQueue[i];
      if (!entry) continue;
      if (this.activeMessages.length >= this.config.maxConcurrentMessages) break;
      const speedTier = getSpeedTier(entry, this.config);
      const requiredSlots = Math.max(1, Math.ceil(entry.height / this.laneHeight));
      if (requiredSlots > this.numLanes) {
        // A message taller than the viewport can never obtain a contiguous
        // block. Treat it as a permanent drop instead of retrying it every
        // frame and keeping the Worker render loop alive indefinitely.
        this.totalDrops++;
        this.messageById.delete(entry.id);
        committed.add(entry);
        continue;
      }
      const laneStrategy =
        this.config.danmakuMode === 'top'
          ? 'top'
          : this.config.danmakuMode === 'bottom'
            ? 'bottom'
            : 'spread';
      const placement = this.findPlacement(entry.height, speedTier, now, laneStrategy);
      if (!placement) {
        this.totalDrops++;
        skipCount++;
        if (skipCount >= MAX_CONSECUTIVE_SKIPS) break;
        continue;
      }
      if (!this.checkCollision(placement, entry.height, speedTier, now, width)) {
        skipCount++;
        if (skipCount >= MAX_CONSECUTIVE_SKIPS) break;
        continue;
      }
      skipCount = 0;
      staggerCursorMs = this.activateMessage(
        entry,
        now,
        placement,
        batchIndex,
        staggerCursorMs,
        speedTier,
        width,
        height
      );
      batchIndex++;
      committed.add(entry);

      // Pre-warm text bitmap cache — see canvas-renderer.ts drainQueue for rationale.
      if (entry.content && this.config.outlineWidthPx > 0 && this.config.outlineOpacity > 0) {
        const warmColor =
          this.config.preserveUserColor && entry.userColor
            ? entry.userColor
            : (entry.authorType && this.config.authorColors[entry.authorType]) ||
              this.config.color ||
              DEFAULT_TEXT_COLOR;
        const farSpacing = speedTier === SPEED_TIER.FAR ? '1px' : undefined;
        warmTextBitmapCache(
          entry.content,
          this.getEffectiveFontSize(),
          this.config.fontWeight,
          this.config.fontFamily,
          warmColor,
          this.config.outlineWidthPx,
          this.config.outlineOpacity,
          this.textBitmapCache,
          this.ctx!,
          farSpacing
        );
      }
    }
    if (committed.size > 0) {
      let writeIdx = 0;
      for (let i = 0; i < this.pendingQueue.length; i++) {
        const entry = this.pendingQueue[i];
        if (entry !== undefined && !committed.has(entry)) {
          this.pendingQueue[writeIdx++] = entry;
        }
      }
      this.pendingQueue.length = writeIdx;
    }
  }

  private async prefetchImages(
    urls: string[],
    cache: ResizableByteLimitedCache<ImageBitmap>
  ): Promise<void> {
    if (this.isDestroyed) return;
    const generation = this.fetchGeneration;
    const toFetch = [...new Set(urls)].filter((u) => !cache.has(u) && !this.fetching.has(u));
    if (toFetch.length === 0) return;
    let idx = 0;
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(this.config?.emojiFetchLimit ?? 8, toFetch.length); i++) {
      workers.push(
        (async () => {
          while (idx < toFetch.length) {
            if (this.isDestroyed || generation !== this.fetchGeneration) break;
            const url = toFetch[idx++];
            if (url === undefined) break;
            if (!isAllowedImageUrl(url)) {
              this.fetching.delete(url);
              continue;
            }
            this.fetching.add(url);
            let timer: ReturnType<typeof setTimeout> | undefined;
            const controller = new AbortController();
            this.fetchControllers.add(controller);
            try {
              timer = setTimeout(
                () => controller.abort(),
                this.config?.emojiFetchTimeoutMs ?? EMOJI_FETCH_TIMEOUT_DEFAULT_MS
              );
              const response = await fetch(url, { signal: controller.signal });
              if (this.isPrefetchStale(generation, controller.signal)) continue;
              if (!response.ok) continue;
              const blob = await response.blob();
              if (this.isPrefetchStale(generation, controller.signal)) continue;
              const bitmap = await createImageBitmap(blob);
              if (this.isPrefetchStale(generation, controller.signal)) {
                bitmap.close();
                continue;
              }
              cache.set(url, bitmap);
            } catch {
              // silently skip
            } finally {
              clearTimeout(timer);
              this.fetchControllers.delete(controller);
              this.fetching.delete(url);
            }
          }
        })()
      );
    }
    await Promise.all(workers);
  }

  private isPrefetchStale(generation: number, signal: AbortSignal): boolean {
    return this.isDestroyed || generation !== this.fetchGeneration || signal.aborted;
  }
}

// ── Worker entry point ──

let renderer = new WorkerRenderer();
self.onmessage = (e: MessageEvent): void => {
  renderer.handleMessage(e);
};

/** Reset worker state for test isolation. */
export function resetWorkerForTests(): void {
  renderer = new WorkerRenderer();
}
