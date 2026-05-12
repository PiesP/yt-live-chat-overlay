/**
 * Renderer
 *
 * Renders chat messages with Nico-nico style flowing animation.
 * Manages lanes and collision detection.
 */

import type { BurstLevel, ChatMessage, OverlayDimensions, OverlaySettings } from '@app-types';
import { PerAuthorRateLimiter } from '@core/author-rate-limiter';
import { BurstDetector } from '@core/burst-detector';
import { buildTextShadow, buildTextStroke, rendererLayout, shadows } from '@core/design-tokens';
import { createLogger } from '@core/logging';
import { ObservabilityReporter } from '@core/observability';
import type { Overlay } from '@core/overlay';
import { LaneAllocator, type LanePlacement } from '@core/renderer-lanes';
import { RendererMessageBuilder } from '@core/renderer-message-builder';
import { RENDERER_STATIC_STYLES } from '@core/renderer-styles';

const log = createLogger('Renderer');

interface QueuedMessage {
  message: ChatMessage;
  nextAttemptAt: number;
  priority: number;
  retries: number; // retry count for dropped messages
}

interface ActiveMessage {
  element: HTMLDivElement;
  readonly startTime: number;
  readonly baseDuration: number;
  readonly baseOpacity: number;
  readonly cleanup: () => void;
  /** Accumulated time (ms) the message spent paused while tab was hidden. */
  pausedDuration: number;
}

type RenderResult =
  | { status: 'rendered' }
  | { status: 'dropped' }
  | { status: 'deferred'; waitMs: number };

interface RenderContext {
  container: HTMLDivElement;
  dimensions: OverlayDimensions;
}

interface RendererUpdateOptions {
  resetState?: boolean;
}

export class Renderer {
  readonly observability: ObservabilityReporter;
  private burstDetector: BurstDetector;
  private authorRateLimiter: PerAuthorRateLimiter;
  private backlogSpeedMultiplier: number = 1;
  private overlay: Overlay;
  private settings: OverlaySettings;
  private readonly laneAllocator: LaneAllocator;
  private readonly messageBuilder: RendererMessageBuilder;
  private activeMessages: Set<ActiveMessage> = new Set();
  private readonly pendingQueue: QueuedMessage[] = [];
  private isPaused = false;
  private isVideoPaused = false;
  private pausedAt: number | null = null;
  private playbackRate = 1;
  private lastWarningTime = 0;
  private backlogPaused = false;
  private static readonly SWEEP_TOLERANCE_MS = 500;
  private static readonly MAX_ANIMATION_JITTER_MS = 15;
  private static readonly QUEUE_MAX_SIZE = 50;
  private static readonly BATCH_SIZE = 8;
  private static readonly MAX_MESSAGE_AGE_MS = 60_000;
  private static readonly OPACITY_UPDATE_INTERVAL_MS = 250;
  private static readonly SWEEP_INTERVAL = 8;
  private static readonly MAX_RETRY_ATTEMPTS = 3;
  private styleElement: HTMLStyleElement | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private opacityUpdateTimer: ReturnType<typeof setInterval> | null = null;
  private overlayDimensionsUnsubscribe: (() => void) | null = null;
  private sweepCounter = 0;
  static readonly BACKGROUND_QUEUE_MAX = 10;
  /** Timestamp until which the EMA speed multiplier is suppressed after resume. */
  private resumeStabilizeUntil: number = 0;
  private processQueueScheduled = false;

