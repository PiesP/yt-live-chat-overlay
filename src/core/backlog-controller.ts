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
 * 4. Progress indicator — shows a "Loading chat history..." overlay indicator
 *    that auto-removes when backlog injection completes.
 */

import type { ChatMessage } from '@app-types';
import { createLogger } from '@core/logging';
import type { ObservabilityReporter } from '@core/observability';

const log = createLogger('Backlog');

interface BacklogControllerConfig {
  /** How to handle past chat messages */
  backlogMode: 'playback' | 'recent' | 'full' | 'none';
  /** Max messages per second during backlog injection */
  backlogMaxRate: number;
  /** Speed multiplier for backlog message animations (2 = twice as fast) */
  backlogSpeedMultiplier: number;
  /** Show backlog loading indicator */
  showBacklogIndicator: boolean;
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
  private config: BacklogControllerConfig;
  private lanes: number;
  private observability: ObservabilityReporter | undefined;
  private realTimeActivityCount = 0;
  private realTimeActivityTimers: ReturnType<typeof setTimeout>[] = [];
  private readonly ADAPTIVE_COOLDOWN_MS = 2000;

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
      const now = performance.now();
      filtered = messages.filter((m) => now - m.timestamp < cutoffMs);
      log.debug(
        `Backlog recent mode: ${messages.length} → ${filtered.length} ` +
          `(last ${this.config.backlogRecentMinutes} min)`
      );
    }

    // Apply sampling based on backlog size
    const sampled = this.sampleMessages(filtered);
    this.backlogQueue = sampled;
    this.totalBacklog = sampled.length;
    this.processedBacklog = 0;
    this.isActive = true;

    log.debug(`Backlog injection: ${messages.length} messages, sampled to ${sampled.length}`);

    // Show indicator
    if (this.config.showBacklogIndicator) {
      this.showIndicator();
    }

    // Report to observability
    this.observability?.updateBacklogProgress(0);

    // Start throttled injection
    this.startInjection();
  }

  /** Notify the controller that a real-time message arrived during injection. */
  notifyRealTimeActivity(): void {
    this.realTimeActivityCount = Math.min(this.realTimeActivityCount + 1, 5);
    const timer = setTimeout(() => {
      this.realTimeActivityCount = Math.max(0, this.realTimeActivityCount - 1);
    }, this.ADAPTIVE_COOLDOWN_MS);
    this.realTimeActivityTimers.push(timer);
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

  /** Execute one injection tick */
  private processTick(): void {
    if (!this.isActive || this.backlogQueue.length === 0) {
      this.isInjecting = false;
      if (this.backlogQueue.length === 0) this.finishBacklogInjection();
      return;
    }

    const maxRate = Math.max(4, Math.min(20, Math.min(this.config.backlogMaxRate, this.lanes * 2)));
    const realTimeFactor = Math.max(0.25, 1 - this.realTimeActivityCount * 0.2);
    const adaptiveRate = Math.max(1, Math.round(maxRate * realTimeFactor));
    const tickInterval = Math.round(1000 / adaptiveRate);

    const message = this.backlogQueue.shift();
    if (!message) return;
    message.isBacklog = true;
    this.processedBacklog++;

    const progress = this.totalBacklog > 0 ? this.processedBacklog / this.totalBacklog : 1;
    this.observability?.updateBacklogProgress(progress);

    if (this.config.showBacklogIndicator) {
      this.updateIndicator(progress);
    }

    this.emitBacklogMessage(message);

    this.injectionTimer = setTimeout(() => this.processTick(), tickInterval);
  }

  /** Emit a single backlog message to the renderer via callback */
  private emitBacklogMessage(message: ChatMessage): void {
    if (this.onBacklogMessage) {
      this.onBacklogMessage(message);
    }
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

    const tier1 = messages.filter(isPriority);
    const tier2 = messages.filter(isSubstantialText);
    const tier2Ids = new Set(tier2);
    const tier3 = messages.filter((m) => !isPriority(m) && !tier2Ids.has(m));

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

    return selected.sort((a, b) => a.timestamp - b.timestamp);
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
    this.indicatorEl.textContent = `Loading chat history... ${pct}%`;
  }

  private hideIndicator(): void {
    if (!this.indicatorEl) return;
    this.indicatorEl.style.opacity = '0';
    setTimeout(() => {
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
    for (const timer of this.realTimeActivityTimers) {
      clearTimeout(timer);
    }
    this.realTimeActivityTimers = [];
    this.backlogQueue = [];
    this.hideIndicator();
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
      this.injectionTimer = setTimeout(() => this.processTick(), 500);
    }
  }
}
