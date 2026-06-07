// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage } from '@app-types';

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

// ── Card rendering ──────────────────────────────────────────────────────

/** Factor applied to card background opacity for visual blending. */
export const CARD_BG_OPACITY_FACTOR = 0.85;

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
export const TRANSLATION_FONT_SCALE = 0.85;

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

/** Milliseconds to seconds conversion divisor. */
export const MS_TO_S = 1000;

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
 * Desaturate a CSS color toward gray by a given factor.
 * Accepts #RRGGBB hex, #RGB short hex, or rgb(r,g,b) / rgba(r,g,b,a) formats.
 * factor 0 = original, 1 = full grayscale.
 * Uses luminance-preserving weights (ITU-R BT.601).
 */
export function desaturateColor(color: string, factor: number): string {
  let r: number, g: number, b: number;

  if (color.startsWith('#')) {
    const hex = color.slice(1);
    if (hex.length === 3) {
      r = parseInt(hex.charAt(0) + hex.charAt(0), 16);
      g = parseInt(hex.charAt(1) + hex.charAt(1), 16);
      b = parseInt(hex.charAt(2) + hex.charAt(2), 16);
    } else {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    }
  } else {
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return color;
    const [, rStr = '0', gStr = '0', bStr = '0'] = match;
    r = parseInt(rStr, 10);
    g = parseInt(gStr, 10);
    b = parseInt(bStr, 10);
  }

  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  return `rgb(${Math.round(r + (gray - r) * factor)},${Math.round(g + (gray - g) * factor)},${Math.round(b + (gray - b) * factor)})`;
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
}
