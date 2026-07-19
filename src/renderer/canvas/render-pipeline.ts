// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Rendering pipeline stages extracted from CanvasRenderer.
 *
 * Contains the draw, cleanup, and drain pipeline methods as standalone
 * functions that receive a `CanvasRenderContext` instead of relying on
 * `this.*` coupling. `renderFrame()` in canvas-renderer.ts remains the
 * single orchestrator that calls these in sequence.
 */

import type { OverlayDimensions, OverlaySettings } from '@app-types';
import { renderPaidCard } from '@renderer/canvas/card-renderers';
import { computePulseAlpha } from '@renderer/canvas/lut-helpers';
import { COMPACTION_THRESHOLD_RATIO } from '@renderer/canvas/pipeline-utils';
import { getDisplayText, renderRegularMessage, renderSegment } from '@renderer/canvas/shared';
import { MEMBERSHIP_CARD_CONFIG, SUPERCHAT_CARD_CONFIG } from '@renderer/card-config';
import {
  ANTI_BLOCK_MAX_DURATION_MS,
  ANTI_BLOCK_PRIORITY_THRESHOLD,
  type CanvasMessage,
  OPACITY_BUCKET_COUNT,
  SPEED_TIER,
  TRANSLATION_FONT_SCALE,
  TRANSLATION_GAP_PX,
  TRANSLATION_OPACITY_SCALE,
} from '@renderer/constants';
import type { LaneAllocator } from '@renderer/layout/lane-allocator';
import { computeMessageOpacity } from '@renderer/shared';
import { getFontString } from '@renderer/text-measure';
import type { ByteLimitedCache } from '@util/byte-limited-cache';
import { rendererLayout } from '@util/design-tokens';
import type { LruMap } from '@util/lru-map';
import type { MessageActivator } from '@util/message-activator';
import type { ObservabilityReporter } from '@util/observability';
import type { PriorityBucketQueue } from '@util/priority-bucket-queue';

// ── Context interface ───────────────────────────────────────────────────

/**
 * Shared state needed by the rendering pipeline stages.
 *
 * Provides mutable references to the core data structures (activeMessages,
 * activeMessagesByLane, opacity buckets) that are mutated by the pipeline
 * stages, along with settings, caches, bound helpers, and callbacks for
 * operations that remain in CanvasRenderer.
 */
export interface CanvasRenderContext {
  settings: OverlaySettings;

  textBitmapCache: ByteLimitedCache<HTMLCanvasElement>;
  superChatGradientCache: LruMap<string, CanvasGradient>;

  imageFetchManager: {
    emojiCache: ByteLimitedCache<HTMLImageElement>;
    authorPhotoCache: ByteLimitedCache<HTMLImageElement>;
    stickerCache: ByteLimitedCache<HTMLImageElement>;
  };

  boundGetFont: (fontSize: number) => string;
  boundMeasureTextWidth: (text: string) => number;

  /** Mutable reference — pipeline stages push/compact this array. */
  activeMessages: CanvasMessage[];
  /** Mutable reference — pipeline stages add/remove lane entries. */
  activeMessagesByLane: Map<number, CanvasMessage[]>;

  /** Pre-allocated opacity buckets (mutated per frame). */
  farOpacityBuckets: CanvasMessage[][];
  midOpacityBuckets: CanvasMessage[][];
  nearOpacityBuckets: CanvasMessage[][];

  /** Scratch array for expired messages collected during cleanup. */
  expiredMessagesScratch: CanvasMessage[];

  messageActivator: MessageActivator;

  cachedOpacityConfig: {
    baseOpacity: number;
    fadeDurationMs: number;
    invFadeDuration: number;
    backlogOpacityMultiplier: number;
    depthLayersEnabled: boolean;
    depthFarOpacityMul: number;
    ageFadeRate: number;
  };

  /** Anti-block state — mutable reference wrapper so pipeline writes propagate back. */
  antiBlockSince: { value: number | null };

  pendingQueue: PriorityBucketQueue;
  laneAllocator: LaneAllocator;

  observability: ObservabilityReporter;

  isReplayMode: boolean;
  isReducedMotionActive: boolean;

  /** Gate callback that stays in CanvasRenderer (uses its laneAllocator). */
  isAntiBlockActive: () => boolean;

  /**
   * DrainQueue callback that stays in CanvasRenderer (owns the queue
   * pumping logic, checkPlacement, enqueueMessageWithPlacement).
   */
  drainQueue: (now: number) => void;

