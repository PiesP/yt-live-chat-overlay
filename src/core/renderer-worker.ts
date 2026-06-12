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
  buildWrappedLines,
  drawAuthorSection,
  drawRoundRect,
  type RegularMessageLike,
  renderRegularMessage,
  renderSegment,
  strokeTextOutline,
  type TextBitmapCache,
} from '@core/canvas-rendering-shared';
import type { CardConfigWorker } from '@core/card-config';
import { EMOJI_ALIAS_PATTERN } from '@core/chat-message-helpers';
import { toRgba } from '@core/color-utils';
import {
  computeScrollDuration,
  DEFAULT_TEXT_COLOR,
  rendererLayout,
  spacing,
} from '@core/design-tokens';
import {
  areSpeedTiersCompatible,
  computeLaneY,
  computeOccupancyMs as computeOccupancyMsShared,
  heapGetSlotAvailableAt,
  heapSiftDown,
  heapUpdateLane,
} from '@core/lane-allocation-shared';
import { LruMap } from '@core/lru-map';
import {
  ANTI_BLOCK_FREE_RATIO,
  ANTI_BLOCK_PRIORITY_THRESHOLD,
  DRAIN_QUEUE_MAX_SKIP as DRAIN_MAX_SKIP,
  desaturateColor,
  EPSILON,
  FAR_LAYER_DESATURATION_FACTOR,
  HORIZONTAL_STAGGER_MAX,
  HORIZONTAL_STAGGER_PER_STEP,
  hashStringForTier as hashForTier,
  OPACITY_BUCKET_COUNT as OPACITY_BUCKETS,
  SPEED_TIER,
  STAGGER_BATCH_MAX,
  STAGGER_EXP_SCALE,
  TIER_NEAR_THRESHOLD,
  TRANSLATION_FONT_SCALE,
  TRANSLATION_GAP_PX,
  TRANSLATION_OPACITY_SCALE,
} from '@core/renderer-constants';
import { computeMessageOpacity, type OpacityConfig } from '@core/renderer-shared';
import { getFontString } from '@core/text-measure';

// ── Types ─────────────────────────────────────────────────────────────────

interface WorkerConfig {
  /** Pixels per second scroll speed (100–400). */
  speedPxPerSec: number;
  /** Font size in logical pixels. */
  fontSize: number;
  /** Font weight: 'normal' | 'bold'. */
  fontWeight: FontWeight;
  /** CSS font-family value. */
  fontFamily: string;
  /** Base opacity (0–1). */
  opacity: number;
  /** Vertical lane spacing in px. */
  laneSpacing: number;
  /** Safe zone top ratio (0–1). */
  safeTop: number;
  /** Safe zone bottom ratio (0–1). */
  safeBottom: number;
  /** Max concurrent messages on screen. */
  maxConcurrentMessages: number;
  /** Danmaku mode. */
  danmakuMode: 'scroll' | 'reverse' | 'top' | 'bottom';
  /** Backlog speed multiplier. */
  backlogSpeedMultiplier: number;
  /** Depth layers enabled. */
  depthLayersEnabled: boolean;
  /** Far-layer speed multiplier. */
  depthFarSpeedMul: number;
  /** Near-layer speed multiplier. */
  depthNearSpeedMul: number;
  /** Far-layer opacity multiplier. */
  depthFarOpacityMul: number;
  /** Backlog opacity multiplier. */
  backlogOpacityMultiplier: number;
  /** Fade-out duration in ms. */
  fadeDurationMs: number;
  /** Max message age for age-based fade-out (ms). */
  maxMessageAgeMs: number;
  /** Text color (CSS string) for regular messages. */
  color: string;
  /** Per-author-type color map (CSS strings). */
  authorColors: Record<string, string>;
  /** Duration multiplier for moderator/owner messages. */
  modOwnerDurationMultiplier: number;
  /** Outline width in px. */
  outlineWidthPx: number;
  /** Outline opacity. */
  outlineOpacity: number;
  /** SuperChat color opacity (0.35–1.0). */
  superChatOpacity: number;
  /** Maximum body text lines for SuperChat cards. */
  superChatMaxBodyLines: number;
  /** Maximum body text lines for Membership messages. */
  membershipMaxBodyLines: number;
  /** Author display settings (per-authorType visibility). */
  showAuthor: Record<string, boolean>;
  /** Translation enabled flag. */
  translationEnabled: boolean;
  /** Translation display mode: 'dual' or 'replace'. */
  translationMode: 'dual' | 'replace';
  /** Toggle Super Chat purchase amount badge display. */
  showSuperChatAmount: boolean;
  /** Extra pixels past screen edge before exit (px). */
  exitPaddingPx: number;
  /** Minimum scroll animation duration (ms). */
  scrollDurationMinMs: number;
  /** Maximum scroll animation duration (ms). */
  scrollDurationMaxMs: number;
  /** Display duration for top/bottom mode (ms). */
  topBottomDurationMs: number;
  /** Headway gap as fraction of message width (0-1). */
  headwayGapRatio: number;
  /** Max pending queue depth. */
  queueMaxSize: number;
  /** Background queue trim target. */
  /** Emoji image cache budget in MB. */
  emojiCacheMb: number;
  /** Author photo cache budget in MB. */
  photoCacheMb: number;
  /** Sticker image cache budget in MB. */
  stickerCacheMb: number;
  /** Text bitmap cache budget in MB. */
  textCacheMb: number;
  /** Max translations to apply per frame. */
  /** Max concurrent emoji fetch operations. */
  emojiFetchLimit: number;
  /** Minutes before retrying failed emoji fetches. */
  failedEmojiRetryMins: number;
  staggerMaxDelayMs: number;
  emojiFetchTimeoutMs: number;
}

interface WorkerContentSegment {
  type: 'text' | 'emoji';
  /** Text content, OR emoji character. */
  content: string;
  /** Emoji image URL (only for type='emoji'). */
  emojiUrl?: string;
  /** Emoji alt text fallback (only for type='emoji'). */
  emojiAlt?: string;
}

