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
import { isPriorityMessage } from '@util/backlog-helpers';
import { BacklogIndicator } from '@util/backlog-indicator';
import { BacklogSampler } from '@util/backlog-sampler';
import { BacklogScheduler } from '@util/backlog-scheduler';
import { clearSafeTimeout } from '@util/dom';
import { createLogger } from '@util/logging';
import type { ObservabilityReporter } from '@util/observability';

/** Offset threshold at which the backlog queue ring buffer is compacted via slice(). */
const BACKLOG_QUEUE_COMPACT_THRESHOLD = 64;

const log = createLogger('Backlog');

type BacklogCapacityDropReason =
  | 'overflow-ordinary-evicted'
  | 'ordinary-capacity-full'
  | 'protected-capacity-full'
  | 'capacity-reduction-ordinary'
  | 'capacity-reduction-protected';

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
  /** Maximum number of messages retained for pending backlog delivery. */
  pendingCapacity: number;
}

export class BacklogInjectionController implements Pauseable {
  private backlogQueue: (ChatMessage | undefined)[] = [];
  private backlogQueueOffset = 0;
  private pendingCount = 0;
  private ordinaryPendingCount = 0;
  /** Monotonic cursor makes ordinary-slot searches aggregate O(capacity). */
  private ordinarySearchCursor = 0;
  /** Test-visible performance counters; no message data is retained. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Security regression tests inspect this counter without widening the production API.
  private capacityScanSteps = 0;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Security regression tests inspect this counter without widening the production API.
  private trackingRebuildCount = 0;
  private backlogSeenIds = new Set<string>();
  private backlogPendingIndices = new Map<string, number>();
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
  /** Fixed-key counters aggregate capacity diagnostics without log flooding. */
  private readonly capacityDropCounts: Record<BacklogCapacityDropReason, number> = {
    'overflow-ordinary-evicted': 0,
    'ordinary-capacity-full': 0,
    'protected-capacity-full': 0,
    'capacity-reduction-ordinary': 0,
    'capacity-reduction-protected': 0,
  };

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
  /** Callback for replacement targets already accepted outside this backlog. */
  public isKnownMessageId: ((id: string) => boolean) | null = null;
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
    while (this.backlogQueueOffset < this.backlogQueue.length) {
      const dequeuedIndex = this.backlogQueueOffset++;
      const message = this.backlogQueue[dequeuedIndex];
      this.backlogQueue[dequeuedIndex] = undefined;
      this.ordinarySearchCursor = Math.max(this.ordinarySearchCursor, this.backlogQueueOffset);
      if (!message) continue;

      this.pendingCount--;
      if (!BacklogInjectionController.isProtectedPendingMessage(message)) {
        this.ordinaryPendingCount--;
      }
      this.removePendingIdentity(message, dequeuedIndex);

      if (this.backlogQueueOffset > BACKLOG_QUEUE_COMPACT_THRESHOLD) {
        this.compactPendingQueue();
      }
      return message;
    }
    return undefined;
  }

  private rebuildPendingTracking(): void {
    this.trackingRebuildCount++;
    this.backlogPendingIndices.clear();
    this.backlogSeenIds.clear();
    this.pendingCount = 0;
    this.ordinaryPendingCount = 0;
    for (let index = this.backlogQueueOffset; index < this.backlogQueue.length; index++) {
      const message = this.backlogQueue[index];
      if (!message) continue;
      this.pendingCount++;
      if (!BacklogInjectionController.isProtectedPendingMessage(message)) {
        this.ordinaryPendingCount++;
      }
      const id = message.id;
      if (id && !this.backlogPendingIndices.has(id)) {
        this.backlogPendingIndices.set(id, index);
        this.backlogSeenIds.add(id);
      }
    }
    this.ordinarySearchCursor = this.backlogQueueOffset;
  }

  private get pendingCapacity(): number {
    const configured = Math.floor(this.config.pendingCapacity);
    return Number.isFinite(configured) ? Math.max(1, configured) : 1;
  }

  private static isProtectedPendingMessage(message: ChatMessage): boolean {
    return message.actionType === 'replace' || isPriorityMessage(message);
  }

  private clearPendingState(): void {
    this.backlogQueue = [];
    this.backlogQueueOffset = 0;
    this.pendingCount = 0;
    this.ordinaryPendingCount = 0;
    this.ordinarySearchCursor = 0;
    this.backlogSeenIds.clear();
    this.backlogPendingIndices.clear();
  }

  private removePendingIdentity(message: ChatMessage, index: number): void {
    if (message.id && this.backlogPendingIndices.get(message.id) === index) {
      this.backlogPendingIndices.delete(message.id);
      this.backlogSeenIds.delete(message.id);
    }
  }

  private addPendingIdentity(message: ChatMessage, index: number): void {
    if (!message.id) return;
    this.backlogSeenIds.add(message.id);
    this.backlogPendingIndices.set(message.id, index);
  }

  private compactPendingQueue(): void {
    const compacted: ChatMessage[] = [];
    for (let index = this.backlogQueueOffset; index < this.backlogQueue.length; index++) {
      const message = this.backlogQueue[index];
      if (message) compacted.push(message);
    }
    this.backlogQueue = compacted;
    this.backlogQueueOffset = 0;
    this.rebuildPendingTracking();
  }

  private findOldestOrdinaryIndex(): number | null {
    if (this.ordinaryPendingCount === 0) return null;
    const start = Math.max(this.backlogQueueOffset, this.ordinarySearchCursor);
    for (let index = start; index < this.backlogQueue.length; index++) {
      this.capacityScanSteps++;
      const message = this.backlogQueue[index];
      if (!message) continue;
      if (!BacklogInjectionController.isProtectedPendingMessage(message)) {
        this.ordinarySearchCursor = index + 1;
        return index;
      }
    }
    // Defensive invariant recovery: do not repeat a full scan on hostile input.
    this.ordinaryPendingCount = 0;
    this.ordinarySearchCursor = this.backlogQueue.length;
    return null;
  }

  private recordCapacityDrop(message: ChatMessage, reason: BacklogCapacityDropReason): void {
    const count = ++this.capacityDropCounts[reason];
    this.observability?.onMessageReceived();
    this.observability?.onMessageDropped(
      reason === 'protected-capacity-full' || reason === 'ordinary-capacity-full'
        ? 'queue_priority'
        : 'queue_replaced'
    );

    const details = {
      reason,
      count,
      capacity: this.pendingCapacity,
      pending: this.backlogQueueLength,
      kind: message.kind,
      actionType: message.actionType ?? 'add',
    };
    if (reason === 'protected-capacity-full' || reason === 'capacity-reduction-protected') {
      // One warning per reason is enough evidence without making a hostile
      // batch amplify into an unbounded console workload.
      if (count === 1) log.warn('backlog.capacity.drop', details);
    } else if (count === 1) {
      log.debug('backlog.capacity.drop', details);
    }
  }

  private trimPendingToCapacity(): void {
    let toRemove = this.pendingCount - this.pendingCapacity;
    if (toRemove <= 0) return;

    // One bounded pass removes ordinary work first.
    for (
      let index = this.backlogQueueOffset;
      index < this.backlogQueue.length && toRemove > 0;
      index++
    ) {
      this.capacityScanSteps++;
      const message = this.backlogQueue[index];
      if (!message || BacklogInjectionController.isProtectedPendingMessage(message)) continue;
      this.backlogQueue[index] = undefined;
      this.pendingCount--;
      this.ordinaryPendingCount--;
      this.removePendingIdentity(message, index);
      this.recordCapacityDrop(message, 'capacity-reduction-ordinary');
      toRemove--;
    }

    // A second bounded pass removes protected work only when unavoidable.
    for (
      let index = this.backlogQueueOffset;
      index < this.backlogQueue.length && toRemove > 0;
      index++
    ) {
      this.capacityScanSteps++;
      const message = this.backlogQueue[index];
      if (!message) continue;
      this.backlogQueue[index] = undefined;
      this.pendingCount--;
      this.removePendingIdentity(message, index);
      this.recordCapacityDrop(message, 'capacity-reduction-protected');
      toRemove--;
    }

    this.compactPendingQueue();
  }

  private syncTotalBacklog(): void {
    this.totalBacklog = this.processedBacklog + this.backlogQueueLength;
    if (this.isActive) {
      const progress = this.totalBacklog > 0 ? this.processedBacklog / this.totalBacklog : 1;
      this.observability?.updateBacklogProgress(progress);
      this.indicator.update(this.processedBacklog, this.totalBacklog);
    }
  }

  /**
   * Append messages in arrival order while filtering duplicate add actions.
   * Replacements update an undelivered entry in place, or are appended when
   * the prior version was already emitted, so ID dedup never discards them.
   */
  private appendMessage(message: ChatMessage): boolean {
    const id = message.id;
    if (message.actionType === 'replace') {
      if (!id) return false;
      const pendingIndex = this.backlogPendingIndices.get(id);
      if (pendingIndex !== undefined) {
        const previous = this.backlogQueue[pendingIndex];
        if (previous && !BacklogInjectionController.isProtectedPendingMessage(previous)) {
          this.ordinaryPendingCount--;
        }
        this.backlogQueue[pendingIndex] = message;
        return false;
      }

      if (this.isKnownMessageId?.(id) !== true) return false;
    } else if (id && (this.backlogSeenIds.has(id) || this.isKnownMessageId?.(id) === true)) {
      return false;
    }

    return this.appendValidatedMessage(message);
  }

  private appendValidatedMessage(message: ChatMessage): boolean {
    if (this.pendingCount >= this.pendingCapacity) {
      if (!BacklogInjectionController.isProtectedPendingMessage(message)) {
        this.recordCapacityDrop(message, 'ordinary-capacity-full');
        return false;
      }
      if (this.ordinaryPendingCount === 0) {
        this.recordCapacityDrop(message, 'protected-capacity-full');
        return false;
      }

      const replacementIndex = this.findOldestOrdinaryIndex();
      if (replacementIndex === null) {
        this.recordCapacityDrop(message, 'protected-capacity-full');
        return false;
      }
      const evicted = this.backlogQueue[replacementIndex];
      if (!evicted) return false;
      this.removePendingIdentity(evicted, replacementIndex);
      this.backlogQueue[replacementIndex] = message;
      this.ordinaryPendingCount--;
      this.addPendingIdentity(message, replacementIndex);
      this.recordCapacityDrop(evicted, 'overflow-ordinary-evicted');
      return true;
    }

    const pendingIndex = this.backlogQueue.length;
    this.backlogQueue.push(message);
    this.pendingCount++;
    if (!BacklogInjectionController.isProtectedPendingMessage(message)) {
      this.ordinaryPendingCount++;
    }
    this.addPendingIdentity(message, pendingIndex);
    return true;
  }

  private appendUniqueMessages(messages: readonly ChatMessage[]): number {
    let added = 0;
    for (const message of messages) {
      if (this.appendMessage(message)) added++;
    }
    return added;
  }

  private isInitialMessageInMode(message: ChatMessage, now: number): boolean {
    if (this.config.backlogMode !== 'recent') return true;
    const cutoffMs = this.config.backlogRecentMinutes * 60_000;
    return now - message.timestamp < cutoffMs;
  }

  /**
   * Perform one-pass bounded admission before sampling creates any copies.
   * The controller's normal pending maps double as the bounded candidate
   * identity state, then are cleared before the sampled result is enqueued.
   */
  private collectInitialCandidates(messages: readonly ChatMessage[], now: number): ChatMessage[] {
    this.clearPendingState();
    for (const message of messages) {
      if (!this.isInitialMessageInMode(message, now)) continue;
      this.appendMessage(message);
    }

    const candidates = this.drainPending();
    this.clearPendingState();
    return candidates;
  }

  // ── Public API ───────────────────────────────────────────

  /** Called when initial seed messages arrive */
  startBacklogInjection(messages: ChatMessage[]): void {
    if (messages.length === 0) return;

    // If already injecting, queue additional messages into the existing
    // injection rather than resetting state and losing progress.
    if (this.isInjecting) {
      const added = this.appendUniqueMessages(messages);
      this.syncTotalBacklog();
      if (added > 0) {
        log.debug('backlog.injection-queued', { added, total: this.totalBacklog });
      }
      return;
    }

    // When injection is paused (render queue over capacity), merge new
    // messages into the existing backlog rather than replacing the queue
    // and silently discarding pending messages.
    if (this.paused && this.backlogQueue.length > 0) {
      const added = this.appendUniqueMessages(messages);
      this.syncTotalBacklog();
      if (added > 0) {
        log.debug('backlog.paused-merge', { added, total: this.totalBacklog });
      }
      return;
    }

    // Mode-based filtering (handles 'none' by returning early)
    if (this.config.backlogMode === 'none') {
      log.debug('backlog.mode-none');
      return;
    }

    const now = Date.now();
    const candidates = this.collectInitialCandidates(messages, now);
    if (this.config.backlogMode === 'recent') {
      log.debug('backlog.recent-filtered', {
        total: messages.length,
        admitted: candidates.length,
        recentMinutes: this.config.backlogRecentMinutes,
      });
    }

    // Sampling and partitioning operate only on the bounded candidate set.
    const sampled = this.sampler.sampleMessages(candidates);
    const { priority: priorityMessages, regular: normalMessages } =
      this.sampler.extractPriorityMessages(sampled);

    this.clearPendingState();
    this.processedBacklog = 0;

    // Priority work remains first, but is metered through the same queue.
    for (const message of priorityMessages) this.appendValidatedMessage(message);
    for (const message of normalMessages) this.appendValidatedMessage(message);
    this.syncTotalBacklog();
    this.isActive = this.totalBacklog > 0;
    this.injectionStartTime = now;
    this.realTimeActivityCount = 0;
    this.lastRealTimeActivityAt = 0;

    // Adapt density ramp duration to backlog size
    this.scheduler.setDensityRampMs(this.scheduler.computeDensityRampMs(sampled.length));

    log.debug('backlog.sampled', {
      total: messages.length,
      admitted: candidates.length,
      sampled: sampled.length,
    });
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
    this.trimPendingToCapacity();
    this.syncTotalBacklog();
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
    this.clearPendingState();
    this.totalBacklog = 0;
    this.processedBacklog = 0;
    this.isKnownMessageId = null;
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
    if (!message) {
      this.finishBacklogInjection();
      return;
    }
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
    this.clearPendingState();
    this.totalBacklog = 0;
    this.processedBacklog = 0;
    this.observability?.updateBacklogProgress(1);
    this.indicator.hide();
    log.debug('backlog.injection-complete');
  }

  /** Effective length of the backlog queue (excluding consumed offset entries). */
  private get backlogQueueLength(): number {
    return this.pendingCount;
  }
}
