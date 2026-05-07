/**
 * Renderer
 *
 * Renders chat messages with Nico-nico style flowing animation.
 * Manages lanes and collision detection.
 */

import type { ChatMessage, OutlineSettings, OverlayDimensions, OverlaySettings } from '@app-types';
import { RENDERER_LAYOUT, shadows } from '@core/design-tokens';
import { createLogger } from '@core/logging';
import { MessageIdRegistry } from '@core/message-id-registry';
import type { Overlay } from '@core/overlay';
import { LaneAllocator, type LanePlacement } from '@core/renderer-lanes';
import { RendererMessageBuilder } from '@core/renderer-message-builder';
import { RENDERER_STATIC_STYLES } from '@core/renderer-styles';

const log = createLogger('Renderer');

/** @internal Queue entry wrapping a message with retry scheduling metadata. */
interface QueuedMessage {
  message: ChatMessage;
  nextAttemptAt: number;
}

/**
 * Bounded message queue that drops oldest entries when full.
 * Used internally by Renderer to buffer messages when lanes are congested.
 */
class RenderQueue {
  private items: QueuedMessage[] = [];

  constructor(private readonly maxSize: number) {}

  get length(): number {
    return this.items.length;
  }

  at(index: number): QueuedMessage | undefined {
    return this.items[index];
  }

  enqueue(message: ChatMessage): void {
    if (this.items.length >= this.maxSize) {
      const excess = this.items.length - this.maxSize + 1;
      this.items.splice(0, excess);
    }

    this.items.push({
      message,
      nextAttemptAt: 0,
    });
  }

  removeAt(index: number): void {
    this.items.splice(index, 1);
  }

  clear(onDiscard?: (message: ChatMessage) => void): void {
    if (onDiscard) {
      for (const item of this.items) {
        onDiscard(item.message);
      }
    }

    this.items = [];
  }

  sortByTimestamp(): void {
    this.items.sort((left, right) => left.message.timestamp - right.message.timestamp);
  }
}

interface ActiveMessage {
  element: HTMLDivElement;
  /** performance.now() timestamp when the animation was started. */
  readonly startTime: DOMHighResTimeStamp;
  /** Base duration before playbackRate adjustment. */
  readonly baseDuration: number;
  /** Cleanup callback registered as animationend listener.
   *  Stored so removeMessage can detach it before manually removing,
   *  preventing re-entrant removal after the element is already deleted. */
  readonly cleanup: () => void;
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

const combineTextShadows = (...shadows: string[]): string => {
  const normalizedShadows = shadows.filter((shadow) => shadow !== '' && shadow !== 'none');
  return normalizedShadows.length > 0 ? normalizedShadows.join(', ') : 'none';
};

export class Renderer {
  private overlay: Overlay;
  private settings: OverlaySettings;
  private readonly laneAllocator: LaneAllocator;
  private readonly messageBuilder: RendererMessageBuilder;
  private activeMessages: Set<ActiveMessage> = new Set();
  private readonly renderQueue = new RenderQueue(RENDERER_LAYOUT.QUEUE_MAX_SIZE);
  private isPaused = false;
  private pausedAt: number | null = null;
  private playbackRate = 1;
  private lastWarningTime = 0;
  private readonly WARNING_INTERVAL_MS = 10000;
  private styleElement: HTMLStyleElement | null = null;
  private retryTimer: number | null = null;
  private overlayDimensionsUnsubscribe: (() => void) | null = null;
  private sweepCounter = 0;
  private readonly SWEEP_INTERVAL = 8;
  /** Tracks whether a processQueue microtask is already pending. */
  private processQueueScheduled = false;
  /** Ids of messages already enqueued/rendered, for dedup across reconnect/resume. */
  private static readonly SEEN_MESSAGE_IDS_LIMIT = 200;
  private readonly seenMessageIds = new MessageIdRegistry(Renderer.SEEN_MESSAGE_IDS_LIMIT);

