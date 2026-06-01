// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * RendererCanvas — Canvas 2D-based renderer.
 *
 * Uses requestAnimationFrame instead of CSS @keyframes animations.
 * Each frame computes positions with Math.floor() to snap to integer pixel
 * coordinates, eliminating the sub-pixel text jitter inherent in CSS
 * transform interpolation.
 *
 * Extends RendererBase for shared state machine, rate limiting, burst
 * detection, and lane allocation.
 *
 * Stagger delay: messages in the same drainQueue batch are given an
 * exponentially-distributed time offset (0-200ms) before they start
 * scrolling. This spreads simultaneous entries across time, preventing
 * the visual clumping that occurs when multiple messages enter from the
 * right edge in the same frame. During the stagger period the message
 * sits at the start position (right edge) but is not rendered. The lane
 * allocator reservation is unaffected — the lane is locked from the
 * actual commit time, not the visual start time.
 *
 * Fixes from audit:
 * - BUG-1: updateSettings now propagates _options to super
 * - BUG-4: reverse travel distance uses consistent exitPadding
 * - BUG-5/6: image caches only store loaded images, errors don't cache
 */

import type { ChatMessage, DropReason, OverlayDimensions, OverlaySettings } from '@app-types';
import { ByteLimitedCache } from '@core/byte-limited-cache';
import { renderPaidCard } from '@core/canvas-card-renderers';
import { drawRoundRect, renderRegularMessage } from '@core/canvas-text-renderer';
import { createMembershipCardConfig, createSuperChatCardConfig } from '@core/card-config';
import { getTranslatableText } from '@core/chat-message-helpers';
import { computeScrollDuration, standbyMessageLayout } from '@core/design-tokens';
import { clearSafeAnimationFrame, forEachSlot } from '@core/dom';
import { ImageFetchManager } from '@core/image-fetch-manager';
import type { LanePlacement } from '@core/lane-allocator';
import { LaneAllocator } from '@core/lane-allocator';
import { createLogger } from '@core/logging';
import { MessageActivator } from '@core/message-activator';
import type { Overlay } from '@core/overlay';
import { PriorityBucketQueue } from '@core/priority-bucket-queue';
import { RendererBase } from '@core/renderer-base';
import {
  DRAIN_QUEUE_MAX_SKIP as _DRAIN_QUEUE_MAX_SKIP,
  HORIZONTAL_STAGGER_MAX as _HORIZONTAL_STAGGER_MAX,
  HORIZONTAL_STAGGER_PER_STEP as _HORIZONTAL_STAGGER_PER_STEP,
  OPACITY_BUCKET_COUNT as _OPACITY_BUCKET_COUNT,
  STAGGER_BATCH_MAX as _STAGGER_BATCH_MAX,
  STAGGER_EXP_SCALE as _STAGGER_EXP_SCALE,
  TIER_NEAR_THRESHOLD as _TIER_NEAR_THRESHOLD,
  TRANSLATION_FONT_SCALE as _TRANSLATION_FONT_SCALE,
  TRANSLATION_GAP_PX as _TRANSLATION_GAP_PX,
  TRANSLATION_OPACITY_SCALE as _TRANSLATION_OPACITY_SCALE,
  type CanvasMessage,
  hashStringForTier,
  SPEED_TIER,
} from '@core/renderer-constants';
import {
  computeMessageOpacity,
  estimateMessageDimensions as sharedEstimateDimensions,
} from '@core/renderer-shared';
import { RenderWorkerManager } from '@core/renderer-worker-manager';
import { clearTextMeasurementCaches, getFontString, measureTextHeight } from '@core/text-measure';
import { TranslationService } from '@core/translation-service';
import { renderSegment } from '@shared/canvas-rendering-shared';

/**
 * Remove expired messages in-place, simultaneously maintaining the
 * lane-indexed map incrementally during compaction.
 * Returns the new logical length and whether any messages were removed.
 */
function cleanupExpiredMessages(
  messages: CanvasMessage[],
  now: number,
  activeMessagesByLane: Map<number, CanvasMessage[]>,
  onExpire?: (msg: CanvasMessage) => void
): { newLength: number; anyRemoved: boolean; newMessages?: CanvasMessage[] } {
  const oldLength = messages.length;
  let writeIdx = 0;
  let anyRemoved = false;

  // Single pass: compact messages + detect expirations.
  for (let i = 0; i < oldLength; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const elapsed = now - msg.startTime - msg.pausedDuration;
    if (elapsed < msg.duration) {
      messages[writeIdx] = msg;
      writeIdx++;
    } else {
      anyRemoved = true;
      onExpire?.(msg);
    }
  }

  // Only rebuild lane map when messages actually expired — avoids
  // unnecessary O(N) Map operations on every frame (7200 ops/sec at 120 msg × 60fps).
  if (anyRemoved) {
    activeMessagesByLane.clear();
    for (let i = 0; i < writeIdx; i++) {
      const msg = messages[i];
      if (!msg) continue;
      let laneList = activeMessagesByLane.get(msg.laneIndex);
      if (!laneList) {
        laneList = [];
        activeMessagesByLane.set(msg.laneIndex, laneList);
      }
      laneList.push(msg);
    }
  }
  // Array compaction threshold: when more than 50% of the array slots are
  // expired, allocate a fresh array via slice() instead of nulling the tail.
  // This avoids keeping garbage-filled tail slots in the array, at the cost
  // of one allocation, which is worthwhile when the majority is garbage.
  if (writeIdx < oldLength * 0.5) {
    return { newMessages: messages.slice(0, writeIdx), newLength: writeIdx, anyRemoved };
  }
  // Otherwise, truncate the array to remove stale references (no allocation of a new array).
  messages.length = writeIdx;
  return { newLength: writeIdx, anyRemoved };
}

/** Accumulate paused duration across all active messages. */
function applyPausedDurationToMessages(messages: CanvasMessage[], pausedMs: number): void {
  for (const msg of messages) {
    msg.pausedDuration += pausedMs;
  }
}

const log = createLogger('RendererCanvas');

/** Pre-built card configs — module-level singletons since they only depend on design-token constants. */
const SUPERCHAT_CARD_CONFIG = createSuperChatCardConfig();
const MEMBERSHIP_CARD_CONFIG = createMembershipCardConfig();

export class CanvasRenderer extends RendererBase {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private animFrameId: number | null = null;
  /** Pre-computed 1/maxMessageAgeMs to avoid per-frame division in opacity calc. */
  private readonly ageFadeRate = 1 / this.settings.maxMessageAgeMs;
  /** Pre-computed 1/fadeDurationMs to avoid per-frame division in opacity calc. */
  private invFadeDuration = 1 / Math.max(1, 500);
  private overlayDimensionsUnsubscribe: (() => void) | null = null;
  /** Debounce flag for emoji-load-triggered rAF restarts. */
  private needsRerender = false;
  /** Image fetch manager for loading and caching emoji, author photos, and stickers. */
  private imageFetchManager!: ImageFetchManager;

