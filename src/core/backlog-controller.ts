/**
 * BacklogInjectionController
 *
 * Throttles the injection of initial backlog messages when a video is first
 * opened, preventing the queue from being flooded with hundreds of messages
 * at once.
 *
 * Strategies:
 * 1. Time-based throttling — backlog messages are injected at a controlled
 *    rate (max N per second, based on lane count).
 * 2. Temporal compression — backlog message animation duration is shortened
 *    by the speed multiplier so they scroll past faster.
 * 3. Statistical sampling — when backlog exceeds 200/500 messages, apply
 *    50%/25% sampling. High-priority messages (SuperChat, Membership) are
 *    always included.
 * 4. Density ramp — injection rate starts low and linearly ramps up over
 *    the first few seconds to avoid visual flooding on startup.
 * 5. Progress indicator — shows a "Loading chat history..." overlay indicator
 *    that auto-removes when backlog injection completes.
 */

import type { BacklogMode, ChatMessage } from '@app-types';
import { sampleExponential } from '@core/design-tokens';
import { createLogger } from '@core/logging';
import type { ObservabilityReporter } from '@core/observability';

const log = createLogger('Backlog');

interface BacklogControllerConfig {
  /** How to handle past chat messages */
  backlogMode: BacklogMode;
  /** Max messages per second during backlog injection */
  backlogMaxRate: number;
  /** Speed multiplier for backlog message animations (2 = twice as fast) */
  backlogSpeedMultiplier: number;
  /** For 'recent' mode: how many minutes of past chat to show */
  backlogRecentMinutes: number;
}

export class BacklogInjectionController {
  private backlogQueue: ChatMessage[] = [];
  private isActive = false;
  private isInjecting = false;
  private injectionTimer: ReturnType<typeof setTimeout> | null = null;
  private totalBacklog = 0;
  private processedBacklog = 0;
  private indicatorEl: HTMLElement | null = null;
  private hideIndicatorTimer: ReturnType<typeof setTimeout> | null = null;
  private config: BacklogControllerConfig;
  private lanes: number;
  private observability: ObservabilityReporter | undefined;
  private realTimeActivityCount = 0;
  private injectionStartTime = 0;

  /**
   * Callback to query current lane utilization (0–1).
   * When set, the injection rate is throttled proportionally to how full
   * the screen is — high utilization → slower injection.
   */
  public onUtilizationQuery: (() => number) | null = null;

  /**
   * Base density ramp duration (ms).
   * During this window the injection rate linearly ramps from 25% to 100%
   * of the computed adaptive rate, avoiding visual flooding on startup.
   *
   * Scales with backlog size: small backlogs (<200) use the base value,
   * large backlogs (>=500) extend to 4000ms to prevent visual flooding.
   */
  private static readonly DENSITY_RAMP_BASE_MS = 2500;
  private static readonly DENSITY_RAMP_MAX_MS = 4000;
  private densityRampMs = BacklogInjectionController.DENSITY_RAMP_BASE_MS;

  constructor(
    config: BacklogControllerConfig,
    lanes: number,
    observability?: ObservabilityReporter
  ) {
    this.config = config;
    this.lanes = lanes;
    this.observability = observability;
  }