interface WorkerMessage {
  /** Unique message ID. */
  id: string;
  /** Plain text content (pre-extracted). */
  text: string;
  /** Width/height estimates (computed on main thread). */
  width: number;
  height: number;
  /** Priority: 100+ = superchat, 80 = membership, 50 = mod/owner, 0 = normal. */
  priority: number;
  /** Whether this is a backlog (past chat) message. */
  isBacklog: boolean;
  /** Translated text (if available). */
  translatedText?: string;
  /** Author type for color selection: normal, moderator, owner, member, etc. */
  authorType?: string;
  /** Message kind: 'chat', 'superchat', 'membership', etc. */
  kind?: string;
  /** Burst speed multiplier computed by main thread (>= 1.0). */
  burstSpeedMultiplier?: number;
  /** Content segments: text + emoji with URLs. */
  content?: WorkerContentSegment[];
  /** Author display name. */
  author?: string;
  /** Author photo URL. */
  authorPhotoUrl?: string;
  // ── SuperChat card data ──
  /** Formatted amount string (e.g. "$5.00"). */
  superChatAmount?: string;
  /** Sticker image URL. */
  superChatStickerUrl?: string;
  /** Membership header text (e.g. member tier/duration). */
  membershipHeader?: string;
  /** Optional CardConfigWorker for config-driven renderPaidCardWorker(). */
  cardConfigWorker?: CardConfigWorker;
}

interface ActiveMessage {
  id: string;
  x: number;
  y: number;
  startX: number;
  width: number;
  height: number;
  /** Position/animation start time (includes stagger delay). */
  startTime: number;
  /** Opacity/fade start time (drain time, before stagger offset). */
  activationTime: number;
  duration: number;
  /** Pre-computed 1/duration for per-frame multiplication (avoids division). */
  invDuration: number;
  pausedDuration: number;
  laneIndex: number;
  laneSlotCount: number;
  speedTier: number;
  text: string;
  /** Per-author color CSS string. */
  color: string;
  /** Author type for stats/desaturation. */
  authorType?: string;
  /** Message kind for speed tiering. */
  kind?: string;
  /** Translated text for dual/replace display. */
  translatedText?: string;
  /** Desaturated color for far-depth layer. */
  colorOverride?: string;
  /** Content segments for emoji/text rendering. */
  content?: WorkerContentSegment[];
  /** Author display name. */
  author?: string;
  /** Author photo URL. */
  authorPhotoUrl?: string;
  /** Formatted SuperChat amount (e.g. "$5.00"). */
  superChatAmount?: string;
  /** SuperChat sticker image URL. */
  superChatStickerUrl?: string;
  /** Membership header text. */
  membershipHeader?: string;
  /** Optional CardConfigWorker for config-driven renderPaidCardWorker(). */
  cardConfigWorker?: CardConfigWorker;
}

// ── Worker-specific constants ──────────────────────────────────────────────

/** Angular frequency for pulsing-border animation (half-cycle per second). */
const PULSE_ANGULAR_FREQ = Math.PI;
/** Milliseconds per second, for time-unit conversions in animation math. */
const MS_PER_SEC = 1000;

// ── Globals (worker scope) ───────────────────────────────────────────────

let ctx: OffscreenCanvasRenderingContext2D | null = null;
let canvas: OffscreenCanvas | null = null;
let config: WorkerConfig | null = null;
let animFrameId: number | null = null;
let isDestroyed = false;
let isPaused = false;
let pauseStartTime = 0;

// Pre-computed invariants (updated on config change to avoid per-frame division)
let invFadeMs = 0;
let ageFadeRate = 0;
let opacityConfig: OpacityConfig | null = null;
let boundGetFont: (fontSize: number) => string = (fs: number) => `${fs}px sans-serif`;

/** Recompute cached values derived from config (called on init + updateConfig). */
function recomputeConfigDerived(): void {
  if (!config) return;
  const c = config; // narrow for closure safety (module-level let config)
  invFadeMs = c.fadeDurationMs > 0 ? 1 / Math.max(1, c.fadeDurationMs) : 0;
  ageFadeRate = 1 / c.maxMessageAgeMs;
  boundGetFont = (fontSize: number): string => `${c.fontWeight} ${fontSize}px ${c.fontFamily}`;
  opacityConfig = {
    baseOpacity: c.opacity,
    fadeDurationMs: c.fadeDurationMs,
    invFadeDuration: invFadeMs,
    backlogOpacityMultiplier: c.backlogOpacityMultiplier,
    depthLayersEnabled: c.depthLayersEnabled,
    depthFarOpacityMul: c.depthFarOpacityMul,
    ageFadeRate,
  };
}

// Text measurement cache (cleared on font config change)
const TEXT_MEASURE_CACHE_MAX = 500;
const textMeasureCache = new Map<string, number>();
function measureTextCached(text: string): number {
  if (!ctx) return 0;
  let w = textMeasureCache.get(text);
  if (w === undefined) {
    const m = ctx.measureText(text);
    const bbWidth = Math.abs(m.actualBoundingBoxLeft) + Math.abs(m.actualBoundingBoxRight);
    w = bbWidth > 0 ? Math.ceil(bbWidth) : Math.ceil(m.width);
    // LRU eviction: delete oldest entry when at capacity, then re-insert
    if (textMeasureCache.size >= TEXT_MEASURE_CACHE_MAX) {
      const oldestKey = textMeasureCache.keys().next().value;
      if (oldestKey !== undefined) textMeasureCache.delete(oldestKey);
    }
    textMeasureCache.set(text, w);
  }
  return w;
}

// Font metrics cache — keyed by font string
const fontMetricsCache = new Map<string, { height: number; ascent: number }>();

/** Build a CSS font string from the current worker config. */
function getFontFromConfig(fontSize: number): string {
  if (!config) return `${fontSize}px sans-serif`;
  return `${config.fontWeight} ${fontSize}px ${config.fontFamily}`;
}

