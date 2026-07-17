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

import type { Overlay } from '@app/overlay';
import type { BurstLevel, ChatMessage, OverlayDimensions, OverlaySettings } from '@app-types';
import { PerAuthorRateLimiter } from '@media/author-rate-limiter';
import { ANTI_BLOCK_FREE_RATIO } from '@renderer/constants';
import { BurstDetector } from '@renderer/layout/burst-detector';
import { LaneAllocator } from '@renderer/layout/lane-allocator';
import { clearTextMeasurementCaches, setTextMeasureCallback } from '@renderer/text-measure';
import { rendererLayout } from '@util/design-tokens';
import { createLogger } from '@util/logging';
import { ObservabilityReporter } from '@util/observability';

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

  /** Called when YouTube's chat panel opens or closes. Subclasses can override. */
  setChatPanelOpen(_open: boolean): void {
    // Default no-op. Subclasses override to react to panel state changes.
  }

  protected overlay: Overlay;
  protected settings: OverlaySettings;
  protected laneAllocator: LaneAllocator;
  protected burstDetector: BurstDetector;
  protected authorRateLimiter: PerAuthorRateLimiter;

  protected isPaused = false;
  protected videoPaused = false;
  /** User-initiated pause (Space key). Blocks rendering independently. */
  protected isUserPaused = false;

  /** Currently active lane density factor — cached to detect burst-driven changes. */
  protected currentLaneDensityFactor = 1.0;
  /** Set by RuntimeManager when the session uses ReplayChatSource. */
  protected replayMode = false;
  protected pausedAt: number | null = null;
  protected backlogPaused = false;

  /**
   * Mutex to prevent concurrent drain operations. Set to true when either
   * drainQueue() or drainQueueAsync() is actively processing; the other
   * path skips if already locked. Prevents duplicate activation of the
   * same pending messages during onResume() where both the async drain
   * and the rAF render loop's drainQueue() may race on the pending queue.
   */
  protected drainLocked = false;

  /**
   * Timestamp (performance.now) of the last successful message enqueue.
   * Updated by subclasses in enqueueMessageWithPlacement after
   * commitPlacement. Used by RuntimeManager's watchdog to detect
   * renderer stuck states (queue growing but nothing rendering).
   */
  protected lastRenderActivity = performance.now();

  // H1: Buffer messages during video pause instead of dropping them.
  // Messages received while the video is paused are stored here and
  // replayed to subclasses on resume, preventing permanent loss during
  // user pauses, seeking, or buffering events.
  private pauseBuffer: ChatMessage[] = [];
  private static readonly PAUSE_BUFFER_MAX = 200;

  // speedBoostMax — read from this.settings
  private static readonly BACKLOG_PRIORITY_OFFSET = 50;

  /** Lane density factor per burst level.
   *  1.0 = full-cell (normal/elevated), 0.75 = transitional (high), 0.5 = half-cell (extreme). */
  private static readonly LANE_DENSITY_BY_BURST: Record<BurstLevel, number> = {
    normal: 1.0,
    elevated: 1.0,
    high: 0.75,
    extreme: 0.5,
  };
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
      fontSize: this.getEffectiveFontSize(),
      fontWeight: this.settings.fontWeight,
      fontFamily: this.settings.fontFamily,
      laneSpacing: this.settings.laneSpacing,
      headwayGapRatio: this.settings.headwayGapRatio,
      exitPaddingPx: this.settings.exitPaddingPx,
      scrollDurationMaxMs: this.settings.scrollDurationMaxMs,
      maxMessageAgeMs: this.settings.maxMessageAgeMs,
      laneDensityFactor: 1.0,
    });
    this.laneAllocator.reset(this.overlay.getDimensions());

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
  get isVideoPaused(): boolean {
    return this.videoPaused;
  }

  /** Whether the renderer is in replay (VOD) mode. */
  get isReplayMode(): boolean {
    return this.replayMode;
  }

  /** Set by RuntimeManager when the session uses ReplayChatSource. */
  setReplayMode(enabled: boolean): void {
    this.replayMode = enabled;
  }

  /**
   * Compute the effective font size scaled to the current viewport height.
   * Linear scaling: fontSize × (viewportHeight / fontBaseViewportHeight),
   * clamped to [fontMinSize, fontMaxSize].
   */
  protected getEffectiveFontSize(): number {
    const dims = this.overlay.getDimensions();
    if (!dims || dims.height <= 0) return this.settings.fontSize;
    const { fontSize, fontBaseViewportHeight, fontMinSize, fontMaxSize } = this.settings;
    const scaled = Math.round(fontSize * (dims.height / fontBaseViewportHeight));
    return Math.max(fontMinSize, Math.min(fontMaxSize, scaled));
  }

  /** Set user-initiated pause state (Space key toggle). */
  setUserPaused(paused: boolean): void {
    this.isUserPaused = paused;
  }

  // ── Shared state machine ──────────────────────────────────────────────

  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
    this.pausedAt = performance.now();
    this.burstDetector.pause();
    this.onPause();
    log.debug('renderer.paused', { reason: 'user' });
  }

  resume(): void {
    if (!this.isPaused) return;

    const now = performance.now();
    let pausedDuration = 0;
    if (this.pausedAt !== null) {
      // B-1: Use a higher clamp (2× maxMessageAgeMs) to avoid the per-message
      // clamp from discarding real elapsed time. The per-message clamp in
      // CanvasRenderer.applyPausedDuration handles individual message expiry.
      const raw = Math.max(0, now - this.pausedAt);
      pausedDuration = Math.min(raw, this.settings.maxMessageAgeMs * 2);
      this.applyPausedDuration(pausedDuration);
    }
    this.pausedAt = null;

    // Pre-warm BurstDetector EMA from pending queue density.
    // Without this, the EMA starts at 0 and takes 30+ messages to
    // reflect actual chat activity after a short tab switch.
    const intervals = this.computePendingQueueIntervals();
    if (intervals.length > 0) {
      this.burstDetector.resumeWithSamples(intervals);
    } else {
      this.burstDetector.resume();
    }

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
    log.debug('renderer.resumed');
  }

  pauseForVideo(): void {
    if (this.isVideoPaused) return;
    this.videoPaused = true;
    if (!this.isPaused) {
      this.pause();
    }
  }

  resumeForVideo(): void {
    if (!this.videoPaused) return;
    this.videoPaused = false;
    if (document.visibilityState === 'visible') {
      if (this.isPaused) {
        this.resume();
      } else {
        // isPaused was already cleared by resume() when tab returned
        // while video was still paused. Render loop needs to start now.
        this.onResume();
        log.debug('renderer.resumed');
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
        this.getEffectiveFontSize(),
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
    const baseSpeed = this.settings.speedPxPerSec;

    // Replay (VOD): use base speed only — burst adaptation would distort
    // exact videoOffsetMs-based timing from ReplayChatSource.
    if (this.replayMode) return Math.max(1, baseSpeed);

    let speed = baseSpeed;

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
    return Math.max(1, speed * rendererLayout.burstSpeedMultiplier[burstLevel]);
  }

  /** Get the current lane density factor based on burst detection level.
   *  Returns 1.0 (full-cell) during normal/elevated traffic,
   *  0.75 during high burst, 0.5 (half-cell) during extreme burst. */
  getLaneDensityFactor(): number {
    const burstLevel = this.burstDetector.getLevel();
    return RendererBase.LANE_DENSITY_BY_BURST[burstLevel];
  }

  /** Apply lane density change if burst level shifted since last check.
   *  Called at the start of each render frame, before drainStage().
   *  When density changes, resets the lane allocator with the new effective lane height.
   *  Active messages are unaffected — they retain their original placement positions.
   *  New placements from this point use the updated grid.
   *  Returns true if lanes were reset. */
  protected applyLaneDensityIfChanged(): boolean {
    const newFactor = this.getLaneDensityFactor();
    if (newFactor === this.currentLaneDensityFactor) return false;
    this.currentLaneDensityFactor = newFactor;
    this.laneAllocator.updateLaneDensityFactor(newFactor);
    this.laneAllocator.reset(this.overlay.getDimensions());
    return true;
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

    // Replay (VOD): messages carry exact videoOffsetMs timing — burst
    // detection and rate limiting are meaningless for historical data.
    if (!this.replayMode) {
      this.burstDetector.onMessageReceived();

      const priority = RendererBase.getMessagePriority(message);
      if (
        !this.authorRateLimiter.allow(message.author ?? 'anonymous', priority, message.authorType)
      ) {
        log.debug('renderer.message.drop', {
          reason: 'rate_limited',
          author: message.author,
          kind: message.kind,
        });
        this.observability.onMessageDropped('rate_limited');
        return false;
      }
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
    this.videoPaused = false;
    this.pauseBuffer.length = 0;
    this.burstDetector.destroy();
    this.authorRateLimiter.destroy();
    this.observability.destroy();
    this.onDestroy();
    log.debug('renderer.destroyed');
  }

  // ── Abstract hooks for subclasses ─────────────────────────────────────

  abstract addMessage(message: ChatMessage): void;
  abstract get laneCount(): number;
  abstract getQueueLength(): number;

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

  // ── Overlay refresh helpers (used by RuntimeManager.performOverlayRefresh) ──

  /**
   * Milliseconds since the last successful render activity.
   * Returns 0 if no render activity has ever been recorded (unlikely,
   * but defensive for early-init edge cases where constructor runs
   * before the first renderFrame).
   */
  getMsSinceLastRenderActivity(now = performance.now()): number {
    return Math.max(0, now - this.lastRenderActivity);
  }

  /** Number of currently active (visible) messages. */
  abstract getActiveMessageCount(): number;

  /**
   * Whether the off-main-thread worker (if any) is responding to pings.
   * Returns true when no worker is active (main-thread only) or when the
   * worker has responded within the timeout window.
   */
  isWorkerAlive(): boolean {
    return true; // default: no worker → always alive
  }

  /**
   * Gracefully degrade from Worker-mode to main-thread rendering.
   * Default no-op — CanvasRenderer overrides with actual fallback logic.
   */
  fallbackToMainThread(_reason: string): void {
    // no-op: main-thread-only renderers have nothing to fall back from
  }

  /** Reset lane allocator with new dimensions. */
  resetAllocator(dims: OverlayDimensions | null): void {
    this.laneAllocator.reset(dims);
  }

  /** Reset burst detector state. */
  resetBurstDetector(): void {
    this.burstDetector.resume();
  }

  /** Explicitly restart the render loop. Subclasses override. */
  resumeRenderLoop(): void {
    // Subclasses override to call startRenderLoop()
  }

  /** Drain pending queue messages. Subclasses override. */
  drainPendingQueue(): ChatMessage[] {
    return [];
  }

  /** Clear all active messages. Subclasses override (used by overlay refresh). */
  clearActiveMessages(): void {}

  /** Clear pending/retry queues. Subclasses override (used by overlay refresh). */
  clearPendingQueue(): void {}

  /** Combo clear for overlay refresh. Subclasses override to call
   *  clearActiveMessages() + clearPendingQueue() together, plus
   *  any subclass-specific state. */
  prepareForRefresh(): void {
    this.clearActiveMessages();
    this.clearPendingQueue();
  }

  /**
   * Return messages currently in the pending queue for burst EMA seeding.
   * Base class returns empty (no pending queue). Subclasses with a pending
   * queue override to provide queued messages.
   */
  protected getPendingQueueMessages(): ChatMessage[] {
    return [];
  }

  /**
   * Extract inter-message intervals from the pending queue for burst EMA
   * seeding.  Returns timestamp deltas between consecutive queued messages
   * in milliseconds.  Used on resume to pre-warm the BurstDetector EMA so
   * speed adaptation doesn't start from zero after a short tab switch.
   */
  private computePendingQueueIntervals(): number[] {
    const msgs = this.getPendingQueueMessages();
    if (msgs.length < 2) return [];
    const intervals: number[] = [];
    for (let i = 1; i < msgs.length; i++) {
      const delta = msgs[i]!.timestamp - msgs[i - 1]!.timestamp;
      if (delta >= 0) intervals.push(delta);
    }
    return intervals;
  }

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
