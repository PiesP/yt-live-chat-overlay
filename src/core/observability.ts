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

import type { BurstLevel, DropReason, SessionMetrics } from '@app-types';
import { createLogger } from '@core/logging';

const log = createLogger('Observability');

export class ObservabilityReporter {
  private metrics: SessionMetrics;
  private dropCounters: Record<DropReason, number>;
  private totalDroppedInWindow = 0;
  private totalReceivedInWindow = 0;
  private windowStartTime = Date.now();
  private debugOverlayEl: HTMLElement | null = null;
  private debugUpdateTimer: ReturnType<typeof setInterval> | null = null;
  private boundVisibilityHandler: (() => void) | null = null;
  private lastWarnTime = 0;
  private readonly WARN_COOLDOWN_MS = 30_000;
  private readonly METRIC_WINDOW_MS = 60_000;
  private showDebug = false;

  constructor(initialShowDebug: boolean = false) {
    this.dropCounters = {
      queue_overflow: 0,
      no_lane_available: 0,
      rate_limited: 0,
      dedup: 0,
      other: 0,
    };
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

  // called when a message is dropped
  onMessageDropped(reason: DropReason): void {
    this.metrics.totalDropped++;
    this.totalDroppedInWindow++;
    this.dropCounters[reason]++;

    // Warn if drop rate exceeds 20%
    this.refreshDerivedMetrics();
    if (this.metrics.dropRate > 0.2) {
      const now = Date.now();
      if (now - this.lastWarnTime > this.WARN_COOLDOWN_MS) {
        this.lastWarnTime = now;
        log.warn(
          `High drop rate: ${(this.metrics.dropRate * 100).toFixed(1)}% ` +
            `(queue=${this.metrics.queueDepth}, lanes=${(this.metrics.laneUtilization * 100).toFixed(0)}%)`
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
    if (elapsed >= this.METRIC_WINDOW_MS) {
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

  private createDebugOverlay(): void {
    if (this.debugOverlayEl || !this.showDebug) return;
    const el = document.createElement('div');
    el.id = 'yt-chat-overlay-debug';
    el.style.cssText =
      'position:fixed;top:8px;right:8px;z-index:99999;' +
      'background:rgba(0,0,0,0.8);color:#0f0;font:12px/1.4 monospace;' +
      'padding:8px 12px;border-radius:4px;min-width:220px;' +
      'pointer-events:none;user-select:none';
    document.body.appendChild(el);
    this.debugOverlayEl = el;
    this.registerVisibilityHandler();
    this.scheduleDebugUpdate();
  }

  private registerVisibilityHandler(): void {
    if (this.boundVisibilityHandler) return;
    this.boundVisibilityHandler = () => {
      if (document.hidden) {
        this.pauseDebugUpdate();
      } else {
        this.resumeDebugUpdate();
      }
    };
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);
  }

  private pauseDebugUpdate(): void {
    if (this.debugUpdateTimer !== null) {
      clearInterval(this.debugUpdateTimer);
      this.debugUpdateTimer = null;
    }
  }

  private resumeDebugUpdate(): void {
    if (this.showDebug) {
      this.scheduleDebugUpdate();
    }
  }

  private scheduleDebugUpdate(): void {
    if (!this.showDebug || !this.debugOverlayEl || this.debugUpdateTimer !== null) return;
    this.debugUpdateTimer = setInterval(() => {
      this.updateDebugOverlay();
    }, 250);
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
    if (this.debugUpdateTimer !== null) {
      clearInterval(this.debugUpdateTimer);
      this.debugUpdateTimer = null;
    }
    if (this.boundVisibilityHandler) {
      document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
      this.boundVisibilityHandler = null;
    }
    if (this.debugOverlayEl) {
      this.debugOverlayEl.remove();
      this.debugOverlayEl = null;
    }
  }

  destroy(): void {
    this.destroyDebugOverlay();
  }
}
