/**
 * RendererBase
 *
 * Shared logic extracted from RendererCSS and RendererCanvas.
 * Subclasses implement the rendering-specific abstract methods.
 *
 * State machine simplification (Phase 4):
 * - Removed isVideoPaused flag: video pause is handled by the runtime
 *   session pausing the renderer AND the chat source independently.
 * - Removed resumeStabilizeUntil: EMA speed adaptation is always active;
 *   the 2-second stabilization window added complexity without measurable benefit.
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

export interface RendererUpdateOptions {
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
  protected playbackRate = 1;
  protected backlogSpeedMultiplier = 1;
  protected backlogPaused = false;

  constructor(overlay: Overlay, settings: OverlaySettings) {
    this.overlay = overlay;
    this.settings = settings;
    this.observability = new ObservabilityReporter(settings.showDebugOverlay);

    this.laneAllocator = new LaneAllocator({
      getEffectiveSpeedPxPerSec: () => this.getEffectiveSpeedPxPerSec(),
      getDanmakuMode: () => this.settings.danmakuMode,
      safeTop: this.settings.safeTop,
      laneSpacing: this.settings.laneSpacing,
    });
    this.laneAllocator.reset(this.overlay.getDimensions());

    this.burstDetector = new BurstDetector(this.observability);
    this.burstDetector.start();

    this.authorRateLimiter = new PerAuthorRateLimiter(() => this.burstDetector.getLevel());
    this.authorRateLimiter.updateConfig({
      enabled: settings.authorRateLimitEnabled,
      windowMs: settings.authorRateLimitWindowMs,
      maxPerWindow: settings.authorRateLimitMaxMessages,
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

    if (this.isVideoPaused) {
      return;
    }

    this.laneAllocator.shiftAll(pausedDuration);
    this.isPaused = false;
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

  setPlaybackRate(rate: number): void {
    if (rate <= 0) return;
    this.playbackRate = rate;
    this.onPlaybackRateChange(rate);
  }

  setBacklogSpeedMultiplier(multiplier: number): void {
    this.backlogSpeedMultiplier = Math.max(1, multiplier);
  }

  updateSettings(settings: OverlaySettings, options: RendererUpdateOptions = {}): void {
    this.settings = settings;
    this.observability.setShowDebug(settings.showDebugOverlay);
    this.authorRateLimiter.updateConfig({
      enabled: settings.authorRateLimitEnabled,
      windowMs: settings.authorRateLimitWindowMs,
      maxPerWindow: settings.authorRateLimitMaxMessages,
    });

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
    let speed = this.settings.speedPxPerSec * this.playbackRate;

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
    if (this.isVideoPaused) {
      this.observability.onMessageDropped('other');
      return false;
    }
    this.observability.onMessageReceived();
    this.burstDetector.onMessageReceived();

    const priority = RendererBase.getMessagePriority(message);
    if (!this.authorRateLimiter.allow(message.author ?? 'anonymous', priority)) {
      log.debug('Drop [rate_limited]:', message.author, message.kind, message.id);
      this.observability.onMessageDropped('rate_limited');
      return false;
    }
    return true;
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

  protected abstract onPause(): void;
  protected abstract onResume(): void;
  abstract onPlaybackRateChange(rate: number): void;
  protected abstract applyPausedDuration(pausedMs: number): void;
  protected abstract resetState(): void;
  protected abstract onDestroy(): void;
}
