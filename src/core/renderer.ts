/**
 * Renderer
 *
 * Renders chat messages with Nico-nico style flowing animation.
 * Manages lanes and collision detection.
 */

import type { ChatMessage, OutlineSettings, OverlayDimensions, OverlaySettings } from '@app-types';
import { rendererLayout, shadows } from '@core/design-tokens';
import { createLogger } from '@core/logging';
import { MessageIdRegistry } from '@core/message-id-registry';
import type { Overlay } from '@core/overlay';
import { LaneAllocator, type LanePlacement } from '@core/renderer-lanes';
import { RendererMessageBuilder } from '@core/renderer-message-builder';
import { RENDERER_STATIC_STYLES } from '@core/renderer-styles';

const log = createLogger('Renderer');

/** @internal Queue entry wrapping a message with retry scheduling metadata and priority. */
interface QueuedMessage {
  message: ChatMessage;
  nextAttemptAt: number;
  priority: number;
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

/** Tolerance (ms) for sweepStaleAnimations: skip messages whose animation
 *  has not had enough time to complete, to avoid false positives from
 *  getAnimations() being unreliable shortly after start. */
const SWEEP_TOLERANCE_MS = 500;

/** Maximum random delay (ms) added to each message's animation start to
 *  stagger entries across lanes without creating a visible chat-to-overlay gap. */
const MAX_ANIMATION_JITTER_MS = 15;

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
  private readonly pendingQueue: QueuedMessage[] = [];
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
  /** Ids of messages already enqueued/rendered, for dedup across reconnect/resume. */
  private static readonly SEEN_MESSAGE_IDS_LIMIT = 200;
  private readonly seenMessageIds = new MessageIdRegistry(Renderer.SEEN_MESSAGE_IDS_LIMIT);
  private visibilityHandler: (() => void) | null = null;
  /** Maximum queue size when tab is in background. */
  private static readonly BACKGROUND_QUEUE_MAX = 10;
  /** 현재 동적 큐 최대 크기 (히스테리시스 캐시) */
  private queueMaxSizeCache: number = 30;
  /** 큐 크기 축소를 위한 다운카운트 (2회 연속 언더플로우 필요) */
  private queueShrinkCountdown: number = 0;
  /** 언더플로우 감지 시작 시간 */
  private queueUnderflowStart: number = 0;

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
    this.overlayDimensionsUnsubscribe = this.overlay.onDimensionsChanged((dimensions) => {
      this.handleOverlayDimensionsChange(dimensions);
    });

