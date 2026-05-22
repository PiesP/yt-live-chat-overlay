/**
 * RendererBase
 *
 * Shared logic for the Canvas2D renderer.
 * Subclasses implement the rendering-specific abstract methods.
 *
 * Two-layer pause state machine:
 * - isPaused: tab-visibility pause (document.hidden). Pauses animations
 *   and stops the render loop. Paused duration is accumulated so
 *   animations resume from the correct position.
 * - isVideoPaused: video-level pause (video.paused). Drops incoming
 *   messages during pause to prevent queue overflow. Both render loop
 *   and message ingress check this flag.
 */

import type { ChatMessage, OverlaySettings } from '@app-types';
import { PerAuthorRateLimiter } from '@core/author-rate-limiter';
import { BurstDetector } from '@core/burst-detector';
import { rendererLayout } from '@core/design-tokens';
import { LaneAllocator } from '@core/lane-allocator';
import { createLogger } from '@core/logging';
import { ObservabilityReporter } from '@core/observability';
import type { Overlay } from '@core/overlay';

const log = createLogger('RendererBase');

interface RendererUpdateOptions {
  resetState?: boolean;
}

export abstract class RendererBase {
  readonly observability: ObservabilityReporter;
  onBacklogPauseChange: ((paused: boolean) => void) | null = null;

  protected overlay: Overlay;
  protected settings: OverlaySettings;
  protected laneAllocator: LaneAllocator;
  protected burstDetector: BurstDetector;
  protected authorRateLimiter: PerAuthorRateLimiter;

  protected isPaused = false;
  protected isVideoPaused = false;
  protected pausedAt: number | null = null;
  protected backlogSpeedMultiplier = 1;
  protected backlogPaused = false;

  constructor(overlay: Overlay, settings: OverlaySettings) {
    this.overlay = overlay;
    this.settings = settings;
    this.observability = new ObservabilityReporter(settings.showDebugOverlay);

    this.laneAllocator = new LaneAllocator({
      safeTop: this.settings.safeTop,
      safeBottom: this.settings.safeBottom,
      fontSize: this.settings.fontSize,
      fontWeight: this.settings.fontWeight,
      fontFamily: this.settings.fontFamily,
      laneSpacing: this.settings.laneSpacing,
    });
    this.laneAllocator.reset(this.overlay.getDimensions());

    this.burstDetector = new BurstDetector(this.observability);
    this.burstDetector.start();

    this.authorRateLimiter = new PerAuthorRateLimiter(() => this.burstDetector.getLevel());
    this.authorRateLimiter.updateConfig({
      preset: settings.authorRateLimit,
    });
  }

  // ── Shared state machine ──────────────────────────────────────────────

  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
    this.pausedAt = performance.now();
    this.burstDetector.pause();
    this.onPause();
    log.debug('Paused');
  }

  resume(): void {
    if (!this.isPaused) return;

    const now = performance.now();
    let pausedDuration = 0;
    if (this.pausedAt !== null) {
      pausedDuration = Math.min(Math.max(0, now - this.pausedAt), rendererLayout.maxMessageAgeMs);
      this.applyPausedDuration(pausedDuration);
    }
    this.pausedAt = null;
    this.burstDetector.resume();

    // BUG-4 fix: only shift lane timers if the video is actually playing.
    // When isVideoPaused is true, the tab was hidden while the video was
    // paused — shifting lanes would advance availability past the pause,
    // causing messages to disappear prematurely when the video resumes.
    if (!this.isVideoPaused) {
      this.laneAllocator.shiftAll(pausedDuration);
    }
    this.isPaused = false;

    if (this.isVideoPaused) {
      return;
    }

    this.onResume();
    log.debug('Resumed');
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

  setBacklogSpeedMultiplier(multiplier: number): void {
    this.backlogSpeedMultiplier = Math.max(1, multiplier);
  }

  updateSettings(settings: OverlaySettings, options: RendererUpdateOptions = {}): void {
    this.settings = settings;
    this.observability.setShowDebug(settings.showDebugOverlay);
    this.authorRateLimiter.updateConfig({
      preset: settings.authorRateLimit,
    });

    // Propagate safe-zone changes to lane allocator even without full reset.
    // This ensures new lane placements use the correct Y positions immediately.
    this.laneAllocator.updateSafeZone(settings.safeTop, settings.safeBottom);

    if (options.resetState) {
      this.resetState();
      this.laneAllocator.reset(this.overlay.getDimensions());
      return;
    }

    if (this.laneAllocator.isEmpty()) {
      this.laneAllocator.reset(this.overlay.getDimensions());
    }
  }

  // ── Shared helpers ────────────────────────────────────────────────────

  protected getEffectiveSpeedPxPerSec(): number {
    let speed = this.settings.speedPxPerSec;

    const emaRate = this.burstDetector.getEmaRate();
    if (emaRate > 5) {
      const emaMultiplier = 1 + Math.min((emaRate - 5) / 15, 0.35);
      speed *= emaMultiplier;
    }

    const burstLevel = this.burstDetector.getLevel();
    speed *= rendererLayout.burstSpeedMultiplier[burstLevel];

    return Math.max(1, speed);
  }

  protected isMessageAllowed(message: ChatMessage): boolean {
    // Count every incoming message regardless of outcome for accurate
    // drop-rate accounting. Previously onVideoPaused drops skipped
    // onMessageReceived(), freezing the denominator and inflating the ratio.
    this.observability.onMessageReceived();

    if (this.isVideoPaused) {
      this.observability.onMessageDropped('video_paused');
      return false;
    }
    this.burstDetector.onMessageReceived();

    const priority = RendererBase.getMessagePriority(message);
    if (!this.authorRateLimiter.allow(message.author ?? 'anonymous', priority)) {
      log.debug('Drop [rate_limited]:', message.author, message.kind, message.id);
      this.observability.onMessageDropped('rate_limited');
      return false;
    }
    return true;
  }

  /** Check whether anti-block is currently throttling new messages. */
  protected isAntiBlockActive(): boolean {
    const ANTI_BLOCK_FREE_RATIO = 0.05;
    const utilization = this.laneAllocator.getUtilization();
    const threshold = 1 - ANTI_BLOCK_FREE_RATIO;
    return utilization >= threshold;
  }

  protected static getMessagePriority(message: ChatMessage): number {
    let priority = rendererLayout.kindPriority[message.kind];
    if (message.isBacklog) priority -= 50;
    return priority;
  }

  destroy(): void {
    this.isPaused = false;
    this.isVideoPaused = false;
    this.burstDetector.destroy();
    this.authorRateLimiter.destroy();
    this.observability.destroy();
    this.onDestroy();
    log.debug('Destroyed');
  }

  // ── Abstract hooks for subclasses ─────────────────────────────────────

  abstract addMessage(message: ChatMessage): void;
  abstract get laneCount(): number;
  protected abstract getQueueLength(): number;

  protected abstract onPause(): void;
  protected abstract onResume(): void;
  protected abstract applyPausedDuration(pausedMs: number): void;
  protected abstract resetState(): void;
  protected abstract onDestroy(): void;

  protected updateBacklogPause(): void {
    const queueRatio = this.getQueueLength() / rendererLayout.queueMaxSize;
    if (queueRatio > 0.8 && !this.backlogPaused) {
      this.backlogPaused = true;
      this.onBacklogPauseChange?.(true);
    } else if (queueRatio < 0.4 && this.backlogPaused) {
      this.backlogPaused = false;
      this.onBacklogPauseChange?.(false);
    }
  }
}