  constructor(overlay: Overlay, settings: OverlaySettings) {
    this.overlay = overlay;
    this.settings = settings;
    this.messageBuilder = new RendererMessageBuilder(() => this.settings);
    this.laneAllocator = new LaneAllocator({
      getFontSize: () => this.settings.fontSize,
      getEffectiveSpeedPxPerSec: () => this.getEffectiveSpeedPxPerSec(),
      globalStaggerMs: rendererLayout.globalStaggerMs,
      safeDistanceScale: rendererLayout.safeDistanceScale,
      safeDistanceMin: rendererLayout.safeDistanceMin,
      laneHeightPaddingScale: rendererLayout.laneHeightPaddingScale,
      laneHeightPaddingMin: rendererLayout.laneHeightPaddingMin,
    });
    this.laneAllocator.reset(this.overlay.getDimensions());
    this.injectStyles();
    this.observability = new ObservabilityReporter(this.settings.showDebugOverlay);
    this.burstDetector = new BurstDetector(this.observability);
    this.burstDetector.start();
    this.authorRateLimiter = new PerAuthorRateLimiter(() => this.burstDetector.getLevel());
    this.authorRateLimiter.updateConfig({
      enabled: settings.authorRateLimitEnabled,
      windowMs: settings.authorRateLimitWindowMs,
      maxPerWindow: settings.authorRateLimitMaxMessages,
    });
    this.overlayDimensionsUnsubscribe = this.overlay.onDimensionsChanged((dimensions) => {
      this.handleOverlayDimensionsChange(dimensions);
    });

    this.startOpacityUpdates();
  }

  /** Callback to signal RuntimeSession to pause/resume backlog injection */
  onBacklogPauseChange: ((paused: boolean) => void) | null = null;

  private resetRenderedState(): void {
    this.clearRetryTimer();

    for (const active of [...this.activeMessages]) {
      this.removeMessage(active);
    }

    this.pendingQueue.length = 0;
    this.backlogPaused = false;
  }

  private handleOverlayDimensionsChange(dimensions: OverlayDimensions | null): void {
    if (!dimensions) {
      this.resetRenderedState();
      this.laneAllocator.reset(null);
      return;
    }

    this.laneAllocator.reset(dimensions);

    if (!this.isPaused && this.pendingQueue.length > 0) {
      this.processQueue();
    }
  }

  private injectStyles(): void {
    if (!this.styleElement) {
      this.styleElement = document.createElement('style');
      this.styleElement.textContent = RENDERER_STATIC_STYLES;
      document.head.appendChild(this.styleElement);
    }

    this.updateStyleVariables();
  }

  private updateStyleVariables(): void {
    const container = this.overlay.getContainer();
    if (!container) {
      return;
    }

    const textShadow = buildTextShadow(this.settings.outline);
    const textStroke = buildTextStroke(this.settings.outline);
    const regularMessageTextShadow = [
      textShadow,
      shadows.text.md,
      '0 0 8px rgba(0, 0, 0, 0.7)',
    ].join(', ');
    const superChatBaseOpacity = Math.min(1, Math.max(0.4, this.settings.superChatOpacity));
    const superChatTopOpacity = Math.min(1, superChatBaseOpacity + 0.06);
    const superChatBottomOpacity = Math.max(0.4, superChatBaseOpacity - 0.08);

    container.style.setProperty('--yt-overlay-message-text-shadow', textShadow);
    container.style.setProperty(
      '--yt-overlay-regular-message-text-shadow',
      regularMessageTextShadow
    );
    container.style.setProperty('--yt-overlay-text-stroke', textStroke);
    container.style.setProperty('--yt-overlay-superchat-base-opacity', `${superChatBaseOpacity}`);
    container.style.setProperty('--yt-overlay-superchat-top-opacity', `${superChatTopOpacity}`);
    container.style.setProperty(
      '--yt-overlay-superchat-bottom-opacity',
      `${superChatBottomOpacity}`
    );
  }

  private getRenderContext(): RenderContext | null {
    const container = this.overlay.getContainer();
    const dimensions = this.overlay.getDimensions();

    if (!container?.isConnected || !dimensions) {
      return null;
    }

    return { container, dimensions };
  }