  /** Last timestamp (performance.now) when the live region was updated. Mutable ref. */
  lastLiveRegionUpdate: { value: number };
  /** Callback to push snippets to the overlay's aria-live region. */
  updateLiveRegion: (snippets: string[]) => void;
}

// ── Constants hoisted from CanvasRenderer static fields ─────────────────

const LIVE_REGION_MAX_MESSAGES = 10;
const LIVE_REGION_THROTTLE_MS = 500;

// ── drainStage ──────────────────────────────────────────────────────────

/**
 * Anti-block gate + drainQueue.
 *
 * When lane utilization is critically high, new placements are paused.
 * If anti-block persists beyond ANTI_BLOCK_MAX_DURATION_MS, drainQueue
 * is force-called to prevent indefinite message suppression.
 */
export function drainStage(ctx: CanvasRenderContext, now: number, _dims: OverlayDimensions): void {
  // Anti-block throttle: check BEFORE resetBatch() to avoid paying the
  // lane-allocator batch-advance cost when anti-block suppresses all
  // new placements on this frame.
  if (!ctx.isReplayMode && ctx.isAntiBlockActive()) {
    const currentNow = performance.now();
    if (ctx.antiBlockSince.value === null) {
      ctx.antiBlockSince.value = currentNow;
    }

    const peeked = ctx.pendingQueue.peek();
    // Use shared constants from @renderer/constants

    const forceDrain =
      peeked !== undefined && currentNow - ctx.antiBlockSince.value >= ANTI_BLOCK_MAX_DURATION_MS;
    const highPriorityFront =
      peeked !== undefined && getMessagePriority(peeked) >= ANTI_BLOCK_PRIORITY_THRESHOLD;

    if (highPriorityFront || forceDrain) {
      if (forceDrain) {
        ctx.antiBlockSince.value = currentNow;
      }
      // Only call resetBatch() + drainQueue() when the anti-block gate
      // actually passes — saves lane-allocator overhead on suppressed frames.
      ctx.laneAllocator.resetBatch();
      ctx.drainQueue(now);
    }
  } else {
    ctx.antiBlockSince.value = null;
    ctx.laneAllocator.resetBatch();
    ctx.drainQueue(now);
  }
}

// ── cleanupAndBucketStage ───────────────────────────────────────────────

/**
 * Return type from cleanupAndBucketStage.
 */
export interface CleanupResult {
  farBuckets: CanvasMessage[][];
  midBuckets: CanvasMessage[][];
  nearBuckets: CanvasMessage[][];
  anyRemoved: boolean;
  writeIdx: number;
  oldLength: number;
}

/**
 * Single-pass cleanup + opacity bucket pre-scan.
 *
 * Removes expired messages and computes per-message opacity bucket
 * assignment. Returns buckets for the draw stage and compaction metadata.
 */
