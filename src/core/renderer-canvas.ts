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

import type { ChatMessage, OverlayDimensions, OverlaySettings } from '@app-types';
import { renderMembershipCard, renderSuperChatCard } from '@core/canvas-card-renderers';
import { drawRoundRect, renderRegularMessage } from '@core/canvas-text-renderer';
import { computeScrollDuration, rendererLayout, standbyMessageLayout } from '@core/design-tokens';
import { clearSafeAnimationFrame, clearSafeInterval, forEachSlot } from '@core/dom';
import type { LanePlacement } from '@core/lane-allocator';
import { LaneAllocator } from '@core/lane-allocator';
import { createLogger } from '@core/logging';
import type { Overlay } from '@core/overlay';
import { RendererBase } from '@core/renderer-base';
import { estimateMessageDimensions as sharedEstimateDimensions } from '@core/renderer-shared';
import { clearTextMeasurementCaches, getFontString } from '@core/text-measure';

// ── CanvasMessage lifecycle (inlined from canvas-message-lifecycle.ts) ─────

interface CanvasMessage {
  message: ChatMessage;
  startTime: number;
  duration: number;
  width: number;
  height: number;
  startX: number;
  x: number;
  y: number;
  pausedDuration: number;
  laneIndex: number;
  /** Time stagger delay (ms) applied to this message's start. */
  staggerDelay: number;
}

interface CreateCanvasMessageParams {
  message: ChatMessage;
  now: number;
  msgWidth: number;
  msgHeight: number;
  laneY: number;
  duration?: number | undefined;
  startX?: number | undefined;
  laneIndex?: number | undefined;
  staggerDelay?: number | undefined;
}

function createCanvasMessage(params: CreateCanvasMessageParams): CanvasMessage {
  const { message, now, msgWidth, msgHeight, laneY, staggerDelay = 0 } = params;
  const duration = params.duration ?? rendererLayout.topBottomDurationMs;
  const startX = params.startX ?? 0;
  return {
    message,
    startTime: now + staggerDelay,
    duration,
    width: msgWidth,
    height: msgHeight,
    startX,
    x: startX,
    y: laneY,
    pausedDuration: 0,
    laneIndex: params.laneIndex ?? 0,
    staggerDelay,
  };
}

/** Remove expired messages in-place. Returns the new logical length. */
function cleanupExpiredMessages(messages: CanvasMessage[], now: number): number {
  const oldLength = messages.length;
  let writeIdx = 0;
  for (let i = 0; i < oldLength; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const elapsed = now - msg.startTime - msg.pausedDuration;
    if (elapsed < msg.duration) {
      messages[writeIdx] = msg;
      writeIdx++;
    }
  }
  return writeIdx;
}

/** Accumulate paused duration across all active messages. */
function applyPausedDurationToMessages(messages: CanvasMessage[], pausedMs: number): void {
  for (const msg of messages) {
    msg.pausedDuration += pausedMs;
  }
}

const log = createLogger('RendererCanvas');

export class CanvasRenderer extends RendererBase {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private animFrameId: number | null = null;
  private overlayDimensionsUnsubscribe: (() => void) | null = null;
  private emojiCleanupIntervalId: ReturnType<typeof setInterval> | null = null;

  private readonly activeMessages: CanvasMessage[] = [];
  private readonly pendingQueue: ChatMessage[] = [];
  private readonly retryQueue: ChatMessage[] = [];

  /** Image caches (bounded LRU). */
  private readonly emojiCache = new Map<string, HTMLImageElement>();
  private readonly emojiFetching = new Set<string>();
  private readonly emojiFetchingStarted = new Map<string, number>();
  private readonly authorPhotoCache = new Map<string, HTMLImageElement>();
  private readonly stickerCache = new Map<string, HTMLImageElement>();
  private readonly failedEmojiFetches = new Set<string>();

  /** Last devicePixelRatio seen — used to detect DPR changes. */
  private lastDpr = 0;
  /** Whether the session is in standby mode (pre-live, waiting for stream). */
  private standbyStatus = false;

  /**
   * Text bitmap cache: pre-rendered text with outline as offscreen canvas.
   * Key = `${font}|${text}|${color}|${strokeWidth}|${strokeColor}`.
   * On cache hit, drawImage() replaces fillText()+strokeText() in the hot path.
   * Bounded to 200 entries (LRU eviction) to prevent unbounded memory growth
   * in long-running streams.
   */
  private readonly textBitmapCache = new Map<string, HTMLCanvasElement>();

