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

import type { ChatMessage, OverlayDimensions, OverlaySettings } from '@app-types';
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

  addMessage(message: ChatMessage): void {
    const dims = this.dimensions;
    if (!dims || !this.ctx) return;

    this.burstDetector.onMessageReceived();
    this.observability.onMessageReceived();
    const estimated = this.messageBuilder.estimateMessageDimensions(message);
    const text = message.author ? `${message.author}: ${message.text}` : message.text;

    const placement = this.laneAllocator.findPlacement(estimated.height, dims);
    if (!placement) {
      this.observability.onMessageDropped('no_lane_available');
      return;
    }

    const textWidth = estimated.width;
    const fontSize = this.settings.fontSize;
    const exitPadding = Math.max(
      fontSize * rendererLayout.exitPaddingScale,
      rendererLayout.exitPaddingMin
    );
    const distance = dims.width + textWidth + exitPadding;
    const speed = this.settings.speedPxPerSec;
    const duration = Math.max(2000, (distance / speed) * 1000);

    const laneY = dims.height * this.settings.safeTop + placement.lane.index * dims.laneHeight;
    const laneSpanHeight = placement.laneSpan * dims.laneHeight;
    const y = laneY + Math.max(0, (laneSpanHeight - estimated.height) / 2);

    const baseOffset =
      dims.laneCount > 1 ? Math.round((placement.lane.index / (dims.laneCount - 1)) * 200) : 100;
    const jitter = Math.floor(Math.random() * 30);
    const entryOffset = baseOffset + jitter;

    const now = performance.now();
    this.laneAllocator.commitPlacement(placement, textWidth, estimated.height, now, now + duration);

    const color = this.settings.colors[message.authorType];

    this.messages.push({
      text,
      x: dims.width + entryOffset,
      y,
      width: textWidth,
      height: estimated.height,
      color,
      opacity: this.settings.opacity,
      startTime: now,
      duration,
      laneIndex: placement.lane.index,
    });

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
    ctx.textBaseline = 'top';

    const outlineEnabled = this.settings.outline.enabled;
    const outlineOpacity = this.settings.outline.opacity;
    const outlineWidth = this.settings.outline.widthPx;

    this.messages = this.messages.filter((msg) => {
      const elapsed = now - msg.startTime;
      if (elapsed >= msg.duration) return false;

      const progress = elapsed / msg.duration;
      msg.x = canvas.width + (msg.x - canvas.width) - progress * (canvas.width + msg.width + 100);

      const ageRatio = elapsed / Math.max(msg.duration, 60000);
      const fadeFactor = Math.max(0, 1 - ageRatio);
      const effectiveOpacity = msg.opacity * fadeFactor;

      ctx.save();
      ctx.globalAlpha = effectiveOpacity;

      if (outlineEnabled && outlineWidth > 0) {
        ctx.strokeStyle = `rgba(0, 0, 0, ${outlineOpacity})`;
        ctx.lineWidth = outlineWidth * 2;
        ctx.lineJoin = 'round';
        for (const [dx, dy] of OUTLINE_OFFSETS) {
          ctx.strokeText(msg.text, msg.x + dx, msg.y + dy);
        }
      }

      ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
      ctx.shadowBlur = 4;
      ctx.fillStyle = msg.color;
      ctx.fillText(msg.text, msg.x, msg.y);
      ctx.restore();

      return true;
    });

    this.observability.updateActiveMessages(this.messages.length);
    this.observability.updateLaneUtilization(
      this.messages.length / Math.max(1, this.laneAllocator.getLaneCount())
    );
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