  constructor(overlay: Overlay, settings: OverlaySettings) {
    this.overlay = overlay;
    this.settings = settings;
    this.messageBuilder = new RendererMessageBuilder(() => this.settings);
    this.laneAllocator = new LaneAllocator({
      getFontSize: () => this.settings.fontSize,
      getEffectiveSpeedPxPerSec: () => this.getEffectiveSpeedPxPerSec(),
      globalStaggerMs: RENDERER_LAYOUT.GLOBAL_STAGGER_MS,
      safeDistanceScale: RENDERER_LAYOUT.SAFE_DISTANCE_SCALE,
      safeDistanceMin: RENDERER_LAYOUT.SAFE_DISTANCE_MIN,
      verticalClearTimeMin: RENDERER_LAYOUT.VERTICAL_CLEAR_TIME_MIN,
      verticalClearTimeMax: RENDERER_LAYOUT.VERTICAL_CLEAR_TIME_MAX,
      laneHeightPaddingScale: RENDERER_LAYOUT.LANE_HEIGHT_PADDING_SCALE,
      laneHeightPaddingMin: RENDERER_LAYOUT.LANE_HEIGHT_PADDING_MIN,
    });
    this.laneAllocator.reset(this.overlay.getDimensions());
    this.injectStyles();
    this.overlayDimensionsUnsubscribe = this.overlay.onDimensionsChanged((dimensions) => {
      this.handleOverlayDimensionsChange(dimensions);
    });
  }

  private resetRenderedState(): void {
    this.clearRetryTimer();

    for (const active of Array.from(this.activeMessages)) {
      this.removeMessage(active);
    }

    this.renderQueue.clear();
    this.seenMessageIds.clear();
  }

  private handleOverlayDimensionsChange(dimensions: OverlayDimensions | null): void {
    if (!dimensions) {
      this.resetRenderedState();
      this.laneAllocator.reset(null);
      return;
    }

    // Re-init lane collision state but keep active animations running so
    // messages finish flowing across the screen instead of vanishing mid-way
    // when the player resizes or enters/exits fullscreen.
    this.laneAllocator.reset(dimensions);

    if (!this.isPaused && this.renderQueue.length > 0) {
      this.processQueue();
    }
  }

  /**
   * Inject CSS animations
   */
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

    const textShadow = this.buildTextShadow(this.settings.outline);
    const textStroke = this.buildTextStroke(this.settings.outline);
    const regularMessageTextShadow = combineTextShadows(
      textShadow,
      shadows.text.md,
      '0 0 8px rgba(0, 0, 0, 0.7)'
    );
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

  private buildTextShadow(outline: OutlineSettings): string {
    if (!outline.enabled || outline.widthPx <= 0 || outline.opacity <= 0) {
      return 'none';
    }

    const offset = outline.widthPx;
    const blur = Math.max(0, outline.blurPx);
    const baseOpacity = Math.min(1, outline.opacity);
    const shadowColor = `rgba(0, 0, 0, ${baseOpacity})`;
    const glowColor = `rgba(0, 0, 0, ${Math.min(1, baseOpacity * 0.85)})`;
    const glowBlur = Math.max(1, blur * 1.5);

    // 4 diagonal shadows + 1 soft glow. Combined with text-stroke below this
    // gives a clean outline on every side without stacking 10 shadow layers.
    return [
      `-${offset}px -${offset}px ${blur}px ${shadowColor}`,
      `${offset}px -${offset}px ${blur}px ${shadowColor}`,
      `-${offset}px ${offset}px ${blur}px ${shadowColor}`,
      `${offset}px ${offset}px ${blur}px ${shadowColor}`,
      `0px 0px ${glowBlur}px ${glowColor}`,
    ].join(', ');
  }

  private buildTextStroke(outline: OutlineSettings): string {
    if (!outline.enabled || outline.widthPx <= 0 || outline.opacity <= 0) {
      return '0 transparent';
    }

    const strokeWidth = Math.max(0.2, outline.widthPx * 0.3);
    const strokeOpacity = Math.min(1, outline.opacity * 0.7);
    return `${strokeWidth}px rgba(0, 0, 0, ${strokeOpacity})`;
  }

  private getRenderContext(): RenderContext | null {
    const container = this.overlay.getContainer();
    const dimensions = this.overlay.getDimensions();

    if (!container?.isConnected || !dimensions) {
      return null;
    }

    return { container, dimensions };
  }

