// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * BacklogInjectionController
 *
 * Lightweight orchestrator that throttles injection of initial backlog
 * messages when a video is first opened, preventing the queue from being
 * flooded with hundreds of messages at once.
 *
 * Delegates to:
 * - BacklogScheduler — rate computation, density ramp, Poisson scheduling
 * - BacklogSampler   — statistical sampling, priority filtering
 * - BacklogIndicator — DOM-based progress overlay
 *
 * Strategies:
 * 1. Time-based throttling — injection rate control per lane count
 * 2. Temporal compression — animation duration shortening (via getSpeedMultiplier)
 * 3. Statistical sampling — priority-based sampling at thresholds
 * 4. Density ramp — linear rate increase over time
 * 5. Progress indicator — overlay UI with auto-removal
 */

import type { BacklogMode, ChatMessage, Pauseable } from '@app-types';
import { BacklogIndicator } from '@util/backlog-indicator';
import { BacklogSampler } from '@util/backlog-sampler';
import { BacklogScheduler } from '@util/backlog-scheduler';
import { clearSafeTimeout } from '@util/dom';
import { createLogger } from '@util/logging';
import type { ObservabilityReporter } from '@util/observability';

/** Offset threshold at which the backlog queue ring buffer is compacted via slice(). */
const BACKLOG_QUEUE_COMPACT_THRESHOLD = 64;

const log = createLogger('Backlog');

export interface BacklogControllerConfig {
  /** How to handle past chat messages */
  backlogMode: BacklogMode;
  /** Max messages per second during backlog injection */
  backlogMaxRate: number;
  /** Speed multiplier for backlog message animations (2 = twice as fast) */
  backlogSpeedMultiplier: number;
  /** For 'recent' mode: how many minutes of past chat to show */
  backlogRecentMinutes: number;
  /** Max injection rate (msg/s) for backlog controller */
  backlogInjectionMax: number;
  /** Density ramp duration in ms */
  backlogDensityRampMs: number;
  /** Max density ramp duration for large backlogs (ms) */
  backlogDensityRampMaxMs: number;
  /** Minimum backlog injection rate (msg/s) */
  backlogInjectionRateMin: number;
}

export class BacklogInjectionController implements Pauseable {
  private backlogQueue: (ChatMessage | undefined)[] = [];
  private backlogQueueOffset = 0;
  private backlogSeenIds = new Set<string>();
  private isActive = false;
  private isInjecting = false;
  private paused = false;
  private injectionTimer: ReturnType<typeof setTimeout> | null = null;
  private totalBacklog = 0;
  private processedBacklog = 0;
  private config: BacklogControllerConfig;
  private observability: ObservabilityReporter | undefined;
  private realTimeActivityCount = 0;
  private lastRealTimeActivityAt = 0;
  private injectionStartTime = 0;

  /** Delegated modules */
  private readonly scheduler: BacklogScheduler;
  private readonly sampler: BacklogSampler;
  private readonly indicator: BacklogIndicator;

  /**
   * Callback to query current lane utilization (0–1).
   * When set, the injection rate is throttled proportionally to how full
   * the screen is — high utilization → slower injection.
   */
  public onUtilizationQuery: (() => number) | null = null;
  /** Callback to be set by RuntimeSession */
  public onBacklogMessage: ((message: ChatMessage) => void) | null = null;

  constructor(
    config: BacklogControllerConfig,
    lanes: number,
    observability?: ObservabilityReporter
  ) {
    this.config = config;
    this.observability = observability;
    this.scheduler = new BacklogScheduler(config, lanes);
    this.sampler = new BacklogSampler();
    this.indicator = new BacklogIndicator();
  }

  // ── Ring buffer ──────────────────────────────────────────

