/**
 * Canvas2DRenderer
 *
 * Canvas 2D-based renderer that uses requestAnimationFrame instead of CSS
 * @keyframes animations.  Each frame computes positions with Math.floor() to
 * snap to integer pixel coordinates, eliminating the sub-pixel text jitter
 * inherent in CSS transform interpolation.
 *
 * Extends RendererBase for shared state machine, rate limiting, burst
 * detection, and lane allocation.
 */

import type { ChatMessage, ContentSegment, OverlaySettings } from '@app-types';
import {
  computeDliosDuration,
  colors as designColors,
  parseRgbColor,
  rendererLayout,
} from '@core/design-tokens';
import { createLogger } from '@core/logging';
import type { Overlay } from '@core/overlay';
import { RendererBase } from '@core/renderer-base';

const log = createLogger('Canvas2DRenderer');

// ── Types ──────────────────────────────────────────────────────────────────

export interface Canvas2DRendererUpdateOptions {
  resetState?: boolean;
}

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
}

// ── Renderer ───────────────────────────────────────────────────────────────

export class Canvas2DRenderer extends RendererBase {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private animFrameId: number | null = null;
  private overlayDimensionsUnsubscribe: (() => void) | null = null;

  private readonly activeMessages: CanvasMessage[] = [];
  private readonly pendingQueue: ChatMessage[] = [];

  /** Emoji image cache: url → HTMLImageElement (bounded LRU, max 200 entries) */
  private readonly emojiCache = new Map<string, HTMLImageElement>();
  private static readonly EMOJI_CACHE_MAX = 200;
  private readonly emojiFetching = new Set<string>();
  private static readonly EMOJI_MAX_CONCURRENT = 6;
  private readonly authorPhotoCache = new Map<string, HTMLImageElement>();
  private readonly stickerCache = new Map<string, HTMLImageElement>();

  private static readonly MAX_ACTIVE = 50;
  private static readonly FADE_DURATION_MS = 500;
  private static readonly EXIT_PADDING = 100;

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
    if (dims && this.canvas) {
      this.canvas.width = dims.width;
      this.canvas.height = dims.height;
    }

    this.overlayDimensionsUnsubscribe = overlay.onDimensionsChanged((d) => {
      if (d && this.canvas) {
        this.canvas.width = d.width;
        this.canvas.height = d.height;
        this.laneAllocator.reset(d);
      }
    });

