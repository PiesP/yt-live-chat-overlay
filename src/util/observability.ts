// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * ObservabilityReporter
 *
 * Collects real-time session metrics (received, rendered, dropped counts,
 * queue depth, lane utilization, burst level) and provides a debug overlay
 * for visual inspection of the render pipeline health.
 *
 * Zero runtime dependencies — all metric processing is done with plain
 * number counters and timestamps.
 */

import type { BurstLevel, DropReason, FrameTimings, SessionMetrics } from '@app-types';
import {
  DEBUG_OVERLAY_BG,
  DEBUG_OVERLAY_RIGHT,
  DEBUG_OVERLAY_TOP,
  INDICATOR_Z_INDEX,
} from '@util/design-tokens';
import { createLogger } from '@util/logging';

const log = createLogger('Observability');

/** Debug overlay inline style tokens. */
const DEBUG_OVERLAY_STYLES = {
  color: '#0f0',
  font: '12px/1.4 monospace',
  padding: '8px 12px',
  borderRadius: '4px',
  minWidth: '220px',
} as const;

export class ObservabilityReporter {
  private metrics: SessionMetrics;
  private totalDroppedInWindow = 0;
  private totalReceivedInWindow = 0;
  private windowStartTime = Date.now();
  private debugOverlayEl: HTMLElement | null = null;
  private lastWarnTime = 0;
  private showDebug = false;
  private static readonly WARN_COOLDOWN_MS = 30_000;
  private static readonly METRIC_WINDOW_MS = 60_000;
  /** Number of lines in the debug overlay. */
  private static readonly DEBUG_OVERLAY_LINE_COUNT = 7;
  /** Drop rate threshold (0–1) that triggers high-drop-rate warnings. */
  private static readonly DROP_RATE_WARN_THRESHOLD = 0.2;

  /** Per-frame timing state. */
  private frameTimings: FrameTimings = {
    renderFrameMs: 0,
    drainQueueMs: 0,
    collisionCheckMs: 0,
    textMeasureMs: 0,
    frameCount: 0,
    lastFrameTimestamp: 0,
  };
  /** Per-frame accumulator for collision check timing (reset each tick). */
  private collisionAccumMs = 0;
  /** Per-frame accumulator for text measure timing (reset each tick). */
  private textMeasureAccumMs = 0;
  /** Timestamp of last debug overlay DOM update, for throttle control. */
  private lastDebugUpdate = 0;
  private static readonly DEBUG_UPDATE_INTERVAL_MS = 250;

  constructor(initialShowDebug: boolean = false) {
    this.metrics = {
      totalReceived: 0,
      totalRendered: 0,
      totalDropped: 0,
      dropRate: 0,
      queueDepth: 0,
      burstLevel: 'normal',
      activeMessages: 0,
      laneUtilization: 0,
      backlogProgress: 1,
      frameTimings: this.frameTimings,
    };
    this.showDebug = initialShowDebug;
    if (initialShowDebug) {
      this.createDebugOverlay();
    }
  }

  // called when a message is received (before any processing)
  onMessageReceived(): void {
    this.metrics.totalReceived++;
    this.totalReceivedInWindow++;
  }

  // called when a message is successfully rendered
  onMessageRendered(): void {
    this.metrics.totalRendered++;
  }

  // called when a message is dropped, with optional reason for diagnostics
  onMessageDropped(reason?: DropReason): void {
    this.metrics.totalDropped++;
    this.totalDroppedInWindow++;

    // Refresh derived metrics for accurate drop rate check
    this.refreshDerivedMetrics();

    // Skip high-drop warning for expected video-pause drops — they are
    // intentional and not indicative of a render pipeline issue.
    if (reason === 'video_paused') return;

    // Warn if drop rate exceeds 20%
    if (this.metrics.dropRate > ObservabilityReporter.DROP_RATE_WARN_THRESHOLD) {
      const now = Date.now();
      if (now - this.lastWarnTime > ObservabilityReporter.WARN_COOLDOWN_MS) {
        this.lastWarnTime = now;
        log.warn(
          `High drop rate: ${(this.metrics.dropRate * 100).toFixed(1)}% ` +
            `(queue=${this.metrics.queueDepth}, ` +
            `lanes=${(this.metrics.laneUtilization * 100).toFixed(0)}%, ` +
            `reason=${reason ?? 'unknown'})`
        );
      }
    } else {
      // Reset cooldown on recovery so next spike triggers a fresh warning
      this.lastWarnTime = 0;
    }
  }

  // called to update queue depth
  updateQueueDepth(depth: number): void {
    this.metrics.queueDepth = depth;
  }

  // called to update burst level
  updateBurstLevel(level: BurstLevel): void {
    this.metrics.burstLevel = level;
  }

  // called to update active messages count
  updateActiveMessages(count: number): void {
    this.metrics.activeMessages = count;
  }

  // called to update lane utilization
  updateLaneUtilization(ratio: number): void {
    this.metrics.laneUtilization = Math.max(0, Math.min(1, ratio));
  }

  // called during backlog injection to report progress (0-1)
  updateBacklogProgress(progress: number): void {
    this.metrics.backlogProgress = Math.max(0, Math.min(1, progress));
  }

  // ── Per-frame timing instrumentation ────────────────────────────────────

  /** Frames elapsed since the last tick() — ensures per-tick averages are computed correctly. */
  private framesSinceLastTick = 0;

  /** Record renderFrame() execution time with exponential moving average. */
  recordRenderFrame(ms: number): void {
    this.frameTimings.renderFrameMs = this.frameTimings.renderFrameMs * 0.95 + ms * 0.05;
    this.frameTimings.frameCount++;
    this.framesSinceLastTick++;
    this.frameTimings.lastFrameTimestamp = performance.now();
  }

