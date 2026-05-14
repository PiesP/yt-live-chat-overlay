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
}

// ── Renderer ─────────────────────────────────────────────────────────────────

export class Renderer extends RendererBase {
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
  private readonly textHeightCache = new Map<string, number>();

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

    const priority = Renderer.getMessagePriority(message);
    this.prefetchImages(message);

    if (this.pendingQueue.length >= rendererLayout.queueMaxSize) {
      const last = this.pendingQueue[this.pendingQueue.length - 1];
      if (last && priority <= Renderer.getMessagePriority(last)) {
        this.observability.onMessageDropped('queue_overflow');
        return;
      }
      this.pendingQueue.pop();
      this.observability.onMessageDropped('queue_overflow');
    }

    const insertIndex = this.pendingQueue.findIndex(
      (q) => Renderer.getMessagePriority(q) < priority
    );
    if (insertIndex === -1) {
      this.pendingQueue.push(message);
    } else {
      this.pendingQueue.splice(insertIndex, 0, message);
    }

    if (this.activeMessages.length < this.settings.maxConcurrentMessages) {
      this.updateBacklogPause();
      const next = this.pendingQueue.shift();
      if (next) this.enqueueMessage(next);
    }
  }

  trimBackgroundQueue(): void {
    if (this.pendingQueue.length <= rendererLayout.backgroundQueueMax) return;
    this.pendingQueue.sort((a, b) => {
      const prioA = Renderer.getMessagePriority(a);
      const prioB = Renderer.getMessagePriority(b);
      return prioB - prioA || a.timestamp - b.timestamp;
    });
    this.pendingQueue.length = rendererLayout.backgroundQueueMax;
  }

  /** BUG-1 fix: propagate _options to super */
  updateSettings(settings: OverlaySettings, options?: RendererUpdateOptions): void {
    super.updateSettings(settings, options);
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
        const travelDistance = canvas.width + msg.width + rendererLayout.exitPaddingMin;
        msg.x = msg.startX - progress * travelDistance;
      } else if (mode === 'reverse') {
        // BUG-4 fix: consistent exitPadding usage
        const travelDistance = canvas.width * 2 + rendererLayout.exitPaddingMin;
        msg.x = -msg.width + progress * travelDistance;
      }

      let opacity = this.settings.opacity;
      if (!isScrolling) {
        if (elapsed < Renderer.FADE_DURATION_MS) {
          opacity *= elapsed / Renderer.FADE_DURATION_MS;
        } else if (elapsed > msg.duration - Renderer.FADE_DURATION_MS) {
          opacity *= Math.max(0, (msg.duration - elapsed) / Renderer.FADE_DURATION_MS);
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

    for (let ri = toRemove.length - 1; ri >= 0; ri--) {
      const idx = toRemove[ri]!;
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
    if (this.isAntiBlockActive()) return;
    while (
      this.pendingQueue.length > 0 &&
      this.activeMessages.length < this.settings.maxConcurrentMessages
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
          ? Math.round(
              (placement.lane.index / (dims.laneCount - 1)) * rendererLayout.entryOffsetRangeMs
            )
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
      startX = -(msgWidth + rendererLayout.exitPaddingMin);
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

  // ── Dimension estimation (uses shared + canvas ctx) ──────────────────

  private estimateDimensions(message: ChatMessage): { width: number; height: number } {
    // Use shared estimation for regular/membership, canvas-specific for superchat
    if (message.kind !== 'superchat') {
      return sharedEstimateDimensions(
        message,
        this.settings.fontSize,
        this.settings.showAuthor[message.authorType],
        this.settings.fontWeight,
        this.settings.fontFamily
      );
    }
    const fontSize = this.settings.fontSize;
    const textWidth = this.measureContentWidth(message, fontSize);
    return {
      width: Math.max(
        rendererLayout.superchatMinWidth,
        Math.min(rendererLayout.superchatMaxWidth, textWidth + 24)
      ),
      height:
        Math.ceil(fontSize * 1.5) + 8 + this.measureTextHeight(fontSize) + rendererLayout.paddingV,
    };
  }

  private measureContentWidth(message: ChatMessage, fontSize: number): number {
    const ctx = this.ctx;
    if (!ctx) return message.text.length * fontSize * 0.6;
    const font = this.getFont(fontSize);

    let width = 0;
    if (message.content.length > 0) {
      for (const seg of message.content) {
        if (seg.type === 'text') {
          width += Math.ceil(this.measureTextWidthCached(seg.content, font));
        } else {
          width += Math.ceil(fontSize * rendererLayout.emojiSize) + 4;
        }
      }
    } else if (message.text) {
      width += Math.ceil(this.measureTextWidthCached(message.text, font));
    }
    return Math.ceil(width);
  }

  private measureTextWidthCached(text: string, font: string): number {
    const key = `${font}|${text}`;
    const cached = this.textWidthCache.get(key);
    if (cached !== undefined) return cached;
    const ctx = this.ctx;
    if (!ctx) return text.length * 8;
    ctx.font = font;
    const width = Math.ceil(ctx.measureText(text).width);
    if (this.textWidthCache.size >= 500) {
      const firstKey = this.textWidthCache.keys().next().value;
      if (firstKey) this.textWidthCache.delete(firstKey);
    }
    this.textWidthCache.set(key, width);
    return width;
  }

  private measureTextHeight(fontSize: number): number {
    const font = this.getFont(fontSize);
    const cached = this.textHeightCache.get(font);
    if (cached !== undefined) return cached;
    const ctx = this.ctx;
    if (!ctx) return Math.ceil(fontSize * 1.1);
    ctx.font = font;
    const metrics = ctx.measureText('Mg');
    const ascent = metrics.fontBoundingBoxAscent;
    const descent = metrics.fontBoundingBoxDescent;
    const height =
      ascent !== undefined && descent !== undefined && ascent > 0
        ? Math.ceil(ascent + descent)
        : Math.ceil(fontSize * 1.1);
    if (this.textHeightCache.size >= 50) {
      const firstKey = this.textHeightCache.keys().next().value;
      if (firstKey) this.textHeightCache.delete(firstKey);
    }
    this.textHeightCache.set(font, height);
    return height;
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
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = this.getFont(fontSize);
    ctx.textBaseline = 'top';

    const outline = this.settings.outline;
    if (outline.enabled && outline.widthPx > 0 && outline.opacity > 0) {
      const strokeWidth = Math.max(0.5, outline.widthPx * 0.85);
      ctx.strokeStyle = `rgba(0, 0, 0, ${Math.min(1, outline.opacity)})`;
      ctx.lineWidth = strokeWidth;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeText(text, x, y);
    }

    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  /** Draw crisp black outline on text using current font and textBaseline. */
  private strokeTextOutline(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number
  ): void {
    const outline = this.settings.outline;
    if (!outline.enabled || outline.widthPx <= 0 || outline.opacity <= 0) return;
    const strokeWidth = Math.max(0.5, outline.widthPx * 0.85);
    ctx.save();
    ctx.strokeStyle = `rgba(0, 0, 0, ${Math.min(1, outline.opacity)})`;
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
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
        ctx.drawImage(
          photo,
          textX,
          textY,
          rendererLayout.authorPhotoSize,
          rendererLayout.authorPhotoSize
        );
        ctx.restore();
      }
      const nameFont = getFontString(
        Math.round(fontSize * rendererLayout.authorFontScale),
        this.settings.fontWeight,
        this.settings.fontFamily
      );
      ctx.font = nameFont;
      ctx.textBaseline = 'top';
      this.strokeTextOutline(ctx, message.author, textX + (photo ? 28 : 0), textY + 6);
      ctx.fillStyle = color;
      ctx.fillText(message.author, textX + (photo ? 28 : 0), textY + 6);
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
    grad.addColorStop(0, Renderer.rgbaHex(baseColor, topAlpha));
    grad.addColorStop(0.48, Renderer.rgbaHex(baseColor, superChatAlpha));
    grad.addColorStop(1, Renderer.rgbaHex(baseColor, bottomAlpha));
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
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
        ctx.drawImage(
          photo,
          textX,
          contentY,
          rendererLayout.authorPhotoSize,
          rendererLayout.authorPhotoSize
        );
        ctx.restore();
      }
      ctx.font = getFontString(
        Math.round(fontSize * rendererLayout.authorFontScale),
        this.settings.fontWeight,
        this.settings.fontFamily
      );
      ctx.textBaseline = 'top';
      this.strokeTextOutline(ctx, msg.message.author, textX + (photo ? 28 : 0), contentY + 6);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(msg.message.author, textX + (photo ? 28 : 0), contentY + 6);
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
    this.strokeTextOutline(ctx, superChat.amount, textX + 12, badgeY + badgeHeight / 2);
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
      this.strokeTextOutline(ctx, msg.message.author, textX, textY);
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
    this.textHeightCache.clear();
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
