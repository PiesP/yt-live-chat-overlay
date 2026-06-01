// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Shared renderer constants — single source of truth for values used by both
 * the main-thread CanvasRenderer and the OffscreenCanvas Web Worker.
 *
 * Extracted from renderer-canvas.ts, lane-allocator.ts, canvas-text-renderer.ts
 * to eliminate the 23+ duplicated constant definitions in renderer-worker.ts
 * that risk maintenance drift.
 *
 * Values that could be imported directly (rendererLayout, LaneAllocator public
 * statics) are NOT duplicated here — import them from their canonical modules.
 */

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

/** Number of opacity buckets for render-phase opacity grouping.
 *  Messages with opacity 0.0–1.0 are distributed across 21 buckets
 *  (Math.round(opacity * 20)) for grouped draw-order submission. */
export const OPACITY_BUCKET_COUNT = 21;

// ── Queue / drain (renderer-canvas.ts) ──────────────────────────────────────

/** Max number of consecutive collision skips in the drain queue. */
export const DRAIN_QUEUE_MAX_SKIP = 3;

// ── Stagger (renderer-canvas.ts) ────────────────────────────────────────────

/** Horizontal stagger per batch index step (px). */
export const HORIZONTAL_STAGGER_PER_STEP = 40;

/** Maximum horizontal stagger offset (px). */
export const HORIZONTAL_STAGGER_MAX = 200;

/** Maximum batch index for stagger exponential scale computation. */
export const STAGGER_BATCH_MAX = 3;

/** Exponential scale factor for stagger delay (negative value = decreasing delay). */
export const STAGGER_EXP_SCALE = 25;

// ── Translation (renderer-canvas.ts) ────────────────────────────────────────

/** Translation font scale relative to main font size. */
export const TRANSLATION_FONT_SCALE = 0.75;

/** Gap (px) between original text and translation text. */
export const TRANSLATION_GAP_PX = 2;

/** Translation opacity scale relative to message opacity. */
export const TRANSLATION_OPACITY_SCALE = 0.8;

// ── Depth layers (renderer-canvas.ts) ───────────────────────────────────────

/** Tier split threshold: hash < this value → Near tier, else Far tier. */
export const TIER_NEAR_THRESHOLD = 0.3;

/** Desaturation factor for Far-tier depth layer user colors. */
export const FAR_LAYER_DESATURATION_FACTOR = 0.3;

// ── Text rendering (canvas-text-renderer.ts) ────────────────────────────────

/** Outline stroke scale factor: outline.widthPx is multiplied by this
 *  to produce the actual stroke width. */
export const OUTLINE_STROKE_SCALE = 0.85;

// ── Shared utility functions ────────────────────────────────────────────────

/** Simple djb2-like hash of a string to a 0-1 float for tier assignment. */
export function hashStringForTier(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0) / 4294967296;
}

/**
 * Desaturate a hex color toward gray by a given factor.
 * factor 0 = original, 1 = full grayscale.
 * Uses luminance-preserving weights (ITU-R BT.601).
 */
export function desaturateColor(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  return `rgb(${Math.round(r + (gray - r) * factor)},${Math.round(g + (gray - g) * factor)},${Math.round(b + (gray - b) * factor)})`;
}