  /** Record drainQueue() execution time with exponential moving average. */
  recordDrainQueue(ms: number): void {
    this.frameTimings.drainQueueMs = this.frameTimings.drainQueueMs * 0.95 + ms * 0.05;
  }

  /** Accumulate collision check time during this frame (reset on tick). */
  recordCollisionCheck(ms: number): void {
    this.collisionAccumMs += ms;
  }

  /** Accumulate text measure time during this frame (reset on tick). */
  recordTextMeasure(ms: number): void {
    this.textMeasureAccumMs += ms;
  }

  // get current metrics snapshot (deep-cloned to prevent external mutation)
  getMetrics(): SessionMetrics {
    this.refreshDerivedMetrics();
    return structuredClone(this.metrics);
  }

  private refreshDerivedMetrics(): void {
    const now = Date.now();
    const elapsed = now - this.windowStartTime;
    if (elapsed >= ObservabilityReporter.METRIC_WINDOW_MS) {
      this.totalDroppedInWindow = 0;
      this.totalReceivedInWindow = 0;
      this.windowStartTime = now;
    }
    this.metrics.dropRate =
      this.totalReceivedInWindow > 0 ? this.totalDroppedInWindow / this.totalReceivedInWindow : 0;
  }

  // --- Debug overlay ---

  setShowDebug(show: boolean): void {
    if (this.showDebug === show) return;
    this.showDebug = show;
    if (show) {
      this.createDebugOverlay();
    } else {
      this.destroyDebugOverlay();
    }
  }

  /**
   * Update the debug HUD — call from the rAF loop (every frame).
   * Avoids a separate setInterval and visibility-change management.
   *
   * Resolves per-frame accumulators (collisionCheckMs, textMeasureMs)
   * into averages before updating the overlay.
   */
  tick(): void {
    if (!this.showDebug || !this.debugOverlayEl) return;
    // Compute averages for per-frame accumulators using per-interval frame count.
    // If no frames occurred since last tick, skip averaging to avoid 0-division
    // and keep the previous tick's values intact.
    if (this.framesSinceLastTick > 0) {
      const fc = this.framesSinceLastTick;
      this.frameTimings.collisionCheckMs = this.collisionAccumMs / fc;
      this.frameTimings.textMeasureMs = this.textMeasureAccumMs / fc;
      this.collisionAccumMs = 0;
      this.textMeasureAccumMs = 0;
      this.framesSinceLastTick = 0;
    }
    // Throttle DOM updates to 250ms intervals.
    // Debug overlay is human-readable — 4 updates/second is plenty.
    // Accumulators continue to reset every frame so timing data stays fresh.
    const now = performance.now();
    if (now - this.lastDebugUpdate >= ObservabilityReporter.DEBUG_UPDATE_INTERVAL_MS) {
      this.lastDebugUpdate = now;
      this.updateDebugOverlay();
    }
  }

  private createDebugOverlay(): void {
    if (this.debugOverlayEl) return;
    const el = document.createElement('div');
    el.id = 'yt-chat-overlay-debug';
    el.style.cssText =
      `position:fixed;top:${DEBUG_OVERLAY_TOP};right:${DEBUG_OVERLAY_RIGHT};z-index:${INDICATOR_Z_INDEX};` +
      `background:${DEBUG_OVERLAY_BG};color:${DEBUG_OVERLAY_STYLES.color};font:${DEBUG_OVERLAY_STYLES.font};` +
      `padding:${DEBUG_OVERLAY_STYLES.padding};border-radius:${DEBUG_OVERLAY_STYLES.borderRadius};` +
      `min-width:${DEBUG_OVERLAY_STYLES.minWidth};pointer-events:none;user-select:none`;
    // Pre-create child divs matching the number of debug lines
    for (let i = 0; i < ObservabilityReporter.DEBUG_OVERLAY_LINE_COUNT; i++) {
      el.appendChild(document.createElement('div'));
    }
    document.body.appendChild(el);
    this.debugOverlayEl = el;
  }

  private updateDebugOverlay(): void {
    if (!this.debugOverlayEl) return;
    const m = this.getMetrics();
    const lines = [
      `Rcvd: ${m.totalReceived} | Rndr: ${m.totalRendered}`,
      `Drop: ${m.totalDropped} (${(m.dropRate * 100).toFixed(1)}%)`,
      `Queue: ${m.queueDepth} | Burst: ${m.burstLevel}`,
      `Active: ${m.activeMessages} | Lane: ${(m.laneUtilization * 100).toFixed(0)}%`,
      `Backlog: ${(m.backlogProgress * 100).toFixed(0)}%`,
      `Render: ${m.frameTimings.renderFrameMs.toFixed(2)}ms` +
        ` | Drain: ${m.frameTimings.drainQueueMs.toFixed(2)}ms`,
      `Coll: ${m.frameTimings.collisionCheckMs.toFixed(2)}ms` +
        ` | Text: ${m.frameTimings.textMeasureMs.toFixed(2)}ms`,
    ];
    const children = this.debugOverlayEl.children;
    for (let i = 0; i < lines.length; i++) {
      const child = children.item(i);
      if (child) child.textContent = lines[i] as string;
    }
  }

  private destroyDebugOverlay(): void {
    if (this.debugOverlayEl) {
      this.debugOverlayEl.remove();
      this.debugOverlayEl = null;
    }
  }

  destroy(): void {
    this.destroyDebugOverlay();
  }
}