  private setupMessageAnimation(
    element: HTMLDivElement,
    placement: LanePlacement,
    textWidth: number,
    messageHeight: number,
    dimensions: OverlayDimensions,
    message?: ChatMessage,
    baseOpacity?: number
  ): ActiveMessage {
    const fontSize = this.settings.fontSize;
    const { lane } = placement;

    const laneBlockTop =
      dimensions.height * this.settings.safeTop + lane.index * dimensions.laneHeight;
    const laneBlockHeight = placement.laneSpan * dimensions.laneHeight;
    const laneY = laneBlockTop + Math.max(0, (laneBlockHeight - messageHeight) / 2);
    element.style.top = `${laneY}px`;
    element.style.left = `${dimensions.width}px`;
    element.style.visibility = 'visible';

    const exitPadding = Math.max(
      fontSize * rendererLayout.exitPaddingScale,
      rendererLayout.exitPaddingMin
    );
    const distance = dimensions.width + textWidth + exitPadding;

    // Deterministic entry offset based on lane position + small random jitter.
    // Messages arriving at the same time are spread evenly across the right
    // edge of the screen rather than clustering at 3 fixed positions.
    const baseOffset =
      dimensions.laneCount > 1 ? Math.round((lane.index / (dimensions.laneCount - 1)) * 200) : 100;
    const jitter = Math.floor(Math.random() * 30);
    const entryOffset = baseOffset + jitter;
    const adjustedDistance = distance + entryOffset;

    const effectiveSpeedPxPerSec = this.getEffectiveSpeedPxPerSec();
    let baseDuration = Math.max(
      rendererLayout.durationMin,
      Math.min(rendererLayout.durationMax, (adjustedDistance / effectiveSpeedPxPerSec) * 1000)
    );
    if (message?.isBacklog && this.backlogSpeedMultiplier > 1) {
      baseDuration = Math.max(
        rendererLayout.durationMin,
        baseDuration / this.backlogSpeedMultiplier
      );
    }
    const adjustedDuration = baseDuration / this.playbackRate;

    const laneDelay = Math.floor(Math.random() * Renderer.MAX_ANIMATION_JITTER_MS);

    element.style.setProperty('--yt-msg-entry-offset', `${entryOffset}px`);
    element.style.setProperty('--yt-msg-exit-offset', `-${distance}px`);
    element.style.setProperty('--yt-msg-duration', `${adjustedDuration}ms`);
    element.style.setProperty('--yt-msg-delay', `${laneDelay}ms`);
    element.classList.add('yt-overlay-message-animate');

    const now = performance.now();
    const startTime = now + laneDelay;
    this.laneAllocator.commitPlacement(
      placement,
      textWidth,
      messageHeight,
      startTime,
      startTime + adjustedDuration
    );

    const cleanup = (): void => {
      element.removeEventListener('animationend', cleanup);
      this.removeMessageByElement(element);
    };
    element.addEventListener('animationend', cleanup, { once: true });

    return {
      element,
      startTime,
      baseDuration,
      baseOpacity: baseOpacity ?? this.settings.opacity,
      cleanup,
      pausedDuration: 0,
    };
  }

