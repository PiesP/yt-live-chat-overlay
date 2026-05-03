import { borderRadius, colors, shadows, spacing, typography, zIndex } from '@core/design-tokens';

export const SETTINGS_UI_STYLES = `
      .yt-chat-overlay-settings-button {
        position: absolute;
        top: ${spacing.sm}px;
        right: ${spacing.sm}px;
        width: ${spacing.xxxl}px;
        height: ${spacing.xxxl}px;
        border-radius: ${borderRadius.sm};
        border: 1px solid rgba(255, 255, 255, 0.25);
        background: rgba(0, 0, 0, 0.6);
        color: ${colors.ui.text};
        font-size: ${typography.fontSize.base};
        cursor: pointer;
        z-index: 120;
        pointer-events: auto;
      }
      .yt-chat-overlay-settings-button:hover {
        background: rgba(0, 0, 0, 0.75);
      }
      .yt-chat-overlay-settings-backdrop {
        position: fixed;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.55);
        z-index: ${zIndex.modal};
      }
      .yt-chat-overlay-settings-modal {
        width: 400px;
        max-height: 82vh;
        overflow: hidden;
        background: ${colors.ui.background};
        color: ${colors.ui.text};
        border-radius: ${borderRadius.md};
        padding: ${spacing.lg}px;
        display: flex;
        flex-direction: column;
        gap: ${spacing.md}px;
        font-family: system-ui, -apple-system, sans-serif;
        box-shadow: ${shadows.box.lg};
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
        color: ${colors.ui.textMuted};
        font-size: ${typography.fontSize.lg};
        cursor: pointer;
        padding: 0 ${spacing.xs}px;
        line-height: 1;
      }
      .yt-chat-overlay-settings-close:hover {
        color: ${colors.ui.text};
      }
      /* Tab bar */
      .yt-chat-overlay-settings-tabs {
        display: flex;
        border-bottom: 1px solid ${colors.ui.border};
        flex-shrink: 0;
      }
      .yt-chat-overlay-settings-tab {
        flex: 1;
        padding: ${spacing.sm}px ${spacing.xs}px;
        border: none;
        border-bottom: 2px solid transparent;
        background: transparent;
        color: ${colors.ui.textMuted};
        font-size: ${typography.fontSize.xs};
        font-weight: ${typography.fontWeight.semibold};
        text-transform: uppercase;
        letter-spacing: 0.05em;
        cursor: pointer;
        margin-bottom: -1px;
        transition: color 0.1s;
      }
      .yt-chat-overlay-settings-tab:hover {
        color: ${colors.ui.text};
      }
      .yt-chat-overlay-settings-tab.active {
        color: ${colors.ui.primary};
        border-bottom-color: ${colors.ui.primary};
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
        color: ${colors.ui.textMuted};
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding-bottom: 4px;
        border-bottom: 1px solid ${colors.ui.border};
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
        width: 86px;
        padding: ${spacing.xs}px ${spacing.sm}px;
        border-radius: ${borderRadius.sm};
        border: 1px solid ${colors.ui.border};
        background: ${colors.ui.backgroundLight};
        color: ${colors.ui.text};
        text-align: right;
      }
      .yt-chat-overlay-settings-field input[type="color"] {
        width: 44px;
        height: 26px;
        border: none;
        background: transparent;
        padding: 0;
        cursor: pointer;
      }
      .yt-chat-overlay-settings-field input[type="checkbox"] {
        width: 18px;
        height: 18px;
        cursor: pointer;
        accent-color: ${colors.ui.primary};
      }
      .yt-chat-overlay-settings-field select {
        padding: ${spacing.xs}px ${spacing.sm}px;
        border-radius: ${borderRadius.sm};
        border: 1px solid ${colors.ui.border};
        background: ${colors.ui.backgroundLight};
        color: ${colors.ui.text};
        cursor: pointer;
      }
      .yt-chat-overlay-settings-field input[type="number"]:disabled,
      .yt-chat-overlay-settings-field input[type="text"]:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      /* Enabled toggle — styled distinctly at top of Display tab */
      .yt-chat-overlay-settings-enabled {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: ${spacing.sm}px ${spacing.md}px;
        background: ${colors.ui.backgroundLight};
        border-radius: ${borderRadius.sm};
        font-size: ${typography.fontSize.sm};
        font-weight: ${typography.fontWeight.semibold};
        cursor: pointer;
      }
      .yt-chat-overlay-settings-enabled input[type="checkbox"] {
        width: 18px;
        height: 18px;
        cursor: pointer;
        accent-color: ${colors.ui.primary};
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
        color: ${colors.ui.textMuted};
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
        border-top: 1px solid ${colors.ui.border};
      }
      .yt-chat-overlay-settings-actions button {
        border: none;
        border-radius: ${borderRadius.sm};
        padding: ${spacing.sm}px ${spacing.md}px;
        cursor: pointer;
        font-weight: ${typography.fontWeight.semibold};
        font-size: ${typography.fontSize.sm};
      }
      .yt-chat-overlay-settings-actions button[data-action="reset"] {
        background: transparent;
        color: ${colors.ui.textMuted};
        border: 1px solid ${colors.ui.border};
      }
      .yt-chat-overlay-settings-actions button[data-action="reset"]:hover {
        color: ${colors.ui.danger};
        border-color: ${colors.ui.danger};
      }
      .yt-chat-overlay-settings-actions button[data-action="apply"] {
        background: ${colors.ui.primary};
        color: ${colors.ui.text};
      }
      .yt-chat-overlay-settings-actions button[data-action="apply"]:hover {
        background: ${colors.ui.primaryHover};
      }
`;
