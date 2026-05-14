/**
 * Canvas2DRenderer
 *
 * Canvas 2D-based renderer that uses requestAnimationFrame instead of CSS
 * @keyframes animations.  Each frame computes positions with Math.floor() to
 * snap to integer pixel coordinates, eliminating the sub-pixel text jitter
 * inherent in CSS transform interpolation.
 *
 * Pause state machine mirrors the CSS Renderer:
 *   isPaused      — tab visibility
 *   isVideoPaused — video element pause
 *
 * Text outline: 3-pass rendering (stroke → shadowBlur glow → fill) matching
 * the CSS renderer's buildTextShadow + buildTextStroke.
 */

import type { BurstLevel, ChatMessage, ContentSegment, OverlaySettings } from '@app-types';
import { PerAuthorRateLimiter } from '@core/author-rate-limiter';
import { BurstDetector } from '@core/burst-detector';
import {
  computeDliosDuration,
  colors as designColors,
  parseRgbColor,
  rendererLayout,
} from '@core/design-tokens';
import { createLogger } from '@core/logging';
import { ObservabilityReporter } from '@core/observability';
import type { Overlay } from '@core/overlay';
import { LaneAllocator } from '@core/renderer-lanes';

const log = createLogger('Canvas2DRenderer');

// ── Types ─────────────────────────────────────────────────────────────────

export interface Canvas2DRendererUpdateOptions {
  resetState?: boolean;
}

interface CanvasMessage {
  message: ChatMessage;
  startTime: number;
  duration: number;
  width: number;
  height: number;
  /** Scroll modes: fixed X at spawn time (never re-read for interpolation) */
  startX: number;
  /** Current X position (synced each frame in render loop) */
  x: number;
  /** Current Y position (top of the message bounding box) */
  y: number;
  /** Accumulated paused time (ms) so the animation timeline resumes correctly */
  pausedDuration: number;
  /** Lane index for cleanup */
  laneIndex: number;
}

// ── Renderer ──────────────────────────────────────────────────────────────

export class Canvas2DRenderer {
  readonly observability: ObservabilityReporter;
  onBacklogPauseChange: ((paused: boolean) => void) | null = null;

  private overlay: Overlay;
  private settings: OverlaySettings;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private animFrameId: number | null = null;
  private overlayDimensionsUnsubscribe: (() => void) | null = null;
  private laneAllocator: LaneAllocator;

  private readonly activeMessages: CanvasMessage[] = [];
  private readonly pendingQueue: ChatMessage[] = [];

  private burstDetector: BurstDetector;
  private authorRateLimiter: PerAuthorRateLimiter;
  private backlogPaused = false;
  private static readonly QUEUE_MAX_SIZE = 50;

  private isPaused = false;
  private isVideoPaused = false;
  private pausedAt: number | null = null;
  private playbackRate = 1;
  private backlogSpeedMultiplier = 1;
  /** Timestamp until which the EMA speed multiplier is suppressed after resume. */
  private resumeStabilizeUntil: number = 0;

  /** Emoji image cache: url → HTMLImageElement (bounded LRU, max 200 entries) */
  private readonly emojiCache = new Map<string, HTMLImageElement>();
  private static readonly EMOJI_CACHE_MAX = 200;
  /** Set of emoji URLs currently being fetched (prevents duplicate requests) */
  private readonly emojiFetching = new Set<string>();
  /** Max concurrent emoji image loads */
  private static readonly EMOJI_MAX_CONCURRENT = 6;
  /** Author photo cache: url → HTMLImageElement */
  private readonly authorPhotoCache = new Map<string, HTMLImageElement>();
  /** SuperChat sticker cache: url → HTMLImageElement */
  private readonly stickerCache = new Map<string, HTMLImageElement>();

  private static readonly MAX_ACTIVE = 50;
  private static readonly FADE_DURATION_MS = 500;
  private static readonly EXIT_PADDING = 100;
  private static readonly MAX_PAUSE_MS = 60_000;

