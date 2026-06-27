// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { DEFAULT_FONT_FAMILY, spacing } from '@core/design-tokens';

// ── UI color palette (settings UI only, not renderer) ──
const uiColors = {
  background: '#1a1a1a',
  backgroundLight: '#222222',
  border: '#444444',
  text: '#ffffff',
  textMuted: '#cccccc',
  primary: '#64b5f6',
  primaryHover: '#42a5f5',
  danger: '#e53935',
  dangerHover: '#c62828',
  warning: '#ffc107',
} as const;

// export { uiColors }; // removed — was only used internally

const typography = {
  fontSize: {
    xs: '0.75rem',
    sm: '0.875rem',
    base: '1rem',
    lg: '1.125rem',
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

const shadows = {
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

const borderRadius = {
  sm: '6px',
  md: '8px',
  lg: '12px',
  full: '50%',
} as const;

const zIndex = {
  modal: 10003,
  settingsButton: 120,
} as const;

// ── UI sizing tokens (settings panel layout) ──
const uiSizing = {
  buttonSize: 44,
  buttonFontSize: 18,
  inputWidth: 86,
  colorSwatch: 36,
  modalWidth: 380,
  modalMaxVW: 92,
  modalMaxWidth: 480,
  modalMaxVH: 82,
  confirmMinWidth: 240,
  checkboxSize: 44,
  borderAlpha: 0.25,
  scrimAlpha: 0.55,
  hoverScrimAlpha: 0.75,
} as const;

// ── Animation durations (settings panel) ──
const animDuration = {
  fast: '0.1s',
  normal: '0.15s',
  slow: '0.18s',
  transitions: {
    button: 'opacity 0.15s, background 0.15s, transform 0.1s',
    action: 'background 0.15s, color 0.15s, border-color 0.15s, transform 0.1s',
    tab: 'color 0.1s, transform 0.1s',
  },
} as const;

// ── UI confirm backdrop alpha ──
const CONFIRM_BACKDROP_ALPHA = 0.5;

// ── Scrollbar (pane overflow) ──
const scrollbar = {
  width: '6px',
  track: 'transparent',
  thumb: 'rgba(255, 255, 255, 0.28)',
  thumbHover: 'rgba(255, 255, 255, 0.45)',
} as const;

// ── Toast notification ──
const TOAST_BG = 'rgba(0, 0, 0, 0.85)';
const TOAST_FONT = `0.75rem/1.4 ${DEFAULT_FONT_FAMILY}`;
const TOAST_PADDING = '6px 14px';

export const SETTINGS_UI_STYLES = `
      .yt-chat-overlay-settings-button {
        position: absolute;
        top: ${spacing.sm}px;
        inset-inline-start: ${spacing.sm}px;
        width: ${uiSizing.buttonSize}px;
        height: ${uiSizing.buttonSize}px;
        border-radius: ${borderRadius.full};
        border: 1px solid rgba(255, 255, 255, ${uiSizing.borderAlpha});
        background: rgba(0, 0, 0, ${uiSizing.scrimAlpha});
        backdrop-filter: blur(4px);
        color: ${uiColors.text};
        font-size: ${uiSizing.buttonFontSize}px;
        line-height: 1;
        cursor: pointer;
        z-index: ${zIndex.settingsButton};
        opacity: 0;
        pointer-events: none;
        transition: ${animDuration.transitions.button};
        &:hover,
        &:focus-visible {
          background: rgba(0, 0, 0, ${uiSizing.hoverScrimAlpha});
          transform: scale(1.1);
        }
        &:focus-visible {
          outline: 2px solid ${uiColors.primary};
          outline-offset: 2px;
          opacity: 1;
          pointer-events: auto;
        }
      }
      #movie_player:hover .yt-chat-overlay-settings-button,
      .html5-video-player:hover .yt-chat-overlay-settings-button {
        opacity: 1;
        pointer-events: auto;
      }
      .yt-chat-overlay-reload-button {
        position: absolute;
        top: ${spacing.sm}px;
        inset-inline-start: ${spacing.sm + uiSizing.buttonSize + spacing.xs}px;
        width: ${uiSizing.buttonSize}px;
        height: ${uiSizing.buttonSize}px;
        border-radius: ${borderRadius.full};
        border: 1px solid rgba(255, 255, 255, ${uiSizing.borderAlpha});
        background: rgba(0, 0, 0, ${uiSizing.scrimAlpha});
        backdrop-filter: blur(4px);
        color: ${uiColors.text};
        font-size: ${uiSizing.buttonFontSize}px;
        line-height: 1;
        cursor: pointer;
        z-index: ${zIndex.settingsButton};
        opacity: 0;
        pointer-events: none;
        transition: ${animDuration.transitions.button};
        &:hover,
        &:focus-visible {
          background: rgba(0, 0, 0, ${uiSizing.hoverScrimAlpha});
          transform: scale(1.1);
        }
        &:focus-visible {
          outline: 2px solid ${uiColors.primary};
          outline-offset: 2px;
        }
      }
      #movie_player:hover .yt-chat-overlay-reload-button,
      .html5-video-player:hover .yt-chat-overlay-reload-button {
        opacity: 1;
        pointer-events: auto;
      }
      .yt-chat-overlay-reload-button--done {
        color: #4ade80;
        border-color: rgba(74, 222, 128, 0.5);
      }
      .yt-chat-overlay-settings-backdrop {
        position: fixed;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        z-index: ${zIndex.modal};
        overscroll-behavior: contain;
        animation: yt-overlay-fade-in ${animDuration.normal} ease-out;
      }
      .yt-chat-overlay-settings-backdrop:has(dialog[open]) {
        background: rgba(0, 0, 0, ${uiSizing.scrimAlpha});
      }
      @keyframes yt-overlay-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes yt-overlay-modal-scale-in {
        from { transform: scale(0.92); opacity: 0; }
        to { transform: scale(1); opacity: 1; }
      }
      .yt-chat-overlay-settings-modal {
        width: clamp(${uiSizing.modalWidth}px, ${uiSizing.modalMaxVW}vw, ${uiSizing.modalMaxWidth}px);
        max-width: min(${uiSizing.modalMaxVW}vw, ${uiSizing.modalMaxWidth}px);
        max-height: ${uiSizing.modalMaxVH}vh;
        overflow: hidden;
        background: ${uiColors.background};
        color: ${uiColors.text};
        border-radius: ${borderRadius.md};
        border: none;
        padding: ${spacing.lg}px;
        display: flex;
        flex-direction: column;
        gap: ${spacing.md}px;
        font-family: ${DEFAULT_FONT_FAMILY};
        box-shadow: ${shadows.box.lg};
        animation: yt-overlay-modal-scale-in ${animDuration.slow} ease-out;
        container-type: inline-size;
      }
      .yt-chat-overlay-settings-modal::backdrop {
        background: rgba(0, 0, 0, ${uiSizing.scrimAlpha});
      }
      /* Container query: narrow modal reduces padding and hides tab labels */
      @container (max-width: 440px) {
        .yt-chat-overlay-settings-modal {
          padding: ${spacing.md}px;
          gap: ${spacing.sm}px;
        }
        .yt-chat-overlay-settings-tab {
          font-size: 0.65rem;
          letter-spacing: 0.02em;
        }
      }
      /* Header */
      .yt-chat-overlay-settings-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-weight: ${typography.fontWeight.bold};
        font-size: ${typography.fontSize.base};
        flex-shrink: 0;
      }
      .yt-chat-overlay-settings-title {
        font-size: ${typography.fontSize.base};
        font-weight: ${typography.fontWeight.bold};
        margin: 0;
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-close {
        border: none;
        background: transparent;
        color: ${uiColors.textMuted};
        font-size: ${typography.fontSize.lg};
        cursor: pointer;
        padding: ${spacing.sm}px;
        line-height: ${typography.lineHeight.tight};
        min-width: ${uiSizing.colorSwatch}px;
        min-height: ${uiSizing.colorSwatch}px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: ${borderRadius.sm};
        &:hover {
          color: ${uiColors.text};
        }
        &:focus-visible {
          outline: 2px solid ${uiColors.primary};
          outline-offset: 2px;
        }
      }
      /* Tab bar */
      .yt-chat-overlay-settings-tabs {
        display: flex;
        border-bottom: 1px solid ${uiColors.border};
        flex-shrink: 0;
      }
      .yt-chat-overlay-settings-tab {
        flex: 1;
        padding: 10px 6px;
        border: none;
        border-bottom: 2px solid transparent;
        background: transparent;
        color: ${uiColors.textMuted};
        font-size: ${typography.fontSize.xs};
        font-weight: ${typography.fontWeight.semibold};
        text-transform: uppercase;
        letter-spacing: 0.05em;
        cursor: pointer;
        margin-block-end: -1px;
        transition: ${animDuration.transitions.tab};
        &:hover {
          color: ${uiColors.text};
        }
        &:focus-visible {
          outline: 2px solid ${uiColors.primary};
          outline-offset: -1px;
        }
        &.active {
          color: ${uiColors.primary};
          border-bottom-color: ${uiColors.primary};
        }
        &:active {
          transform: scale(0.97);
        }
      }
      /* Tab panes */
      .yt-chat-overlay-settings-pane {
        display: flex;
        flex-direction: column;
        gap: ${spacing.md}px;
        overflow-y: auto;
        flex: 1;
        min-height: 0;
        padding-inline-end: 2px;
        scrollbar-width: thin;
        scrollbar-color: ${scrollbar.thumb} ${scrollbar.track};
      }
      .yt-chat-overlay-settings-pane::-webkit-scrollbar {
        width: ${scrollbar.width};
      }
      .yt-chat-overlay-settings-pane::-webkit-scrollbar-track {
        background: ${scrollbar.track};
      }
      .yt-chat-overlay-settings-pane::-webkit-scrollbar-thumb {
        background: ${scrollbar.thumb};
        border-radius: ${scrollbar.width};
      }
      .yt-chat-overlay-settings-pane::-webkit-scrollbar-thumb:hover {
        background: ${scrollbar.thumbHover};
      }
      .yt-chat-overlay-settings-pane[hidden] {
        display: none;
      }
      /* Sections within a pane */
      .yt-chat-overlay-settings-section {
        display: flex;
        flex-direction: column;
        gap: ${spacing.md}px;
      }
      .yt-chat-overlay-settings-section-title {
        font-size: ${typography.fontSize.xs};
        color: ${uiColors.textMuted};
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding-block-end: ${spacing.xs}px;
        border-bottom: 1px solid ${uiColors.border};
        margin: 0;
      }
      /* Row fields */
      .yt-chat-overlay-settings-field {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: ${spacing.md}px;
        font-size: ${typography.fontSize.sm};
        min-width: 0;
      }
      .yt-chat-overlay-settings-field > span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .yt-chat-overlay-settings-field input[type="number"] {
        width: ${uiSizing.inputWidth}px;
        padding: ${spacing.xs}px ${spacing.sm}px;
        border-radius: ${borderRadius.sm};
        border: 1px solid ${uiColors.border};
        background: ${uiColors.backgroundLight};
        color: ${uiColors.text};
        text-align: right;
        -moz-appearance: textfield;
      }
      .yt-chat-overlay-settings-field input[type="number"]::-webkit-inner-spin-button,
      .yt-chat-overlay-settings-field input[type="number"]::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      .yt-chat-overlay-settings-field input[type="text"] {
        width: ${uiSizing.inputWidth}px;
        padding: ${spacing.xs}px ${spacing.sm}px;
        border-radius: ${borderRadius.sm};
        border: 1px solid ${uiColors.border};
        background: ${uiColors.backgroundLight};
        color: ${uiColors.text};
        font-size: ${typography.fontSize.sm};
      }
      .yt-chat-overlay-settings-field input[type="color"] {
        width: ${uiSizing.colorSwatch}px;
        min-height: 44px;
        border: none;
        background: transparent;
        padding: 0;
        cursor: pointer;
      }
      .yt-chat-overlay-settings-field input[type="checkbox"] {
        width: 24px;
        height: 24px;
        cursor: pointer;
        accent-color: ${uiColors.primary};
      }
      .yt-chat-overlay-settings-field input[type="checkbox"]:focus-visible {
        outline: 2px solid ${uiColors.primary};
        outline-offset: 1px;
      }
      .yt-chat-overlay-settings-field select {
        padding: ${spacing.xs}px ${spacing.sm}px;
        border-radius: ${borderRadius.sm};
        border: 1px solid ${uiColors.border};
        background: ${uiColors.backgroundLight};
        color: ${uiColors.text};
        cursor: pointer;
      }
      .yt-chat-overlay-settings-field select:focus-visible {
        outline: 2px solid ${uiColors.primary};
        outline-offset: 1px;
      }
      .yt-chat-overlay-settings-field input[type="number"]:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      /* Enabled toggle */
      .yt-chat-overlay-settings-enabled {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: ${spacing.sm}px ${spacing.md}px;
        background: ${uiColors.backgroundLight};
        border-radius: ${borderRadius.sm};
        font-size: ${typography.fontSize.sm};
        font-weight: ${typography.fontWeight.semibold};
        cursor: pointer;
      }
      .yt-chat-overlay-settings-enabled input[type="checkbox"] {
        width: ${uiSizing.checkboxSize}px;
        height: ${uiSizing.checkboxSize}px;
        cursor: pointer;
        accent-color: ${uiColors.primary};
      }
      /* Authors grid */
      .yt-chat-overlay-author-grid {
        display: grid;
        grid-template-columns: 1fr auto auto;
        gap: ${spacing.sm}px ${spacing.md}px;
        align-items: center;
      }
      .yt-chat-overlay-author-grid-header {
        font-size: ${typography.fontSize.xs};
        color: ${uiColors.textMuted};
        text-align: center;
      }
      .yt-chat-overlay-author-grid-label {
        font-size: ${typography.fontSize.sm};
      }
      .yt-chat-overlay-author-grid-color {
        justify-self: center;
      }
      .yt-chat-overlay-author-grid-checkbox {
        justify-self: center;
      }
      /* Actions bar */
      .yt-chat-overlay-settings-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: ${spacing.sm}px;
        flex-shrink: 0;
        padding-top: ${spacing.sm}px;
        border-top: 1px solid ${uiColors.border};
      }
      .yt-chat-overlay-settings-actions button {
        border: none;
        border-radius: ${borderRadius.sm};
        padding: ${spacing.sm}px ${spacing.md}px;
        cursor: pointer;
        font-weight: ${typography.fontWeight.semibold};
        font-size: ${typography.fontSize.sm};
        transition: ${animDuration.transitions.action};
      }
      .yt-chat-overlay-settings-actions button[data-action="reset"] {
        background: transparent;
        color: ${uiColors.textMuted};
        border: 1px solid ${uiColors.border};
      }
      .yt-chat-overlay-settings-actions button[data-action="reset"]:hover {
        color: ${uiColors.danger};
        border-color: ${uiColors.danger};
      }
      .yt-chat-overlay-settings-actions button[data-action="export"] {
        background: transparent;
        color: ${uiColors.textMuted};
        border: 1px solid ${uiColors.border};
      }
      .yt-chat-overlay-settings-actions button[data-action="export"]:hover {
        color: ${uiColors.text};
        border-color: ${uiColors.primary};
      }
      .yt-chat-overlay-settings-actions button[data-action="import"] {
        background: transparent;
        color: ${uiColors.textMuted};
        border: 1px solid ${uiColors.border};
      }
      .yt-chat-overlay-settings-actions button[data-action="import"]:hover {
        color: ${uiColors.warning};
        border-color: ${uiColors.warning};
      }
      .yt-chat-overlay-settings-actions button:focus-visible {
        outline: 2px solid ${uiColors.primary};
        outline-offset: 1px;
      }
      .yt-chat-overlay-settings-actions button:active {
        transform: scale(0.97);
      }
      .yt-chat-overlay-settings-actions button[data-action="close"] {
        background: ${uiColors.primary};
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-actions button[data-action="close"]:hover {
        background: ${uiColors.primaryHover};
      }
      .yt-chat-overlay-settings-actions button[data-action="close"]:active {
        transform: scale(0.97);
      }

      /* Reset confirmation dialog */
      .yt-chat-overlay-settings-confirm {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1;
        padding: ${spacing.lg}px;
      }
      .yt-chat-overlay-settings-confirm-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, ${CONFIRM_BACKDROP_ALPHA});
        border-radius: ${borderRadius.md};
      }
      .yt-chat-overlay-settings-confirm-message {
        margin: 0 0 ${spacing.md}px;
        font-size: ${typography.fontSize.sm};
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-confirm-buttons {
        display: flex;
        justify-content: flex-end;
        gap: ${spacing.sm}px;
      }
      .yt-chat-overlay-settings-confirm-cancel,
      .yt-chat-overlay-settings-confirm-ok {
        border: none;
        border-radius: ${borderRadius.sm};
        padding: ${spacing.sm}px ${spacing.md}px;
        cursor: pointer;
        font-weight: ${typography.fontWeight.semibold};
        font-size: ${typography.fontSize.sm};
      }
      .yt-chat-overlay-settings-confirm-cancel {
        background: transparent;
        color: ${uiColors.textMuted};
        border: 1px solid ${uiColors.border};
      }
      .yt-chat-overlay-settings-confirm-cancel:hover {
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-confirm-cancel:focus-visible {
        outline: 2px solid ${uiColors.primary};
        outline-offset: 1px;
      }
      .yt-chat-overlay-settings-confirm-ok {
        background: ${uiColors.danger};
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-confirm-ok:hover {
        background: ${uiColors.dangerHover};
      }
      .yt-chat-overlay-settings-confirm-ok:focus-visible {
        outline: 2px solid ${uiColors.primary};
        outline-offset: 1px;
      }
      /* Toast notification */
      .yt-chat-overlay-settings-toast {
        position: absolute;
        bottom: 60px;
        inset-inline-start: 50%;
        transform: translateX(-50%);
        background: ${TOAST_BG};
        color: ${uiColors.text};
        font: ${TOAST_FONT};
        padding: ${TOAST_PADDING};
        border-radius: ${borderRadius.sm};
        z-index: 2;
        pointer-events: none;
        animation: yt-overlay-fade-in ${animDuration.normal} ease-out;
      }
      .yt-chat-overlay-settings-unsupported {
        padding: ${spacing.lg}px;
        margin: ${spacing.md}px 0;
        color: ${uiColors.textMuted};
        font-size: ${typography.fontSize.sm};
        text-align: center;
        line-height: 1.5;
      }
      /* Range slider (dual: slider + number) */
      .yt-chat-overlay-settings-range {
        display: flex;
        align-items: center;
        gap: ${spacing.sm}px;
        padding: 6px 0;
      }
      .yt-chat-overlay-settings-range label {
        flex: 0 1 auto;
        font-size: ${typography.fontSize.sm};
        color: ${uiColors.text};
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .yt-chat-overlay-settings-range-slider {
        flex: 1;
        min-width: 80px;
        height: 4px;
        accent-color: ${uiColors.primary};
        margin: 0;
      }
      .yt-chat-overlay-settings-range-slider:focus-visible {
        outline: 2px solid ${uiColors.primary};
        outline-offset: 2px;
      }
      .yt-chat-overlay-settings-range-number {
        width: ${uiSizing.inputWidth}px;
        flex-shrink: 0;
        text-align: right;
        padding: ${spacing.xs}px ${spacing.sm}px;
        border-radius: ${borderRadius.sm};
        border: 1px solid ${uiColors.border};
        background: ${uiColors.backgroundLight};
        color: ${uiColors.text};
        font-size: ${typography.fontSize.sm};
        -moz-appearance: textfield;
      }
      .yt-chat-overlay-settings-range-number::-webkit-inner-spin-button,
      .yt-chat-overlay-settings-range-number::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      /* Inline validation error */
      .yt-chat-overlay-settings-field-error {
        display: block;
        font-size: ${typography.fontSize.xs};
        color: ${uiColors.danger};
        margin-top: 2px;
      }
      /* Disabled-field helper hint */
      .yt-chat-overlay-settings-field-hint {
        display: block;
        font-size: ${typography.fontSize.xs};
        color: ${uiColors.textMuted};
        margin-top: 2px;
      }

      /* Live region (visually hidden) */
      .yt-live-chat-overlay-live-region {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      /* Sync live region (visually hidden) */
      .yt-chat-overlay-settings-sync-live-region {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      /* Author grid fieldset */
      .yt-chat-overlay-author-grid-fieldset {
        border: none;
        padding: 0;
        margin: 0;
      }
      .yt-chat-overlay-author-grid-legend {
        font-size: ${typography.fontSize.xs};
        color: ${uiColors.textMuted};
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding-bottom: ${spacing.xs}px;
        border-bottom: 1px solid ${uiColors.border};
        margin-block-end: ${spacing.sm}px;
        width: 100%;
      }
      .yt-chat-overlay-author-grid-color-cell,
      .yt-chat-overlay-author-grid-checkbox-cell {
        justify-self: center;
      }

      /* ── prefers-reduced-motion ── */
      @media (prefers-reduced-motion: reduce) {
        .yt-chat-overlay-settings-backdrop,
        .yt-chat-overlay-settings-modal,
        .yt-chat-overlay-settings-toast,
        .yt-chat-overlay-settings-field-error {
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.01ms !important;
        }
        @keyframes yt-overlay-fade-in {
          from { opacity: 1; }
          to { opacity: 1; }
        }
        @keyframes yt-overlay-modal-scale-in {
          from { transform: scale(1); opacity: 1; }
          to { transform: scale(1); opacity: 1; }
        }
      }

      /* ── prefers-color-scheme: light ── */
      @media (prefers-color-scheme: light) {
        .yt-chat-overlay-settings-backdrop:has(dialog[open]) {
          background: rgba(0, 0, 0, 0.4);
        }
        .yt-chat-overlay-settings-modal {
          background: #ffffff;
          color: #1a1a1a;
        }
        .yt-chat-overlay-settings-section-title {
          color: #555555;
          border-bottom-color: #d0d0d0;
        }
        .yt-chat-overlay-settings-field input[type="number"],
        .yt-chat-overlay-settings-field input[type="text"],
        .yt-chat-overlay-settings-range-number {
          background: #f5f5f5;
          border-color: #d0d0d0;
          color: #1a1a1a;
        }
        .yt-chat-overlay-settings-field select {
          background: #f5f5f5;
          border-color: #d0d0d0;
          color: #1a1a1a;
        }
        .yt-chat-overlay-settings-field input[type="checkbox"] {
          accent-color: #1565c0;
        }
        .yt-chat-overlay-settings-enabled {
          background: #f5f5f5;
          color: #1a1a1a;
        }
        .yt-chat-overlay-settings-actions button[data-action="reset"],
        .yt-chat-overlay-settings-actions button[data-action="export"],
        .yt-chat-overlay-settings-actions button[data-action="import"] {
          color: #555555;
          border-color: #d0d0d0;
        }
        .yt-chat-overlay-settings-actions button[data-action="close"] {
          background: #1565c0;
          color: #ffffff;
        }
        .yt-chat-overlay-settings-confirm-dialog {
          background: #ffffff;
          border-color: #d0d0d0;
        }
        .yt-chat-overlay-settings-confirm-message {
          color: #1a1a1a;
        }
        .yt-chat-overlay-settings-confirm-cancel {
          color: #555555;
          border-color: #d0d0d0;
        }
        .yt-chat-overlay-settings-confirm-ok {
          background: #c62828;
          color: #ffffff;
        }
        .yt-chat-overlay-settings-toast {
          background: rgba(255, 255, 255, 0.95);
          color: #1a1a1a;
          border: 1px solid #d0d0d0;
        }
        .yt-chat-overlay-settings-field-hint {
          color: #555555;
        }
        .yt-chat-overlay-settings-field-error {
          color: #c62828;
        }
      }

      /* ── prefers-contrast: more ── */
      @media (prefers-contrast: more) {
        .yt-chat-overlay-settings-modal {
          border-width: 2px;
        }
        .yt-chat-overlay-settings-tabs {
          border-bottom-width: 2px;
        }
        .yt-chat-overlay-settings-tab {
          border-bottom-width: 3px;
        }
        .yt-chat-overlay-settings-tab:focus-visible {
          outline-width: 3px;
          outline-offset: 2px;
        }
        .yt-chat-overlay-settings-close:focus-visible {
          outline-width: 3px;
          outline-offset: 3px;
        }
        .yt-chat-overlay-settings-field input[type="number"],
        .yt-chat-overlay-settings-field input[type="text"],
        .yt-chat-overlay-settings-field select,
        .yt-chat-overlay-settings-range-number {
          border-width: 2px;
        }
        .yt-chat-overlay-settings-field input:focus-visible,
        .yt-chat-overlay-settings-field select:focus-visible {
          outline-width: 3px;
          outline-offset: 2px;
        }
        .yt-chat-overlay-settings-actions button {
          border-width: 2px;
        }
        .yt-chat-overlay-settings-actions button:focus-visible {
          outline-width: 3px;
          outline-offset: 2px;
        }
        .yt-chat-overlay-settings-section-title {
          border-bottom-width: 2px;
        }
        .yt-chat-overlay-settings-button,
        .yt-chat-overlay-reload-button {
          border-width: 2px;
        }
        .yt-chat-overlay-settings-button:focus-visible,
        .yt-chat-overlay-reload-button:focus-visible {
          outline-width: 3px;
          outline-offset: 3px;
        }
      }

      /* ── forced-colors (High Contrast Mode) ── */
      @media (forced-colors: active) {
        .yt-chat-overlay-settings-backdrop:has(dialog[open]) {
          background: Canvas;
        }
        .yt-chat-overlay-settings-modal {
          border: 2px solid CanvasText;
          forced-color-adjust: none;
        }
        .yt-chat-overlay-settings-button,
        .yt-chat-overlay-reload-button {
          background: Canvas;
          color: CanvasText;
          border: 2px solid CanvasText;
          forced-color-adjust: none;
        }
        .yt-chat-overlay-settings-button:focus-visible,
        .yt-chat-overlay-reload-button:focus-visible {
          outline: 3px solid Highlight;
        }
        .yt-chat-overlay-settings-tab {
          color: CanvasText;
          border-bottom: 2px solid transparent;
        }
        .yt-chat-overlay-settings-tab.active {
          color: Highlight;
          border-bottom-color: Highlight;
        }
        .yt-chat-overlay-settings-tab:focus-visible {
          outline: 3px solid Highlight;
        }
        .yt-chat-overlay-settings-close:focus-visible {
          outline: 3px solid Highlight;
        }
        .yt-chat-overlay-settings-actions button:focus-visible {
          outline: 3px solid Highlight;
        }
        .yt-chat-overlay-settings-actions button[data-action="close"] {
          background: Highlight;
          color: HighlightText;
        }
        .yt-chat-overlay-settings-confirm-dialog {
          border: 2px solid CanvasText;
          forced-color-adjust: none;
        }
        .yt-chat-overlay-settings-confirm-ok {
          background: Highlight;
          color: HighlightText;
        }
        .yt-chat-overlay-settings-toast {
          border: 1px solid CanvasText;
          forced-color-adjust: none;
        }
      }
`;