  private readonly activeMessages: CanvasMessage[] = [];
  /** Lane-indexed active messages for O(1) lane-scoped collision checks. */
  private readonly activeMessagesByLane = new Map<number, CanvasMessage[]>();
  private readonly pendingQueue = new PriorityBucketQueue();
  private readonly retryQueue: ChatMessage[] = [];

  /** Last devicePixelRatio seen — used to detect DPR changes. */
  private lastDpr = 0;
  /** When the idle condition is first met, record the timestamp so the loop
   * continues for a grace period before stopping. Prevents start/stop
   * thrashing during sparse chat intervals. */
  private idleSince: number | null = null;
  /** Whether the session is in standby mode (pre-live, waiting for stream). */
  private standbyStatus = false;
  private translationService: TranslationService;
  private messageActivator: MessageActivator;

  /** Max translations to apply per frame to avoid single-frame spikes during chat bursts. */
  private readonly translationBatchSize: number;

  /**
   * Pending translation results collected between frames.
   * Promise callbacks push here; renderFrame() applies up to
   * translationBatchSize per frame, leaving the rest for
   * subsequent frames to avoid frame spikes during chat bursts.
   */
  private pendingTranslations: Array<{ msg: CanvasMessage; text: string | null }> = [];

  /**
   * OffscreenCanvas Web Worker for off-main-thread rendering.
   * When active, the worker owns the render loop; the main thread
   * handles message ingress, translation, and image loading only.
   * Falls back to main-thread rendering when unavailable.
   */
  private workerManager!: RenderWorkerManager;

  /**
   * Text bitmap cache: pre-rendered text with outline as offscreen canvas.
   * Key = `${font}|${text}|${color}|${strokeWidth}|${strokeColor}`.
   * On cache hit, drawImage() replaces fillText()+strokeText() in the hot path.
   * Bounded to 200 entries (FIFO eviction with LRU touch on re-insert) to prevent unbounded memory growth
   * in long-running streams.
   */
  private readonly textBitmapCache = new ByteLimitedCache<HTMLCanvasElement>(
    this.settings.textCacheMb * 1_000_000, // configurable MB
    (c) => c.width * c.height * 4 // RGBA bytes
  );
  private readonly superChatGradientCache = new Map<string, CanvasGradient>();

  /** Cached message dimensions by message ID. Cleared on settings change. */
  private readonly dimensionCache = new Map<string, { width: number; height: number }>();

  /** Max cached dimension entries before LRU eviction. */
  private static readonly DIMENSION_CACHE_MAX = 1000;

  /**
   * Pre-allocated opacity buckets for per-frame reuse.
   * Bucket index = Math.round(opacity * 20), yielding 21 buckets (0.00–1.00 in 0.05 steps).
   * Each frame resets bucket lengths instead of allocating new arrays/Map, eliminating
   * the per-frame GC pressure from Map + {msg,elapsed} object creation.
   */
  private readonly _opacityBuckets: Array<Array<{ msg: CanvasMessage; elapsed: number }>> =
    Array.from({ length: _OPACITY_BUCKET_COUNT }, () => []);

  /** Cached opacity config object — rebuilt on settings changes to avoid per-frame allocation. */
  private _cachedOpacityConfig!: {
    baseOpacity: number;
    fadeDurationMs: number;
    invFadeDuration: number;
    backlogOpacityMultiplier: number;
    depthLayersEnabled: boolean;
    depthFarOpacityMul: number;
    ageFadeRate: number;
  };

  /** Pre-bound getFont to avoid per-call arrow function allocation. */
  private readonly _boundGetFont = (fs: number): string => this.getFont(fs);

  /**
   * Horizontal stagger per batch index step (px).
   * Each successive message in a drainQueue batch starts this many pixels
   * further to the right, spreading them horizontally so they don't all
   * enter from the same right-edge position.
   */
  private static readonly HORIZONTAL_STAGGER_PER_STEP = _HORIZONTAL_STAGGER_PER_STEP;

  /**
   * Maximum horizontal stagger offset (px).
   * Prevents messages from starting too far off-screen, which would
   * increase scroll duration unnecessarily.
   */
  private static readonly HORIZONTAL_STAGGER_MAX = _HORIZONTAL_STAGGER_MAX;

  /**
   * Max number of consecutive collision skips in the drain queue.
   * Prevents scanning the entire pending queue when all entries collide.
   */
  private static readonly DRAIN_QUEUE_MAX_SKIP = _DRAIN_QUEUE_MAX_SKIP;

  /** Stagger queue depth thresholds. */
  private static readonly STAGGER_QUEUE_HIGH = 50;
  private static readonly STAGGER_QUEUE_MED = 30;

  /** Translation font scale relative to main font size. */
  private static readonly TRANSLATION_FONT_SCALE = _TRANSLATION_FONT_SCALE;
  /** Gap (px) between original text and translation text. */
  private static readonly TRANSLATION_GAP_PX = _TRANSLATION_GAP_PX;
  /** Translation opacity scale relative to message opacity. */
  private static readonly TRANSLATION_OPACITY_SCALE = _TRANSLATION_OPACITY_SCALE;

  /**
   * Priority threshold for anti-block gate: messages with priority >= this
   * value bypass the anti-block throttle so high-priority content (SuperChat,
   * Membership) is never blocked by lane saturation.
   */
  private static readonly ANTI_BLOCK_PRIORITY_THRESHOLD = 80;

  /** Tier split threshold: hash < this value → Near tier, else Far tier. */
  private static readonly TIER_NEAR_THRESHOLD = _TIER_NEAR_THRESHOLD;

  /** Maximum batch index for stagger exponential scale computation. */
  private static readonly STAGGER_BATCH_MAX = _STAGGER_BATCH_MAX;
  /** Exponential scale factor for stagger delay (negative value = decreasing delay). */
  private static readonly STAGGER_EXP_SCALE = _STAGGER_EXP_SCALE;

  /** Grace period (ms) that the render loop continues after the idle condition
   * is met. Prevents start/stop thrashing during sparse chat intervals. */
  private static readonly IDLE_GRACE_PERIOD_MS = 500;

