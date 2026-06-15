// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

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
 *    60%/35% sampling. High-priority messages (SuperChat, Membership) are
 *    always included.
 * 4. Density ramp — injection rate starts low and linearly ramps up over
 *    the first few seconds to avoid visual flooding on startup.
 * 5. Progress indicator — shows a "Loading chat history..." overlay indicator
 *    that auto-removes when backlog injection completes.
 */

import type { BacklogMode, ChatMessage, Pauseable } from '@app-types';
import { BACKLOG_INDICATOR_BG, DEFAULT_FONT_FAMILY, INDICATOR_Z_INDEX } from '@core/design-tokens';
import { clearSafeTimeout } from '@core/dom';
import { t } from '@core/i18n';
import { createLogger } from '@core/logging';
import { sampleExponential } from '@core/math-utils';
import type { ObservabilityReporter } from '@core/observability';

/** Offset threshold at which the backlog queue ring buffer is compacted via slice(). */
const BACKLOG_QUEUE_COMPACT_THRESHOLD = 64;

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
  /** Max injection rate (msg/s) for backlog controller */
  backlogInjectionMax: number;
  /** Density ramp duration in ms */
  backlogDensityRampMs: number;
  /** Max density ramp duration for large backlogs (ms) */
  backlogDensityRampMaxMs: number;
  /** Minimum backlog injection rate (msg/s) */
  backlogInjectionRateMin: number;
}

/**
 * Priority-check helper shared by sampling, partitioning, and sorting.
 * Returns true for messages that should always be shown (SuperChat, Membership).
 */
function isPriorityMessage(m: ChatMessage): boolean {
  return m.kind === 'superchat' || m.kind === 'membership';
}

/**
 * Get the priority sort order for message kinds.
 * Lower number = higher priority (SuperChat → Membership → regular).
 */
