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
 * Stagger delay: messages in the same drainQueue batch are given an
 * exponentially-distributed time offset (0-200ms) before they start
 * scrolling. This spreads simultaneous entries across time, preventing
 * the visual clumping that occurs when multiple messages enter from the
 * right edge in the same frame. During the stagger period the message
 * sits at the start position (right edge) but is not rendered. The lane
 * allocator reservation is unaffected — the lane is locked from the
 * actual commit time, not the visual start time.
 *
 * Fixes from audit:
 * - BUG-1: updateSettings now propagates _options to super
 * - BUG-4: reverse travel distance uses consistent exitPadding
 * - BUG-5/6: image caches only store loaded images, errors don't cache
 */

import type { ChatMessage, ContentSegment, OverlayDimensions, OverlaySettings } from '@app-types';
import { EMOJI_ALIAS_PATTERN } from '@core/chat-message-helpers';
import {
  computeDliosDuration,
  computeOutlineColor,
  computeReadableTextColor,
  computeSuperChatOpacities,
  colors as designColors,
  rendererLayout,
  resolveSuperChatRgb,
  spacing,
  toRgba,
} from '@core/design-tokens';
import { createLogger } from '@core/logging';
import type { Overlay } from '@core/overlay';
import { RendererBase, type RendererUpdateOptions } from '@core/renderer-base';
import { estimateMessageDimensions as sharedEstimateDimensions } from '@core/renderer-shared';
import {
  clearTextMeasurementCaches,
  getFontString,
  measureTextHeight,
  measureTextWidth,
  wrapTextLines,
} from '@core/text-measure';

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

  /** Image caches (bounded LRU). */
  private readonly emojiCache = new Map<string, HTMLImageElement>();
  private readonly emojiFetching = new Set<string>();
  private readonly authorPhotoCache = new Map<string, HTMLImageElement>();
  private readonly stickerCache = new Map<string, HTMLImageElement>();

  /**
   * Text bitmap cache: pre-rendered text with outline as offscreen canvas.
   * Key = `${font}|${text}|${color}|${strokeWidth}|${strokeColor}`.
   * On cache hit, drawImage() replaces fillText()+strokeText() in the hot path.
   */
  private readonly textBitmapCache = new Map<string, HTMLCanvasElement>();
  private static readonly TEXT_BITMAP_MAX = 500;

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

  /** Get current lane utilization ratio (0–1): occupied lanes / total lanes. */
  getLaneUtilization(): number {
    return this.laneAllocator.getUtilization();
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

    this.updateBacklogPause();

    // Trigger an immediate render frame so the message appears within
    // one frame (~16ms) instead of waiting for the next natural rAF.
    if (this.pendingQueue.length === 1 && this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
      this.startRenderLoop();
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

  // ── Image pre-fetching ────────────────────────────────────────────────

  /** Load an image and store it in the given cache on success. */
  private loadImage(url: string, cache: Map<string, HTMLImageElement>, maxEntries: number): void {
    if (cache.has(url)) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    img.onload = () => {
      if (cache.size >= maxEntries) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
      }
      cache.set(url, img);
    };
  }

  private prefetchImages(message: ChatMessage): void {
    for (const seg of message.content) {
      if (seg.type !== 'emoji') continue;
      if (this.emojiFetching.has(seg.emoji.url)) continue;
      if (this.emojiFetching.size >= 6) continue;
      this.emojiFetching.add(seg.emoji.url);
      const url = seg.emoji.url;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = url;
      img.onload = () => {
        this.emojiFetching.delete(url);
        this.loadImage(url, this.emojiCache, 200);
      };
      img.onerror = () => this.emojiFetching.delete(url);
    }

    if (message.authorPhotoUrl) {
      this.loadImage(message.authorPhotoUrl, this.authorPhotoCache, 100);
    }

    const stickerUrl = message.superChat?.sticker?.url;
    if (stickerUrl) {
      this.loadImage(stickerUrl, this.stickerCache, 50);
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

    // BUG-3 fix: remove expired messages BEFORE draining the queue.
    // Previously drainQueue ran first, so activeMessages.length included
    // about-to-expire entries, artificially limiting how many new messages
    // could be admitted in this frame.
    // Optimized: reverse iteration with splice avoids O(n*m) filter+includes.
    let removed = false;
    for (let i = this.activeMessages.length - 1; i >= 0; i--) {
      const msg = this.activeMessages[i];
      if (!msg) continue;
      const elapsed = now - msg.startTime - msg.pausedDuration;
      if (elapsed >= msg.duration) {
        this.activeMessages.splice(i, 1);
        removed = true;
      }
    }
    if (removed) {
      this.observability.updateActiveMessages(this.activeMessages.length);
      this.observability.updateQueueDepth(this.pendingQueue.length);
    }

    this.drainQueue(now);

    this.observability.tick();

    for (let i = 0; i < this.activeMessages.length; i++) {
      const msg = this.activeMessages[i];
      if (!msg) continue;
      const elapsed = now - msg.startTime - msg.pausedDuration;

      // Skip messages still in stagger delay period (haven't visually started)
      if (elapsed < 0) continue;

      const progress = Math.min(1, Math.max(0, elapsed / msg.duration));

      if (mode === 'scroll') {
        const travelDistance = canvas.width + msg.width + rendererLayout.exitPaddingMin;
        msg.x = msg.startX - progress * travelDistance;
      } else if (mode === 'reverse') {
        const travelDistance = canvas.width * 2 + rendererLayout.exitPaddingMin;
        msg.x = -msg.width + progress * travelDistance;
      }

      let opacity = this.settings.opacity;

      // Fade-in / fade-out. Skip entirely when fadeDurationMs is 0.
      const fadeDuration = this.settings.fadeDurationMs;
      if (fadeDuration > 0) {
        if (elapsed < fadeDuration) {
          opacity *= elapsed / fadeDuration;
        }
        if (!isScrolling && elapsed > msg.duration - fadeDuration) {
          opacity *= Math.max(0, (msg.duration - elapsed) / fadeDuration);
        }
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
  }

  // ── Queue drain ──────────────────────────────────────────────────────

  private drainQueue(now: number): void {
    if (this.isAntiBlockActive()) return;
    let skipped = 0;
    const maxSkip = 3; // prevent scanning entire queue when all collide
    let batchIndex = 0; // for stagger delay computation
    this.laneAllocator.resetBatch();
    while (
      this.pendingQueue.length > 0 &&
      this.activeMessages.length < this.settings.maxConcurrentMessages &&
      skipped <= maxSkip
    ) {
      const msg = this.pendingQueue.shift();
      if (!msg) continue;

      const result = this.checkPlacement(msg, now);
      if (!result.ok) {
        if (result.reason === 'no_lane') {
          this.observability.onMessageDropped('no_lane_available');
          skipped = 0; // reset after drop
          continue;
        }
        // Collision: skip this message and try the next one.
        // Only retry the skipped message if we haven't exceeded maxSkip.
        skipped++;
        this.observability.onMessageDropped('collision');
        continue;
      }

      this.enqueueMessageWithPlacement(msg, now, result.placement, batchIndex);
      skipped = 0; // reset after successful enqueue
      batchIndex++;
    }
  }

  /**
   * Check whether placing a new message at its target lane would cause
   * visual overlap with any currently active (visible) message.
   *
   * Unlike the old wouldOverlap, this returns the LanePlacement on success
   * so the caller can reuse it without calling findPlacement a second time.
   *
   * For scrolling modes, overlap occurs when a new message enters from the
   * right edge while an existing message in the same or adjacent lane has
   * not yet fully exited from the left edge. We use the actual bounding
   * boxes of active messages rather than the lane allocator's theoretical
   * available-time, which can be inaccurate after pause/resume.
   *
   * For top/bottom modes, overlap occurs when an active message in the same
   * lane has not yet expired.
   */
  private checkPlacement(
    message: ChatMessage,
    now: number
  ):
    | { ok: true; placement: import('@core/lane-allocator').LanePlacement }
    | {
        ok: false;
        reason: 'collision' | 'no_lane';
      } {
    const dims = this.overlay.getDimensions();
    if (!dims) return { ok: false, reason: 'no_lane' as const };

    const mode = this.settings.danmakuMode;
    const isScrolling = mode === 'scroll' || mode === 'reverse';
    const { height: msgHeight } = this.estimateDimensions(message);

    // Find the target lane Y position via the allocator (without committing).
    const placement = this.laneAllocator.findPlacement(msgHeight, dims, message.isBacklog ?? false);
    if (!placement) return { ok: false, reason: 'no_lane' as const };

    const newLaneY = placement.laneY;
    const laneHeight = this.laneAllocator.getLaneHeight();

    // Check active messages in reverse (newest first) for early exit on collision.
    for (let i = this.activeMessages.length - 1; i >= 0; i--) {
      const active = this.activeMessages[i];
      if (!active) continue;
      const activeElapsed = now - active.startTime - active.pausedDuration;
      if (activeElapsed < 0) continue; // not yet started

      // Vertical overlap: check if the two messages occupy the same vertical space.
      // Use lane-height granularity to account for padding/spacing.
      const verticalGap = Math.abs(active.y - newLaneY);
      if (verticalGap >= laneHeight) continue; // different lanes, no overlap

      if (isScrolling) {
        // Horizontal overlap: the active message's right edge must have exited
        // the screen before the new message enters from the right.
        const travelDistance = dims.width + active.width + rendererLayout.exitPaddingMin;
        const activeProgress = Math.min(1, activeElapsed / active.duration);
        const activeRightEdge = active.startX - activeProgress * travelDistance + active.width;

        // The new message starts at the right edge (or left for reverse).
        // Overlap if the active message's right edge is still on screen.
        if (mode === 'scroll') {
          if (activeRightEdge > 0) return { ok: false, reason: 'collision' as const };
        } else {
          // reverse mode: messages enter from left, travel right
          const reverseTravel = dims.width * 2 + rendererLayout.exitPaddingMin;
          const activeX = -active.width + activeProgress * reverseTravel;
          if (activeX + active.width > 0) return { ok: false, reason: 'collision' as const };
        }
      } else {
        // Top/bottom modes: overlap if the active message in the same lane
        // has not yet expired.
        if (activeElapsed < active.duration) return { ok: false, reason: 'collision' as const };
      }
    }

    return { ok: true, placement };
  }

  // ── Message enqueue ──────────────────────────────────────────────────

  /**
   * Enqueue a message using a pre-computed placement (from checkPlacement).
   * This avoids the double findPlacement call that caused BUG-1.
   */
  private enqueueMessageWithPlacement(
    message: ChatMessage,
    now: number,
    placement: import('@core/lane-allocator').LanePlacement,
    batchIndex = 0
  ): void {
    const dims = this.overlay.getDimensions();
    if (!dims) return;

    const mode = this.settings.danmakuMode;
    const { width: msgWidth, height: msgHeight } = this.estimateDimensions(message);

    const isScrolling = mode === 'scroll' || mode === 'reverse';

    let effectiveDuration: number;
    if (isScrolling) {
      const speed = message.isBacklog
        ? this.getEffectiveBacklogSpeed()
        : this.getEffectiveSpeedPxPerSec();
      const exitPadding = Math.max(
        this.settings.fontSize * rendererLayout.exitPaddingScale,
        rendererLayout.exitPaddingMin
      );
      const totalDistance =
        mode === 'reverse' ? dims.width * 2 + exitPadding : dims.width + msgWidth + exitPadding;
      effectiveDuration =
        speed > 0 ? computeDliosDuration(totalDistance, speed) : rendererLayout.durationMin;
    } else {
      effectiveDuration = rendererLayout.topBottomDurationMs;
    }

    const laneY = placement.laneY;

    this.laneAllocator.commitPlacement(placement, now, effectiveDuration, msgWidth, dims.width);

    const startX = isScrolling
      ? mode === 'scroll'
        ? dims.width
        : -(msgWidth + rendererLayout.exitPaddingMin)
      : 0;

    // Stagger delay: spread batch entries across time to prevent vertical
    // clumping. Uses exponential distribution so most get 0-50ms, a few
    // get up to 200ms. Only for scrolling mode (top/bottom don't scroll,
    // so stagger doesn't help).
    const staggerDelay =
      isScrolling && batchIndex > 0
        ? Math.round(Math.min(200, batchIndex * -25 * Math.log(1 - Math.random())))
        : 0;

    this.activateMessage(
      message,
      now,
      msgWidth,
      msgHeight,
      laneY,
      effectiveDuration,
      startX,
      placement.lane.index,
      staggerDelay
    );
  }

  /** Finalize and activate a message. */
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
      startTime: now + staggerDelay, // effective start — message waits at right edge
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
      this.settings.fontFamily,
      {
        superchat: this.settings.superChatMaxBodyLines,
        membership: this.settings.membershipMaxBodyLines,
      }
    );
  }

  private getFont(fontSize: number): string {
    return getFontString(fontSize, this.settings.fontWeight, this.settings.fontFamily);
  }

  // ── Backlog pause ────────────────────────────────────────────────────

  private getEffectiveBacklogSpeed(): number {
    const speed = this.settings.speedPxPerSec * Math.max(1, this.backlogSpeedMultiplier);
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
        cursorX += measureTextWidth(seg.content, this.getFont(fontSize));
      } else {
        const cached = this.emojiCache.get(seg.emoji.url);
        const img = cached?.complete && cached.naturalWidth > 0 ? cached : null;
        if (img) {
          ctx.globalAlpha = alpha;
          ctx.drawImage(img, cursorX, y, emojiSize, emojiSize);
        } else if (seg.emoji.fallbackText) {
          this.renderSegment(ctx, seg.emoji.fallbackText, cursorX, y, color, alpha, fontSize);
        } else if (seg.emoji.alt && !EMOJI_ALIAS_PATTERN.test(seg.emoji.alt)) {
          this.renderSegment(ctx, seg.emoji.alt, cursorX, y, color, alpha, fontSize);
        }
        cursorX += emojiSize + 4;
      }
    }
  }

  // ── Wrapped text rendering ────────────────────────────────────────────

  /**
   * Render text with word-wrapping, respecting `maxWidth` and `maxLines`.
   *
   * Uses the same `wrapTextLines()` algorithm as the dimension estimator so
   * rendered output always matches the predicted layout.
   *
   * @returns The Y position after the last rendered line.
   */
  private renderWrappedText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    maxLines: number,
    color: string,
    alpha: number,
    fontSize: number
  ): number {
    const font = this.getFont(fontSize);
    const allLines = wrapTextLines(text, font, maxWidth);
    const lineHeight = Math.ceil(measureTextHeight(font, fontSize));
    const lines = allLines.length > maxLines ? allLines.slice(0, maxLines) : allLines;

    let cursorY = y;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const isLastLine = i === lines.length - 1;
      const isTruncated = isLastLine && allLines.length > maxLines;

      const renderText = isTruncated ? `${line}\u2026` : line;
      this.renderSegment(ctx, renderText, x, cursorY, color, alpha, fontSize);
      cursorY += lineHeight;
    }

    return cursorY;
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
      textY = this.drawAuthorSection(ctx, msg, textX, textY, color);
    }

    if (message.content.length > 0) {
      this.renderContentSegments(ctx, message.content, textX, textY, color, 1, fontSize);
    } else if (message.text.length > 0) {
      this.renderSegment(ctx, message.text, textX, textY, color, 1, fontSize);
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
      base: scAlpha,
      top: topAlpha,
      bottom: bottomAlpha,
    } = computeSuperChatOpacities(this.settings.superChatOpacity);
    const rgb = resolveSuperChatRgb(superChat, designColors.superChat);
    const baseColor = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    const textColor = computeReadableTextColor(baseColor);

    // Background gradient
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, toRgba(baseColor, topAlpha));
    grad.addColorStop(0.48, toRgba(baseColor, scAlpha));
    grad.addColorStop(1, toRgba(baseColor, bottomAlpha));
    ctx.fillStyle = grad;
    this.roundRect(ctx, x, y, w, h, rendererLayout.superchatCardRadius);
    ctx.fill();

    // Left accent bar
    ctx.fillStyle = baseColor;
    ctx.fillRect(x, y, 4, h);

    const scPad = rendererLayout.superchat;
    const textX = x + scPad.paddingH;
    let contentY = y + scPad.paddingV;

    // Author section
    if (this.settings.showAuthor.superChat && message.author) {
      const nameMaxWidth = w - scPad.paddingH * 2;
      contentY = this.drawAuthorSection(ctx, msg, textX, contentY, textColor, nameMaxWidth);
    }

    // Amount badge pill
    const badgeY = contentY + spacing.xs;
    const badgeFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
    const badgeHeight = badgeFontSize + rendererLayout.superchatBadge.paddingV * 2;
    ctx.font = `bold ${badgeFontSize}px ${this.settings.fontFamily}`;
    const badgeTextWidth = Math.ceil(ctx.measureText(superChat.amount).width);
    const badgeWidth = badgeTextWidth + rendererLayout.superchatBadge.paddingH * 2;

    this.roundRect(
      ctx,
      textX,
      badgeY,
      badgeWidth,
      badgeHeight,
      rendererLayout.superchatBadge.radius
    );
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textBaseline = 'middle';
    this.strokeTextOutline(
      ctx,
      superChat.amount,
      textX + rendererLayout.superchatBadge.paddingH,
      badgeY + badgeHeight / 2,
      textColor
    );
    ctx.fillStyle = textColor;
    ctx.fillText(
      superChat.amount,
      textX + rendererLayout.superchatBadge.paddingH,
      badgeY + badgeHeight / 2
    );
    ctx.textBaseline = 'top';

    // Body text
    let textBottomY = badgeY + badgeHeight;
    if (message.text) {
      const bodyMaxWidth = w - scPad.paddingH * 2;
      textBottomY = this.renderWrappedText(
        ctx,
        message.text,
        textX,
        textBottomY + spacing.xs,
        bodyMaxWidth,
        this.settings.superChatMaxBodyLines,
        textColor,
        alpha,
        fontSize
      );
    }

    // Sticker
    if (superChat.sticker) {
      const cached = this.stickerCache.get(superChat.sticker.url);
      const stickerImg = cached?.complete && cached.naturalWidth > 0 ? cached : null;
      if (stickerImg) {
        const maxStickerSize = Math.round(fontSize * rendererLayout.superchatStickerSize);
        const stickerY = textBottomY + spacing.xs;
        const availableHeight = y + h - scPad.paddingV - stickerY;
        const stickerSize = Math.max(0, Math.min(maxStickerSize, availableHeight));
        if (stickerSize > 0) {
          ctx.globalAlpha = alpha;
          ctx.drawImage(stickerImg, textX, stickerY, stickerSize, stickerSize);
        }
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
    const mem = designColors.membership;

    ctx.globalAlpha = alpha;

    ctx.fillStyle = `rgba(${mem.background.r}, ${mem.background.g}, ${mem.background.b}, ${mem.backgroundAlpha})`;
    this.roundRect(ctx, x, y, w, h, rendererLayout.membershipCardRadius);
    ctx.fill();

    const elapsed = performance.now() - msg.startTime - msg.pausedDuration;
    const pulse = Math.sin((elapsed / 1000) * Math.PI) * mem.borderAlphaAmplitude + mem.borderAlpha;
    ctx.strokeStyle = `rgba(${mem.background.r}, ${mem.background.g}, ${mem.background.b}, ${pulse})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    const padH = rendererLayout.membership.paddingH;
    const padV = rendererLayout.membership.paddingV;
    const textX = x + padH;
    let textY = y + padV;

    if (msg.message.author) {
      const nameMaxWidth = w - padH * 2;
      textY = this.drawAuthorSection(ctx, msg, textX, textY, '#ffffff', nameMaxWidth);
    }

    if (msg.message.text) {
      const bodyMaxWidth = w - padH * 2;
      const bodyY = msg.message.author ? textY + spacing.xs : textY;
      this.renderWrappedText(
        ctx,
        msg.message.text,
        textX,
        bodyY,
        bodyMaxWidth,
        this.settings.membershipMaxBodyLines,
        '#ffffff',
        1,
        fontSize
      );
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /** Draw author photo + name section. Returns the Y offset after the section. */
  private drawAuthorSection(
    ctx: CanvasRenderingContext2D,
    msg: CanvasMessage,
    textX: number,
    startY: number,
    color: string,
    maxNameWidth?: number
  ): number {
    const message = msg.message;
    if (!message.author) return startY;

    const fontSize = this.settings.fontSize;
    const authorFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
    const nameFont = getFontString(
      authorFontSize,
      this.settings.fontWeight,
      this.settings.fontFamily
    );
    const nameHeight = measureTextHeight(nameFont, authorFontSize);
    const sectionHeight = Math.max(rendererLayout.authorPhotoSize, nameHeight);

    const photo = message.authorPhotoUrl
      ? this.authorPhotoCache.get(message.authorPhotoUrl)
      : undefined;
    if (photo?.complete && photo.naturalWidth > 0) {
      this.drawAuthorPhoto(ctx, photo, textX, startY);
    }
    const nameX = textX + (photo ? rendererLayout.authorPhotoSize + 4 : 0);
    const nameY = startY + Math.max(0, Math.floor((sectionHeight - nameHeight) / 2));

    // Truncate author name with ellipsis if it exceeds the allowed width
    let displayName = message.author;
    if (maxNameWidth !== undefined && maxNameWidth > 0) {
      ctx.font = nameFont;
      ctx.textBaseline = 'top';
      let nameWidth = ctx.measureText(displayName).width;
      if (nameWidth > maxNameWidth) {
        const ellipsis = '\u2026';
        const ellipsisWidth = ctx.measureText(ellipsis).width;
        while (displayName.length > 0 && nameWidth + ellipsisWidth > maxNameWidth) {
          displayName = displayName.slice(0, -1);
          nameWidth = ctx.measureText(displayName).width;
        }
        displayName += ellipsis;
      }
    }

    ctx.font = nameFont;
    ctx.textBaseline = 'top';
    this.strokeTextOutline(ctx, displayName, nameX, nameY, color);
    ctx.fillStyle = color;
    ctx.fillText(displayName, nameX, nameY);
    return startY + sectionHeight;
  }

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
    clearTextMeasurementCaches();
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