  /**
   * Dequeue the next backlog message using ring-buffer semantics.
   * Marks the slot as undefined and advances the offset pointer.
   * When the offset exceeds 64 entries, compacts via slice() to
   * reclaim memory without splice() overhead on every tick.
   */
  private dequeueBacklog(): ChatMessage | undefined {
    if (this.backlogQueueOffset >= this.backlogQueue.length) {
      return undefined;
    }
    const msg = this.backlogQueue[this.backlogQueueOffset];
    this.backlogQueue[this.backlogQueueOffset] = undefined;
    this.backlogQueueOffset++;

    if (this.backlogQueueOffset > BACKLOG_QUEUE_COMPACT_THRESHOLD) {
      this.backlogQueue = this.backlogQueue.slice(this.backlogQueueOffset);
      this.backlogQueueOffset = 0;
    }
    return msg;
  }

  // ── Public API ───────────────────────────────────────────

  /** Called when initial seed messages arrive */
  startBacklogInjection(messages: ChatMessage[]): void {
    if (messages.length === 0) return;

    // If already injecting, queue additional messages into the existing
    // injection rather than resetting state and losing progress.
    if (this.isInjecting) {
      let added = 0;
      for (const msg of messages) {
        if (!msg.id || !this.backlogSeenIds.has(msg.id)) {
          this.backlogQueue.push(msg);
          if (msg.id) this.backlogSeenIds.add(msg.id);
          added++;
        }
      }
      if (added > 0) {
        this.totalBacklog += added;
        log.debug(
          `Backlog injection in progress, queued ${added} additional (${messages.length - added} duplicates skipped, total now ${this.totalBacklog})`
        );
      }
      return;
    }

    // Mode-based filtering (handles 'none' by returning early)
    if (this.config.backlogMode === 'none') {
      log.debug('Backlog mode is "none", skipping injection');
      return;
    }

    const now = Date.now();
    const filtered = this.sampler.filterByMode(messages, this.config, now);

    if (this.config.backlogMode === 'recent') {
      log.debug(
        `Backlog recent mode: ${messages.length} → ${filtered.length} ` +
          `(last ${this.config.backlogRecentMinutes} min)`
      );
    }

    // Statistical sampling + priority extraction
    const sampled = this.sampler.sampleMessages(filtered);
    const { priority: priorityMessages, regular: normalMessages } =
      this.sampler.extractPriorityMessages(sampled);

    // Priority messages bypass the throttled queue
    let queueMessages: ChatMessage[] = normalMessages;
    if (priorityMessages.length > 0) {
      if (this.paused) {
        queueMessages = [...priorityMessages, ...normalMessages];
      } else {
        for (const msg of priorityMessages) {
          msg.isBacklog = true;
          this.onBacklogMessage?.(msg);
        }
        log.debug(`Backlog: emitted ${priorityMessages.length} priority messages immediately`);
      }
    }

    // Setup backlog queue state
    this.backlogQueue = queueMessages;
    this.backlogSeenIds = new Set<string>();
    for (const msg of queueMessages) {
      if (msg.id) this.backlogSeenIds.add(msg.id);
    }
    this.totalBacklog = queueMessages.length;
    this.processedBacklog = 0;
    this.isActive = queueMessages.length > 0;
    this.injectionStartTime = now;
    this.realTimeActivityCount = 0;
    this.lastRealTimeActivityAt = 0;

    // Adapt density ramp duration to backlog size
    this.scheduler.setDensityRampMs(this.scheduler.computeDensityRampMs(sampled.length));

    log.debug(`Backlog injection: ${messages.length} messages, sampled to ${sampled.length}`);
    this.indicator.show();
    this.observability?.updateBacklogProgress(0);
    this.startInjection();
  }

  /** Notify the controller that a real-time message arrived during injection. */
  notifyRealTimeActivity(): void {
    this.realTimeActivityCount = Math.min(
      this.realTimeActivityCount + 1,
      BacklogScheduler.REAL_TIME_ACTIVITY_CAP
    );
    this.lastRealTimeActivityAt = Date.now();
  }