  /**
   * Setup CSS-animation-based positioning for a message element.
   * Uses CSS @keyframes + custom properties instead of element.animate()
   * so animation runs on the GPU compositor thread.
   */
  private setupMessageAnimation(
    element: HTMLDivElement,
    placement: LanePlacement,
    textWidth: number,
    messageHeight: number,
    dimensions: OverlayDimensions
  ): ActiveMessage {
    const fontSize = this.settings.fontSize;
    const { lane } = placement;

    // Calculate Y position: for multi-lane messages (laneSpan > 1),
    // center vertically within the occupied lane block to prevent
    // boundary overlaps with adjacent messages.
    const laneBlockTop =
      dimensions.height * this.settings.safeTop + lane.index * dimensions.laneHeight;
    let laneY: number;
    if (placement.laneSpan > 1) {
      const laneBlockHeight = placement.laneSpan * dimensions.laneHeight;
      laneY = laneBlockTop + Math.max(0, (laneBlockHeight - messageHeight) / 2);
    } else {
      laneY = laneBlockTop;
    }
    element.style.top = `${laneY}px`;
    element.style.left = `${dimensions.width}px`;
    element.style.visibility = 'visible';

    // Calculate animation distance and padding
    const exitPadding = Math.max(
      fontSize * RENDERER_LAYOUT.EXIT_PADDING_SCALE,
      RENDERER_LAYOUT.EXIT_PADDING_MIN
    );
    const distance = dimensions.width + textWidth + exitPadding;

    // Stagger entry offset by lane index so messages on different lanes
    // start from different horizontal positions, creating a more natural look.
    const entryOffset = (lane.index % 3) * 50 + Math.floor(Math.random() * 100);

    // Adjust effective distance for entry offset so actual travel
    // speed stays consistent regardless of the starting offset.
    const adjustedDistance = distance + entryOffset;

    // Optimized duration for better pacing
    const effectiveSpeedPxPerSec = this.getEffectiveSpeedPxPerSec();
    const baseDuration = Math.max(
      RENDERER_LAYOUT.DURATION_MIN,
      Math.min(RENDERER_LAYOUT.DURATION_MAX, (adjustedDistance / effectiveSpeedPxPerSec) * 1000)
    );
    const adjustedDuration = baseDuration / this.playbackRate;

    // Hierarchical delay: group lanes into tiers with base delay + small jitter.
    let laneDelay: number;
    if (lane.index <= 3) {
      laneDelay = Math.floor(Math.random() * 20);
    } else if (lane.index <= 7) {
      laneDelay = 30 + Math.floor(Math.random() * 30);
    } else {
      laneDelay = 60 + Math.floor(Math.random() * 40);
    }

    // ── CSS custom properties drive the @keyframes animation ───────────
    element.style.setProperty('--yt-msg-entry-offset', `${entryOffset}px`);
    element.style.setProperty('--yt-msg-exit-offset', `-${distance}px`);
    element.style.setProperty('--yt-msg-duration', `${adjustedDuration}ms`);
    element.style.setProperty('--yt-msg-delay', `${laneDelay}ms`);
    element.classList.add('yt-overlay-message-animate');

    // Update lane state with message dimensions
    const now = Date.now();
    const startTime = now + laneDelay;
    this.laneAllocator.commitPlacement(
      placement,
      textWidth,
      messageHeight,
      startTime,
      startTime + adjustedDuration
    );

    // Cleanup via animationend event
    const cleanup = (): void => {
      element.removeEventListener('animationend', cleanup);
      this.removeMessageByElement(element);
    };
    element.addEventListener('animationend', cleanup, { once: true });

    return {
      element,
      startTime: performance.now(),
      baseDuration,
      cleanup,
    };
  }

  /**
   * Add message to render queue
   */
  addMessage(message: ChatMessage): void {
    // Dedup across reconnect/resume replays.
    if (message.id && this.seenMessageIds.has(message.id)) {
      return;
    }

    if (message.id) {
      this.seenMessageIds.mark(message.id);
    }

    this.renderQueue.enqueue(message);

    // Only process queue if not paused — debounce to a single microtask
    // so that N synchronous addMessage calls schedule only one processQueue
    // invocation, preventing interleaving with retry timers.
    if (!this.isPaused && !this.processQueueScheduled) {
      this.processQueueScheduled = true;
      queueMicrotask(() => {
        this.processQueueScheduled = false;
        this.processQueue();
      });
    }
    // If paused, message stays in queue until resume()
  }