  /**
   * Horizontal stagger per batch index step (px).
   * Each successive message in a drainQueue batch starts this many pixels
   * further to the right, spreading them horizontally so they don't all
   * enter from the same right-edge position.
   */
  private static readonly HORIZONTAL_STAGGER_PER_STEP = 40;

  /**
   * Maximum horizontal stagger offset (px).
   * Prevents messages from starting too far off-screen, which would
   * increase scroll duration unnecessarily.
   */
  private static readonly HORIZONTAL_STAGGER_MAX = 200;

  /**
   * Max number of consecutive collision skips in the drain queue.
   * Prevents scanning the entire pending queue when all entries collide.
   */
  private static readonly DRAIN_QUEUE_MAX_SKIP = 3;

  /** Max concurrent emoji fetch operations. */
  private static readonly EMOJI_FETCH_MAX_CONCURRENT = 6;
  /** Max entries in the emoji image cache. */
  private static readonly EMOJI_CACHE_MAX = 200;
  /** Max entries in the author photo cache. */
  private static readonly AUTHOR_PHOTO_CACHE_MAX = 100;
  /** Max entries in the sticker image cache. */
  private static readonly STICKER_CACHE_MAX = 50;

  /** Stagger queue depth thresholds. */
  private static readonly STAGGER_QUEUE_HIGH = 50;
  private static readonly STAGGER_QUEUE_MED = 30;
  /** Stagger delay when queue is medium depth (ms). */
  private static readonly STAGGER_MED_MS = 80;
  /** Stagger delay when queue is shallow (ms). */
  private static readonly STAGGER_MAX_MS = 200;

  constructor(overlay: Overlay, settings: OverlaySettings) {
    super(overlay, settings);

    const container = overlay.getContainer();
    const canvas = document.createElement('canvas');
    canvas.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none';
    if (container) container.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    if (!this.ctx) {
      log.warn('Failed to get CanvasRenderingContext2D — renderer will be inactive');
    } else if (!canvas.isConnected) {
      log.warn('Canvas created but not connected to DOM — renderer will be inactive');
    }

    const dims = overlay.getDimensions();
    this.applyDevicePixelRatio(dims);

    this.overlayDimensionsUnsubscribe = overlay.onDimensionsChanged((d) => {
      if (d && this.canvas) {
        this.applyDevicePixelRatio(d);
        this.laneAllocator.reset(d);
      }
    });

    this.startRenderLoop();
    this.emojiCleanupIntervalId = setInterval(() => {
      this.cleanupStaleEmojiFetching();
    }, 5_000);
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
    return this.pendingQueue.length;
  }

  // ── Message ingress ──────────────────────────────────────────────────

  addMessage(message: ChatMessage): void {
    if (!this.isMessageAllowed(message)) return;
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
    this.prefetchImages(message);

    if (this.pendingQueue.length >= rendererLayout.queueMaxSize) {
      const last = this.pendingQueue[this.pendingQueue.length - 1];
      if (last && priority <= CanvasRenderer.getMessagePriority(last)) {
        if (trackDrops) this.observability.onMessageDropped('queue_priority');
        return;
      }
      this.pendingQueue.pop();
      if (trackDrops) this.observability.onMessageDropped('queue_replaced');
    }

    const insertIndex = this.findQueueInsertIndex(priority);
    if (insertIndex === this.pendingQueue.length) {
      this.pendingQueue.push(message);
    } else {
      this.pendingQueue.splice(insertIndex, 0, message);
    }

    this.updateBacklogPause();

    // Trigger an immediate render frame so the message appears within
    // one frame (~16ms) instead of waiting for the next natural rAF.
    if (this.pendingQueue.length === 1 && this.animFrameId !== null) {
      this.animFrameId = clearSafeAnimationFrame(this.animFrameId);
      this.startRenderLoop();
    }
  }