  constructor(overlay: Overlay, settings: OverlaySettings) {
    super(overlay, settings);
    this.invFadeDuration = 1 / Math.max(1, settings.fadeDurationMs);
    this.translationBatchSize = settings.translationBatchSize;
    this.translationService = new TranslationService();
    this.translationService.configure({
      enabled: settings.translationEnabled,
      service: settings.translationService,
      source: settings.translationSource,
      target: settings.translationTarget,
    });
    this.messageActivator = new MessageActivator(this.translationService, {
      topBottomDurationMs: settings.topBottomDurationMs,
      depthLayersEnabled: settings.depthLayersEnabled,
    });

    const container = overlay.getContainer();
    const canvas = document.createElement('canvas');
    canvas.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;text-rendering:optimizeSpeed';
    if (container) container.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    if (!this.ctx) {
      log.warn('Failed to get CanvasRenderingContext2D — renderer will be inactive');
    } else if (!canvas.isConnected) {
      log.warn('Canvas created but not connected to DOM — renderer will be inactive');
    }

    // Initialize ImageFetchManager BEFORE RenderWorkerManager so the worker
    // receives a valid reference instead of undefined.
    this.imageFetchManager = new ImageFetchManager();

    // Initialize OffscreenCanvas worker for off-main-thread rendering.
    // Falls back silently to main-thread rendering when unavailable
    // (e.g. missing APIs, CSP restrictions, build-time exclusion).
    this.workerManager = new RenderWorkerManager({
      settings: this.settings,
      observability: this.observability,
      imageFetchManager: this.imageFetchManager,
      estimateDimensions: (msg) => this.estimateDimensions(msg),
      getMessagePriority: CanvasRenderer.getMessagePriority,
      getEffectiveSpeedPxPerSec: () => this.getEffectiveSpeedPxPerSec(),
    });
    const useWorker = this.workerManager.init(canvas, settings, overlay);

    const dims = overlay.getDimensions();
    if (!useWorker) this.applyDevicePixelRatio(dims);

    this.overlayDimensionsUnsubscribe = overlay.onDimensionsChanged((d) => {
      if (d && this.canvas) {
        this.applyDevicePixelRatio(d);
        this.laneAllocator.reset(d);
      }
    });

    this.startRenderLoop();
    this.imageFetchManager.updateConfig(settings, this.workerManager.workerRef);
    this.imageFetchManager.setOnImageReady(() => {
      if (!this.isPaused && !this.isVideoPaused && !this.needsRerender) {
        if (this.animFrameId !== null) {
          this.animFrameId = clearSafeAnimationFrame(this.animFrameId);
        }
        this.needsRerender = true;
        this.startRenderLoop();
      }
    });
    this._buildOpacityConfig();
    log.info('RendererCanvas created');
  }

  /** Total number of lanes in the allocator. */
  get laneCount(): number {
    return this.laneAllocator.getLaneCount();
  }

  /** Get current lane utilization ratio (0–1): occupied lanes / total lanes. */
  getLaneUtilization(): number {
    return this.laneAllocator.getUtilization();
  }

  /** Update standby status and ensure render loop is running for message display. */
  setStandbyStatus(standby: boolean): void {
    this.standbyStatus = standby;
    if (!standby) return;
    // Ensure render loop is running to draw the standby message.
    if (this.animFrameId === null) {
      this.startRenderLoop();
    }
  }

  protected getQueueLength(): number {
    return this.pendingQueue.size;
  }

  // ── Message ingress ──────────────────────────────────────────────────

  addMessage(message: ChatMessage): void {
    if (!this.isMessageAllowed(message)) return;
    // Route to worker when off-main-thread rendering is active
    if (this.workerManager.isActive) {
      this.workerManager.sendToWorker(message);
      // Also trigger translation asynchronously and send result to worker
      const translatableText = getTranslatableText(message);
      if (this.translationService.isEnabled && translatableText) {
        const msgId = message.id ?? `${message.timestamp}-${Math.random()}`;
        this.translationService
          .translate(translatableText)
          .then((translated) => {
            this.workerManager.sendTranslation(msgId, translated);
          })
          .catch(() => {
            // Silently ignore individual translation failures
          });
      }
      return;
    }
    this.enqueueMessage(message, true);
  }

  /**
   * Replay a previously received message without observability tracking.
   * Used by replayLatestMessages so replayed messages don't inflate
   * drop-rate denominators or trigger burst detection / rate limiting.
   */
  replayMessage(message: ChatMessage): void {
    if (this.isVideoPaused) return;
    this.enqueueMessage(message, false);
  }

  private enqueueMessage(message: ChatMessage, trackDrops: boolean): void {
    const priority = CanvasRenderer.getMessagePriority(message);
    this.imageFetchManager.prefetchImages(message);

    if (this.pendingQueue.size >= this.settings.queueMaxSize) {
      // Queue full — check if the new message has higher priority than
      // the lowest-priority message currently in the queue.
      const lowest = this.pendingQueue.peekLowest();
      // peekLowest returns the lowest-priority entry; but to determine
      // priority we call getMessagePriority on it (same cost as old code).
      // If the new message isn't more important, drop it.
      if (lowest && priority <= CanvasRenderer.getMessagePriority(lowest)) {
        if (trackDrops) this.observability.onMessageDropped('queue_priority');
        return;
      }
      // New message is more important — displace the lowest-priority entry.
      this.pendingQueue.dropLowest();
      if (trackDrops) this.observability.onMessageDropped('queue_replaced');
    }

    this.pendingQueue.enqueue(message, priority);
    this.updateBacklogPause();

    // Trigger an immediate render frame so the message appears within
    // one frame (~16ms) instead of waiting for the next natural rAF.
    // When the loop self-idled (animFrameId === null), restart it.
    // Skip if paused — the render loop would just return immediately.
    if (this.pendingQueue.size === 1 && !this.isPaused && !this.isVideoPaused) {
      if (this.animFrameId !== null) {
        this.animFrameId = clearSafeAnimationFrame(this.animFrameId);
      }
      this.startRenderLoop();
    }
  }

  trimBackgroundQueue(): void {
    if (this.pendingQueue.size <= this.settings.backgroundQueueMax) return;
    this.pendingQueue.trim(this.settings.backgroundQueueMax);
  }

  // ── Render loop ──────────────────────────────────────────────────────