/**
 * Measure the full bounding-box height of the font's rendered glyphs.
 *
 * Uses the OffscreenCanvas context to measure "Mg" — capital M gives a reliable
 * ascent and lowercase g gives a reliable descent. Results are cached because
 * the same font string always produces identical metrics regardless of fontSize.
 * Falls back to a fontSize-based estimate when ctx is unavailable.
 */
function measureTextHeight(fontSize: number): number {
  if (!ctx) return Math.ceil(fontSize * 1.1); // fallback
  const font = getFontFromConfig(fontSize);
  let metrics = fontMetricsCache.get(font);
  if (!metrics) {
    ctx.font = font;
    const m = ctx.measureText('Mg');
    const ascent = Math.max(0, m.actualBoundingBoxAscent);
    const descent = Math.max(0, m.actualBoundingBoxDescent);
    metrics = {
      height: Math.ceil(ascent + descent),
      ascent: Math.ceil(ascent),
    };
    fontMetricsCache.set(font, metrics);
  }
  return metrics.height;
}

// Active messages (renderable)
const activeMessages: ActiveMessage[] = [];

// Pending queue (waiting for lane allocation)
const pendingQueue: WorkerMessage[] = [];
let pendingQueueSortNeeded = false;
let pendingQueueOffset = 0;
const retryQueue: WorkerMessage[] = [];

// Lane allocator state — heap of [laneIndex, availableAtMs]
let laneHeap: [number, number][] = [];
const laneIndexToHeapIndex = new Map<number, number>();
let laneHeight = 0;
let numLanes = 0;
// Track speed-tier occupancy per lane
const speedTierLanes = new Map<number, { tier: number; until: number }>();

// Collision feedback: lanes already used in this batch
const collidedLanes = new Set<number>();

// Cumulative drop counter for stats
let totalDrops = 0;

// ── Text bitmap cache ──────────────────────────────────────────────────────

let textBitmapCache: ByteLimitedCache<OffscreenCanvas>;

let emojiCache: ByteLimitedCache<ImageBitmap>;
let authorPhotoCache: ByteLimitedCache<ImageBitmap>;
let stickerCache: ByteLimitedCache<ImageBitmap>;
const superChatGradientCache = new LruMap<string, CanvasGradient>(64);

// ── Image prefetch utility (semaphore-based concurrency) ──────────────────

/** Estimate byte size of an ImageBitmap (RGBA). */
function estimateBitmapBytes(bitmap: ImageBitmap): number {
  return bitmap.width * bitmap.height * 4;
}

/** In-flight URLs to avoid duplicate prefetches. */
const fetching = new Set<string>();

/**
 * Semaphore-based concurrent image prefetch.
 * Fetches images and inserts them into the given ByteLimitedCache.
 */
async function prefetchImages(urls: string[], cache: ByteLimitedCache<ImageBitmap>): Promise<void> {
  const toFetch = urls.filter((u) => !cache.has(u) && !fetching.has(u));
  if (toFetch.length === 0) return;

  // Semaphore pattern: process all URLs with concurrency limit
  let idx = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(config?.emojiFetchLimit ?? 8, toFetch.length); i++) {
    workers.push(
      (async () => {
        while (idx < toFetch.length) {
          const url = toFetch[idx++];
          if (url === undefined) break;
          fetching.add(url);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const controller = new AbortController();
            timer = setTimeout(() => controller.abort(), config?.emojiFetchTimeoutMs ?? 30_000);
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) continue;
            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob);
            cache.set(url, bitmap);
          } catch {
            // Network errors, aborts, decode failures — silently skip
          } finally {
            clearTimeout(timer);
            fetching.delete(url);
          }
        }
      })()
    );
  }
  await Promise.all(workers);
}

/**
 * Pre-allocated opacity buckets for per-frame reuse.
 * Bucket index = Math.round(opacity * (OPACITY_BUCKETS - 1)), yielding 21 buckets.
 * Each frame resets bucket lengths instead of allocating new arrays, eliminating
 * per-frame GC pressure and reducing ctx.globalAlpha set/reset pairs.
 */
const opacityBuckets: Array<Array<{ msg: ActiveMessage; elapsed: number }>> = Array.from(
  { length: OPACITY_BUCKETS },
  () => []
);

// ── Ported rendering functions from canvas-text-renderer / canvas-card-renderers ──

/** Outline stroke scale factor. */
// OUTLINE_STROKE_SCALE imported from @core/renderer-constants

// strokeTextOutline imported from @core/canvas-rendering-shared

// renderSegment imported from @core/canvas-rendering-shared

// renderContentSegments imported from @core/canvas-rendering-shared

// ── Wrapped content segments (text + emoji) ────────────────────────────────

/**
 * Render WorkerContentSegment[] with word-wrapping, respecting maxWidth and maxLines.
 *
 * Uses buildWrappedLines for line-breaking (SSOT shared with the
 * dimension estimator), then renders each line via renderSegment (text) or
 * emojiCache (emoji images).
 *
 * @returns The Y position after the last rendered line.
 */