export function cleanupAndBucketStage(
  ctx: CanvasRenderContext,
  now: number,
  dims: OverlayDimensions,
  mode: string
): CleanupResult {
  const isScrolling = mode === 'scroll' || mode === 'reverse';
  const farBuckets = ctx.farOpacityBuckets;
  const midBuckets = ctx.midOpacityBuckets;
  const nearBuckets = ctx.nearOpacityBuckets;
  for (const bucket of farBuckets) bucket.length = 0;
  for (const bucket of midBuckets) bucket.length = 0;
  for (const bucket of nearBuckets) bucket.length = 0;
  ctx.expiredMessagesScratch.length = 0;

  const oldLength = ctx.activeMessages.length;
  let writeIdx = 0;
  let anyRemoved = false;

  for (let i = 0; i < oldLength; i++) {
    const msg = ctx.activeMessages[i];
    if (!msg) continue;
    const elapsed = now - msg.startTime - msg.pausedDuration;

    // Expired: message has exceeded its display duration
    if (elapsed >= msg.duration) {
      ctx.expiredMessagesScratch.push(msg);
      ctx.messageActivator.releaseMessage(msg);
      anyRemoved = true;
      continue;
    }

    // Keep message in active array (in-place compaction)
    ctx.activeMessages[writeIdx] = msg;
    writeIdx++;

    // Still in stagger delay — keep in array but skip rendering
    if (elapsed < 0) continue;

    // ── Render pre-compute ──
    // Save previous position for temporal frame blending (FAR-tier motion blur)
    if (msg.speedTier === SPEED_TIER.FAR) {
      msg._prevX = msg.x;
      msg._prevY = msg.y;
    }
    const progress = Math.min(1, Math.max(0, elapsed * msg.invDuration));

    if (mode === 'scroll') {
      if (!ctx.isReducedMotionActive) {
        const travelDistance = msg.startX + msg.width + ctx.settings.exitPaddingPx;
        msg.x = msg.startX - progress * travelDistance;
      } else {
        // Reduced motion: place message at a fixed visible position (no scrolling)
        msg.x = Math.max(0, (dims.width - msg.width) / 2);
      }
    } else if (mode === 'reverse') {
      if (!ctx.isReducedMotionActive) {
        const travelDistance = dims.width - msg.startX + ctx.settings.exitPaddingPx;
        msg.x = msg.startX + progress * travelDistance;
      } else {
        // Reduced motion: place message at a fixed visible position (no scrolling)
        msg.x = Math.max(0, (dims.width - msg.width) / 2);
      }
    }

    // Fade-in starts from fadeStartTime, independent of position timeline.
    const fadeElapsed = now - msg.fadeStartTime - msg.pausedDuration;
    const opacity = computeMessageOpacity(
      msg.message,
      fadeElapsed,
      msg.duration,
      isScrolling,
      msg.speedTier,
      ctx.cachedOpacityConfig
    );

    const bucketIndex = Math.min(
      OPACITY_BUCKET_COUNT - 1,
      Math.round(opacity * (OPACITY_BUCKET_COUNT - 1))
    );
    msg._frameElapsed = elapsed;
    // Route to the correct speed-tier bucket for z-order rendering
    if (msg.speedTier === SPEED_TIER.FAR) {
      farBuckets[bucketIndex]!.push(msg);
    } else if (msg.speedTier === SPEED_TIER.NEAR) {
      nearBuckets[bucketIndex]!.push(msg);
    } else {
      midBuckets[bucketIndex]!.push(msg);
    }
  }

  return { farBuckets, midBuckets, nearBuckets, anyRemoved, writeIdx, oldLength };
}

// ── compactRemovedMessages ──────────────────────────────────────────────

/**
 * Compact the activeMessages array and clean the per-lane map after
 * expired message removal.
 */
export function compactRemovedMessages(
  ctx: CanvasRenderContext,
  writeIdx: number,
  oldLength: number
): void {
  // Remove only expired messages from the lane map using O(1) swap-pop
  for (const msg of ctx.expiredMessagesScratch) {
    const slotCount = msg.slotCount ?? 1;
    const indices = msg.laneArrayIndices;
    for (let slot = 0; slot < slotCount; slot++) {
      const lane = msg.laneIndex + slot;
      const list = ctx.activeMessagesByLane.get(lane);
      if (!list || list.length === 0) continue;

      const idx = indices?.[slot] ?? list.indexOf(msg);
      if (idx < 0 || idx >= list.length) continue;

      const lastMsg = list[list.length - 1]!;
      if (lastMsg !== msg) {
        list[idx] = lastMsg;
        // Update the swapped message's laneArrayIndices entry for this lane
        if (lastMsg.laneArrayIndices) {
          for (let ss = 0; ss < (lastMsg.slotCount ?? 1); ss++) {
            if (lastMsg.laneIndex + ss === lane) {
              lastMsg.laneArrayIndices[ss] = idx;
              break;
            }
          }
        }
      }
      list.pop();
      if (list.length === 0) ctx.activeMessagesByLane.delete(lane);
    }
  }

  // Array compaction: when >50% slots expired, allocate fresh array
  if (writeIdx < oldLength * COMPACTION_THRESHOLD_RATIO) {
    const newMessages = ctx.activeMessages.slice(0, writeIdx);
    ctx.activeMessages.length = 0;
    Array.prototype.push.apply(ctx.activeMessages, newMessages);
  } else {
    ctx.activeMessages.length = writeIdx;
  }

  // Remove lanes that now have 0 messages
  for (const [lane, msgs] of ctx.activeMessagesByLane) {
    if (msgs.length === 0) {
      ctx.activeMessagesByLane.delete(lane);
    }
  }
  ctx.observability.updateActiveMessages(ctx.activeMessages.length);
  ctx.observability.updateQueueDepth(ctx.pendingQueue.size);
}

// ── drawStage ───────────────────────────────────────────────────────────

/**
 * Render active messages grouped by opacity bucket.
 *
 * Each bucket is rendered with a single ctx.globalAlpha set,
 * reducing GPU state changes by ~21× vs per-message alpha.
 */
