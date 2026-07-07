// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Design tokens and layout constants.
 *
 * Pure constants and layout configuration. Color utility functions have been
 * extracted to color-utils.ts, math helpers to math-utils.ts, and are
 * re-exported here for backward compatibility.
 */

export { resolveSuperChatRgb } from '@renderer/color-utils';
export { computeScrollDuration } from '@renderer/utils';

import type { RgbColor, SuperChatInfo } from '@app-types';

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
