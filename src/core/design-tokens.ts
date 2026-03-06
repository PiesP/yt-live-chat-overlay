import type { AuthorType, SuperChatInfo } from '@app-types';

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const authorColors = {
  normal: '#ffffff',
  member: '#0f9d58',
  moderator: '#5e84f1',
  owner: '#ffd600',
  verified: '#ffffff',
} as const satisfies Record<AuthorType, string>;

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

const emojiColors = {
  standard: '#ffab00',
  member: '#0f9d58',
} as const;

export const colors = {
  author: authorColors,
  superChat: superChatColors,
  ui: uiColors,
  emoji: emojiColors,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const typography = {
  fontSize: {
    xs: '12px',
    sm: '14px',
    base: '16px',
    lg: '18px',
    xl: '24px',
    xxl: '32px',
  },
  fontWeight: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  lineHeight: {
    tight: 1.2,
    normal: 1.5,
    relaxed: 1.75,
  },
} as const;

export const shadows = {
  text: {
    sm: '1px 1px 2px rgba(0, 0, 0, 0.8)',
    md: '2px 2px 4px rgba(0, 0, 0, 0.8)',
    lg: '3px 3px 6px rgba(0, 0, 0, 0.9)',
  },
  box: {
    sm: '0 2px 8px rgba(0, 0, 0, 0.6)',
    md: '0 4px 16px rgba(0, 0, 0, 0.8)',
    lg: '0 8px 24px rgba(0, 0, 0, 0.9)',
  },
  filter: {
    sm: 'drop-shadow(1px 1px 2px rgba(0, 0, 0, 0.8))',
    md: 'drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.8))',
    lg: 'drop-shadow(3px 3px 6px rgba(0, 0, 0, 0.9))',
  },
} as const;

export const borderRadius = {
  sm: '6px',
  md: '8px',
  lg: '12px',
  xl: '14px',
  full: '50%',
} as const;

export const animation = {
  duration: {
    min: 5000,
    max: 12000,
  },
  laneDelay: 300,
} as const;

export const zIndex = {
  base: 10000,
  messages: 10001,
  settings: 10002,
  modal: 10003,
} as const;

const clampAlpha = (alpha: number): number => Math.min(1, Math.max(0, alpha));

export function rgba(color: RgbColor, alpha: number): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${clampAlpha(alpha)})`;
}

export function createGradient(color: RgbColor, stops: readonly number[]): string {
  return `linear-gradient(to bottom, ${stops.map((alpha) => rgba(color, alpha)).join(', ')})`;
}
