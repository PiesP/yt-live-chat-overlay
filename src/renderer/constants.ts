// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage } from '@app-types';

/**
 * Shared renderer constants — single source of truth for values used by both
 * the main-thread CanvasRenderer and the OffscreenCanvas Web Worker.
 *
 * Extracted from renderer-canvas.ts, lane-allocator.ts, canvas-rendering-shared.ts
 * to eliminate the 23+ duplicated constant definitions in renderer-worker.ts
 * that risk maintenance drift.
 *
 * Values that could be imported directly (rendererLayout, LaneAllocator public
 * statics) are NOT duplicated here — import them from their canonical modules.
 */

// ── Card rendering ──────────────────────────────────────────────────────

/** Max cached linear-gradient entries (SuperChat/Membership card backgrounds).
 *  Used by both main thread (LruMap) and worker (Map with manual eviction)
 *  to keep gradient memory bounded during long streams. */
export const GRADIENT_CACHE_MAX = 64;

// ── Lane allocation (lane-allocator.ts) ─────────────────────────────────────

/** Speed tier constants for depth-layered rendering.
 *  FAR=background, MID=middle, NEAR=foreground, BACKLOG=backlog messages.
 *  Used by both main-thread lane allocator and worker. */
export const SPEED_TIER = { FAR: 0, MID: 1, NEAR: 2, BACKLOG: 3 } as const;

/** Minimum cooldown between consecutive uses of the same lane (ms).
 *  Used only for top/bottom (non-scrolling) modes. */
export const LANE_COOLDOWN_MIN_MS = 500;

/** Safety margin ratio applied to message duration.
 *  Used only for top/bottom (non-scrolling) modes. */
export const SAFETY_MARGIN_RATIO = 0.15;

/** Epsilon-greedy selection probability (0-1).
 *  5% chance to skip the strict topmost zero-wait lane. */
export const EPSILON = 0.05;

/** Free ratio for anti-block gate: utilization above (1 - this) triggers
 *  probabilistic blocking of new message placements. */
export const ANTI_BLOCK_FREE_RATIO = 0.05;

/** Maximum consecutive duration (ms) that anti-block can suppress drainQueue
 *  before the renderer forces a drain regardless of lane saturation.
 *  Shared by CanvasRenderer (main thread) and renderer-worker (OffscreenCanvas). */
export const ANTI_BLOCK_MAX_DURATION_MS = 2000;

/** Default emoji fetch timeout (ms) — fallback used when config is unavailable. */
export const EMOJI_FETCH_TIMEOUT_DEFAULT_MS = 30_000;

/** Grace period (ms) before the render loop transitions to idle mode
 *  after the last active message exits or playback pauses.
 *  Shared by both main-thread CanvasRenderer and OffscreenCanvas Worker renderer. */
export const IDLE_GRACE_PERIOD_MS = 500;

/** Number of opacity buckets for render-phase opacity grouping.
 *  Messages with opacity 0.0–1.0 are distributed across 21 buckets
 *  (Math.round(opacity * 20)) for grouped draw-order submission. */
export const OPACITY_BUCKET_COUNT = 21;

// ── Stagger (renderer-canvas.ts) ────────────────────────────────────────────

/** Horizontal stagger per batch index step (px). */
export const HORIZONTAL_STAGGER_PER_STEP = 40;

/** Maximum horizontal stagger offset (px). */
export const HORIZONTAL_STAGGER_MAX = 200;

/** Maximum batch index for stagger exponential scale computation. */
export const STAGGER_BATCH_MAX = 3;

/** Exponential scale factor for stagger delay (negative value = decreasing delay). */
export const STAGGER_EXP_SCALE = 25;

/** Stagger queue depth thresholds for adaptive stagger. */
export const STAGGER_QUEUE_HIGH = 50;
export const STAGGER_QUEUE_MED = 30;

// ── Translation (renderer-canvas.ts) ────────────────────────────────────────

/** Translation font scale relative to main font size. */
export const TRANSLATION_FONT_SCALE = 0.85;

/** Gap (px) between original text and translation text. */
export const TRANSLATION_GAP_PX = 2;

/** Translation opacity scale relative to message opacity. */
export const TRANSLATION_OPACITY_SCALE = 0.8;

// ── Depth layers (renderer-canvas.ts) ───────────────────────────────────────

/** Priority threshold for anti-block gate: messages with priority >= this
 *  value bypass the anti-block throttle so high-priority content (SuperChat,
 *  Membership) is never blocked by lane saturation. */
export const ANTI_BLOCK_PRIORITY_THRESHOLD = 80;

