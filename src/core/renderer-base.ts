// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

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
import { ANTI_BLOCK_FREE_RATIO } from '@core/renderer-constants';
import { clearTextMeasurementCaches, setTextMeasureCallback } from '@core/text-measure';

export type ConnectionStatus = 'connected' | 'connecting' | 'degraded' | 'disconnected' | 'standby';

const log = createLogger('RendererBase');

interface RendererUpdateOptions {
  resetState?: boolean;
}

export abstract class RendererBase {
  readonly observability: ObservabilityReporter;
  onBacklogPauseChange: ((paused: boolean) => void) | null = null;
  /** Callback invoked when the disconnected status bar is clicked. */
  onStatusBarClick: (() => void) | null = null;

  protected overlay: Overlay;
  protected settings: OverlaySettings;
  protected laneAllocator: LaneAllocator;
  protected burstDetector: BurstDetector;
  protected authorRateLimiter: PerAuthorRateLimiter;

  protected isPaused = false;
  protected isVideoPaused = false;
  protected pausedAt: number | null = null;
  protected backlogPaused = false;
  /** Whether the user prefers reduced motion via OS/browser setting. */
  protected reducedMotion = false;

  // H1: Buffer messages during video pause instead of dropping them.
  // Messages received while the video is paused are stored here and
  // replayed to subclasses on resume, preventing permanent loss during
  // user pauses, seeking, or buffering events.
  private pauseBuffer: ChatMessage[] = [];
  private static readonly PAUSE_BUFFER_MAX = 200;

  // speedBoostMax — read from this.settings
  private static readonly BACKLOG_PRIORITY_OFFSET = 50;
  // Minimum interval between backlog pause toggles to prevent oscillation
  // when the queue ratio hovers near the hysteresis thresholds.
  private lastBacklogToggleTime = 0;

  constructor(overlay: Overlay, settings: OverlaySettings) {
    this.overlay = overlay;
    this.settings = settings;
    this.observability = new ObservabilityReporter(settings.showDebugOverlay);
    setTextMeasureCallback((ms) => this.observability.recordTextMeasure(ms));

    this.laneAllocator = new LaneAllocator({
      safeTop: this.settings.safeTop,
      safeBottom: this.settings.safeBottom,
      fontSize: this.settings.fontSize,
      fontWeight: this.settings.fontWeight,
      fontFamily: this.settings.fontFamily,
      laneSpacing: this.settings.laneSpacing,
      exitPaddingPx: this.settings.exitPaddingPx,
      scrollDurationMaxMs: this.settings.scrollDurationMaxMs,
      maxMessageAgeMs: this.settings.maxMessageAgeMs,
    });
    this.laneAllocator.reset(this.overlay.getDimensions());

    // Respect user's reduced-motion preference (a11y). When enabled,
    // scrolling animations are disabled — messages appear statically.
    // The media query is checked at construction and whenever the
    // preference changes (e.g. user toggles OS accessibility setting).
    try {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = mq.matches;
      mq.addEventListener('change', (ev: MediaQueryListEvent) => {
        this.reducedMotion = ev.matches;
      });
    } catch {
      // matchMedia may not be available in all environments (e.g. workers)
      this.reducedMotion = false;
    }

    this.burstDetector = new BurstDetector(this.observability);
    this.burstDetector.updateThresholds({
      burstSampleWindow: this.settings.burstSampleWindow,
      burstElevatedThreshold: this.settings.burstElevatedThreshold,
      burstHighThreshold: this.settings.burstHighThreshold,
      burstExtremeThreshold: this.settings.burstExtremeThreshold,
    });
    this.burstDetector.start();

    this.authorRateLimiter = new PerAuthorRateLimiter(() => this.burstDetector.getLevel());
    this.authorRateLimiter.updateConfig({
      preset: settings.authorRateLimit,
    });
  }

  // ── Public accessors for external coordination ─────────────────────────

  /** Get the current EMA-smoothed message rate (msg/s) for adaptive polling. */
  getBurstEmaRate(): number {
    return this.burstDetector.getEmaRate();
  }

