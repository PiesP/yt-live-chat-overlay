// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Design tokens and layout constants.
 *
 * Pure constants and layout configuration. Color utility functions have been
 * extracted to color-utils.ts, math helpers to math-utils.ts, and are
 * re-exported here for backward compatibility.
 */

export { resolveSuperChatRgb } from './color-utils';

import type { RgbColor, SuperChatInfo } from '@app-types';

/** Default font family stack for overlay text rendering. */
export const DEFAULT_FONT_FAMILY = 'system-ui, -apple-system, sans-serif';

// ── Time unit constants ─────────────────────────────────────────────────
/** One second in milliseconds. */
export const SECOND = 1000;
/** One minute in milliseconds. */
export const MINUTE = 60 * SECOND;
/** One hour in milliseconds. */
export const HOUR = 60 * MINUTE;

const superChatColors = {
  blue: { r: 30, g: 136, b: 229 },
  cyan: { r: 0, g: 191, b: 255 },
  green: { r: 15, g: 157, b: 88 },
  yellow: { r: 255, g: 202, b: 40 },
  orange: { r: 245, g: 124, b: 0 },
  magenta: { r: 233, g: 30, b: 99 },
  red: { r: 230, g: 33, b: 23 },
} as const satisfies Readonly<Record<SuperChatInfo['tier'], RgbColor>>;

export const SUPERCHAT_TIER_KEYS = Object.keys(superChatColors) as (keyof typeof superChatColors)[];

export const colors = {
  authorNormal: '#FFFFFF',
  authorMember: '#0F9D58',
  authorModerator: '#5E84F1',
  authorOwner: '#FFD600',
  authorVerified: '#AAAAAA',
  superChat: superChatColors,
  membership: {
    background: { r: 15, g: 157, b: 88 },
    borderRgb: { r: 45, g: 220, b: 120 },
    backgroundAlpha: 0.28,
    borderAlpha: 0.75,
    borderAlphaAmplitude: 0.15,
    text: '#ffffff',
    headerText: '#ffffff',
  },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
} as const;

// ── SuperChat amount badge ──
export const SUPERCHAT_AMOUNT_BADGE_FILL = 'rgba(255, 255, 255, 0.24)';
export const SUPERCHAT_AMOUNT_BADGE_STROKE = 'rgba(255, 255, 255, 0.35)';

// ── Author photo shadow ──
export const AUTHOR_PHOTO_SHADOW = 'rgba(0, 0, 0, 0.6)';

// ── Debug overlay ──
export const DEBUG_OVERLAY_BG = 'rgba(0, 0, 0, 0.8)';
export const DEBUG_OVERLAY_TOP = '8px';
export const DEBUG_OVERLAY_RIGHT = '8px';
export const DEBUG_OVERLAY_Z_INDEX = '99999';

// ── Backlog indicator ──
export const BACKLOG_INDICATOR_BG = 'rgba(0, 0, 0, 0.75)';

/**
 * Renderer layout constants.
 *
 * Placed here to avoid circular imports between renderer.ts ↔ renderer-styles.ts
 * and renderer.ts ↔ renderer-message-builder.ts.
 */
export const rendererLayout = {
  authorPhotoSize: 24,
  authorFontScale: 0.85,
  emojiSize: 1.2,
  superchatStickerSize: 2,
  exitPaddingMin: 100,
  durationMin: 5000,
  durationMax: 30000,
  topBottomDurationMs: 4000,
  kindPriority: {
    superchat: 200,
    membership: 100,
    text: 0,
  } as const,
  burstSpeedMultiplier: {
    normal: 1.0,
    elevated: 1.1,
    high: 1.2,
    extreme: 1.35,
  } as const,
  // ── Message padding ──
  /** Message padding: horizontal (px) */
  paddingH: 12,
  /** Message padding: vertical (px) */
  paddingV: 8,
  /** SuperChat card min width (px) */
  superchatMinWidth: 280,
  /** SuperChat card max width (px) */
  superchatMaxWidth: 640,
  /** SuperChat card padding */
  superchat: {
    /** Horizontal padding inside the card (px) */
    paddingH: 24,
    /** Vertical padding inside the card (px) */
    paddingV: 20,
  },
  /** Membership card padding */
  membership: {
    /** Horizontal padding inside the card (px) */
    paddingH: 16,
    /** Vertical padding inside the card (px) */
    paddingV: 12,
  },
  /** SuperChat amount badge pill metrics */
  superchatBadge: {
    /** Horizontal padding inside the badge pill (px) */
    paddingH: 12,
    /** Vertical padding inside the badge pill (px) */
    paddingV: 8,
    /** Border radius of the badge pill (px) */
    radius: 12,
  },
  /** Pending queue max size */
  queueMaxSize: 200,
  /** Background queue max */
  backgroundQueueMax: 50,
  /** Max message age for fade-out (ms) */
  maxMessageAgeMs: 60_000,
  /** Delay after fullscreen change before updating dimensions (ms) */
  fullscreenUpdateDelayMs: 100,
  /** Z-index for the overlay container */
  overlayZIndex: '100',
  /** SuperChat card border radius (px) */
  superchatCardRadius: 6,
  /** Membership card border radius (px) */
  membershipCardRadius: 6,
  /** SuperChat left accent bar width (px) */
  superchatAccentBarWidth: 4,
  /** SuperChat amount badge stroke width (px) */
  superchatBadgeStrokeWidth: 1,
  /** Membership card glow border stroke width (px) */
  membershipBorderWidth: 2,
  /** Maximum author name width inside a card (px).
   *  Derived from: superchatMaxWidth - paddingH*2 - authorPhotoSize - spacing.sm
   *  = 640 - 48 - 24 - 8 = 560. Prevents long names from overflowing the card. */
  authorNameMaxWidth: 560,
  /** Headway gap ratio: fraction of message width used as gap between consecutive messages on the same lane. */
  headwayGapRatio: 0.08,
} as const;

/** Standby status message constants (pre-live overlay). */
export const standbyMessageLayout = {
  fontSize: 16,
  paddingX: 16,
  paddingY: 8,
  /** Vertical distance from bottom edge of viewport. */
  bottomOffset: 24,
  /** Rounded corner radius for the pill background. */
  pillRadius: 6,
  /** Semi-transparent background color. */
  fillStyle: 'rgba(0, 0, 0, 0.5)',
  /** Text color. */
  textFillStyle: 'rgba(255, 255, 255, 0.7)',
} as const;

/**
 * Compute DLIOS animation duration from total travel distance and velocity.
 *
 * The minimum duration is velocity-aware so that short messages at high
 * scroll speeds are not artificially slowed down by a static floor.
 * Without this, at speedPxPerSec=500 a 3-char message's computed duration
 * (~3070ms) was clamped to rendererLayout.durationMin (5000ms), capping
 * the effective speed at 307px/s instead of the user-configured 500px/s.
 *
 * @param totalDistance  — screenWidth + textWidth + exitPadding
 * @param velocity       — constant scroll velocity in px/sec
 * @returns Animation duration in milliseconds
 */
export function computeScrollDuration(
  totalDistance: number,
  velocity: number,
  durationMin: number,
  durationMax: number,
  exitPaddingPx: number
): number {
  // Velocity-based floor: at minimum, allow the message to travel
  // exitPadding pixels at the configured velocity, but no less than the minimum duration.
  const velocityFloor = Math.max(durationMin, (exitPaddingPx / velocity) * 1000);
  return Math.max(velocityFloor, Math.min(durationMax, (totalDistance / velocity) * 1000));
}
