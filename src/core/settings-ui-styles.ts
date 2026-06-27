// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { DEFAULT_FONT_FAMILY, spacing } from '@core/design-tokens';

// ── UI color palette (settings UI only, not renderer) ──
const uiColors = {
  background: '#1a1a1a',
  backgroundLight: '#222222',
  border: '#5a5a5a',
  text: '#ffffff',
  textMuted: '#b0b0b0',
  primary: '#1e88e5',
  primaryHover: '#1976d2',
  danger: '#e53935',
  dangerHover: '#c62828',
  warning: '#ffc107',
} as const;

// export { uiColors }; // removed — was only used internally

const typography = {
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
const animDuration = {
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
const CONFIRM_BACKDROP_ALPHA = 0.5;

// ── Scrollbar (pane overflow) ──
const scrollbar = {
  width: '6px',
  track: 'transparent',
  thumb: 'rgba(255, 255, 255, 0.12)',
  thumbHover: 'rgba(255, 255, 255, 0.28)',
} as const;

// ── Toast notification ──
const TOAST_BG = 'rgba(0, 0, 0, 0.85)';
const TOAST_FONT = `12px/1.4 ${DEFAULT_FONT_FAMILY}`;
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
      }
      .yt-chat-overlay-settings-button:hover,
      .yt-chat-overlay-settings-button:focus-visible {
        background: rgba(0, 0, 0, ${uiSizing.hoverScrimAlpha});
        transform: scale(1.1);
      }
      .yt-chat-overlay-settings-button:focus-visible {
        outline: 2px solid ${uiColors.primary};
        outline-offset: 2px;
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
      }
      .yt-chat-overlay-reload-button:hover,
      .yt-chat-overlay-reload-button:focus-visible {
        background: rgba(0, 0, 0, ${uiSizing.hoverScrimAlpha});
        transform: scale(1.1);
      }
      .yt-chat-overlay-reload-button:focus-visible {
        outline: 2px solid ${uiColors.primary};
        outline-offset: 2px;
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
        background: rgba(0, 0, 0, ${uiSizing.scrimAlpha});
        z-index: ${zIndex.modal};
        overscroll-behavior: contain;
        animation: yt-overlay-fade-in ${animDuration.normal} ease-out;
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
        width: min(${uiSizing.modalWidth}px, ${uiSizing.modalMaxVW}vw);
        max-width: min(${uiSizing.modalMaxVW}vw, ${uiSizing.modalMaxWidth}px);
        max-height: ${uiSizing.modalMaxVH}vh;
        overflow: hidden;
        background: ${uiColors.background};
        color: ${uiColors.text};
        border-radius: ${borderRadius.md};
        padding: ${spacing.lg}px;
        display: flex;
        flex-direction: column;
        gap: ${spacing.md}px;
        font-family: ${DEFAULT_FONT_FAMILY};
        box-shadow: ${shadows.box.lg};
        animation: yt-overlay-modal-scale-in ${animDuration.slow} ease-out;
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
      }
      .yt-chat-overlay-settings-close:hover {
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-close:focus-visible {
        outline: 2px solid ${uiColors.primary};
        outline-offset: 2px;
      }
      /* Tab bar */
      .yt-chat-overlay-settings-tabs {
        display: flex;
        border-bottom: 1px solid ${uiColors.border};
        flex-shrink: 0;
      }
      .yt-chat-overlay-settings-tab {
        flex: 1;
        padding: ${spacing.sm}px ${spacing.xs}px;
        border: none;
        border-bottom: 2px solid transparent;
        background: transparent;
        color: ${uiColors.textMuted};
        font-size: ${typography.fontSize.xs};
        font-weight: ${typography.fontWeight.semibold};
        text-transform: uppercase;
        letter-spacing: 0.05em;
        cursor: pointer;
        margin-bottom: -1px;
        transition: ${animDuration.transitions.tab};
      }
      .yt-chat-overlay-settings-tab:hover {
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-tab:focus-visible {
        outline: 2px solid ${uiColors.primary};
        outline-offset: -1px;
      }
      .yt-chat-overlay-settings-tab.active {
        color: ${uiColors.primary};
        border-bottom-color: ${uiColors.primary};
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
        padding-bottom: ${spacing.xs}px;
        border-bottom: 1px solid ${uiColors.border};
      }
      /* Row fields */
      .yt-chat-overlay-settings-field {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: ${spacing.md}px;
        font-size: ${typography.fontSize.sm};
      }
      .yt-chat-overlay-settings-field input[type="number"] {
        width: ${uiSizing.inputWidth}px;
        padding: ${spacing.xs}px ${spacing.sm}px;
        border-radius: ${borderRadius.sm};
        border: 1px solid ${uiColors.border};
        background: ${uiColors.backgroundLight};
        color: ${uiColors.text};
        text-align: end;
        -moz-appearance: textfield;
      }
      .yt-chat-overlay-settings-field input[type="number"]::-webkit-inner-spin-button,
      .yt-chat-overlay-settings-field input[type="number"]::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      .yt-chat-overlay-settings-field input[type="text"] {
        flex: 1;
        padding: ${spacing.xs}px ${spacing.sm}px;
        border-radius: ${borderRadius.sm};
        border: 1px solid ${uiColors.border};
        background: ${uiColors.backgroundLight};
        color: ${uiColors.text};
        font-size: ${typography.fontSize.sm};
      }
      .yt-chat-overlay-settings-field input[type="color"] {
        width: ${uiSizing.colorSwatch}px;
        height: 26px;
        border: none;
        background: transparent;
        padding: 0;
        cursor: pointer;
      }
      .yt-chat-overlay-settings-field input[type="checkbox"] {
        width: ${uiSizing.checkboxSize}px;
        height: ${uiSizing.checkboxSize}px;
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
        unicode-bidi: isolate;
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
      .yt-chat-overlay-settings-actions button[data-action="close"] {
        background: ${uiColors.primary};
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-actions button[data-action="close"]:hover {
        background: ${uiColors.primaryHover};
      }

      /* Reset confirmation dialog */
      .yt-chat-overlay-settings-confirm {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1;
      }
      .yt-chat-overlay-settings-confirm-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, ${CONFIRM_BACKDROP_ALPHA});
        border-radius: ${borderRadius.md};
      }
      .yt-chat-overlay-settings-confirm-dialog {
        position: relative;
        background: ${uiColors.backgroundLight};
        border: 1px solid ${uiColors.border};
        border-radius: ${borderRadius.md};
        padding: ${spacing.lg}px;
        min-width: ${uiSizing.confirmMinWidth}px;
        box-shadow: ${shadows.box.lg};
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
      .yt-chat-overlay-settings-confirm-ok {
        background: ${uiColors.danger};
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-confirm-ok:hover {
        background: ${uiColors.dangerHover};
      }
      /* Toast notification */
      .yt-chat-overlay-settings-toast {
        position: absolute;
        bottom: 60px;
        left: 50%;
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
        justify-content: space-between;
      }
      .yt-chat-overlay-settings-range label {
        flex: 1;
        font-size: ${typography.fontSize.sm};
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-range-slider {
        flex: 2;
        height: ${spacing.xs}px;
        accent-color: ${uiColors.primary};
        margin: 0;
      }
      .yt-chat-overlay-settings-range-slider:focus-visible {
        outline: 2px solid ${uiColors.primary};
        outline-offset: 2px;
      }
      .yt-chat-overlay-settings-range-number {
        width: ${uiSizing.inputWidth}px;
        text-align: end;
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
        animation: yt-overlay-error-fade 3s ease-out forwards;
      }
      @keyframes yt-overlay-error-fade {
        0%, 70% { opacity: 1; }
        100% { opacity: 0; }
      }
      /* Disabled-field helper hint */
      .yt-chat-overlay-settings-field-hint {
        display: block;
        font-size: ${typography.fontSize.xs};
        color: ${uiColors.textMuted};
        margin-top: 2px;
      }

      /* ── Accessibility: reduced motion ── */
      @media (prefers-reduced-motion: reduce) {
        .yt-chat-overlay-settings-backdrop,
        .yt-chat-overlay-settings-modal,
        .yt-chat-overlay-settings-toast,
        .yt-chat-overlay-settings-field-error,
        .yt-chat-overlay-settings-button,
        .yt-chat-overlay-reload-button,
        .yt-chat-overlay-settings-close,
        .yt-chat-overlay-settings-actions button,
        .yt-chat-overlay-settings-tab {
          animation: none !important;
          transition: none !important;
        }
      }

      /* ── Accessibility: forced colors (Windows High Contrast) ── */
      @media (forced-colors: active) {
        .yt-chat-overlay-settings-tabs,
        .yt-chat-overlay-settings-section-title,
        .yt-chat-overlay-settings-actions button[data-action="reset"],
        .yt-chat-overlay-settings-actions button[data-action="export"],
        .yt-chat-overlay-settings-actions button[data-action="import"],
        .yt-chat-overlay-settings-confirm-dialog,
        .yt-chat-overlay-settings-confirm-cancel {
          border-color: CanvasText;
        }
        .yt-chat-overlay-settings-button,
        .yt-chat-overlay-reload-button,
        .yt-chat-overlay-settings-close,
        .yt-chat-overlay-settings-actions button,
        .yt-chat-overlay-settings-tab,
        .yt-chat-overlay-settings-field input,
        .yt-chat-overlay-settings-field select,
        .yt-chat-overlay-settings-range-number,
        .yt-chat-overlay-settings-confirm-cancel,
        .yt-chat-overlay-settings-confirm-ok {
          forced-color-adjust: none;
        }
        .yt-chat-overlay-settings-button:focus-visible,
        .yt-chat-overlay-reload-button:focus-visible,
        .yt-chat-overlay-settings-close:focus-visible,
        .yt-chat-overlay-settings-actions button:focus-visible,
        .yt-chat-overlay-settings-tab:focus-visible {
          outline-color: Highlight;
        }
        .yt-chat-overlay-settings-tab.active {
          border-bottom-color: Highlight;
          color: Highlight;
        }
        .yt-chat-overlay-settings-actions button[data-action="close"] {
          background: Highlight;
          color: HighlightText;
        }
      }
`;
