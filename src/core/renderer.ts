/**
 * Renderer — CSS DOM-animation based renderer.
 *
 * Extends RendererBase for shared state machine, rate limiting, burst
 * detection, and lane allocation.  This class owns only the CSS-specific
 * rendering: DOM element creation, @keyframes animation setup, opacity
 * fade timer, and style injection.
 */

import type { ChatMessage, DanmakuMode, OverlayDimensions, OverlaySettings } from '@app-types';
import {
  buildTextShadow,
  buildTextStroke,
  computeDliosDuration,
  rendererLayout,
  shadows,
} from '@core/design-tokens';
import type { LanePlacement } from '@core/lane-allocator';
import { createLogger } from '@core/logging';
import type { Overlay } from '@core/overlay';
import { RendererBase, type RendererUpdateOptions } from '@core/renderer-base';
import { RendererMessageBuilder } from '@core/renderer-message-builder';
import { RENDERER_STATIC_STYLES } from '@core/renderer-styles';

const log = createLogger('Renderer');

interface QueuedMessage {
  message: ChatMessage;
  nextAttemptAt: number;
  priority: number;
  retries: number;
}

interface ActiveMessage {
  element: HTMLDivElement;
  readonly startTime: number;
  readonly baseDuration: number;
  readonly baseOpacity: number;
  readonly cleanup: () => void;
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

export class Renderer extends RendererBase {
  private readonly messageBuilder: RendererMessageBuilder;
  private activeMessages: Set<ActiveMessage> = new Set();
  private readonly pendingQueue: QueuedMessage[] = [];
  private danmakuMode: DanmakuMode = 'scroll';
  private lastWarningTime = 0;
  private static readonly SWEEP_TOLERANCE_MS = 500;
  private static readonly MAX_ANIMATION_JITTER_MS = 15;
  private static readonly QUEUE_MAX_SIZE = 50;
  private static readonly BATCH_SIZE = 3;
  private static readonly MAX_MESSAGE_AGE_MS = 60_000;
  private static readonly OPACITY_UPDATE_INTERVAL_MS = 1000;
  private static readonly SWEEP_INTERVAL = 8;
  private static readonly MAX_RETRY_ATTEMPTS = 3;
  private styleElement: HTMLStyleElement | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private opacityUpdateTimer: ReturnType<typeof setInterval> | null = null;
  private overlayDimensionsUnsubscribe: (() => void) | null = null;
  private sweepCounter = 0;
  static readonly BACKGROUND_QUEUE_MAX = 10;
  private processQueueScheduled = false;

  constructor(overlay: Overlay, settings: OverlaySettings) {
    super(overlay, settings);
    this.messageBuilder = new RendererMessageBuilder(() => this.settings);
    this.danmakuMode = this.settings.danmakuMode;
    this.injectStyles();

    this.overlayDimensionsUnsubscribe = this.overlay.onDimensionsChanged((dimensions) => {
      this.handleOverlayDimensionsChange(dimensions);
    });

    this.startOpacityUpdates();
  }

  get laneCount(): number {
    return this.laneAllocator.getLaneCount();
  }

  // ── Message ingress ──────────────────────────────────────────────────