  /**
   * Remove stale activeMessage entries whose CSS animation finished
   * without triggering the cleanup callback (e.g. GC delay, rapid
   * destroy/create cycles, tab-hidden edge cases).
   *
   * Uses Set.forEach instead of for...of because the callback may
   * delete entries from the Set, and forEach safely handles
   * concurrent modification during iteration.
   */
  private sweepStaleAnimations(): void {
    if (this.activeMessages.size === 0) return;
    this.sweepCounter++;
    if (this.sweepCounter % this.SWEEP_INTERVAL !== 0) return;

    this.activeMessages.forEach((active) => {
      try {
        const animations = active.element.getAnimations();
        const isFinished =
          animations.length === 0 ||
          animations.some((a) => a.playState === 'finished' || a.playState === 'idle');
        if (isFinished) {
          this.activeMessages.delete(active);
          if (active.element.parentNode) {
            active.element.remove();
          }
        }
      } catch (error) {
        log.debug('Failed to check animation state during sweep:', error);
        this.activeMessages.delete(active);
      }
    });
  }

  /**
   * Process messages from the queue immediately.
   *
   * Displays one message per cycle, respecting lane availability.
   * Re-schedules itself when there are still messages waiting
   * or lanes are temporarily busy.
   */
  private processQueue(): void {
    // Don't process while paused
    if (this.isPaused) {
      return;
    }

    this.sweepStaleAnimations();
    this.clearRetryTimer();

    if (this.renderQueue.length === 0) {
      return;
    }

    // Sort by message timestamp so earlier chat messages get rendered
    // before later ones, keeping chat order approximately correct.
    this.renderQueue.sortByTimestamp();

    const now = Date.now();
    const queued = this.renderQueue.at(0);
    if (!queued) return;

    if (queued.nextAttemptAt > now) {
      this.scheduleRetry(queued.nextAttemptAt - now);
      return;
    }

    // Soft cap warning (non-blocking)
    if (this.activeMessages.size >= this.settings.maxConcurrentMessages) {
      this.logPerformanceWarning();
    }

    const result = this.renderMessage(queued.message);

    if (result.status !== 'deferred') {
      this.renderQueue.removeAt(0);
    } else {
      queued.nextAttemptAt = now + result.waitMs;
    }

    // Schedule next if there are still messages waiting.
    if (this.renderQueue.length > 0 && !this.isPaused) {
      this.scheduleRetry(RENDERER_LAYOUT.RETRY_DELAY_MIN_MS);
    }
  }

  /**
   * Get effective message speed considering current video playback rate
   */
  private getEffectiveSpeedPxPerSec(): number {
    return Math.max(1, this.settings.speedPxPerSec * this.playbackRate);
  }

