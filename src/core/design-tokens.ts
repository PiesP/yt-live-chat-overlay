import type { OutlineSettings, SuperChatInfo, SuperChatTier } from '@app-types';

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

export const SUPERCHAT_TIER_KEYS = [
  'blue',
  'cyan',
  'green',
  'yellow',
  'orange',
  'magenta',
  'red',
] as const satisfies readonly SuperChatInfo['tier'][];

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

/** Common font family presets for user selection.
 *  The first entry is the default. Each entry includes a CSS-safe fallback. */
export const FONT_FAMILIES = [
  'system-ui, -apple-system, sans-serif',
  '"Noto Sans KR", sans-serif',
  '"Malgun Gothic", sans-serif',
  '"Apple SD Gothic Neo", sans-serif',
  '"Nanum Gothic", sans-serif',
  '"Nanum Myeongjo", serif',
  '"D2Coding", monospace',
  '"Spoqa Han Sans Neo", sans-serif',
  '"Pretendard", sans-serif',
] as const satisfies readonly string[];

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
  laneHeightMultiplier: 1.12,
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
  /** Horizontal entry offset range for scroll mode (spread across lanes) */
  entryOffsetRangeMs: 200,
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
 * @param totalDistance  — entryOffset + screenWidth + textWidth + exitPadding
 * @param velocity       — constant scroll velocity in px/sec
 * @returns Animation duration in milliseconds, clamped to [durationMin, durationMax]
 */
export function computeDliosDuration(totalDistance: number, velocity: number): number {
  return Math.max(
    rendererLayout.durationMin,
    Math.min(rendererLayout.durationMax, (totalDistance / velocity) * 1000)
  );
}

export function parseRgbColor(colorString: string): RgbColor | null {
  const match = colorString.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!match) return null;
  return {
    r: parseInt(match[1] ?? '0', 10),
    g: parseInt(match[2] ?? '0', 10),
    b: parseInt(match[3] ?? '0', 10),
  };
}

export function rgba(color: RgbColor, alpha: number): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.min(1, Math.max(0, alpha))})`;
}

/** Resolve SuperChat display color: use YouTube's color if available, else tier default. */
export function resolveSuperChatRgb(
  superChat: { headerBackgroundColor?: string; backgroundColor?: string; tier: SuperChatTier },
  colors: Record<SuperChatTier, RgbColor>
): RgbColor {
  const sourceColor = superChat.headerBackgroundColor || superChat.backgroundColor;
  const parsed = sourceColor ? parseRgbColor(sourceColor) : null;
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

// ── Text outline helpers (shared between Renderer and future consumers) ───

/**
 * Build a CSS text-shadow string from outline settings.
 * Produces a multi-directional shadow for a thick outline effect, plus a
 * glow component for added legibility on bright backgrounds.
 */
export function buildTextShadow(outline: OutlineSettings): string {
  if (!outline.enabled || outline.widthPx <= 0 || outline.opacity <= 0) {
    return 'none';
  }

  const offset = outline.widthPx;
  const blur = Math.max(0, outline.blurPx);
  const baseOpacity = Math.min(1, outline.opacity);
  const shadowColor = `rgba(0, 0, 0, ${baseOpacity})`;
  const glowColor = `rgba(0, 0, 0, ${Math.min(1, baseOpacity * 0.85)})`;
  const glowBlur = Math.max(0.5, blur * 0.8);

  const corners = (
    [[-1, -1] as const, [1, -1] as const, [-1, 1] as const, [1, 1] as const] as const
  ).map(([dx, dy]) => `${dx * offset}px ${dy * offset}px ${blur}px ${shadowColor}`);

  return [...corners, `0px 0px ${glowBlur}px ${glowColor}`].join(', ');
}

/**
 * Build a CSS -webkit-text-stroke value from outline settings.
 * The stroke width is a fraction of the shadow offset so both effects
 * layer naturally without competing.
 */
export function buildTextStroke(outline: OutlineSettings): string {
  if (!outline.enabled || outline.widthPx <= 0 || outline.opacity <= 0) {
    return '0 transparent';
  }

  const strokeWidth = Math.max(0.3, outline.widthPx * 0.5);
  const strokeOpacity = Math.min(1, outline.opacity * 0.8);
  return `${strokeWidth}px rgba(0, 0, 0, ${strokeOpacity})`;
}