  /** Called when initial seed messages arrive */
  startBacklogInjection(messages: ChatMessage[]): void {
    if (messages.length === 0) return;

    // 'none' mode: skip backlog entirely
    if (this.config.backlogMode === 'none') {
      log.debug('Backlog mode is "none", skipping injection');
      this.finishBacklogInjection();
      return;
    }

    // 'recent' mode: filter messages by time window
    let filtered = messages;
    if (this.config.backlogMode === 'recent') {
      const cutoffMs = this.config.backlogRecentMinutes * 60 * 1000;
      const now = Date.now();
      filtered = messages.filter((m) => now - m.timestamp < cutoffMs);
      log.debug(
        `Backlog recent mode: ${messages.length} → ${filtered.length} ` +
          `(last ${this.config.backlogRecentMinutes} min)`
      );
    }

    // Apply sampling based on backlog size
    const sampled = this.sampleMessages(filtered);

    // Priority messages (SuperChat, Membership) bypass the throttled queue
    // and are emitted immediately for minimum display latency.
    const priorityMessages: ChatMessage[] = [];
    const normalMessages: ChatMessage[] = [];
    for (const m of sampled) {
      if (m.kind === 'superchat' || m.kind === 'membership') {
        priorityMessages.push(m);
      } else {
        normalMessages.push(m);
      }
    }

    // Emit priority messages immediately through the renderer callback
    if (priorityMessages.length > 0) {
      for (const msg of priorityMessages) {
        msg.isBacklog = true;
        this.onBacklogMessage?.(msg);
      }
      log.debug(`Backlog: emitted ${priorityMessages.length} priority messages immediately`);
    }

    this.backlogQueue = normalMessages;
    this.totalBacklog = normalMessages.length;
    this.processedBacklog = 0;
    this.isActive = normalMessages.length > 0;
    this.injectionStartTime = Date.now();

    // Adapt density ramp duration to backlog size.
    // Small backlogs (<200) use the base ramp; large backlogs (>=500)
    // extend up to DENSITY_RAMP_MAX_MS to prevent visual flooding.
    const backlogSize = sampled.length;
    if (backlogSize >= 500) {
      this.densityRampMs = BacklogInjectionController.DENSITY_RAMP_MAX_MS;
    } else if (backlogSize >= 200) {
      const t = (backlogSize - 200) / 300; // 0 at 200, 1 at 500
      this.densityRampMs = Math.round(
        BacklogInjectionController.DENSITY_RAMP_BASE_MS +
          t *
            (BacklogInjectionController.DENSITY_RAMP_MAX_MS -
              BacklogInjectionController.DENSITY_RAMP_BASE_MS)
      );
    } else {
      this.densityRampMs = BacklogInjectionController.DENSITY_RAMP_BASE_MS;
    }

    log.debug(`Backlog injection: ${messages.length} messages, sampled to ${sampled.length}`);

    // Show indicator
    this.showIndicator();

    // Report to observability
    this.observability?.updateBacklogProgress(0);

    // Start throttled injection
    this.startInjection();
  }

  /** Notify the controller that a real-time message arrived during injection. */
  notifyRealTimeActivity(): void {
    this.realTimeActivityCount = Math.min(this.realTimeActivityCount + 1, 5);
  }

  /** Start the throttled injection loop */
  private startInjection(): void {
    if (this.isInjecting || !this.isActive || this.backlogQueue.length === 0) {
      if (this.backlogQueue.length === 0) this.finishBacklogInjection();
      return;
    }

    this.isInjecting = true;
    this.processTick();
  }

  /** Execute one injection tick. Uses setTimeout for throttled scheduling. */
  private processTick(): void {
    if (!this.isActive || this.backlogQueue.length === 0) {
      this.isInjecting = false;
      if (this.backlogQueue.length === 0) this.finishBacklogInjection();
      return;
    }

    const maxRate = Math.max(4, Math.min(20, this.config.backlogMaxRate, this.lanes * 2));
    const realTimeFactor = Math.max(0.25, 1 - this.realTimeActivityCount * 0.2);
    const rampFactor = this.getDensityRampFactor();
    const utilizationFactor = this.getUtilizationFactor();
    const adaptiveRate = Math.max(
      1,
      Math.round(maxRate * realTimeFactor * rampFactor * utilizationFactor)
    );
    const meanInterval = Math.round(1000 / adaptiveRate);

    this.realTimeActivityCount = Math.max(0, this.realTimeActivityCount - 1);

    const message = this.backlogQueue.shift();
    /* v8 ignore next 1 — TypeScript guard: queue non-empty checked above */
    if (!message) return;
    message.isBacklog = true;
    this.processedBacklog++;

    const progress = this.totalBacklog > 0 ? this.processedBacklog / this.totalBacklog : 1;
    this.observability?.updateBacklogProgress(progress);

    this.updateIndicator(progress);

    this.onBacklogMessage?.(message);

    this.scheduleNextTick(meanInterval);
  }

