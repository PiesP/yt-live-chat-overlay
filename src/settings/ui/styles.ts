// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { SETTINGS_UI_DESIGN } from '@settings/ui/design-adapter';
import { DEFAULT_FONT_FAMILY, spacing } from '@util/design-tokens';

/**
 * Settings UI styles — plain CSS string injected into the page.
 *
 * CSP NOTE: The CSS is injected via `style.textContent` (see
 * `settings-ui.ts`). This works in userscript contexts (GM adds the
 * `style-src: 'unsafe-inline'` for content scripts) but may fail under
 * strict CSP in MV3 extension content scripts that don't allow inline
 * styles. A future improvement could use the CSSOM
 * (CSSStyleSheet.insertRule) or a background-script messaging bridge
 * to inject styles without violating CSP.
 *
 * STATE MANAGEMENT — CSS `:has()` policy (2026 update):
 *
 *   `:has()` is Baseline 2023, fully supported in all modern browsers
 *   (Chrome 105+, Firefox 121+, Safari 15.4+). The project uses it in
 *   4 places for contextual layout selectors (see lines 465, 468, 785, 786).
 *
 *   Guidelines for choosing between class-based state and `:has()`:
 *
 *   1. Prefer class-based toggle (`classList.toggle('active')`) for
 *      critical UI state (active, focused, open). Classes are O(1) to
 *      toggle, don't require sibling/ancestor traversal on every mutation,
 *      and are programmatically accessible (other components can do
 *      `element.classList.contains('active')` without querying stylesheets).
 *      This matters for the focus trap, tab switching, and confirm dialog
 *      logic in settings-ui.ts.
 *
 *   2. Use `:has()` for layout relationships (e.g. gridcell styling based
 *      on child element presence), hover effects, and contextual styling
 *      where a class-based approach would require extra JS coordination.
 *
 *   3. Always scope `:has()` selectors with the `.yt-chat-overlay-*`
 *      namespace prefix to avoid accidentally matching host page elements —
 *      content scripts run in the MAIN world and share CSS scope with the page.
 *
 *   CONTAINER QUERY NOTE: container queries (`@container`) remain risky in
 *   injected YouTube modals because YouTube's DOM can interfere with
 *   containment contexts. Prefer `@media` queries for responsive breakpoints
 *   in the settings UI unless the container query targets an element wholly
 *   under our control (i.e. not injected into YouTube's modal DOM).
 */

// ── Quiet Instruments adapter (settings UI only, not renderer) ──
const uiColors = {
  background: SETTINGS_UI_DESIGN.colors.surface,
  backgroundLight: SETTINGS_UI_DESIGN.colors.raised,
  border: SETTINGS_UI_DESIGN.colors.border,
  text: SETTINGS_UI_DESIGN.colors.text,
  textMuted: SETTINGS_UI_DESIGN.colors.textMuted,
  accent: SETTINGS_UI_DESIGN.colors.accent,
  accentHover: `color-mix(in srgb, ${SETTINGS_UI_DESIGN.colors.accent} 84%, black)`,
  onAccent: SETTINGS_UI_DESIGN.colors.onAccent,
  focus: SETTINGS_UI_DESIGN.colors.focus,
  danger: SETTINGS_UI_DESIGN.colors.danger,
  dangerFill: `color-mix(in srgb, ${SETTINGS_UI_DESIGN.colors.danger} 55%, black)`,
  dangerFillHover: `color-mix(in srgb, ${SETTINGS_UI_DESIGN.colors.danger} 65%, black)`,
  warning: SETTINGS_UI_DESIGN.colors.warning,
  success: SETTINGS_UI_DESIGN.colors.success,
  info: SETTINGS_UI_DESIGN.colors.info,
} as const;

const uiColorsAlpha = {
  accentBg: `color-mix(in srgb, ${SETTINGS_UI_DESIGN.colors.accent} 25%, transparent)`,
  accentBgLight: `color-mix(in srgb, ${SETTINGS_UI_DESIGN.colors.accent} 20%, transparent)`,
} as const;

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
  box: {
    sm: '0 2px 8px rgba(0, 0, 0, 0.6)',
    md: '0 4px 16px rgba(0, 0, 0, 0.8)',
    lg: SETTINGS_UI_DESIGN.shadow.floating,
  },
} as const;