  /**
   * Schedule queue processing retry when lanes are temporarily occupied
   */
  private scheduleRetry(waitMs: number): void {
    if (this.isPaused) return;

    const delay = Math.max(
      RENDERER_LAYOUT.RETRY_DELAY_MIN_MS,
      Math.min(waitMs, RENDERER_LAYOUT.RETRY_DELAY_MAX_MS)
    );
    this.clearRetryTimer();

    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.processQueue();
    }, delay);
  }

  /**
   * Clear pending queue retry timer
   */
  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Log performance warning when concurrent message count is high
   * Limited to once per 10 seconds to avoid log spam
   */
  private logPerformanceWarning(): void {
    const now = Date.now();
    if (now - this.lastWarningTime < this.WARNING_INTERVAL_MS) {
      return;
    }

    this.lastWarningTime = now;
    log.warn(
      `Performance warning: ${this.activeMessages.size} concurrent messages ` +
        `(recommended max: ${this.settings.maxConcurrentMessages}). ` +
        'Consider reducing maxMessagesPerSecond setting.'
    );
  }

  /**
   * Apply common visual styles shared by all message kinds
   */
  private applyCommonMessageStyles(
    element: HTMLDivElement,
    message: ChatMessage,
    isSuperChat: boolean,
    isMembership: boolean
  ): void {
    element.style.fontSize = `${this.settings.fontSize}px`;
    element.style.opacity = `${this.settings.opacity}`;

    // Apply author color only for regular messages
    if (!isSuperChat && !isMembership) {
      element.style.color = this.settings.colors[message.authorType];
    }
  }

  /**
   * Render a single message.
   *
   * Uses Canvas-based dimension estimation (no DOM reflow) and
   * CSS animation (@keyframes) instead of element.animate().
   */
  private renderMessage(message: ChatMessage): RenderResult {
    const renderContext = this.getRenderContext();
    if (!renderContext) {
      log.debug('Cannot render: container or dimensions missing');
      return { status: 'dropped' };
    }

    const { container, dimensions } = renderContext;

    // ── Step 1: Estimate dimensions via Canvas (no DOM append) ─────────
    const estimated = this.messageBuilder.estimateMessageDimensions(message);
    const messageHeight = estimated.height;

    // ── Step 2: Find available lane ────────────────────────────────────
    const placement = this.laneAllocator.findPlacement(messageHeight, dimensions);
    if (placement === null) {
      log.debug(
        `No available lane for message (height: ${messageHeight}px). ` +
          `Active messages: ${this.activeMessages.size}, Lanes: ${dimensions.laneCount}, ` +
          `Queue size: ${this.renderQueue.length}`
      );
      return { status: 'dropped' };
    }

    if (placement.waitMs > 0) {
      return { status: 'deferred', waitMs: placement.waitMs };
    }

    // ── Step 3: Build element ──────────────────────────────────────────
    const builtMessage = this.messageBuilder.buildMessageElement(message);
    if (!builtMessage) {
      return { status: 'dropped' };
    }

    const { element, isSuperChat, isMembership } = builtMessage;
    this.applyCommonMessageStyles(element, message, isSuperChat, isMembership);

    // ── Step 4: Position, append, animate (single DOM touch) ──────────
    const activeMessage = this.setupMessageAnimation(
      element,
      placement,
      estimated.width,
      messageHeight,
      dimensions
    );

    // Append to container — now the element is at its final start
    // position so there is no hidden measurement phase.
    container.appendChild(element);

    // Track active message
    this.activeMessages.add(activeMessage);

    log.debug('Rendering message:', {
      text: message.text.substring(0, 20),
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

  /**
   * Remove message by element
   */
  private removeMessageByElement(element: HTMLDivElement): void {
    const active = Array.from(this.activeMessages).find((m) => m.element === element);
    if (active) {
      this.removeMessage(active);
    }
  }

  /**
   * Remove active message
   *
   * Detaches animationend listener before removing the element
   * so the auto-cleanup callback does not re-enter the removal path.
   */
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

  /**
   * Update settings
   */
  updateSettings(settings: OverlaySettings, options: RendererUpdateOptions = {}): void {
    this.settings = settings;
    this.injectStyles();

    if (options.resetState) {
      this.resetRenderedState();
      this.laneAllocator.reset(this.overlay.getDimensions());
      return;
    }

    if (this.laneAllocator.isEmpty()) {
      this.laneAllocator.reset(this.overlay.getDimensions());
    }
  }

  /**
   * Pause all active CSS animations via animation-play-state
   */
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

  /**
   * Resume all active CSS animations and process queued messages
   */
  resume(): void {
    if (!this.isPaused) return;

    const now = Date.now();
    if (this.pausedAt !== null) {
      // Cap to 60s so lanes don't get pushed far into the future after long pauses.
      const pausedDuration = Math.min(Math.max(0, now - this.pausedAt), 60_000);
      if (pausedDuration > 0) {
        this.laneAllocator.shiftTimeline(pausedDuration);
      }
    }
    this.pausedAt = null;

    log.debug('Resuming all animations');
    this.isPaused = false;
    this.forEachElement((el) => {
      el.style.animationPlayState = 'running';
    });
    log.debug(`Resumed ${this.activeMessages.size} animations`);

    // Process any queued messages
    this.processQueue();
  }

  /**
   * Set playback rate for all active CSS animations.
   *
   * CSS animations lack a native playbackRate property, so we restart
   * each animation with an adjusted duration and seek to the correct
   * elapsed time via negative animation-delay.
   */
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

        // Restart CSS animation with new duration, seeked to current position.
        // Forced reflow here is acceptable since rate changes are infrequent.
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

  /**
   * Helper method to apply an operation to all active message elements.
   * Replaces the old forEachAnimation that operated on Animation objects.
   */
  private forEachElement(operation: (element: HTMLDivElement) => void): void {
    for (const active of this.activeMessages) {
      try {
        operation(active.element);
      } catch (error) {
        log.warn('Element operation failed:', error);
      }
    }
  }

  /**
   * Destroy and cleanup all resources
   */
  destroy(): void {
    this.isPaused = false;
    this.overlayDimensionsUnsubscribe?.();
    this.overlayDimensionsUnsubscribe = null;

    this.resetRenderedState();
    this.seenMessageIds.clear();
    this.pausedAt = null;
    this.playbackRate = 1;

    this.styleElement?.remove();
    this.styleElement = null;

    log.debug('Destroyed');
  }
}
