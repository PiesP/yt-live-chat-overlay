/**
 * Canvas2D Renderer
 *
 * Renders chat messages as scrolling comments on a <canvas> element.
 * Shares LaneAllocator with the CSS Renderer for consistent placement.
 * Uses RendererMessageBuilder for dimension estimation.
 *
 * ── Key differences from the CSS Renderer ──────────────────────────────
 * - rAF-based continuous render loop (no CSS @keyframes)
 * - No DOM nodes per message — renders directly to Canvas 2D
 * - 8-direction text outline (replaces -webkit-text-stroke)
 * - No text-shadow CSS property — manual shadow via ctx.shadow*
 */

import type {
  ChatMessage,
  ContentSegment,
  DanmakuMode,
  OverlayDimensions,
  OverlaySettings,
} from '@app-types';
import { BurstDetector } from '@core/burst-detector';
import { rendererLayout } from '@core/design-tokens';
import { createLogger } from '@core/logging';
import { ObservabilityReporter } from '@core/observability';
import type { Overlay } from '@core/overlay';
import { LaneAllocator } from '@core/renderer-lanes';
import { RendererMessageBuilder } from '@core/renderer-message-builder';

const log = createLogger('Canvas2DRenderer');

interface CanvasMessage {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  opacity: number;
  startTime: number;
  duration: number;
  laneIndex: number;
  kind: 'text' | 'superchat' | 'membership';
  mode: DanmakuMode;
  /** For top/bottom: entry opacity animation start time */
  fadeInEndTime?: number;
  /** For top/bottom: fade-out start time */
  fadeOutStartTime?: number;
  tierColor?: string | undefined;
  amount?: string | undefined;
  authorName?: string | undefined;
  content: ContentSegment[];
  isBacklog?: boolean | undefined;
}

const OUTLINE_OFFSETS = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
] as const;

export class Canvas2DRenderer {
  readonly observability: ObservabilityReporter;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private animFrameId: number | null = null;
  private laneAllocator: LaneAllocator;
  private messageBuilder: RendererMessageBuilder;
  private messages: CanvasMessage[] = [];
  private settings: OverlaySettings;
  private isPaused = false;
  private burstDetector: BurstDetector;
  private dimensions: OverlayDimensions | null = null;
  private overlayDimensionsUnsubscribe: (() => void) | null = null;

  constructor(overlay: Overlay, settings: OverlaySettings) {
    this.settings = settings;
    this.messageBuilder = new RendererMessageBuilder(() => this.settings);
    this.laneAllocator = new LaneAllocator({
      getFontSize: () => this.settings.fontSize,
      getEffectiveSpeedPxPerSec: () => this.settings.speedPxPerSec,
      globalStaggerMs: rendererLayout.globalStaggerMs,
      safeDistanceScale: rendererLayout.safeDistanceScale,
      safeDistanceMin: rendererLayout.safeDistanceMin,
      laneHeightPaddingScale: rendererLayout.laneHeightPaddingScale,
      laneHeightPaddingMin: rendererLayout.laneHeightPaddingMin,
    });
    this.laneAllocator.reset(overlay.getDimensions());
    this.observability = new ObservabilityReporter(settings.showDebugOverlay);
    this.burstDetector = new BurstDetector(this.observability);
    this.burstDetector.start();

    this.initCanvas(overlay);

    this.overlayDimensionsUnsubscribe = overlay.onDimensionsChanged((dimensions) => {
      if (dimensions) {
        this.dimensions = dimensions;
        this.laneAllocator.reset(dimensions);
        this.canvas!.width = dimensions.width;
        this.canvas!.height = dimensions.height;
      }
    });
  }

  private initCanvas(overlay: Overlay): void {
    const container = overlay.getContainer();
    if (!container) {
      log.warn('No overlay container for Canvas2D');
      return;
    }

    this.canvas = document.createElement('canvas');
    this.canvas.style.position = 'absolute';
    this.canvas.style.inset = '0';
    this.canvas.style.pointerEvents = 'none';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';

    const dims = overlay.getDimensions();
    if (dims) {
      this.dimensions = dims;
      this.canvas.width = dims.width;
      this.canvas.height = dims.height;
    }

    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      log.warn('Failed to get Canvas 2D context');
      return;
    }
    this.ctx = ctx;

