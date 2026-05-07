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

const log = createLogger('[Backlog]');

export interface BacklogControllerConfig {
  /** Max messages per second during backlog injection */
  backlogMaxRate: number;
  /** Speed multiplier for backlog messages (2 = twice as fast) */
  backlogSpeedMultiplier: number;
  /** Show backlog loading indicator */
  showBacklogIndicator: boolean;
}

export interface BacklogInjectionStats {
  totalBacklog: number;
  processedBacklog: number;
  progress: number; // 0-1
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

    // Apply sampling based on backlog size
    const sampled = this.sampleMessages(messages);
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

  /** Start the throttled injection loop */
  private startInjection(): void {
    if (this.isInjecting || !this.isActive || this.backlogQueue.length === 0) {
      if (this.backlogQueue.length === 0) this.finishBacklogInjection();
      return;
    }

    this.isInjecting = true;

    // Calculate rate: min(config.maxRate, laneCount * 2), clamped to 4-20
    const maxRate = Math.max(4, Math.min(20, Math.min(this.config.backlogMaxRate, this.lanes * 2)));
    // Calculate interval between ticks
    const tickInterval = maxRate > 0 ? Math.round(1000 / maxRate) : 250;

    const processTick = () => {
      if (!this.isActive || this.backlogQueue.length === 0) {
        this.isInjecting = false;
        if (this.backlogQueue.length === 0) this.finishBacklogInjection();
        return;
      }

      // Process one message per tick
      const message = this.backlogQueue.shift()!;
      message.isBacklog = true;
      this.processedBacklog++;

      // Update progress
      const progress = this.totalBacklog > 0 ? this.processedBacklog / this.totalBacklog : 1;
      this.observability?.updateBacklogProgress(progress);

      // Update indicator
      if (this.config.showBacklogIndicator) {
        this.updateIndicator(progress);
      }

      // Emit single message for rendering
      this.emitBacklogMessage(message);

      // Schedule next tick
      this.injectionTimer = setTimeout(processTick, tickInterval);
    };

    processTick();
  }

  /** Emit a single backlog message to the renderer via callback */
  private emitBacklogMessage(message: ChatMessage): void {
    if (this.onBacklogMessage) {
      this.onBacklogMessage(message);
    }
  }

  /** Callback to be set by RuntimeSession */
  public onBacklogMessage: ((message: ChatMessage) => void) | null = null;

  /** Apply sampling based on backlog size */
  private sampleMessages(messages: ChatMessage[]): ChatMessage[] {
    const count = messages.length;
    // Always keep high-priority messages (SuperChat, Membership)
    // Use string comparison to handle runtime kind values not in the type.
    const highPriority = messages.filter((m) => {
      const kind = m.kind;
      return kind === 'superchat' || kind === 'membership';
    });
    const normal = messages.filter((m) => {
      const kind = m.kind;
      return kind !== 'superchat' && kind !== 'membership';
    });

    let sampleCount: number;
    if (count < 200) {
      sampleCount = count; // Keep all
    } else if (count < 500) {
      sampleCount = Math.floor(count * 0.5); // 50%
    } else {
      sampleCount = Math.floor(count * 0.25); // 25%
    }
    // Ensure high-priority messages are always included
    sampleCount = Math.max(sampleCount, highPriority.length);

    // Take high-priority + random sample of normal messages
    const normalSample = this.randomSample(normal, Math.max(0, sampleCount - highPriority.length));
    return [...highPriority, ...normalSample].sort((a, b) => {
      // Sort by timestamp ascending (oldest first)
      return a.timestamp - b.timestamp;
    });
  }

  private randomSample<T>(arr: T[], count: number): T[] {
    if (count >= arr.length) return [...arr];
    const shuffled = [...arr];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const tmp = shuffled[i]!;
      shuffled[i] = shuffled[j]!;
      shuffled[j] = tmp;
    }
    return shuffled.slice(0, count);
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
    Object.assign(this.config, config);
  }

  /** Clean up */
  destroy(): void {
    this.isActive = false;
    this.isInjecting = false;
    if (this.injectionTimer !== null) {
      clearTimeout(this.injectionTimer);
      this.injectionTimer = null;
    }
    this.backlogQueue = [];
    this.hideIndicator();
    this.onBacklogMessage = null;
  }
}