  /** Binary search for insertion point in the priority-sorted pending queue. */
  private findQueueInsertIndex(priority: number): number {
    const queue = this.pendingQueue;
    let lo = 0;
    let hi = queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midMsg = queue[mid];
      if (midMsg && CanvasRenderer.getMessagePriority(midMsg) >= priority) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  trimBackgroundQueue(): void {
    if (this.pendingQueue.length <= rendererLayout.backgroundQueueMax) return;
    this.pendingQueue.sort((a, b) => {
      const prioA = CanvasRenderer.getMessagePriority(a);
      const prioB = CanvasRenderer.getMessagePriority(b);
      return prioB - prioA || a.timestamp - b.timestamp;
    });
    this.pendingQueue.length = rendererLayout.backgroundQueueMax;
  }

  // ── Image pre-fetching

  /** Load an image and store it in the given cache on success. */
  private loadImage(url: string, cache: Map<string, HTMLImageElement>, maxEntries: number): void {
    if (cache.has(url)) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    img.onload = () => {
      while (cache.size >= maxEntries) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
      }
      cache.set(url, img);
    };
    img.onerror = () => {
      this.failedEmojiFetches.add(url);
      // Silently skip — don't retry broken URLs on every frame.
    };
  }

  private prefetchImages(message: ChatMessage): void {
    for (const seg of message.content) {
      if (seg.type !== 'emoji') continue;
      if (this.emojiFetching.has(seg.emoji.url)) continue;
      if (this.emojiCache.has(seg.emoji.url)) continue;
      if (this.failedEmojiFetches.has(seg.emoji.url)) continue;
      this.cleanupStaleEmojiFetching();
      if (this.emojiFetching.size >= CanvasRenderer.EMOJI_FETCH_MAX_CONCURRENT) continue;
      this.emojiFetching.add(seg.emoji.url);
      this.emojiFetchingStarted.set(seg.emoji.url, performance.now());
      const url = seg.emoji.url;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = url;
      img.onload = () => {
        this.emojiFetching.delete(url);
        this.emojiFetchingStarted.delete(url);
        // Direct cache write instead of delegating to loadImage() —
        // the old path created a second Image for the same URL,
        // doubling the load latency before the emoji appeared.
        while (this.emojiCache.size >= CanvasRenderer.EMOJI_CACHE_MAX) {
          const key = this.emojiCache.keys().next().value;
          if (key !== undefined) this.emojiCache.delete(key);
        }
        this.emojiCache.set(url, img);

        // Trigger an immediate render frame so the emoji appears within
        // ~1 frame instead of waiting for the next natural rAF tick.
        if (this.animFrameId !== null) {
          this.animFrameId = clearSafeAnimationFrame(this.animFrameId);
          this.startRenderLoop();
        }
      };
      img.onerror = () => {
        this.emojiFetching.delete(url);
        this.emojiFetchingStarted.delete(url);
        this.failedEmojiFetches.add(url);
      };
    }

    if (message.authorPhotoUrl) {
      this.loadImage(
        message.authorPhotoUrl,
        this.authorPhotoCache,
        CanvasRenderer.AUTHOR_PHOTO_CACHE_MAX
      );
    }

    const stickerUrl = message.superChat?.sticker?.url;
    if (stickerUrl) {
      this.loadImage(stickerUrl, this.stickerCache, CanvasRenderer.STICKER_CACHE_MAX);
    }
  }

  /**
   * Remove stale entries from emojiFetching that never resolved.
   * If an image fetch hasn't completed within 30 seconds, the fetch
   * likely failed silently (e.g. CORS block), so evict it to unblock
   * future retries.
   */
  private static readonly EMOJI_FETCH_TIMEOUT_MS = 30_000;