    this.startRenderLoop();
    log.info('Canvas2DRenderer created');
  }

  get laneCount(): number {
    return this.laneAllocator.getLaneCount();
  }

  // ── Message ingress ──────────────────────────────────────────────────

  addMessage(message: ChatMessage): void {
    if (!this.isMessageAllowed(message)) return;

    const priority = Canvas2DRenderer.getMessagePriority(message);
    this.prefetchImages(message);

    if (this.pendingQueue.length >= 50) {
      const last = this.pendingQueue[this.pendingQueue.length - 1];
      if (last && priority <= Canvas2DRenderer.getMessagePriority(last)) {
        this.observability.onMessageDropped('queue_overflow');
        return;
      }
      this.pendingQueue.pop();
      this.observability.onMessageDropped('queue_overflow');
    }

    const insertIndex = this.pendingQueue.findIndex(
      (q) => Canvas2DRenderer.getMessagePriority(q) < priority
    );
    if (insertIndex === -1) {
      this.pendingQueue.push(message);
    } else {
      this.pendingQueue.splice(insertIndex, 0, message);
    }

    if (this.activeMessages.length < Canvas2DRenderer.MAX_ACTIVE) {
      this.updateBacklogPause();
      const next = this.pendingQueue.shift();
      if (next) this.enqueueMessage(next);
    }
  }

  trimBackgroundQueue(): void {
    if (this.pendingQueue.length <= 10) return;
    this.pendingQueue.sort((a, b) => {
      const prioA = Canvas2DRenderer.getMessagePriority(a);
      const prioB = Canvas2DRenderer.getMessagePriority(b);
      return prioB - prioA || a.timestamp - b.timestamp;
    });
    this.pendingQueue.length = 10;
  }

  updateSettings(settings: OverlaySettings, _options?: Canvas2DRendererUpdateOptions): void {
    super.updateSettings(settings);
  }

  // ── Image pre-fetching ───────────────────────────────────────────────

  private prefetchImages(message: ChatMessage): void {
    for (const seg of message.content) {
      if (seg.type !== 'emoji') continue;
      if (this.emojiCache.has(seg.emoji.url)) continue;
      if (this.emojiFetching.has(seg.emoji.url)) continue;
      if (this.emojiFetching.size >= Canvas2DRenderer.EMOJI_MAX_CONCURRENT) continue;

      this.emojiFetching.add(seg.emoji.url);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = seg.emoji.url;
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
      };
    }

    const photoUrl = message.authorPhotoUrl;
    if (photoUrl && !this.authorPhotoCache.has(photoUrl)) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = photoUrl;
      img.onload = () => this.authorPhotoCache.set(photoUrl, img);
      img.onerror = () => this.authorPhotoCache.set(photoUrl, img);
    }

    const sticker = message.superChat?.sticker;
    const stickerUrl = sticker?.url;
    if (stickerUrl && !this.stickerCache.has(stickerUrl)) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = stickerUrl;
      img.onload = () => this.stickerCache.set(stickerUrl, img);
      img.onerror = () => this.stickerCache.set(stickerUrl, img);
      this.stickerCache.set(stickerUrl, img);
    }
  }

  // ── Render loop ──────────────────────────────────────────────────────

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

  private renderFrame(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    if (this.isPaused) return;
    if (this.isVideoPaused) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const now = performance.now();
    const dims = this.overlay.getDimensions();
    if (!dims) return;

    const mode = this.settings.danmakuMode;
    const isScrolling = mode === 'scroll' || mode === 'reverse';

    this.drainQueue();

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
        const travelDistance = canvas.width + msg.width + Canvas2DRenderer.EXIT_PADDING;
        msg.x = msg.startX - progress * travelDistance;
      } else if (mode === 'reverse') {
        const travelDistance = canvas.width * 2 + Canvas2DRenderer.EXIT_PADDING;
        msg.x = -msg.width + progress * travelDistance;
      }

      let opacity = this.settings.opacity;
      if (!isScrolling) {
        if (elapsed < Canvas2DRenderer.FADE_DURATION_MS) {
          opacity *= elapsed / Canvas2DRenderer.FADE_DURATION_MS;
        } else if (elapsed > msg.duration - Canvas2DRenderer.FADE_DURATION_MS) {
          opacity *= Math.max(0, (msg.duration - elapsed) / Canvas2DRenderer.FADE_DURATION_MS);
        }
      }
      if (msg.message.isBacklog) opacity *= 0.5;

      const maxAgeMs = 60_000;
      const ageRatio = Math.min(1, elapsed / maxAgeMs);
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

  // ── Queue drain ──────────────────────────────────────────────────────

  private drainQueue(): void {
    while (
      this.pendingQueue.length > 0 &&
      this.activeMessages.length < Canvas2DRenderer.MAX_ACTIVE
    ) {
      const msg = this.pendingQueue.shift();
      if (msg) this.enqueueMessage(msg);
    }
  }

  // ── Message enqueue ──────────────────────────────────────────────────

  private enqueueMessage(message: ChatMessage): void {
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
    const speed = message.isBacklog
      ? this.getEffectiveBacklogSpeed()
      : this.getEffectiveSpeedPxPerSec();

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

  // ── Dimension estimation ─────────────────────────────────────────────

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
          width += Math.ceil(fontSize * rendererLayout.emojiSize) + 4;
        }
      }
    } else if (message.text) {
      width += Math.ceil(ctx.measureText(message.text).width);
    }
    return Math.ceil(width);
  }

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

  private getFont(fontSize: number): string {
    return `bold ${fontSize}px system-ui, -apple-system, sans-serif`;
  }

  // ── Backlog pause ────────────────────────────────────────────────────

  private updateBacklogPause(): void {
    const queueRatio = this.pendingQueue.length / Canvas2DRenderer.MAX_ACTIVE;
    if (queueRatio > 0.8 && this.backlogPaused === false) {
      this.backlogPaused = true;
      this.onBacklogPauseChange?.(true);
    } else if (queueRatio < 0.4 && this.backlogPaused === true) {
      this.backlogPaused = false;
      this.onBacklogPauseChange?.(false);
    }
  }

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
    ctx.globalAlpha = alpha;
    ctx.font = this.getFont(fontSize);
    ctx.textBaseline = 'top';

    const outline = this.settings.outline;
    if (outline.enabled && outline.widthPx > 0 && outline.opacity > 0) {
      const strokeWidth = Math.max(0.2, outline.widthPx * 0.3);
      const strokeOpacity = Math.min(1, outline.opacity * 0.7);
      ctx.strokeStyle = `rgba(0, 0, 0, ${strokeOpacity})`;
      ctx.lineWidth = strokeWidth;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, x, y);

      ctx.shadowColor = `rgba(0, 0, 0, ${Math.min(1, outline.opacity * 0.85)})`;
      ctx.shadowBlur = Math.max(1, outline.blurPx * 1.5);
    }

    ctx.fillStyle = color;
    ctx.fillText(text, x, y);

    if (outline.enabled && outline.widthPx > 0 && outline.opacity > 0) {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }
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
        cursorX += Math.ceil(ctx.measureText(seg.content).width);
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
    const color = this.settings.colors[message.authorType];

    ctx.globalAlpha = alpha * 0.25;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    this.roundRect(ctx, x, y, msg.width, msg.height, 6);
    ctx.fill();
    ctx.globalAlpha = alpha;

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

    const superChatAlpha = Math.min(1, Math.max(0.4, this.settings.superChatOpacity));
    const topAlpha = Math.min(1, superChatAlpha + 0.06);
    const bottomAlpha = Math.max(0.4, superChatAlpha - 0.08);

    const sourceColor = superChat.headerBackgroundColor || superChat.backgroundColor;
    const parsed = sourceColor ? parseRgbColor(sourceColor) : null;
    const rgb = parsed ?? designColors.superChat[superChat.tier];
    const baseColor = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;

    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, Canvas2DRenderer.rgbaHex(baseColor, topAlpha));
    grad.addColorStop(0.48, Canvas2DRenderer.rgbaHex(baseColor, superChatAlpha));
    grad.addColorStop(1, Canvas2DRenderer.rgbaHex(baseColor, bottomAlpha));
    ctx.fillStyle = grad;
    this.roundRect(ctx, x, y, w, h, 6);
    ctx.fill();

    ctx.fillStyle = baseColor;
    ctx.fillRect(x, y, 4, h);

    const textX = x + 12;
    let contentY = y + 8;

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

    const badgeY = contentY;
    ctx.font = `bold ${Math.round(fontSize * 0.85)}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(superChat.amount, textX, badgeY);

    if (message.text) {
      const msgY = badgeY + Math.round(fontSize * 1.1) + 6;
      this.renderSegment(ctx, message.text, textX, msgY, '#ffffff', alpha, fontSize);
    }

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

    ctx.strokeStyle = 'rgba(15, 157, 88, 0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();

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

  // ── Helpers ──────────────────────────────────────────────────────────

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
    this.drainQueue();
  }

  onPlaybackRateChange(_rate: number): void {
    // Canvas2D computes rate on each frame via getEffectiveSpeed().
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
  }
}