  /**
   * Compute a utilization-based throttle factor (0.1–1.0).
   * When the screen is heavily occupied, injection slows down to prevent
   * visual crowding. Uses the lane utilization ratio from the allocator.
   */
  private getUtilizationFactor(): number {
    if (!this.onUtilizationQuery) return 1;
    const utilization = this.onUtilizationQuery();
    // Linear falloff: 0% utilized → 1.0, 100% utilized → 0.1
    return Math.max(0.1, 1 - utilization * 0.9);
  }

  /**
   * Schedule the next injection tick using Poisson-distributed spacing.
   *
   * Instead of a fixed interval, the delay is sampled from an exponential
   * distribution with the given mean. This produces a Poisson process whose
   * long-term rate matches the target, but whose individual intervals vary
   * naturally — eliminating the "train" pattern caused by uniform spacing.
   *
   * The result is clamped to [floorMs, 2×mean] to prevent both sub-32ms
   * clustering (vertical bunching on nearby lanes) and extreme outliers.
   * floorMs = max(32, meanInterval × 0.6) adapts to the injection rate.
   */
  private scheduleNextTick(meanInterval: number): void {
    const floorMs = Math.max(32, Math.round(meanInterval * 0.6));
    const poissonDelay = Math.max(
      floorMs,
      Math.min(meanInterval * 2, sampleExponential(meanInterval))
    );
    this.injectionTimer = setTimeout(() => this.processTick(), poissonDelay);
  }

  /**
   * Compute the density ramp factor (0.25-1.0).
   * Linearly interpolates from 0.25 to 1.0 over the adaptive density ramp window.
   * After the ramp window, returns 1.0 (full rate).
   */
  private getDensityRampFactor(): number {
    const elapsed = Date.now() - this.injectionStartTime;
    if (elapsed >= this.densityRampMs) return 1;
    return 0.25 + 0.75 * (elapsed / this.densityRampMs);
  }

  /** Callback to be set by RuntimeSession */
  public onBacklogMessage: ((message: ChatMessage) => void) | null = null;

  /** Apply smart sampling based on message importance and time distribution. */
  private sampleMessages(messages: ChatMessage[]): ChatMessage[] {
    const count = messages.length;
    if (count < 200) return messages;

    const isPriority = (m: ChatMessage): boolean =>
      m.kind === 'superchat' || m.kind === 'membership';

    const isSubstantialText = (m: ChatMessage): boolean => {
      if (isPriority(m)) return false;
      const text = m.text.trim();
      return text.length >= 3 && !/^[\sㅋㅎㅇㄱ]+$/.test(text);
    };

    // Partition into priority / substantial / other tiers in a single pass.
    const tier1: ChatMessage[] = [];
    const tier2: ChatMessage[] = [];
    const tier3: ChatMessage[] = [];
    for (const m of messages) {
      if (isPriority(m)) {
        tier1.push(m);
      } else if (isSubstantialText(m)) {
        tier2.push(m);
      } else {
        tier3.push(m);
      }
    }

    const normalBudget = count < 500 ? Math.floor(count * 0.6) : Math.floor(count * 0.35);

    const selected: ChatMessage[] = [...tier1];
    let remaining = normalBudget;

    if (tier2.length > 0 && remaining > 0) {
      const pick = Math.min(remaining, tier2.length);
      selected.push(...this.timeDistributedPick(tier2, pick));
      remaining -= pick;
    }

    if (tier3.length > 0 && remaining > 0) {
      const pick = Math.min(remaining, tier3.length);
      selected.push(...this.timeDistributedPick(tier3, pick));
    }

    return selected.sort((a, b) => {
      const priorityA = a.kind === 'superchat' ? 0 : a.kind === 'membership' ? 1 : 2;
      const priorityB = b.kind === 'superchat' ? 0 : b.kind === 'membership' ? 1 : 2;
      if (priorityA !== priorityB) return priorityA - priorityB;
      return a.timestamp - b.timestamp;
    });
  }

