// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { spacing } from '@core/design-tokens';
import {
  borderRadius,
  CONFIRM_BACKDROP_ALPHA,
  shadows,
  TOAST_BG,
  TOAST_FONT,
  TOAST_PADDING,
  typography,
  uiColors,
  zIndex,
} from '@core/settings-ui-tokens';

// ── UI sizing tokens (settings-specific, not shared with renderer) ──
const S = {
  buttonSize: 36,
  buttonFontSize: 18,
  buttonZ: 120,
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

export const SETTINGS_UI_STYLES = `
      .yt-chat-overlay-settings-button {
        position: absolute;
        top: ${spacing.sm}px;
        left: ${spacing.sm}px;
        width: ${S.buttonSize}px;
        height: ${S.buttonSize}px;
        border-radius: ${borderRadius.full};
        border: 1px solid rgba(255, 255, 255, ${S.borderAlpha});
        background: rgba(0, 0, 0, ${S.scrimAlpha});
        backdrop-filter: blur(4px);
        color: ${uiColors.text};
        font-size: ${S.buttonFontSize}px;
        line-height: 1;
        cursor: pointer;
        z-index: ${S.buttonZ};
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s, background 0.15s, transform 0.1s;
      }
      .yt-chat-overlay-settings-button:hover,
      .yt-chat-overlay-settings-button:focus-visible {
        background: rgba(0, 0, 0, ${S.hoverScrimAlpha});
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
      .yt-chat-overlay-settings-backdrop {
        position: fixed;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, ${S.scrimAlpha});
        z-index: ${zIndex.modal};
        animation: yt-overlay-fade-in 0.15s ease-out;
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
        width: ${S.modalWidth}px;
        max-width: min(${S.modalMaxVW}vw, ${S.modalMaxWidth}px);
        max-height: ${S.modalMaxVH}vh;
        overflow: hidden;
        background: ${uiColors.background};
        color: ${uiColors.text};
        border-radius: ${borderRadius.md};
        padding: ${spacing.lg}px;
        display: flex;
        flex-direction: column;
        gap: ${spacing.md}px;
        font-family: system-ui, -apple-system, sans-serif;
        box-shadow: ${shadows.box.lg};
        animation: yt-overlay-modal-scale-in 0.18s ease-out;
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
        line-height: 1;
        min-width: ${S.colorSwatch}px;
        min-height: ${S.colorSwatch}px;
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
        transition: color 0.1s;
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
        padding-right: 2px;
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
        padding-bottom: 4px;
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
        width: ${S.inputWidth}px;
        padding: ${spacing.xs}px ${spacing.sm}px;
        border-radius: ${borderRadius.sm};
        border: 1px solid ${uiColors.border};
        background: ${uiColors.backgroundLight};
        color: ${uiColors.text};
        text-align: right;
      }
      .yt-chat-overlay-settings-field input[type="color"] {
        width: ${S.colorSwatch}px;
        height: 26px;
        border: none;
        background: transparent;
        padding: 0;
        cursor: pointer;
      }
      .yt-chat-overlay-settings-field input[type="checkbox"] {
        width: ${S.checkboxSize}px;
        height: ${S.checkboxSize}px;
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
        width: ${S.checkboxSize}px;
        height: ${S.checkboxSize}px;
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
        transition: background 0.15s, color 0.15s, border-color 0.15s;
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
      .yt-chat-overlay-settings-actions button[data-action="import"] {
        border-left: 2px solid rgba(255, 193, 7, 0.4);
      }
      .yt-chat-overlay-settings-actions button[data-action="import"]:hover {
        background: rgba(255, 193, 7, 0.15);
        color: #ffc107;
        border-color: rgba(255, 193, 7, 0.3);
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
        min-width: ${S.confirmMinWidth}px;
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
        animation: yt-overlay-fade-in 0.15s ease-out;
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
        gap: 8px;
        padding: 6px 0;
        justify-content: space-between;
      }
      .yt-chat-overlay-settings-range label {
        flex: 1;
        font-size: 13px;
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-range-slider {
        flex: 2;
        height: 4px;
        accent-color: ${uiColors.primary};
        margin: 0;
      }
      .yt-chat-overlay-settings-range-slider:focus-visible {
        outline: 2px solid ${uiColors.primary};
        outline-offset: 2px;
      }
      .yt-chat-overlay-settings-range-number {
        width: ${S.inputWidth}px;
        text-align: right;
      }
      /* Inline validation error */
      .yt-chat-overlay-settings-field-error {
        display: block;
        font-size: 11px;
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
        font-size: 11px;
        color: ${uiColors.textMuted};
        margin-top: 2px;
      }
`;