  /**
   * Whether the renderer is currently paused because the user explicitly
   * paused the video (via pause event). This is distinct from the DOM
   * `video.paused` which is also true during premiere countdowns where
   * the video hasn't started yet but the user didn't press pause.
   */
  isPausedByVideo(): boolean {
    return this.isVideoPaused;
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
      pausedDuration = Math.min(Math.max(0, now - this.pausedAt), this.settings.maxMessageAgeMs);
      this.applyPausedDuration(pausedDuration);
    }
    this.pausedAt = null;
    this.burstDetector.resume();

    // Clear paused flag BEFORE isVideoPaused guard so resumeForVideo()
    // can call onResume() when video later un-pauses. Without this,
    // resumeForVideo calls resume() which sees isPaused=false and
    // returns early without starting the render loop.
    this.isPaused = false;

    // Only shift lane timers if the video is actually playing.
    // When isVideoPaused is true, the tab was hidden while the video was
    // paused — shifting lanes would advance availability past the pause,
    // causing messages to disappear prematurely when the video resumes.
    if (!this.isVideoPaused) {
      this.laneAllocator.shiftAll(pausedDuration);
    }

    if (this.isVideoPaused) {
      // Don't start render loop while video is paused — it would waste
      // CPU doing nothing (renderFrame checks isVideoPaused and returns early).
      // resumeForVideo() will call onResume() when the video un-pauses.
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
    if (document.visibilityState === 'visible') {
      if (this.isPaused) {
        this.resume();
      } else {
        // isPaused was already cleared by resume() when tab returned
        // while video was still paused. Render loop needs to start now.
        this.onResume();
        log.debug('Resumed');
      }
    }
    // H1: Replay buffered messages from the pause period.
    // Subclasses override onResumeFromVideoPause() to receive them.
    this.flushPauseBuffer();
  }

  /**
   * H1: Flush the pause buffer by replaying buffered messages.
   * Called from resumeForVideo() after the video pause flag is cleared.
   * Subclasses can override onResumeFromVideoPause() to receive messages.
   */
  private flushPauseBuffer(): void {
    if (this.pauseBuffer.length === 0) return;
    const buffered = this.pauseBuffer;
    this.pauseBuffer = [];
    this.onResumeFromVideoPause(buffered);
  }

  /**
   * H1: Called when the video resumes with messages that arrived during pause.
   * Subclasses override to replay buffered messages into their queue.
   * Default implementation discards the buffer (safe fallback).
   */
  protected onResumeFromVideoPause(_messages: ChatMessage[]): void {
    // Default: discard. Subclasses override to replay.
  }

  updateSettings(settings: OverlaySettings, options: RendererUpdateOptions = {}): void {
    // Capture previous values for change detection
    const prev = {
      safeTop: this.settings.safeTop,
      safeBottom: this.settings.safeBottom,
      fontSize: this.settings.fontSize,
      fontWeight: this.settings.fontWeight,
      fontFamily: this.settings.fontFamily,
      laneSpacing: this.settings.laneSpacing,
    };

    this.settings = settings;
    this.observability.setShowDebug(settings.showDebugOverlay);
    this.authorRateLimiter.updateConfig({
      preset: settings.authorRateLimit,
    });

    // Font change invalidates cached text measurements (LRU width cache).
    // Must clear before lane allocator reset to ensure laneHeight recalculation
    // uses fresh font metrics.
    const fontChanged =
      settings.fontSize !== prev.fontSize ||
      settings.fontWeight !== prev.fontWeight ||
      settings.fontFamily !== prev.fontFamily;
    const laneSpacingChanged = settings.laneSpacing !== prev.laneSpacing;

    if (fontChanged || laneSpacingChanged) {
      this.laneAllocator.updateFontMetrics(
        settings.fontSize,
        settings.fontWeight,
        settings.fontFamily,
        settings.laneSpacing
      );
    }

    if (fontChanged) {
      clearTextMeasurementCaches();
    }

    // Propagate safe-zone changes to lane allocator even without full reset.
    // This ensures new lane placements use the correct Y positions immediately.
    const safeZoneChanged =
      settings.safeTop !== prev.safeTop || settings.safeBottom !== prev.safeBottom;
    this.laneAllocator.updateSafeZone(settings.safeTop, settings.safeBottom);

    if (options.resetState) {
      this.resetState();
      this.laneAllocator.reset(this.overlay.getDimensions());
      return;
    }

    // Safe zone changes affect lane count (usable height), so recalculate.
    if (safeZoneChanged || this.laneAllocator.isEmpty()) {
      this.laneAllocator.reset(this.overlay.getDimensions());
    }
  }