function prioritySortOrder(kind: ChatMessage['kind']): number {
  return kind === 'superchat' ? 0 : kind === 'membership' ? 1 : 2;
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
  /** Callback to be set by RuntimeSession */
  public onBacklogMessage: ((message: ChatMessage) => void) | null = null;

  // backlogDensityRampMs — read from this.config
  private densityRampMs: number;

  // ── Injection rate constants ────────────────────────────────────
  // backlogInjectionRateMin — read from this.config
  private static readonly REAL_TIME_ACTIVITY_CAP = 5;
  private static readonly REAL_TIME_FACTOR_MIN = 0.25;
  private static readonly REAL_TIME_FACTOR_STEP = 0.2;
  private static readonly UTILIZATION_FACTOR_MIN = 0.1;
  private static readonly UTILIZATION_FACTOR_SLOPE = 0.9;
  private static readonly DENSITY_SMALL_THRESHOLD = 200;
  private static readonly DENSITY_LARGE_THRESHOLD = 500;
  private static readonly SAMPLE_RATIO_SMALL = 0.6;
  private static readonly SAMPLE_RATIO_LARGE = 0.35;
  private static readonly INDICATOR_HIDE_DELAY_MS = 300;

  /** Effective length of the backlog queue (excluding consumed offset entries). */
  private get backlogQueueLength(): number {
    return this.backlogQueue.length - this.backlogQueueOffset;
  }

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

  /**
   * Filter messages based on the configured backlog mode.
   * - 'none': returns empty array (no backlog at all).
   * - 'recent': returns only messages within the configured time window.
   * - otherwise: returns all messages unfiltered.
   */
  private filterByMode(allMessages: ChatMessage[], now: number): ChatMessage[] {
    if (this.config.backlogMode === 'none') return [];
    if (this.config.backlogMode === 'recent') {
      const cutoffMs = this.config.backlogRecentMinutes * 60 * 1000;
      return allMessages.filter((m) => now - m.timestamp < cutoffMs);
    }
    return allMessages;
  }

  /**
   * Split messages into priority (SuperChat/Membership) and regular groups.
   * Priority messages are emitted immediately during backlog injection;
   * regular messages go through the throttled queue.
   */
  private extractPriorityMessages(messages: ChatMessage[]): {
    priority: ChatMessage[];
    regular: ChatMessage[];
  } {
    const priority: ChatMessage[] = [];
    const regular: ChatMessage[] = [];
    for (const msg of messages) {
      if (isPriorityMessage(msg)) {
        priority.push(msg);
      } else {
        regular.push(msg);
      }
    }
    return { priority, regular };
  }

  constructor(
    config: BacklogControllerConfig,
    lanes: number,
    observability?: ObservabilityReporter
  ) {
    this.config = config;
    this.lanes = lanes;
    this.observability = observability;
    this.densityRampMs = config.backlogDensityRampMs;
  }

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
      if (added > 0)
        log.debug(
          `Backlog injection in progress, queued ${added} additional (${messages.length - added} duplicates skipped)`
        );
      return;
    }

    // Mode-based filtering (handles 'none' by returning early before
    // starting any observability or UI state changes).
    if (this.config.backlogMode === 'none') {
      log.debug('Backlog mode is "none", skipping injection');
      return;
    }

    const now = Date.now();
    const filtered = this.filterByMode(messages, now);

    // Log recent mode filtering summary
    if (this.config.backlogMode === 'recent') {
      log.debug(
        `Backlog recent mode: ${messages.length} → ${filtered.length} ` +
          `(last ${this.config.backlogRecentMinutes} min)`
      );
    }

    // Statistical sampling + priority extraction
    const sampled = this.sampleMessages(filtered);
    const { priority: priorityMessages, regular: normalMessages } =
      this.extractPriorityMessages(sampled);

    // Priority messages bypass the throttled queue and are emitted
    // immediately for minimum display latency. When the injector is
    // paused (lane utilization > 80%), prepend them to the normal queue
    // instead — they surface first when injection resumes.
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

    // Setup backlog queue state and dedup tracking
    this.backlogQueue = queueMessages;
    this.backlogSeenIds = new Set<string>();
    for (const msg of queueMessages) {
      if (msg.id) this.backlogSeenIds.add(msg.id);
    }
    this.totalBacklog = queueMessages.length;
    this.processedBacklog = 0;
    this.isActive = queueMessages.length > 0;
    this.injectionStartTime = now;

    // Adapt density ramp duration to backlog size.
    // Small backlogs (<200) use the base ramp; large backlogs (>=500)
    // extend up to DENSITY_RAMP_MAX_MS to prevent visual flooding.
    const backlogSize = sampled.length;
    if (backlogSize >= BacklogInjectionController.DENSITY_LARGE_THRESHOLD) {
      this.densityRampMs = this.config.backlogDensityRampMaxMs;
    } else if (backlogSize >= BacklogInjectionController.DENSITY_SMALL_THRESHOLD) {
      const t =
        (backlogSize - BacklogInjectionController.DENSITY_SMALL_THRESHOLD) /
        (BacklogInjectionController.DENSITY_LARGE_THRESHOLD -
          BacklogInjectionController.DENSITY_SMALL_THRESHOLD); // 0 at 200, 1 at 500
      this.densityRampMs = Math.round(
        this.config.backlogDensityRampMs +
          t * (this.config.backlogDensityRampMaxMs - this.config.backlogDensityRampMs)
      );
    } else {
      this.densityRampMs = this.config.backlogDensityRampMs;
    }

    log.debug(`Backlog injection: ${messages.length} messages, sampled to ${sampled.length}`);
    this.showIndicator();
    this.observability?.updateBacklogProgress(0);
    this.startInjection();
  }

  /** Notify the controller that a real-time message arrived during injection. */
  notifyRealTimeActivity(): void {
    this.realTimeActivityCount = Math.min(
      this.realTimeActivityCount + 1,
      BacklogInjectionController.REAL_TIME_ACTIVITY_CAP
    );
  }

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

    const maxRate = Math.max(
      this.config.backlogInjectionRateMin,
      Math.min(this.config.backlogInjectionMax, this.config.backlogMaxRate, this.lanes * 2)
    );
    const realTimeFactor = Math.max(
      BacklogInjectionController.REAL_TIME_FACTOR_MIN,
      1 - this.realTimeActivityCount * BacklogInjectionController.REAL_TIME_FACTOR_STEP
    );
    const rampFactor = this.getDensityRampFactor();
    const utilizationFactor = this.getUtilizationFactor();
    const adaptiveRate = Math.max(
      1,
      Math.round(maxRate * realTimeFactor * rampFactor * utilizationFactor)
    );
    const meanInterval = Math.round(1000 / adaptiveRate);

    this.realTimeActivityCount = Math.max(0, this.realTimeActivityCount - 1);

    const message = this.dequeueBacklog();
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
    return Math.max(
      BacklogInjectionController.UTILIZATION_FACTOR_MIN,
      1 - utilization * BacklogInjectionController.UTILIZATION_FACTOR_SLOPE
    );
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

  /** Apply smart sampling based on message importance and time distribution. */
  private sampleMessages(messages: ChatMessage[]): ChatMessage[] {
    const count = messages.length;
    if (count < 200) return messages;

    const isSubstantialText = (m: ChatMessage): boolean => {
      if (isPriorityMessage(m)) return false;
      const text = m.text.trim();
      return text.length >= 3 && !/^[\sㅋㅎㅇㄱ]+$/.test(text);
    };

    // Partition into priority / substantial / other tiers in a single pass.
    const tier1: ChatMessage[] = [];
    const tier2: ChatMessage[] = [];
    const tier3: ChatMessage[] = [];
    for (const m of messages) {
      if (isPriorityMessage(m)) {
        tier1.push(m);
      } else if (isSubstantialText(m)) {
        tier2.push(m);
      } else {
        tier3.push(m);
      }
    }

    const normalBudget =
      count < BacklogInjectionController.DENSITY_LARGE_THRESHOLD
        ? Math.floor(count * BacklogInjectionController.SAMPLE_RATIO_SMALL)
        : Math.floor(count * BacklogInjectionController.SAMPLE_RATIO_LARGE);

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
      const priorityA = prioritySortOrder(a.kind);
      const priorityB = prioritySortOrder(b.kind);
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
    this.backlogQueueOffset = 0;
    this.backlogSeenIds.clear();
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
      position: fixed; top: 40px; right: 8px; z-index: ${INDICATOR_Z_INDEX};
      background: ${BACKLOG_INDICATOR_BG}; color: #fff;
      font: 12px/1.4 ${DEFAULT_FONT_FAMILY}; padding: 6px 10px;
      border-radius: 4px; pointer-events: none; user-select: none;
      opacity: 0; transition: opacity 0.3s ease;
    `;
    el.textContent = t('Loading chat history...');
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
    this.indicatorEl.textContent = `${t('Loading chat history...')} ${this.processedBacklog}/${this.totalBacklog} (${pct}%)`;
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
    }, BacklogInjectionController.INDICATOR_HIDE_DELAY_MS);
  }

  /** Update config at runtime */
  updateConfig(config: Partial<BacklogControllerConfig>): void {
    this.config = { ...this.config, ...config };
    this.densityRampMs = this.config.backlogDensityRampMs;
  }

  /** Clean up */
  destroy(): void {
    this.isActive = false;
    this.isInjecting = false;
    this.injectionTimer = clearSafeTimeout(this.injectionTimer);
    this.hideIndicatorTimer = clearSafeTimeout(this.hideIndicatorTimer);
    this.backlogQueue = [];
    this.backlogQueueOffset = 0;
    this.backlogSeenIds.clear();
    if (this.indicatorEl) {
      this.indicatorEl.remove();
      this.indicatorEl = null;
    }
    this.onBacklogMessage = null;
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
}