const borderRadius = {
  sm: SETTINGS_UI_DESIGN.radius.control,
  md: SETTINGS_UI_DESIGN.radius.panel,
  lg: SETTINGS_UI_DESIGN.radius.panel,
  pill: SETTINGS_UI_DESIGN.radius.full,
  full: SETTINGS_UI_DESIGN.radius.full,
} as const;

const zIndex = {
  settingsButton: 120,
} as const;

// ── UI sizing tokens (settings panel layout) ──
const uiSizing = {
  buttonSize: SETTINGS_UI_DESIGN.target.minimum,
  buttonFontSize: SETTINGS_UI_DESIGN.icon.size,
  targetMinimum: SETTINGS_UI_DESIGN.target.minimum,
  compactControlHeight: SETTINGS_UI_DESIGN.target.compactControlHeight,
  inputWidth: 86,
  colorSwatch: 44,
  colorSwatchHeight: 26,
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

const tooltip = {
  bg: SETTINGS_UI_DESIGN.colors.canvas,
  border: SETTINGS_UI_DESIGN.colors.border,
  text: SETTINGS_UI_DESIGN.colors.text,
} as const;

// ── Animation durations (settings panel) ──
const animDuration = {
  fast: SETTINGS_UI_DESIGN.motion.fast,
  normal: SETTINGS_UI_DESIGN.motion.standard,
  slow: SETTINGS_UI_DESIGN.motion.deliberate,
  transitions: {
    button: `opacity ${SETTINGS_UI_DESIGN.motion.standard} ${SETTINGS_UI_DESIGN.motion.easing}, background ${SETTINGS_UI_DESIGN.motion.standard} ${SETTINGS_UI_DESIGN.motion.easing}, transform ${SETTINGS_UI_DESIGN.motion.fast} ${SETTINGS_UI_DESIGN.motion.easing}`,
    action: `background ${SETTINGS_UI_DESIGN.motion.standard} ${SETTINGS_UI_DESIGN.motion.easing}, color ${SETTINGS_UI_DESIGN.motion.standard} ${SETTINGS_UI_DESIGN.motion.easing}, border-color ${SETTINGS_UI_DESIGN.motion.standard} ${SETTINGS_UI_DESIGN.motion.easing}`,
    tab: `color ${SETTINGS_UI_DESIGN.motion.fast} ${SETTINGS_UI_DESIGN.motion.easing}`,
  },
} as const;

// ── UI confirm backdrop alpha ──
const CONFIRM_BACKDROP_ALPHA = 0.5;

// ── Scrollbar (pane overflow) ──
const scrollbar = {
  width: '6px',
  track: 'transparent',
  thumb: `color-mix(in srgb, ${SETTINGS_UI_DESIGN.colors.border} 70%, transparent)`,
  thumbHover: `color-mix(in srgb, ${SETTINGS_UI_DESIGN.colors.textMuted} 45%, transparent)`,
} as const;

// ── Toast notification ──
const TOAST_BG = SETTINGS_UI_DESIGN.colors.canvas;
const TOAST_FONT = `12px/1.4 ${DEFAULT_FONT_FAMILY}`;
const TOAST_PADDING = '6px 14px';

export const SETTINGS_UI_STYLES = `
      .yt-chat-overlay-settings-modal,
      .yt-chat-overlay-settings-confirm,
      #yt-chat-overlay-settings-backdrop {
        color-scheme: ${SETTINGS_UI_DESIGN.colorScheme};
      }
      .yt-chat-overlay-settings-button {
        position: absolute;
        top: ${spacing.sm}px;
        inset-inline-start: ${spacing.sm}px;
        width: ${uiSizing.buttonSize};
        height: ${uiSizing.buttonSize};
        border-radius: ${borderRadius.full};
        border: 1px solid rgba(255, 255, 255, ${uiSizing.borderAlpha});
        background: rgba(0, 0, 0, ${uiSizing.scrimAlpha});
        backdrop-filter: blur(4px);
        color: ${uiColors.text};
        font-size: ${uiSizing.buttonFontSize};
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
        scale: 1.1;
      }
      .yt-chat-overlay-settings-button:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
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
        top: ${spacing.sm}px;
        inset-inline-start: calc(${spacing.sm}px + ${uiSizing.buttonSize} + ${spacing.xs}px);
        width: ${uiSizing.buttonSize};
        height: ${uiSizing.buttonSize};
        border-radius: ${borderRadius.full};
        border: 1px solid rgba(255, 255, 255, ${uiSizing.borderAlpha});
        background: rgba(0, 0, 0, ${uiSizing.scrimAlpha});
        backdrop-filter: blur(4px);
        color: ${uiColors.text};
        font-size: ${uiSizing.buttonFontSize};
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
        scale: 1.1;
      }
      .yt-chat-overlay-reload-button:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
        opacity: 1;
        pointer-events: auto;
      }
      #movie_player:hover .yt-chat-overlay-reload-button,
      .html5-video-player:hover .yt-chat-overlay-reload-button {
        opacity: 1;
        pointer-events: auto;
      }
      /* Touch devices: no hover capability — show buttons at reduced opacity */
      @media (hover: none) {
        .yt-chat-overlay-settings-button,
        .yt-chat-overlay-reload-button {
          opacity: 0.7;
          pointer-events: auto;
        }
        .yt-chat-overlay-settings-button:focus-visible,
        .yt-chat-overlay-reload-button:focus-visible {
          opacity: 1;
        }
      }
      .yt-chat-overlay-reload-button--done {
        color: ${uiColors.success};
        border-color: ${uiColors.success}80;
      }
      @keyframes yt-overlay-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes yt-overlay-modal-scale-in {
        from { transform: scale(0.92); opacity: 0; }
        to { transform: scale(1); opacity: 1; }
      }
      @keyframes yt-overlay-confirm-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      /* Native <dialog> backdrop — replaces custom .yt-chat-overlay-settings-backdrop */
      dialog.yt-chat-overlay-settings-modal[open]::backdrop {
        background: rgba(0, 0, 0, ${uiSizing.scrimAlpha});
        animation: yt-overlay-fade-in ${animDuration.normal} ease-out;
      }
      dialog.yt-chat-overlay-settings-modal[open] {
        border: none;
        padding: ${spacing.lg}px;
        margin: auto;
        width: min(${uiSizing.modalWidth}px, ${uiSizing.modalMaxVW}vw);
        max-width: min(${uiSizing.modalMaxVW}vw, ${uiSizing.modalMaxWidth}px);
        max-height: ${uiSizing.modalMaxVH}vh;
        overflow: hidden;
        background: ${uiColors.background};
        color: ${uiColors.text};
        border-radius: ${borderRadius.md};
        display: flex;
        flex-direction: column;
        gap: ${spacing.md}px;
        font-family: ${DEFAULT_FONT_FAMILY};
        box-shadow: ${shadows.box.lg};
        animation: yt-overlay-modal-scale-in ${animDuration.slow} ease-out;
      }
      @starting-style {
        dialog.yt-chat-overlay-settings-modal[open] {
          transform: scale(0.92);
          opacity: 0;
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
      .yt-chat-overlay-settings-close {
        border: none;
        background: transparent;
        color: ${uiColors.textMuted};
        font-size: ${typography.fontSize.lg};
        cursor: pointer;
        padding: ${spacing.sm}px;
        line-height: ${typography.lineHeight.tight};
        min-width: ${uiSizing.targetMinimum};
        min-height: ${uiSizing.targetMinimum};
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: ${borderRadius.sm};
      }
      .yt-chat-overlay-settings-close:hover {
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-close:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      /* Tab bar */
      .yt-chat-overlay-settings-tabs {
        display: flex;
        border-bottom: 1px solid ${uiColors.border};
        flex-shrink: 0;
      }
      .yt-chat-overlay-settings-tab {
        flex: 1;
        padding: ${spacing.sm + 2}px ${spacing.sm}px;
        min-height: ${uiSizing.targetMinimum};
        border: none;
        border-bottom: 2px solid transparent;
        background: transparent;
        color: ${uiColors.textMuted};
        font-size: ${typography.fontSize.xs};
        font-weight: ${typography.fontWeight.bold};
        letter-spacing: 0.05em;
        cursor: pointer;
        margin-bottom: -1px;
        transition: ${animDuration.transitions.tab};
      }
      .yt-chat-overlay-settings-tab:hover {
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-tab:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: calc(${SETTINGS_UI_DESIGN.focus.ringOffset} * -1);
      }
      .yt-chat-overlay-settings-tab.active {
        color: ${uiColors.accent};
        border-bottom-color: ${uiColors.accent};
      }
      /* Tab panes */
      .yt-chat-overlay-settings-pane {
        display: flex;
        flex-direction: column;
        gap: ${spacing.md}px;
        overflow-y: auto;
        flex: 1;
        min-height: 0;
        padding-inline-end: ${spacing.xxs}px;
        scrollbar-width: thin;
        scrollbar-color: ${scrollbar.thumb} ${scrollbar.track};
        content-visibility: auto;
        contain-intrinsic-size: 300px;
        mask-image: linear-gradient(to bottom, black 94%, transparent 100%);
        -webkit-mask-image: linear-gradient(to bottom, black 94%, transparent 100%);
        padding-bottom: calc(${spacing.lg}px * 2);
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
        letter-spacing: 0.05em;
        padding-bottom: ${spacing.xs}px;
        border-bottom: 1px solid ${uiColors.border};
      }
      /* Row fields */
      .yt-chat-overlay-settings-field {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: ${spacing.md}px;
        font-size: ${typography.fontSize.sm};
        min-height: 40px;
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
      .yt-chat-overlay-settings-field input[type="text"]:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      .yt-chat-overlay-settings-field input[type="color"] {
        width: ${uiSizing.colorSwatch}px;
        height: ${uiSizing.colorSwatchHeight}px;
        border: none;
        background: transparent;
        padding: 0;
        cursor: pointer;
      }
      .yt-chat-overlay-settings-field input[type="checkbox"] {
        width: ${uiSizing.checkboxSize}px;
        height: ${uiSizing.checkboxSize}px;
        cursor: pointer;
        accent-color: ${uiColors.accent};
      }
      .yt-chat-overlay-settings-field input[type="checkbox"]:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
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
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      /* ── :user-invalid validation styles ── */
      .yt-chat-overlay-settings-field input:user-invalid,
      .yt-chat-overlay-settings-field select:user-invalid {
        border-color: ${uiColors.danger};
        outline: 1px solid ${uiColors.danger};
      }
      .yt-chat-overlay-settings-section:has(:user-invalid) .yt-chat-overlay-settings-section-title {
        color: ${uiColors.danger};
      }
      .yt-chat-overlay-settings-field input[type="number"],
      .yt-chat-overlay-settings-field input[type="text"] {
        field-sizing: content;
        min-inline-size: 60px;
        max-inline-size: 200px;
      }
      .yt-chat-overlay-settings-field input[type="number"]:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      .yt-chat-overlay-settings-field input[type="text"]:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
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
        accent-color: ${uiColors.accent};
      }
      .yt-chat-overlay-settings-enabled input[type="checkbox"]:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      /* Authors grid — role="row" wrappers use display:contents so children
         become direct grid items (immune to wrapper insertion/removal) */
      .yt-chat-overlay-author-grid {
        display: grid;
        grid-template-columns: 1fr auto auto auto;
        gap: ${spacing.sm}px ${spacing.md}px;
        align-items: center;
      }
      .yt-chat-overlay-author-grid > [role="row"] {
        display: contents;
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
        width: ${uiSizing.colorSwatch}px;
        height: ${uiSizing.colorSwatchHeight}px;
        cursor: pointer;
      }
      .yt-chat-overlay-author-grid-color:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      .yt-chat-overlay-author-grid [role="gridcell"]:has(> .yt-chat-overlay-author-grid-color) {
        justify-self: center;
      }
      .yt-chat-overlay-author-grid-checkbox {
        width: ${uiSizing.checkboxSize}px;
        height: ${uiSizing.checkboxSize}px;
        cursor: pointer;
        accent-color: ${uiColors.accent};
      }
      .yt-chat-overlay-author-grid-checkbox:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      .yt-chat-overlay-author-grid [role="gridcell"]:has(> .yt-chat-overlay-author-grid-checkbox) {
        justify-self: center;
      }
      .yt-chat-overlay-author-grid-background {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: ${spacing.xs}px;
      }
      .yt-chat-overlay-author-grid-background-toggle {
        width: ${uiSizing.checkboxSize}px;
        height: ${uiSizing.checkboxSize}px;
      }
      .yt-chat-overlay-author-grid-color-superchat {
        width: ${uiSizing.colorSwatch}px;
        height: ${uiSizing.colorSwatchHeight}px;
      }
      /* Actions bar */
      .yt-chat-overlay-settings-actions-wrapper {
        flex-shrink: 0;
        padding-top: ${spacing.sm}px;
        border-top: 1px solid ${uiColors.border};
      }
      .yt-chat-overlay-settings-actions {
        display: flex;
        justify-content: flex-end;
        gap: ${spacing.sm}px;
      }
      .yt-chat-overlay-settings-actions button {
        border: none;
        border-radius: ${borderRadius.sm};
        padding: ${spacing.sm}px ${spacing.md}px;
        min-height: ${uiSizing.compactControlHeight};
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
        border-color: ${uiColors.accent};
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
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      .yt-chat-overlay-settings-actions button[data-action="close"] {
        background: ${uiColors.accent};
        color: ${uiColors.onAccent};
      }
      .yt-chat-overlay-settings-actions button[data-action="close"]:hover {
        background: ${uiColors.accentHover};
      }
      .yt-chat-overlay-settings-autosave-hint {
        margin: ${spacing.xs}px 0 0;
        font-size: ${typography.fontSize.xs};
        color: ${uiColors.textMuted};
        text-align: end;
        font-family: ${DEFAULT_FONT_FAMILY};
      }

      /* Reset confirmation dialog — native <dialog> */
      dialog.yt-chat-overlay-settings-confirm[open] {
        border: none;
        padding: ${spacing.lg}px;
        margin: auto;
        background: ${uiColors.backgroundLight};
        border: 1px solid ${uiColors.border};
        border-radius: ${borderRadius.md};
        min-width: ${uiSizing.confirmMinWidth}px;
        box-shadow: ${shadows.box.lg};
        animation: yt-overlay-confirm-fade-in ${animDuration.normal} ease-out;
      }
      dialog.yt-chat-overlay-settings-confirm[open]::backdrop {
        background: rgba(0, 0, 0, ${CONFIRM_BACKDROP_ALPHA});
        animation: yt-overlay-confirm-fade-in ${animDuration.normal} ease-out;
      }
      .yt-chat-overlay-settings-confirm-message {
        margin: 0 0 ${spacing.md}px;
        font-size: ${typography.fontSize.sm};
        color: ${uiColors.text};
        font-family: ${DEFAULT_FONT_FAMILY};
      }
      .yt-chat-overlay-settings-confirm-buttons {
        display: flex;
        justify-content: flex-end;
        gap: ${spacing.sm}px;
        font-family: ${DEFAULT_FONT_FAMILY};
      }
      .yt-chat-overlay-settings-confirm-cancel,
      .yt-chat-overlay-settings-confirm-ok {
        border: none;
        border-radius: ${borderRadius.sm};
        padding: ${spacing.sm}px ${spacing.md}px;
        min-height: ${uiSizing.compactControlHeight};
        cursor: pointer;
        font-weight: ${typography.fontWeight.semibold};
        font-size: ${typography.fontSize.sm};
        font-family: inherit;
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
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      .yt-chat-overlay-settings-confirm-ok {
        background: ${uiColors.dangerFill};
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-confirm-ok:hover {
        background: ${uiColors.dangerFillHover};
      }
      .yt-chat-overlay-settings-confirm-ok:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
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
        flex-wrap: wrap;
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
        height: ${spacing.sm}px;
        accent-color: ${uiColors.accent};
        cursor: pointer;
        margin: 0;
      }
      .yt-chat-overlay-settings-range-slider:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
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
      .yt-chat-overlay-settings-range-number:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      .yt-chat-overlay-settings-range-number::-webkit-inner-spin-button,
      .yt-chat-overlay-settings-range-number::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      /* Inline validation error */
      .yt-chat-overlay-settings-field-error {
        display: block;
        flex-basis: 100%;
        min-height: 1lh;
        font-size: ${typography.fontSize.xs};
        color: ${uiColors.danger};
        margin-top: ${spacing.xxs}px;
        text-align: end;
      }
      /* Disabled-field helper hint */
      .yt-chat-overlay-settings-field-hint {
        display: block;
        font-size: ${typography.fontSize.xs};
        color: ${uiColors.textMuted};
        margin-top: ${spacing.xxs}px;
      }

      /* ── Font preview ── */
      .yt-chat-overlay-settings-font-preview {
        background: ${uiColors.background};
        border: 1px solid ${uiColors.border};
        border-radius: ${borderRadius.sm};
        padding: ${spacing.lg}px;
        margin-bottom: ${spacing.md}px;
        text-align: center;
        min-height: 60px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .yt-chat-overlay-settings-font-preview-text {
        color: ${uiColors.text};
        transition: font-size ${animDuration.fast} ${SETTINGS_UI_DESIGN.motion.easing}, font-weight ${animDuration.fast} ${SETTINGS_UI_DESIGN.motion.easing};
        line-height: 1.3;
      }

      /* ── Weight toggle pills ── */
      .yt-chat-overlay-settings-weight-toggle {
        display: flex;
        gap: 0;
        border-radius: ${borderRadius.sm};
        overflow: hidden;
        border: 1px solid ${uiColors.border};
      }
      .yt-chat-overlay-settings-weight-toggle-btn {
        flex: 1;
        padding: ${spacing.xs}px ${spacing.md}px;
        border: none;
        background: ${uiColors.backgroundLight};
        color: ${uiColors.textMuted};
        font-size: ${typography.fontSize.sm};
        cursor: pointer;
        transition: ${animDuration.transitions.action};
        border-right: 1px solid ${uiColors.border};
        min-height: ${uiSizing.targetMinimum};
      }
      .yt-chat-overlay-settings-weight-toggle-btn:last-child {
        border-right: none;
      }
      .yt-chat-overlay-settings-weight-toggle-btn.active {
        background: ${uiColorsAlpha.accentBg};
        color: ${uiColors.text};
        font-weight: ${typography.fontWeight.bold};
      }
      .yt-chat-overlay-settings-weight-toggle-btn:hover:not(.active) {
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-weight-toggle-btn:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: calc(${SETTINGS_UI_DESIGN.focus.ringOffset} * -1);
      }

      /* ── Font family chips ── */
      .yt-chat-overlay-settings-font-chips-wrapper {
        width: 100%;
      }
      .yt-chat-overlay-settings-font-chips {
        display: flex;
        flex-wrap: wrap;
        gap: ${spacing.xs}px;
        margin-bottom: ${spacing.sm}px;
      }
      .yt-chat-overlay-settings-font-chip {
        appearance: none;
        -webkit-appearance: none;
        font-family: inherit;
        padding: ${spacing.sm - 1}px ${spacing.md}px;
        min-height: ${uiSizing.targetMinimum};
        line-height: 1.3;
        border-radius: ${borderRadius.pill};
        border: 1px solid ${uiColors.border};
        background: ${uiColors.backgroundLight};
        color: ${uiColors.textMuted};
        font-size: ${typography.fontSize.xs};
        cursor: pointer;
        transition: background-color ${animDuration.normal} ${SETTINGS_UI_DESIGN.motion.easing}, border-color ${animDuration.normal} ${SETTINGS_UI_DESIGN.motion.easing}, color ${animDuration.normal} ${SETTINGS_UI_DESIGN.motion.easing};
        white-space: nowrap;
        text-wrap: nowrap;
        user-select: none;
      }
      .yt-chat-overlay-settings-font-chip:hover {
        border-color: ${uiColors.accent};
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-font-chip.active {
        background: ${uiColorsAlpha.accentBgLight};
        border-color: ${uiColors.accent};
        color: ${uiColors.text};
        font-weight: ${typography.fontWeight.bold};
      }
      .yt-chat-overlay-settings-font-chip:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }

      /* ── Custom font input row ── */
      .yt-chat-overlay-settings-font-custom-row {
        display: flex;
        align-items: center;
        gap: ${spacing.sm}px;
      }
      .yt-chat-overlay-settings-font-custom-input {
        flex: 1;
        padding: ${spacing.xs}px ${spacing.sm}px;
        border-radius: ${borderRadius.sm};
        border: 1px solid ${uiColors.border};
        background: ${uiColors.backgroundLight};
        color: ${uiColors.text};
        font-size: ${typography.fontSize.xs};
      }
      .yt-chat-overlay-settings-font-custom-input:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }

      /* Font panel label override — vertical alignment for chip/weight containers */
      .yt-chat-overlay-settings-field--top-align {
        align-items: flex-start;
      }

      /* Reflow translated controls instead of truncating their labels. */
      @media (max-width: 480px) {
        .yt-chat-overlay-settings-tabs {
          flex-wrap: wrap;
        }
        .yt-chat-overlay-settings-tab {
          flex: 1 1 50%;
          min-width: 0;
        }
        .yt-chat-overlay-settings-actions {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .yt-chat-overlay-settings-actions button {
          inline-size: 100%;
        }
      }

      /* ── Accessibility: reduced motion ── */
      @media (prefers-reduced-motion: reduce) {
        .yt-chat-overlay-settings-toast,
        .yt-chat-overlay-settings-field-error,
        .yt-chat-overlay-settings-button,
        .yt-chat-overlay-reload-button,
        .yt-chat-overlay-settings-close,
        .yt-chat-overlay-settings-actions button,
        .yt-chat-overlay-settings-tab,
        .yt-chat-overlay-settings-font-preview-text,
        .yt-chat-overlay-settings-weight-toggle-btn,
        .yt-chat-overlay-settings-font-chip,
        dialog.yt-chat-overlay-settings-modal[open]::backdrop,
        dialog.yt-chat-overlay-settings-modal[open],
        dialog.yt-chat-overlay-settings-confirm[open]::backdrop,
        dialog.yt-chat-overlay-settings-confirm[open] {
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
        dialog.yt-chat-overlay-settings-confirm[open],
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
      /* Black overlay opacity scale — documented rationale:
       * - 0.90: Tooltip bg (highest contrast, over white/dark content)
       * - 0.85: Toast bg (floating notification, slightly less opaque)
       * - 0.80: Debug overlay (dev-only, unobtrusive)
       * - 0.75: Backlog indicator (small pill, less intrusive)
       */
      /* Native Popover API tooltips */
      .yt-chat-overlay-tooltip {
        font-family: ${DEFAULT_FONT_FAMILY};
        font-size: ${typography.fontSize.xs};
        line-height: 1.4;
        padding: ${spacing.xs}px ${spacing.sm}px;
        border-radius: ${borderRadius.sm};
        background: ${tooltip.bg};
        color: ${tooltip.text};
        border: 1px solid ${tooltip.border};
        max-width: 240px;
        pointer-events: none;
        white-space: nowrap;
        opacity: 0;
        transition: opacity ${animDuration.normal} ${SETTINGS_UI_DESIGN.motion.easing};
      }
      @starting-style {
        .yt-chat-overlay-tooltip:popover-open {
          opacity: 0;
        }
      }
      .yt-chat-overlay-tooltip:popover-open {
        inset: unset;
        margin: 0;
        opacity: 1;
        /* Default placement: below the anchor element, center-aligned */
        position-area: block-end;
        /* Edge-aware fallbacks: flip above if no room below, then flip horizontally */
        position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline;
      }
      /* CSS Anchor Positioning — anchor-name targets use fixed ID strings */
      #yt-chat-overlay-settings-button {
        anchor-name: --yt-overlay-settings-btn;
      }
      #yt-chat-overlay-reload-button {
        anchor-name: --yt-overlay-reload-btn;
      }
      #yt-chat-overlay-settings-tooltip {
        position-anchor: --yt-overlay-settings-btn;
      }
      #yt-chat-overlay-reload-tooltip {
        position-anchor: --yt-overlay-reload-btn;
      }
`;
