import { type OverlaySettings, SETTINGS_LIMITS } from '@app-types';
import { ensurePlayerPositioning, findPlayerContainerElement } from '@core/dom';
import { overlayLog } from '@core/logging';
import { borderRadius, colors, shadows, spacing, typography, zIndex } from './design-tokens.js';

const STYLE_ID = 'yt-chat-overlay-settings-style';
const BUTTON_ID = 'yt-chat-overlay-settings-button';
const BACKDROP_ID = 'yt-chat-overlay-settings-backdrop';
const TITLE_ID = 'yt-chat-overlay-settings-title';
const PLAYER_LOOKUP_INTERVAL_MS = 500;

const AUTHOR_COLOR_KEYS = ['normal', 'member', 'moderator', 'owner', 'verified'] as const;
const SHOW_AUTHOR_KEYS = [
  'normal',
  'member',
  'moderator',
  'owner',
  'verified',
  'superChat',
] as const;

const toPercent = (value: number): number => Math.round(value * 100);
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
const isLogLevel = (value: string): value is OverlaySettings['logLevel'] =>
  value === 'warn' || value === 'info' || value === 'debug';

const UI_LIMITS = {
  superChatOpacity: {
    min: toPercent(SETTINGS_LIMITS.superChatOpacity.min),
    max: toPercent(SETTINGS_LIMITS.superChatOpacity.max),
    step: toPercent(SETTINGS_LIMITS.superChatOpacity.step),
  },
  safeTop: {
    min: toPercent(SETTINGS_LIMITS.safeTop.min),
    max: toPercent(SETTINGS_LIMITS.safeTop.max),
    step: toPercent(SETTINGS_LIMITS.safeTop.step),
  },
  safeBottom: {
    min: toPercent(SETTINGS_LIMITS.safeBottom.min),
    max: toPercent(SETTINGS_LIMITS.safeBottom.max),
    step: toPercent(SETTINGS_LIMITS.safeBottom.step),
  },
} as const;

export class SettingsUi {
  private playerElement: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private backdrop: HTMLDivElement | null = null;
  private modal: HTMLDivElement | null = null;
  private previousFocus: HTMLElement | null = null;
  private activeTab = 'display';

