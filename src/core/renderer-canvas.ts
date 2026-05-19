/**
 * RendererCanvas — Canvas 2D-based renderer.
 *
 * Uses requestAnimationFrame instead of CSS @keyframes animations.
 * Each frame computes positions with Math.floor() to snap to integer pixel
 * coordinates, eliminating the sub-pixel text jitter inherent in CSS
 * transform interpolation.
 *
 * Extends RendererBase for shared state machine, rate limiting, burst
 * detection, and lane allocation.
 *
 * Fixes from audit:
 * - BUG-1: updateSettings now propagates _options to super
 * - BUG-4: reverse travel distance uses consistent exitPadding
 * - BUG-5/6: image caches only store loaded images, errors don't cache
 */

import type { ChatMessage, ContentSegment, OverlayDimensions, OverlaySettings } from '@app-types';
import {
  computeDliosDuration,
  computeOutlineColor,
  computeSuperChatOpacities,
  colors as designColors,
  rendererLayout,
  resolveSuperChatRgb,
} from '@core/design-tokens';
import { createLogger } from '@core/logging';
import type { Overlay } from '@core/overlay';
import { RendererBase, type RendererUpdateOptions } from '@core/renderer-base';
import { estimateMessageDimensions as sharedEstimateDimensions } from '@core/renderer-shared';
import { getFontString } from '@core/text-measure';

const log = createLogger('RendererCanvas');

// ── Types ──────────────────────────────────────────────────────────────────

interface CanvasMessage {
  message: ChatMessage;
  startTime: number;
  duration: number;
  width: number;
  height: number;
  startX: number;
  x: number;
  y: number;
  pausedDuration: number;
  laneIndex: number;
  /** Time stagger delay (ms) applied to this message's start. */
  staggerDelay: number;
}

// ── Renderer ─────────────────────────────────────────────────────────────────

export class CanvasRenderer extends RendererBase {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private animFrameId: number | null = null;
  private overlayDimensionsUnsubscribe: (() => void) | null = null;

  private readonly activeMessages: CanvasMessage[] = [];
  private readonly pendingQueue: ChatMessage[] = [];

  /** Emoji image cache: url → HTMLImageElement (bounded LRU, max 200 entries) */
  private readonly emojiCache = new Map<string, HTMLImageElement>();
  private readonly emojiFetching = new Set<string>();
  private readonly authorPhotoCache = new Map<string, HTMLImageElement>();
  private readonly stickerCache = new Map<string, HTMLImageElement>();

  /** Text measurement caches (cleared on settings/font change) */
  private readonly textWidthCache = new Map<string, number>();

  /**
   * Text bitmap cache: pre-rendered text with outline as offscreen canvas.
   * Key = `${font}|${text}|${color}|${strokeWidth}|${strokeColor}`.
   * On cache hit, drawImage() replaces fillText()+strokeText() in the hot path.
   */
  private readonly textBitmapCache = new Map<string, HTMLCanvasElement>();
  private static readonly TEXT_BITMAP_MAX = 200;

  private static readonly FADE_DURATION_MS = 500;

  constructor(overlay: Overlay, settings: OverlaySettings) {
    super(overlay, settings);

    const container = overlay.getContainer();
    const canvas = document.createElement('canvas');
    canvas.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none';
    if (container) container.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    const dims = overlay.getDimensions();
    this.applyDevicePixelRatio(dims);

    this.overlayDimensionsUnsubscribe = overlay.onDimensionsChanged((d) => {
      if (d && this.canvas) {
        this.applyDevicePixelRatio(d);
        this.laneAllocator.reset(d);
      }
    });

    this.startRenderLoop();
    log.info('RendererCanvas created');
  }

  get laneCount(): number {
    return this.laneAllocator.getLaneCount();
  }

  protected getQueueLength(): number {
    return this.pendingQueue.length;
  }

  // ── Message ingress ──────────────────────────────────────────────────