export function drawStage(
  ctx: CanvasRenderContext,
  renderCtx: CanvasRenderingContext2D,
  buckets: CanvasMessage[][]
): void {
  for (let bucketIndex = 0; bucketIndex < OPACITY_BUCKET_COUNT; bucketIndex++) {
    const entries = buckets[bucketIndex];
    if (!entries || entries.length === 0) continue;
    const bucketOpacity = bucketIndex / (OPACITY_BUCKET_COUNT - 1);
    renderCtx.globalAlpha = bucketOpacity;

    try {
      for (const msg of entries) {
        const elapsed = msg._frameElapsed!;
        const snappedX = Math.floor(msg.x);
        const snappedY = Math.floor(msg.y);

        // Temporal frame blending: render ghost at previous position for FAR-tier
        if (
          ctx.settings.motionBlurEnabled &&
          msg.speedTier === SPEED_TIER.FAR &&
          msg._prevX !== undefined &&
          msg._prevY !== undefined
        ) {
          const ghostAlpha = renderCtx.globalAlpha * ctx.settings.motionBlurAlpha;
          if (ghostAlpha > 0.001) {
            renderCtx.save();
            renderCtx.globalAlpha = ghostAlpha;
            if (msg.renderMessage) {
              const ghostFont = ctx.boundGetFont(ctx.settings.fontSize);
              renderCtx.font = ghostFont;
              renderCtx.textBaseline = 'top';
              renderCtx.textRendering = 'optimizeSpeed';
              renderCtx.fontKerning = 'none';
              const ghostColor =
                msg.renderMessage.userColor && ctx.settings.preserveUserColor
                  ? msg.renderMessage.userColor
                  : (msg.renderMessage.authorType &&
                      ctx.settings.colors[msg.renderMessage.authorType]) ||
                    ctx.settings.colors.normal;
              renderCtx.fillStyle = ghostColor;
              const ghostText = getDisplayText(msg.renderMessage.content);
              if (ghostText) {
                renderCtx.fillText(
                  ghostText,
                  Math.floor(msg._prevX) + rendererLayout.paddingH,
                  Math.floor(msg._prevY)
                );
              }
            }
            renderCtx.restore();
          }
        }

        const renderMessage = msg.renderMessage;

        if (msg.message.kind === 'text') {
          const isReplace = ctx.settings.translationMode === 'replace';
          renderRegularMessage(
            renderCtx,
            renderMessage,
            snappedX,
            snappedY,
            {
              fontSize: ctx.settings.fontSize,
              fontWeight: ctx.settings.fontWeight,
              fontFamily: ctx.settings.fontFamily,
              outlineWidthPx: ctx.settings.outline.enabled ? ctx.settings.outline.widthPx : 0,
              outlineOpacity: ctx.settings.outline.enabled ? ctx.settings.outline.opacity : 0,
              showAuthor: ctx.settings.showAuthor[renderMessage.authorType],
              color:
                ctx.settings.preserveUserColor && renderMessage.userColor
                  ? renderMessage.userColor
                  : ctx.settings.colors[renderMessage.authorType],
            },
            ctx.textBitmapCache,
            (url: string) => ctx.imageFetchManager.emojiCache.get(url),
            isImageReady,
            ctx.imageFetchManager.authorPhotoCache,
            isImageReady,
            ctx.boundGetFont,
            ctx.boundMeasureTextWidth,
            isReplace ? msg.translatedText : undefined,
            msg.speedTier === SPEED_TIER.FAR ? '1px' : undefined
          );
        } else {
          const cardConfig =
            msg.message.kind === 'superchat' ? SUPERCHAT_CARD_CONFIG : MEMBERSHIP_CARD_CONFIG;
          renderPaidCard(
            renderCtx,
            renderMessage,
            msg.width,
            msg.height,
            snappedX,
            snappedY,
            elapsed,
            cardConfig,
            ctx.settings,
            ctx.textBitmapCache,
            ctx.imageFetchManager.authorPhotoCache,
            ctx.imageFetchManager.stickerCache,
            ctx.imageFetchManager.emojiCache,
            ctx.boundGetFont,
            ctx.superChatGradientCache
          );
        }

        // Render translation in dual mode
        if (msg.translatedText && ctx.settings.translationMode !== 'replace') {
          const fontSize = Math.max(1, Math.round(ctx.settings.fontSize * TRANSLATION_FONT_SCALE));
          const gap = TRANSLATION_GAP_PX;
          const transY = snappedY + msg.height - fontSize - gap;
          const transColor =
            ctx.settings.preserveUserColor && renderMessage.userColor
              ? renderMessage.userColor
              : (msg.message.authorType && ctx.settings.colors[msg.message.authorType]) ||
                ctx.settings.colors.normal;
          renderCtx.save();
          try {
            renderCtx.globalAlpha = bucketOpacity * TRANSLATION_OPACITY_SCALE;
            const transFont = getFontString(fontSize, 'normal', ctx.settings.fontFamily);
            renderSegment(
              renderCtx,
              msg.translatedText,
              snappedX,
              transY,
              transColor,
              fontSize,
              ctx.settings.outline.widthPx,
              ctx.settings.outline.opacity,
              ctx.textBitmapCache,
              (_fs: number) => transFont
            );
          } finally {
            renderCtx.restore();
          }
        }
      }
    } finally {
      renderCtx.globalAlpha = 1;
    }
  }
}