  private cleanupStaleEmojiFetching(): void {
    const now = performance.now();
    for (const [url, startedAt] of this.emojiFetchingStarted) {
      if (now - startedAt > CanvasRenderer.EMOJI_FETCH_TIMEOUT_MS) {
        this.emojiFetching.delete(url);
        this.emojiFetchingStarted.delete(url);
      }
    }

    // Clear stale failure entries periodically to allow retry after transient errors
    if (this.failedEmojiFetches.size > 0) {
      this.failedEmojiFetches.clear();
    }
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
    const loop = (): void => {
      if (!this.canvas?.isConnected) {
        this.animFrameId = null;
        return;
      }
      this.renderFrame();
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
    if (this.isPaused) return;
    if (this.isVideoPaused) return;

    const now = performance.now();
    const dims = this.overlay.getDimensions();
    if (!dims) return;

    // Reset device pixel ratio (canvas buffer size may need update on DPR change)
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this.lastDpr) {
      this.lastDpr = dpr;
      canvas.width = dims.width * dpr;
      canvas.height = dims.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ctx.clearRect(0, 0, dims.width, dims.height);

    // Draw standby status message when in pre-live standby mode
    if (this.standbyStatus) {
      this.renderStandbyMessage(ctx, dims);
    }

    const mode = this.settings.danmakuMode;
    const isScrolling = mode === 'scroll' || mode === 'reverse';

    // O(n) single-pass cleanup of expired messages
    const newLength = cleanupExpiredMessages(this.activeMessages, now);
    if (newLength < this.activeMessages.length) {
      this.activeMessages.length = newLength;
      this.observability.updateActiveMessages(this.activeMessages.length);
      this.observability.updateQueueDepth(this.pendingQueue.length);
    }

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

    for (let i = 0; i < this.activeMessages.length; i++) {
      const msg = this.activeMessages[i];
      if (!msg) continue;
      const elapsed = now - msg.startTime - msg.pausedDuration;

      // Skip messages still in stagger delay period (haven't visually started)
      if (elapsed < 0) continue;

      const progress = Math.min(1, Math.max(0, elapsed / msg.duration));

      if (mode === 'scroll') {
        const travelDistance = msg.startX + msg.width + rendererLayout.exitPaddingMin;
        msg.x = msg.startX - progress * travelDistance;
      } else if (mode === 'reverse') {
        // Reverse: message enters from left and scrolls right.
        // Compute travel from startX (left edge) to off-screen right edge,
        // accounting for horizontal stagger in the start position.
        const travelDistance = dims.width - msg.startX + rendererLayout.exitPaddingMin;
        msg.x = msg.startX + progress * travelDistance;
      }

      const opacity = this.computeMessageOpacity(msg.message, elapsed, msg.duration, isScrolling);

      const snappedX = Math.floor(msg.x);
      const snappedY = Math.floor(msg.y);

      if (msg.message.kind === 'superchat') {
        renderSuperChatCard(
          ctx,
          msg.message,
          msg.width,
          msg.height,
          snappedX,
          snappedY,
          opacity,
          this.settings,
          this.textBitmapCache,
          this.authorPhotoCache,
          this.stickerCache,
          (fs) => this.getFont(fs)
        );
      } else if (msg.message.kind === 'membership') {
        renderMembershipCard(
          ctx,
          msg.message,
          msg.width,
          msg.height,
          snappedX,
          snappedY,
          opacity,
          elapsed,
          this.settings,
          this.textBitmapCache,
          this.authorPhotoCache,
          (fs) => this.getFont(fs)
        );
      } else {
        renderRegularMessage(
          ctx,
          msg.message,
          snappedX,
          snappedY,
          opacity,
          this.settings,
          this.textBitmapCache,
          this.emojiCache,
          this.authorPhotoCache,
          (fs) => this.getFont(fs)
        );
      }
    }
  }

  // ── Queue drain ──────────────────────────────────────────────────────

  private drainQueue(now: number): void {
    // Anti-block throttle: when lane utilization is critically high, pause
    // new placements to prevent visual chaos. High-priority messages
    // (SuperChat priority ≥100, Membership ≥80) bypass the gate so paid
    // interactions are never blocked by lane saturation.
    if (this.isAntiBlockActive()) {
      const front = this.pendingQueue[0];
      if (!front || CanvasRenderer.getMessagePriority(front) < 80) return;
    }
    let skipped = 0;
    const maxSkip = CanvasRenderer.DRAIN_QUEUE_MAX_SKIP;
    let batchIndex = 0; // for stagger delay computation
    while (
      this.pendingQueue.length > 0 &&
      this.activeMessages.length < this.settings.maxConcurrentMessages &&
      skipped <= maxSkip
    ) {
      const msg = this.pendingQueue.shift();
      if (!msg) continue;

      const result = this.checkPlacement(msg, now);
      if (!result.ok) {
        if (result.reason === 'no_lane') {
          // No lane available from the allocator — all lanes are occupied.
          // Push back to retry queue so the message gets retried next frame
          // when existing messages may have expired. Previously this was a
          // hard drop, which meant the highest-priority message (front of
          // priority-sorted queue) was discarded first during bursts.
          // The skip counter limits deferrals per frame to prevent infinite
          // retry loops when lanes are truly saturated for extended periods.
          skipped++;
          this.retryQueue.push(msg);
          continue;
        }
        // Collision: the allocator found a lane but the bounding-box check
        // against active (visible) messages detected overlap near the entry
        // edge. Keep the message in a separate retry queue and retry next
        // frame — the collision window is often <100ms as the existing
        // message scrolls left. Previously this was a hard drop, causing
        // 80%+ loss during high-density bursts despite available lanes
        // (queue=0, lanes=75%). Pushing to a separate queue avoids O(n²)
        // push-back into the main pending queue.
        skipped++;
        this.retryQueue.push(msg);
        continue;
      }

      this.enqueueMessageWithPlacement(msg, now, result.placement, batchIndex);
      skipped = 0; // reset after successful enqueue
      batchIndex++;
    }

    // Merge retry queue back into pending queue for next frame.
    // Re-insert via priority-sorted splice instead of blind push to preserve
    // ordering: a collided superchat retry shouldn't sit behind newly-arrived
    // text messages. Each insert is O(n) splice, but retryQueue is typically
    // ≤3 elements (limited by maxSkip).
    if (this.retryQueue.length > 0) {
      for (const msg of this.retryQueue) {
        const idx = this.findQueueInsertIndex(CanvasRenderer.getMessagePriority(msg));
        this.pendingQueue.splice(idx, 0, msg);
      }
      this.retryQueue.length = 0;
    }
  }

  /**
   * Check whether placing a new message at its target lane would cause
   * visual overlap with any currently active (visible) message.
   *
   * Unlike the old wouldOverlap, this returns the LanePlacement on success
   * so the caller can reuse it without calling findPlacement a second time.
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
    now: number
  ):
    | { ok: true; placement: LanePlacement }
    | {
        ok: false;
        reason: 'collision' | 'no_lane';
      } {
    const dims = this.overlay.getDimensions();
    if (!dims) return { ok: false, reason: 'no_lane' as const };

    const mode = this.settings.danmakuMode;
    const isScrolling = mode === 'scroll' || mode === 'reverse';
    const { height: msgHeight } = this.estimateDimensions(message);

    // Find the target lane Y position via the allocator (without committing).
    const placement = this.laneAllocator.findPlacement(msgHeight, dims, message.isBacklog ?? false);
    if (!placement) return { ok: false, reason: 'no_lane' as const };

    const newLaneY = placement.laneY + placement.verticalOffset;
    const laneHeight = this.laneAllocator.getLaneHeight();

    // Check active messages in reverse (newest first) for early exit on collision.
    for (let i = this.activeMessages.length - 1; i >= 0; i--) {
      const active = this.activeMessages[i];
      if (!active) continue;
      const activeElapsed = now - active.startTime - active.pausedDuration;
      if (activeElapsed < 0) continue; // not yet started

      // Vertical overlap: check if the two messages occupy the same vertical space.
      // Use lane-height granularity to account for padding/spacing.
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
        const headwayPx = this.computeHeadwayPx(
          active.width,
          active.message.isBacklog ?? false,
          message.isBacklog ?? false
        );
        const travelDistance = active.startX + active.width + rendererLayout.exitPaddingMin;
        const activeProgress = Math.min(1, activeElapsed / active.duration);
        const activeRightEdge = active.startX - activeProgress * travelDistance + active.width;

        // The new message starts at the right edge (or left for reverse).
        // Overlap if the active message's right edge is still past the
        // right edge minus headway gap.
        if (mode === 'scroll') {
          if (activeRightEdge > dims.width - headwayPx) {
            forEachSlot(placement.laneIndex, placement.slotCount, (slotIdx) => {
              this.laneAllocator.markCollision(slotIdx);
            });
            return { ok: false, reason: 'collision' as const };
          }
        } else {
          // reverse mode: messages enter from left, travel right.
          // Speed-aware headway: when a fast backlog message enters a lane
          // with a slow reverse message, headway scales up to prevent the
          // faster chaser from catching up and visually crossing through.
          const reverseTravel = dims.width - active.startX + rendererLayout.exitPaddingMin;
          const activeX = active.startX + activeProgress * reverseTravel;
          if (activeX + active.width > -headwayPx) {
            forEachSlot(placement.laneIndex, placement.slotCount, (slotIdx) => {
              this.laneAllocator.markCollision(slotIdx);
            });
            return { ok: false, reason: 'collision' as const };
          }
        }
      } else {
        // Top/bottom modes: overlap if the active message in the same lane
        // has not yet expired.
        if (activeElapsed < active.duration) {
          forEachSlot(placement.laneIndex, placement.slotCount, (slotIdx) => {
            this.laneAllocator.markCollision(slotIdx);
          });
          return { ok: false, reason: 'collision' as const };
        }
      }
    }

    return { ok: true, placement };
  }

  // ── Message enqueue ──────────────────────────────────────────────────

  /**
   * Enqueue a message using a pre-computed placement (from checkPlacement).
   * This avoids the double findPlacement call that caused BUG-1.
   */
  private enqueueMessageWithPlacement(
    message: ChatMessage,
    now: number,
    placement: LanePlacement,
    batchIndex = 0
  ): void {
    const dims = this.overlay.getDimensions();
    if (!dims) return;

    const mode = this.settings.danmakuMode;
    const { width: msgWidth, height: msgHeight } = this.estimateDimensions(message);

    const isScrolling = mode === 'scroll' || mode === 'reverse';

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
      const speed = message.isBacklog
        ? this.getEffectiveBacklogSpeed()
        : this.getEffectiveSpeedPxPerSec();
      // Total travel distance must account for horizontal stagger to maintain
      // constant velocity — a message starting further from the entry edge
      // travels farther at the same speed, so duration adjusts proportionally.
      const totalDistance =
        mode === 'scroll'
          ? startX + msgWidth + rendererLayout.exitPaddingMin
          : dims.width + msgWidth + rendererLayout.exitPaddingMin + horizontalStagger;
      effectiveDuration =
        speed > 0 ? computeScrollDuration(totalDistance, speed) : rendererLayout.durationMin;
    } else {
      effectiveDuration = rendererLayout.topBottomDurationMs;
    }

    const laneY = placement.laneY + placement.verticalOffset;

    // Stagger delay: spread batch entries across time to prevent vertical
    // clumping. Computed BEFORE commitPlacement so the allocator accounts
    // for the effective visual start time, not the raw 'now' timestamp.
    //
    // When the pending queue backs up, stagger is reduced to avoid
    // compounding the delay — deep queue → zero stagger (backlog mode).
    const maxStagger =
      this.pendingQueue.length > CanvasRenderer.STAGGER_QUEUE_HIGH
        ? 0
        : this.pendingQueue.length > CanvasRenderer.STAGGER_QUEUE_MED
          ? CanvasRenderer.STAGGER_MED_MS
          : CanvasRenderer.STAGGER_MAX_MS;
    const staggerDelay =
      batchIndex > 0 && maxStagger > 0
        ? Math.round(
            Math.min(maxStagger, Math.min(batchIndex, 3) * -25 * Math.log(1 - Math.random()))
          )
        : 0;

    const effectiveStartTime = now + staggerDelay;
    this.laneAllocator.commitPlacement(
      placement,
      effectiveStartTime,
      effectiveDuration,
      isScrolling ? msgWidth : undefined,
      isScrolling ? dims.width : undefined,
      message.isBacklog
    );

    this.activateMessage(
      message,
      now,
      msgWidth,
      msgHeight,
      laneY,
      effectiveDuration,
      startX,
      placement.laneIndex,
      staggerDelay
    );
  }

