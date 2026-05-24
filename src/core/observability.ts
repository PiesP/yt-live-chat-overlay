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

import type { BurstLevel, SessionMetrics } from '@app-types';
import {
  DEBUG_OVERLAY_BG,
  DEBUG_OVERLAY_RIGHT,
  DEBUG_OVERLAY_TOP,
  DEBUG_OVERLAY_Z_INDEX,
} from '@core/design-tokens';
import { createLogger } from '@core/logging';

const log = createLogger('Observability');

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
  onMessageDropped(reason?: string): void {
    this.metrics.totalDropped++;
    this.totalDroppedInWindow++;

    // Refresh derived metrics for accurate drop rate check
    this.refreshDerivedMetrics();

    // Skip high-drop warning for expected video-pause drops — they are
    // intentional and not indicative of a render pipeline issue.
    if (reason === 'video_paused') return;

    // Warn if drop rate exceeds 20%
    if (this.metrics.dropRate > 0.2) {
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

  // get current metrics snapshot
  getMetrics(): SessionMetrics {
    this.refreshDerivedMetrics();
    return { ...this.metrics };
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
   */
  tick(): void {
    if (!this.showDebug || !this.debugOverlayEl) return;
    this.updateDebugOverlay();
  }

  private createDebugOverlay(): void {
    if (this.debugOverlayEl) return;
    const el = document.createElement('div');
    el.id = 'yt-chat-overlay-debug';
    el.style.cssText = [
      `position:fixed;top:${DEBUG_OVERLAY_TOP};right:${DEBUG_OVERLAY_RIGHT};z-index:${DEBUG_OVERLAY_Z_INDEX};`,
      `background:${DEBUG_OVERLAY_BG};color:#0f0;font:12px/1.4 monospace;`,
      'padding:8px 12px;border-radius:4px;min-width:220px;',
      'pointer-events:none;user-select:none',
    ].join('');
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
    ];
    // Use DOM API instead of innerHTML to avoid any XSS surface
    this.debugOverlayEl.replaceChildren(
      ...lines.map((line) => {
        const div = document.createElement('div');
        div.textContent = line;
        return div;
      })
    );
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