  addMessage(message: ChatMessage): void {
    if (!this.isMessageAllowed(message)) return;

    const priority = CanvasRenderer.getMessagePriority(message);
    this.prefetchImages(message);

    if (this.pendingQueue.length >= rendererLayout.queueMaxSize) {
      const last = this.pendingQueue[this.pendingQueue.length - 1];
      if (last && priority <= CanvasRenderer.getMessagePriority(last)) {
        this.observability.onMessageDropped('queue_overflow');
        return;
      }
      this.pendingQueue.pop();
      this.observability.onMessageDropped('queue_overflow');
    }

    const insertIndex = this.findQueueInsertIndex(priority);
    if (insertIndex === this.pendingQueue.length) {
      this.pendingQueue.push(message);
    } else {
      this.pendingQueue.splice(insertIndex, 0, message);
    }

    if (this.activeMessages.length < this.settings.maxConcurrentMessages) {
      this.updateBacklogPause();
      const next = this.pendingQueue.shift();
      if (next) this.enqueueMessage(next, performance.now());
    }
  }

  /** Binary search for insertion point in the priority-sorted pending queue. */
  private findQueueInsertIndex(priority: number): number {
    const queue = this.pendingQueue;
    let lo = 0;
    let hi = queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midMsg = queue[mid];
      if (midMsg && CanvasRenderer.getMessagePriority(midMsg) >= priority) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  trimBackgroundQueue(): void {
    if (this.pendingQueue.length <= rendererLayout.backgroundQueueMax) return;
    this.pendingQueue.sort((a, b) => {
      const prioA = CanvasRenderer.getMessagePriority(a);
      const prioB = CanvasRenderer.getMessagePriority(b);
      return prioB - prioA || a.timestamp - b.timestamp;
    });
    this.pendingQueue.length = rendererLayout.backgroundQueueMax;
  }

  /** BUG-1 fix: propagate _options to super */
  updateSettings(settings: OverlaySettings, options?: RendererUpdateOptions): void {
    super.updateSettings(settings, options);
  }

  // ── Lane partition control ──────────────────────────────────────────

  /**
   * Enable lane partitioning: backlog messages use lanes [0, partitionEnd),
   * real-time messages use [partitionEnd, laneCount).
   */
  setBacklogPartition(partitionEnd: number): void {
    this.laneAllocator.setBacklogPartition(true, partitionEnd);
  }

  /** Disable lane partitioning: all lanes are shared. */
  clearBacklogPartition(): void {
    this.laneAllocator.setBacklogPartition(false, 0);
  }

  // ── Image pre-fetching (BUG-5/6 fix) ─────────────────────────────────

  private prefetchImages(message: ChatMessage): void {
    for (const seg of message.content) {
      if (seg.type !== 'emoji') continue;
      if (this.emojiCache.has(seg.emoji.url)) continue;
      if (this.emojiFetching.has(seg.emoji.url)) continue;
      if (this.emojiFetching.size >= 6) continue;

      this.emojiFetching.add(seg.emoji.url);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = seg.emoji.url;
      img.onload = () => {
        this.emojiFetching.delete(seg.emoji.url);
        if (this.emojiCache.size >= 200) {
          const oldestKey = this.emojiCache.keys().next().value;
          if (oldestKey !== undefined) this.emojiCache.delete(oldestKey);
        }
        this.emojiCache.set(seg.emoji.url, img);
      };
      img.onerror = () => {
        this.emojiFetching.delete(seg.emoji.url);
      };
    }

    const photoUrl = message.authorPhotoUrl;
    if (photoUrl && !this.authorPhotoCache.has(photoUrl)) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = photoUrl;
      img.onload = () => this.authorPhotoCache.set(photoUrl, img);
      // BUG-6 fix: do NOT cache on error
      img.onerror = () => {};
    }

    const sticker = message.superChat?.sticker;
    const stickerUrl = sticker?.url;
    if (stickerUrl && !this.stickerCache.has(stickerUrl)) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = stickerUrl;
      img.onload = () => this.stickerCache.set(stickerUrl, img);
      // BUG-5 fix: do NOT set cache before onload
      img.onerror = () => {};
    }
  }

  // ── Render loop ──────────────────────────────────────────────────────

  private applyDevicePixelRatio(dims?: OverlayDimensions | null): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx || !dims) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = dims.width * dpr;
    canvas.height = dims.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private startRenderLoop(): void {
    if (this.animFrameId !== null) return;
    const loop = (): void => {
      if (!this.canvas?.isConnected) {
        this.animFrameId = null;
        return;
      }
      this.renderFrame();
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  private stopRenderLoop(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  private lastDpr = 0;

  private renderFrame(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    if (this.isPaused) return;
    if (this.isVideoPaused) return;

    const now = performance.now();
    const dims = this.overlay.getDimensions();
    if (!dims) return;

    // Reset device pixel ratio transform (canvas.width set may have reset it)
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this.lastDpr) {
      this.lastDpr = dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ctx.clearRect(0, 0, dims.width, dims.height);

    const mode = this.settings.danmakuMode;
    const isScrolling = mode === 'scroll' || mode === 'reverse';

    this.drainQueue(now);

    const toRemove: number[] = [];

    for (let i = 0; i < this.activeMessages.length; i++) {
      const msg = this.activeMessages[i];
      if (!msg) continue;
      const elapsed = now - msg.startTime - msg.pausedDuration;

      if (elapsed >= msg.duration) {
        toRemove.push(i);
        continue;
      }

      const progress = Math.min(1, Math.max(0, elapsed / msg.duration));

      if (mode === 'scroll') {
        const travelDistance = canvas.width + msg.width + rendererLayout.exitPaddingMin;
        msg.x = msg.startX - progress * travelDistance;
      } else if (mode === 'reverse') {
        // BUG-4 fix: consistent exitPadding usage
        const travelDistance = canvas.width * 2 + rendererLayout.exitPaddingMin;
        msg.x = -msg.width + progress * travelDistance;
      }

      let opacity = this.settings.opacity;

      // Fade-in for the first moment a message appears on screen.
      // In scroll/reverse modes this applies only to backlog messages to
      // soften the initial visual burst. In top/bottom modes it applies
      // to all messages.
      const shouldFadeIn = !isScrolling || (msg.message.isBacklog ?? false);
      if (shouldFadeIn && elapsed < CanvasRenderer.FADE_DURATION_MS) {
        opacity *= elapsed / CanvasRenderer.FADE_DURATION_MS;
      }
      if (!isScrolling && elapsed > msg.duration - CanvasRenderer.FADE_DURATION_MS) {
        opacity *= Math.max(0, (msg.duration - elapsed) / CanvasRenderer.FADE_DURATION_MS);
      }

      if (msg.message.isBacklog) opacity *= 0.5;

      const ageRatio = Math.min(1, elapsed / rendererLayout.maxMessageAgeMs);
      opacity *= Math.max(0, 1 - ageRatio);

      const snappedX = Math.floor(msg.x);
      const snappedY = Math.floor(msg.y);

      if (msg.message.kind === 'superchat') {
        this.renderSuperChat(ctx, msg, snappedX, snappedY, opacity);
      } else if (msg.message.kind === 'membership') {
        this.renderMembership(ctx, msg, snappedX, snappedY, opacity);
      } else {
        this.renderRegular(ctx, msg, snappedX, snappedY, opacity);
      }
    }

    if (toRemove.length === 0) return;

    // Filter out expired messages (swap-pop pattern avoided for clarity)
    const surviving = this.activeMessages.filter((_, i) => !toRemove.includes(i));
    this.activeMessages.length = 0;
    this.activeMessages.push(...surviving);

    this.observability.updateActiveMessages(this.activeMessages.length);
    this.observability.updateQueueDepth(this.pendingQueue.length);
  }

  // ── Queue drain ──────────────────────────────────────────────────────

  private drainQueue(now: number): void {
    if (this.isAntiBlockActive()) return;
    while (
      this.pendingQueue.length > 0 &&
      this.activeMessages.length < this.settings.maxConcurrentMessages
    ) {
      const msg = this.pendingQueue.shift();
      if (msg) this.enqueueMessage(msg, now);
    }
  }

  // ── Message enqueue ──────────────────────────────────────────────────

  /**
   * Minimum interval between messages in top/bottom fixed modes (ms).
   * Prevents message flooding when lane allocation is bypassed.
   */
  private static readonly FIXED_MODE_MIN_INTERVAL_MS = 100;
  private lastFixedModeEnqueueTime = 0;

  /**
   * Per-lane stagger interval (ms) for scroll/reverse modes.
   * Higher lanes start slightly later, spreading messages evenly
   * across time without causing diagonal entry patterns.
   * 5ms × 20 lanes = 100ms total spread.
   */
  private static readonly LANE_STAGGER_MS = 5;

  private enqueueMessage(message: ChatMessage, now: number): void {
    const dims = this.overlay.getDimensions();
    if (!dims) return;

    const mode = this.settings.danmakuMode;
    const { width: msgWidth, height: msgHeight } = this.estimateDimensions(message);

    // ── Top/Bottom fixed modes: bypass LaneAllocator ──────────────────
    if (mode === 'top' || mode === 'bottom') {
      this.enqueueFixedMode(message, now, dims, msgWidth, msgHeight, mode);
      return;
    }

    // ── Scroll/Reverse modes: use DLIOS lane allocator ────────────────
    const placement = this.laneAllocator.findPlacement(msgHeight, dims, message.isBacklog ?? false);
    if (!placement) {
      this.observability.onMessageDropped('no_lane_available');
      return;
    }

    const speed = message.isBacklog
      ? this.getEffectiveBacklogSpeed()
      : this.getEffectiveSpeedPxPerSec();

    // Time stagger: higher lanes start slightly later so messages don't
    // all launch simultaneously. The delay is proportional to lane index
    // and kept small (max ~100ms spread) to avoid visible diagonal patterns.
    const staggerDelay = placement.lane.index * CanvasRenderer.LANE_STAGGER_MS;

    let effectiveDuration: number;
    if (mode === 'scroll' || mode === 'reverse') {
      const exitPadding = Math.max(
        this.settings.fontSize * rendererLayout.exitPaddingScale,
        rendererLayout.exitPaddingMin
      );
      // All lanes use the same total distance → uniform scroll speed.
      // The old per-lane entryOffset was removed because it caused different
      // lanes to move at different speeds, producing diagonal entry patterns.
      const totalDistance =
        mode === 'reverse' ? dims.width * 2 + exitPadding : dims.width + msgWidth + exitPadding;
      effectiveDuration =
        speed > 0 ? computeDliosDuration(totalDistance, speed) : rendererLayout.durationMin;
    } else {
      effectiveDuration = rendererLayout.topBottomDurationMs;
    }

    const laneY = placement.laneY;

    // For backlog messages, pass the speed multiplier so the lane allocator
    // can account for the faster scroll speed when computing lane occupancy.
    const backlogSpeed = message.isBacklog ? this.settings.backlogSpeedMultiplier : 1;
    this.laneAllocator.commitPlacement(placement, msgWidth, now + staggerDelay, backlogSpeed);

    // All messages in scroll mode start from the same vertical line.
    const startX = mode === 'scroll' ? dims.width : -(msgWidth + rendererLayout.exitPaddingMin);

    this.activateMessage(
      message,
      now + staggerDelay,
      msgWidth,
      msgHeight,
      laneY,
      effectiveDuration,
      startX,
      placement.lane.index,
      staggerDelay
    );
  }

  /** Enqueue a message in top/bottom fixed mode — no lane allocation needed. */
  private enqueueFixedMode(
    message: ChatMessage,
    now: number,
    dims: { width: number; height: number },
    msgWidth: number,
    msgHeight: number,
    mode: 'top' | 'bottom'
  ): void {
    // Simple time-based gate to prevent flooding
    if (now - this.lastFixedModeEnqueueTime < CanvasRenderer.FIXED_MODE_MIN_INTERVAL_MS) {
      this.observability.onMessageDropped('no_lane_available');
      return;
    }
    this.lastFixedModeEnqueueTime = now;

    const laneY =
      mode === 'bottom'
        ? dims.height * (1 - this.settings.safeBottom) - msgHeight
        : dims.height * this.settings.safeTop;

    this.activateMessage(message, now, msgWidth, msgHeight, laneY);
  }

  /** Finalize and activate a message (shared by scroll/reverse and fixed modes). */
  private activateMessage(
    message: ChatMessage,
    now: number,
    msgWidth: number,
    msgHeight: number,
    laneY: number,
    duration?: number,
    startX?: number,
    laneIndex?: number,
    staggerDelay = 0
  ): void {
    const cm: CanvasMessage = {
      message,
      startTime: now,
      duration: duration ?? rendererLayout.topBottomDurationMs,
      width: msgWidth,
      height: msgHeight,
      startX: startX ?? 0,
      x: startX ?? 0,
      y: laneY,
      pausedDuration: 0,
      laneIndex: laneIndex ?? 0,
      staggerDelay,
    };

    this.activeMessages.push(cm);
    this.observability.onMessageRendered();
  }

  // ── Dimension estimation (delegates to shared functions) ──────────────

  private estimateDimensions(message: ChatMessage): { width: number; height: number } {
    return sharedEstimateDimensions(
      message,
      this.settings.fontSize,
      this.settings.showAuthor[message.authorType],
      this.settings.fontWeight,
      this.settings.fontFamily
    );
  }

  private measureTextWidthCached(text: string, font: string): number {
    const key = `${font}|${text}`;
    const cached = this.textWidthCache.get(key);
    if (cached !== undefined) return cached;
    const ctx = this.ctx;
    if (!ctx) return text.length * 8;
    ctx.font = font;
    const m = ctx.measureText(text);
    const bbWidth = Math.abs(m.actualBoundingBoxLeft) + Math.abs(m.actualBoundingBoxRight);
    const width = bbWidth > 0 ? Math.ceil(bbWidth) : Math.ceil(m.width);
    if (this.textWidthCache.size >= 500) {
      const firstKey = this.textWidthCache.keys().next().value;
      if (firstKey) this.textWidthCache.delete(firstKey);
    }
    this.textWidthCache.set(key, width);
    return width;
  }

  private getFont(fontSize: number): string {
    return getFontString(fontSize, this.settings.fontWeight, this.settings.fontFamily);
  }

  // ── Backlog pause ────────────────────────────────────────────────────

  private getEffectiveBacklogSpeed(): number {
    const speed =
      this.settings.speedPxPerSec * this.playbackRate * Math.max(1, this.backlogSpeedMultiplier);
    return Math.max(1, speed);
  }

  // ── Text rendering ───────────────────────────────────────────────────

  private renderSegment(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    color: string,
    alpha: number,
    fontSize: number
  ): void {
    const outline = this.settings.outline;
    const font = this.getFont(fontSize);

    // Try bitmap cache first (includes outline rendering)
    if (outline.enabled && outline.widthPx > 0 && outline.opacity > 0) {
      const strokeWidth = Math.max(0.5, outline.widthPx * 0.85);
      const strokeColor = computeOutlineColor(color, Math.min(1, outline.opacity));
      const key = `${font}|${text}|${color}|${strokeWidth.toFixed(1)}|${strokeColor}`;
      const bitmap = this.textBitmapCache.get(key);
      if (bitmap) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.drawImage(bitmap, x, y);
        ctx.restore();
        return;
      }

      // Cache miss — render to offscreen canvas and cache
      this.cacheTextBitmap(key, text, font, color, strokeWidth, strokeColor);
    }

    // Fallback: direct fillText + strokeText
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = font;
    ctx.textBaseline = 'top';
    this.strokeTextOutline(ctx, text, x, y, color);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  /** Render text with outline to an offscreen canvas and store in bitmap cache. */
  private cacheTextBitmap(
    key: string,
    text: string,
    font: string,
    fillColor: string,
    strokeWidth: number,
    strokeColor: string
  ): void {
    if (this.textBitmapCache.size >= CanvasRenderer.TEXT_BITMAP_MAX) {
      const oldestKey = this.textBitmapCache.keys().next().value;
      if (oldestKey) this.textBitmapCache.delete(oldestKey);
    }

    const ctx = this.ctx;
    if (!ctx) return;

    ctx.save();
    ctx.font = font;
    const metrics = ctx.measureText(text);
    const bbWidth =
      Math.abs(metrics.actualBoundingBoxLeft) + Math.abs(metrics.actualBoundingBoxRight);
    const textWidth = bbWidth > 0 ? Math.ceil(bbWidth) : Math.ceil(metrics.width);
    const width = textWidth + Math.ceil(strokeWidth) + 2;
    const mgMetrics = ctx.measureText('Mg');
    const ascent = mgMetrics.actualBoundingBoxAscent ?? mgMetrics.fontBoundingBoxAscent ?? 0;
    const descent = mgMetrics.actualBoundingBoxDescent ?? mgMetrics.fontBoundingBoxDescent ?? 0;
    const height = Math.ceil(ascent) + Math.ceil(descent) + Math.ceil(strokeWidth) + 2;
    ctx.restore();

    const offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;
    const offCtx = offscreen.getContext('2d');
    if (!offCtx) return;

    offCtx.font = font;
    offCtx.textBaseline = 'top';
    offCtx.strokeStyle = strokeColor;
    offCtx.lineWidth = strokeWidth;
    offCtx.lineJoin = 'round';
    offCtx.lineCap = 'round';
    offCtx.strokeText(text, strokeWidth / 2 + 1, strokeWidth / 2 + 1);
    offCtx.fillStyle = fillColor;
    offCtx.fillText(text, strokeWidth / 2 + 1, strokeWidth / 2 + 1);

    this.textBitmapCache.set(key, offscreen);
  }

  /** Draw crisp auto-contrast outline on text using current font and textBaseline. */
  private strokeTextOutline(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    textColor: string
  ): void {
    const outline = this.settings.outline;
    if (!outline.enabled || outline.widthPx <= 0 || outline.opacity <= 0) return;
    const strokeWidth = Math.max(0.5, outline.widthPx * 0.85);
    ctx.save();
    ctx.strokeStyle = computeOutlineColor(textColor, Math.min(1, outline.opacity));
    ctx.lineWidth = strokeWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeText(text, x, y);
    ctx.restore();
  }

  private renderContentSegments(
    ctx: CanvasRenderingContext2D,
    segments: readonly ContentSegment[],
    startX: number,
    y: number,
    color: string,
    alpha: number,
    fontSize: number
  ): void {
    let cursorX = startX;
    const emojiSize = Math.round(fontSize * rendererLayout.emojiSize);

    for (const seg of segments) {
      if (seg.type === 'text') {
        this.renderSegment(ctx, seg.content, cursorX, y, color, alpha, fontSize);
        cursorX += Math.ceil(this.measureTextWidthCached(seg.content, this.getFont(fontSize)));
      } else {
        const cached = this.emojiCache.get(seg.emoji.url);
        const img = cached?.complete && cached.naturalWidth > 0 ? cached : null;
        if (img) {
          ctx.globalAlpha = alpha;
          ctx.drawImage(img, cursorX, y, emojiSize, emojiSize);
        } else if (seg.emoji.alt) {
          this.renderSegment(ctx, seg.emoji.alt, cursorX, y, color, alpha, fontSize);
        }
        cursorX += emojiSize + 4;
      }
    }
  }

  // ── Regular message ──────────────────────────────────────────────────

  private renderRegular(
    ctx: CanvasRenderingContext2D,
    msg: CanvasMessage,
    x: number,
    y: number,
    alpha: number
  ): void {
    const message = msg.message;
    const fontSize = this.settings.fontSize;
    const color =
      this.settings.preserveUserColor && message.userColor
        ? message.userColor
        : this.settings.colors[message.authorType];

    ctx.globalAlpha = alpha;

    const showAuthor = this.settings.showAuthor[message.authorType];
    const textX = x + rendererLayout.paddingH;
    let textY = y + rendererLayout.paddingV;
    if (showAuthor && message.author) {
      const photo = message.authorPhotoUrl
        ? this.authorPhotoCache.get(message.authorPhotoUrl)
        : undefined;
      if (photo?.complete && photo.naturalWidth > 0) {
        this.drawAuthorPhoto(ctx, photo, textX, textY);
      }
      const nameFont = getFontString(
        Math.round(fontSize * rendererLayout.authorFontScale),
        this.settings.fontWeight,
        this.settings.fontFamily
      );
      ctx.font = nameFont;
      ctx.textBaseline = 'top';
      this.strokeTextOutline(
        ctx,
        message.author,
        textX + (photo ? rendererLayout.authorPhotoSize + 4 : 0),
        textY + 6,
        color
      );
      ctx.fillStyle = color;
      ctx.fillText(
        message.author,
        textX + (photo ? rendererLayout.authorPhotoSize + 4 : 0),
        textY + 6
      );
      textY += rendererLayout.authorSectionHeightPx;
    }

    if (message.content.length > 0) {
      this.renderContentSegments(ctx, message.content, textX, textY, color, alpha, fontSize);
    } else if (message.text.length > 0) {
      this.renderSegment(ctx, message.text, textX, textY, color, alpha, fontSize);
    }
  }

  // ── Super chat ───────────────────────────────────────────────────────

  private renderSuperChat(
    ctx: CanvasRenderingContext2D,
    msg: CanvasMessage,
    x: number,
    y: number,
    alpha: number
  ): void {
    const message = msg.message;
    const superChat = message.superChat;
    if (!superChat) return;

    const fontSize = this.settings.fontSize;
    const w = msg.width;
    const h = msg.height;

    ctx.globalAlpha = alpha;

    const {
      base: superChatAlpha,
      top: topAlpha,
      bottom: bottomAlpha,
    } = computeSuperChatOpacities(this.settings.superChatOpacity);

    const rgb = resolveSuperChatRgb(superChat, designColors.superChat);
    const baseColor = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;

    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, CanvasRenderer.rgbaHex(baseColor, topAlpha));
    grad.addColorStop(0.48, CanvasRenderer.rgbaHex(baseColor, superChatAlpha));
    grad.addColorStop(1, CanvasRenderer.rgbaHex(baseColor, bottomAlpha));
    ctx.fillStyle = grad;
    this.roundRect(ctx, x, y, w, h, 6);
    ctx.fill();

    ctx.fillStyle = baseColor;
    ctx.fillRect(x, y, 4, h);

    const textX = x + rendererLayout.paddingH;
    let contentY = y + rendererLayout.paddingV;

    const showAuthor = this.settings.showAuthor.superChat;
    if (showAuthor && msg.message.author) {
      const photo = msg.message.authorPhotoUrl
        ? this.authorPhotoCache.get(msg.message.authorPhotoUrl)
        : undefined;
      if (photo?.complete && photo.naturalWidth > 0) {
        this.drawAuthorPhoto(ctx, photo, textX, contentY);
      }
      ctx.font = getFontString(
        Math.round(fontSize * rendererLayout.authorFontScale),
        this.settings.fontWeight,
        this.settings.fontFamily
      );
      ctx.textBaseline = 'top';
      this.strokeTextOutline(
        ctx,
        msg.message.author,
        textX + (photo ? rendererLayout.authorPhotoSize + 4 : 0),
        contentY + 6,
        '#ffffff'
      );
      ctx.fillStyle = '#ffffff';
      ctx.fillText(
        msg.message.author,
        textX + (photo ? rendererLayout.authorPhotoSize + 4 : 0),
        contentY + 6
      );
      contentY += rendererLayout.authorSectionHeightPx;
    }

    const badgeY = contentY;
    const badgeFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
    ctx.font = `bold ${badgeFontSize}px ${this.settings.fontFamily}`;
    const badgeWidth = Math.ceil(ctx.measureText(superChat.amount).width) + 24;
    const badgeHeight = badgeFontSize + 8;

    // Badge pill background
    this.roundRect(ctx, textX, badgeY, badgeWidth, badgeHeight, 12);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textBaseline = 'middle';
    this.strokeTextOutline(ctx, superChat.amount, textX + 12, badgeY + badgeHeight / 2, '#ffffff');
    ctx.fillStyle = '#ffffff';
    ctx.fillText(superChat.amount, textX + 12, badgeY + badgeHeight / 2);

    if (message.text) {
      const msgY = badgeY + badgeHeight + 6;
      this.renderSegment(ctx, message.text, textX, msgY, '#ffffff', alpha, fontSize);
    }

    if (superChat.sticker) {
      const cached = this.stickerCache.get(superChat.sticker.url);
      const stickerImg = cached?.complete && cached.naturalWidth > 0 ? cached : null;
      if (stickerImg) {
        const stickerSize = Math.round(fontSize * rendererLayout.superchatStickerSize);
        ctx.globalAlpha = alpha;
        ctx.drawImage(
          stickerImg,
          textX,
          badgeY + badgeHeight + 6 + (message.text ? Math.round(fontSize * 1.4) + 6 : 0),
          stickerSize,
          stickerSize
        );
      }
    }
  }

  // ── Membership ───────────────────────────────────────────────────────

  private renderMembership(
    ctx: CanvasRenderingContext2D,
    msg: CanvasMessage,
    x: number,
    y: number,
    alpha: number
  ): void {
    const fontSize = this.settings.fontSize;
    const w = msg.width;
    const h = msg.height;

    ctx.globalAlpha = alpha;

    ctx.fillStyle = 'rgba(15, 157, 88, 0.28)';
    this.roundRect(ctx, x, y, w, h, 6);
    ctx.fill();

    // Pulsing green glow border (CSS keyframes equivalent)
    const elapsed = performance.now() - msg.startTime - msg.pausedDuration;
    const pulse = Math.sin((elapsed / 1000) * Math.PI) * 0.15 + 0.75;
    ctx.strokeStyle = `rgba(15, 157, 88, ${pulse})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    const textX = x + rendererLayout.paddingH;
    let textY = y + rendererLayout.paddingV;

    if (msg.message.author) {
      ctx.font = this.getFont(fontSize);
      ctx.textBaseline = 'top';
      this.strokeTextOutline(ctx, msg.message.author, textX, textY, '#ffffff');
      ctx.fillStyle = '#ffffff';
      ctx.fillText(msg.message.author, textX, textY);
      textY += fontSize + 4;
    }

    if (msg.message.text) {
      this.renderSegment(ctx, msg.message.text, textX, textY, '#ffffff', 1, fontSize);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /** Draw an author photo with shadow effects. */
  private drawAuthorPhoto(
    ctx: CanvasRenderingContext2D,
    photo: HTMLImageElement,
    x: number,
    y: number
  ): void {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.drawImage(photo, x, y, rendererLayout.authorPhotoSize, rendererLayout.authorPhotoSize);
    ctx.restore();
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  private static rgbaHex(color: string, alpha: number): string {
    const rgbMatch = color.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (rgbMatch) {
      return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
    }
    const rgbaMatch = color.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*[\d.]+\s*\)/);
    if (rgbaMatch) {
      return `rgba(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]}, ${alpha})`;
    }
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // ── Abstract hook implementations ────────────────────────────────────

  protected onPause(): void {
    this.stopRenderLoop();
  }

  protected onResume(): void {
    this.startRenderLoop();
    this.drainQueue(performance.now());
  }

  protected applyPausedDuration(pausedMs: number): void {
    for (const msg of this.activeMessages) {
      msg.pausedDuration += pausedMs;
    }
  }

  protected resetState(): void {
    this.activeMessages.length = 0;
    this.pendingQueue.length = 0;
    this.backlogPaused = false;
    this.textWidthCache.clear();
    this.textBitmapCache.clear();
  }

  protected onDestroy(): void {
    this.stopRenderLoop();
    this.overlayDimensionsUnsubscribe?.();
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.emojiCache.clear();
    this.authorPhotoCache.clear();
    this.stickerCache.clear();
    this.textBitmapCache.clear();
  }
}