    container.appendChild(this.canvas);
    this.startRenderLoop();
  }

  private getFont(): string {
    return `${this.settings.fontSize}px system-ui, -apple-system, sans-serif`;
  }

  private emojiCache = new Map<string, HTMLImageElement>();
  private textMeasureCache = new Map<string, number>();
  private offscreenCanvas: HTMLCanvasElement | null = null;
  private offscreenCtx: CanvasRenderingContext2D | null = null;

  private getOffscreenCtx(): CanvasRenderingContext2D | null {
    if (!this.offscreenCanvas) {
      this.offscreenCanvas = document.createElement('canvas');
      this.offscreenCanvas.width = 2048;
      this.offscreenCanvas.height = 256;
      const ctx = this.offscreenCanvas.getContext('2d');
      if (ctx) this.offscreenCtx = ctx;
    }
    return this.offscreenCtx;
  }

  addMessage(message: ChatMessage): void {
    const dims = this.dimensions;
    if (!dims || !this.ctx) return;

    this.burstDetector.onMessageReceived();
    this.observability.onMessageReceived();
    const estimated = this.messageBuilder.estimateMessageDimensions(message);
    const text = message.text;
    const author = message.author ?? '';
    const showAuthor = this.settings.showAuthor[message.authorType];
    const displayText = showAuthor && author ? `${author}: ${text}` : text;

    const placement = this.laneAllocator.findPlacement(estimated.height, dims);
    if (!placement) {
      this.observability.onMessageDropped('no_lane_available');
      return;
    }

    const textWidth = estimated.width;
    const fontSize = this.settings.fontSize;
    const mode = this.settings.danmakuMode;
    const now = performance.now();
    const speed = this.settings.speedPxPerSec;

    let x: number;
    let y: number;
    let duration: number;

    if (mode === 'top' || mode === 'bottom') {
      // Fixed modes: position at top/bottom of safe zone, fade in/out
      const xRange = Math.max(1, dims.width - textWidth);
      x = Math.random() * xRange;
      if (mode === 'top') {
        y = dims.height * this.settings.safeTop;
      } else {
        y = dims.height * (1 - this.settings.safeBottom) - estimated.height;
      }
      duration = 4000;
      this.laneAllocator.commitPlacement(
        placement,
        textWidth,
        estimated.height,
        now,
        now + duration
      );
    } else {
      // Scroll modes (RTL / LTR)
      const exitPadding = Math.max(
        fontSize * rendererLayout.exitPaddingScale,
        rendererLayout.exitPaddingMin
      );
      const baseOffset =
        dims.laneCount > 1 ? Math.round((placement.lane.index / (dims.laneCount - 1)) * 200) : 100;
      const jitter = Math.floor(Math.random() * 30);
      const entryOffset = baseOffset + jitter;

      const laneY = dims.height * this.settings.safeTop + placement.lane.index * dims.laneHeight;
      const laneSpanHeight = placement.laneSpan * dims.laneHeight;
      y = laneY + Math.max(0, (laneSpanHeight - estimated.height) / 2);

      const distance = dims.width + textWidth + exitPadding + entryOffset;
      duration = Math.max(2000, (distance / speed) * 1000);

      if (mode === 'reverse') {
        x = -(textWidth + exitPadding); // start off-screen left
      } else {
        x = dims.width + entryOffset; // start off-screen right (RTL)
      }

      this.laneAllocator.commitPlacement(
        placement,
        textWidth,
        estimated.height,
        now,
        now + duration
      );
    }

    const color = this.settings.colors[message.authorType];
    const kind = message.kind;
    const isSuperChat = kind === 'superchat' && !!message.superChat;
    const isMembership = kind === 'membership';
    const effectiveKind: CanvasMessage['kind'] = isSuperChat
      ? 'superchat'
      : isMembership
        ? 'membership'
        : 'text';

    // Load emoji images
    for (const seg of message.content) {
      if (seg.type === 'emoji' && !this.emojiCache.has(seg.emoji.url)) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = seg.emoji.url;
        img.onload = () => this.emojiCache.set(seg.emoji.url, img);
        this.emojiCache.set(seg.emoji.url, img);
      }
    }

    const msg: CanvasMessage = {
      text: displayText,
      x,
      y,
      width: textWidth,
      height: estimated.height,
      color,
      opacity: this.settings.opacity,
      startTime: now,
      duration,
      laneIndex: placement.lane.index,
      kind: effectiveKind,
      mode,
      content: message.content,
      authorName: author || undefined,
      isBacklog: message.isBacklog,
    };

    if (mode === 'top' || mode === 'bottom') {
      msg.fadeInEndTime = now + 400; // 400ms fade in
      msg.fadeOutStartTime = now + 3200; // fade out from 3.2s to 4s
    }

    if (isSuperChat && message.superChat) {
      msg.tierColor = message.superChat.headerBackgroundColor || message.superChat.backgroundColor;
      msg.amount = message.superChat.amount;
    }

    this.messages.push(msg);
    this.observability.onMessageRendered();
  }

  private startRenderLoop(): void {
    const loop = (): void => {
      if (this.isPaused) {
        this.animFrameId = requestAnimationFrame(loop);
        return;
      }
      this.render();
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  private render(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const now = performance.now();
    const font = this.getFont();
    ctx.font = font;

    const outlineEnabled = this.settings.outline.enabled;
    const outlineOpacity = this.settings.outline.opacity;
    const outlineWidth = this.settings.outline.widthPx;
    const maxAgeMs = 60000;
    const dims = this.dimensions;

    this.messages = this.messages.filter((msg) => {
      const elapsed = now - msg.startTime;
      if (elapsed >= msg.duration) return false;

      // ── Position update per mode ────────────────────────────────────
      if (msg.mode === 'top' || msg.mode === 'bottom') {
        // No horizontal movement — stays in place, fades
        const effectiveOpacity = this.computeFixedOpacity(elapsed, msg);
        ctx.save();
        ctx.globalAlpha = Math.min(1, Math.max(0, effectiveOpacity * msg.opacity));
        if (msg.kind === 'superchat') {
          this.drawSuperChat(ctx, msg, canvas);
        } else if (msg.kind === 'membership') {
          this.drawMembership(ctx, msg);
        } else {
          this.drawText(ctx, msg, outlineEnabled, outlineOpacity, outlineWidth);
        }
        ctx.restore();
      } else if (msg.mode === 'reverse') {
        // LTR scroll
        const progress = elapsed / msg.duration;
        const travelDistance = (dims?.width ?? canvas.width) + msg.width + 200;
        msg.x = -msg.width + progress * travelDistance;
        this.renderMessageContent(
          ctx,
          msg,
          canvas,
          elapsed,
          maxAgeMs,
          outlineEnabled,
          outlineOpacity,
          outlineWidth
        );
      } else {
        // RTL scroll (default)
        const progress = elapsed / msg.duration;
        msg.x = canvas.width + (msg.x - canvas.width) - progress * (canvas.width + msg.width + 100);
        this.renderMessageContent(
          ctx,
          msg,
          canvas,
          elapsed,
          maxAgeMs,
          outlineEnabled,
          outlineOpacity,
          outlineWidth
        );
      }

      return true;
    });

    this.observability.updateActiveMessages(this.messages.length);
    this.observability.updateLaneUtilization(
      this.messages.length / Math.max(1, this.laneAllocator.getLaneCount())
    );
  }

  /** Compute opacity for top/bottom fixed modes: fade in → hold → fade out. */
  private computeFixedOpacity(elapsed: number, msg: CanvasMessage): number {
    const fadeInEnd = msg.fadeInEndTime !== undefined ? msg.fadeInEndTime - msg.startTime : 400;
    const fadeOutStart =
      msg.fadeOutStartTime !== undefined ? msg.fadeOutStartTime - msg.startTime : 3200;
    const fadeOutEnd = msg.duration;

    if (elapsed < fadeInEnd) return elapsed / fadeInEnd; // 0→1
    if (elapsed < fadeOutStart) return 1; // hold
    return Math.max(0, 1 - (elapsed - fadeOutStart) / (fadeOutEnd - fadeOutStart)); // 1→0
  }

  private renderMessageContent(
    ctx: CanvasRenderingContext2D,
    msg: CanvasMessage,
    canvas: HTMLCanvasElement,
    elapsed: number,
    maxAgeMs: number,
    outlineEnabled: boolean,
    outlineOpacity: number,
    outlineWidth: number
  ): void {
    const ageRatio = elapsed / Math.max(msg.duration, maxAgeMs);
    const fadeFactor = Math.max(0, 1 - ageRatio);
    const effectiveOpacity = msg.opacity * fadeFactor;

    ctx.save();
    ctx.globalAlpha = effectiveOpacity;

    if (msg.kind === 'superchat') {
      this.drawSuperChat(ctx, msg, canvas);
    } else if (msg.kind === 'membership') {
      this.drawMembership(ctx, msg);
    } else {
      this.drawText(ctx, msg, outlineEnabled, outlineOpacity, outlineWidth);
    }

    ctx.restore();
  }

  private drawText(
    ctx: CanvasRenderingContext2D,
    msg: CanvasMessage,
    outlineEnabled: boolean,
    outlineOpacity: number,
    outlineWidth: number
  ): void {
    if (msg.content.length > 0) {
      this.drawRichContent(ctx, msg);
      return;
    }

    // Plain text: try off-screen pre-rendering
    if (outlineEnabled && outlineWidth > 0) {
      ctx.strokeStyle = `rgba(0, 0, 0, ${outlineOpacity})`;
      ctx.lineWidth = outlineWidth * 2;
      ctx.lineJoin = 'round';
      for (const [dx, dy] of OUTLINE_OFFSETS) {
        ctx.strokeText(msg.text, msg.x + dx, msg.y + dy);
      }
    }

    ctx.fillStyle = msg.color;
    ctx.fillText(msg.text, msg.x, msg.y);
  }

  /** Render content with emoji images using inline Image elements. */
  private drawRichContent(ctx: CanvasRenderingContext2D, msg: CanvasMessage): void {
    let cursorX = msg.x;
    const y = msg.y;
    const emojiSize = this.settings.fontSize * 1.2;
    ctx.textBaseline = 'top';

    for (const seg of msg.content) {
      if (seg.type === 'text') {
        ctx.fillStyle = msg.color;
        ctx.fillText(seg.content, cursorX, y);
        cursorX += this.measureTextCached(seg.content);
      } else if (seg.type === 'emoji') {
        const img = this.emojiCache.get(seg.emoji.url);
        if (img?.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, cursorX, y, emojiSize, emojiSize);
        } else {
          // Fallback: draw alt text
          const alt = seg.emoji.fallbackText || seg.emoji.alt || '[ ]';
          ctx.fillStyle = msg.color;
          ctx.fillText(alt, cursorX, y);
        }
        cursorX += emojiSize + 4;
      }
    }
  }

  private measureTextCached(text: string): number {
    const cached = this.textMeasureCache.get(text);
    if (cached !== undefined) return cached;
    const ctx = this.getOffscreenCtx();
    if (!ctx) return text.length * this.settings.fontSize * 0.6;
    ctx.font = this.getFont();
    const width = Math.ceil(ctx.measureText(text).width);
    this.textMeasureCache.set(text, width);
    return width;
  }

  private drawSuperChat(
    ctx: CanvasRenderingContext2D,
    msg: CanvasMessage,
    canvas: HTMLCanvasElement
  ): void {
    const padding = 10;
    const cardW = Math.max(240, Math.min(canvas.width * 0.6, msg.width + padding * 2));
    const cardH = msg.height + padding * 2;

    // Tier color
    const tierColor = msg.tierColor || '#1e88e5';
    const rgb = this.parseRgb(tierColor);

    // Background gradient
    const grad = ctx.createLinearGradient(msg.x, msg.y, msg.x, msg.y + cardH);
    grad.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.5)`);
    grad.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.35)`);

    // Card background
    ctx.fillStyle = grad;
    this.roundRect(ctx, msg.x, msg.y, cardW, cardH, 6);
    ctx.fill();

    // Border
    ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.6)`;
    ctx.lineWidth = 1;
    this.roundRect(ctx, msg.x, msg.y, cardW, cardH, 6);
    ctx.stroke();

    // Left accent
    ctx.fillStyle = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    ctx.fillRect(msg.x, msg.y, 4, cardH);

    // Amount badge
    if (msg.amount) {
      ctx.font = `bold ${this.settings.fontSize * 0.75}px system-ui, sans-serif`;
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 3;
      ctx.fillText(msg.amount, msg.x + 14, msg.y + padding);
    }

    // Text
    ctx.font = this.getFont();
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 3;
    ctx.fillText(
      msg.text,
      msg.x + 14,
      msg.y + padding + (msg.amount ? this.settings.fontSize * 0.85 + 6 : 0)
    );
  }

  private drawMembership(ctx: CanvasRenderingContext2D, msg: CanvasMessage): void {
    const padding = 12;
    const cardW = msg.width + padding * 2;
    const cardH = msg.height + padding * 2;

    // Green background
    ctx.fillStyle = 'rgba(76, 175, 80, 0.25)';
    this.roundRect(ctx, msg.x, msg.y - padding / 2, cardW, cardH, 8);
    ctx.fill();

    // Green border
    ctx.strokeStyle = 'rgba(76, 175, 80, 0.6)';
    ctx.lineWidth = 2;
    this.roundRect(ctx, msg.x, msg.y - padding / 2, cardW, cardH, 8);
    ctx.stroke();

    // Text
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4;
    ctx.fillStyle = msg.color;
    ctx.fillText(msg.text, msg.x + padding, msg.y);
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

  private parseRgb(color: string): { r: number; g: number; b: number } {
    const match = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (match) {
      const r = Number.parseInt(match[1] ?? '30', 16);
      const g = Number.parseInt(match[2] ?? '136', 16);
      const b = Number.parseInt(match[3] ?? '229', 16);
      return { r, g, b };
    }
    // Fallback: try rgb() format
    const rgbMatch = color.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
    if (rgbMatch) {
      return { r: Number(rgbMatch[1]), g: Number(rgbMatch[2]), b: Number(rgbMatch[3]) };
    }
    return { r: 30, g: 136, b: 229 }; // Default blue
  }

  pause(): void {
    this.isPaused = true;
    this.burstDetector.pause();
  }

  resume(): void {
    this.isPaused = false;
    this.burstDetector.resume();
  }

  get laneCount(): number {
    return this.laneAllocator.getLaneCount();
  }

  setBacklogSpeedMultiplier(_multiplier: number): void {
    // Canvas2D renderer uses fixed speed settings; backlog multiplier is a no-op.
  }

  trimBackgroundQueue(): void {
    // Canvas2D renderer has no background queue to trim.
  }

  pauseForVideo(): void {
    this.pause();
  }

  resumeForVideo(): void {
    this.resume();
  }

  onBacklogPauseChange: ((paused: boolean) => void) | null = null;

  updateSettings(settings: OverlaySettings, _options?: { resetState?: boolean }): void {
    this.settings = settings;
  }

  destroy(): void {
    this.isPaused = false;
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.overlayDimensionsUnsubscribe?.();
    this.overlayDimensionsUnsubscribe = null;
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.messages = [];
    this.burstDetector.destroy();
    this.observability.destroy();
    log.debug('Destroyed');
  }
}