  /** Finalize and activate a message. */
  private activateMessage(
    message: ChatMessage,
    now: number,
    msgWidth: number,
    msgHeight: number,
    laneY: number,
    duration?: number,
    startX?: number,
    laneIndex?: number,
    staggerDelay = 0
  ): void {
    const cm = createCanvasMessage({
      message,
      now,
      msgWidth,
      msgHeight,
      laneY,
      duration,
      startX,
      laneIndex,
      staggerDelay,
    });

    this.activeMessages.push(cm);
    this.observability.onMessageRendered();
  }

  // ── Dimension estimation (delegates to shared functions) ──────────────

  private estimateDimensions(message: ChatMessage): { width: number; height: number } {
    // SuperChat rendering uses showAuthor.superChat (canvas-card-renderers.ts:82),
    // not showAuthor[authorType]. Match the rendering's key so that estimation
    // and rendering agree on whether the author section is included.
    const showAuthor =
      message.kind === 'superchat'
        ? this.settings.showAuthor.superChat
        : this.settings.showAuthor[message.authorType];
    return sharedEstimateDimensions(
      message,
      this.settings.fontSize,
      showAuthor,
      this.settings.fontWeight,
      this.settings.fontFamily,
      {
        superchat: this.settings.superChatMaxBodyLines,
        membership: this.settings.membershipMaxBodyLines,
      }
    );
  }

