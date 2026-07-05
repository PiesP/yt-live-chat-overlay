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
 *   { type: 'resize', width: number, height: number }
 *   { type: 'addMessages', messages: WorkerMessage[] }
 *   { type: 'updateConfig', config: Partial<WorkerConfig> }
 *   { type: 'setPaused', paused: boolean }
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

import type { ChatMessage, FontWeight } from '@app-types';
import { ByteLimitedCache } from '@core/byte-limited-cache';
import {
  drawAuthorSection,
  drawRoundRect,
  renderRegularMessage,
  renderSegment,
  renderWrappedContentSegments,
  strokeTextOutline,
  type TextBitmapCache,
  toSharedContentSegments,
} from '@core/canvas-rendering-shared';
import type { CardConfigWorker } from '@core/card-config';
import { desaturateColor, toRgba } from '@core/color-utils';
import {
  computeScrollDuration,
  DEFAULT_TEXT_COLOR,
  rendererLayout,
  spacing,
} from '@core/design-tokens';
import {
  areSpeedTiersCompatible,
  buildLaneHeap,
  commitPlacementShared,
  computeBaseHeadwayPx,
  computeLaneY,
  computeOccupancyMs as computeOccupancyMsShared,
  heapGetSlotAvailableAt,
  type LaneAllocationState,
  resetBatchShared,
  shiftLaneTimersShared,
} from '@core/lane-allocation-shared';
import { LruMap } from '@core/lru-map';
import {
  ANTI_BLOCK_FREE_RATIO,
  ANTI_BLOCK_MAX_DURATION_MS,
  ANTI_BLOCK_PRIORITY_THRESHOLD,
  EMOJI_FETCH_TIMEOUT_DEFAULT_MS,
  EPSILON,
  FAR_LAYER_DESATURATION_FACTOR,
  GRADIENT_CACHE_MAX,
  HORIZONTAL_STAGGER_MAX,
  HORIZONTAL_STAGGER_PER_STEP,
  hashStringForTier as hashForTier,
  MS_TO_S,
  OPACITY_BUCKET_COUNT as OPACITY_BUCKETS,
  SPEED_TIER,
  STAGGER_BATCH_MAX,
  STAGGER_EXP_SCALE,
  STAGGER_QUEUE_HIGH,
  STAGGER_QUEUE_MED,
  TIER_NEAR_THRESHOLD,
  TRANSLATION_FONT_SCALE,
  TRANSLATION_GAP_PX,
  TRANSLATION_OPACITY_SCALE,
} from '@core/renderer-constants';
import {
  computeAgeFadeRate,
  computeInvFadeDuration,
  computeMessageOpacity,
  type OpacityConfig,
} from '@core/renderer-shared';
import { getFontString, measureBoundingBoxWidth } from '@core/text-measure';

import type {
  ActiveMessage,
  WorkerConfig,
  WorkerContentSegment,
  WorkerMessage,
} from './renderer-worker-types';

// ── Worker-specific constants ──────────────────────────────────────────────
const PULSE_ANGULAR_FREQ = Math.PI;
const MS_PER_SEC = MS_TO_S;

// ── Module-level state for standalone card renderer ──

const ctx: OffscreenCanvasRenderingContext2D | null = null;
const config: WorkerConfig | null = null;
const fontMetricsCache = new Map<string, { height: number }>();
let stickerCache!: ByteLimitedCache<ImageBitmap>;

function measureTextHeight(fontSize: number): number {
  if (!ctx) return Math.ceil(fontSize * 1.1);
  const font = ((): string => {
    if (!config) return `${fontSize}px sans-serif`;
    return getFontString(fontSize, config.fontWeight, config.fontFamily);
  })();
  let metrics = fontMetricsCache.get(font);
  if (!metrics) {
    ctx.font = font;
    const m = ctx.measureText('Mg');
    const ascent = Math.max(0, m.actualBoundingBoxAscent);
    const descent = Math.max(0, m.actualBoundingBoxDescent);
    metrics = { height: Math.ceil(ascent + descent) };
    fontMetricsCache.set(font, metrics);
  }
  return metrics.height;
}

// ── Config-driven paid card renderer (worker variant) ────────────────────────

