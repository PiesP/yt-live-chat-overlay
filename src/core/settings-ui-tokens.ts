// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { DEFAULT_FONT_FAMILY } from '@core/design-tokens';

// ── UI color palette (settings UI only, not renderer) ──
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
  warning: '#ffc107',
} as const;

export { uiColors };

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
    tight: 1,
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
  settingsButton: 120,
} as const;

// ── UI sizing tokens (settings panel layout) ──
export const uiSizing = {
  buttonSize: 36,
  buttonFontSize: 18,
  inputWidth: 86,
  colorSwatch: 44,
  modalWidth: 400,
  modalMaxVW: 92,
  modalMaxWidth: 420,
  modalMaxVH: 82,
  confirmMinWidth: 240,
  checkboxSize: 18,
  borderAlpha: 0.25,
  scrimAlpha: 0.55,
  hoverScrimAlpha: 0.75,
} as const;

// ── Animation durations (settings panel) ──
export const animDuration = {
  fast: '0.1s',
  normal: '0.15s',
  slow: '0.18s',
  transitions: {
    button: 'opacity 0.15s, background 0.15s, transform 0.1s',
    action: 'background 0.15s, color 0.15s, border-color 0.15s',
    tab: 'color 0.1s',
  },
} as const;

// ── UI confirm backdrop alpha ──
export const CONFIRM_BACKDROP_ALPHA = 0.5;

// ── Toast notification ──
export const TOAST_BG = 'rgba(0, 0, 0, 0.85)';
export const TOAST_FONT = `12px/1.4 ${DEFAULT_FONT_FAMILY}`;
export const TOAST_PADDING = '6px 14px';