  private getFont(fontSize: number): string {
    return getFontString(fontSize, this.settings.fontWeight, this.settings.fontFamily);
  }

  /**
   * Compute the headway gap (px) between a new message and an active one
   * on the same lane, accounting for speed differences.
   *
   * When the new message is faster than the active one (backlog entering
   * real-time lane), the headway is scaled up by the speed multiplier so
   * the active message has more lead time — preventing the faster chaser
   * from catching up and visually crossing through.
   *
   * Same-speed messages use the standard adaptive formula:
   *   headwayPx = clamp(msgWidth × 0.08, 16, 60)
   */
  private computeHeadwayPx(
    activeWidth: number,
    activeIsBacklog: boolean,
    newIsBacklog: boolean
  ): number {
    const base = Math.max(
      LaneAllocator.HEADWAY_GAP_MIN_PX,
      Math.min(
        LaneAllocator.HEADWAY_GAP_MAX_PX,
        Math.round(activeWidth * rendererLayout.headwayGapRatio)
      )
    );
    // Only adjust when speeds differ and the new message is faster.
    if (!activeIsBacklog && newIsBacklog) {
      return Math.round(base * this.settings.backlogSpeedMultiplier);
    }
    return base;
  }

  // ── Backlog pause ────────────────────────────────────────────────────

