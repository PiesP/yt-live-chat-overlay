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

import type { ChatMessage, ContentSegment, OverlaySettings } from '@app-types';
import { computeDliosDuration, rendererLayout } from '@core/design-tokens';
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

  private isPaused = false;
  private isVideoPaused = false;
  private pausedAt: number | null = null;
  private playbackRate = 1;
  private backlogSpeedMultiplier = 1;

  /** Emoji image cache: url → HTMLImageElement (bounded LRU, max 200 entries) */
  private readonly emojiCache = new Map<string, HTMLImageElement>();
  private static readonly EMOJI_CACHE_MAX = 200;

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

    // Pre-load emoji images when the message is first seen
    this.prefetchEmojis(message);

    if (this.activeMessages.length >= Canvas2DRenderer.MAX_ACTIVE) {
      this.pendingQueue.push(message);
      return;
    }
    this.renderMessage(message);
  }

  setBacklogSpeedMultiplier(multiplier: number): void {
    this.backlogSpeedMultiplier = Math.max(1, multiplier);
  }

  trimBackgroundQueue(): void {
    if (this.pendingQueue.length > 10) {
      this.pendingQueue.length = 10;
    }
  }

  updateSettings(settings: OverlaySettings, _options?: Canvas2DRendererUpdateOptions): void {
    this.settings = settings;
    this.observability.setShowDebug(settings.showDebugOverlay);
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

    // Remove expired (reverse order to preserve indices)
    for (let ri = toRemove.length - 1; ri >= 0; ri--) {
      const idx = toRemove[ri];
      if (idx !== undefined) {
        this.activeMessages.splice(idx, 1);
      }
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

  // ── Emoji Pre-fetching ──────────────────────────────────────────────────

  private prefetchEmojis(message: ChatMessage): void {
    for (const seg of message.content) {
      if (seg.type === 'emoji' && !this.emojiCache.has(seg.emoji.url)) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = seg.emoji.url;
        img.alt = seg.emoji.alt || '';
        img.onload = () => {
          this.emojiCache.set(seg.emoji.url, img);
        };
        img.onerror = () => {
          // Cache the URL as failed so we don't retry every frame
          this.emojiCache.set(seg.emoji.url, img);
        };
        // Evict oldest entry when cache is full (LRU via Map insertion order)
        if (this.emojiCache.size >= Canvas2DRenderer.EMOJI_CACHE_MAX) {
          const oldestKey = this.emojiCache.keys().next().value;
          if (oldestKey !== undefined) this.emojiCache.delete(oldestKey);
        }
        this.emojiCache.set(seg.emoji.url, img); // placeholder to avoid re-queue
      }
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
    const effectiveDuration =
      speed > 0
        ? computeDliosDuration(dims.width + msgWidth + Canvas2DRenderer.EXIT_PADDING, speed)
        : rendererLayout.durationMin;

    let startX: number;
    if (mode === 'scroll') {
      const entryOffset =
        dims.laneCount > 1 ? Math.round((placement.lane.index / (dims.laneCount - 1)) * 200) : 100;
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
    this.drainQueue();
  }

  // ── Dimension Estimation ────────────────────────────────────────────────

  private estimateDimensions(message: ChatMessage): { width: number; height: number } {
    const fontSize = this.settings.fontSize;
    const textWidth = this.measureContentWidth(message, fontSize);
    const textHeight = fontSize * 1.1;
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

    if (message.content.length > 0) {
      this.renderContentSegments(ctx, message.content, x, y, color, alpha, fontSize);
    } else if (message.text.length > 0) {
      this.renderSegment(ctx, message.text, x, y, color, alpha, fontSize);
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

    const tierColors: Record<string, string> = {
      blue: '#1e88e5',
      cyan: '#00bfff',
      green: '#1de9b6',
      yellow: '#ffca28',
      orange: '#f57c00',
      magenta: '#e91e63',
      red: '#e62117',
    };
    const baseColor = tierColors[superChat.tier] ?? '#1e88e5';

    // Card background gradient
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, `${baseColor}bb`);
    grad.addColorStop(0.5, `${baseColor}66`);
    grad.addColorStop(1, `${baseColor}55`);
    ctx.fillStyle = grad;
    this.roundRect(ctx, x, y, w, h, 6);
    ctx.fill();

    // Left accent border
    ctx.fillStyle = baseColor;
    ctx.fillRect(x, y, 4, h);

    // Amount badge
    const textX = x + 12;
    const badgeY = y + 8;
    ctx.font = `bold ${Math.round(fontSize * 0.85)}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(superChat.amount, textX, badgeY);

    // Message text
    if (message.text) {
      const msgY = badgeY + Math.round(fontSize * 1.1) + 6;
      this.renderSegment(ctx, message.text, textX, msgY, '#ffffff', alpha, fontSize);
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
      ctx.font = `${fontSize}px system-ui, -apple-system, sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(msg.message.text, textX, textY);
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

  private getEffectiveSpeed(): number {
    const speed = this.settings.speedPxPerSec * this.playbackRate;
    return Math.max(1, speed);
  }

  /** Get speed for backlog messages, which scroll faster. */
  private getEffectiveBacklogSpeed(): number {
    const speed =
      this.settings.speedPxPerSec * this.playbackRate * Math.max(1, this.backlogSpeedMultiplier);
    return Math.max(1, speed);
  }
}