  addMessage(message: ChatMessage): void {
    // Note: message deduplication is handled by RuntimeSession.acceptForRenderer()
    // using the session-level MessageIdRegistry. The renderer trusts that messages
    // it receives are already deduplicated.

    // Drop messages while video is paused — they would queue up and flood on resume.
    if (this.isVideoPaused) {
      this.observability.onMessageDropped('other');
      return;
    }

    this.observability.onMessageReceived();
    this.burstDetector.onMessageReceived();

    const priority = Renderer.getMessagePriority(message);
    if (!this.authorRateLimiter.allow(message.author ?? 'anonymous', priority)) {
      log.debug('Drop [rate_limited]:', message.author, message.kind, message.id);
      this.observability.onMessageDropped('rate_limited');
      return;
    }

    if (this.pendingQueue.length >= Renderer.QUEUE_MAX_SIZE) {
      const lowestPriorityIndex = this.findLowestPriorityIndex();
      if (lowestPriorityIndex >= 0) {
        const removed = this.pendingQueue[lowestPriorityIndex];
        if (removed && priority > removed.priority) {
          log.debug(
            'Drop [queue_overflow/replaced]:',
            removed.message.author,
            removed.message.kind,
            'priority:',
            removed.priority,
            '← replaced by',
            message.author,
            'priority:',
            priority
          );
          this.pendingQueue.splice(lowestPriorityIndex, 1);
          this.observability.onMessageDropped('queue_overflow');
        } else {
          log.debug(
            'Drop [queue_overflow/rejected]:',
            message.author,
            message.kind,
            'priority:',
            priority
          );
          this.observability.onMessageDropped('queue_overflow');
          return;
        }
      } else {
        this.pendingQueue.shift();
        this.observability.onMessageDropped('queue_overflow');
      }
    }

    const queued: QueuedMessage = { message, nextAttemptAt: 0, priority, retries: 0 };
    // Insert in priority order (highest first) so processQueue doesn't need to sort
    const insertIndex = this.pendingQueue.findIndex((q) => q.priority < priority);
    if (insertIndex === -1) {
      this.pendingQueue.push(queued);
    } else {
      this.pendingQueue.splice(insertIndex, 0, queued);
    }

    if (!this.isPaused) {
      this.scheduleProcessQueue();
    }
  }

  /** Defer processQueue to the next microtask, collapsing multiple enqueue events. */
  private scheduleProcessQueue(): void {
    if (this.processQueueScheduled || this.isPaused) return;
    this.processQueueScheduled = true;
    queueMicrotask(() => {
      this.processQueueScheduled = false;
      if (!this.isPaused) {
        this.processQueue();
      }
    });
  }

  private sweepStaleAnimations(): void {
    if (this.activeMessages.size === 0) return;
    this.sweepCounter++;
    if (this.sweepCounter % Renderer.SWEEP_INTERVAL !== 0) return;

    const toRemove: ActiveMessage[] = [];
    const now = performance.now();
    for (const active of this.activeMessages) {
      try {
        // Remove messages that exceeded their expected lifetime + tolerance
        const elapsed = now - active.startTime - active.pausedDuration;
        if (elapsed >= active.baseDuration + Renderer.SWEEP_TOLERANCE_MS) {
          toRemove.push(active);
        }
      } catch (error) {
        log.debug('Failed to check animation state during sweep:', error);
        toRemove.push(active);
      }
    }

    for (const active of toRemove) {
      this.activeMessages.delete(active);
      if (active.element.parentNode) {
        active.element.remove();
      }
    }
  }

  get laneCount(): number {
    return this.laneAllocator.getLaneCount();
  }

  /** Find the index of the queued message with the lowest priority (for queue overflow replacement). */
  private findLowestPriorityIndex(): number {
    const queue = this.pendingQueue;
    let lowestIdx = -1;
    let lowestPrio = Infinity;

    queue.forEach((q, i) => {
      if (q.priority < lowestPrio) {
        lowestPrio = q.priority;
        lowestIdx = i;
      }
    });

    return lowestIdx;
  }

  setBacklogSpeedMultiplier(multiplier: number): void {
    this.backlogSpeedMultiplier = Math.max(1, multiplier);
  }

  private static readonly KIND_PRIORITY: Record<ChatMessage['kind'], number> = {
    superchat: 200,
    membership: 100,
    text: 0,
  };

  private static getMessagePriority(message: ChatMessage): number {
    let priority = Renderer.KIND_PRIORITY[message.kind];
    if (message.isBacklog) priority -= 50;
    return priority;
  }