function renderWrappedContentSegments(
  ctx: OffscreenCanvasRenderingContext2D,
  segments: readonly WorkerContentSegment[],
  x: number,
  y: number,
  maxWidth: number,
  maxLines: number,
  color: string,
  fontSize: number,
  outlineWidthPx: number,
  outlineOpacity: number,
  textBitmapCache: TextBitmapCache,
  emojiCache: ByteLimitedCache<ImageBitmap>,
  getFontFn: (fontSize: number) => string
): number {
  if (segments.length === 0) return y;

  const font = getFontFn(fontSize);
  const emojiSize = Math.round(fontSize * rendererLayout.emojiSize);
  const lineHeight = measureTextHeight(fontSize);
  const ellipsis = '\u2026';

  // Set font once for all measureText calls inside buildWrappedLines
  ctx.font = font;
  const { lines } = buildWrappedLines(segments, maxWidth, emojiSize, measureTextCached);

  // ── Render lines (up to maxLines) ────────────────────────────────────
  const renderLines = lines.length > maxLines ? lines.slice(0, maxLines) : lines;
  const isTruncated = lines.length > maxLines;
  let cursorY = y;

  for (let li = 0; li < renderLines.length; li++) {
    const line = renderLines[li];
    if (!line) continue;
    const isLastLine = li === renderLines.length - 1;
    const needsEllipsis = isLastLine && isTruncated;
    let cursorX = x;
    let prevText = false;

    for (const piece of line) {
      // Space gap between text words
      if (prevText && piece.type === 'text') {
        cursorX += ctx.measureText(' ').width;
      }
      prevText = piece.type === 'text';

      if (piece.type === 'text') {
        renderSegment(
          ctx,
          piece.text,
          cursorX,
          cursorY,
          color,
          fontSize,
          outlineWidthPx,
          outlineOpacity,
          textBitmapCache,
          getFontFn
        );
        cursorX += piece.width;
      } else {
        // Emoji
        const img = piece.emojiUrl ? emojiCache.get(piece.emojiUrl) : null;
        if (img) {
          ctx.drawImage(img, cursorX, cursorY, emojiSize, emojiSize);
        } else if (piece.emojiAlt && !EMOJI_ALIAS_PATTERN.test(piece.emojiAlt)) {
          renderSegment(
            ctx,
            piece.emojiAlt,
            cursorX,
            cursorY,
            color,
            fontSize,
            outlineWidthPx,
            outlineOpacity,
            textBitmapCache,
            getFontFn
          );
        }
        cursorX += piece.width;
      }
    }

    // Append ellipsis if this line was truncated
    if (needsEllipsis) {
      renderSegment(
        ctx,
        ellipsis,
        cursorX,
        cursorY,
        color,
        fontSize,
        outlineWidthPx,
        outlineOpacity,
        textBitmapCache,
        getFontFn
      );
    }

    cursorY += lineHeight;
  }

  return cursorY;
}

// ── Config-driven paid card renderer (worker variant) ────────────────────────

/** Max cached gradients for renderPaidCardWorker LRU eviction. */
const PAID_CARD_GRADIENT_CACHE_MAX = 100;