  private applyDevicePixelRatio(dims?: OverlayDimensions | null): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx || !dims) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = dims.width * dpr;
    canvas.height = dims.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.lastDpr = dpr;
  }

  private startRenderLoop(): void {
    if (this.animFrameId !== null) return;
    // Reset grace period on restart — fresh cycle, no prior idle state.
    this.idleSince = null;
    const loop = (): void => {
      if (!this.canvas?.isConnected) {
        this.animFrameId = null;
        return;
      }
      this.renderFrame();
      // Stop the render loop when there is no work to do — no visible
      // messages, no queued messages, not in standby. This eliminates
      // wasted 60fps rAF cycles when the stream has no chat activity.
      // The loop is restarted by:
      //   - enqueueMessage (queue 0→1 transition, running or self-idled)
      //   - setStandbyStatus(true)
      //   - onResume (tab visibility or video unpause)
      //   - emoji/sticker load callbacks (via needsRerender flag)
      //
      // A 500ms idle grace period prevents start/stop thrashing during
      // sparse chat intervals — the loop continues briefly after the
      // idle condition is first met, so a message arriving within 500ms
      // reuses the same rAF cycle without restart overhead.
      if (this.activeMessages.length === 0 && this.pendingQueue.isEmpty && !this.standbyStatus) {
        const now = performance.now();
        if (this.idleSince === null) {
          this.idleSince = now;
        } else if (now - this.idleSince >= CanvasRenderer.IDLE_GRACE_PERIOD_MS) {
          this.animFrameId = null;
          this.idleSince = null;
          return;
        }
        // Continue the loop during the grace period.
      } else {
        this.idleSince = null; // reset — not idle anymore
      }
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  private stopRenderLoop(): void {
    this.animFrameId = clearSafeAnimationFrame(this.animFrameId);
  }

  private renderFrame(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    if (!canvas.isConnected) return;
    if (this.isPaused) return;
    if (this.isVideoPaused) return;
    const t0 = performance.now();

    // Reset emoji-load debounce flag — any pending rAF restart has landed
    this.needsRerender = false;

    // Reuse t0 for position/opacity — the sub-microsecond difference between
    // two performance.now() calls is invisible to any rendering calculation.
    const now = t0;
    const dims = this.overlay.getDimensions();
    if (!dims) return;

    // Apply up to MAX_TRANSLATIONS_PER_FRAME translation results that arrived
    // between frames. Incremental drain prevents single-frame spikes during
    // chat bursts when many translations resolve simultaneously.
    if (this.pendingTranslations.length > 0) {
      const batch = this.pendingTranslations.splice(0, this.translationBatchSize);
      for (const { msg, text } of batch) {
        msg.translatedText = text;
      }
    }

    // Reset device pixel ratio (canvas buffer size may need update on DPR change)
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this.lastDpr) {
      this.lastDpr = dpr;
      canvas.width = dims.width * dpr;
      canvas.height = dims.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    // Single-pass cleanup of expired messages + incremental lane map maintenance.
    // When messages are removed, truncate the active array and prune empty lane entries.
    const { newMessages, newLength, anyRemoved } = cleanupExpiredMessages(
      this.activeMessages,
      now,
      this.activeMessagesByLane,
      (msg) => this.messageActivator.releaseMessage(msg)
    );
    if (anyRemoved) {
      if (newMessages) {
        // Replace the array reference entirely (avoids keeping garbage-filled tail slots)
        this.activeMessages.length = 0;
        this.activeMessages.push(...newMessages);
      } else {
        this.activeMessages.length = newLength;
      }
      // Remove lanes that now have 0 messages — stale empty entries waste
      // iteration time in lane-scoped lookups.
      for (const [lane, msgs] of this.activeMessagesByLane) {
        if (msgs.length === 0) {
          this.activeMessagesByLane.delete(lane);
        }
      }
      this.observability.updateActiveMessages(this.activeMessages.length);
      this.observability.updateQueueDepth(this.pendingQueue.size);
    }

    // P2-3: Skip clearRect + render loop when no active messages or standby message.
    // Empty frames have nothing to draw, so we skip GPU work entirely.
    const hasContent = this.activeMessages.length > 0 || this.standbyStatus;
    if (hasContent) {
      ctx.clearRect(0, 0, dims.width, dims.height);
    }

    // Draw standby status message when in pre-live standby mode
    if (this.standbyStatus) {
      this.renderStandbyMessage(ctx, dims);
    }

    const mode = this.settings.danmakuMode;
    const isScrolling = mode === 'scroll' || mode === 'reverse';

    // Recalculate lane utilization BEFORE drainQueue so anti-block sees
    // accurate state. Previously resetBatch() was inside drainQueue() and
    // never called when anti-block was active, causing a deadlock:
    // activeMessages emptied → cachedUtilization stuck at 100% →
    // anti-block always true → drainQueue never runs → resetBatch never
    // called → cachedUtilization never updated → permanent stall.
    this.laneAllocator.resetBatch();

    this.drainQueue(now);

    this.observability.updateLaneUtilization(this.laneAllocator.getUtilization());
    this.observability.tick();

    // Early exit for empty frames — nothing to render.
    if (!hasContent) return;

    // ── Pre-scan: group active messages by opacity bucket (0.05 granularity) ──
    // Reuse pre-allocated buckets to avoid per-frame Map + object allocations.
    const buckets = this._opacityBuckets;
    for (const bucket of buckets) bucket.length = 0;

    for (let i = 0; i < this.activeMessages.length; i++) {
      const msg = this.activeMessages[i];
      if (!msg) continue;
      const positionElapsed = now - msg.startTime - msg.pausedDuration;

      // Skip messages still in stagger delay period (haven't visually started)
      if (positionElapsed < 0) continue;

      const progress = Math.min(1, Math.max(0, positionElapsed * msg.invDuration));

      if (mode === 'scroll') {
        const travelDistance = msg.startX + msg.width + this.settings.exitPaddingPx;
        msg.x = msg.startX - progress * travelDistance;
      } else if (mode === 'reverse') {
        // Reverse: message enters from left and scrolls right.
        // Compute travel from startX (left edge) to off-screen right edge,
        // accounting for horizontal stagger in the start position.
        const travelDistance = dims.width - msg.startX + this.settings.exitPaddingPx;
        msg.x = msg.startX + progress * travelDistance;
      }

      // Fade-in starts from fadeStartTime, independent of position timeline.
      // Currently set equal to startTime (visual appearance), but the separate
      // field allows future independent fade/position timing control.
      const fadeElapsed = now - msg.fadeStartTime - msg.pausedDuration;
      const opacity = computeMessageOpacity(
        msg.message,
        fadeElapsed,
        msg.duration,
        isScrolling,
        msg.speedTier,
        this._cachedOpacityConfig
      );

      const bucketIndex = Math.round(opacity * (_OPACITY_BUCKET_COUNT - 1));
      // Store positionElapsed for membership card border pulse animation
      buckets[bucketIndex]?.push({ msg, elapsed: positionElapsed });
    }

    // ── Render each opacity group with a single ctx.globalAlpha set ──
    // Iterate ascending (0→N-1) so low-opacity messages render behind,
    // high-opacity on top — consistent with pre-pooling Map insertion order.
    for (let bucketIndex = 0; bucketIndex < _OPACITY_BUCKET_COUNT; bucketIndex++) {
      const entries = buckets[bucketIndex];
      if (!entries || entries.length === 0) continue;
      const bucketOpacity = bucketIndex / (_OPACITY_BUCKET_COUNT - 1);
      ctx.globalAlpha = bucketOpacity;

      try {
        for (const { msg, elapsed } of entries) {
          const snappedX = Math.floor(msg.x);
          const snappedY = Math.floor(msg.y);

          // renderMessage is always set in activateMessage (avoids per-frame nullish coalescing)
          const renderMessage = msg.renderMessage;

          // Rich card types (SuperChat/Membership) always render their original
          // card structure — replace mode is not supported for structured cards.
          // Translation appears as dual-mode text below the card.
          const renderOriginal = true;
          if (msg.message.kind === 'text') {
            const isReplace = this.settings.translationMode === 'replace';
            renderRegularMessage(
              ctx,
              renderMessage,
              snappedX,
              snappedY,
              this.settings,
              this.textBitmapCache,
              this.imageFetchManager.emojiCache,
              this.imageFetchManager.authorPhotoCache,
              this._boundGetFont,
              isReplace ? msg.translatedText : undefined
            );
          } else {
            if (renderOriginal) {
              const cardConfig =
                msg.message.kind === 'superchat' ? SUPERCHAT_CARD_CONFIG : MEMBERSHIP_CARD_CONFIG;
              renderPaidCard(
                ctx,
                renderMessage,
                msg.width,
                msg.height,
                snappedX,
                snappedY,
                elapsed,
                cardConfig,
                this.settings,
                this.textBitmapCache,
                this.imageFetchManager.authorPhotoCache,
                this.imageFetchManager.stickerCache,
                this.imageFetchManager.emojiCache,
                this._boundGetFont,
                this.superChatGradientCache
              );
            }
          }

          // Render translation below original text (dual mode only).
          // Replace mode renders translation inside renderRegularMessage as override text.
          if (msg.translatedText && this.settings.translationMode !== 'replace') {
            const fontSize = Math.max(
              1,
              Math.round(this.settings.fontSize * CanvasRenderer.TRANSLATION_FONT_SCALE)
            );
            const transY = snappedY + msg.height + CanvasRenderer.TRANSLATION_GAP_PX;
            const transColor = this.settings.colors[msg.message.authorType];
            ctx.save();
            ctx.globalAlpha = bucketOpacity * CanvasRenderer.TRANSLATION_OPACITY_SCALE;
            // Bitmap-cached via renderSegment — same text across frames only rasterizes once.
            renderSegment(
              ctx,
              msg.translatedText,
              snappedX,
              transY,
              transColor,
              fontSize,
              this.settings.outline.widthPx,
              this.settings.outline.opacity,
              this.textBitmapCache,
              this._boundGetFont
            );
            ctx.restore();
          }
        }
      } finally {
        ctx.globalAlpha = 1;
      }
    }
    this.observability.recordRenderFrame(performance.now() - t0);
  }

  // ── Queue drain ──────────────────────────────────────────────────────

  private drainQueue(now: number): void {
    // Anti-block throttle: when lane utilization is critically high, pause
    // new placements to prevent visual chaos. High-priority messages
    // (SuperChat priority ≥100, Membership ≥80) bypass the gate so paid
    // interactions are never blocked by lane saturation.
    if (this.isAntiBlockActive()) {
      const front = this.pendingQueue.peek();
      if (
        !front ||
        CanvasRenderer.getMessagePriority(front) < CanvasRenderer.ANTI_BLOCK_PRIORITY_THRESHOLD
      )
        return;
    }
    const t0 = performance.now();
    // Cache dimensions once for the entire drain cycle — avoids repeated
    // overlay.getDimensions() calls in checkPlacement/enqueueMessageWithPlacement.
    const dims = this.overlay.getDimensions();
    if (!dims) return;

    let skipped = 0;
    const maxSkip = CanvasRenderer.DRAIN_QUEUE_MAX_SKIP;
    let batchIndex = 0; // for stagger delay computation
    while (
      !this.pendingQueue.isEmpty &&
      this.activeMessages.length < this.settings.maxConcurrentMessages &&
      skipped <= maxSkip
    ) {
      const msg = this.pendingQueue.dequeue();
      if (!msg) continue;

      const result = this.checkPlacement(msg, now, dims);
      if (!result.ok) {
        // no_lane: all lanes occupied. collision: bounding-box overlap at entry edge.
        // Both cases: retry next frame via retry queue — lanes typically free within <100ms.
        skipped++;
        this.retryQueue.push(msg);
        continue;
      }

      this.enqueueMessageWithPlacement(
        msg,
        now,
        result.placement,
        batchIndex,
        result.dimensions,
        result.speedTier,
        dims
      );
      skipped = 0; // reset after successful enqueue
      batchIndex++;
    }

    // Merge retry queue back into pending queue for next frame.
    // refill() re-inserts each message into its priority bucket (O(k) per message
    // where k = number of priority levels, typically 6). Previously this used
    // O(n) splice per message. retryQueue is typically ≤3 elements (limited by maxSkip).
    if (this.retryQueue.length > 0) {
      this.pendingQueue.refill(this.retryQueue, (msg) => CanvasRenderer.getMessagePriority(msg));
      this.retryQueue.length = 0;
    }
    this.observability.recordDrainQueue(performance.now() - t0);
  }

  /**
   * Check whether placing a new message at its target lane would cause
   * visual overlap with any currently active (visible) message.
   *
   * Returns pre-computed dimensions so callers can reuse them instead of
   * calling estimateDimensions again (avoids duplicate wrap calls for
   * 2-pass-wrapping messages like SuperChat).
   *
   * For scrolling modes, overlap occurs when a new message enters from the
   * right edge while an existing message in the same or adjacent lane has
   * not yet fully exited from the left edge. We use the actual bounding
   * boxes of active messages rather than the lane allocator's theoretical
   * available-time, which can be inaccurate after pause/resume.
   *
   * For top/bottom modes, overlap occurs when an active message in the same
   * lane has not yet expired.
   */
  private checkPlacement(
    message: ChatMessage,
    now: number,
    precomputedDims?: OverlayDimensions
  ):
    | {
        ok: true;
        placement: LanePlacement;
        dimensions: { width: number; height: number };
        speedTier: number;
      }
    | {
        ok: false;
        reason: DropReason;
      } {
    const t0 = performance.now();
    const dims = precomputedDims ?? this.overlay.getDimensions();
    if (!dims) {
      this.observability.recordCollisionCheck(performance.now() - t0);
      return { ok: false, reason: 'no_lane' };
    }

    const mode = this.settings.danmakuMode;
    const isScrolling = mode === 'scroll' || mode === 'reverse';
    const dimensions = this.estimateDimensions(message);
    const { height: msgHeight } = dimensions;

    // Find the target lane Y position via the allocator (without committing).
    const speedTier = this.getSpeedTier(message);
    const placement = this.laneAllocator.findPlacement(msgHeight, dims, speedTier);
    if (!placement) {
      this.observability.recordCollisionCheck(performance.now() - t0);
      return { ok: false, reason: 'no_lane' };
    }

    const newLaneY = placement.laneY + placement.verticalOffset;
    const laneHeight = this.laneAllocator.getLaneHeight();

    // Check active messages in the target lane and adjacent lanes (reverse/newest first).
    // Lane-scoped scan: instead of O(all activeMessages), only check messages within
    // vertical overlap range. For single-slot messages: laneIndex ± 1.
    // For multi-slot messages: laneIndex-1 through laneIndex+slotCount covers all covered lanes.
    const adjacentMessages: CanvasMessage[] = [];
    const scanEnd = placement.laneIndex + placement.slotCount;
    for (let li = placement.laneIndex - 1; li <= scanEnd; li++) {
      const laneMsgs = this.activeMessagesByLane.get(li);
      if (laneMsgs) {
        for (const m of laneMsgs) adjacentMessages.push(m);
      }
    }
    // Scan newest-first for early collision exit
    for (let i = adjacentMessages.length - 1; i >= 0; i--) {
      const active = adjacentMessages[i];
      if (!active) continue;
      const activeElapsed = now - active.startTime - active.pausedDuration;
      if (activeElapsed < 0) continue; // not yet started

      // Vertical overlap: check if the two messages occupy the same vertical space.
      const verticalGap = Math.abs(active.y - newLaneY);
      if (verticalGap >= laneHeight) continue; // different lanes, no overlap

      if (isScrolling) {
        // Horizontal overlap: the active message's right edge must have
        // moved past the screen's RIGHT edge (not left) before a new
        // message can enter. This allows multiple comments to share the
        // same lane simultaneously — the new one enters from the right
        // while the previous one is still visible on the left.
        //
        // The headway gap is speed-aware: when the new message is faster
        // (backlog entering real-time lane), headway scales up by the
        // speed multiplier so the slower message has more lead time,
        // preventing the faster chaser from visually crossing through.
        const headwayPx = this.computeHeadwayPx(active.width, active.speedTier, speedTier);
        const travelDistance = active.startX + active.width + this.settings.exitPaddingPx;
        const activeProgress = Math.min(1, activeElapsed * active.invDuration);
        const activeRightEdge = active.startX - activeProgress * travelDistance + active.width;

        // The new message starts at the right edge (or left for reverse).
        // Overlap if the active message's right edge is still past the
        // right edge minus headway gap.
        if (mode === 'scroll') {
          if (activeRightEdge > dims.width - headwayPx) {
            forEachSlot(placement.laneIndex, placement.slotCount, (slotIdx) => {
              this.laneAllocator.markCollision(slotIdx);
            });
            this.observability.recordCollisionCheck(performance.now() - t0);
            return { ok: false, reason: 'collision' };
          }
        } else {
          // reverse mode: messages enter from left, travel right.
          // Speed-aware headway: when a fast backlog message enters a lane
          // with a slow reverse message, headway scales up to prevent the
          // faster chaser from catching up and visually crossing through.
          const reverseTravel = dims.width - active.startX + this.settings.exitPaddingPx;
          const activeX = active.startX + activeProgress * reverseTravel;
          if (activeX + active.width > -headwayPx) {
            forEachSlot(placement.laneIndex, placement.slotCount, (slotIdx) => {
              this.laneAllocator.markCollision(slotIdx);
            });
            this.observability.recordCollisionCheck(performance.now() - t0);
            return { ok: false, reason: 'collision' };
          }
        }
      } else {
        // Top/bottom modes: overlap if the active message in the same lane
        // has not yet expired.
        if (activeElapsed < active.duration) {
          forEachSlot(placement.laneIndex, placement.slotCount, (slotIdx) => {
            this.laneAllocator.markCollision(slotIdx);
          });
          this.observability.recordCollisionCheck(performance.now() - t0);
          return { ok: false, reason: 'collision' };
        }
      }
    }

    return { ok: true, placement, dimensions, speedTier };
  }

  // ── Message enqueue ──────────────────────────────────────────────────

  /**
   * Enqueue a message using a pre-computed placement (from checkPlacement).
   * This avoids the double findPlacement call that caused BUG-1.
   *
   * Accepts optional pre-computed dimensions to avoid duplicate
   * estimateDimensions calls (e.g. when called from drainQueue after
   * checkPlacement already computed them).
   */
  private enqueueMessageWithPlacement(
    message: ChatMessage,
    now: number,
    placement: LanePlacement,
    batchIndex = 0,
    precomputedDimensions?: { width: number; height: number },
    precomputedSpeedTier?: number,
    precomputedDims?: OverlayDimensions
  ): void {
    const dims = precomputedDims ?? this.overlay.getDimensions();
    if (!dims) return;

    const mode = this.settings.danmakuMode;
    const { width: msgWidth, height: msgHeight } =
      precomputedDimensions ?? this.estimateDimensions(message);

    const isScrolling = mode === 'scroll' || mode === 'reverse';
    const speedTier = precomputedSpeedTier ?? this.getSpeedTier(message);

    // Horizontal stagger: progressively offset batch messages from the
    // entry edge so they don't all enter in a vertical column. Each
    // successive batch message starts further from the entry edge,
    // spreading them horizontally and breaking the vertical "wall" effect.
    const horizontalStagger =
      isScrolling && batchIndex > 0
        ? Math.min(
            CanvasRenderer.HORIZONTAL_STAGGER_MAX,
            batchIndex * CanvasRenderer.HORIZONTAL_STAGGER_PER_STEP
          )
        : 0;

    // startX: off-screen entry position for scrolling modes,
    // horizontal center for top/bottom fixed modes.
    //   scroll  → dims.width + horizontalStagger  (right edge + stagger)
    //   reverse → -(msgWidth + horizontalStagger)    (left edge − stagger)
    //   top/bottom → center of viewport
    const startX = isScrolling
      ? mode === 'scroll'
        ? dims.width + horizontalStagger
        : -(msgWidth + horizontalStagger)
      : Math.max(0, Math.floor((dims.width - msgWidth) / 2));

    let effectiveDuration: number;
    if (isScrolling) {
      const speed = this.getSpeedForTier(speedTier);
      // Total travel distance must account for horizontal stagger to maintain
      // constant velocity — a message starting further from the entry edge
      // travels farther at the same speed, so duration adjusts proportionally.
      const totalDistance =
        mode === 'scroll'
          ? startX + msgWidth + this.settings.exitPaddingPx
          : dims.width + msgWidth + this.settings.exitPaddingPx + horizontalStagger;
      effectiveDuration =
        speed > 0
          ? computeScrollDuration(
              totalDistance,
              speed,
              this.settings.scrollDurationMinMs,
              this.settings.scrollDurationMaxMs,
              this.settings.exitPaddingPx
            )
          : this.settings.scrollDurationMinMs;
    } else {
      effectiveDuration = this.settings.topBottomDurationMs;
    }

    // Moderator and owner messages stay on screen longer.
    if (message.authorType === 'moderator' || message.authorType === 'owner') {
      effectiveDuration *= this.settings.modOwnerDurationMultiplier;
    }

    const laneY = placement.laneY + placement.verticalOffset;

    // Stagger delay: spread batch entries across time to prevent vertical
    // clumping. Computed BEFORE commitPlacement so the allocator accounts
    // for the effective visual start time, not the raw 'now' timestamp.
    //
    // When the pending queue backs up, stagger is reduced to avoid
    // compounding the delay — deep queue → zero stagger (backlog mode).
    const maxStagger =
      this.pendingQueue.size > CanvasRenderer.STAGGER_QUEUE_HIGH
        ? 0
        : this.pendingQueue.size > CanvasRenderer.STAGGER_QUEUE_MED
          ? this.settings.staggerMediumDelayMs
          : this.settings.staggerMaxDelayMs;
    const staggerDelay =
      batchIndex > 0 && maxStagger > 0
        ? Math.round(
            Math.min(
              maxStagger,
              Math.min(batchIndex, CanvasRenderer.STAGGER_BATCH_MAX) *
                -CanvasRenderer.STAGGER_EXP_SCALE *
                Math.log(1 - Math.random())
            )
          )
        : 0;

    const effectiveStartTime = now + staggerDelay;
    this.laneAllocator.commitPlacement(
      placement,
      effectiveStartTime,
      effectiveDuration,
      isScrolling ? msgWidth : undefined,
      isScrolling ? dims.width : undefined,
      speedTier
    );

    this.messageActivator.activate(
      message,
      now,
      msgWidth,
      msgHeight,
      laneY,
      {
        onActivated: (cm) => {
          this.activeMessages.push(cm);
          let laneList = this.activeMessagesByLane.get(cm.laneIndex);
          if (!laneList) {
            laneList = [];
            this.activeMessagesByLane.set(cm.laneIndex, laneList);
          }
          laneList.push(cm);
        },
        onMessageRendered: () => this.observability.onMessageRendered(),
        onTranslationResult: (cm, text) => {
          this.pendingTranslations.push({ msg: cm, text });
        },
      },
      effectiveDuration,
      startX,
      placement.laneIndex,
      staggerDelay,
      speedTier
    );
  }

  // ── Dimension estimation (delegates to shared functions) ──────────────

  private estimateDimensions(message: ChatMessage): { width: number; height: number } {
    // Check message-level cache first — same message ID means same content/kind/author.
    // Invalidated on settings change (updateSettings, resetState).
    let cached: { width: number; height: number } | undefined;
    if (message.id) {
      cached = this.dimensionCache.get(message.id);
    }
    if (cached) {
      // Translation height adjustment must be re-applied (translation state can change)
      if (
        this.settings.translationEnabled &&
        this.translationService.isActive &&
        this.settings.translationMode === 'dual'
      ) {
        const transFontSize = Math.max(
          1,
          Math.round(this.settings.fontSize * CanvasRenderer.TRANSLATION_FONT_SCALE)
        );
        const transFont = getFontString(
          transFontSize,
          this.settings.fontWeight,
          this.settings.fontFamily
        );
        const transHeight =
          measureTextHeight(transFont, transFontSize) + CanvasRenderer.TRANSLATION_GAP_PX;
        return { width: cached.width, height: cached.height + transHeight };
      }
      return cached;
    }

    // SuperChat rendering uses showAuthor.superChat (canvas-card-renderers.ts:82),
    // not showAuthor[authorType]. Match the rendering's key so that estimation
    // and rendering agree on whether the author section is included.
    const showAuthor =
      message.kind === 'superchat'
        ? this.settings.showAuthor.superChat
        : this.settings.showAuthor[message.authorType];
    const dims = sharedEstimateDimensions(
      message,
      this.settings.fontSize,
      showAuthor,
      this.settings.fontWeight,
      this.settings.fontFamily,
      {
        superchat: this.settings.superChatMaxBodyLines,
        membership: this.settings.membershipMaxBodyLines,
      },
      this.settings.showSuperChatAmount
    );

    if (message.id) {
      // LRU eviction on overflow
      if (this.dimensionCache.size >= CanvasRenderer.DIMENSION_CACHE_MAX) {
        const oldestKey = this.dimensionCache.keys().next().value;
        if (oldestKey !== undefined) this.dimensionCache.delete(oldestKey);
      }
      this.dimensionCache.set(message.id, dims);
    }

    // In dual translation mode, add extra height for the translation line
    // below the original content (all message kinds).
    if (
      this.settings.translationEnabled &&
      this.translationService.isActive &&
      this.settings.translationMode === 'dual'
    ) {
      const transFontSize = Math.max(
        1,
        Math.round(this.settings.fontSize * CanvasRenderer.TRANSLATION_FONT_SCALE)
      );
      const transFont = getFontString(
        transFontSize,
        this.settings.fontWeight,
        this.settings.fontFamily
      );
      const transHeight =
        measureTextHeight(transFont, transFontSize) + CanvasRenderer.TRANSLATION_GAP_PX;
      return { width: dims.width, height: dims.height + transHeight };
    }

    return dims;
  }

  private getFont(fontSize: number): string {
    return getFontString(fontSize, this.settings.fontWeight, this.settings.fontFamily);
  }

  /** Rebuild cached opacity config from current settings. Called on constructor and updateSettings. */
  private _buildOpacityConfig(): void {
    this._cachedOpacityConfig = {
      baseOpacity: this.settings.opacity,
      fadeDurationMs: this.settings.fadeDurationMs,
      invFadeDuration: this.invFadeDuration,
      backlogOpacityMultiplier: this.settings.backlogOpacityMultiplier,
      depthLayersEnabled: this.settings.depthLayersEnabled,
      depthFarOpacityMul: this.settings.depthFarOpacityMul,
      ageFadeRate: this.ageFadeRate,
    };
  }

  /**
   * Compute the headway gap (px) between a new message and an active one
   * on the same lane, accounting for speed differences.
   *
   * When the new message is faster than the active one (higher speedTier),
   * the headway is scaled up by the backlog speed multiplier so the active
   * message has more lead time — preventing the faster chaser from catching
   * up and visually crossing through.
   *
   * Same-tier messages use the standard adaptive formula:
   *   headwayPx = clamp(msgWidth × 0.08, 16, 60)
   */
  private computeHeadwayPx(
    activeWidth: number,
    activeSpeedTier: number,
    newSpeedTier: number
  ): number {
    const base = LaneAllocator.computeBaseHeadwayPx(activeWidth, this.settings.headwayGapRatio);
    // Only adjust when the new message is faster (higher tier).
    if (newSpeedTier > activeSpeedTier) {
      return Math.round(base * this.settings.backlogSpeedMultiplier);
    }
    return base;
  }

  // ── Backlog pause ────────────────────────────────────────────────────

  private getEffectiveBacklogSpeed(): number {
    const speed = this.settings.speedPxPerSec * Math.max(1, this.settings.backlogSpeedMultiplier);
    return Math.max(1, speed);
  }

  /** Compute scroll speed for a given speed tier. */
  private getSpeedForTier(tier: number): number {
    const base = this.getEffectiveSpeedPxPerSec();
    switch (tier) {
      case SPEED_TIER.FAR:
        return Math.max(30, base * this.settings.depthFarSpeedMul);
      case SPEED_TIER.NEAR:
        return base * this.settings.depthNearSpeedMul;
      case SPEED_TIER.BACKLOG:
        return this.getEffectiveBacklogSpeed();
      default:
        return base;
    }
  }

  /**
   * Compute the speed tier for a message based on settings and message properties.
   * Speed tiers: 0=Far, 1=Mid, 2=Near, 3=Backlog.
   */
  private getSpeedTier(message: ChatMessage): number {
    if (message.isBacklog) return SPEED_TIER.BACKLOG;
    if (!this.settings.depthLayersEnabled) return SPEED_TIER.MID;
    const mode = this.settings.danmakuMode;
    if (mode !== 'scroll' && mode !== 'reverse') return SPEED_TIER.MID;
    // SuperChat/Membership → Near tier
    if (message.kind === 'superchat' || message.kind === 'membership') return SPEED_TIER.NEAR;
    // Regular messages: deterministic assignment via message id hash
    const hash = hashStringForTier(message.id ?? String(message.timestamp));
    return hash < CanvasRenderer.TIER_NEAR_THRESHOLD ? SPEED_TIER.NEAR : SPEED_TIER.FAR;
  }

  // hashStringForTier imported from @core/renderer-constants

  // desaturateColor imported from @core/renderer-constants

  // ── Opacity ──────────────────────────────────────────────────────────

  /**
   * Compute the final rendering opacity for a message by composing the
   * user-configured opacity with fade-in/out, backlog dimming, depth layer
   * dimming, and age-based fade-out. All effects are multiplicative.
   *
   * Order of application:
   *   1. settings.opacity (base, default 0.85)
   *   2. Fade-in: linear ramp over fadeDurationMs at start (top/bottom only)
   *   3. Fade-out: linear ramp over fadeDurationMs at end (all modes)
   *   4. Backlog dimming: backlogOpacityMultiplier if isBacklog
   *   5. Far depth dimming: depthFarOpacityMul for Far tier messages
   *   6. Age fade-out: linear ramp to 0 over maxMessageAgeMs (60s)
   */

  // ── Abstract hook implementations ────────────────────────────────────

  updateSettings(settings: OverlaySettings, options?: { resetState?: boolean }): void {
    const wasTranslationEnabled = this.settings.translationEnabled;
    super.updateSettings(settings, options);

    // When settings change, cached dimensions become stale
    // (font, size, weight, family, maxBodyLines all affect dimension calculation).
    this.dimensionCache.clear();
    // Text bitmap cache also depends on font/size/color settings — clear to
    // avoid stale pre-rendered canvases being reused with the wrong style.
    this.textBitmapCache.clear();
    // Pre-compute 1/fadeDurationMs to avoid per-frame divisions in opacity calc
    this.invFadeDuration = 1 / Math.max(1, settings.fadeDurationMs);

    // Sync settings to render worker when off-main-thread mode is active
    this.workerManager.syncSettings(settings);

    // When translation is disabled, clear translated text from all active
    // messages so they revert to showing only the original text on the next frame.
    if (wasTranslationEnabled && !settings.translationEnabled) {
      for (const msg of this.activeMessages) {
        msg.translatedText = null;
      }
    }

    // Re-attempt translator creation if it previously failed due to missing
    // user activation or model download. Fire-and-forget — configure() below
    // serializes behind configurePromise so they don't race.
    this.translationService.onUserActivation();
    this.translationService.configure({
      enabled: settings.translationEnabled,
      service: settings.translationService,
      source: settings.translationSource,
      target: settings.translationTarget,
    });

    this.messageActivator = new MessageActivator(this.translationService, {
      topBottomDurationMs: settings.topBottomDurationMs,
      depthLayersEnabled: settings.depthLayersEnabled,
    });
    this._buildOpacityConfig();
  }

  protected onPause(): void {
    this.stopRenderLoop();
  }

  protected onResume(): void {
    this.startRenderLoop();
    this.laneAllocator.resetBatch();
    this.drainQueue(performance.now());
  }

  protected applyPausedDuration(pausedMs: number): void {
    applyPausedDurationToMessages(this.activeMessages, pausedMs);
  }

  protected resetState(): void {
    this.activeMessages.length = 0;
    this.activeMessagesByLane.clear();
    this.pendingQueue.clear();
    this.backlogPaused = false;
    this.onBacklogPauseChange = null;
    clearTextMeasurementCaches();
    this.textBitmapCache.clear();
    this.dimensionCache.clear();
  }

  protected onDestroy(): void {
    this.stopRenderLoop();
    this.workerManager.destroy();
    this.imageFetchManager.destroy();
    this.overlayDimensionsUnsubscribe?.();
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.imageFetchManager.emojiCache.clear();
    this.imageFetchManager.emojiFetching.clear();
    this.imageFetchManager.emojiFetchingStarted.clear();
    this.imageFetchManager.authorPhotoCache.clear();
    this.imageFetchManager.stickerCache.clear();
    this.textBitmapCache.clear();
    this.superChatGradientCache.clear();
    this.dimensionCache.clear();
    this.activeMessagesByLane.clear();
    this.translationService.destroy();
    clearTextMeasurementCaches();
  }

  // ── Standby message rendering ─────────────────────────────────────────

  private renderStandbyMessage(
    ctx: CanvasRenderingContext2D,
    dims: { width: number; height: number }
  ): void {
    ctx.save();
    const message = 'Waiting for live stream\u2026';
    const { fontSize, paddingX, paddingY, bottomOffset, pillRadius, fillStyle, textFillStyle } =
      standbyMessageLayout;
    const font = getFontString(fontSize, 'normal', this.settings.fontFamily);
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const textWidth = ctx.measureText(message).width;
    const boxW = textWidth + paddingX * 2;
    const boxH = fontSize * 1.5 + paddingY * 2;
    const boxX = (dims.width - boxW) / 2;
    const boxY = dims.height - boxH - bottomOffset;

    // Semi-transparent background pill
    ctx.fillStyle = fillStyle;
    drawRoundRect(ctx, boxX, boxY, boxW, boxH, pillRadius);
    ctx.fill();

    // Text on top
    ctx.fillStyle = textFillStyle;
    ctx.fillText(message, dims.width / 2, boxY + boxH / 2);
    ctx.restore();
  }
}
