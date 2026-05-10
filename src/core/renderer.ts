/**
 * Renderer
 *
 * Renders chat messages with Nico-nico style flowing animation.
 * Manages lanes and collision detection.
 */

import type { ChatMessage, OutlineSettings, OverlayDimensions, OverlaySettings } from '@app-types';
import { PerAuthorRateLimiter } from '@core/author-rate-limiter';
import { BurstDetector } from '@core/burst-detector';
import { rendererLayout, shadows } from '@core/design-tokens';
import { createLogger } from '@core/logging';
import { MessageIdRegistry } from '@core/message-id-registry';
import { ObservabilityReporter } from '@core/observability';
import type { Overlay } from '@core/overlay';
import { LaneAllocator, type LanePlacement } from '@core/renderer-lanes';
import { RendererMessageBuilder } from '@core/renderer-message-builder';
import { RENDERER_STATIC_STYLES } from '@core/renderer-styles';

const log = createLogger('Renderer');

// ── Pure outline helpers (module-level to keep Renderer focused) ─────────────

function buildTextShadow(outline: OutlineSettings): string {
  if (!outline.enabled || outline.widthPx <= 0 || outline.opacity <= 0) {
    return 'none';
  }

  const offset = outline.widthPx;
  const blur = Math.max(0, outline.blurPx);
  const baseOpacity = Math.min(1, outline.opacity);
  const shadowColor = `rgba(0, 0, 0, ${baseOpacity})`;
  const glowColor = `rgba(0, 0, 0, ${Math.min(1, baseOpacity * 0.85)})`;
  const glowBlur = Math.max(1, blur * 1.5);

  const corners = (
    [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const
  ).map(([dx, dy]) => `${dx * offset}px ${dy * offset}px ${blur}px ${shadowColor}`);

  return [...corners, `0px 0px ${glowBlur}px ${glowColor}`].join(', ');
}

function buildTextStroke(outline: OutlineSettings): string {
  if (!outline.enabled || outline.widthPx <= 0 || outline.opacity <= 0) {
    return '0 transparent';
  }

  const strokeWidth = Math.max(0.2, outline.widthPx * 0.3);
  const strokeOpacity = Math.min(1, outline.opacity * 0.7);
  return `${strokeWidth}px rgba(0, 0, 0, ${strokeOpacity})`;
}

interface QueuedMessage {
  message: ChatMessage;
  nextAttemptAt: number;
  priority: number;
}

interface ActiveMessage {
  element: HTMLDivElement;
  readonly startTime: DOMHighResTimeStamp;
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
  private static readonly SWEEP_TOLERANCE_MS = 500;
  private static readonly MAX_ANIMATION_JITTER_MS = 15;
  private static readonly WARNING_INTERVAL_MS = 10_000;
  private static readonly QUEUE_MAX_SIZE = 50;
  private static readonly BATCH_SIZE = 8;
  private static readonly RETRY_DELAY_MS = 4;
  private static readonly MAX_MESSAGE_AGE_MS = 60_000;
  private static readonly OPACITY_UPDATE_INTERVAL_MS = 250;
  private static readonly SWEEP_INTERVAL = 8;
  private styleElement: HTMLStyleElement | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private opacityUpdateTimer: ReturnType<typeof setInterval> | null = null;
  private overlayDimensionsUnsubscribe: (() => void) | null = null;
  private sweepCounter = 0;
  private static readonly SEEN_MESSAGE_IDS_LIMIT = 2000;
  private readonly seenMessageIds = new MessageIdRegistry(Renderer.SEEN_MESSAGE_IDS_LIMIT);
  static readonly BACKGROUND_QUEUE_MAX = 10;
  private static readonly BACKLOG_OPACITY_SCALE = 0.5;

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
    this.burstDetector = new BurstDetector(this.observability, (level) => {
      this.laneAllocator.setBurstLevel(level);
    });
    this.burstDetector.start();
    this.authorRateLimiter = new PerAuthorRateLimiter(() => this.burstDetector.getLevel());
    this.overlayDimensionsUnsubscribe = this.overlay.onDimensionsChanged((dimensions) => {
      this.handleOverlayDimensionsChange(dimensions);
    });

    this.startOpacityUpdates();
  }

  private resetRenderedState(): void {
    this.clearRetryTimer();

    for (const active of [...this.activeMessages]) {
      this.removeMessage(active);
    }

    this.pendingQueue.length = 0;
    this.seenMessageIds.clear();
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
    const regularMessageTextShadow = [textShadow, shadows.text.md, '0 0 8px rgba(0, 0, 0, 0.7)']
      .filter(Boolean)
      .join(', ');
    const superChatBaseOpacity = Math.min(1, Math.max(0.4, this.settings.superChatOpacity));
    const superChatTopOpacity = Math.min(1, superChatBaseOpacity + 0.06);
    const superChatBottomOpacity = Math.max(0.4, superChatBaseOpacity - 0.08);

    container.style.setProperty('--yt-overlay-message-text-shadow', textShadow);
    container.style.setProperty(
      '--yt-overlay-regular-message-text-shadow',
      regularMessageTextShadow
    );
    container.style.setProperty('--yt-overlay-text-stroke', textStroke);
    container.style.setProperty(
      '--yt-overlay-superchat-base-opacity',
      String(superChatBaseOpacity)
    );
    container.style.setProperty('--yt-overlay-superchat-top-opacity', String(superChatTopOpacity));
    container.style.setProperty(
      '--yt-overlay-superchat-bottom-opacity',
      String(superChatBottomOpacity)
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

    const now = Date.now();
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
      startTime: performance.now(),
      baseDuration,
      baseOpacity: baseOpacity ?? this.settings.opacity,
      cleanup,
      pausedDuration: 0,
    };
  }

  addMessage(message: ChatMessage): void {
    if (message.id && this.seenMessageIds.has(message.id)) {
      this.observability.onMessageDropped('dedup');
      return;
    }

    // Drop messages while video is paused — they would queue up and flood on resume.
    if (this.isVideoPaused) {
      this.observability.onMessageDropped('other');
      return;
    }

    this.observability.onMessageReceived();
    this.burstDetector.onMessageReceived();

    const priority = Renderer.getMessagePriority(message);
    if (!this.authorRateLimiter.allow(message.author ?? 'anonymous', priority)) {
      this.observability.onMessageDropped('rate_limited');
      return;
    }

    if (this.pendingQueue.length >= Renderer.QUEUE_MAX_SIZE) {
      this.pendingQueue.shift();
      this.observability.onMessageDropped('queue_overflow');
    }

    this.pendingQueue.push({ message, nextAttemptAt: 0, priority });

    if (message.id) {
      this.seenMessageIds.mark(message.id);
    }

    if (!this.isPaused) {
      this.processQueue();
    }
  }

  private sweepStaleAnimations(): void {
    if (this.activeMessages.size === 0) return;
    this.sweepCounter++;
    if (this.sweepCounter % Renderer.SWEEP_INTERVAL !== 0) return;

    const toRemove: ActiveMessage[] = [];
    for (const active of this.activeMessages) {
      try {
        const elapsed = performance.now() - active.startTime;
        const minLifetimeMs = active.baseDuration + Renderer.SWEEP_TOLERANCE_MS;
        if (elapsed < minLifetimeMs) continue;

        const animations = active.element.getAnimations();
        if (animations.length === 0) {
          toRemove.push(active);
          continue;
        }

        for (const anim of animations) {
          if (anim.playState === 'finished') {
            toRemove.push(active);
            break;
          }
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

    this.pendingQueue.sort(
      (left, right) =>
        right.priority - left.priority || left.message.timestamp - right.message.timestamp
    );

    const now = Date.now();
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

    while (this.pendingQueue.length > 0 && processed < Renderer.BATCH_SIZE) {
      const queued = this.pendingQueue[0];
      if (!queued) break;

      if (queued.nextAttemptAt > Date.now()) {
        this.scheduleRetry(queued.nextAttemptAt - Date.now());
        return;
      }

      const result = this.renderMessage(queued.message);

      if (result.status === 'deferred') {
        queued.nextAttemptAt = Date.now() + result.waitMs;
        this.scheduleRetry(result.waitMs);
        return;
      }

      this.pendingQueue.shift();
      processed++;
    }

    if (this.pendingQueue.length > 0 && !this.isPaused) {
      this.scheduleRetry(Renderer.RETRY_DELAY_MS);
    }
  }

  private getEffectiveSpeedPxPerSec(): number {
    return Math.max(1, this.settings.speedPxPerSec * this.playbackRate);
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
        const elapsed = now - active.startTime;

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
    const now = Date.now();
    if (now - this.lastWarningTime < Renderer.WARNING_INTERVAL_MS) {
      return;
    }

    this.lastWarningTime = now;
    log.warn(
      `Performance warning: ${this.activeMessages.size} concurrent messages ` +
        `(recommended max: ${this.settings.maxConcurrentMessages}). ` +
        'Consider reducing maxMessagesPerSecond setting.'
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
    const effectiveOpacity = message.isBacklog
      ? baseOpacity * Renderer.BACKLOG_OPACITY_SCALE
      : baseOpacity;
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

  /** Clear all pending messages — used when returning from a hidden tab. */
  clearPendingQueue(): void {
    this.pendingQueue.length = 0;
    this.clearRetryTimer();
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
    this.pausedAt = Date.now();
    this.clearRetryTimer();
    this.forEachElement((el) => {
      el.style.animationPlayState = 'paused';
    });
    log.debug(`Paused ${this.activeMessages.size} animations`);
  }

  resume(): void {
    if (!this.isPaused) return;

    const now = Date.now();
    let pausedDuration = 0;
    if (this.pausedAt !== null) {
      pausedDuration = Math.min(Math.max(0, now - this.pausedAt), 60_000);
      if (pausedDuration > 0) {
        this.laneAllocator.shiftTimeline(pausedDuration);
      }
    }
    this.pausedAt = null;

    this.isPaused = false;

    // Reset active animations so they continue from their current visual
    // position with the remaining duration, rather than jumping to where
    // they would be if they had been running during the pause.
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

        const el = active.element;
        el.style.animationName = 'none';
        void el.offsetWidth;
        el.style.animationName = '';
        el.style.setProperty('--yt-msg-duration', `${remaining}ms`);
        el.style.setProperty('--yt-msg-delay', '0ms');
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
    this.pause();
  }

  resumeForVideo(): void {
    if (!this.isVideoPaused) return;
    this.isVideoPaused = false;
    this.resume();
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
        el.style.animationName = 'none';
        void el.offsetWidth;
        el.style.animationName = '';
        el.style.setProperty('--yt-msg-duration', `${adjustedDuration}ms`);
        el.style.setProperty('--yt-msg-delay', `${-Math.min(elapsed, active.baseDuration)}ms`);
      } catch (error) {
        log.warn('Failed to update animation rate:', error);
      }
    }
  }

  private forEachElement(operation: (element: HTMLDivElement) => void): void {
    for (const active of [...this.activeMessages]) {
      try {
        operation(active.element);
      } catch (error) {
        log.warn('Element operation failed:', error);
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
    this.seenMessageIds.clear();
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
