// Design token system for unified styling across all components

export const colors = {
  // Author type colors
  author: {
    owner: '#ffd600', // Channel owner
    moderator: '#5e84f1', // Moderators
    verified: '#ffffff', // Verified users
    member: '#0f9d58', // Channel members
    normal: '#ffffff', // Regular users
  },

  // Super Chat tier colors
  superChat: {
    blue: { r: 30, g: 136, b: 229 }, // Tier 1
    cyan: { r: 29, g: 233, b: 182 }, // Tier 2
    green: { r: 0, g: 229, b: 255 }, // Tier 3
    yellow: { r: 255, g: 202, b: 40 }, // Tier 4
    orange: { r: 245, g: 124, b: 0 }, // Tier 5
    magenta: { r: 233, g: 30, b: 99 }, // Tier 6
    red: { r: 230, g: 33, b: 23 }, // Tier 7
  },

  // UI colors
  ui: {
    background: '#1a1a1a',
    backgroundLight: '#222222',
    border: '#444444',
    text: '#ffffff',
    textMuted: '#cccccc',
    primary: '#1e88e5',
    primaryHover: '#1976d2',
    danger: '#e53935',
  },

  // Semantic colors
  emoji: {
    standard: '#ffab00',
    member: '#0f9d58',
  },
};

export const spacing = {
  xs: 4, // 4px
  sm: 8, // 8px
  md: 12, // 12px
  lg: 16, // 16px
  xl: 20, // 20px
  xxl: 24, // 24px
  xxxl: 32, // 32px
};

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
};

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
};

export const borderRadius = {
  sm: '6px',
  md: '8px',
  lg: '12px',
  xl: '14px',
  full: '50%',
};

export const animation = {
  duration: {
    min: 5000,
    max: 12000,
  },

  laneDelay: 300,
};

export const zIndex = {
  base: 10000,
  messages: 10001,
  settings: 10002,
  modal: 10003,
};

// Helper functions

export function rgba(color: { r: number; g: number; b: number }, alpha: number): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

export function createGradient(
  color: { r: number; g: number; b: number },
  stops: number[]
): string {
  return `linear-gradient(to bottom, ${stops.map((alpha) => rgba(color, alpha)).join(', ')})`;
}
