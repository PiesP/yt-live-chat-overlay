/**
 * Canvas2D Renderer
 *
 * Renders chat messages as scrolling comments on a <canvas> element.
 * Shares LaneAllocator with the CSS Renderer for consistent placement.
 * Uses RendererMessageBuilder for dimension estimation.
 *
 * ── Performance features ───────────────────────────────────────────────
 * - Off-screen bitmap caching: text pre-rendered once, blitted each frame
 * - Minimal save/restore: globalAlpha set directly per message
 * - Depth-batched rendering: SuperChat/membership first, text second
 * - Density-based adaptation: tightens spacing at high message rates
 *   instead of increasing scroll speed (keeps comments readable)
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
const OUTLINE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];
const MAX_AGE_MS = 60_000;
const PREVIEW_BITMAP_SIZE = 2048;

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
  kind: 'text' | 'superchat' | 'membership';
  mode: DanmakuMode;
  fadeInEndTime?: number;
  fadeOutStartTime?: number;
  tierColor?: string | undefined;
  amount?: string | undefined;
  content: ContentSegment[];
  isBacklog?: boolean | undefined;
  /** Accumulated time (ms) the message spent paused while tab was hidden. */
  pausedDuration: number;
  /** Pre-rendered bitmap for this message text (null for rich-content messages). */
  bitmap: HTMLCanvasElement | null;
  /** True when the bitmap has been rendered at least once. */
  bitmapReady: boolean;
}