  // ── Shared helpers ────────────────────────────────────────────────────

  protected getEffectiveSpeedPxPerSec(): number {
    let speed = this.settings.speedPxPerSec;

    const emaRate = this.burstDetector.getEmaRate();
    if (emaRate > this.settings.speedBoostThreshold) {
      const emaMultiplier =
        1 +
        Math.min(
          (emaRate - this.settings.speedBoostThreshold) / this.settings.speedBoostDenom,
          this.settings.speedBoostMax
        );
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

    // H1: Buffer messages during video pause instead of dropping them.
    // They will be replayed to subclasses when the video resumes.
    if (this.isVideoPaused) {
      this.observability.onMessageDropped('video_paused');
      if (this.pauseBuffer.length < RendererBase.PAUSE_BUFFER_MAX) {
        this.pauseBuffer.push(message);
      }
      return false;
    }
    this.burstDetector.onMessageReceived();

    const priority = RendererBase.getMessagePriority(message);
    if (
      !this.authorRateLimiter.allow(message.author ?? 'anonymous', priority, message.authorType)
    ) {
      log.debug('Drop [rate_limited]:', message.author, message.kind, message.id);
      this.observability.onMessageDropped('rate_limited');
      return false;
    }
    return true;
  }

  /**
   * Check whether anti-block is currently throttling new messages.
   *
   * Uses a gradual probabilistic throttle instead of a binary gate.
   * At ≥95% lane utilization the acceptance probability approaches 0%,
   * at ≤90% it approaches 100%. This prevents the on/off oscillation
   * pattern that a binary threshold causes when utilization hovers near 95%.
   */
  protected isAntiBlockActive(): boolean {
    const utilization = this.laneAllocator.getUtilization();
    if (utilization < 1 - ANTI_BLOCK_FREE_RATIO) return false;
    const acceptProb = (1 - utilization) / ANTI_BLOCK_FREE_RATIO;
    return Math.random() >= acceptProb;
  }

  /** Compute priority score for a chat message (higher = more important, rendered first). */
  public static getMessagePriority(message: ChatMessage): number {
    let priority = rendererLayout.kindPriority[message.kind];
    if (message.isBacklog) priority -= RendererBase.BACKLOG_PRIORITY_OFFSET;
    return priority;
  }

  destroy(): void {
    this.isPaused = false;
    this.isVideoPaused = false;
    this.pauseBuffer.length = 0;
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

  /** Number of lanes currently available (delegates to laneAllocator). */
  getLaneCount(): number {
    return this.laneAllocator.getLaneCount();
  }

  /** Current lane utilization ratio (0-1). */
  getLaneUtilization(): number {
    return this.laneAllocator.getUtilization();
  }

  /** Trim expired messages from the background queue. Override in subclasses. */
  trimBackgroundQueue(): void {}

  /** Replay a previously received message. Override in subclasses. */
  replayMessage(_message: ChatMessage): void {}

  protected abstract onPause(): void;
  protected abstract onResume(): void;
  protected abstract applyPausedDuration(pausedMs: number): void;
  protected abstract resetState(): void;
  protected abstract onDestroy(): void;

  /** Inform the renderer that the session entered or exited standby mode. */
  setStandbyStatus(_standby: boolean): void {}

  /** Inform the renderer of the current connection health status.
   *  Subclasses override to update visual feedback (status bar, reload prompt). */
  setConnectionStatus(_status: ConnectionStatus): void {}

  protected updateBacklogPause(): void {
    const now = Date.now();
    if (now - this.lastBacklogToggleTime < this.settings.backlogToggleCooldownMs) return;

    const queueRatio =
      this.settings.queueMaxSize > 0 ? this.getQueueLength() / this.settings.queueMaxSize : 0;
    if (queueRatio > this.settings.backlogPauseThreshold && !this.backlogPaused) {
      this.backlogPaused = true;
      this.lastBacklogToggleTime = now;
      this.onBacklogPauseChange?.(true);
    } else if (queueRatio < this.settings.backlogResumeThreshold && this.backlogPaused) {
      this.backlogPaused = false;
      this.lastBacklogToggleTime = now;
      this.onBacklogPauseChange?.(false);
    }
  }
}