// ── drawGlowStage ───────────────────────────────────────────────────────

/**
 * Render pulsing-border glow effects for membership/superchat cards.
 *
 * Uses ctx.filter blur for GPU-accelerated Gaussian blur (all browsers).
 * Drawn BEFORE text passes so glow renders beneath the text layer.
 */
export function drawGlowStage(
  _ctx: CanvasRenderContext,
  renderCtx: CanvasRenderingContext2D,
  buckets: CanvasMessage[][]
): void {
  for (let bucketIndex = 0; bucketIndex < OPACITY_BUCKET_COUNT; bucketIndex++) {
    const entries = buckets[bucketIndex];
    if (!entries || entries.length === 0) continue;
    for (const msg of entries) {
      if (!msg.message || msg.message.kind === 'text') continue;
      const renderMessage = msg.renderMessage;
      if (!renderMessage) continue;

      const cardConfig =
        renderMessage.kind === 'superchat' ? SUPERCHAT_CARD_CONFIG : MEMBERSHIP_CARD_CONFIG;

      if (cardConfig.decoration !== 'pulsingBorder') continue;
      const pb = cardConfig.pulsingBorder;
      if (!pb) continue;

      const elapsed = msg._frameElapsed ?? 0;
      const pulse = computePulseAlpha(elapsed, pb.baseAlpha, pb.amplitude);
      if (pulse <= 0.01) continue;

      const alpha = Math.min(1, pulse * 0.3);
      renderCtx.save();
      renderCtx.globalAlpha = alpha;
      renderCtx.filter = 'blur(8px)';
      renderCtx.fillStyle = `rgb(${pb.borderRgb.r},${pb.borderRgb.g},${pb.borderRgb.b})`;
      renderCtx.fillRect(
        Math.floor(msg.x) - 4,
        Math.floor(msg.y) - 4,
        msg.width + 8,
        msg.height + 8
      );
      renderCtx.restore();
    }
  }
}

// ── mirrorVisibleMessages ───────────────────────────────────────────────

/**
 * Mirror snippets from visible canvas messages to an offscreen aria-live
 * region so screen readers, find-in-page, and translation tools can
 * discover canvas-rendered text content.
 *
 * Throttled to at most once per 500ms to avoid flooding the live region
 * with updates at 60fps.
 */
export function mirrorVisibleMessages(ctx: CanvasRenderContext): void {
  const now = performance.now();
  if (now - ctx.lastLiveRegionUpdate.value < LIVE_REGION_THROTTLE_MS) return;
  ctx.lastLiveRegionUpdate.value = now;
  const count = Math.min(ctx.activeMessages.length, LIVE_REGION_MAX_MESSAGES);
  if (count === 0) return;
  const snippets: string[] = [];
  const start = ctx.activeMessages.length - count;
  for (let i = start; i < ctx.activeMessages.length; i++) {
    const msg = ctx.activeMessages[i];
    if (!msg) continue;
    const text = msg.message.text;
    if (text) snippets.push(text.slice(0, 80));
  }
  if (snippets.length > 0) {
    ctx.updateLiveRegion(snippets);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Check if an image element is fully loaded and has valid dimensions. */
function isImageReady(img: unknown): boolean {
  return (img as HTMLImageElement)?.complete === true && (img as HTMLImageElement).naturalWidth > 0;
}

/**
 * Get message priority for anti-block gate checks.
 * Mirrors RendererBase.getMessagePriority to avoid circular dependency.
 */
function getMessagePriority(message: { kind: string; isBacklog?: boolean }): number {
  const kindPriority: Record<string, number> = {
    superchat: 100,
    membership: 90,
    text: 0,
  };
  let priority = kindPriority[message.kind] ?? 0;
  if (message.isBacklog) priority -= 50; // BACKLOG_PRIORITY_OFFSET
  return priority;
}