/** Get or create a cached linear gradient (top-to-bottom) within the worker. */
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
  if (cache.size >= PAID_CARD_GRADIENT_CACHE_MAX) {
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
      message.content,
      textX,
      cursorY + card.bodyMarginTop,
      bodyMaxWidth,
      card.bodyMaxLines,
      textColor,
      fontSize,
      outlineWidthPx,
      outlineOpacity,
      textBitmapCache,
      emojiCache,
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

// ── Message handler ───────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
  try {
    try {
      const data = e.data as Record<string, unknown>;
      const type = data.type as string;

      switch (type) {
        case 'init': {
          config = data.config as WorkerConfig;
          canvas = data.canvas as OffscreenCanvas;
          ctx = canvas.getContext('2d', { alpha: false });
          if (!ctx) {
            self.postMessage({ type: 'error', error: 'Failed to get 2D context' });
            return;
          }
          emojiCache = new ByteLimitedCache<ImageBitmap>(
            (config.emojiCacheMb ?? 4) * 1_000_000,
            estimateBitmapBytes,
            (b) => b.close()
          );
          authorPhotoCache = new ByteLimitedCache<ImageBitmap>(
            (config.photoCacheMb ?? 4) * 1_000_000,
            estimateBitmapBytes,
            (b) => b.close()
          );
          stickerCache = new ByteLimitedCache<ImageBitmap>(
            (config.stickerCacheMb ?? 4) * 1_000_000,
            estimateBitmapBytes,
            (b) => b.close()
          );
          textBitmapCache = new ByteLimitedCache<OffscreenCanvas>(
            (config.textCacheMb ?? 4) * 1_000_000,
            (canvas) => canvas.width * canvas.height * 4
          );
          recomputeConfigDerived();
          initLanes(data.width as number, data.height as number);
          startRenderLoop();
          self.postMessage({ type: 'ready' });
          break;
        }
        case 'resize':
          initLanes(data.width as number, data.height as number);
          break;
        case 'addMessages': {
          const msgs = data.messages as WorkerMessage[];
          // Handle transferred ImageBitmaps from main thread
          const imageData = data.imageData as
            | Array<{ url: string; bitmap: ImageBitmap; target: string }>
            | undefined;
          if (imageData) {
            for (const item of imageData) {
              const { url, bitmap, target } = item;
              if (!url || !bitmap) continue;
              const cache =
                target === 'author'
                  ? authorPhotoCache
                  : target === 'sticker'
                    ? stickerCache
                    : emojiCache; // 'emoji' or unknown → emojiCache
              cache.set(url, bitmap);
            }
          }
          for (const m of msgs) enqueueMessage(m);
          break;
        }
        case 'updateConfig':
          if (config) {
            Object.assign(config, data.config as Partial<WorkerConfig>);
            recomputeConfigDerived();
            textMeasureCache.clear();
            textBitmapCache.clear();
            emojiCache.clear();
            authorPhotoCache.clear();
            stickerCache.clear();
            superChatGradientCache.clear();
          }
          break;
        case 'setPaused': {
          const shouldPause = data.paused as boolean;
          if (shouldPause && !isPaused) {
            // Pause: record the time
            pauseStartTime = performance.now();
            isPaused = true;
          } else if (!shouldPause && isPaused) {
            // Resume: accumulate paused duration and shift lane timers
            const now = performance.now();
            const pausedMs = Math.max(0, now - pauseStartTime);
            // Accumulate pausedDuration on active messages
            for (const msg of activeMessages) {
              msg.pausedDuration += pausedMs;
            }
            // Shift lane heap timers by paused duration
            shiftLaneTimers(pausedMs);
            isPaused = false;
            pauseStartTime = 0;
            // Restart render loop if stopped
            if (animFrameId === null && !isDestroyed) {
              startRenderLoop();
            }
          } else {
            isPaused = shouldPause;
          }
          break;
        }
        case 'updateTranslation': {
          const msgId = data.id as string;
          const translatedText = data.translatedText as string;
          for (const msg of activeMessages) {
            if (msg.id === msgId) {
              msg.translatedText = translatedText;
              break;
            }
          }
          // Also check pendingQueue in case message hasn't been activated yet
          for (const msg of pendingQueue) {
            if (msg.id === msgId) {
              msg.translatedText = translatedText;
              break;
            }
          }
          break;
        }
        case 'destroy':
          handleDestroy();
          break;
      }
    } catch (err) {
      self.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};

// ── Queue ─────────────────────────────────────────────────────────────────

function enqueueMessage(msg: WorkerMessage): void {
  // O(1) push — sort deferred to drainQueue batch start
  pendingQueue.push(msg);
  pendingQueueSortNeeded = true;
  // Restart the render loop if it was idled.
  if (animFrameId === null && !isDestroyed) {
    startRenderLoop();
  }
}

// ── Lane allocator (simplified 3-phase, adapted from LaneAllocator) ───────

function initLanes(_width: number, height: number): void {
  if (!config || !ctx) return;
  const totalPaddingV = rendererLayout.paddingV * 2;
  // Height estimation from actual font metrics via bounding-box measurement
  const textHeight = measureTextHeight(config.fontSize);
  laneHeight = Math.max(1, textHeight + totalPaddingV + config.laneSpacing);

  const usableHeight = height * (1 - config.safeTop - config.safeBottom);
  numLanes = Math.max(1, Math.floor(usableHeight / laneHeight));

  laneHeap = [];
  laneIndexToHeapIndex.clear();
  speedTierLanes.clear();

  const now = performance.now();
  for (let i = 0; i < numLanes; i++) {
    laneHeap.push([i, now]);
    laneIndexToHeapIndex.set(i, i);
  }
  // Build 4-ary min-heap
  for (let i = Math.floor((laneHeap.length - 2) / 4); i >= 0; i--) {
    siftDown(i);
  }
}

function resetBatch(): void {
  // Prune expired speed-tier entries
  const now = performance.now();
  for (const [k, v] of speedTierLanes) {
    if (v.until <= now) speedTierLanes.delete(k);
  }
}

function findPlacement(
  msgHeight: number,
  speedTier: number
): {
  laneIndex: number;
  waitMs: number;
  laneY: number;
} | null {
  if (laneHeap.length === 0) return null;

  collidedLanes.clear();
  const now = performance.now();
  const slotCount = Math.max(1, Math.ceil(msgHeight / laneHeight));
  const result = allocateSingleLane(now, speedTier, slotCount);
  if (!result) return null;

  const laneY = computeLaneY(
    result.laneIndex,
    canvas?.height ?? 0,
    config?.safeTop ?? 0,
    laneHeight
  );
  return { ...result, laneY };
}

function allocateSingleLane(
  now: number,
  speedTier: number,
  slotCount: number
): { laneIndex: number; waitMs: number } | null {
  if (laneHeap.length === 0) return null;

  const maxWaitMs = (config as WorkerConfig).scrollDurationMaxMs;
  let firstBusy: { laneIndex: number; waitMs: number } | null = null;
  let speedMatched: { laneIndex: number; waitMs: number } | null = null;
  let zeroWaitCandidates: number[] | null = null;

  // Phase 1: zero-wait lanes
  for (let i = 0; i < numLanes - slotCount + 1; i++) {
    // Check tier compatibility for all slots
    let tierOk = true;
    for (let s = 0; s < slotCount; s++) {
      const active = speedTierLanes.get(i + s);
      if (active && active.until > now && !areTiersCompatible(speedTier, active.tier)) {
        tierOk = false;
        break;
      }
    }
    if (!tierOk) continue;

    // Skip lanes already used for another message in this batch (collision feedback)
    if (collidedLanes.has(i)) continue;

    const avail = getSlotAvailableAt(i);
    if (avail === undefined) continue;
    const wait = Math.max(0, Math.ceil(avail - now));
    if (wait > 0) {
      if (!firstBusy) firstBusy = { laneIndex: i, waitMs: wait };
      const active = speedTierLanes.get(i);
      if ((!speedMatched || wait < speedMatched.waitMs) && active && active.tier === speedTier) {
        speedMatched = { laneIndex: i, waitMs: wait };
      }
      continue;
    }

    // Zero-wait lane found — epsilon-greedy
    if (Math.random() < EPSILON) {
      if (!zeroWaitCandidates) {
        zeroWaitCandidates = [];
        for (let j = i + 1; j < numLanes - slotCount + 1; j++) {
          const availJ = getSlotAvailableAt(j);
          if (availJ !== undefined && Math.max(0, Math.ceil(availJ - now)) === 0) {
            let jTierOk = true;
            for (let s = 0; s < slotCount; s++) {
              const activeJ = speedTierLanes.get(j + s);
              if (activeJ && activeJ.until > now && !areTiersCompatible(speedTier, activeJ.tier)) {
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

  // Phase 2: same-tier busy
  if (speedMatched && speedMatched.waitMs <= maxWaitMs) return speedMatched;
  // Phase 3: fastest-free
  if (firstBusy && firstBusy.waitMs <= maxWaitMs) return firstBusy;
  return null;
}

const areTiersCompatible = areSpeedTiersCompatible;

function getSlotAvailableAt(laneIndex: number): number | undefined {
  return heapGetSlotAvailableAt(laneHeap, laneIndexToHeapIndex, laneIndex, numLanes);
}

function commitPlacement(
  laneIndex: number,
  slotCount: number,
  startTime: number,
  durationMs: number,
  speedTier: number,
  msgWidth?: number
): void {
  const occupancyMs = computeOccupancyMs(durationMs, msgWidth);
  const nextAvailable = startTime + occupancyMs;
  const until = startTime + durationMs;

  for (let s = 0; s < slotCount; s++) {
    speedTierLanes.set(laneIndex + s, { tier: speedTier, until });
    updateLane(laneIndex + s, nextAvailable);
    // Mark lanes as occupied for this batch to prevent double-allocation
    collidedLanes.add(laneIndex + s);
  }
}

function computeOccupancyMs(durationMs: number, msgWidthPx?: number): number {
  if (!config) return durationMs;
  const screenWidth = canvas?.width ?? 1920;
  return computeOccupancyMsShared(
    durationMs,
    config.exitPaddingPx,
    config.headwayGapRatio,
    msgWidthPx,
    screenWidth
  );
}

function updateLane(laneIdx: number, availableAt: number): void {
  heapUpdateLane(laneHeap, laneIndexToHeapIndex, laneIdx, availableAt);
}

/**
 * Shift all lane timers forward by `ms` to account for pause duration.
 * Mirrors renderer-canvas.ts LaneAllocator.shiftAll().
 */
function shiftLaneTimers(ms: number): void {
  for (let i = 0; i < laneHeap.length; i++) {
    const entry = laneHeap[i];
    if (entry) entry[1] += ms;
  }
  for (const [key, entry] of speedTierLanes) {
    speedTierLanes.set(key, { tier: entry.tier, until: entry.until + ms });
  }
}

// ── 4-ary min-heap helpers ───────────────────────────────────────────────

const siftDown = (idx: number): void => heapSiftDown(laneHeap, laneIndexToHeapIndex, idx);

// ── Render loop ───────────────────────────────────────────────────────────

let statsFrameCounter = 0;

/** Grace period (ms) before self-idling — matches main thread. */
const IDLE_GRACE_PERIOD_MS = 500;
let idleSince: number | null = null;

function startRenderLoop(): void {
  if (animFrameId !== null) return;

  function frame(_t: number): void {
    if (isDestroyed) return;
    renderFrame();
    // Self-idle with grace period to prevent rAF start/stop thrashing
    // during sparse chat intervals.
    if (activeMessages.length === 0 && pendingQueue.length === 0 && retryQueue.length === 0) {
      const now = performance.now();
      if (idleSince === null) {
        idleSince = now;
      } else if (now - idleSince >= IDLE_GRACE_PERIOD_MS) {
        animFrameId = null;
        idleSince = null;
        return;
      }
      // Continue the loop during the grace period.
    } else {
      idleSince = null; // reset — not idle anymore
    }
    animFrameId = requestAnimationFrame(frame);
  }

  animFrameId = requestAnimationFrame(frame);
}

function renderFrame(): void {
  if (!ctx || !canvas || !config || isPaused) return;
  const cfg = config;

  const now = performance.now();
  const width = canvas.width;
  const height = canvas.height;

  // Apply pending batch state
  resetBatch();

  // Drain queue
  drainQueue(now, width, height);

  // Cleanup expired
  cleanupExpired(now);

  // Clear canvas
  ctx.clearRect(0, 0, width, height);

  if (activeMessages.length === 0) {
    // Stats every ~60 frames
    statsFrameCounter++;
    if (statsFrameCounter >= 60) {
      statsFrameCounter = 0;
      self.postMessage({
        type: 'stats',
        activeMessages: 0,
        drops: totalDrops,
        pendingQueueDepth: pendingQueue.length,
      });
    }
    return;
  }

  // ── Pre-scan: compute positions, opacity, and group into opacity buckets ──
  const mode = config.danmakuMode;
  const isScrolling = mode === 'scroll' || mode === 'reverse';
  const strokeWidth =
    config.outlineWidthPx > 0 && config.outlineOpacity > 0 ? config.outlineWidthPx : 0;

  // Reset pre-allocated buckets for this frame
  for (const bucket of opacityBuckets) bucket.length = 0;

  for (let i = 0; i < activeMessages.length; i++) {
    const msg = activeMessages[i];
    if (!msg) continue;
    const elapsed = now - msg.startTime - msg.pausedDuration;
    if (elapsed < 0) continue;

    const progress = Math.min(1, Math.max(0, elapsed * msg.invDuration));

    // Update position
    if (mode === 'scroll') {
      const dist = msg.startX + msg.width + config.exitPaddingPx;
      msg.x = msg.startX - progress * dist;
    } else if (mode === 'reverse') {
      const dist = width - msg.startX + config.exitPaddingPx;
      msg.x = msg.startX + progress * dist;
    }

    // Compute opacity via shared SSOT (matches renderer-canvas.ts)
    const oc = opacityConfig;
    const opacity = oc
      ? computeMessageOpacity(
          { isBacklog: msg.speedTier === SPEED_TIER.BACKLOG } as ChatMessage,
          elapsed,
          msg.duration,
          isScrolling,
          msg.speedTier,
          oc
        )
      : 0;

    if (opacity <= 0) continue;

    const bucketIndex = Math.round(opacity * (OPACITY_BUCKETS - 1));
    opacityBuckets[bucketIndex]?.push({ msg, elapsed });
  }

  // ── Render pass: one ctx.globalAlpha per opacity bucket ──
  // Iterate ascending (0→20) — low opacity behind, high opacity on top.
  ctx.textBaseline = 'top';
  const getFont = boundGetFont;

  for (let bucketIndex = 0; bucketIndex < OPACITY_BUCKETS; bucketIndex++) {
    const entries = opacityBuckets[bucketIndex];
    if (!entries || entries.length === 0) continue;

    ctx.globalAlpha = bucketIndex / (OPACITY_BUCKETS - 1);

    try {
      for (const { msg, elapsed } of entries) {
        // Per-message color with optional FAR desaturation
        let renderColor = msg.colorOverride || msg.color;
        if (msg.speedTier === SPEED_TIER.FAR && !msg.colorOverride) {
          renderColor = desaturateColor(renderColor, FAR_LAYER_DESATURATION_FACTOR);
          msg.colorOverride = renderColor; // cache for future frames
        }

        const sx = Math.floor(msg.x);
        const sy = Math.floor(msg.y);

        // Dispatch to the appropriate render function based on message kind
        // Config-driven dispatch (worker variant) — takes priority when CardConfigWorker is available
        if (msg.cardConfigWorker) {
          renderPaidCardWorker(
            ctx,
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
            textBitmapCache,
            authorPhotoCache,
            emojiCache,
            getFont,
            superChatGradientCache
          );
        } else {
          // Regular message — handle translation
          const overrideText =
            cfg.translationEnabled && cfg.translationMode === 'replace' && msg.translatedText
              ? msg.translatedText
              : null;

          renderRegularMessage(
            ctx,
            {
              author: msg.author ?? undefined,
              authorPhotoUrl: msg.authorPhotoUrl ?? undefined,
              content: msg.content ?? [],
              text: msg.text,
            } as unknown as RegularMessageLike,
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
            textBitmapCache,
            (url: string) => emojiCache.get(url),
            () => true,
            { get: (url: string) => authorPhotoCache.get(url) },
            () => true,
            getFont,
            measureTextCached,
            overrideText
          );
        }

        // Dual-mode translation: render inside the card with a small gap
        // to visually group the original and translation as one unit.
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
          // Compute vertical positions: translation text near card bottom with small gap
          const translationY = sy + msg.height - translationFontSize - TRANSLATION_GAP_PX;
          ctx.save();
          try {
            ctx.globalAlpha = (bucketIndex / (OPACITY_BUCKETS - 1)) * TRANSLATION_OPACITY_SCALE;
            // Translation text (normal weight for subtle distinction)
            const translationFont = `${translationFontSize}px ${cfg.fontFamily}`;
            renderSegment(
              ctx,
              msg.translatedText,
              sx,
              Math.floor(translationY),
              translationColor,
              translationFontSize,
              strokeWidth,
              cfg.outlineOpacity,
              textBitmapCache,
              (_fs: number) => translationFont
            );
          } finally {
            ctx.restore();
          }
        }
      }
    } finally {
      ctx.globalAlpha = 1;
    }
  }

  statsFrameCounter++;
  if (statsFrameCounter >= 60) {
    statsFrameCounter = 0;
    self.postMessage({
      type: 'stats',
      activeMessages: activeMessages.length,
      drops: totalDrops,
      pendingQueueDepth: pendingQueue.length,
    });
  }
}

// ── Queue drain ───────────────────────────────────────────────────────────

function drainQueue(now: number, width: number, height: number): void {
  if (!config) return;

  // Lazy sort: O(n log n) once per batch instead of O(n) per enqueue
  if (pendingQueueSortNeeded && pendingQueue.length > 0) {
    pendingQueue.sort((a, b) => b.priority - a.priority);
    pendingQueueSortNeeded = false;
  }

  let skipped = 0;
  let batchIndex = 0;

  // Anti-block gate: when lane utilization is critically high (≥95%),
  // probabilistically pause new placements. High-priority messages (≥80)
  // bypass the gate so paid interactions are never blocked.
  const laneUtilization = laneHeap.length / Math.max(1, numLanes);
  const isAntiBlock = laneUtilization >= 1 - ANTI_BLOCK_FREE_RATIO;

  while (
    pendingQueueOffset < pendingQueue.length &&
    activeMessages.length < config.maxConcurrentMessages &&
    skipped <= DRAIN_MAX_SKIP
  ) {
    const entry = pendingQueue[pendingQueueOffset++];
    if (!entry) continue;

    // Anti-block: probabilistically skip low-priority messages when lanes are saturated
    if (isAntiBlock && entry.priority < ANTI_BLOCK_PRIORITY_THRESHOLD) {
      const acceptProb = (1 - laneUtilization) / ANTI_BLOCK_FREE_RATIO;
      if (Math.random() >= acceptProb) {
        skipped++;
        continue;
      }
    }

    // Compute speed tier matching activateMessage for correct lane allocation
    let speedTier: number;
    if (entry.isBacklog) {
      speedTier = SPEED_TIER.BACKLOG;
    } else if (!config.depthLayersEnabled) {
      speedTier = SPEED_TIER.MID;
    } else if (config.danmakuMode !== 'scroll' && config.danmakuMode !== 'reverse') {
      speedTier = SPEED_TIER.MID;
    } else if (entry.kind === 'superchat' || entry.kind === 'membership') {
      speedTier = SPEED_TIER.NEAR;
    } else {
      const hash = hashForTier(entry.id);
      speedTier = hash < TIER_NEAR_THRESHOLD ? SPEED_TIER.NEAR : SPEED_TIER.FAR;
    }

    const placement = findPlacement(entry.height, speedTier);

    if (!placement) {
      skipped++;
      totalDrops++;
      retryQueue.push(entry);
      continue;
    }

    activateMessage(entry, now, placement, batchIndex, width, height);
    skipped = 0;
    batchIndex++;
  }

  // Compact consumed entries to prevent unbounded memory growth
  if (pendingQueueOffset > 64) {
    pendingQueue.splice(0, pendingQueueOffset);
    pendingQueueOffset = 0;
  }

  // Merge retries
  if (retryQueue.length > 0) {
    // Bulk push + single sort (O(n log n)) instead of per-message splice insert (O(n²))
    pendingQueue.push(...retryQueue);
    pendingQueue.sort((a, b) => b.priority - a.priority);
    retryQueue.length = 0;
  }
}

function activateMessage(
  msg: WorkerMessage,
  now: number,
  placement: { laneIndex: number; waitMs: number; laneY: number },
  batchIndex: number,
  screenWidth: number,
  _screenHeight: number
): void {
  if (!config) return;

  const mode = config.danmakuMode;
  const isScrolling = mode === 'scroll' || mode === 'reverse';

  // ── Speed tier (hash-based FAR/MID/NEAR/BACKLOG, matching main thread) ──
  let speedTier: number;
  if (msg.isBacklog) {
    speedTier = SPEED_TIER.BACKLOG;
  } else if (!config.depthLayersEnabled) {
    speedTier = SPEED_TIER.MID;
  } else if (!isScrolling) {
    speedTier = SPEED_TIER.MID;
  } else if (msg.kind === 'superchat' || msg.kind === 'membership') {
    speedTier = SPEED_TIER.NEAR;
  } else {
    const hash = hashForTier(msg.id);
    speedTier = hash < TIER_NEAR_THRESHOLD ? SPEED_TIER.NEAR : SPEED_TIER.FAR;
  }

  // ── Speed calculation (per-tier + burst boost) ──
  let speed = config.speedPxPerSec;
  if (msg.burstSpeedMultiplier && msg.burstSpeedMultiplier > 1) {
    speed *= msg.burstSpeedMultiplier;
  }
  switch (speedTier) {
    case SPEED_TIER.FAR:
      speed = Math.max(30, speed * config.depthFarSpeedMul);
      break;
    case SPEED_TIER.NEAR:
      speed *= config.depthNearSpeedMul;
      break;
    case SPEED_TIER.BACKLOG:
      speed *= config.backlogSpeedMultiplier;
      break;
    // MID: no multiplier
  }

  // ── Adaptive stagger: reduce delay when pending queue is deep (matches renderer-canvas.ts) ──
  const pendingCount = pendingQueue.length;
  let effectiveMaxStagger = config.staggerMaxDelayMs;
  if (pendingCount > 50) {
    effectiveMaxStagger = 0;
  } else if (pendingCount > 30) {
    effectiveMaxStagger = Math.floor(config.staggerMaxDelayMs / 2);
  }

  // ── Exponential stagger delay (matching main thread) ──
  let staggerDelay = 0;
  if (batchIndex > 0 && isScrolling) {
    const staggeredIdx = Math.min(batchIndex, STAGGER_BATCH_MAX);
    staggerDelay = Math.round(
      Math.min(effectiveMaxStagger, staggeredIdx * -STAGGER_EXP_SCALE * Math.log(1 - Math.random()))
    );
  }

  // ── Horizontal stagger ──
  const horizontalStagger =
    isScrolling && batchIndex > 0
      ? Math.min(HORIZONTAL_STAGGER_MAX, batchIndex * HORIZONTAL_STAGGER_PER_STEP)
      : 0;

  let startX: number;
  if (mode === 'scroll') startX = screenWidth + horizontalStagger;
  else if (mode === 'reverse') startX = -(msg.width + horizontalStagger);
  else startX = (screenWidth - msg.width) / 2;

  // ── Duration (with computeScrollDuration matching design-tokens) ──
  let duration: number;
  if (isScrolling) {
    const totalDistance =
      mode === 'scroll'
        ? startX + msg.width + config.exitPaddingPx
        : screenWidth - startX + config.exitPaddingPx;
    duration =
      speed > 0
        ? computeScrollDuration(
            totalDistance,
            speed,
            config.scrollDurationMinMs,
            config.scrollDurationMaxMs,
            config.exitPaddingPx
          )
        : config.scrollDurationMinMs;
  } else {
    duration = config.topBottomDurationMs;
  }

  // Moderator and owner messages stay on screen longer.
  if (msg.authorType === 'moderator' || msg.authorType === 'owner') {
    duration *= config.modOwnerDurationMultiplier;
  }

  const slotCount = Math.max(1, Math.ceil(msg.height / laneHeight));
  const laneY = placement.laneY;

  // ── Per-author color ──
  const authorColor =
    (msg.authorType && config.authorColors[msg.authorType]) || config.color || DEFAULT_TEXT_COLOR;

  const am: ActiveMessage = {
    id: msg.id,
    x: startX,
    y: laneY,
    startX,
    width: msg.width,
    height: msg.height,
    activationTime: now,
    startTime: now + staggerDelay,
    duration,
    invDuration: duration > 0 ? 1 / duration : 0,
    pausedDuration: 0,
    laneIndex: placement.laneIndex,
    laneSlotCount: slotCount,
    speedTier,
    text: msg.text,
    color: authorColor,
    ...(msg.authorType !== undefined ? { authorType: msg.authorType } : {}),
    ...(msg.kind !== undefined ? { kind: msg.kind } : {}),
    ...(msg.translatedText !== undefined ? { translatedText: msg.translatedText } : {}),
    // Rich rendering fields
    ...(msg.content !== undefined ? { content: msg.content } : {}),
    ...(msg.author !== undefined ? { author: msg.author } : {}),
    ...(msg.authorPhotoUrl !== undefined ? { authorPhotoUrl: msg.authorPhotoUrl } : {}),
    ...(msg.superChatAmount !== undefined ? { superChatAmount: msg.superChatAmount } : {}),
    ...(msg.superChatStickerUrl !== undefined
      ? { superChatStickerUrl: msg.superChatStickerUrl }
      : {}),
    ...(msg.membershipHeader !== undefined ? { membershipHeader: msg.membershipHeader } : {}),
    ...(msg.cardConfigWorker !== undefined ? { cardConfigWorker: msg.cardConfigWorker } : {}),
  };

  commitPlacement(
    placement.laneIndex,
    slotCount,
    now + staggerDelay,
    duration,
    speedTier,
    msg.width
  );
  activeMessages.push(am);

  // Prefetch images for this message — route to appropriate byte-limited cache
  if (msg.content) {
    const emojiUrls: string[] = [];
    for (const seg of msg.content) {
      if (seg.type === 'emoji' && seg.emojiUrl) emojiUrls.push(seg.emojiUrl);
    }
    if (emojiUrls.length > 0) void prefetchImages(emojiUrls, emojiCache);
  }
  if (msg.authorPhotoUrl) void prefetchImages([msg.authorPhotoUrl], authorPhotoCache);
  if (msg.superChatStickerUrl) void prefetchImages([msg.superChatStickerUrl], stickerCache);
}

// ── Cleanup ───────────────────────────────────────────────────────────────

function cleanupExpired(now: number): void {
  let writeIdx = 0;
  for (let i = 0; i < activeMessages.length; i++) {
    const m = activeMessages[i];
    if (!m) continue;
    if (now - m.startTime - m.pausedDuration >= m.duration) continue;
    activeMessages[writeIdx++] = m;
  }
  activeMessages.length = writeIdx;
}

function handleDestroy(): void {
  isDestroyed = true;
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  ctx = null;
  canvas = null;
  activeMessages.length = 0;
  pendingQueue.length = 0;
  pendingQueueOffset = 0;
  textBitmapCache.clear();
  emojiCache.clear();
  authorPhotoCache.clear();
  stickerCache.clear();
  superChatGradientCache.clear();
}

// Signal ready