  constructor(overlay: Overlay, settings: OverlaySettings) {
    this.overlay = overlay;
    this.settings = settings;
    this.observability = new ObservabilityReporter(settings.showDebugOverlay);

    const container = overlay.getContainer();
    const canvas = document.createElement('canvas');
    canvas.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none';
    if (container) container.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    const dims = overlay.getDimensions();
    if (dims && this.canvas) {
      this.canvas.width = dims.width;
      this.canvas.height = dims.height;
    }

    this.laneAllocator = new LaneAllocator({
      getEffectiveSpeedPxPerSec: () => this.getEffectiveSpeed(),
      getDanmakuMode: () => this.settings.danmakuMode,
      safeTop: this.settings.safeTop,
      laneSpacing: this.settings.laneSpacing,
    });
    if (dims) this.laneAllocator.reset(dims);

    this.burstDetector = new BurstDetector(this.observability);
    this.burstDetector.start();
    this.authorRateLimiter = new PerAuthorRateLimiter(() => this.burstDetector.getLevel());
    this.authorRateLimiter.updateConfig({
      enabled: settings.authorRateLimitEnabled,
      windowMs: settings.authorRateLimitWindowMs,
      maxPerWindow: settings.authorRateLimitMaxMessages,
    });

    this.overlayDimensionsUnsubscribe = overlay.onDimensionsChanged((dims) => {
      if (dims && this.canvas) {
        this.canvas.width = dims.width;
        this.canvas.height = dims.height;
        this.laneAllocator.reset(dims);
      }
    });

    this.startRenderLoop();
    log.info('Canvas2DRenderer created');
  }

  // ── Public API ──────────────────────────────────────────────────────────

  get laneCount(): number {
    return this.laneAllocator.getLaneCount();
  }

  addMessage(message: ChatMessage): void {
    if (this.isVideoPaused) {
      this.observability.onMessageDropped('other');
      return;
    }

    this.observability.onMessageReceived();
    this.burstDetector.onMessageReceived();

    // Per-author rate limiting
    const priority = this.getMessagePriority(message);
    if (!this.authorRateLimiter.allow(message.author ?? 'anonymous', priority)) {
      log.debug('Drop [rate_limited]:', message.author, message.kind, message.id);
      this.observability.onMessageDropped('rate_limited');
      return;
    }

    // Pre-load emoji images, author photos, and stickers
    this.prefetchImages(message);

    // Queue overflow: replace lowest-priority message if incoming is more important
    if (this.pendingQueue.length >= Canvas2DRenderer.QUEUE_MAX_SIZE) {
      // Last item is lowest priority (FIFO tail)
      const last = this.pendingQueue[this.pendingQueue.length - 1];
      if (last && priority <= this.getMessagePriority(last)) {
        log.debug('Drop [queue_overflow]:', message.author, message.kind);
        this.observability.onMessageDropped('queue_overflow');
        return;
      }
      this.pendingQueue.pop();
      this.observability.onMessageDropped('queue_overflow');
    }

    // Insert in priority order (highest first) for fairness
    const insertIndex = this.pendingQueue.findIndex((q) => this.getMessagePriority(q) < priority);
    if (insertIndex === -1) {
      this.pendingQueue.push(message);
    } else {
      this.pendingQueue.splice(insertIndex, 0, message);
    }

    // If slots available, render immediately
    if (this.activeMessages.length < Canvas2DRenderer.MAX_ACTIVE) {
      // Pause backlog injection if queue is saturated
      this.updateBacklogPause();

      const next = this.pendingQueue.shift();
      if (next) this.renderMessage(next);
    }
  }

  setBacklogSpeedMultiplier(multiplier: number): void {
    this.backlogSpeedMultiplier = Math.max(1, multiplier);
  }

  trimBackgroundQueue(): void {
    if (this.pendingQueue.length > 10) {
      // Sort by priority descending (SuperChat > Membership > text), then by timestamp
      this.pendingQueue.sort((a, b) => {
        const prioA = a.kind === 'superchat' ? 2 : a.kind === 'membership' ? 1 : 0;
        const prioB = b.kind === 'superchat' ? 2 : b.kind === 'membership' ? 1 : 0;
        return prioB - prioA || (a.timestamp ?? 0) - (b.timestamp ?? 0);
      });
      this.pendingQueue.length = 10;
    }
  }