  private readonly handleKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      this.close();
      return;
    }

    if (event.key === 'Tab') {
      this.trapFocus(event);
    }
  };

  constructor(
    private readonly getSettings: () => Readonly<OverlaySettings>,
    private readonly updateSettings: (partial: Partial<OverlaySettings>) => void,
    private readonly resetSettings: () => void
  ) {}

  async attach(): Promise<void> {
    const player = await this.findPlayerContainer();
    if (!player) return;

    if (this.playerElement === player && this.button?.isConnected) {
      return;
    }

    this.playerElement = player;
    this.ensureButton(player);
    this.ensureModal();
    this.close();
  }

  close(): void {
    if (!this.backdrop) return;
    this.setDialogOpen(false);

    if (this.previousFocus?.isConnected) {
      this.previousFocus.focus();
    }
    this.previousFocus = null;
  }

  private async findPlayerContainer(): Promise<HTMLElement | null> {
    return findPlayerContainerElement({
      intervalMs: PLAYER_LOOKUP_INTERVAL_MS,
    });
  }

  private ensureButton(player: HTMLElement): void {
    if (!this.button) {
      this.button = document.createElement('button');
      this.button.id = BUTTON_ID;
      this.button.type = 'button';
      this.button.className = 'yt-chat-overlay-settings-button';
      this.button.textContent = '⚙';
      this.button.setAttribute('aria-label', 'Chat overlay settings');
      this.button.addEventListener('click', () => this.open());
    } else if (this.button.parentElement) {
      this.button.remove();
    }

    ensurePlayerPositioning(player);

    player.appendChild(this.button);
  }

  private ensureStyles(): void {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
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
    document.head.appendChild(style);
  }

  private setDialogOpen(isOpen: boolean): void {
    if (!this.backdrop) {
      return;
    }

    this.backdrop.style.display = isOpen ? 'flex' : 'none';
    this.backdrop.hidden = !isOpen;
    this.backdrop.setAttribute('aria-hidden', isOpen ? 'false' : 'true');

    if (isOpen) {
      document.addEventListener('keydown', this.handleKeydown);
      return;
    }

    document.removeEventListener('keydown', this.handleKeydown);
  }

  private bindTabEvents(): void {
    this.modal
      ?.querySelectorAll<HTMLButtonElement>('.yt-chat-overlay-settings-tab')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          const tabId = btn.dataset.tab;
          if (tabId) this.switchTab(tabId);
        });
      });
  }

  private switchTab(tabId: string): void {
    if (!this.modal) return;
    this.activeTab = tabId;

    this.modal
      .querySelectorAll<HTMLButtonElement>('.yt-chat-overlay-settings-tab')
      .forEach((btn) => {
        const isActive = btn.dataset.tab === tabId;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', String(isActive));
      });

    this.modal
      .querySelectorAll<HTMLDivElement>('.yt-chat-overlay-settings-pane')
      .forEach((pane) => {
        if (pane.dataset.pane === tabId) {
          pane.removeAttribute('hidden');
        } else {
          pane.setAttribute('hidden', '');
        }
      });
  }

  private bindModalEvents(): void {
    this.modal
      ?.querySelector<HTMLButtonElement>('.yt-chat-overlay-settings-close')
      ?.addEventListener('click', () => this.close());
    this.modal
      ?.querySelector<HTMLButtonElement>('button[data-action="apply"]')
      ?.addEventListener('click', () => this.apply());
    this.modal
      ?.querySelector<HTMLButtonElement>('button[data-action="reset"]')
      ?.addEventListener('click', () => this.handleReset());

    this.modal
      ?.querySelector<HTMLInputElement>('input[name="allowShortTextMessages"]')
      ?.addEventListener('change', () => this.syncMinTextLengthState());

    this.bindTabEvents();
  }

  private ensureModal(): void {
    this.ensureStyles();

    if (this.backdrop) return;

    this.backdrop = document.createElement('div');
    this.backdrop.id = BACKDROP_ID;
    this.backdrop.className = 'yt-chat-overlay-settings-backdrop';
    this.backdrop.addEventListener('click', (event) => {
      if (event.target === this.backdrop) {
        this.close();
      }
    });

    this.modal = document.createElement('div');
    this.modal.className = 'yt-chat-overlay-settings-modal';
    this.modal.tabIndex = -1;
    this.modal.setAttribute('role', 'dialog');
    this.modal.setAttribute('aria-modal', 'true');
    this.modal.setAttribute('aria-labelledby', TITLE_ID);
    this.modal.innerHTML = `
      <div class="yt-chat-overlay-settings-header">
        <div id="${TITLE_ID}">Chat Overlay</div>
        <button
          type="button"
          class="yt-chat-overlay-settings-close"
          aria-label="Close settings"
        >✕</button>
      </div>

      <nav class="yt-chat-overlay-settings-tabs" role="tablist" aria-label="Settings categories">
        <button class="yt-chat-overlay-settings-tab active" data-tab="display"
          role="tab" aria-selected="true" aria-controls="pane-display">Display</button>
        <button class="yt-chat-overlay-settings-tab" data-tab="style"
          role="tab" aria-selected="false" aria-controls="pane-style">Style</button>
        <button class="yt-chat-overlay-settings-tab" data-tab="authors"
          role="tab" aria-selected="false" aria-controls="pane-authors">Authors</button>
        <button class="yt-chat-overlay-settings-tab" data-tab="filter"
          role="tab" aria-selected="false" aria-controls="pane-filter">Filter</button>
      </nav>

      <!-- Display: core visibility controls -->
      <div class="yt-chat-overlay-settings-pane" id="pane-display" data-pane="display" role="tabpanel">
        <label class="yt-chat-overlay-settings-enabled">
          <span>Overlay Enabled</span>
          <input type="checkbox" name="enabled" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Font Size (px)</span>
          <input
            type="number"
            name="fontSize"
            min="${SETTINGS_LIMITS.fontSize.min}"
            max="${SETTINGS_LIMITS.fontSize.max}"
            step="${SETTINGS_LIMITS.fontSize.step}"
          />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Text Opacity</span>
          <input
            type="number"
            name="opacity"
            min="${SETTINGS_LIMITS.opacity.min}"
            max="${SETTINGS_LIMITS.opacity.max}"
            step="${SETTINGS_LIMITS.opacity.step}"
          />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Scroll Speed (px/s)</span>
          <input
            type="number"
            name="speedPxPerSec"
            min="${SETTINGS_LIMITS.speedPxPerSec.min}"
            max="${SETTINGS_LIMITS.speedPxPerSec.max}"
            step="${SETTINGS_LIMITS.speedPxPerSec.step}"
          />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Top Clear Zone (%)</span>
          <input
            type="number"
            name="safeTop"
            min="${UI_LIMITS.safeTop.min}"
            max="${UI_LIMITS.safeTop.max}"
            step="${UI_LIMITS.safeTop.step}"
            title="Keep top N% of video free of comments"
          />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Bottom Clear Zone (%)</span>
          <input
            type="number"
            name="safeBottom"
            min="${UI_LIMITS.safeBottom.min}"
            max="${UI_LIMITS.safeBottom.max}"
            step="${UI_LIMITS.safeBottom.step}"
            title="Keep bottom N% of video free of comments"
          />
        </label>
      </div>

      <!-- Style: visual appearance -->
      <div class="yt-chat-overlay-settings-pane" id="pane-style" data-pane="style" hidden role="tabpanel">
        <label class="yt-chat-overlay-settings-field">
          <span>SuperChat Opacity (%)</span>
          <input
            type="number"
            name="superChatOpacity"
            min="${UI_LIMITS.superChatOpacity.min}"
            max="${UI_LIMITS.superChatOpacity.max}"
            step="${UI_LIMITS.superChatOpacity.step}"
            title="Background opacity of Super Chat cards"
          />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Lane Gap (px)</span>
          <input
            type="number"
            name="laneSpacing"
            min="${SETTINGS_LIMITS.laneSpacing.min}"
            max="${SETTINGS_LIMITS.laneSpacing.max}"
            step="${SETTINGS_LIMITS.laneSpacing.step}"
            title="Extra vertical gap between comment rows"
          />
        </label>
        <div class="yt-chat-overlay-settings-section">
          <div class="yt-chat-overlay-settings-section-title">Text Outline</div>
          <label class="yt-chat-overlay-settings-field">
            <span>Enabled</span>
            <input type="checkbox" name="outline-enabled" />
          </label>
          <label class="yt-chat-overlay-settings-field">
            <span>Width (px)</span>
            <input
              type="number"
              name="outline-widthPx"
              min="${SETTINGS_LIMITS.outlineWidthPx.min}"
              max="${SETTINGS_LIMITS.outlineWidthPx.max}"
              step="${SETTINGS_LIMITS.outlineWidthPx.step}"
            />
          </label>
          <label class="yt-chat-overlay-settings-field">
            <span>Blur (px)</span>
            <input
              type="number"
              name="outline-blurPx"
              min="${SETTINGS_LIMITS.outlineBlurPx.min}"
              max="${SETTINGS_LIMITS.outlineBlurPx.max}"
              step="${SETTINGS_LIMITS.outlineBlurPx.step}"
            />
          </label>
          <label class="yt-chat-overlay-settings-field">
            <span>Opacity</span>
            <input
              type="number"
              name="outline-opacity"
              min="${SETTINGS_LIMITS.outlineOpacity.min}"
              max="${SETTINGS_LIMITS.outlineOpacity.max}"
              step="${SETTINGS_LIMITS.outlineOpacity.step}"
            />
          </label>
        </div>
      </div>

      <!-- Authors: per-type color and name visibility -->
      <div class="yt-chat-overlay-settings-pane" id="pane-authors" data-pane="authors" hidden role="tabpanel">
        <div class="yt-chat-overlay-author-grid">
          <span class="yt-chat-overlay-author-grid-label"></span>
          <span class="yt-chat-overlay-author-grid-header">Color</span>
          <span class="yt-chat-overlay-author-grid-header">Show</span>

          <span class="yt-chat-overlay-author-grid-label">Normal</span>
          <input type="color" name="color-normal" class="yt-chat-overlay-author-grid-color" />
          <input
            type="checkbox"
            name="showAuthor-normal"
            class="yt-chat-overlay-author-grid-checkbox"
          />

          <span class="yt-chat-overlay-author-grid-label">Member</span>
          <input type="color" name="color-member" class="yt-chat-overlay-author-grid-color" />
          <input
            type="checkbox"
            name="showAuthor-member"
            class="yt-chat-overlay-author-grid-checkbox"
          />

          <span class="yt-chat-overlay-author-grid-label">Moderator</span>
          <input type="color" name="color-moderator" class="yt-chat-overlay-author-grid-color" />
          <input
            type="checkbox"
            name="showAuthor-moderator"
            class="yt-chat-overlay-author-grid-checkbox"
          />

          <span class="yt-chat-overlay-author-grid-label">Owner</span>
          <input type="color" name="color-owner" class="yt-chat-overlay-author-grid-color" />
          <input
            type="checkbox"
            name="showAuthor-owner"
            class="yt-chat-overlay-author-grid-checkbox"
          />

          <span class="yt-chat-overlay-author-grid-label">Verified</span>
          <input type="color" name="color-verified" class="yt-chat-overlay-author-grid-color" />
          <input
            type="checkbox"
            name="showAuthor-verified"
            class="yt-chat-overlay-author-grid-checkbox"
          />

          <span class="yt-chat-overlay-author-grid-label">SuperChat</span>
          <span></span>
          <input
            type="checkbox"
            name="showAuthor-superChat"
            class="yt-chat-overlay-author-grid-checkbox"
          />
        </div>
      </div>

      <!-- Filter: rate limiting, text filtering, advanced -->
      <div class="yt-chat-overlay-settings-pane" id="pane-filter" data-pane="filter" hidden role="tabpanel">
        <div class="yt-chat-overlay-settings-section">
          <div class="yt-chat-overlay-settings-section-title">Message Rate</div>
          <label class="yt-chat-overlay-settings-field">
            <span>Max per Second</span>
            <input
              type="number"
              name="maxMessagesPerSecond"
              min="${SETTINGS_LIMITS.maxMessagesPerSecond.min}"
              max="${SETTINGS_LIMITS.maxMessagesPerSecond.max}"
              step="${SETTINGS_LIMITS.maxMessagesPerSecond.step}"
              title="Maximum new comments displayed per second"
            />
          </label>
          <label class="yt-chat-overlay-settings-field">
            <span>Show Short Messages</span>
            <input
              type="checkbox"
              name="allowShortTextMessages"
              title="Show messages shorter than Min Length"
            />
          </label>
          <label class="yt-chat-overlay-settings-field">
            <span>Min Length (chars)</span>
            <input
              type="number"
              name="minTextLength"
              min="${SETTINGS_LIMITS.minTextLength.min}"
              max="${SETTINGS_LIMITS.minTextLength.max}"
              step="${SETTINGS_LIMITS.minTextLength.step}"
              title="Minimum character count (ignored when Show Short is on)"
            />
          </label>
        </div>
        <div class="yt-chat-overlay-settings-section">
          <div class="yt-chat-overlay-settings-section-title">Performance</div>
          <label class="yt-chat-overlay-settings-field">
            <span>Max Visible</span>
            <input
              type="number"
              name="maxConcurrentMessages"
              min="${SETTINGS_LIMITS.maxConcurrentMessages.min}"
              max="${SETTINGS_LIMITS.maxConcurrentMessages.max}"
              step="${SETTINGS_LIMITS.maxConcurrentMessages.step}"
              title="Performance warning threshold for simultaneous comments"
            />
          </label>
        </div>
        <div class="yt-chat-overlay-settings-section">
          <div class="yt-chat-overlay-settings-section-title">Debug</div>
          <label class="yt-chat-overlay-settings-field">
            <span>Log Level</span>
            <select name="logLevel" title="Console output verbosity">
              <option value="warn">Warn</option>
              <option value="info">Info</option>
              <option value="debug">Debug</option>
            </select>
          </label>
        </div>
      </div>

      <div class="yt-chat-overlay-settings-actions">
        <button type="button" data-action="reset">Reset</button>
        <button type="button" data-action="apply">Apply</button>
      </div>
    `;

    this.bindModalEvents();

    this.backdrop.appendChild(this.modal);
    document.body.appendChild(this.backdrop);
    this.setDialogOpen(false);
  }

  private open(): void {
    if (!this.backdrop || !this.modal) return;

    const activeElement = document.activeElement;
    this.previousFocus = activeElement instanceof HTMLElement ? activeElement : null;

    this.populateForm(this.getSettings());
    this.switchTab(this.activeTab);
    this.setDialogOpen(true);
    this.focusInitialElement();
  }

  private apply(): void {
    const partial = this.collectSettings();
    this.updateSettings(partial);
    this.populateForm(this.getSettings());
    this.close();
  }

  private handleReset(): void {
    this.resetSettings();
    this.populateForm(this.getSettings());
  }

  private setAuthorSettings(settings: Readonly<OverlaySettings>): void {
    for (const key of AUTHOR_COLOR_KEYS) {
      this.setValue(`color-${key}`, settings.colors[key]);
    }

    for (const key of SHOW_AUTHOR_KEYS) {
      this.setCheckbox(`showAuthor-${key}`, settings.showAuthor[key]);
    }
  }

  private populateForm(settings: Readonly<OverlaySettings>): void {
    this.setCheckbox('enabled', settings.enabled);
    this.setValue('speedPxPerSec', settings.speedPxPerSec);
    this.setValue('fontSize', settings.fontSize);
    this.setValue('opacity', settings.opacity);
    this.setValue('superChatOpacity', (settings.superChatOpacity * 100).toFixed(0));
    this.setValue('safeTop', (settings.safeTop * 100).toFixed(1));
    this.setValue('safeBottom', (settings.safeBottom * 100).toFixed(1));
    this.setValue('maxConcurrentMessages', settings.maxConcurrentMessages);
    this.setValue('maxMessagesPerSecond', settings.maxMessagesPerSecond);
    this.setCheckbox('allowShortTextMessages', settings.allowShortTextMessages);
    this.setValue('minTextLength', settings.minTextLength);
    this.setSelect('logLevel', settings.logLevel);
    this.setAuthorSettings(settings);

    this.setCheckbox('outline-enabled', settings.outline.enabled);
    this.setValue('outline-widthPx', settings.outline.widthPx);
    this.setValue('outline-blurPx', settings.outline.blurPx);
    this.setValue('outline-opacity', settings.outline.opacity);
    this.setValue('laneSpacing', settings.laneSpacing);

    this.syncMinTextLengthState();
  }

  private syncMinTextLengthState(): void {
    const allowShort = this.getInput('allowShortTextMessages');
    const minLength = this.getInput('minTextLength');
    if (allowShort && minLength) {
      minLength.disabled = allowShort.checked;
    }
  }

  private readNumber(name: string, fallback: number): number {
    const input = this.getInput(name);
    if (!input) return fallback;

    const parsed = Number.parseFloat(input.value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private readClampedNumber(
    name: string,
    fallback: number,
    limits: { min: number; max: number }
  ): number {
    return clamp(this.readNumber(name, fallback), limits.min, limits.max);
  }

  private readRoundedClampedNumber(
    name: string,
    fallback: number,
    limits: { min: number; max: number }
  ): number {
    return Math.round(this.readClampedNumber(name, fallback, limits));
  }

  private readPercentSetting(
    name: string,
    fallbackFraction: number,
    limits: { min: number; max: number }
  ): number {
    return this.readClampedNumber(name, fallbackFraction * 100, limits) / 100;
  }

  private collectAuthorColors(current: Readonly<OverlaySettings>): OverlaySettings['colors'] {
    const nextColors: OverlaySettings['colors'] = { ...current.colors };

    for (const key of AUTHOR_COLOR_KEYS) {
      nextColors[key] = this.getColor(`color-${key}`, current.colors[key]);
    }

    return nextColors;
  }

  private collectShowAuthorSettings(
    current: Readonly<OverlaySettings>
  ): OverlaySettings['showAuthor'] {
    const nextShowAuthor: OverlaySettings['showAuthor'] = {
      ...current.showAuthor,
    };

    for (const key of SHOW_AUTHOR_KEYS) {
      nextShowAuthor[key] = this.getCheckbox(`showAuthor-${key}`, current.showAuthor[key]);
    }

    return nextShowAuthor;
  }

  private collectSettings(): Partial<OverlaySettings> {
    const current = this.getSettings();

    return {
      enabled: this.getCheckbox('enabled', current.enabled),
      speedPxPerSec: this.readClampedNumber('speedPxPerSec', current.speedPxPerSec, {
        min: SETTINGS_LIMITS.speedPxPerSec.min,
        max: SETTINGS_LIMITS.speedPxPerSec.max,
      }),
      fontSize: this.readClampedNumber('fontSize', current.fontSize, {
        min: SETTINGS_LIMITS.fontSize.min,
        max: SETTINGS_LIMITS.fontSize.max,
      }),
      opacity: this.readClampedNumber('opacity', current.opacity, {
        min: SETTINGS_LIMITS.opacity.min,
        max: SETTINGS_LIMITS.opacity.max,
      }),
      superChatOpacity: this.readPercentSetting(
        'superChatOpacity',
        current.superChatOpacity,
        UI_LIMITS.superChatOpacity
      ),
      safeTop: this.readPercentSetting('safeTop', current.safeTop, UI_LIMITS.safeTop),
      safeBottom: this.readPercentSetting('safeBottom', current.safeBottom, UI_LIMITS.safeBottom),
      maxConcurrentMessages: this.readRoundedClampedNumber(
        'maxConcurrentMessages',
        current.maxConcurrentMessages,
        {
          min: SETTINGS_LIMITS.maxConcurrentMessages.min,
          max: SETTINGS_LIMITS.maxConcurrentMessages.max,
        }
      ),
      maxMessagesPerSecond: this.readRoundedClampedNumber(
        'maxMessagesPerSecond',
        current.maxMessagesPerSecond,
        {
          min: SETTINGS_LIMITS.maxMessagesPerSecond.min,
          max: SETTINGS_LIMITS.maxMessagesPerSecond.max,
        }
      ),
      allowShortTextMessages: this.getCheckbox(
        'allowShortTextMessages',
        current.allowShortTextMessages
      ),
      minTextLength: this.readRoundedClampedNumber('minTextLength', current.minTextLength, {
        min: SETTINGS_LIMITS.minTextLength.min,
        max: SETTINGS_LIMITS.minTextLength.max,
      }),
      logLevel: this.getLogLevel('logLevel', current.logLevel),
      showAuthor: this.collectShowAuthorSettings(current),
      colors: this.collectAuthorColors(current),
      outline: {
        enabled: this.getCheckbox('outline-enabled', current.outline.enabled),
        widthPx: this.readClampedNumber('outline-widthPx', current.outline.widthPx, {
          min: SETTINGS_LIMITS.outlineWidthPx.min,
          max: SETTINGS_LIMITS.outlineWidthPx.max,
        }),
        blurPx: this.readClampedNumber('outline-blurPx', current.outline.blurPx, {
          min: SETTINGS_LIMITS.outlineBlurPx.min,
          max: SETTINGS_LIMITS.outlineBlurPx.max,
        }),
        opacity: this.readClampedNumber('outline-opacity', current.outline.opacity, {
          min: SETTINGS_LIMITS.outlineOpacity.min,
          max: SETTINGS_LIMITS.outlineOpacity.max,
        }),
      },
      laneSpacing: this.readRoundedClampedNumber('laneSpacing', current.laneSpacing, {
        min: SETTINGS_LIMITS.laneSpacing.min,
        max: SETTINGS_LIMITS.laneSpacing.max,
      }),
    };
  }

  private getFocusableElements(): HTMLElement[] {
    if (!this.modal) return [];

    const selectors =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
      'textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

    return Array.from(this.modal.querySelectorAll<HTMLElement>(selectors)).filter((element) => {
      if (element.tabIndex < 0) return false;
      if (element.hasAttribute('hidden')) return false;
      // Exclude elements inside a hidden tab pane
      if (element.closest('[hidden]')) return false;
      return true;
    });
  }

  private focusInitialElement(): void {
    if (!this.modal) return;

    const closeButton = this.modal.querySelector<HTMLButtonElement>(
      '.yt-chat-overlay-settings-close'
    );
    if (closeButton) {
      closeButton.focus();
      return;
    }

    const [first] = this.getFocusableElements();
    if (first) {
      first.focus();
      return;
    }

    this.modal.focus();
  }

  private trapFocus(event: KeyboardEvent): void {
    if (!this.backdrop || this.backdrop.hidden) {
      return;
    }

    const focusableElements = this.getFocusableElements();
    if (focusableElements.length === 0) {
      event.preventDefault();
      this.modal?.focus();
      return;
    }

    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];
    if (!first || !last) return;

    const activeElement = document.activeElement;
    const isShiftTab = event.shiftKey;

    if (isShiftTab && activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!isShiftTab && activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private getInput(name: string): HTMLInputElement | null {
    return this.modal?.querySelector<HTMLInputElement>(`input[name="${name}"]`) ?? null;
  }

  private getSelect(name: string): HTMLSelectElement | null {
    return this.modal?.querySelector<HTMLSelectElement>(`select[name="${name}"]`) ?? null;
  }

  private getCheckbox(name: string, fallback: boolean): boolean {
    const input = this.getInput(name);
    return input ? input.checked : fallback;
  }

  private getColor(name: string, fallback: string): string {
    const input = this.getInput(name);
    return input?.value || fallback;
  }

  private getLogLevel(
    name: string,
    fallback: OverlaySettings['logLevel']
  ): OverlaySettings['logLevel'] {
    const select = this.getSelect(name);
    if (!select) return fallback;

    return isLogLevel(select.value) ? select.value : fallback;
  }

  private setValue(name: string, value: string | number): void {
    const input = this.getInput(name);
    if (input) {
      input.value = String(value);
    }
  }

  private setCheckbox(name: string, value: boolean): void {
    const input = this.getInput(name);
    if (input) {
      input.checked = value;
    }
  }

  private setSelect(name: string, value: string): void {
    const select = this.getSelect(name);
    if (select) {
      select.value = value;
    }
  }

  destroy(): void {
    this.close();
    this.button?.remove();
    this.backdrop?.remove();

    const styleElement = document.getElementById(STYLE_ID);
    styleElement?.remove();

    this.button = null;
    this.backdrop = null;
    this.modal = null;
    this.playerElement = null;

    overlayLog.info('[SettingsUi] Destroyed');
  }
}