  private processQueue(): void {
    if (this.isPaused) {
      return;
    }

    this.sweepStaleAnimations();
    this.clearRetryTimer();

    this.observability.updateQueueDepth(this.pendingQueue.length);
    this.observability.updateActiveMessages(this.activeMessages.size);
    this.observability.updateLaneUtilization(
      this.activeMessages.size / Math.max(1, this.laneAllocator.getLaneCount())
    );

    if (this.pendingQueue.length === 0) {
      return;
    }

    const now = performance.now();
    const nextMessage = this.pendingQueue[0];
    if (!nextMessage) return;

    if (nextMessage.nextAttemptAt > now) {
      this.scheduleRetry(nextMessage.nextAttemptAt - now);
      return;
    }

    if (this.activeMessages.size >= this.settings.maxConcurrentMessages) {
      this.logPerformanceWarning();
    }

    let processed = 0;
    let droppedCount = 0;

    while (this.pendingQueue.length > 0 && processed < Renderer.BATCH_SIZE) {
      const queued = this.pendingQueue[0];
      if (!queued) break;

      if (queued.nextAttemptAt > performance.now()) {
        this.scheduleRetry(queued.nextAttemptAt - performance.now());
        break;
      }

      const result = this.renderMessage(queued.message);

      if (result.status === 'deferred') {
        queued.nextAttemptAt = performance.now() + result.waitMs;
        this.scheduleRetry(result.waitMs);
        return;
      }

      // Drop with retry: re-enqueue at lower priority if retries remain
      if (result.status === 'dropped') {
        this.pendingQueue.shift();
        droppedCount++;
        queued.retries++;
        if (queued.retries < Renderer.MAX_RETRY_ATTEMPTS) {
          // Find insertion point past higher-priority items to avoid starvation
          const insertAfter = this.pendingQueue.findIndex((q) => q.priority <= queued.priority);
          if (insertAfter === -1) {
            this.pendingQueue.push(queued);
          } else {
            this.pendingQueue.splice(insertAfter, 0, queued);
          }
        } else {
          log.debug('Drop [max_retries_exceeded]:', queued.message.author, queued.message.kind);
          this.observability.onMessageDropped('other');
        }
        processed++;
        continue;
      }

      // Successfully rendered or deduplicated — remove from queue
      this.pendingQueue.shift();
      processed++;
    }

    if (droppedCount > 0) {
      log.debug(`${droppedCount} message(s) dropped, requeued with retry`);
    }

    // Pause backlog injection if queue is saturated
    const queueRatio = this.pendingQueue.length / Renderer.QUEUE_MAX_SIZE;
    if (queueRatio > 0.8 && this.backlogPaused === false) {
      this.backlogPaused = true;
      this.onBacklogPauseChange?.(true);
    } else if (queueRatio < 0.4 && this.backlogPaused === true) {
      this.backlogPaused = false;
      this.onBacklogPauseChange?.(false);
    }

    if (this.pendingQueue.length > 0 && !this.isPaused) {
      this.scheduleRetry(rendererLayout.retryDelayMinMs);
    }
  }

  /** Burst-level-based speed multiplier for adaptive scrolling. */
  private static readonly BURST_SPEED_MULTIPLIER: Record<BurstLevel, number> = {
    normal: 1.0,
    elevated: 1.1,
    high: 1.2,
    extreme: 1.35,
  };

  /** Force a CSS reflow to restart an animation after modifying its properties. */
  private static triggerAnimationRestart(element: HTMLElement): void {
    element.style.animation = 'none';
    void element.offsetWidth;
    element.style.animation = '';
  }

  private getEffectiveSpeedPxPerSec(): number {
    let speed = this.settings.speedPxPerSec * this.playbackRate;

    // Suppress the EMA-based proactive speed adaptation during the
    // 2-second stabilisation window after a tab-visibility resume.
    // The backlog drained from the pending queue can cause a transient
    // EMA spike that would otherwise make animations visibly faster
    // than intended.
    if (performance.now() >= this.resumeStabilizeUntil) {
      const emaRate = this.burstDetector.getEmaRate();
      if (emaRate > 5) {
        const emaMultiplier = 1 + Math.min((emaRate - 5) / 15, 0.35);
        speed *= emaMultiplier;
      }
    }

    // Burst-level multiplier — the averaged, long-term component.
    const burstLevel = this.burstDetector.getLevel();
    speed *= Renderer.BURST_SPEED_MULTIPLIER[burstLevel];

    return Math.max(1, speed);
  }