function getPaidCardGradient(
  ctx: OffscreenCanvasRenderingContext2D,
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

/**
 * Render a paid card (SuperChat or Membership) driven entirely by a
 * CardConfigWorker. Mirrors the main-thread renderPaidCard but uses worker-safe
 * types (OffscreenCanvasRenderingContext2D, ByteLimitedCache<ImageBitmap>).
 *
 * All colours, dimensions, and flags are pre-resolved in the CardConfigWorker
 * — no callbacks or settings lookups needed.
 */
function renderPaidCardWorker(
  ctx: OffscreenCanvasRenderingContext2D,
  message: {
    author: string | undefined;
    authorPhotoUrl: string | undefined;
    content: readonly WorkerContentSegment[];
    /** Amount text for badge (e.g. "$5.00"). */
    badgeText: string | undefined;
    /** Header tag text (e.g. membership tier). */
    headerTagText: string | undefined;
    /** Sticker image URL. */
    stickerUrl: string | undefined;
  },
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
  authorPhotoCache: ByteLimitedCache<ImageBitmap>,
  emojiCache: ByteLimitedCache<ImageBitmap>,
  getFontFn: (fontSize: number) => string,
  gradientCache: Map<string, CanvasGradient>
): void {
  const w = msgWidth;
  const h = msgHeight;

  // ── 1. Resolve base colour ────────────────────────────────────────────
  const rgb = card.resolveColorRgb;
  const baseColor = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  const textColor = card.textColor;

  // Compute gradient opacities if background is gradient
  let topAlpha = 1;
  let scAlpha = 1;
  let bottomAlpha = 1;
  if (card.background === 'gradient' && card.backgroundGradient) {
    const bg = card.backgroundGradient;
    scAlpha = Math.min(1, Math.max(bg.minOpacity, 0.7)); // use configurable superChatOpacity from settings
    topAlpha = Math.min(1, scAlpha + bg.topBoost);
    bottomAlpha = Math.max(bg.minOpacity, scAlpha - bg.bottomReduction);
  }

  // ── 2. Background ─────────────────────────────────────────────────────
  if (card.background === 'gradient' && card.backgroundGradient) {
    const grad = getPaidCardGradient(
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
    ctx.translate(x, y);
    drawRoundRect(ctx, 0, 0, w, h, card.cardRadius);
    ctx.clip();
    ctx.fillStyle = `rgb(${barRgb.r}, ${barRgb.g}, ${barRgb.b})`;
    ctx.fillRect(0, 0, card.accentBar.width, h);
    ctx.restore();
  } else if (card.decoration === 'pulsingBorder' && card.pulsingBorder) {
    const pb = card.pulsingBorder;
    const pulse =
      Math.sin((elapsed / MS_PER_SEC) * PULSE_ANGULAR_FREQ) * pb.amplitude + pb.baseAlpha;
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
    cursorY = drawAuthorSection(
      ctx,
      // Safe cast: guarded by message.author check above, exactOptionalPropertyTypes compat
      { author: message.author, authorPhotoUrl: message.authorPhotoUrl } as {
        author?: string;
        authorPhotoUrl?: string;
      },
      textX,
      cursorY,
      textColor,
      card.authorNameMaxWidth,
      Math.round(fontSize * rendererLayout.authorFontScale),
      fontWeight,
      fontFamily,
      outlineWidthPx,
      outlineOpacity,
      (url: string) => authorPhotoCache.get(url),
      () => true,
      textBitmapCache,
      getFontFn
    );
  }

  // ── 6. Header tag (tier name / membership duration)
  if (card.headerTagEnabled && message.headerTagText) {
    const headerFontSize = Math.round(fontSize * card.headerTagFontSizeScale);
    const headerFont = getFontString(headerFontSize, fontWeight as FontWeight, fontFamily);
    ctx.save();
    ctx.font = headerFont;
    ctx.textBaseline = 'top';
    const headerMaxWidth = w - padH * 2;
    let displayText = message.headerTagText;
    if (ctx.measureText(displayText).width > headerMaxWidth) {
      let lo = 0,
        hi = displayText.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (ctx.measureText(`${displayText.slice(0, mid)}…`).width > headerMaxWidth) {
          hi = mid;
        } else {
          lo = mid + 1;
        }
      }
      displayText = lo > 0 ? `${displayText.slice(0, lo - 1)}…` : '…';
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
    const headerHeight = measureTextHeight(headerFontSize);
    cursorY += headerHeight + card.headerTagMarginTop + card.headerTagMarginBottom;
  }

  // ── 7. Badge (amount pill) — respects showSuperChatAmount setting
  if (card.badgeEnabled && card.showBadgeAmount && message.badgeText) {
    cursorY += spacing.xs;
    const badgeFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
    const badgeFont = getFontString(badgeFontSize, 'bold' as FontWeight, fontFamily);
    ctx.font = badgeFont;
    const badgeTextWidth = Math.ceil(ctx.measureText(message.badgeText).width);
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
      message.badgeText,
      textX + card.badgePaddingH,
      cursorY + badgeHeight / 2,
      DEFAULT_TEXT_COLOR,
      outlineWidthPx,
      outlineOpacity
    );
    ctx.fillStyle = DEFAULT_TEXT_COLOR;
    ctx.fillText(message.badgeText, textX + card.badgePaddingH, cursorY + badgeHeight / 2);
    ctx.textBaseline = 'top';
    ctx.fillStyle = prevFillStyle;
    ctx.strokeStyle = prevStrokeStyle;
    ctx.lineWidth = prevLineWidth;

    cursorY += badgeHeight;
  }

  // ── 8. Body text ──────────────────────────────────────────────────────
  let textBottomY = cursorY;
  if (message.content.length > 0) {
    const bodyMaxWidth = w - padH * 2;
    textBottomY = renderWrappedContentSegments(
      ctx,
      toSharedContentSegments(message.content),
      textX,
      cursorY + card.bodyMarginTop,
      bodyMaxWidth,
      card.bodyMaxLines,
      textColor,
      fontSize,
      outlineWidthPx,
      outlineOpacity,
      textBitmapCache,
      emojiCache as ByteLimitedCache<CanvasImageSource>,
      getFontFn
    );
  }

  // ── 9. Sticker (skip if no URL — worker doesn't have sticker cache) ────
  if (card.stickerEnabled && message.stickerUrl) {
    // Sticker images are handled via the main thread's imageData transfer.
    // Render if available in stickerCache.
    const stickerImg = stickerCache.get(message.stickerUrl);
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
  private pauseStartTime = 0;
  private antiBlockStartTime = 0;
  private invFadeMs = 0;
  private ageFadeRate = 0;
  private opacityConfig: OpacityConfig | null = null;
  private boundGetFont: (fontSize: number) => string = (fs: number) => `${fs}px sans-serif`;
  private static TEXT_MEASURE_CACHE_MAX = 500;
  private textMeasureCache = new Map<string, number>();
  private fontMetricsCache = new Map<string, { height: number }>();
  private activeMessages: ActiveMessage[] = [];
  private pendingQueue: WorkerMessage[] = [];
  private pendingQueueSortNeeded = false;
  private pendingQueueOffset = 0;
  private laneHeap: [number, number][] = [];
  private laneIndexToHeapIndex = new Map<number, number>();
  private laneHeight = 0;
  private numLanes = 0;
  private speedTierLanes = new Map<number, { tier: number; until: number }>();
  private collidedLanes = new Set<number>();
  private totalDrops = 0;
  private textBitmapCache!: ByteLimitedCache<OffscreenCanvas>;
  private emojiCache!: ByteLimitedCache<ImageBitmap>;
  private authorPhotoCache!: ByteLimitedCache<ImageBitmap>;
  private stickerCache!: ByteLimitedCache<ImageBitmap>;
  private superChatGradientCache = new LruMap<string, CanvasGradient>(GRADIENT_CACHE_MAX);
  private fetching = new Set<string>();
  private opacityBuckets: Array<Array<{ msg: ActiveMessage; elapsed: number }>> = Array.from(
    { length: OPACITY_BUCKETS },
    () => []
  );
  private statsFrameCounter = 0;
  private idleSince: number | null = null;
  private static readonly IDLE_GRACE_PERIOD_MS = 500;

  handleMessage(e: MessageEvent): void {
    try {
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
            const dpr = (data.dpr as number) || 1;
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            this.emojiCache = new ByteLimitedCache<ImageBitmap>(
              (this.config.emojiCacheMb ?? 4) * 1_000_000,
              WorkerRenderer.estimateBitmapBytes,
              (b) => b.close()
            );
            this.authorPhotoCache = new ByteLimitedCache<ImageBitmap>(
              (this.config.photoCacheMb ?? 4) * 1_000_000,
              WorkerRenderer.estimateBitmapBytes,
              (b) => b.close()
            );
            this.stickerCache = new ByteLimitedCache<ImageBitmap>(
              (this.config.stickerCacheMb ?? 4) * 1_000_000,
              WorkerRenderer.estimateBitmapBytes,
              (b) => b.close()
            );
            this.textBitmapCache = new ByteLimitedCache<OffscreenCanvas>(
              (this.config.textCacheMb ?? 4) * 1_000_000,
              (canvas) => canvas.width * canvas.height * 4
            );
            this.recomputeConfigDerived();
            this.initLanes(data.width as number, data.height as number);
            this.startRenderLoop();
            self.postMessage({ type: 'ready' });
            break;
          }
          case 'resize': {
            if (!this.canvas || !this.ctx) break;
            const newDpr = (data.dpr as number) || 1;
            const cssW = data.width as number;
            const cssH = data.height as number;
            this.canvas.width = cssW * newDpr;
            this.canvas.height = cssH * newDpr;
            this.ctx.setTransform(newDpr, 0, 0, newDpr, 0, 0);
            this.initLanes(cssW, cssH);
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
              Object.assign(this.config, data.config as Partial<WorkerConfig>);
              this.recomputeConfigDerived();
              this.textMeasureCache.clear();
              this.textBitmapCache.clear();
              this.emojiCache.clear();
              this.authorPhotoCache.clear();
              this.stickerCache.clear();
              this.superChatGradientCache.clear();
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
              const pausedMs = Math.max(0, now - this.pauseStartTime);
              for (const msg of this.activeMessages) {
                const elapsedBeforePause = now - pausedMs - msg.startTime;
                const remainingDisplay = msg.duration - elapsedBeforePause;
                const capped = Math.max(
                  0,
                  Math.min(pausedMs, Math.max(0, remainingDisplay) + 1000)
                );
                msg.pausedDuration += capped;
              }
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
            const translatedText = data.translatedText as string;
            for (const msg of this.activeMessages) {
              if (msg.id === msgId) {
                msg.translatedText = translatedText;
                break;
              }
            }
            for (const msg of this.pendingQueue) {
              if (msg.id === msgId) {
                msg.translatedText = translatedText;
                break;
              }
            }
            break;
          }
          case 'destroy':
            this.handleDestroy();
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
      const ascent = Math.max(0, m.actualBoundingBoxAscent);
      const descent = Math.max(0, m.actualBoundingBoxDescent);
      metrics = { height: Math.ceil(ascent + descent) };
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
      let minIdx = this.pendingQueueOffset;
      for (let i = this.pendingQueueOffset + 1; i < this.pendingQueue.length; i++) {
        if ((this.pendingQueue[i]?.priority ?? 0) < (this.pendingQueue[minIdx]?.priority ?? 0)) {
          minIdx = i;
        }
      }
      if (msg.priority > (this.pendingQueue[minIdx]?.priority ?? 0)) {
        this.pendingQueue[minIdx] = msg;
      }
      return;
    }
    this.pendingQueue.push(msg);
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
        } else if (now - this.idleSince >= WorkerRenderer.IDLE_GRACE_PERIOD_MS) {
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
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.ctx = null;
    this.canvas = null;
    this.activeMessages.length = 0;
    this.pendingQueue.length = 0;
    this.pendingQueueOffset = 0;
    this.textBitmapCache.clear();
    this.emojiCache.clear();
    this.authorPhotoCache.clear();
    this.stickerCache.clear();
    this.superChatGradientCache.clear();
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

  private initLanes(_width: number, height: number): void {
    if (!this.config || !this.ctx) return;
    const totalPaddingV = rendererLayout.paddingV * 2;
    const textHeight = this.measureTextHeight(this.config.fontSize);
    this.laneHeight = Math.max(1, textHeight + totalPaddingV + this.config.laneSpacing);
    const usableHeight = height * (1 - this.config.safeTop - this.config.safeBottom);
    this.numLanes = Math.max(1, Math.floor(usableHeight / this.laneHeight));
    const now = performance.now();
    this.laneHeap = buildLaneHeap(this.numLanes, now, this.laneIndexToHeapIndex);
    this.speedTierLanes.clear();
  }

  private static resetBatch(state: LaneAllocationState): void {
    resetBatchShared(state);
  }

  private findPlacement(
    msgHeight: number,
    speedTier: number
  ): { laneIndex: number; waitMs: number; laneY: number } | null {
    if (this.laneHeap.length === 0) return null;
    this.collidedLanes.clear();
    const now = performance.now();
    const slotCount = Math.max(1, Math.ceil(msgHeight / this.laneHeight));
    const result = this.allocateSingleLane(now, speedTier, slotCount);
    if (!result) return null;
    const laneY = computeLaneY(
      result.laneIndex,
      this.canvas?.height ?? 0,
      this.config?.safeTop ?? 0,
      this.laneHeight
    );
    return { ...result, laneY };
  }

  private allocateSingleLane(
    now: number,
    speedTier: number,
    slotCount: number
  ): { laneIndex: number; waitMs: number } | null {
    if (this.laneHeap.length === 0) return null;
    const maxWaitMs = (this.config as WorkerConfig).scrollDurationMaxMs;
    let firstBusy: { laneIndex: number; waitMs: number } | null = null;
    let speedMatched: { laneIndex: number; waitMs: number } | null = null;
    let zeroWaitCandidates: number[] | null = null;
    for (let i = 0; i < this.numLanes - slotCount + 1; i++) {
      let tierOk = true;
      for (let s = 0; s < slotCount; s++) {
        const active = this.speedTierLanes.get(i + s);
        if (active && active.until > now && !areSpeedTiersCompatible(speedTier, active.tier)) {
          tierOk = false;
          break;
        }
      }
      if (!tierOk) continue;
      if (this.collidedLanes.has(i)) continue;
      const avail = this.getSlotAvailableAt(i);
      if (avail === undefined) continue;
      const wait = Math.max(0, Math.ceil(avail - now));
      if (wait > 0) {
        if (!firstBusy) firstBusy = { laneIndex: i, waitMs: wait };
        const active = this.speedTierLanes.get(i);
        if ((!speedMatched || wait < speedMatched.waitMs) && active && active.tier === speedTier) {
          speedMatched = { laneIndex: i, waitMs: wait };
        }
        continue;
      }
      if (Math.random() < EPSILON) {
        if (!zeroWaitCandidates) {
          zeroWaitCandidates = [];
          for (let j = i + 1; j < this.numLanes - slotCount + 1; j++) {
            const availJ = this.getSlotAvailableAt(j);
            if (availJ !== undefined && Math.max(0, Math.ceil(availJ - now)) === 0) {
              let jTierOk = true;
              for (let s = 0; s < slotCount; s++) {
                const activeJ = this.speedTierLanes.get(j + s);
                if (
                  activeJ &&
                  activeJ.until > now &&
                  !areSpeedTiersCompatible(speedTier, activeJ.tier)
                ) {
                  jTierOk = false;
                  break;
                }
              }
              if (jTierOk) zeroWaitCandidates.push(j);
            }
          }
        }
        if (zeroWaitCandidates.length > 0) continue;
      }
      return { laneIndex: i, waitMs: 0 };
    }
    if (speedMatched && speedMatched.waitMs <= maxWaitMs) return speedMatched;
    if (firstBusy && firstBusy.waitMs <= maxWaitMs && speedTier !== SPEED_TIER.BACKLOG)
      return firstBusy;
    return null;
  }

  private commitPlacement(
    laneIndex: number,
    slotCount: number,
    startTime: number,
    durationMs: number,
    speedTier: number,
    msgWidth?: number
  ): void {
    if (!this.config) return;
    const screenWidth = this.canvas?.width ?? 1920;
    const occupancyMs = computeOccupancyMsShared(
      durationMs,
      this.config.exitPaddingPx,
      this.config.headwayGapRatio,
      msgWidth,
      screenWidth
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

  private getSlotAvailableAt(laneIndex: number): number | undefined {
    return heapGetSlotAvailableAt(
      this.laneHeap,
      this.laneIndexToHeapIndex,
      laneIndex,
      this.numLanes
    );
  }

  private static shiftLaneTimers(state: LaneAllocationState, ms: number): void {
    shiftLaneTimersShared(state, ms);
  }

  private activateMessage(
    msg: WorkerMessage,
    now: number,
    placement: { laneIndex: number; waitMs: number; laneY: number },
    batchIndex: number,
    screenWidth: number,
    _screenHeight: number
  ): void {
    if (!this.config) return;
    const mode = this.config.danmakuMode;
    const isScrolling = mode === 'scroll' || mode === 'reverse';
    let speedTier: number;
    if (msg.isBacklog) {
      speedTier = SPEED_TIER.BACKLOG;
    } else if (!this.config.depthLayersEnabled) {
      speedTier = SPEED_TIER.MID;
    } else if (!isScrolling) {
      speedTier = SPEED_TIER.MID;
    } else if (msg.kind === 'superchat' || msg.kind === 'membership') {
      speedTier = SPEED_TIER.NEAR;
    } else {
      const hash = hashForTier(msg.id);
      speedTier = hash < TIER_NEAR_THRESHOLD ? SPEED_TIER.NEAR : SPEED_TIER.FAR;
    }
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
    const pendingCount = this.pendingQueue.length;
    let effectiveMaxStagger = this.config.staggerMaxDelayMs;
    if (pendingCount > STAGGER_QUEUE_HIGH) effectiveMaxStagger = 0;
    else if (pendingCount > STAGGER_QUEUE_MED)
      effectiveMaxStagger = this.config.staggerMediumDelayMs;
    let staggerDelay = 0;
    if (batchIndex > 0 && isScrolling) {
      const staggeredIdx = Math.min(batchIndex, STAGGER_BATCH_MAX);
      staggerDelay = Math.round(
        Math.min(
          effectiveMaxStagger,
          staggeredIdx * -STAGGER_EXP_SCALE * Math.log(1 - Math.random())
        )
      );
    }
    const horizontalStagger =
      isScrolling && batchIndex > 0
        ? Math.min(HORIZONTAL_STAGGER_MAX, batchIndex * HORIZONTAL_STAGGER_PER_STEP)
        : 0;
    let startX: number;
    if (mode === 'scroll') startX = screenWidth + horizontalStagger;
    else if (mode === 'reverse') startX = -(msg.width + horizontalStagger);
    else startX = (screenWidth - msg.width) / 2;
    let duration: number;
    if (isScrolling) {
      const totalDistance =
        mode === 'scroll'
          ? startX + msg.width + this.config.exitPaddingPx
          : screenWidth - startX + this.config.exitPaddingPx;
      duration =
        speed > 0
          ? computeScrollDuration(
              totalDistance,
              speed,
              this.config.scrollDurationMinMs,
              this.config.scrollDurationMaxMs,
              this.config.exitPaddingPx
            )
          : this.config.scrollDurationMinMs;
    } else {
      duration = this.config.topBottomDurationMs;
    }
    if (msg.authorType === 'moderator' || msg.authorType === 'owner')
      duration *= this.config.modOwnerDurationMultiplier;
    const slotCount = Math.max(1, Math.ceil(msg.height / this.laneHeight));
    const laneY = placement.laneY;
    const authorColor =
      (msg.authorType && this.config.authorColors[msg.authorType]) ||
      this.config.color ||
      DEFAULT_TEXT_COLOR;
    const am: ActiveMessage = {
      id: msg.id,
      x: startX,
      y: laneY,
      startX,
      width: msg.width,
      height: msg.height,
      fadeStartTime: now + staggerDelay,
      startTime: now + staggerDelay,
      duration,
      invDuration: 1 / Math.max(1, duration),
      pausedDuration: 0,
      laneIndex: placement.laneIndex,
      laneSlotCount: slotCount,
      speedTier,
      text: msg.text,
      color: authorColor,
    };
    if (msg.authorType !== undefined) am.authorType = msg.authorType;
    if (msg.kind !== undefined) am.kind = msg.kind;
    if (msg.translatedText !== undefined) am.translatedText = msg.translatedText;
    if (msg.content !== undefined) am.content = msg.content;
    if (msg.author !== undefined) am.author = msg.author;
    if (msg.authorPhotoUrl !== undefined) am.authorPhotoUrl = msg.authorPhotoUrl;
    if (msg.superChatAmount !== undefined) am.superChatAmount = msg.superChatAmount;
    if (msg.superChatStickerUrl !== undefined) am.superChatStickerUrl = msg.superChatStickerUrl;
    if (msg.membershipHeader !== undefined) am.membershipHeader = msg.membershipHeader;
    if (msg.cardConfigWorker !== undefined) am.cardConfigWorker = msg.cardConfigWorker;
    this.commitPlacement(
      placement.laneIndex,
      slotCount,
      now + staggerDelay,
      duration,
      speedTier,
      isScrolling ? msg.width : undefined
    );
    this.activeMessages.push(am);
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
  }

  private cleanupExpired(now: number): void {
    let writeIdx = 0;
    for (let i = 0; i < this.activeMessages.length; i++) {
      const m = this.activeMessages[i];
      if (!m) continue;
      if (now - m.startTime - m.pausedDuration >= m.duration) continue;
      this.activeMessages[writeIdx++] = m;
    }
    this.activeMessages.length = writeIdx;
  }

  private renderFrame(): void {
    if (!this.ctx || !this.canvas || !this.config || this.isPaused) return;
    const cfg = this.config;
    const now = performance.now();
    const width = this.canvas.width;
    const height = this.canvas.height;
    WorkerRenderer.resetBatch(this.laneState);
    this.drainQueue(now, width, height);
    this.cleanupExpired(now);
    this.ctx.clearRect(0, 0, width, height);
    if (this.activeMessages.length === 0) {
      this.statsFrameCounter++;
      if (this.statsFrameCounter >= 60) {
        this.statsFrameCounter = 0;
        self.postMessage({
          type: 'stats',
          activeMessages: 0,
          drops: this.totalDrops,
          pendingQueueDepth: this.pendingQueue.length,
        });
      }
      return;
    }
    const mode = this.config.danmakuMode;
    const isScrolling = mode === 'scroll' || mode === 'reverse';
    const strokeWidth =
      this.config.outlineWidthPx > 0 && this.config.outlineOpacity > 0
        ? this.config.outlineWidthPx
        : 0;
    for (const bucket of this.opacityBuckets) bucket.length = 0;
    for (let i = 0; i < this.activeMessages.length; i++) {
      const msg = this.activeMessages[i];
      if (!msg) continue;
      const elapsed = now - msg.startTime - msg.pausedDuration;
      if (elapsed < 0) continue;
      const progress = Math.min(1, Math.max(0, elapsed * msg.invDuration));
      const isReducedMotionActive = this.config.reducedMotion && !this.config.ignoreReducedMotion;
      if (mode === 'scroll') {
        if (!isReducedMotionActive) {
          msg.x = msg.startX - progress * (msg.startX + msg.width + this.config.exitPaddingPx);
        } else {
          msg.x = Math.max(0, (width - msg.width) / 2);
        }
      } else if (mode === 'reverse') {
        if (!isReducedMotionActive) {
          msg.x = msg.startX + progress * (width - msg.startX + this.config.exitPaddingPx);
        } else {
          msg.x = Math.max(0, (width - msg.width) / 2);
        }
      }
      const oc = this.opacityConfig;
      const fadeElapsed = now - msg.fadeStartTime - msg.pausedDuration;
      const opacity = oc
        ? computeMessageOpacity(
            { isBacklog: msg.speedTier === SPEED_TIER.BACKLOG } as ChatMessage,
            fadeElapsed,
            msg.duration,
            isScrolling,
            msg.speedTier,
            oc
          )
        : 0;
      if (opacity <= 0) continue;
      const bucketIndex = Math.min(
        OPACITY_BUCKETS - 1,
        Math.round(opacity * (OPACITY_BUCKETS - 1))
      );
      this.opacityBuckets[bucketIndex]?.push({ msg, elapsed });
    }
    this.ctx.textBaseline = 'top';
    const getFont = this.boundGetFont;
    for (let bucketIndex = 0; bucketIndex < OPACITY_BUCKETS; bucketIndex++) {
      const entries = this.opacityBuckets[bucketIndex];
      if (!entries || entries.length === 0) continue;
      this.ctx.globalAlpha = bucketIndex / (OPACITY_BUCKETS - 1);
      try {
        for (const { msg, elapsed } of entries) {
          let renderColor = msg.colorOverride || msg.color;
          if (msg.speedTier === SPEED_TIER.FAR && !msg.colorOverride) {
            renderColor = desaturateColor(renderColor, FAR_LAYER_DESATURATION_FACTOR);
            msg.colorOverride = renderColor;
          }
          const sx = Math.floor(msg.x);
          if (sx + msg.width <= 0) continue;
          const sy = Math.floor(msg.y);
          if (msg.cardConfigWorker) {
            renderPaidCardWorker(
              this.ctx,
              {
                author: msg.author,
                authorPhotoUrl: msg.authorPhotoUrl,
                content: msg.content ?? [],
                badgeText: msg.superChatAmount,
                headerTagText: msg.membershipHeader,
                stickerUrl: msg.superChatStickerUrl,
              },
              msg.width,
              msg.height,
              sx,
              sy,
              elapsed,
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
              this.superChatGradientCache
            );
          } else {
            const overrideText =
              cfg.translationEnabled && cfg.translationMode === 'replace' && msg.translatedText
                ? msg.translatedText
                : null;
            renderRegularMessage(
              this.ctx,
              {
                ...(msg.author !== undefined ? { author: msg.author } : {}),
                ...(msg.authorPhotoUrl !== undefined ? { authorPhotoUrl: msg.authorPhotoUrl } : {}),
                content: msg.content ?? [],
                text: msg.text,
              },
              sx,
              sy,
              {
                showAuthor: true,
                fontSize: cfg.fontSize,
                fontWeight: cfg.fontWeight,
                fontFamily: cfg.fontFamily,
                color: renderColor,
                outlineWidthPx: strokeWidth,
                outlineOpacity: cfg.outlineOpacity,
              },
              this.textBitmapCache,
              (url: string) => this.emojiCache.get(url),
              () => true,
              { get: (url: string) => this.authorPhotoCache.get(url) },
              () => true,
              getFont,
              this.measureTextCached.bind(this),
              overrideText
            );
          }
          if (
            cfg.translationEnabled &&
            cfg.translationMode === 'dual' &&
            msg.translatedText &&
            msg.translatedText !== msg.text
          ) {
            const translationFontSize = Math.round(cfg.fontSize * TRANSLATION_FONT_SCALE);
            const translationColor = msg.authorType
              ? cfg.authorColors[msg.authorType] || renderColor
              : renderColor;
            const translationY = sy + msg.height - translationFontSize - TRANSLATION_GAP_PX;
            this.ctx.save();
            try {
              this.ctx.globalAlpha =
                (bucketIndex / (OPACITY_BUCKETS - 1)) * TRANSLATION_OPACITY_SCALE;
              renderSegment(
                this.ctx,
                msg.translatedText,
                sx,
                Math.floor(translationY),
                translationColor,
                translationFontSize,
                strokeWidth,
                cfg.outlineOpacity,
                this.textBitmapCache,
                (_fs: number) => getFontString(translationFontSize, 'normal', cfg.fontFamily)
              );
            } finally {
              this.ctx.restore();
            }
          }
        }
      } finally {
        this.ctx.globalAlpha = 1;
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
      });
    }
  }

  private checkCollision(
    placement: { laneIndex: number; waitMs: number; laneY: number },
    newMsgHeight: number,
    newSpeedTier: number,
    now: number,
    screenWidth: number
  ): boolean {
    if (!this.config) return true;
    const mode = this.config.danmakuMode;
    const isScrolling = mode === 'scroll' || mode === 'reverse';
    const newTop = placement.laneY;
    const newBottom = placement.laneY + newMsgHeight;
    for (let i = 0; i < this.activeMessages.length; i++) {
      const active = this.activeMessages[i];
      if (!active) continue;
      const activeElapsed = now - active.startTime - active.pausedDuration;
      if (activeElapsed < 0) continue;
      if (active.y + active.height <= newTop || active.y >= newBottom) continue;
      if (isScrolling) {
        let headwayPx = computeBaseHeadwayPx(active.width, this.config.headwayGapRatio);
        if (newSpeedTier > active.speedTier)
          headwayPx = Math.round(headwayPx * this.config.backlogSpeedMultiplier);
        const activeProgress = Math.min(1, Math.max(0, activeElapsed * active.invDuration));
        if (mode === 'scroll') {
          if (
            active.startX -
              activeProgress * (active.startX + active.width + this.config.exitPaddingPx) +
              active.width >
            screenWidth - headwayPx
          ) {
            this.collidedLanes.add(placement.laneIndex);
            return false;
          }
        } else {
          if (
            active.startX +
              activeProgress * (screenWidth - active.startX + this.config.exitPaddingPx) +
              active.width >
            -headwayPx
          ) {
            this.collidedLanes.add(placement.laneIndex);
            return false;
          }
        }
      } else {
        if (activeElapsed < active.duration) {
          this.collidedLanes.add(placement.laneIndex);
          return false;
        }
      }
    }
    return true;
  }

  private drainQueue(now: number, width: number, height: number): void {
    if (!this.config) return;
    if (this.pendingQueueSortNeeded && this.pendingQueue.length > 0) {
      this.pendingQueue.sort((a, b) => b.priority - a.priority);
      this.pendingQueueSortNeeded = false;
    }
    if (this.pendingQueueOffset > 64) {
      this.pendingQueue.splice(0, this.pendingQueueOffset);
      this.pendingQueueOffset = 0;
    }
    let batchIndex = 0;
    let occupiedCount = 0;
    for (let h = 0; h < this.laneHeap.length; h++) {
      const entry = this.laneHeap[h];
      if (entry && entry[1] > now) occupiedCount++;
    }
    const laneUtilization = occupiedCount / Math.max(1, this.numLanes);
    let isAntiBlock = laneUtilization >= 1 - ANTI_BLOCK_FREE_RATIO;
    if (isAntiBlock) {
      if (this.antiBlockStartTime === 0) {
        this.antiBlockStartTime = now;
      } else if (now - this.antiBlockStartTime >= ANTI_BLOCK_MAX_DURATION_MS) {
        isAntiBlock = false;
      }
    } else {
      this.antiBlockStartTime = 0;
    }
    const committed = new Set<WorkerMessage>();
    for (let i = this.pendingQueueOffset; i < this.pendingQueue.length; i++) {
      const entry = this.pendingQueue[i];
      if (!entry) continue;
      if (this.activeMessages.length >= this.config.maxConcurrentMessages) break;
      if (isAntiBlock && entry.priority < ANTI_BLOCK_PRIORITY_THRESHOLD) {
        if (Math.random() >= (1 - laneUtilization) / ANTI_BLOCK_FREE_RATIO) continue;
      }
      let speedTier: number;
      if (entry.isBacklog) {
        speedTier = SPEED_TIER.BACKLOG;
      } else if (!this.config.depthLayersEnabled) {
        speedTier = SPEED_TIER.MID;
      } else if (this.config.danmakuMode !== 'scroll' && this.config.danmakuMode !== 'reverse') {
        speedTier = SPEED_TIER.MID;
      } else if (entry.kind === 'superchat' || entry.kind === 'membership') {
        speedTier = SPEED_TIER.NEAR;
      } else {
        speedTier = hashForTier(entry.id) < TIER_NEAR_THRESHOLD ? SPEED_TIER.NEAR : SPEED_TIER.FAR;
      }
      const placement = this.findPlacement(entry.height, speedTier);
      if (!placement) {
        this.totalDrops++;
        continue;
      }
      if (!this.checkCollision(placement, entry.height, speedTier, now, width)) continue;
      this.activateMessage(entry, now, placement, batchIndex, width, height);
      batchIndex++;
      committed.add(entry);
    }
    if (committed.size > 0) {
      let writeIdx = this.pendingQueueOffset;
      for (let i = this.pendingQueueOffset; i < this.pendingQueue.length; i++) {
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
    cache: ByteLimitedCache<ImageBitmap>
  ): Promise<void> {
    const toFetch = urls.filter((u) => !cache.has(u) && !this.fetching.has(u));
    if (toFetch.length === 0) return;
    let idx = 0;
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(this.config?.emojiFetchLimit ?? 8, toFetch.length); i++) {
      workers.push(
        (async () => {
          while (idx < toFetch.length) {
            const url = toFetch[idx++];
            if (url === undefined) break;
            this.fetching.add(url);
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const controller = new AbortController();
              timer = setTimeout(
                () => controller.abort(),
                this.config?.emojiFetchTimeoutMs ?? EMOJI_FETCH_TIMEOUT_DEFAULT_MS
              );
              const response = await fetch(url, { signal: controller.signal });
              if (!response.ok) continue;
              const blob = await response.blob();
              const bitmap = await createImageBitmap(blob);
              cache.set(url, bitmap);
            } catch {
              // silently skip
            } finally {
              clearTimeout(timer);
              this.fetching.delete(url);
            }
          }
        })()
      );
    }
    await Promise.all(workers);
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