  private getEffectiveBacklogSpeed(): number {
    const speed = this.settings.speedPxPerSec * Math.max(1, this.settings.backlogSpeedMultiplier);
    return Math.max(1, speed);
  }

  // ── Opacity ──────────────────────────────────────────────────────────

  /**
   * Compute the final rendering opacity for a message by composing the
   * user-configured opacity with fade-in/out, backlog dimming, and age-based
   * fade-out. All effects are multiplicative, forming a single SSOT path.
   *
   * Order of application:
   *   1. settings.opacity (base, default 0.85)
   *   2. Fade-in: linear ramp over fadeDurationMs at start of life
   *   3. Fade-out: linear ramp over fadeDurationMs at end (top/bottom only)
   *   4. Backlog dimming: backlogOpacityMultiplier setting (default 0.75) if isBacklog
   *   5. Age fade-out: linear ramp to 0 over maxMessageAgeMs (60s)
   */
  private computeMessageOpacity(
    message: ChatMessage,
    elapsed: number,
    duration: number,
    isScrolling: boolean
  ): number {
    let opacity = this.settings.opacity;

    const fadeDuration = this.settings.fadeDurationMs;
    if (fadeDuration > 0) {
      // Fade-in: ramp from 0 to 1 over fadeDuration at message start
      if (elapsed < fadeDuration) {
        opacity *= elapsed / fadeDuration;
      }
      // Fade-out: ramp from 1 to 0 over fadeDuration at message end
      // Skip for scrolling messages — they exit the screen naturally.
      if (!isScrolling && elapsed > duration - fadeDuration) {
        opacity *= Math.max(0, (duration - elapsed) / fadeDuration);
      }
    }

    // Backlog dimming: uses backlogOpacityMultiplier setting (default 0.75)
    if (message.isBacklog) opacity *= this.settings.backlogOpacityMultiplier;

    // Age fade-out: gradually fade after maxMessageAgeMs (default 60s)
    const ageRatio = Math.min(1, elapsed / rendererLayout.maxMessageAgeMs);
    opacity *= Math.max(0, 1 - ageRatio);

    return opacity;
  }

  // ── Abstract hook implementations ────────────────────────────────────

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
    this.pendingQueue.length = 0;
    this.backlogPaused = false;
    clearTextMeasurementCaches();
    this.textBitmapCache.clear();
  }

  protected onDestroy(): void {
    this.stopRenderLoop();
    this.emojiCleanupIntervalId = clearSafeInterval(this.emojiCleanupIntervalId);
    this.overlayDimensionsUnsubscribe?.();
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.emojiCache.clear();
    this.emojiFetching.clear();
    this.emojiFetchingStarted.clear();
    this.authorPhotoCache.clear();
    this.stickerCache.clear();
    this.textBitmapCache.clear();
    clearTextMeasurementCaches();
  }

  // ── Standby message rendering ─────────────────────────────────────────

  private renderStandbyMessage(
    ctx: CanvasRenderingContext2D,
    dims: { width: number; height: number }
  ): void {
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
  }
}