  addMessage(message: ChatMessage): void {
    if (!this.isMessageAllowed(message)) return;

    const priority = RendererBase.getMessagePriority(message);

    if (this.pendingQueue.length >= Renderer.QUEUE_MAX_SIZE) {
      const lowestPriorityIndex = this.findLowestPriorityIndex();
      if (lowestPriorityIndex >= 0) {
        const removed = this.pendingQueue[lowestPriorityIndex];
        if (removed && priority > removed.priority) {
          this.pendingQueue.splice(lowestPriorityIndex, 1);
          this.observability.onMessageDropped('queue_overflow');
        } else {
          this.observability.onMessageDropped('queue_overflow');
          return;
        }
      } else {
        this.pendingQueue.shift();
        this.observability.onMessageDropped('queue_overflow');
      }
    }

    const queued: QueuedMessage = { message, nextAttemptAt: 0, priority, retries: 0 };
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

  // ── Queue processing ─────────────────────────────────────────────────

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

  private processQueue(): void {
    if (this.isPaused) return;

    this.sweepStaleAnimations();
    this.clearRetryTimer();

    this.observability.updateQueueDepth(this.pendingQueue.length);
    this.observability.updateActiveMessages(this.activeMessages.size);
    this.observability.updateLaneUtilization(
      this.activeMessages.size / Math.max(1, this.laneAllocator.getLaneCount())
    );

    if (this.pendingQueue.length === 0) return;

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

      const result = this.renderOneMessage(queued.message);

      if (result.status === 'deferred') {
        queued.nextAttemptAt = performance.now() + result.waitMs;
        this.scheduleRetry(Math.min(result.waitMs, rendererLayout.retryDelayMaxMs));
        this.pendingQueue.shift();
        // Re-insert deferred message for retry after wait
        const insertBeforeDeferred = this.pendingQueue.findIndex(
          (q) => q.priority < queued.priority
        );
        if (insertBeforeDeferred === -1) {
          this.pendingQueue.push(queued);
        } else {
          this.pendingQueue.splice(insertBeforeDeferred, 0, queued);
        }
        processed++;
        continue;
      }

      if (result.status === 'dropped') {
        this.pendingQueue.shift();
        droppedCount++;
        queued.retries++;
        if (queued.retries < Renderer.MAX_RETRY_ATTEMPTS) {
          const insertBefore = this.pendingQueue.findIndex((q) => q.priority < queued.priority);
          if (insertBefore === -1) {
            this.pendingQueue.push(queued);
          } else {
            this.pendingQueue.splice(insertBefore, 0, queued);
          }
        } else {
          this.observability.onMessageDropped('other');
        }
        continue;
      }

      this.pendingQueue.shift();
      processed++;
    }

    if (droppedCount > 0) {
      log.debug(`${droppedCount} message(s) dropped, requeued with retry`);
    }

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

  // ── CSS rendering ────────────────────────────────────────────────────

  private getRenderContext(): RenderContext | null {
    const container = this.overlay.getContainer();
    const dimensions = this.overlay.getDimensions();
    if (!container?.isConnected || !dimensions) return null;
    return { container, dimensions };
  }

  private renderOneMessage(message: ChatMessage): RenderResult {
    const renderContext = this.getRenderContext();
    if (!renderContext) {
      return { status: 'dropped' };
    }

    const { container, dimensions } = renderContext;
    const estimated = this.messageBuilder.estimateMessageDimensions(message);
    const messageHeight = estimated.height;

    const placement = this.laneAllocator.findPlacement(messageHeight, dimensions);
    if (placement === null) {
      this.observability.onMessageDropped('no_lane_available');
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

    return { status: 'rendered' };
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
    const { lane, laneY } = placement;
    const mode = this.danmakuMode;
    const effectiveSpeedPxPerSec = this.getEffectiveSpeedPxPerSec();
    const now = performance.now();

    let baseDuration: number;
    let laneDelay = Math.floor(Math.random() * Renderer.MAX_ANIMATION_JITTER_MS);
    let startTime = now + laneDelay;

    if (mode === 'top' || mode === 'bottom') {
      element.style.left = `${Math.random() * (dimensions.width - Math.min(textWidth, dimensions.width))}px`;
      if (mode === 'top') {
        element.style.top = `${dimensions.height * this.settings.safeTop}px`;
      } else {
        element.style.top = `${dimensions.height * (1 - this.settings.safeBottom) - messageHeight}px`;
      }
      element.style.visibility = 'visible';
      baseDuration = rendererLayout.topBottomDurationMs;
      laneDelay = 0;
      startTime = now;
      this.laneAllocator.commitPlacement(placement, textWidth, startTime);
    } else if (mode === 'reverse') {
      const reverseTotalDistance = dimensions.width * 2 + 100;
      baseDuration = computeDliosDuration(reverseTotalDistance, effectiveSpeedPxPerSec);
      element.style.top = `${laneY}px`;
      element.style.right = '0';
      element.style.visibility = 'visible';
      startTime = now + laneDelay;
      this.laneAllocator.commitPlacement(placement, textWidth, startTime);
    } else {
      element.style.top = `${laneY}px`;
      element.style.left = `${dimensions.width}px`;
      element.style.visibility = 'visible';

      const exitPadding = Math.max(
        fontSize * rendererLayout.exitPaddingScale,
        rendererLayout.exitPaddingMin
      );
      const exitDistance = dimensions.width + textWidth + exitPadding;

      const baseOffset =
        dimensions.laneCount > 1
          ? Math.round((lane.index / (dimensions.laneCount - 1)) * 200)
          : 100;
      const jitter = Math.floor(Math.random() * 30);
      const entryOffset = baseOffset + jitter;

      const totalDistance = entryOffset + dimensions.width + textWidth + exitPadding;
      baseDuration = computeDliosDuration(totalDistance, effectiveSpeedPxPerSec);

      element.style.setProperty('--yt-msg-entry-offset', `${entryOffset}px`);
      element.style.setProperty('--yt-msg-exit-offset', `-${exitDistance}px`);
      startTime = now + laneDelay;
      this.laneAllocator.commitPlacement(placement, textWidth, startTime);
    }

    if (message?.isBacklog && this.backlogSpeedMultiplier > 1) {
      baseDuration = Math.max(
        rendererLayout.durationMin,
        baseDuration / this.backlogSpeedMultiplier
      );
    }
    const adjustedDuration = baseDuration / this.playbackRate;

    element.style.setProperty('--yt-msg-duration', `${adjustedDuration}ms`);
    element.style.setProperty('--yt-msg-delay', `${laneDelay}ms`);

    if (mode === 'reverse') {
      element.classList.add('yt-overlay-message-animate-reverse');
    } else if (mode === 'top') {
      element.classList.add('yt-overlay-message-animate-top');
    } else if (mode === 'bottom') {
      element.classList.add('yt-overlay-message-animate-bottom');
    } else {
      element.classList.add('yt-overlay-message-animate');
    }

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

  // ── Style injection ──────────────────────────────────────────────────

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
    if (!container) return;

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

  // ── Opacity fade timer ───────────────────────────────────────────────

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
        const ageRatio = elapsed / Renderer.MAX_MESSAGE_AGE_MS;
        const fadeFactor = Math.max(0, 1 - ageRatio);
        active.element.style.opacity = `${active.baseOpacity * fadeFactor}`;
      } catch {
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

  // ── Animation restart helper ─────────────────────────────────────────

  private static triggerAnimationRestart(element: HTMLElement): void {
    element.style.animation = 'none';
    void element.offsetWidth;
    element.style.animation = '';
  }

  // ── Retry scheduling ─────────────────────────────────────────────────

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

  // ── Sweep stale animations ───────────────────────────────────────────

  private sweepStaleAnimations(): void {
    if (this.activeMessages.size === 0) return;
    this.sweepCounter++;
    if (this.sweepCounter % Renderer.SWEEP_INTERVAL !== 0) return;

    const toRemove: ActiveMessage[] = [];
    const now = performance.now();
    for (const active of this.activeMessages) {
      try {
        const elapsed = now - active.startTime - active.pausedDuration;
        if (elapsed >= active.baseDuration + Renderer.SWEEP_TOLERANCE_MS) {
          toRemove.push(active);
        }
      } catch {
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

  // ── Message lifecycle ────────────────────────────────────────────────

  private findLowestPriorityIndex(): number {
    const len = this.pendingQueue.length;
    if (len === 0) return -1;
    return len - 1;
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
      // Element may already be detached.
    }
    if (active.element.parentNode) {
      active.element.remove();
    }
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

  private logPerformanceWarning(): void {
    const now = performance.now();
    if (now - this.lastWarningTime < 10_000) return;
    this.lastWarningTime = now;
    log.warn(
      `Performance warning: ${this.activeMessages.size} concurrent messages ` +
        `(recommended max: ${this.settings.maxConcurrentMessages}).`
    );
  }

  // ── Queue trimming ───────────────────────────────────────────────────

  trimBackgroundQueue(): void {
    if (this.pendingQueue.length <= Renderer.BACKGROUND_QUEUE_MAX) return;
    this.pendingQueue.sort(
      (a, b) => b.priority - a.priority || a.message.timestamp - b.message.timestamp
    );
    this.pendingQueue.length = Renderer.BACKGROUND_QUEUE_MAX;
  }

  // ── Dimension change handler ─────────────────────────────────────────

  private handleOverlayDimensionsChange(dimensions: OverlayDimensions | null): void {
    if (!dimensions) {
      this.resetState();
      this.laneAllocator.reset(null);
      return;
    }
    this.laneAllocator.reset(dimensions);
    if (!this.isPaused && !this.isVideoPaused && this.pendingQueue.length > 0) {
      this.processQueue();
    }
  }

  // ── Settings update ──────────────────────────────────────────────────

  updateSettings(settings: OverlaySettings, options: RendererUpdateOptions = {}): void {
    super.updateSettings(settings, options);
    this.danmakuMode = settings.danmakuMode;
    this.injectStyles();
  }

  // ── Abstract hook implementations ────────────────────────────────────

  protected onPause(): void {
    this.clearRetryTimer();
    this.stopOpacityUpdates();
    for (const active of this.activeMessages) {
      active.element.style.animationPlayState = 'paused';
    }
  }

  protected onResume(): void {
    this.startOpacityUpdates();
    for (const active of [...this.activeMessages]) {
      try {
        const elapsed = performance.now() - active.startTime - active.pausedDuration;
        const remaining = active.baseDuration - elapsed;
        if (remaining <= 0) {
          this.removeMessage(active);
          continue;
        }
        const el = active.element;
        el.style.setProperty('--yt-msg-delay', `${-elapsed}ms`);
        Renderer.triggerAnimationRestart(el);
        el.style.animationPlayState = 'running';
      } catch {
        active.element.style.animationPlayState = 'running';
      }
    }
    this.processQueue();
  }

  onPlaybackRateChange(rate: number): void {
    for (const active of this.activeMessages) {
      try {
        const elapsed = performance.now() - active.startTime - active.pausedDuration;
        const adjustedDuration = active.baseDuration / rate;
        const el = active.element;
        el.style.setProperty('--yt-msg-duration', `${adjustedDuration}ms`);
        el.style.setProperty('--yt-msg-delay', `${-Math.min(elapsed, active.baseDuration)}ms`);
        Renderer.triggerAnimationRestart(el);
      } catch {
        // Best-effort update.
      }
    }
  }

  protected applyPausedDuration(pausedMs: number): void {
    for (const active of [...this.activeMessages]) {
      active.pausedDuration += pausedMs;
    }
  }

  protected resetState(): void {
    this.clearRetryTimer();
    for (const active of [...this.activeMessages]) {
      this.removeMessage(active);
    }
    this.pendingQueue.length = 0;
    this.backlogPaused = false;
  }

  protected onDestroy(): void {
    this.stopOpacityUpdates();
    this.overlayDimensionsUnsubscribe?.();
    this.overlayDimensionsUnsubscribe = null;
    this.resetState();
    this.pausedAt = null;
    this.playbackRate = 1;
    this.styleElement?.remove();
    this.styleElement = null;
  }
}