  updateSettings(settings: OverlaySettings, _options?: Canvas2DRendererUpdateOptions): void {
    this.settings = settings;
    this.observability.setShowDebug(settings.showDebugOverlay);
    this.authorRateLimiter.updateConfig({
      enabled: settings.authorRateLimitEnabled,
      windowMs: settings.authorRateLimitWindowMs,
      maxPerWindow: settings.authorRateLimitMaxMessages,
    });
    // Only reset lane allocator when the overlay dimensions have changed,
    // not on every settings update (mirrors CSS renderer behavior).
    if (this.laneAllocator.isEmpty()) {
      this.laneAllocator.reset(this.overlay.getDimensions());
    }
  }

  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
    this.pausedAt = performance.now();
    this.stopRenderLoop();
    log.debug('Paused');
  }

  resume(): void {
    if (!this.isPaused) return;
    if (this.isVideoPaused) {
      return;
    }

    const now = performance.now();
    if (this.pausedAt !== null) {
      const pauseMs = Math.min(now - this.pausedAt, Canvas2DRenderer.MAX_PAUSE_MS);
      for (const msg of this.activeMessages) {
        msg.pausedDuration += pauseMs;
      }
    }
    this.pausedAt = null;
    this.isPaused = false;
    this.resumeStabilizeUntil = performance.now() + 2000;
    this.startRenderLoop();

    // Drain any messages that accumulated in the queue during pause
    this.drainQueue();
    log.debug(`Resumed: ${this.activeMessages.length} active, ${this.pendingQueue.length} queued`);
  }

  pauseForVideo(): void {
    if (this.isVideoPaused) return;
    this.isVideoPaused = true;
    if (!this.isPaused) {
      this.pause();
    }
  }

  resumeForVideo(): void {
    if (!this.isVideoPaused) return;
    this.isVideoPaused = false;
    if (!document.hidden) {
      this.resume();
    }
  }

  setPlaybackRate(rate: number): void {
    if (rate <= 0) return;
    this.playbackRate = rate;
  }

  destroy(): void {
    this.isPaused = false;
    this.isVideoPaused = false;
    this.stopRenderLoop();
    this.overlayDimensionsUnsubscribe?.();
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.activeMessages.length = 0;
    this.pendingQueue.length = 0;
    this.emojiCache.clear();
    this.authorPhotoCache.clear();
    this.stickerCache.clear();
    this.burstDetector.destroy();
    this.authorRateLimiter.destroy();
    this.observability.destroy();
    log.debug('Destroyed');
  }

  // ── Render Loop ─────────────────────────────────────────────────────────

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

  // ── Frame Rendering ─────────────────────────────────────────────────────

  private renderFrame(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    // Skip drawing while paused (positions frozen, but rAF loop keeps running)
    if (this.isPaused) return;
    // Skip drawing while video is paused — prevents drainQueue from adding
    // pending messages with timestamps that don't account for pause duration.
    if (this.isVideoPaused) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const now = performance.now();
    const dims = this.overlay.getDimensions();
    if (!dims) return;

    const mode = this.settings.danmakuMode;
    const isScrolling = mode === 'scroll' || mode === 'reverse';

    // Process queue if slots available
    this.drainQueue();

    // Update positions and collect expired
    const toRemove: number[] = [];

    for (let i = 0; i < this.activeMessages.length; i++) {
      const msg = this.activeMessages[i];
      if (!msg) continue;
      const elapsed = now - msg.startTime - msg.pausedDuration;

      if (elapsed >= msg.duration) {
        toRemove.push(i);
        continue;
      }

      // ── Position update (with pixel snap) ────────────────────────────
      const progress = Math.min(1, Math.max(0, elapsed / msg.duration));

      if (mode === 'scroll') {
        const travelDistance = canvas.width + msg.width + Canvas2DRenderer.EXIT_PADDING;
        msg.x = msg.startX - progress * travelDistance;
      } else if (mode === 'reverse') {
        const travelDistance = canvas.width * 2 + Canvas2DRenderer.EXIT_PADDING;
        msg.x = -msg.width + progress * travelDistance;
      }
      // top/bottom: X is static, set at spawn time

      // ── Opacity ──────────────────────────────────────────────────────
      let opacity = this.settings.opacity;
      if (!isScrolling) {
        if (elapsed < Canvas2DRenderer.FADE_DURATION_MS) {
          opacity *= elapsed / Canvas2DRenderer.FADE_DURATION_MS;
        } else if (elapsed > msg.duration - Canvas2DRenderer.FADE_DURATION_MS) {
          opacity *= Math.max(0, (msg.duration - elapsed) / Canvas2DRenderer.FADE_DURATION_MS);
        }
      }
      if (msg.message.isBacklog) opacity *= 0.5;

      // Long-term age fade (matches CSS renderer's 60s linear fade)
      const maxAgeMs = 60_000;
      const ageRatio = Math.min(1, elapsed / maxAgeMs);
      opacity *= Math.max(0, 1 - ageRatio);

      // ── Render ───────────────────────────────────────────────────────
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

    // Remove expired (swap-with-last + pop to avoid O(n) splice shifts)
    for (let ri = toRemove.length - 1; ri >= 0; ri--) {
      const idx = toRemove[ri];
      if (idx === undefined) continue;
      const lastIdx = this.activeMessages.length - 1;
      if (idx < lastIdx) {
        const lastMsg = this.activeMessages[lastIdx];
        if (lastMsg) this.activeMessages[idx] = lastMsg;
      }
      this.activeMessages.pop();
    }

    this.observability.updateActiveMessages(this.activeMessages.length);
    this.observability.updateQueueDepth(this.pendingQueue.length);
  }

  // ── Queue Processing ────────────────────────────────────────────────────

  private drainQueue(): void {
    while (
      this.pendingQueue.length > 0 &&
      this.activeMessages.length < Canvas2DRenderer.MAX_ACTIVE
    ) {
      const msg = this.pendingQueue.shift();
      if (msg) this.renderMessage(msg);
    }
  }

  // ── Image Pre-fetching ──────────────────────────────────────────────────

  private prefetchImages(message: ChatMessage): void {
    // Pre-fetch emoji images
    for (const seg of message.content) {
      if (seg.type !== 'emoji') continue;
      if (this.emojiCache.has(seg.emoji.url)) continue;
      if (this.emojiFetching.has(seg.emoji.url)) continue;
      if (this.emojiFetching.size >= Canvas2DRenderer.EMOJI_MAX_CONCURRENT) continue;

      this.emojiFetching.add(seg.emoji.url);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = seg.emoji.url;
      img.alt = seg.emoji.alt || '';
      img.onload = () => {
        this.emojiFetching.delete(seg.emoji.url);
        if (this.emojiCache.size >= Canvas2DRenderer.EMOJI_CACHE_MAX) {
          const oldestKey = this.emojiCache.keys().next().value;
          if (oldestKey !== undefined) this.emojiCache.delete(oldestKey);
        }
        this.emojiCache.set(seg.emoji.url, img);
      };
      img.onerror = () => {
        this.emojiFetching.delete(seg.emoji.url);
        this.emojiCache.set(seg.emoji.url, img);
      };
    }

    // Pre-fetch author photo
    const photoUrl = message.authorPhotoUrl;
    if (photoUrl && !this.authorPhotoCache.has(photoUrl)) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = photoUrl;
      img.alt = message.author ?? 'Author';
      img.onload = () => this.authorPhotoCache.set(photoUrl, img);
      img.onerror = () => this.authorPhotoCache.set(photoUrl, img);
      this.authorPhotoCache.set(photoUrl, img);
    }

    // Pre-fetch SuperChat sticker
    const sticker = message.superChat?.sticker;
    const stickerUrl = sticker?.url;
    if (stickerUrl && !this.stickerCache.has(stickerUrl)) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = stickerUrl;
      img.alt = sticker?.alt || '';
      img.onload = () => this.stickerCache.set(stickerUrl, img);
      img.onerror = () => this.stickerCache.set(stickerUrl, img);
      this.stickerCache.set(stickerUrl, img);
    }
  }

  // ── Message Rendering ───────────────────────────────────────────────────

  private renderMessage(message: ChatMessage): void {
    const dims = this.overlay.getDimensions();
    if (!dims) return;

    const mode = this.settings.danmakuMode;

    const { width: msgWidth, height: msgHeight } = this.estimateDimensions(message);

    const placement = this.laneAllocator.findPlacement(msgHeight, dims);
    if (!placement) {
      this.observability.onMessageDropped('no_lane_available');
      return;
    }

    const now = performance.now();
    const speed = message.isBacklog ? this.getEffectiveBacklogSpeed() : this.getEffectiveSpeed();

    // Compute entry offset once for both duration and startX.
    // Scroll mode: proportional to lane index (0-200px range).
    // Reverse / fixed modes: no entry offset.
    const entryOffset =
      mode === 'scroll'
        ? dims.laneCount > 1
          ? Math.round((placement.lane.index / (dims.laneCount - 1)) * 200)
          : 100
        : 0;

    let effectiveDuration: number;
    if (mode === 'scroll' || mode === 'reverse') {
      const exitPadding = Math.max(
        this.settings.fontSize * rendererLayout.exitPaddingScale,
        rendererLayout.exitPaddingMin
      );
      const totalDistance =
        mode === 'reverse'
          ? dims.width * 2 + exitPadding
          : entryOffset + dims.width + msgWidth + exitPadding;
      effectiveDuration =
        speed > 0 ? computeDliosDuration(totalDistance, speed) : rendererLayout.durationMin;
    } else {
      effectiveDuration = rendererLayout.topBottomDurationMs;
    }

    let startX: number;
    if (mode === 'scroll') {
      startX = dims.width + entryOffset;
    } else if (mode === 'reverse') {
      startX = -(msgWidth + Canvas2DRenderer.EXIT_PADDING);
    } else {
      startX = Math.random() * Math.max(1, dims.width - msgWidth);
    }

    let laneY = placement.laneY;
    if (mode === 'bottom') {
      laneY = dims.height * (1 - this.settings.safeBottom) - msgHeight;
    } else if (mode === 'top') {
      laneY = dims.height * this.settings.safeTop;
    }

    this.laneAllocator.commitPlacement(placement, msgWidth, now);

    const cm: CanvasMessage = {
      message,
      startTime: now,
      duration: effectiveDuration,
      width: msgWidth,
      height: msgHeight,
      startX,
      x: startX,
      y: laneY,
      pausedDuration: 0,
      laneIndex: placement.lane.index,
    };

    this.activeMessages.push(cm);
    this.observability.onMessageRendered();
  }

  // ── Message Priority ───────────────────────────────────────────────

  private static readonly KIND_PRIORITY: Record<ChatMessage['kind'], number> = {
    superchat: 200,
    membership: 100,
    text: 0,
  };

  private getMessagePriority(message: ChatMessage): number {
    let priority = Canvas2DRenderer.KIND_PRIORITY[message.kind];
    if (message.isBacklog) priority -= 50;
    return priority;
  }

  // ── Backlog Pause ──────────────────────────────────────────────────

  private updateBacklogPause(): void {
    const queueRatio = this.pendingQueue.length / Canvas2DRenderer.QUEUE_MAX_SIZE;
    if (queueRatio > 0.8 && this.backlogPaused === false) {
      this.backlogPaused = true;
      this.onBacklogPauseChange?.(true);
    } else if (queueRatio < 0.4 && this.backlogPaused === true) {
      this.backlogPaused = false;
      this.onBacklogPauseChange?.(false);
    }
  }

  // ── Dimension Estimation ────────────────────────────────────────────────

  private estimateDimensions(message: ChatMessage): { width: number; height: number } {
    const fontSize = this.settings.fontSize;
    const textWidth = this.measureContentWidth(message, fontSize);
    const textHeight = this.measureTextHeight(fontSize);
    const paddingH = 16;
    const paddingV = 8;

    if (message.kind === 'superchat') {
      return {
        width: Math.max(280, Math.min(640, textWidth + 24)),
        height: Math.ceil(fontSize * 1.5) + 8 + textHeight + paddingV,
      };
    }
    if (message.kind === 'membership') {
      return {
        width: textWidth + 32,
        height: Math.max(24, fontSize) + 4 + textHeight + paddingV,
      };
    }
    return {
      width: textWidth + paddingH,
      height: textHeight + paddingV,
    };
  }

  private measureContentWidth(message: ChatMessage, fontSize: number): number {
    const ctx = this.ctx;
    if (!ctx) return message.text.length * fontSize * 0.6;
    const font = this.getFont(fontSize);
    ctx.font = font;

    let width = 0;
    if (message.content.length > 0) {
      for (const seg of message.content) {
        if (seg.type === 'text') {
          width += Math.ceil(ctx.measureText(seg.content).width);
        } else {
          width += Math.ceil(fontSize * 1.2) + 4;
        }
      }
    } else if (message.text) {
      width += Math.ceil(ctx.measureText(message.text).width);
    }
    return Math.ceil(width);
  }

  /**
   * Measure actual text height using font bounding box metrics,
   * falling back to fontSize * 1.1 (matches RendererMessageBuilder.measureTextHeight).
   */
  private measureTextHeight(fontSize: number): number {
    const ctx = this.ctx;
    if (!ctx) return Math.ceil(fontSize * 1.1);
    const font = this.getFont(fontSize);
    ctx.font = font;
    const metrics = ctx.measureText('Mg');
    const ascent = metrics.fontBoundingBoxAscent;
    const descent = metrics.fontBoundingBoxDescent;
    if (ascent !== undefined && descent !== undefined && ascent > 0) {
      return Math.ceil(ascent + descent);
    }
    return Math.ceil(fontSize * 1.1);
  }

  // ── Font & Outline ──────────────────────────────────────────────────────

  private getFont(fontSize: number): string {
    return `bold ${fontSize}px system-ui, -apple-system, sans-serif`;
  }

  /**
   * Render a single text content segment to the canvas.
   * Uses the same stroke+shadow+fill approach as the CSS renderer's
   * buildTextShadow + buildTextStroke.
   */
  private renderSegment(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    color: string,
    alpha: number,
    fontSize: number
  ): void {
    ctx.globalAlpha = alpha;
    ctx.font = this.getFont(fontSize);
    ctx.textBaseline = 'top';

    // Apply CSS-matched outline: stroke then shadow+fill
    // stroke matches buildTextStroke (width=offset*0.3, opacity*0.7)
    const outline = this.settings.outline;
    if (outline.enabled && outline.widthPx > 0 && outline.opacity > 0) {
      const strokeWidth = Math.max(0.2, outline.widthPx * 0.3);
      const strokeOpacity = Math.min(1, outline.opacity * 0.7);
      ctx.strokeStyle = `rgba(0, 0, 0, ${strokeOpacity})`;
      ctx.lineWidth = strokeWidth;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, x, y);

      // shadowBlur glow matching buildTextShadow's central glow term
      ctx.shadowColor = `rgba(0, 0, 0, ${Math.min(1, outline.opacity * 0.85)})`;
      ctx.shadowBlur = Math.max(1, outline.blurPx * 1.5);
    }

    ctx.fillStyle = color;
    ctx.fillText(text, x, y);

    // Reset shadow for subsequent draws
    if (outline.enabled && outline.widthPx > 0 && outline.opacity > 0) {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }
  }

  // ── Regular Message (mixed content: text + emoji) ───────────────────────

  private renderRegular(
    ctx: CanvasRenderingContext2D,
    msg: CanvasMessage,
    x: number,
    y: number,
    alpha: number
  ): void {
    const message = msg.message;
    const fontSize = this.settings.fontSize;
    const color = this.settings.colors[message.authorType];

    // Semi-transparent background (matches CSS .yt-chat-overlay-message-with-author)
    ctx.globalAlpha = alpha * 0.25;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    this.roundRect(ctx, x, y, msg.width, msg.height, 6);
    ctx.fill();
    ctx.globalAlpha = alpha;

    // Author info (matches CSS showAuthor settings)
    const showAuthor = this.settings.showAuthor[message.authorType];
    const textX = x + 12;
    let textY = y + 8;
    if (showAuthor && message.author) {
      const photo = message.authorPhotoUrl
        ? this.authorPhotoCache.get(message.authorPhotoUrl)
        : undefined;
      if (photo?.complete && photo.naturalWidth > 0) {
        ctx.drawImage(photo, textX, textY, 24, 24);
      }
      const nameFont = `bold ${Math.round(fontSize * 0.85)}px system-ui, -apple-system, sans-serif`;
      ctx.font = nameFont;
      ctx.textBaseline = 'top';
      ctx.fillStyle = color;
      ctx.fillText(message.author, textX + (photo ? 28 : 0), textY + 6);
      textY += 28;
    }

    if (message.content.length > 0) {
      this.renderContentSegments(ctx, message.content, textX, textY, color, alpha, fontSize);
    } else if (message.text.length > 0) {
      this.renderSegment(ctx, message.text, textX, textY, color, alpha, fontSize);
    }
  }

  /**
   * Render mixed content segments (text + emoji) in sequence.
   * Positions advance horizontally per segment.
   */
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
    const emojiSize = Math.round(fontSize * 1.2);

    for (const seg of segments) {
      if (seg.type === 'text') {
        this.renderSegment(ctx, seg.content, cursorX, y, color, alpha, fontSize);
        cursorX += Math.ceil(ctx.measureText(seg.content).width);
      } else {
        // Emoji: try to draw the cached image, fall back to alt text
        const cached = this.emojiCache.get(seg.emoji.url);
        const img = cached?.complete && cached.naturalWidth > 0 ? cached : null;

        if (img) {
          ctx.globalAlpha = alpha;
          ctx.drawImage(img, cursorX, y, emojiSize, emojiSize);
        } else if (seg.emoji.alt) {
          this.renderSegment(ctx, seg.emoji.alt, cursorX, y, color, alpha, fontSize);
        }
        cursorX += emojiSize + 4; // 4px gap between emoji and next segment
      }
    }
  }

  /** Convert a hex color or rgb() string to an rgba() string with custom alpha. */
  private static rgbaHex(color: string, alpha: number): string {
    // rgb(r, g, b) format from design-tokens RgbColor
    const rgbMatch = color.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (rgbMatch) {
      return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
    }
    // #RRGGBB hex format
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // ── Super Chat ──────────────────────────────────────────────────────────

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

    const superChatAlpha = Math.min(1, Math.max(0.4, this.settings.superChatOpacity));
    const topAlpha = Math.min(1, superChatAlpha + 0.06);
    const bottomAlpha = Math.max(0.4, superChatAlpha - 0.08);

    // Resolve tier color from actual YouTube SuperChat header color,
    // falling back to design tokens (matches CSS renderer behavior).
    const sourceColor = superChat.headerBackgroundColor || superChat.backgroundColor;
    const parsed = sourceColor ? parseRgbColor(sourceColor) : null;
    const rgb = parsed ?? designColors.superChat[superChat.tier];
    const baseColor = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;

    // Card background gradient (matches CSS --yt-overlay-superchat-*-opacity)
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, Canvas2DRenderer.rgbaHex(baseColor, topAlpha));
    grad.addColorStop(0.48, Canvas2DRenderer.rgbaHex(baseColor, superChatAlpha));
    grad.addColorStop(1, Canvas2DRenderer.rgbaHex(baseColor, bottomAlpha));
    ctx.fillStyle = grad;
    this.roundRect(ctx, x, y, w, h, 6);
    ctx.fill();

    // Left accent border
    ctx.fillStyle = baseColor;
    ctx.fillRect(x, y, 4, h);

    // Amount badge
    const textX = x + 12;
    let contentY = y + 8;

    // Author photo + name (matches CSS renderer superchat header)
    const showAuthor = this.settings.showAuthor.superChat;
    if (showAuthor && msg.message.author) {
      const photo = msg.message.authorPhotoUrl
        ? this.authorPhotoCache.get(msg.message.authorPhotoUrl)
        : undefined;
      if (photo?.complete && photo.naturalWidth > 0) {
        ctx.drawImage(photo, textX, contentY, 24, 24);
      }
      ctx.font = `bold ${Math.round(fontSize * 0.85)}px system-ui, -apple-system, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(msg.message.author, textX + (photo ? 28 : 0), contentY + 6);
      contentY += 28;
    }

    // Amount badge
    const badgeY = contentY;
    ctx.font = `bold ${Math.round(fontSize * 0.85)}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(superChat.amount, textX, badgeY);

    // Message text
    if (message.text) {
      const msgY = badgeY + Math.round(fontSize * 1.1) + 6;
      this.renderSegment(ctx, message.text, textX, msgY, '#ffffff', alpha, fontSize);
    }

    // Sticker
    if (superChat.sticker) {
      const cached = this.stickerCache.get(superChat.sticker.url);
      const stickerImg = cached?.complete && cached.naturalWidth > 0 ? cached : null;
      if (stickerImg) {
        const stickerSize = Math.round(fontSize * 2);
        ctx.globalAlpha = alpha;
        ctx.drawImage(
          stickerImg,
          textX,
          badgeY +
            Math.round(fontSize * 1.1) +
            6 +
            (message.text ? Math.round(fontSize * 1.4) + 6 : 0),
          stickerSize,
          stickerSize
        );
      }
    }
  }

  // ── Membership ──────────────────────────────────────────────────────────

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

    // Green background
    ctx.fillStyle = 'rgba(15, 157, 88, 0.28)';
    this.roundRect(ctx, x, y, w, h, 6);
    ctx.fill();

    // Green border
    ctx.strokeStyle = 'rgba(15, 157, 88, 0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Content
    const textX = x + 12;
    let textY = y + 8;

    if (msg.message.author) {
      ctx.font = this.getFont(fontSize);
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(msg.message.author, textX, textY);
      textY += fontSize + 4;
    }

    if (msg.message.text) {
      this.renderSegment(ctx, msg.message.text, textX, textY, '#ffffff', 1, fontSize);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

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

  private static readonly BURST_SPEED_MULTIPLIER: Record<BurstLevel, number> = {
    normal: 1.0,
    elevated: 1.1,
    high: 1.2,
    extreme: 1.35,
  };

  private getEffectiveSpeed(): number {
    let speed = this.settings.speedPxPerSec * this.playbackRate;

    // Suppress the EMA-based proactive speed adaptation during the
    // 2-second stabilisation window after a tab-visibility resume.
    if (performance.now() >= this.resumeStabilizeUntil) {
      const emaRate = this.burstDetector.getEmaRate();
      if (emaRate > 5) {
        const emaMultiplier = 1 + Math.min((emaRate - 5) / 15, 0.35);
        speed *= emaMultiplier;
      }
    }

    // Burst-level multiplier
    const burstLevel = this.burstDetector.getLevel();
    speed *= Canvas2DRenderer.BURST_SPEED_MULTIPLIER[burstLevel];

    return Math.max(1, speed);
  }

  /** Get speed for backlog messages, which scroll faster. */
  private getEffectiveBacklogSpeed(): number {
    const speed =
      this.settings.speedPxPerSec * this.playbackRate * Math.max(1, this.backlogSpeedMultiplier);
    return Math.max(1, speed);
  }
}
