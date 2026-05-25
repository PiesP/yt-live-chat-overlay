import type { SuperChatInfo, SuperChatTier } from '@app-types';

/** Default font family stack for overlay text rendering. */
export const DEFAULT_FONT_FAMILY = 'system-ui, -apple-system, sans-serif';

interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const superChatColors = {
  blue: { r: 30, g: 136, b: 229 },
  cyan: { r: 0, g: 191, b: 255 },
  green: { r: 29, g: 233, b: 182 },
  yellow: { r: 255, g: 202, b: 40 },
  orange: { r: 245, g: 124, b: 0 },
  magenta: { r: 233, g: 30, b: 99 },
  red: { r: 230, g: 33, b: 23 },
} as const satisfies Readonly<Record<SuperChatInfo['tier'], RgbColor>>;

export const SUPERCHAT_TIER_KEYS = Object.keys(superChatColors) as Array<SuperChatInfo['tier']>;

export const colors = {
  authorNormal: '#FFFFFF',
  authorMember: '#0F9D58',
  authorModerator: '#5E84F1',
  authorOwner: '#FFD600',
  authorVerified: '#AAAAAA',
  superChat: superChatColors,
  membership: {
    background: { r: 15, g: 157, b: 88 },
    backgroundAlpha: 0.28,
    borderAlpha: 0.75,
    borderAlphaAmplitude: 0.15,
    text: '#ffffff',
  },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
} as const;

// ── SuperChat amount badge ──
export const SUPERCHAT_AMOUNT_BADGE_FILL = 'rgba(255, 255, 255, 0.16)';
export const SUPERCHAT_AMOUNT_BADGE_STROKE = 'rgba(255, 255, 255, 0.22)';

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
export function computeScrollDuration(totalDistance: number, velocity: number): number {
  // Velocity-based floor: at minimum, allow the message to travel
  // exitPadding pixels at the configured velocity, but no less than 3s.
  const velocityFloor = Math.max(
    rendererLayout.durationMin,
    (rendererLayout.exitPaddingMin / velocity) * 1000
  );
  return Math.max(
    velocityFloor,
    Math.min(rendererLayout.durationMax, (totalDistance / velocity) * 1000)
  );
}

/** Parse any supported color string (hex or rgb/rgba) to RgbColor. */
export function parseAnyColor(colorString: string): RgbColor | null {
  if (colorString.startsWith('#')) {
    const hex = colorString.slice(1);
    if (hex.length < 3) return null;
    const expand = hex.length <= 4;
    const h0 = hex[0] ?? '0';
    const h1 = hex[1] ?? '0';
    const h2 = hex[2] ?? '0';
    const r = parseInt(expand ? h0 + h0 : hex.slice(0, 2), 16);
    const g = parseInt(expand ? h1 + h1 : hex.slice(2, 4), 16);
    const b = parseInt(expand ? h2 + h2 : hex.slice(4, 6), 16);
    return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? { r, g, b } : null;
  }
  const match = colorString.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!match) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

/**
 * Relative luminance per WCAG 2.0.
 * https://www.w3.org/TR/WCAG20/#relativeluminancedef
 */
function relativeLuminance(rgb: RgbColor): number {
  const [rs, gs, bs] = [rgb.r / 255, rgb.g / 255, rgb.b / 255];
  const r = rs <= 0.03928 ? rs / 12.92 : ((rs + 0.055) / 1.055) ** 2.4;
  const g = gs <= 0.03928 ? gs / 12.92 : ((gs + 0.055) / 1.055) ** 2.4;
  const b = bs <= 0.03928 ? bs / 12.92 : ((bs + 0.055) / 1.055) ** 2.4;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Compute an outline color that contrasts with the given text color.
 *
 * Uses WCAG 2.0 relative luminance: light text (L > 0.5) gets a dark
 * outline, dark text gets a light outline. This ensures the outline is
 * always visible regardless of the text color or background.
 *
 * @param textColor - CSS color string (hex or rgb/rgba)
 * @param opacity   - Outline opacity (0-1)
 * @returns CSS rgba string for the outline stroke
 */
export function computeOutlineColor(textColor: string, opacity: number): string {
  const rgb = parseAnyColor(textColor);
  if (!rgb) return `rgba(0, 0, 0, ${opacity})`;
  const lum = relativeLuminance(rgb);
  if (lum > 0.5) {
    return `rgba(0, 0, 0, ${opacity})`;
  }
  return `rgba(255, 255, 255, ${opacity})`;
}

/** Resolve SuperChat display color: use YouTube's color if available, else tier default. */
export function resolveSuperChatRgb(
  superChat: { headerBackgroundColor?: string; backgroundColor?: string; tier: SuperChatTier },
  colors: Record<SuperChatTier, RgbColor>
): RgbColor {
  const sourceColor = superChat.headerBackgroundColor || superChat.backgroundColor;
  const parsed = sourceColor ? parseAnyColor(sourceColor) : null;
  return parsed ?? colors[superChat.tier] ?? colors.blue;
}

/** Opacity boost applied to the top of a SuperChat card gradient. */
const SUPERCHAT_TOP_OPACITY_BOOST = 0.06;

/** Opacity reduction applied to the bottom of a SuperChat card gradient. */
const SUPERCHAT_BOTTOM_OPACITY_REDUCTION = 0.08;

/** Minimum opacity for SuperChat card gradient (clamps base and bottom). */
const SUPERCHAT_MIN_OPACITY = 0.4;

/** Compute top/middle/bottom opacities for SuperChat card gradient. */
export function computeSuperChatOpacities(superChatOpacity: number): {
  base: number;
  top: number;
  bottom: number;
} {
  const base = Math.min(1, Math.max(SUPERCHAT_MIN_OPACITY, superChatOpacity));
  return {
    base,
    top: Math.min(1, base + SUPERCHAT_TOP_OPACITY_BOOST),
    bottom: Math.max(SUPERCHAT_MIN_OPACITY, base - SUPERCHAT_BOTTOM_OPACITY_REDUCTION),
  };
}

/**
 * Convert an rgb(...) or rgba(...) color string to rgba(...) with the given alpha.
 */
export function toRgba(color: string, alpha: number): string {
  const match = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,[^)]*)?\)/);
  if (!match) return color;
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
}

/**
 * Sample from an exponential distribution with the given mean.
 * Uses the inverse-CDF method: -mean * ln(1 - U) where U ~ Uniform(0, 1).
 */
export function sampleExponential(mean: number): number {
  return -mean * Math.log(1 - Math.random());
}

/**
 * Choose a readable text color (black or white) for a given background color.
 * Uses WCAG 2.0 relative luminance: returns '#000000' for light backgrounds,
 * '#ffffff' for dark backgrounds.
 */
export function computeReadableTextColor(backgroundColor: string): string {
  const rgb = parseAnyColor(backgroundColor);
  if (!rgb) return '#ffffff';
  return relativeLuminance(rgb) > 0.5 ? '#000000' : '#ffffff';
}