/** Tier split threshold: hash < this value → Near tier, else Far tier. */
export const TIER_NEAR_THRESHOLD = 0.3;

/** Desaturation factor for Far-tier depth layer user colors. */
export const FAR_LAYER_DESATURATION_FACTOR = 0.3;

/** Ghost alpha for temporal frame blending on FAR-tier messages.
 *  Renders a faint previous-frame copy before the current frame to
 *  create perceived motion blur, smoothing fast-scrolling text.
 *  Keep low (0.08–0.15) to avoid visible ghosting artifacts.
 *
 *  IMPORTANT: Ghost text MUST use text-only content segments, NOT
 *  message.text.  message.text includes emoji fallbackText (e.g.
 *  "PiesP Smile") which would render as faint unrelated text
 *  alongside emoji images.  See ChatMessage.text documentation. */
export const TEMPORAL_BLEND_ALPHA = 0.12;

// ── Text rendering (canvas-rendering-shared.ts) ──────────────────────────────

/** Outline stroke scale factor: outline.widthPx is multiplied by this
 *  to produce the actual stroke width. */
export const OUTLINE_STROKE_SCALE = 0.85;

/** Milliseconds to seconds conversion divisor. */
export const MS_TO_S = 1000;

// ── Trigonometric LUTs ──────────────────────────────────────────────────────

/** 256-entry pre-computed sine table covering [0, 2π).
 *  Indexed by floor(elapsed * SIN_LUT_SCALE) & 255 to avoid per-frame Math.sin().
 *  One sine cycle = 2000ms for membership card pulsing. */
export const SIN_TABLE: Float64Array = (() => {
  const t = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    t[i] = Math.sin((i / 256) * 2 * Math.PI);
  }
  return t;
})();

/** Scale factor to map elapsed (ms) to SIN_TABLE index.
 *  256 entries / 2000ms period = 0.128 index/ms.
 *  Usage: SIN_TABLE[((elapsed * SIN_LUT_SCALE) | 0) & 255] */
export const SIN_LUT_SCALE = 256 / 2000; // 0.128

// ── Shared utility functions ────────────────────────────────────────────────

/** Simple djb2-like hash of a string to a 0-1 float for tier assignment. */
export function hashStringForTier(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0) / 4294967296;
}

/** Reusable empty ChatMessage for pool initialization. */
export const EMPTY_CHAT_MESSAGE: ChatMessage = {
  text: '',
  content: [],
  kind: 'text',
  timestamp: 0,
  authorType: 'normal',
};

/** Canvas-side message state used by the render loop. */
export interface CanvasMessage {
  message: ChatMessage;
  /** Position/animation start time (includes stagger delay). */
  startTime: number;
  /** Opacity/fade start time — independent of position timeline.
   *  When equal to startTime, fade-in begins when the message appears.
   *  Can be offset for independent fade/position timing control. */
  fadeStartTime: number;
  duration: number;
  /** Pre-computed 1/duration to avoid per-frame division in progress calc. */
  invDuration: number;
  width: number;
  height: number;
  startX: number;
  x: number;
  y: number;
  pausedDuration: number;
  laneIndex: number;
  /** Time stagger delay (ms) applied to this message's start. */
  staggerDelay: number;
  /** Speed tier for lane allocation (0=Far, 1=Mid, 2=Near, 3=Backlog). */
  speedTier: number;
  /** Translated text (async result). undefined = not requested, null = cleared/unavailable, string = done. */
  translatedText?: string | null;
  /** Pre-computed desaturated color for Far-tier depth layer. */
  desaturatedUserColor?: string;
  /** Number of vertical lanes this message occupies (1 for single-slot, 2+ for multi-slot). */
  slotCount?: number;
  /** Pre-computed render message (always set — either original or desaturated copy). */
  renderMessage: ChatMessage;
  /** Transient frame-local elapsed (ms). Set by renderFrame pre-scan, read by
   *  rendering. Not serialized — re-set each frame. */
  _frameElapsed?: number;
  /** Transient previous-frame X position for temporal frame blending (motion blur).
   *  Set before position update in pre-scan, read by draw stage for ghost rendering.
   *  Only meaningful for FAR-tier messages. Not serialized. */
  _prevX?: number;
  /** Transient previous-frame Y position for temporal frame blending. */
  _prevY?: number;
  /**
   * Per-slot index in each per-lane array (activeMessagesByLane).
   * laneArrayIndices[s] = position of this message in the per-lane array
   * for lane laneIndex + s. Used by compactRemovedMessages for O(1)
   * swap-pop removal instead of O(n) indexOf. Updated when swap-pop
   * displaces another message in the same per-lane array.
   */
  laneArrayIndices: number[];
}
