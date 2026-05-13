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
 * Text outline: 3-pass rendering (stroke → shadowBlur glow → fill) to match
 * the CSS renderer's buildTextShadow + buildTextStroke.
 */

import type { ChatMessage, OverlaySettings } from '@app-types';
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
  /** True when this message carries rendered bitmap data */
  bitmapRendered: boolean;
  /** Pre-rendered bitmap for plain text messages (avoids fillText per frame) */
  bitmap: HTMLCanvasElement | null;
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

  /** Per-text bitmap cache: key=text|font|color|outlineKey */
  private readonly bitmapCache = new Map<string, HTMLCanvasElement>();
  /** Emoji image cache */
  private readonly emojiCache = new Map<string, HTMLImageElement>();

  private static readonly MAX_ACTIVE = 50;
  private static readonly FADE_DURATION_MS = 500;
  private static readonly EXIT_PADDING = 100;
  private static readonly MAX_PAUSE_MS = 60_000;

  constructor(overlay: Overlay, settings: OverlaySettings) {
    this.overlay = overlay;
    this.settings = settings;
    this.observability = new ObservabilityReporter(settings.showDebugOverlay);

    // Create canvas
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

    // Lane allocator (tighter padding than CSS renderer)
    this.laneAllocator = new LaneAllocator({
      getEffectiveSpeedPxPerSec: () => this.getEffectiveSpeed(),
      getDanmakuMode: () => this.settings.danmakuMode,
      safeTop: this.settings.safeTop,
      laneSpacing: this.settings.laneSpacing,
    });
    if (dims) this.laneAllocator.reset(dims);

    // Resize observer
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
    // Keep at most 10 items — prefer recent
    if (this.pendingQueue.length > 10) {
      this.pendingQueue.length = 10;
    }
  }

  updateSettings(settings: OverlaySettings, _options?: Canvas2DRendererUpdateOptions): void {
    this.settings = settings;
    this.observability.setShowDebug(settings.showDebugOverlay);
    this.laneAllocator.reset(this.overlay.getDimensions());
  }

  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
    this.pausedAt = performance.now();
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
    this.bitmapCache.clear();
    this.emojiCache.clear();
    this.observability.destroy();
    log.debug('Destroyed');
  }

  // ── Render Loop ─────────────────────────────────────────────────────────

  private startRenderLoop(): void {
    const loop = (): void => {
      if (!this.canvas?.isConnected) return;
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

    // Skip drawing while paused (positions frozen)
    if (this.isPaused) return;

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
      // Backlog messages at half opacity
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
    const speed = this.getEffectiveSpeed();
    const effectiveDuration =
      speed > 0
        ? computeDliosDuration(dims.width + msgWidth + Canvas2DRenderer.EXIT_PADDING, speed)
        : rendererLayout.durationMin;

    let startX: number;
    if (mode === 'scroll') {
      // Right-to-left: start off-screen right
      const entryOffset =
        dims.laneCount > 1 ? Math.round((placement.lane.index / (dims.laneCount - 1)) * 200) : 100;
      startX = dims.width + entryOffset;
    } else if (mode === 'reverse') {
      // Left-to-right: start off-screen left
      startX = -(msgWidth + Canvas2DRenderer.EXIT_PADDING);
    } else {
      // top / bottom: random X, Y determined by mode
      startX = Math.random() * Math.max(1, dims.width - msgWidth);
    }

    let laneY = placement.laneY;
    if (mode === 'bottom') {
      // Bottom mode: Y position measured from bottom
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
      bitmapRendered: false,
      bitmap: null,
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
    const paddingH = 16; // 8px * 2
    const paddingV = 8; // 4px * 2

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
    // Regular
    return {
      width: textWidth + paddingH,
      height: textHeight + paddingV,
    };
  }

  private measureContentWidth(message: ChatMessage, fontSize: number): number {
    const ctx = this.ctx;
    if (!ctx) return message.text.length * fontSize * 0.6;
    const font = `bold ${fontSize}px system-ui, -apple-system, sans-serif`;
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

  // ── Text Rendering ──────────────────────────────────────────────────────

  private getFont(fontSize: number): string {
    return `bold ${fontSize}px system-ui, -apple-system, sans-serif`;
  }

  private renderText(
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

    const outline = this.settings.outline;
    if (outline.enabled && outline.widthPx > 0 && outline.opacity > 0) {
      const offset = outline.widthPx;
      const blur = Math.max(0, outline.blurPx);
      const baseOpacity = Math.min(1, outline.opacity);

      // Pass 1: stroke (outline border)
      ctx.strokeStyle = `rgba(0,0,0,${baseOpacity * 0.7})`;
      ctx.lineWidth = Math.max(0.2, offset * 0.3);
      ctx.lineJoin = 'round';
      ctx.strokeText(text, x, y);

      // Pass 2: shadowBlur glow
      ctx.shadowColor = `rgba(0,0,0,${Math.min(1, baseOpacity * 0.85)})`;
      ctx.shadowBlur = Math.max(1, blur * 1.5);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);

      // Reset shadow for subsequent draws
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    } else {
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
    }
  }

  // ── Regular Message (plain text) ────────────────────────────────────────

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
    const text = message.text;

    // Use bitmap cache for plain text messages
    if (!msg.bitmapRendered && msg.bitmap === null && text.length > 0) {
      const bitmap = this.getOrCreateBitmap(text, fontSize, color);
      msg.bitmap = bitmap;
      msg.bitmapRendered = true;
    }

    const bitmap = msg.bitmap;
    if (bitmap) {
      ctx.globalAlpha = alpha;
      ctx.drawImage(bitmap, x, y);
    } else if (text.length > 0) {
      // Fallback: direct fillText
      this.renderText(ctx, text, x, y, color, alpha, fontSize);
    }
  }

  // ── Bitmap Cache ────────────────────────────────────────────────────────

  private getOrCreateBitmap(text: string, fontSize: number, color: string): HTMLCanvasElement {
    const font = this.getFont(fontSize);
    const outline = this.settings.outline;
    const outlineKey = outline.enabled
      ? `${outline.widthPx}x${outline.blurPx}x${outline.opacity}`
      : 'none';
    const key = `${text}|${font}|${color}|${outlineKey}`;

    const cached = this.bitmapCache.get(key);
    if (cached) return cached;

    const offscreen = document.createElement('canvas');
    const octx = offscreen.getContext('2d');
    if (!octx) {
      // Fallback: return a tiny canvas (shouldn't happen)
      offscreen.width = 1;
      offscreen.height = 1;
      this.bitmapCache.set(key, offscreen);
      return offscreen;
    }

    // Measure text width
    octx.font = font;
    const textWidth = Math.ceil(octx.measureText(text).width);
    const textHeight = Math.ceil(fontSize * 1.1);
    offscreen.width = textWidth;
    offscreen.height = textHeight;

    // Render text with full styling
    this.renderText(octx, text, 0, 0, color, 1, fontSize);

    this.bitmapCache.set(key, offscreen);
    return offscreen;
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

    // Background gradient based on tier
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

    // Card background
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, `${baseColor}bb`);
    grad.addColorStop(0.5, `${baseColor}66`);
    grad.addColorStop(1, `${baseColor}55`);
    ctx.fillStyle = grad;
    this.roundRect(ctx, x, y, w, h, 6);
    ctx.fill();

    // Border-left accent
    ctx.fillStyle = baseColor;
    ctx.fillRect(x, y, 4, h);

    // Text content
    const textX = x + 12;
    let textY = y + 8;

    // Amount badge
    const amountText = superChat.amount;
    ctx.font = `bold ${Math.round(fontSize * 0.85)}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(amountText, textX, textY);

    // Body message
    if (message.text) {
      textY += Math.round(fontSize * 1.1) + 6;
      ctx.font = this.getFont(fontSize);
      this.renderText(ctx, message.text, textX, textY, '#ffffff', alpha, fontSize);
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

    // Green border card
    ctx.fillStyle = 'rgba(15, 157, 88, 0.28)';
    this.roundRect(ctx, x, y, w, h, 6);
    ctx.fill();

    ctx.strokeStyle = 'rgba(15, 157, 88, 0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Text content
    const textX = x + 12;
    let textY = y + 8;

    // Author name
    if (msg.message.author) {
      ctx.font = this.getFont(fontSize);
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(msg.message.author, textX, textY);
      textY += fontSize + 4;
    }

    // Message text
    if (msg.message.text) {
      ctx.font = `${fontSize}px system-ui, -apple-system, sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(msg.message.text, textX, textY);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Draw a filled rounded rectangle */
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
    const speed = this.settings.speedPxPerSec * this.playbackRate * this.backlogSpeedMultiplier;
    return Math.max(1, speed);
  }
}
