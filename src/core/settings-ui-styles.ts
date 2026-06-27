// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

// ── UI color palette (settings UI only, not renderer) ──
const _uiColors = {
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

export { _uiColors as uiColors };

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
export const CONFIRM_BACKDROP_ALPHA = 0.5;

// ── Scrollbar (pane overflow) ──
const scrollbar = {
  width: '6px',
  track: 'transparent',
  thumb: 'rgba(255, 255, 255, 0.28)',
  thumbHover: 'rgba(255, 255, 255, 0.45)',
} as const;

// ── Toast notification (inlined into SETTINGS_UI_STYLES) ──

export const SETTINGS_UI_STYLES = `
      .yt-chat-overlay-settings-button {
        position: absolute;
        top: 8px;
        inset-inline-start: 8px;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.25);
        background: rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(4px);
        color: #ffffff;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
        z-index: 120;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s, background 0.15s, transform 0.1s;
      }
      .yt-chat-overlay-settings-button:hover,
      .yt-chat-overlay-settings-button:focus-visible {
        background: rgba(0, 0, 0, 0.75);
        transform: scale(1.1);
      }
      .yt-chat-overlay-settings-button:focus-visible {
        outline: 2px solid #64b5f6;
        outline-offset: 2px;
        opacity: 1;
        pointer-events: auto;
      }
      #movie_player:hover .yt-chat-overlay-settings-button,
      .html5-video-player:hover .yt-chat-overlay-settings-button {
        opacity: 1;
        pointer-events: auto;
      }
      .yt-chat-overlay-reload-button {
        position: absolute;
        top: 8px;
        inset-inline-start: 56px;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.25);
        background: rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(4px);
        color: #ffffff;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
        z-index: 120;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s, background 0.15s, transform 0.1s;
      }
      .yt-chat-overlay-reload-button:hover,
      .yt-chat-overlay-reload-button:focus-visible {
        background: rgba(0, 0, 0, 0.75);
        transform: scale(1.1);
      }
      .yt-chat-overlay-reload-button:focus-visible {
        outline: 2px solid #64b5f6;
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
        z-index: 10003;
        overscroll-behavior: contain;
        animation: yt-overlay-fade-in 0.15s ease-out;
      }
      .yt-chat-overlay-settings-backdrop[data-visible="true"] {
        background: rgba(0, 0, 0, 0.55);
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
        width: min(380px, 92vw);
        max-width: min(92vw, 480px);
        max-height: 82vh;
        overflow: hidden;
        background: #1a1a1a;
        color: #ffffff;
        border-radius: 8px;
        border: none;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        font-family: system-ui, -apple-system, sans-serif;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.9);
        animation: yt-overlay-modal-scale-in 0.18s ease-out;
      }
      .yt-chat-overlay-settings-modal::backdrop {
        background: rgba(0, 0, 0, 0.55);
      }
      /* Header */
      .yt-chat-overlay-settings-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-weight: 700;
        font-size: 1rem;
        flex-shrink: 0;
      }
      .yt-chat-overlay-settings-title {
        font-size: 1rem;
        font-weight: 700;
        margin: 0;
        color: #ffffff;
      }
      .yt-chat-overlay-settings-close {
        border: none;
        background: #e53935;
        color: #ffffff;
        font-size: 1.125rem;
        cursor: pointer;
        padding: 8px;
        line-height: 1;
        min-width: 36px;
        min-height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
      }
      .yt-chat-overlay-settings-close:hover {
        background: #c62828;
        color: #ffffff;
      }
      .yt-chat-overlay-settings-close:focus-visible {
        outline: 2px solid #64b5f6;
        outline-offset: 2px;
      }
      /* Tab bar */
      .yt-chat-overlay-settings-tabs {
        display: flex;
        border-bottom: 1px solid #444444;
        flex-shrink: 0;
      }
      .yt-chat-overlay-settings-tab {
        flex: 1;
        padding: 12px 8px;
        border: none;
        border-bottom: 2px solid transparent;
        background: transparent;
        color: #cccccc;
        font-size: 0.875rem;
        line-height: normal;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        cursor: pointer;
        margin-block-end: -1px;
        transition: color 0.1s, transform 0.1s;
      }
      .yt-chat-overlay-settings-tab:hover {
        color: #ffffff;
      }
      .yt-chat-overlay-settings-tab:focus-visible {
        outline: 2px solid #64b5f6;
        outline-offset: -1px;
      }
      .yt-chat-overlay-settings-tab.active {
        color: #64b5f6;
        border-bottom-color: #64b5f6;
      }
      .yt-chat-overlay-settings-tab:active {
        transform: scale(0.97);
      }
      /* Tab panes */
      .yt-chat-overlay-settings-pane {
        display: flex;
        flex-direction: column;
        gap: 12px;
        overflow-y: auto;
        flex: 1;
        min-height: 0;
        padding-inline-end: 8px;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.28) transparent;
      }
      .yt-chat-overlay-settings-pane::-webkit-scrollbar {
        width: 6px;
      }
      .yt-chat-overlay-settings-pane::-webkit-scrollbar-track {
        background: transparent;
      }
      .yt-chat-overlay-settings-pane::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.28);
        border-radius: 6px;
      }
      .yt-chat-overlay-settings-pane::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.45);
      }
      .yt-chat-overlay-settings-pane[hidden] {
        display: none;
      }
      /* Sections within a pane */
      .yt-chat-overlay-settings-section {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .yt-chat-overlay-settings-section-title {
        font-size: 0.75rem;
        color: #cccccc;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding-block-end: 4px;
        border-bottom: 1px solid #444444;
        margin: 0;
        font-weight: 600;
      }
      .yt-chat-overlay-settings-field > span[title] {
        cursor: help;
        border-bottom: 1px dotted #444444;
      }
      /* Checkbox & radio: ensure 44px minimum touch target (WCAG 2.5.8) */
      .yt-chat-overlay-settings-field {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        font-size: 0.875rem;
        min-width: 0;
        min-height: 44px;
        padding: 4px 0;
      }
      .yt-chat-overlay-settings-field > span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .yt-chat-overlay-settings-field input[type="number"] {
        width: auto;
        min-width: 60px;
        max-width: 90px;
        flex: 0 1 70px;
        padding: 4px 8px;
        border-radius: 6px;
        border: 1px solid #444444;
        background: #222222;
        color: #ffffff;
        text-align: right;
        -moz-appearance: textfield;
      }
      .yt-chat-overlay-settings-field input[type="number"]::-webkit-inner-spin-button,
      .yt-chat-overlay-settings-field input[type="number"]::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      .yt-chat-overlay-settings-field input[type="text"] {
        width: 86px;
        padding: 4px 8px;
        border-radius: 6px;
        border: 1px solid #444444;
        background: #222222;
        color: #ffffff;
        font-size: 0.875rem;
      }
      .yt-chat-overlay-author-grid-color {
        width: 36px;
        height: 36px;
        min-width: 36px;
        min-height: 36px;
        max-width: 36px;
        max-height: 36px;
        border: none;
        background: transparent;
        padding: 0;
        cursor: pointer;
        appearance: none;
        -webkit-appearance: none;
      }
      .yt-chat-overlay-author-grid-color::-webkit-color-swatch-wrapper {
        padding: 0;
      }
      .yt-chat-overlay-author-grid-color::-webkit-color-swatch {
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 6px;
      }
      .yt-chat-overlay-settings-field input[type="checkbox"] {
        width: 24px;
        height: 24px;
        cursor: pointer;
        accent-color: #64b5f6;
      }
      .yt-chat-overlay-settings-field input[type="checkbox"]:focus-visible {
        outline: 2px solid #64b5f6;
        outline-offset: 1px;
      }
      .yt-chat-overlay-settings-field select {
        padding: 4px 8px;
        border-radius: 6px;
        border: 1px solid #444444;
        background: #222222;
        color: #ffffff;
        cursor: pointer;
      }
      .yt-chat-overlay-settings-field select:focus-visible {
        outline: 2px solid #64b5f6;
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
        padding: 8px 12px;
        background: #222222;
        border-radius: 6px;
        font-size: 0.875rem;
        font-weight: 600;
        cursor: pointer;
      }
      .yt-chat-overlay-settings-enabled input[type="checkbox"] {
        width: 44px;
        height: 44px;
        cursor: pointer;
        accent-color: #64b5f6;
      }
      /* Author grid */
      .yt-chat-overlay-author-grid {
        display: grid;
        grid-template-columns: 1fr 40px 36px;
        gap: 8px 12px;
        align-items: center;
      }
      .yt-chat-overlay-author-grid-header {
        font-size: 0.75rem;
        color: #cccccc;
        text-align: center;
      }
      .yt-chat-overlay-author-grid-label {
        font-size: 0.875rem;
      }
      .yt-chat-overlay-author-grid-color-cell {
        justify-self: center;
        width: 40px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .yt-chat-overlay-author-grid-checkbox-cell {
        justify-self: center;
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .yt-chat-overlay-author-grid-checkbox-cell > input[type="checkbox"] {
        width: 20px;
        height: 20px;
        min-width: 20px;
        cursor: pointer;
        accent-color: #64b5f6;
      }
      /* Actions bar */
      .yt-chat-overlay-settings-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
        flex-shrink: 0;
        padding-top: 8px;
        border-top: 1px solid #444444;
      }
      .yt-chat-overlay-settings-actions button {
        border: none;
        border-radius: 6px;
        padding: 8px 12px;
        cursor: pointer;
        font-weight: 600;
        font-size: 0.875rem;
        transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.1s;
      }
      .yt-chat-overlay-settings-actions button[data-action="reset"] {
        background: #e53935;
        color: #fff;
        border: 1px solid #e53935;
      }
      .yt-chat-overlay-settings-actions button[data-action="reset"]:hover {
        background: #c62828;
        border-color: #c62828;
      }
      .yt-chat-overlay-settings-actions button[data-action="export"] {
        background: transparent;
        color: #cccccc;
        border: 1px solid #444444;
      }
      .yt-chat-overlay-settings-actions button[data-action="export"]:hover {
        color: #ffffff;
        border-color: #64b5f6;
      }
      .yt-chat-overlay-settings-actions button[data-action="import"] {
        background: transparent;
        color: #cccccc;
        border: 1px solid #444444;
      }
      .yt-chat-overlay-settings-actions button[data-action="import"]:hover {
        color: #ffc107;
        border-color: #ffc107;
      }
      .yt-chat-overlay-settings-actions button:focus-visible {
        outline: 2px solid #64b5f6;
        outline-offset: 1px;
      }
      .yt-chat-overlay-settings-actions button:active {
        transform: scale(0.97);
      }
      .yt-chat-overlay-settings-actions button[data-action="close"] {
        background: #64b5f6;
        color: #ffffff;
      }
      .yt-chat-overlay-settings-actions button[data-action="close"]:hover {
        background: #42a5f5;
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
        padding: 16px;
      }
      .yt-chat-overlay-settings-confirm-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        border-radius: 8px;
      }
      .yt-chat-overlay-settings-confirm-message {
        margin: 0 0 12px;
        font-size: 0.875rem;
        color: #ffffff;
      }
      .yt-chat-overlay-settings-confirm-buttons {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .yt-chat-overlay-settings-confirm-cancel,
      .yt-chat-overlay-settings-confirm-ok {
        border: none;
        border-radius: 6px;
        padding: 8px 12px;
        cursor: pointer;
        font-weight: 600;
        font-size: 0.875rem;
      }
      .yt-chat-overlay-settings-confirm-cancel {
        background: transparent;
        color: #cccccc;
        border: 1px solid #444444;
      }
      .yt-chat-overlay-settings-confirm-cancel:hover {
        color: #ffffff;
      }
      .yt-chat-overlay-settings-confirm-cancel:focus-visible {
        outline: 2px solid #64b5f6;
        outline-offset: 1px;
      }
      .yt-chat-overlay-settings-confirm-ok {
        background: #e53935;
        color: #ffffff;
      }
      .yt-chat-overlay-settings-confirm-ok:hover {
        background: #c62828;
      }
      .yt-chat-overlay-settings-confirm-ok:focus-visible {
        outline: 2px solid #64b5f6;
        outline-offset: 1px;
      }
      /* Toast notification */
      .yt-chat-overlay-settings-toast {
        position: absolute;
        bottom: 60px;
        inset-inline-start: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.85);
        color: #ffffff;
        font: 0.75rem/1.4 system-ui, -apple-system, sans-serif;
        padding: 6px 14px;
        border-radius: 6px;
        z-index: 2;
        pointer-events: none;
        animation: yt-overlay-fade-in 0.15s ease-out;
      }
      .yt-chat-overlay-settings-unsupported {
        padding: 16px;
        margin: 12px 0;
        color: #cccccc;
        font-size: 0.875rem;
        text-align: center;
        line-height: 1.5;
      }
      /* Range slider (dual: slider + number) */
      .yt-chat-overlay-settings-range {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 6px 0;
      }
      .yt-chat-overlay-settings-range label {
        flex: 0 1 auto;
        font-size: 0.875rem;
        color: #ffffff;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .yt-chat-overlay-settings-range-slider {
        flex: 1;
        min-width: 80px;
        max-width: 280px;
        height: 4px;
        accent-color: #64b5f6;
        margin: 0;
      }
      .yt-chat-overlay-settings-range-slider:focus-visible {
        outline: 2px solid #64b5f6;
        outline-offset: 2px;
      }
      .yt-chat-overlay-settings-range-number {
        width: 72px;
        flex-shrink: 0;
        text-align: right;
        padding: 4px 8px;
        border-radius: 6px;
        border: 1px solid #444444;
        background: #222222;
        color: #ffffff;
        font-size: 0.875rem;
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
        font-size: 0.75rem;
        color: #e53935;
        margin-top: 2px;
      }
      /* Disabled-field helper hint */
      .yt-chat-overlay-settings-field-hint {
        display: block;
        font-size: 0.75rem;
        color: #cccccc;
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
        font-size: 0.75rem;
        color: #cccccc;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding-bottom: 4px;
        border-bottom: 1px solid #444444;
        margin-block-end: 8px;
        width: 100%;
      }
      .yt-chat-overlay-author-grid-color-cell {
        justify-self: center;
        width: 32px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .yt-chat-overlay-author-grid-checkbox-cell {
        justify-self: center;
        width: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      /* ── prefers-reduced-motion ── */
      @media (prefers-reduced-motion: reduce) {
        .yt-chat-overlay-settings-backdrop,
        .yt-chat-overlay-settings-modal,
        .yt-chat-overlay-settings-toast,
        .yt-chat-overlay-settings-field-error {
          animation-duration: 0.01ms;
          animation-iteration-count: 1;
          transition-duration: 0.01ms;
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
        .yt-chat-overlay-settings-backdrop[data-visible="true"] {
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
        .yt-chat-overlay-settings-backdrop[data-visible="true"] {
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

      /* ── Mobile responsive (max-width: 480px) ── */
      @media (max-width: 480px) {
        .yt-chat-overlay-settings-modal {
          width: 100vw;
          max-width: 100vw;
          max-height: 100vh;
          min-height: auto;
          border-radius: 0;
          padding: 12px;
          margin: auto 0 0;
        }
        .yt-chat-overlay-settings-tabs {
          flex-wrap: wrap;
        }
        .yt-chat-overlay-settings-tab {
          flex: 1 1 50%;
          padding: 8px 4px;
          font-size: 0.6rem;
        }
        .yt-chat-overlay-settings-range {
          flex-direction: column;
          align-items: stretch;
          gap: 4px;
        }
        .yt-chat-overlay-settings-range-slider {
          max-width: 100%;
        }
        .yt-chat-overlay-settings-range-number {
          width: 100%;
          text-align: center;
        }
        .yt-chat-overlay-author-grid {
          grid-template-columns: 1fr 36px 32px;
          gap: 8px 10px;
        }
        .yt-chat-overlay-settings-field input[type="number"],
        .yt-chat-overlay-settings-field input[type="text"] {
          width: 60px;
          min-width: 50px;
        }
      }
`;

// ── Re-exported tokens for use in other modules ──
export { animDuration, borderRadius, scrollbar, shadows, typography, uiSizing, zIndex };