/** Density multiplier per burst level — tighter spacing = higher density. */
const BURST_DENSITY: Record<string, number> = {
  normal: 1.0,
  elevated: 0.85,
  high: 0.7,
  extreme: 0.55,
};

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
  /** Timestamp when pause started, for accumulating pausedDuration across messages (null when not paused). */
  private pausedAt: number | null = null;
  private burstDetector: BurstDetector;
  private dimensions: OverlayDimensions | null = null;
  private overlayDimensionsUnsubscribe: (() => void) | null = null;
  private emojiCache = new Map<string, HTMLImageElement>();
  private textMeasureCache = new Map<string, number>();
  private measureCtx: CanvasRenderingContext2D | null = null;

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
    this.initMeasureCanvas();

    this.overlayDimensionsUnsubscribe = overlay.onDimensionsChanged((dimensions) => {
      if (dimensions) {
        this.dimensions = dimensions;
        this.laneAllocator.reset(dimensions);
        const cnv = this.canvas;
        if (cnv) {
          cnv.width = dimensions.width;
          cnv.height = dimensions.height;
        }
      }
    });
  }

  private initMeasureCanvas(): void {
    const canvas = document.createElement('canvas');
    canvas.width = PREVIEW_BITMAP_SIZE;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      this.measureCtx = ctx;
    }
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

  /** Density-based gap multiplier: tighter at high burst levels, keeps speed constant. */
  private getDensityMultiplier(): number {
    return BURST_DENSITY[this.burstDetector.getLevel()] ?? 1.0;
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
    const densityMul = this.getDensityMultiplier();

    let x: number;
    let y: number;
    let duration: number;

    if (mode === 'top' || mode === 'bottom') {
      const xRange = Math.max(1, dims.width - textWidth);
      x = Math.random() * xRange;
      y =
        mode === 'top'
          ? dims.height * this.settings.safeTop
          : dims.height * (1 - this.settings.safeBottom) - estimated.height;
      duration = 4000;
      this.laneAllocator.commitPlacement(
        placement,
        textWidth,
        estimated.height,
        now,
        now + duration
      );
    } else {
      const exitPadding = Math.max(
        fontSize * rendererLayout.exitPaddingScale * densityMul,
        rendererLayout.exitPaddingMin * densityMul
      );
      const baseOffset =
        dims.laneCount > 1 ? Math.round((placement.lane.index / (dims.laneCount - 1)) * 200) : 100;
      const jitter = Math.floor(Math.random() * 30);
      const entryOffset = baseOffset + jitter;

      const laneY = dims.height * this.settings.safeTop + placement.lane.index * dims.laneHeight;
      const laneSpanHeight = placement.laneSpan * dims.laneHeight;
      y = laneY + Math.max(0, (laneSpanHeight - estimated.height) / 2);

      duration = Math.max(2000, (dims.width / speed) * 1000);

      x = mode === 'reverse' ? -(textWidth + exitPadding) : dims.width + entryOffset;

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

    // Eager-load emoji images
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
      kind: effectiveKind,
      mode,
      content: message.content,
      isBacklog: message.isBacklog,
      pausedDuration: 0,
      bitmap: null,
      bitmapReady: false,
    };

    if (mode === 'top' || mode === 'bottom') {
      msg.fadeInEndTime = now + 400;
      msg.fadeOutStartTime = now + 3200;
    }

    if (isSuperChat && message.superChat) {
      msg.tierColor = message.superChat.headerBackgroundColor || message.superChat.backgroundColor;
      msg.amount = message.superChat.amount;
    }

    this.messages.push(msg);
    this.observability.onMessageRendered();
  }

  // ── Render loop ───────────────────────────────────────────────────────

  private startRenderLoop(): void {
    const loop = (): void => {
      this.animFrameId = requestAnimationFrame(
        this.isPaused
          ? loop
          : () => {
              this.render();
              this.animFrameId = requestAnimationFrame(loop);
            }
      );
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
    const dims = this.dimensions;
    const canvasW = canvas.width;

    // Phase 1: update positions, build depth-sorted render list
    const cards: Array<{ msg: CanvasMessage; elapsed: number; opacity: number }> = [];
    const texts: Array<{ msg: CanvasMessage; elapsed: number; opacity: number }> = [];

    this.messages = this.messages.filter((msg) => {
      const elapsed = now - msg.startTime - msg.pausedDuration;
      if (elapsed >= msg.duration) return false;

      let renderOpacity: number;

      if (msg.mode === 'top' || msg.mode === 'bottom') {
        renderOpacity = this.computeFixedOpacity(elapsed, msg) * msg.opacity;
        // No position update needed — stays in place
      } else if (msg.mode === 'reverse') {
        const progress = elapsed / msg.duration;
        const travelDistance = (dims?.width ?? canvasW) + msg.width + 200;
        msg.x = -msg.width + progress * travelDistance;
        renderOpacity = msg.opacity * Math.max(0, 1 - elapsed / Math.max(msg.duration, MAX_AGE_MS));
      } else {
        const progress = elapsed / msg.duration;
        msg.x = canvasW + (msg.x - canvasW) - progress * (canvasW + msg.width + 100);
        renderOpacity = msg.opacity * Math.max(0, 1 - elapsed / Math.max(msg.duration, MAX_AGE_MS));
      }

      const entry = { msg, elapsed, opacity: renderOpacity };
      if (msg.kind === 'superchat' || msg.kind === 'membership') {
        cards.push(entry);
      } else {
        texts.push(entry);
      }

      return true;
    });

    // Phase 2: depth-ordered rendering (cards behind text)
    // Batch by type to minimize context state changes
    ctx.textBaseline = 'top';
    for (const entry of cards)
      this.drawEntry(ctx, entry, canvas, font, outlineEnabled, outlineOpacity, outlineWidth);
    for (const entry of texts)
      this.drawEntry(ctx, entry, canvas, font, outlineEnabled, outlineOpacity, outlineWidth);

    this.observability.updateActiveMessages(this.messages.length);
    this.observability.updateLaneUtilization(
      this.messages.length / Math.max(1, this.laneAllocator.getLaneCount())
    );
  }

  private drawEntry(
    ctx: CanvasRenderingContext2D,
    entry: { msg: CanvasMessage; opacity: number },
    canvas: HTMLCanvasElement,
    font: string,
    outlineEnabled: boolean,
    outlineOpacity: number,
    outlineWidth: number
  ): void {
    const { msg, opacity } = entry;
    ctx.globalAlpha = opacity;

    if (msg.kind === 'superchat') {
      this.drawSuperChat(ctx, msg, canvas);
    } else if (msg.kind === 'membership') {
      this.drawMembership(ctx, msg);
    } else {
      this.drawTextBitmap(ctx, msg, font, outlineEnabled, outlineOpacity, outlineWidth);
    }
  }

  // ── Bitmap-cached text rendering ──────────────────────────────────────

  /** Pre-render text to a bitmap canvas once, then blit each frame. */
  private ensureBitmap(
    msg: CanvasMessage,
    font: string,
    outlineEnabled: boolean,
    outlineOpacity: number,
    outlineWidth: number
  ): HTMLCanvasElement | null {
    if (msg.bitmapReady && msg.bitmap) return msg.bitmap;
    if (msg.content.length > 0) return null; // rich content: no bitmap caching

    const w = Math.ceil(msg.width);
    const h = Math.ceil(msg.height);
    if (w < 1 || h < 1) return null;

    const bmp = document.createElement('canvas');
    bmp.width = w;
    bmp.height = h;
    const bCtx = bmp.getContext('2d');
    if (!bCtx) return null;

    bCtx.font = font;
    bCtx.textBaseline = 'top';

    if (outlineEnabled && outlineWidth > 0) {
      bCtx.strokeStyle = `rgba(0, 0, 0, ${outlineOpacity})`;
      bCtx.lineWidth = outlineWidth * 2;
      bCtx.lineJoin = 'round';
      for (const [dx, dy] of OUTLINE_OFFSETS) {
        bCtx.strokeText(msg.text, dx, dy);
      }
    }

    bCtx.fillStyle = msg.color;
    bCtx.fillText(msg.text, 0, 0);

    msg.bitmap = bmp;
    msg.bitmapReady = true;
    return bmp;
  }

  private drawTextBitmap(
    ctx: CanvasRenderingContext2D,
    msg: CanvasMessage,
    font: string,
    outlineEnabled: boolean,
    outlineOpacity: number,
    outlineWidth: number
  ): void {
    // Rich content: render directly (text + emoji, can't precache easily)
    if (msg.content.length > 0) {
      this.drawRichContent(ctx, msg);
      return;
    }

    // Bitmap-cached path: pre-render once, blit each frame
    const bmp = this.ensureBitmap(msg, font, outlineEnabled, outlineOpacity, outlineWidth);
    if (bmp) {
      ctx.drawImage(bmp, msg.x, msg.y);
    } else {
      // Fallback direct rendering (e.g. bitmap creation failed)
      ctx.fillStyle = msg.color;
      ctx.fillText(msg.text, msg.x, msg.y);
    }
  }

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
      } else {
        const img = this.emojiCache.get(seg.emoji.url);
        if (img?.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, cursorX, y, emojiSize, emojiSize);
        } else {
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
    const mc = this.measureCtx;
    if (!mc) return text.length * this.settings.fontSize * 0.6;
    mc.font = this.getFont();
    const width = Math.ceil(mc.measureText(text).width);
    this.textMeasureCache.set(text, width);
    return width;
  }

  // ── Fixed-mode opacity ────────────────────────────────────────────────

  private computeFixedOpacity(elapsed: number, msg: CanvasMessage): number {
    const fadeInEnd = msg.fadeInEndTime !== undefined ? msg.fadeInEndTime - msg.startTime : 400;
    const fadeOutStart =
      msg.fadeOutStartTime !== undefined ? msg.fadeOutStartTime - msg.startTime : 3200;
    const fadeOutEnd = msg.duration;
    if (elapsed < fadeInEnd) return elapsed / fadeInEnd;
    if (elapsed < fadeOutStart) return 1;
    return Math.max(0, 1 - (elapsed - fadeOutStart) / (fadeOutEnd - fadeOutStart));
  }

  // ── Super Chat card (gradient + tier color) ───────────────────────────

  private drawSuperChat(
    ctx: CanvasRenderingContext2D,
    msg: CanvasMessage,
    canvas: HTMLCanvasElement
  ): void {
    const padding = 10;
    const cardW = Math.max(240, Math.min(canvas.width * 0.6, msg.width + padding * 2));
    const cardH = msg.height + padding * 2;
    const tierColor = msg.tierColor || '#1e88e5';
    const rgb = this.parseRgb(tierColor);

    const grad = ctx.createLinearGradient(msg.x, msg.y, msg.x, msg.y + cardH);
    grad.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.5)`);
    grad.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.35)`);

    this.roundRect(ctx, msg.x, msg.y, cardW, cardH, 6);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.6)`;
    ctx.lineWidth = 1;
    this.roundRect(ctx, msg.x, msg.y, cardW, cardH, 6);
    ctx.stroke();

    ctx.fillStyle = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    ctx.fillRect(msg.x, msg.y, 4, cardH);

    if (msg.amount) {
      ctx.font = `bold ${this.settings.fontSize * 0.75}px system-ui, sans-serif`;
      ctx.fillStyle = '#fff';
      ctx.fillText(msg.amount, msg.x + 14, msg.y + padding);
    }

    ctx.font = this.getFont();
    ctx.fillStyle = '#fff';
    ctx.fillText(
      msg.text,
      msg.x + 14,
      msg.y + padding + (msg.amount ? this.settings.fontSize * 0.85 + 6 : 0)
    );
  }

  // ── Membership card (green border) ────────────────────────────────────

  private drawMembership(ctx: CanvasRenderingContext2D, msg: CanvasMessage): void {
    const padding = 12;
    const cardW = msg.width + padding * 2;
    const cardH = msg.height + padding * 2;

    ctx.fillStyle = 'rgba(76, 175, 80, 0.25)';
    this.roundRect(ctx, msg.x, msg.y - padding / 2, cardW, cardH, 8);
    ctx.fill();

    ctx.strokeStyle = 'rgba(76, 175, 80, 0.6)';
    ctx.lineWidth = 2;
    this.roundRect(ctx, msg.x, msg.y - padding / 2, cardW, cardH, 8);
    ctx.stroke();

    ctx.fillStyle = msg.color;
    ctx.fillText(msg.text, msg.x + padding, msg.y);
  }

  // ── Geometry helpers ──────────────────────────────────────────────────

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
      return {
        r: Number.parseInt(match[1] ?? '30', 16),
        g: Number.parseInt(match[2] ?? '136', 16),
        b: Number.parseInt(match[3] ?? '229', 16),
      };
    }
    const rgbMatch = color.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
    if (rgbMatch) {
      return { r: Number(rgbMatch[1]), g: Number(rgbMatch[2]), b: Number(rgbMatch[3]) };
    }
    return { r: 30, g: 136, b: 229 };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  pause(): void {
    this.isPaused = true;
    this.pausedAt = performance.now();
    this.burstDetector.pause();
  }
  resume(): void {
    if (this.pausedAt !== null) {
      const pauseDuration = performance.now() - this.pausedAt;
      // Accumulate pause time across all active messages so elapsed
      // calculation in render() excludes time spent paused.
      // Messages created during pause also receive the offset so they
      // behave as if created at resume time (elapsed starts near 0).
      for (const msg of this.messages) {
        msg.pausedDuration += pauseDuration;
      }
      this.pausedAt = null;
    }
    this.isPaused = false;
    this.burstDetector.resume();
  }
  pauseForVideo(): void {
    this.pause();
  }
  resumeForVideo(): void {
    this.resume();
  }

  get laneCount(): number {
    return this.laneAllocator.getLaneCount();
  }

  setBacklogSpeedMultiplier(_multiplier: number): void {}
  trimBackgroundQueue(): void {}
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
    this.emojiCache.clear();
    this.textMeasureCache.clear();
    this.burstDetector.destroy();
    this.observability.destroy();
    log.debug('Destroyed');
  }
}