    // visibilitychange handler for tab visibility optimization
    this.visibilityHandler = () => {
      if (document.hidden) {
        this.handleBackgroundTab();
      } else {
        this.handleForegroundTab();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private resetRenderedState(): void {
    this.clearRetryTimer();

    for (const active of Array.from(this.activeMessages)) {
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

    // Re-init lane collision state but keep active animations running so
    // messages finish flowing across the screen instead of vanishing mid-way
    // when the player resizes or enters/exits fullscreen.
    this.laneAllocator.reset(dimensions);

    if (!this.isPaused && this.pendingQueue.length > 0) {
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
      fontSize * rendererLayout.exitPaddingScale,
      rendererLayout.exitPaddingMin
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
      rendererLayout.durationMin,
      Math.min(rendererLayout.durationMax, (adjustedDistance / effectiveSpeedPxPerSec) * 1000)
    );
    const adjustedDuration = baseDuration / this.playbackRate;

    // Minimal start-position stagger: small per-lane jitter so messages
    // on different lanes don't begin at identical horizontal offsets.
    // The maximum delay is kept very low (≤15ms) to minimise the
    // chat-to-overlay visual gap.
    const laneDelay = Math.floor(Math.random() * MAX_ANIMATION_JITTER_MS);

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

    // Cleanup via animationend event.
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
   * Add message to render queue.
   *
   * Processing is triggered synchronously so the message starts flowing
   * without waiting for a microtask boundary.  To avoid re-entrance and
   * excessive work, processQueue() dynamically sizes the batch per cycle
   * based on queue pressure and uses the retry-timer mechanism for
   * remaining items.
   */
  addMessage(message: ChatMessage): void {
    // Dedup fast path: quick Set.has() check only.
    if (message.id && this.seenMessageIds.has(message.id)) {
      return;
    }

    // Enqueue with dynamically bounded capacity — drop oldest when full.
    // Under high load the queue grows up to 2x the base size so fewer
    // messages are dropped during bursts.
    const queueMaxSize = this.getDynamicQueueMaxSize();
    if (this.pendingQueue.length >= queueMaxSize) {
      const excess = this.pendingQueue.length - queueMaxSize + 1;
      // Sort by priority ASC (lowest first), then timestamp ASC (oldest first),
      // and drop the lowest-priority messages.
      this.pendingQueue.sort(
        (a, b) => a.priority - b.priority || a.message.timestamp - b.message.timestamp
      );
      this.pendingQueue.splice(0, excess);
      // Restore priority DESC + timestamp ASC order for processing.
      this.pendingQueue.sort(
        (a, b) => b.priority - a.priority || a.message.timestamp - b.message.timestamp
      );
    }

    const priority = Renderer.getMessagePriority(message);
    this.pendingQueue.push({ message, nextAttemptAt: 0, priority });

    // Register ID lazily — only after enqueue, so the hot path does not
    // pay for potential Set eviction on every message.
    if (message.id) {
      this.seenMessageIds.mark(message.id);
    }

    // Process immediately unless paused.
    if (!this.isPaused) {
      this.processQueue();
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
        // Time-based guard: do not remove messages before their animation
        // has had sufficient time to complete. getAnimations() / playState
        // can be unreliable during the animation-delay period and shortly
        // after start across different browsers.
        const elapsed = performance.now() - active.startTime;
        const minLifetimeMs = active.baseDuration + SWEEP_TOLERANCE_MS;
        if (elapsed < minLifetimeMs) return;

        const animations = active.element.getAnimations();
        if (animations.length === 0) {
          this.activeMessages.delete(active);
          if (active.element.parentNode) {
            active.element.remove();
          }
          return;
        }

        for (const anim of animations) {
          if (anim.playState === 'finished') {
            this.activeMessages.delete(active);
            if (active.element.parentNode) {
              active.element.remove();
            }
            return;
          }
        }
      } catch (error) {
        log.debug('Failed to check animation state during sweep:', error);
        this.activeMessages.delete(active);
      }
    });
  }

  /**
   * Compute the maximum number of messages to process per cycle.
   *
   * Adapts batch size based on both queue depth and active message density:
   * - 5-level base batch size (4/7/10/15/20) based on queue depth
   * - Utilization factor reduces batch when screen is congested
   */
  private getDynamicMaxPerCycle(): number {
    const len = this.pendingQueue.length;
    const activeCount = this.activeMessages.size;
    const maxConcurrent = this.getMaxConcurrentMessages();
    // 활성 메시지 밀도 (0.0 ~ 1.0)
    const utilization = maxConcurrent > 0 ? activeCount / maxConcurrent : 0;

    // 기본 배치 크기는 큐 깊이 기반 (5단계)
    let base: number;
    if (len >= 25) {
      base = 20;
    } else if (len >= 15) {
      base = 15;
    } else if (len >= 8) {
      base = 10;
    } else if (len >= 4) {
      base = 7;
    } else {
      base = 4;
    }

    // utilization이 높으면(화면이 꽉 찼으면) 배치 크기 감소
    // 새 메시지를 추가해도 레인을 찾지 못하고 deferred될 가능성이 높기 때문
    if (utilization > 0.8) {
      // 화면이 거의 꽉 참 → 배치 크기를 줄여 deferred/failed 재시도 부하 감소
      return Math.max(3, Math.floor(base * 0.6));
    }
    if (utilization > 0.5) {
      // 화면이 어느 정도 참 → 약간 감소
      return Math.max(4, Math.floor(base * 0.8));
    }

    return base;
  }

  /**
   * 최대 동시 메시지 수를 추정합니다.
   * 레인 수를 기반으로 각 레인이 동시에 1~2개 메시지를 처리할 수 있다고 가정합니다.
   */
  private getMaxConcurrentMessages(): number {
    const laneCount = this.laneAllocator.getLaneCount();
    // 각 레인은 최대 2개 메시지를 동시에 처리할 수 있다고 가정 (화면에 표시 중 + 대기)
    return laneCount * 2;
  }

  /**
   * 현재 메시지 밀도에 기반한 동적 속도 배수를 반환합니다.
   * 밀도가 높을수록 속도가 빨라져 화면 혼잡을 완화합니다.
   */
  private getDynamicSpeedMultiplier(): number {
    const activeCount = this.activeMessages.size;
    const maxConcurrent = this.getMaxConcurrentMessages();
    if (maxConcurrent <= 0) {
      return 1;
    }

    const density = activeCount / maxConcurrent;

    // 밀도가 임계값 이하면 기본 속도
    if (density <= rendererLayout.speedDensityThresholdLow) {
      return rendererLayout.speedDensityLow;
    }

    // 밀도가 임계값 이상이면 최대 속도
    if (density >= rendererLayout.speedDensityThresholdHigh) {
      return rendererLayout.speedDensityHigh;
    }

    // 밀도에 따라 선형 보간 (0.8 ~ 1.5)
    const t =
      (density - rendererLayout.speedDensityThresholdLow) /
      (rendererLayout.speedDensityThresholdHigh - rendererLayout.speedDensityThresholdLow);
    return (
      rendererLayout.speedDensityLow +
      t * (rendererLayout.speedDensityHigh - rendererLayout.speedDensityLow)
    );
  }

  /**
   * Compute the retry delay based on queue pressure.
   *
   * When the queue is deep, reduce the gap between processQueue
   * invocations so the backlog drains faster:
   * - queue >= 15 ->  0ms  (immediate retry)
   * - queue >=  5 ->  2ms  (half the min delay)
   * - otherwise  ->  4ms  (default min delay)
   */
  private getDynamicRetryDelay(): number {
    const queueLen = this.pendingQueue.length;
    if (queueLen >= 15) return 0;
    if (queueLen >= 5) return Math.max(1, rendererLayout.retryDelayMinMs / 2);
    return rendererLayout.retryDelayMinMs;
  }

  /**
   * Compute the effective queue capacity.
   *
   * Under pressure the queue expands up to 2x the base size so bursty
   * traffic causes fewer drops.  When pressure subsides, new messages
   * that overflow the base size will still trigger the drop path, but
   * only after the expanded capacity is genuinely exhausted.
   */
  /**
   * Returns a priority score based on the message kind.
   * Higher-priority messages are rendered first and survive queue overflow.
   *
   * @param message - The chat message to evaluate.
   * @returns Priority score (superchat=200, membership=100, normal=0).
   */
  private static getMessagePriority(message: ChatMessage): number {
    // Cast to string to support future kind values not yet in ChatMessageKind.
    switch (message.kind as string) {
      case 'superchat':
      case 'superchat-paid-sticker':
        return 200;
      case 'membership':
      case 'membership-gift-receipt':
        return 100;
      default:
        return 0;
    }
  }

  /**
   * Compute the effective queue capacity with exponential backoff and
   * hysteresis to prevent frequent resizing oscillations.
   *
   * - **Overflow**: When the queue fills past DEFAULT_SIZE, capacity grows
   *   exponentially (1.5x) up to MAX_SIZE (100).
   * - **Underflow (Hysteresis)**: When queue length stays below
   *   (maxSize * UNDERFLOW_RATIO) for at least UNDERFLOW_DURATION_MS and
   *   the condition holds for SHRINK_REQUIRED_COUNT consecutive cycles,
   *   capacity shrinks by half (down to MIN_SIZE = 20).
   */
  private getDynamicQueueMaxSize(): number {
    const DEFAULT_SIZE = 30;
    const MAX_SIZE = 100;
    const MIN_SIZE = 20;
    const UNDERFLOW_RATIO = 0.5; // maxSize의 50% 미만이면 언더플로우
    const UNDERFLOW_DURATION_MS = 30_000; // 30초 지속 필요
    const SHRINK_REQUIRED_COUNT = 2; // 2회 연속 조건 충족 필요

    const len = this.pendingQueue.length;

    // --- 확장 (Overflow) ---
    // 큐가 가득 차면 1.5배씩 지수적으로 확장 (최대 MAX_SIZE)
    if (len >= DEFAULT_SIZE && this.queueMaxSizeCache < MAX_SIZE) {
      const newSize = Math.min(MAX_SIZE, Math.round(this.queueMaxSizeCache * 1.5));
      this.queueMaxSizeCache = newSize;
      this.queueShrinkCountdown = 0; // 확장 시 축소 카운트 리셋
      this.queueUnderflowStart = 0; // 언더플로우 감지 리셋
      return newSize;
    }

    // --- 축소 (Underflow with Hysteresis) ---
    // 큐 크기가 maxSize의 UNDERFLOW_RATIO 미만이면 축소 가능 상태
    if (len < this.queueMaxSizeCache * UNDERFLOW_RATIO) {
      if (this.queueUnderflowStart === 0) {
        this.queueUnderflowStart = Date.now();
      }

      const elapsed = Date.now() - this.queueUnderflowStart;

      if (elapsed >= UNDERFLOW_DURATION_MS) {
        this.queueShrinkCountdown++;

        if (this.queueShrinkCountdown >= SHRINK_REQUIRED_COUNT) {
          // 2회 연속 조건 충족 → 축소 실행
          const newSize = Math.max(MIN_SIZE, Math.round(this.queueMaxSizeCache / 2));
          this.queueMaxSizeCache = newSize;
          this.queueShrinkCountdown = 0;
          this.queueUnderflowStart = 0;
          return newSize;
        }
      }
    } else {
      // 언더플로우 상태가 아님 → 카운트 리셋
      this.queueShrinkCountdown = 0;
      this.queueUnderflowStart = 0;
    }

    return this.queueMaxSizeCache;
  }

  /**
   * Process messages from the queue immediately.
   *
   * Renders up to getDynamicMaxPerCycle() messages per invocation to
   * reduce per-message timer overhead when lanes are available.  Falls
   * back to scheduleRetry when the next message is deferred or the
   * batch limit is reached with more messages waiting.
   *
   * The retry delay is adjusted dynamically based on queue pressure
   * so the backlog drains faster under high load.
   */
  private processQueue(): void {
    // Don't process while paused
    if (this.isPaused) {
      return;
    }

    this.sweepStaleAnimations();
    this.clearRetryTimer();

    if (this.pendingQueue.length === 0) {
      return;
    }

    // Sort by priority descending (highest first), then by timestamp ascending
    // so high-priority messages (superchat, membership) render before normal chat.
    this.pendingQueue.sort(
      (left, right) =>
        right.priority - left.priority || left.message.timestamp - right.message.timestamp
    );

    const now = Date.now();
    const nextMessage = this.pendingQueue[0];
    if (!nextMessage) return;

    // If the front message is still deferring, wait.
    if (nextMessage.nextAttemptAt > now) {
      this.scheduleRetry(nextMessage.nextAttemptAt - now);
      return;
    }

    // Soft cap warning (non-blocking)
    if (this.activeMessages.size >= this.settings.maxConcurrentMessages) {
      this.logPerformanceWarning();
    }

    // Dynamic batch size based on queue pressure.
    let processed = 0;
    const maxPerCycle = this.getDynamicMaxPerCycle();
    // When queue is deep (>=10), allow lane overwrite for congested lanes
    // so the backlog drains even when all visible lanes are occupied.
    const forceOverwriteMs = this.pendingQueue.length >= 10 ? 100 : undefined;

    while (this.pendingQueue.length > 0 && processed < maxPerCycle) {
      const queued = this.pendingQueue[0];
      if (!queued) break;

      if (queued.nextAttemptAt > Date.now()) {
        this.scheduleRetry(queued.nextAttemptAt - Date.now());
        return;
      }

      const result = this.renderMessage(queued.message, forceOverwriteMs);

      if (result.status === 'deferred') {
        queued.nextAttemptAt = Date.now() + result.waitMs;
        this.scheduleRetry(result.waitMs);
        return;
      }

      this.pendingQueue.shift();
      processed++;
    }

    // Schedule next if there are still messages waiting.
    if (this.pendingQueue.length > 0 && !this.isPaused) {
      this.scheduleRetry(this.getDynamicRetryDelay());
    }
  }

  /**
   * Get effective message speed considering current video playback rate
   */
  private getEffectiveSpeedPxPerSec(): number {
    const baseSpeed = this.settings.speedPxPerSec;
    const multiplier = this.getDynamicSpeedMultiplier();
    return Math.max(1, baseSpeed * multiplier * this.playbackRate);
  }

  /**
   * Schedule queue processing retry when lanes are temporarily occupied
   */
  private scheduleRetry(waitMs: number): void {
    if (this.isPaused) return;

    const delay = Math.max(
      rendererLayout.retryDelayMinMs,
      Math.min(waitMs, rendererLayout.retryDelayMaxMs)
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
   *
   * @param forceOverwriteMs - When set, lanes with a wait >= this value
   *   are force-assigned (overwriting the occupant) to drain a deep queue.
   */
  private renderMessage(message: ChatMessage, forceOverwriteMs?: number): RenderResult {
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
    const placement = this.laneAllocator.findPlacement(messageHeight, dimensions, forceOverwriteMs);
    if (placement === null) {
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

  private handleBackgroundTab(): void {
    // Limit queue size when tab is hidden to reduce memory usage.
    // Drop lowest-priority messages first using the priority system from Phase 1.
    if (this.pendingQueue.length > Renderer.BACKGROUND_QUEUE_MAX) {
      const excess = this.pendingQueue.length - Renderer.BACKGROUND_QUEUE_MAX;
      this.pendingQueue.sort(
        (a, b) => a.priority - b.priority || a.message.timestamp - b.message.timestamp
      );
      this.pendingQueue.splice(0, excess);
      // Restore priority DESC + timestamp ASC order for processing.
      this.pendingQueue.sort(
        (a, b) => b.priority - a.priority || a.message.timestamp - b.message.timestamp
      );
    }
  }

  private handleForegroundTab(): void {
    // Resume queue processing immediately when returning to foreground.
    this.processQueue();
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

    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    this.playbackRate = 1;

    this.styleElement?.remove();
    this.styleElement = null;

    log.debug('Destroyed');
  }
}