  /**
   * Pick messages with even time distribution to avoid clustering.
   * Divides the time range into buckets and picks one message per bucket.
   */
  private timeDistributedPick(messages: ChatMessage[], count: number): ChatMessage[] {
    if (count >= messages.length) return [...messages];
    if (count <= 0) return [];

    const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);
    const step = Math.max(1, Math.floor(sorted.length / count));
    const picked: ChatMessage[] = [];

    for (let i = 0; i < count; i++) {
      const idx = Math.min(i * step, sorted.length - 1);
      const msg = sorted[idx];
      if (msg) picked.push(msg);
    }

    return picked;
  }

  /** Mark backlog injection as complete */
  private finishBacklogInjection(): void {
    this.isActive = false;
    this.isInjecting = false;
    this.backlogQueue = [];
    this.observability?.updateBacklogProgress(1);
    this.hideIndicator();
    log.debug('Backlog injection complete');
  }

  /** Returns the speed multiplier for backlog message animations */
  getSpeedMultiplier(): number {
    return this.config.backlogSpeedMultiplier;
  }

  /** Whether backlog injection is currently active */
  get isBacklogActive(): boolean {
    return this.isActive;
  }

  // --- Backlog indicator UI ---

  private showIndicator(): void {
    if (this.indicatorEl) return;
    const el = document.createElement('div');
    el.id = 'yt-chat-overlay-backlog-indicator';
    el.style.cssText = `
      position: fixed; top: 40px; right: 8px; z-index: 99999;
      background: rgba(0,0,0,0.75); color: #fff;
      font: 12px/1.4 sans-serif; padding: 6px 10px;
      border-radius: 4px; pointer-events: none; user-select: none;
      opacity: 0; transition: opacity 0.3s ease;
    `;
    el.textContent = 'Loading chat history...';
    document.body.appendChild(el);
    this.indicatorEl = el;
    // Fade in
    requestAnimationFrame(() => {
      el.style.opacity = '1';
    });
  }

  private updateIndicator(progress: number): void {
    if (!this.indicatorEl) return;
    const pct = Math.round(progress * 100);
    this.indicatorEl.textContent = `Loading chat history... ${this.processedBacklog}/${this.totalBacklog} (${pct}%)`;
  }

  private hideIndicator(): void {
    if (!this.indicatorEl) return;
    this.indicatorEl.style.opacity = '0';
    this.hideIndicatorTimer = setTimeout(() => {
      this.hideIndicatorTimer = null;
      if (this.indicatorEl) {
        this.indicatorEl.remove();
        this.indicatorEl = null;
      }
    }, 300);
  }

  /** Update config at runtime */
  updateConfig(config: Partial<BacklogControllerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Clean up */
  destroy(): void {
    this.isActive = false;
    this.isInjecting = false;
    if (this.injectionTimer !== null) {
      clearTimeout(this.injectionTimer);
      this.injectionTimer = null;
    }
    if (this.hideIndicatorTimer !== null) {
      clearTimeout(this.hideIndicatorTimer);
      this.hideIndicatorTimer = null;
    }
    this.backlogQueue = [];
    if (this.indicatorEl) {
      this.indicatorEl.remove();
      this.indicatorEl = null;
    }
    this.onBacklogMessage = null;
  }

  /** Pause/resume injection when the render queue is overloaded */
  setPaused(paused: boolean): void {
    if (paused) {
      this.isInjecting = false;
      if (this.injectionTimer !== null) {
        clearTimeout(this.injectionTimer);
        this.injectionTimer = null;
      }
    } else if (!this.isInjecting && this.isActive && this.backlogQueue.length > 0) {
      this.isInjecting = true;
      this.processTick();
    }
  }
}
