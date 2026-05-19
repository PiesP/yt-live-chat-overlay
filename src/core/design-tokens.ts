import type { SuperChatInfo, SuperChatTier } from '@app-types';

export interface RgbColor {
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

const uiColors = {
  background: '#1a1a1a',
  backgroundLight: '#222222',
  border: '#444444',
  text: '#ffffff',
  textMuted: '#cccccc',
  primary: '#1e88e5',
  primaryHover: '#1976d2',
  danger: '#e53935',
  dangerHover: '#c62828',
} as const;

export const colors = {
  authorNormal: '#FFFFFF',
  authorMember: '#0F9D58',
  authorModerator: '#5E84F1',
  authorOwner: '#FFD600',
  authorVerified: '#AAAAAA',
  superChat: superChatColors,
  ui: uiColors,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
} as const;

export const typography = {
  fontSize: {
    xs: '12px',
    sm: '14px',
    base: '16px',
    lg: '18px',
  },
  fontWeight: {
    normal: 400,
    semibold: 600,
    bold: 700,
  },
  lineHeight: {
    normal: 1.5,
  },
} as const;

export const shadows = {
  text: {
    sm: '1px 1px 2px rgba(0, 0, 0, 0.8)',
    md: '2px 2px 4px rgba(0, 0, 0, 0.8)',
    lg: '2px 2px 6px rgba(0, 0, 0, 0.9), -1px -1px 4px rgba(0, 0, 0, 0.7)',
  },
  box: {
    sm: '0 2px 8px rgba(0, 0, 0, 0.6)',
    md: '0 4px 16px rgba(0, 0, 0, 0.8)',
    lg: '0 8px 24px rgba(0, 0, 0, 0.9)',
  },
  filter: {
    md: 'drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.8))',
  },
} as const;

export const borderRadius = {
  sm: '6px',
  md: '8px',
  lg: '12px',
  full: '50%',
} as const;

export const zIndex = {
  modal: 10003,
} as const;

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
  exitPaddingScale: 3,
  durationMin: 5000,
  durationMax: 30000,
  globalStaggerMs: 20,
  safeDistanceScale: 0.05,
  safeDistanceMin: 4,
  retryDelayMinMs: 32,
  retryDelayMaxMs: 800,
  topBottomDurationMs: 4000,
  dliosSafetyGap: 4,
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
  // ── Extracted magic numbers ──
  /** Random jitter added to lane delay (ms) */
  laneJitterMs: 30,
  /** Author section vertical gap in px (photo + name height) */
  authorSectionHeightPx: 28,
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
  /** Pending queue max size */
  queueMaxSize: 50,
  /** Batch size for queue processing */
  batchSize: 3,
  /** Max retry attempts for deferred messages */
  maxRetries: 3,
  /** Sweep interval (process every N calls) */
  sweepInterval: 8,
  /** Sweep tolerance (ms) */
  sweepToleranceMs: 500,
  /** Max animation jitter (ms) */
  maxAnimationJitterMs: 15,
  /** Opacity update interval (ms) — 0 = disabled (use frame-based fade) */
  opacityUpdateIntervalMs: 0,
  /** Background queue max */
  backgroundQueueMax: 10,
  /** Max message age for fade-out (ms) */
  maxMessageAgeMs: 60_000,
  /** Delay after fullscreen change before updating dimensions (ms) */
  fullscreenUpdateDelayMs: 100,
  /** Z-index for the overlay container */
  overlayZIndex: '100',
} as const;

/**
 * Compute scrolling duration for a single comment under the DLIOS
 * constant-velocity model. Unlike the old computeCrossDuration (same
 * duration for all comments), this returns a width-proportional duration
 * so every comment scrolls at the same velocity.
 *
 * @param totalDistance  — screenWidth + textWidth + exitPadding
 * @param velocity       — constant scroll velocity in px/sec
 * @returns Animation duration in milliseconds, clamped to [durationMin, durationMax]
 */
export function computeDliosDuration(totalDistance: number, velocity: number): number {
  return Math.max(
    rendererLayout.durationMin,
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

/** Compute top/middle/bottom opacities for SuperChat card gradient. */
export function computeSuperChatOpacities(superChatOpacity: number): {
  base: number;
  top: number;
  bottom: number;
} {
  const base = Math.min(1, Math.max(0.4, superChatOpacity));
  return {
    base,
    top: Math.min(1, base + 0.06),
    bottom: Math.max(0.4, base - 0.08),
  };
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