  /** Returns the speed multiplier for backlog message animations */
  getSpeedMultiplier(): number {
    return this.config.backlogSpeedMultiplier;
  }

  /** Whether backlog injection is currently active */
  get isBacklogActive(): boolean {
    return this.isActive;
  }

  /** Update config at runtime */
  updateConfig(config: Partial<BacklogControllerConfig>): void {
    this.config = { ...this.config, ...config };
    this.scheduler.updateConfig(config);
  }

  /**
   * Drain undelivered backlog messages for preservation across restarts.
   * Returns all unconsumed messages from the current offset to the end
   * of the queue, without modifying the controller's internal state
   * (caller should destroy() afterward).
   */
  drainPending(): ChatMessage[] {
    if (!this.isActive && this.backlogQueueLength === 0) return [];
    const messages: ChatMessage[] = [];
    for (let i = this.backlogQueueOffset; i < this.backlogQueue.length; i++) {
      const msg = this.backlogQueue[i];
      if (msg !== undefined) messages.push(msg);
    }
    return messages;
  }

  /** Pause/resume injection when the render queue is overloaded */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.isInjecting = false;
      this.injectionTimer = clearSafeTimeout(this.injectionTimer);
    } else if (!this.isInjecting && this.isActive && this.backlogQueueLength > 0) {
      this.isInjecting = true;
      this.processTick();
    }
  }

  /** Clean up */
  destroy(): void {
    this.isActive = false;
    this.isInjecting = false;
    this.injectionTimer = clearSafeTimeout(this.injectionTimer);
    this.indicator.destroy();
    this.backlogQueue = [];
    this.backlogQueueOffset = 0;
    this.backlogSeenIds.clear();
    this.onBacklogMessage = null;
  }

  // ── Injection lifecycle ──────────────────────────────────

  /** Start the throttled injection loop */
  private startInjection(): void {
    if (this.isInjecting || !this.isActive || this.backlogQueueLength === 0) {
      if (this.backlogQueueLength === 0) this.finishBacklogInjection();
      return;
    }

    this.isInjecting = true;
    this.processTick();
  }

  /** Execute one injection tick. Uses setTimeout for throttled scheduling. */
  private processTick(): void {
    if (!this.isActive || this.backlogQueueLength === 0) {
      this.isInjecting = false;
      this.injectionTimer = clearSafeTimeout(this.injectionTimer);
      if (this.backlogQueueLength === 0) this.finishBacklogInjection();
      return;
    }

    const { meanInterval, updatedActivityCount } =
      this.scheduler.computeMeanIntervalWithUtilization(
        this.realTimeActivityCount,
        this.lastRealTimeActivityAt,
        this.injectionStartTime,
        this.onUtilizationQuery
      );
    this.realTimeActivityCount = updatedActivityCount;

    const message = this.dequeueBacklog();
    if (!message) return;
    message.isBacklog = true;
    this.processedBacklog++;

    const progress = this.totalBacklog > 0 ? this.processedBacklog / this.totalBacklog : 1;
    this.observability?.updateBacklogProgress(progress);
    this.indicator.update(this.processedBacklog, this.totalBacklog);
    this.onBacklogMessage?.(message);

    this.injectionTimer = this.scheduler.scheduleNextTick(() => this.processTick(), meanInterval);
  }

  /** Mark backlog injection as complete */
  private finishBacklogInjection(): void {
    this.isActive = false;
    this.isInjecting = false;
    this.backlogQueue = [];
    this.backlogQueueOffset = 0;
    this.backlogSeenIds.clear();
    this.observability?.updateBacklogProgress(1);
    this.indicator.hide();
    log.debug('Backlog injection complete');
  }

  /** Effective length of the backlog queue (excluding consumed offset entries). */
  private get backlogQueueLength(): number {
    return this.backlogQueue.length - this.backlogQueueOffset;
  }
}
