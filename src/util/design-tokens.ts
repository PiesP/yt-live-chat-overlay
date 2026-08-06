// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Design tokens and layout constants.
 *
 * Pure constants and layout configuration.
 */

import type { RgbColor, SuperChatInfo } from '@app-types';
import { MS_TO_S } from '@renderer/constants';

/**
 * Compute DLIOS animation duration from total travel distance and velocity.
 *
 * The minimum duration is velocity-aware so that short messages at high
 * scroll speeds are not artificially slowed down by a static floor.
 * Without this, at speedPxPerSec=500 a 3-char message's computed duration
 * (~3070ms) was clamped to the settings scrollDurationMinMs (5000ms), capping
 * the effective speed at 307px/s instead of the user-configured 500px/s.
 *
 * @param totalDistance  — screenWidth + textWidth + exitPadding
 * @param velocity       — constant scroll velocity in px/sec
 * @param durationMin    — minimum allowed duration in ms
 * @param durationMax    — maximum allowed duration in ms
 * @param exitPaddingPx  — exit padding distance in px
 * @returns Animation duration in milliseconds
 */
export function computeScrollDuration(
  totalDistance: number,
  velocity: number,
  durationMin: number,
  durationMax: number,
  exitPaddingPx: number
): number {
  // Defensive: return minimum duration when any input is NaN or velocity ≤ 0.
  // NaN can propagate from text measurement failures or invalid canvas
  // dimensions, leading to stuck messages (invDuration=NaN → position=NaN).
  if (Number.isNaN(totalDistance) || Number.isNaN(velocity) || velocity <= 0) {
    return durationMin;
  }
  // Velocity-based floor: at minimum, allow the message to travel
  // exitPadding pixels at the configured velocity, but no less than the minimum duration.
  const velocityFloor = Math.max(durationMin, (exitPaddingPx / velocity) * MS_TO_S);
  return Math.max(velocityFloor, Math.min(durationMax, (totalDistance / velocity) * MS_TO_S));
}

/** Default font family stack for overlay text rendering. */
export const DEFAULT_FONT_FAMILY = 'system-ui, -apple-system, sans-serif';

// ── Rendering / Layout defaults ─────────────────────────────────────────
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
  /** Regular-message backgrounds. Alpha 0x59 is approximately 35% opacity. */
  authorBackground: {
    normal: '#00000000',
    member: '#00000000',
    moderator: '#1B3A6F59',
    owner: '#6B4F0059',
    verified: '#00000000',
  },
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
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
} as const;

// ── Fallback colors ─────────────────────────────────────────────────────────

/** Default text color used when no author-specific color is configured. */
export const DEFAULT_TEXT_COLOR = '#ffffff';

// ── SuperChat amount badge ──
export const SUPERCHAT_AMOUNT_BADGE_FILL = 'rgba(255, 255, 255, 0.24)';
export const SUPERCHAT_AMOUNT_BADGE_STROKE = 'rgba(255, 255, 255, 0.35)';

// ── Author photo shadow ──
export const AUTHOR_PHOTO_SHADOW = 'rgba(0, 0, 0, 0.6)';

// ── Debug overlay ──
export const DEBUG_OVERLAY_BG = 'rgba(0, 0, 0, 0.8)';
export const DEBUG_OVERLAY_TOP = '8px';
export const DEBUG_OVERLAY_RIGHT = '8px';
export const INDICATOR_Z_INDEX = '99999';

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
  // ── Message layout ──
  /** Font-relative insets for regular message cards. */
  regularCard: {
    paddingXScale: 0.375,
    paddingXMin: 6,
    paddingXMax: 14,
    paddingYScale: 0.1875,
    paddingYMin: 3,
    paddingYMax: 8,
  },
  /** Message padding: horizontal (px) */
  paddingH: 12,
  /** Regular message background border radius (px) */
  messageBackgroundRadius: 6,
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
  // SSOT: these 4 values mirror DEFAULT_SETTINGS in src/settings/defaults.ts
  // Update there first if defaults need changing (circular dep prevents direct import).
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
  /** Headway gap ratio: fraction of message width used as gap between consecutive messages on the same lane.
   *  SSOT: mirrors DEFAULT_SETTINGS.headwayGapRatio. */
  headwayGapRatio: 0.08,
} as const;

/** Status bar layout constants (connection state overlay). */
export const statusBarLayout = {
  fontSize: 14,
  paddingX: 14,
  paddingY: 6,
  /** Vertical distance from bottom edge of viewport. */
  bottomOffset: 24,
  /** Rounded corner radius for the pill background. */
  pillRadius: 6,
  /** Dot radius for the status indicator. */
  dotRadius: 4,
  /** Gap between dot and text. */
  dotGap: 8,
  /** Colors keyed by ConnectionStatus type. */
  colors: {
    connected: {
      bg: 'rgba(0,200,100,0.30)',
      dot: 'rgba(0,255,140,0.80)',
      text: 'rgba(255,255,255,0.75)',
    },
    connecting: {
      bg: 'rgba(255,200,0,0.30)',
      dot: 'rgba(255,220,0,0.85)',
      text: 'rgba(255,255,255,0.75)',
    },
    degraded: {
      bg: 'rgba(255,140,0,0.30)',
      dot: 'rgba(255,160,0,0.85)',
      text: 'rgba(255,255,255,0.75)',
    },
    disconnected: {
      bg: 'rgba(220,50,50,0.45)',
      dot: 'rgba(255,60,60,0.90)',
      text: 'rgba(255,255,255,0.85)',
    },
    standby: {
      bg: 'rgba(0,0,0,0.50)',
      dot: 'rgba(255,255,255,0.50)',
      text: 'rgba(255,255,255,0.70)',
    },
  },
} as const;