  private scheduleRetry(waitMs: number): void {
    if (this.isPaused) return;

    const delay = Math.max(
      rendererLayout.retryDelayMinMs,
      Math.min(waitMs, rendererLayout.retryDelayMaxMs)
    );
    this.clearRetryTimer();

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.processQueue();
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Periodically fade active messages based on their age, and remove
   * messages that exceed the 60-second playback-time window.
   *
   * Messages fade linearly from full opacity (age=0) to fully transparent
   * (age=60s), creating a smooth "past messages grow faint" effect while
   * keeping the visible window limited to recent chat.
   */
  private startOpacityUpdates(): void {
    this.opacityUpdateTimer = setInterval(() => {
      this.updateMessageOpacity();
    }, Renderer.OPACITY_UPDATE_INTERVAL_MS);
  }

  private updateMessageOpacity(): void {
    const now = performance.now();
    const toRemove: ActiveMessage[] = [];

    for (const active of this.activeMessages) {
      try {
        const elapsed = now - active.startTime - active.pausedDuration;

        if (elapsed >= Renderer.MAX_MESSAGE_AGE_MS) {
          toRemove.push(active);
          continue;
        }

        // Linear fade: full opacity at age=0, near-zero at age=60s
        const ageRatio = elapsed / Renderer.MAX_MESSAGE_AGE_MS;
        const fadeFactor = Math.max(0, 1 - ageRatio);
        active.element.style.opacity = `${active.baseOpacity * fadeFactor}`;
      } catch (error) {
        log.debug('Failed to update message opacity:', error);
        toRemove.push(active);
      }
    }

    for (const active of toRemove) {
      this.removeMessage(active);
    }
  }

  private stopOpacityUpdates(): void {
    if (this.opacityUpdateTimer !== null) {
      clearInterval(this.opacityUpdateTimer);
      this.opacityUpdateTimer = null;
    }
  }

  private logPerformanceWarning(): void {
    const now = performance.now();
    if (now - this.lastWarningTime < 10_000) {
      return;
    }

    this.lastWarningTime = now;
    log.warn(
      `Performance warning: ${this.activeMessages.size} concurrent messages ` +
        `(recommended max: ${this.settings.maxConcurrentMessages}).`
    );
  }

  private applyCommonMessageStyles(
    element: HTMLDivElement,
    message: ChatMessage,
    isSuperChat: boolean,
    isMembership: boolean,
    effectiveOpacity: number
  ): void {
    element.style.fontSize = `${this.settings.fontSize}px`;

    element.style.opacity = `${effectiveOpacity}`;

    if (!isSuperChat && !isMembership) {
      element.style.color = this.settings.colors[message.authorType];
    }
  }

  private renderMessage(message: ChatMessage): RenderResult {
    const renderContext = this.getRenderContext();
    if (!renderContext) {
      log.debug('Cannot render: container or dimensions missing');
      return { status: 'dropped' };
    }

    const { container, dimensions } = renderContext;

    const estimated = this.messageBuilder.estimateMessageDimensions(message);
    const messageHeight = estimated.height;

    const placement = this.laneAllocator.findPlacement(messageHeight, dimensions);
    if (placement === null) {
      this.observability.onMessageDropped('no_lane_available');
      log.debug(
        `No available lane for message (height: ${messageHeight}px). ` +
          `Active messages: ${this.activeMessages.size}, Lanes: ${dimensions.laneCount}, ` +
          `Queue size: ${this.pendingQueue.length}`
      );
      return { status: 'dropped' };
    }

    if (placement.waitMs > 0) {
      return { status: 'deferred', waitMs: placement.waitMs };
    }

    const builtMessage = this.messageBuilder.buildMessageElement(message);
    if (!builtMessage) {
      return { status: 'dropped' };
    }

    const { element, isSuperChat, isMembership } = builtMessage;

    // Backlog messages rendered at reduced opacity so they recede behind
    // real-time messages without overwhelming the screen.
    const baseOpacity = this.settings.opacity;
    const effectiveOpacity = message.isBacklog ? baseOpacity * 0.5 : baseOpacity;
    this.applyCommonMessageStyles(element, message, isSuperChat, isMembership, effectiveOpacity);

    const activeMessage = this.setupMessageAnimation(
      element,
      placement,
      estimated.width,
      messageHeight,
      dimensions,
      message,
      effectiveOpacity
    );

    container.appendChild(element);

    this.activeMessages.add(activeMessage);
    this.observability.onMessageRendered();

    log.debug('Rendering message:', {
      text: message.text.slice(0, 20),
      author: message.author,
      authorType: message.authorType,
      kind: message.kind,
      isSuperChat,
      superChatTier: message.superChat?.tier,
      superChatAmount: message.superChat?.amount,
      color: isSuperChat ? 'tier-based' : this.settings.colors[message.authorType],
      lane: placement.lane.index,
      laneSpan: placement.laneSpan,
      width: estimated.width,
      height: messageHeight,
      dimensions,
    });

    return { status: 'rendered' };
  }

  private removeMessageByElement(element: HTMLDivElement): void {
    for (const active of this.activeMessages) {
      if (active.element === element) {
        this.removeMessage(active);
        return;
      }
    }
  }

  private removeMessage(active: ActiveMessage): void {
    this.activeMessages.delete(active);

    try {
      active.element.removeEventListener('animationend', active.cleanup);
    } catch {
      // Element may already be detached — ignore.
    }

    if (active.element.parentNode) {
      active.element.remove();
    }
  }

  /** Trim the pending queue to BACKGROUND_QUEUE_MAX, keeping highest-priority messages. */
  trimBackgroundQueue(): void {
    if (this.pendingQueue.length <= Renderer.BACKGROUND_QUEUE_MAX) return;
    this.pendingQueue.sort(
      (a, b) => b.priority - a.priority || a.message.timestamp - b.message.timestamp
    );
    this.pendingQueue.length = Renderer.BACKGROUND_QUEUE_MAX;
  }

  updateSettings(settings: OverlaySettings, options: RendererUpdateOptions = {}): void {
    this.settings = settings;
    this.injectStyles();
    this.observability.setShowDebug(settings.showDebugOverlay);

    this.authorRateLimiter.updateConfig({
      enabled: settings.authorRateLimitEnabled,
      windowMs: settings.authorRateLimitWindowMs,
      maxPerWindow: settings.authorRateLimitMaxMessages,
    });

    if (options.resetState) {
      this.resetRenderedState();
      this.laneAllocator.reset(this.overlay.getDimensions());
      return;
    }

    if (this.laneAllocator.isEmpty()) {
      this.laneAllocator.reset(this.overlay.getDimensions());
    }
  }

  pause(): void {
    if (this.isPaused) return;

    log.debug('Pausing all animations');
    this.isPaused = true;
    this.pausedAt = performance.now();
    this.clearRetryTimer();
    // Halt burst detection so messages accumulated while hidden
    // don't pollute the rate on return.
    this.burstDetector.pause();
    for (const active of this.activeMessages) {
      active.element.style.animationPlayState = 'paused';
    }
    log.debug(`Paused ${this.activeMessages.size} animations`);
  }

  resume(): void {
    if (!this.isPaused) return;
    // When the video is paused, keep isPaused=true so active animations
    // stay frozen until the user unpauses. Resume burst detection so
    // the EMA rate is fresh when video playback resumes.
    if (this.isVideoPaused) {
      this.burstDetector.resume();
      return;
    }

    // Restart burst detection from a clean slate so the EMA rate and
    // burst level reflect post-hide real-time activity, not the backlog
    // that accumulated while the tab was hidden.
    this.burstDetector.resume();

    // Suppress the EMA speed multiplier for 2s after resume so the
    // backlog messages drained from the pending queue don't spike the
    // animation speed before real-time activity stabilises.
    this.resumeStabilizeUntil = performance.now() + 2000;

    const now = performance.now();
    let pausedDuration = 0;
    if (this.pausedAt !== null) {
      pausedDuration = Math.min(Math.max(0, now - this.pausedAt), 60_000);
      if (pausedDuration > 0) {
        this.laneAllocator.shiftTimeline(pausedDuration);
      }
    }
    this.pausedAt = null;

    this.isPaused = false;

    // Reset active animations using a negative animation-delay so they
    // continue from their current visual position rather than jumping
    // to the start of the animation timeline.  A negative delay tells
    // the CSS engine "start as if already running for N ms," placing
    // the element exactly where it was when paused.
    for (const active of [...this.activeMessages]) {
      try {
        // Subtract accumulated paused time so the animation resumes from
        // where it visually stopped, not from wall-clock elapsed time.
        active.pausedDuration += pausedDuration;
        const elapsed = performance.now() - active.startTime - active.pausedDuration;
        const remaining = active.baseDuration - elapsed;
        if (remaining <= 0) {
          this.removeMessage(active);
          continue;
        }

        // Negative animation-delay places the element at the correct
        // interpolated position without changing the animation definition.
        // The original duration is preserved so the speed (px/s) remains
        // identical to pre-pause.
        const el = active.element;
        Renderer.triggerAnimationRestart(el);
        el.style.setProperty('--yt-msg-delay', `${-elapsed}ms`);
        el.style.animationPlayState = 'running';
      } catch (error) {
        log.warn('Failed to reset animation on resume:', error);
        active.element.style.animationPlayState = 'running';
      }
    }

    log.debug(`Resumed ${this.activeMessages.size} animations`);
    this.processQueue();
  }

  // ── Video pause/play (distinct from tab visibility pause) ─────────────────

  pauseForVideo(): void {
    if (this.isVideoPaused) return;
    this.isVideoPaused = true;
    // Only pause animations if the tab isn't already hidden (isPaused handles that).
    // When isPaused is already true, the video-pause is a no-op and resumeForVideo
    // must not undo the tab-visibility pause.
    if (!this.isPaused) {
      this.pause();
    }
  }

  resumeForVideo(): void {
    if (!this.isVideoPaused) return;
    this.isVideoPaused = false;
    // Resume only if the tab is visible.  Use document.hidden rather than
    // isPaused because isPaused may have been set by pauseForVideo()
    // itself (via pause()), not just by tab-visibility changes.
    if (!document.hidden) {
      this.resume();
    }
  }

  setPlaybackRate(rate: number): void {
    if (rate <= 0) {
      log.warn('Invalid playback rate:', rate);
      return;
    }

    this.playbackRate = rate;

    log.debug(`Setting playback rate to ${rate}x for ${this.activeMessages.size} animations`);

    for (const active of this.activeMessages) {
      try {
        const elapsed = performance.now() - active.startTime;
        const adjustedDuration = active.baseDuration / rate;

        const el = active.element;
        Renderer.triggerAnimationRestart(el);
        el.style.setProperty('--yt-msg-duration', `${adjustedDuration}ms`);
        el.style.setProperty('--yt-msg-delay', `${-Math.min(elapsed, active.baseDuration)}ms`);
      } catch (error) {
        log.warn('Failed to update animation rate:', error);
      }
    }
  }

  destroy(): void {
    this.isPaused = false;
    this.isVideoPaused = false;
    this.stopOpacityUpdates();
    this.overlayDimensionsUnsubscribe?.();
    this.overlayDimensionsUnsubscribe = null;

    this.resetRenderedState();
    this.pausedAt = null;

    this.playbackRate = 1;

    this.styleElement?.remove();
    this.styleElement = null;

    this.burstDetector.destroy();
    this.authorRateLimiter.destroy();
    this.observability.destroy();

    log.debug('Destroyed');
  }
}
