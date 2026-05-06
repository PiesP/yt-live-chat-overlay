import type { SuperChatInfo } from '@app-types';

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

const uiColors = {
  background: '#1a1a1a',
  backgroundLight: '#222222',
  border: '#444444',
  text: '#ffffff',
  textMuted: '#cccccc',
  primary: '#1e88e5',
  primaryHover: '#1976d2',
  danger: '#e53935',
} as const;

export const colors = {
  authorMember: '#0f9d58',
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
export const RENDERER_LAYOUT = {
  AUTHOR_PHOTO_SIZE: 24,
  AUTHOR_FONT_SCALE: 0.85,
  EMOJI_SIZE: 1.2,
  SUPERCHAT_STICKER_SIZE: 2,
  EXIT_PADDING_MIN: 100,
  EXIT_PADDING_SCALE: 3,
  DURATION_MIN: 5000,
  DURATION_MAX: 12000,
  LANE_DELAY_CYCLE: 13,
  LANE_DELAY_MS: 15,
  GLOBAL_STAGGER_MS: 150,
  SAFE_DISTANCE_SCALE: 0.3,
  SAFE_DISTANCE_MIN: 6,
  VERTICAL_CLEAR_TIME_MIN: 20,
  VERTICAL_CLEAR_TIME_MAX: 80,
  LANE_HEIGHT_PADDING_SCALE: 0.06,
  LANE_HEIGHT_PADDING_MIN: 1,
  RETRY_DELAY_MIN_MS: 16,
  RETRY_DELAY_MAX_MS: 800,
  QUEUE_MAX_SIZE: 30,
  ENTRY_OFFSET_MAX: 200,
} as const;

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
