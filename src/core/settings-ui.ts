import { type OverlaySettings, SETTINGS_LIMITS } from '@app-types';
import { isVisibleElement, PLAYER_CONTAINER_SELECTORS, waitForElementMatch } from '@core/dom';
import { borderRadius, colors, shadows, spacing, typography, zIndex } from './design-tokens.js';

const STYLE_ID = 'yt-chat-overlay-settings-style';
const BUTTON_ID = 'yt-chat-overlay-settings-button';
const BACKDROP_ID = 'yt-chat-overlay-settings-backdrop';
const TITLE_ID = 'yt-chat-overlay-settings-title';

const toPercent = (value: number): number => Math.round(value * 100);

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
    this.backdrop.style.display = 'none';
    this.backdrop.hidden = true;
    this.backdrop.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', this.handleKeydown);

    if (this.previousFocus?.isConnected) {
      this.previousFocus.focus();
    }
    this.previousFocus = null;
  }

  private async findPlayerContainer(): Promise<HTMLElement | null> {
    const match = await waitForElementMatch<HTMLElement>(PLAYER_CONTAINER_SELECTORS, {
      attempts: 5,
      intervalMs: 500,
      predicate: isVisibleElement,
    });

    if (!match) {
      console.warn('[YT Chat Overlay] Settings UI: player container not found');
      return null;
    }

    return match.element;
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

    const computedStyle = window.getComputedStyle(player);
    if (computedStyle.position === 'static') {
      player.style.position = 'relative';
    }

    player.appendChild(this.button);
  }

  private ensureModal(): void {
    if (!document.getElementById(STYLE_ID)) {
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
          width: 380px;
          max-height: 82vh;
          overflow: auto;
          background: ${colors.ui.background};
          color: ${colors.ui.text};
          border-radius: ${borderRadius.md};
          padding: ${spacing.lg}px;
          display: flex;
          flex-direction: column;
          gap: ${spacing.lg}px;
          font-family: system-ui, -apple-system, sans-serif;
          box-shadow: ${shadows.box.lg};
        }
        .yt-chat-overlay-settings-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-weight: ${typography.fontWeight.bold};
          font-size: ${typography.fontSize.base};
        }
        .yt-chat-overlay-settings-close {
          border: none;
          background: transparent;
          color: ${colors.ui.text};
          font-size: ${typography.fontSize.lg};
          cursor: pointer;
        }
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
        }
        .yt-chat-overlay-settings-field {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: ${spacing.md}px;
          font-size: ${typography.fontSize.sm};
        }
        .yt-chat-overlay-settings-field input[type="number"] {
          width: 110px;
          padding: ${spacing.xs}px ${spacing.sm}px;
          border-radius: ${borderRadius.sm};
          border: 1px solid ${colors.ui.border};
          background: ${colors.ui.backgroundLight};
          color: ${colors.ui.text};
        }
        .yt-chat-overlay-settings-field input[type="color"] {
          width: 48px;
          height: 28px;
          border: none;
          background: transparent;
          padding: 0;
        }
        .yt-chat-overlay-settings-field input[type="checkbox"] {
          width: 18px;
          height: 18px;
          cursor: pointer;
        }
        .yt-chat-overlay-settings-field select {
          padding: ${spacing.xs}px ${spacing.sm}px;
          border-radius: ${borderRadius.sm};
          border: 1px solid ${colors.ui.border};
          background: ${colors.ui.backgroundLight};
          color: ${colors.ui.text};
          cursor: pointer;
        }
        .yt-chat-overlay-author-grid {
          display: grid;
          grid-template-columns: auto 1fr auto;
          gap: ${spacing.sm}px ${spacing.md}px;
          align-items: center;
          padding: ${spacing.sm}px 0;
        }
        .yt-chat-overlay-author-grid-label {
          font-size: ${typography.fontSize.sm};
          min-width: 80px;
        }
        .yt-chat-overlay-author-grid-color {
          justify-self: end;
        }
        .yt-chat-overlay-author-grid-checkbox {
          justify-self: end;
        }
        .yt-chat-overlay-settings-actions {
          display: flex;
          justify-content: flex-end;
          gap: ${spacing.sm}px;
          padding-top: ${spacing.xs}px;
        }
        .yt-chat-overlay-settings-actions button {
          border: none;
          border-radius: ${borderRadius.sm};
          padding: ${spacing.sm}px ${spacing.md}px;
          cursor: pointer;
          font-weight: ${typography.fontWeight.semibold};
        }
        .yt-chat-overlay-settings-actions button[data-action="reset"] {
          background: ${colors.ui.danger};
          color: ${colors.ui.text};
        }
        .yt-chat-overlay-settings-actions button[data-action="apply"] {
          background: ${colors.ui.primary};
          color: ${colors.ui.text};
        }
      `;
      document.head.appendChild(style);
    }

    if (this.backdrop) return;

    this.backdrop = document.createElement('div');
    this.backdrop.id = BACKDROP_ID;
    this.backdrop.className = 'yt-chat-overlay-settings-backdrop';
    this.backdrop.style.display = 'none';
    this.backdrop.hidden = true;
    this.backdrop.setAttribute('aria-hidden', 'true');
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
        <div id="${TITLE_ID}">Chat Overlay Settings</div>
        <button type="button" class="yt-chat-overlay-settings-close" aria-label="Close settings">✕</button>
      </div>
      <div class="yt-chat-overlay-settings-section">
        <div class="yt-chat-overlay-settings-section-title">General</div>
        <label class="yt-chat-overlay-settings-field">
          <span>Enabled</span>
          <input type="checkbox" name="enabled" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Speed (px/s)</span>
          <input
            type="number"
            name="speedPxPerSec"
            min="${SETTINGS_LIMITS.speedPxPerSec.min}"
            max="${SETTINGS_LIMITS.speedPxPerSec.max}"
            step="${SETTINGS_LIMITS.speedPxPerSec.step}"
          />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Font size (px)</span>
          <input
            type="number"
            name="fontSize"
            min="${SETTINGS_LIMITS.fontSize.min}"
            max="${SETTINGS_LIMITS.fontSize.max}"
            step="${SETTINGS_LIMITS.fontSize.step}"
          />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Opacity</span>
          <input
            type="number"
            name="opacity"
            min="${SETTINGS_LIMITS.opacity.min}"
            max="${SETTINGS_LIMITS.opacity.max}"
            step="${SETTINGS_LIMITS.opacity.step}"
          />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Super Chat color opacity (%)</span>
          <input
            type="number"
            name="superChatOpacity"
            min="${UI_LIMITS.superChatOpacity.min}"
            max="${UI_LIMITS.superChatOpacity.max}"
            step="${UI_LIMITS.superChatOpacity.step}"
          />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Safe top (%)</span>
          <input
            type="number"
            name="safeTop"
            min="${UI_LIMITS.safeTop.min}"
            max="${UI_LIMITS.safeTop.max}"
            step="${UI_LIMITS.safeTop.step}"
          />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Safe bottom (%)</span>
          <input
            type="number"
            name="safeBottom"
            min="${UI_LIMITS.safeBottom.min}"
            max="${UI_LIMITS.safeBottom.max}"
            step="${UI_LIMITS.safeBottom.step}"
          />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Warning threshold</span>
          <input
            type="number"
            name="maxConcurrentMessages"
            min="${SETTINGS_LIMITS.maxConcurrentMessages.min}"
            max="${SETTINGS_LIMITS.maxConcurrentMessages.max}"
            step="${SETTINGS_LIMITS.maxConcurrentMessages.step}"
            title="Performance warning threshold (not enforced)"
          />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Max messages/s</span>
          <input
            type="number"
            name="maxMessagesPerSecond"
            min="${SETTINGS_LIMITS.maxMessagesPerSecond.min}"
            max="${SETTINGS_LIMITS.maxMessagesPerSecond.max}"
            step="${SETTINGS_LIMITS.maxMessagesPerSecond.step}"
            title="Rate limit for new messages (enforced)"
          />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Allow short texts</span>
          <input
            type="checkbox"
            name="allowShortTextMessages"
            title="Show short regular messages (e.g. 1-2 characters)"
          />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Min text length</span>
          <input
            type="number"
            name="minTextLength"
            min="${SETTINGS_LIMITS.minTextLength.min}"
            max="${SETTINGS_LIMITS.minTextLength.max}"
            step="${SETTINGS_LIMITS.minTextLength.step}"
            title="Minimum visible character count for regular messages"
          />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Log level</span>
          <select name="logLevel" title="Console diagnostics verbosity">
            <option value="warn">Warn (default)</option>
            <option value="info">Info</option>
            <option value="debug">Debug</option>
          </select>
        </label>
      </div>
      <div class="yt-chat-overlay-settings-section">
        <div class="yt-chat-overlay-settings-section-title">Author Types (Color & Display)</div>
        <div class="yt-chat-overlay-author-grid">
          <span class="yt-chat-overlay-author-grid-label">Normal</span>
          <input type="color" name="color-normal" class="yt-chat-overlay-author-grid-color" />
          <input type="checkbox" name="showAuthor-normal" class="yt-chat-overlay-author-grid-checkbox" />

          <span class="yt-chat-overlay-author-grid-label">Member</span>
          <input type="color" name="color-member" class="yt-chat-overlay-author-grid-color" />
          <input type="checkbox" name="showAuthor-member" class="yt-chat-overlay-author-grid-checkbox" />

          <span class="yt-chat-overlay-author-grid-label">Moderator</span>
          <input type="color" name="color-moderator" class="yt-chat-overlay-author-grid-color" />
          <input type="checkbox" name="showAuthor-moderator" class="yt-chat-overlay-author-grid-checkbox" />

          <span class="yt-chat-overlay-author-grid-label">Owner</span>
          <input type="color" name="color-owner" class="yt-chat-overlay-author-grid-color" />
          <input type="checkbox" name="showAuthor-owner" class="yt-chat-overlay-author-grid-checkbox" />

          <span class="yt-chat-overlay-author-grid-label">Verified</span>
          <input type="color" name="color-verified" class="yt-chat-overlay-author-grid-color" />
          <input type="checkbox" name="showAuthor-verified" class="yt-chat-overlay-author-grid-checkbox" />

          <span class="yt-chat-overlay-author-grid-label">Super Chat</span>
          <span></span>
          <input type="checkbox" name="showAuthor-superChat" class="yt-chat-overlay-author-grid-checkbox" />
        </div>
      </div>
      <div class="yt-chat-overlay-settings-section">
        <div class="yt-chat-overlay-settings-section-title">Outline</div>
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
      <div class="yt-chat-overlay-settings-actions">
        <button type="button" data-action="reset">Reset</button>
        <button type="button" data-action="apply">Apply</button>
      </div>
    `;

    this.modal
      .querySelector<HTMLButtonElement>('.yt-chat-overlay-settings-close')
      ?.addEventListener('click', () => this.close());
    this.modal
      .querySelector<HTMLButtonElement>('button[data-action="apply"]')
      ?.addEventListener('click', () => this.apply());
    this.modal
      .querySelector<HTMLButtonElement>('button[data-action="reset"]')
      ?.addEventListener('click', () => this.handleReset());

    this.backdrop.appendChild(this.modal);
    document.body.appendChild(this.backdrop);
  }

  private open(): void {
    if (!this.backdrop || !this.modal) return;

    const activeElement = document.activeElement;
    this.previousFocus = activeElement instanceof HTMLElement ? activeElement : null;

    this.populateForm(this.getSettings());
    this.backdrop.style.display = 'flex';
    this.backdrop.hidden = false;
    this.backdrop.setAttribute('aria-hidden', 'false');
    document.addEventListener('keydown', this.handleKeydown);
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

  private populateForm(settings: OverlaySettings): void {
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

    this.setValue('color-normal', settings.colors.normal);
    this.setValue('color-member', settings.colors.member);
    this.setValue('color-moderator', settings.colors.moderator);
    this.setValue('color-owner', settings.colors.owner);
    this.setValue('color-verified', settings.colors.verified);

    this.setCheckbox('showAuthor-normal', settings.showAuthor.normal);
    this.setCheckbox('showAuthor-member', settings.showAuthor.member);
    this.setCheckbox('showAuthor-moderator', settings.showAuthor.moderator);
    this.setCheckbox('showAuthor-owner', settings.showAuthor.owner);
    this.setCheckbox('showAuthor-verified', settings.showAuthor.verified);
    this.setCheckbox('showAuthor-superChat', settings.showAuthor.superChat);

    this.setCheckbox('outline-enabled', settings.outline.enabled);
    this.setValue('outline-widthPx', settings.outline.widthPx);
    this.setValue('outline-blurPx', settings.outline.blurPx);
    this.setValue('outline-opacity', settings.outline.opacity);
  }

  private collectSettings(): Partial<OverlaySettings> {
    const current = this.getSettings();
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    const readNumber = (name: string, fallback: number) => {
      const input = this.getInput(name);
      if (!input) return fallback;
      const parsed = Number.parseFloat(input.value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    return {
      enabled: this.getCheckbox('enabled', current.enabled),
      speedPxPerSec: clamp(
        readNumber('speedPxPerSec', current.speedPxPerSec),
        SETTINGS_LIMITS.speedPxPerSec.min,
        SETTINGS_LIMITS.speedPxPerSec.max
      ),
      fontSize: clamp(
        readNumber('fontSize', current.fontSize),
        SETTINGS_LIMITS.fontSize.min,
        SETTINGS_LIMITS.fontSize.max
      ),
      opacity: clamp(
        readNumber('opacity', current.opacity),
        SETTINGS_LIMITS.opacity.min,
        SETTINGS_LIMITS.opacity.max
      ),
      superChatOpacity:
        clamp(
          readNumber('superChatOpacity', current.superChatOpacity * 100),
          UI_LIMITS.superChatOpacity.min,
          UI_LIMITS.superChatOpacity.max
        ) / 100,
      safeTop:
        clamp(
          readNumber('safeTop', current.safeTop * 100),
          UI_LIMITS.safeTop.min,
          UI_LIMITS.safeTop.max
        ) / 100,
      safeBottom:
        clamp(
          readNumber('safeBottom', current.safeBottom * 100),
          UI_LIMITS.safeBottom.min,
          UI_LIMITS.safeBottom.max
        ) / 100,
      maxConcurrentMessages: Math.round(
        clamp(
          readNumber('maxConcurrentMessages', current.maxConcurrentMessages),
          SETTINGS_LIMITS.maxConcurrentMessages.min,
          SETTINGS_LIMITS.maxConcurrentMessages.max
        )
      ),
      maxMessagesPerSecond: Math.round(
        clamp(
          readNumber('maxMessagesPerSecond', current.maxMessagesPerSecond),
          SETTINGS_LIMITS.maxMessagesPerSecond.min,
          SETTINGS_LIMITS.maxMessagesPerSecond.max
        )
      ),
      allowShortTextMessages: this.getCheckbox(
        'allowShortTextMessages',
        current.allowShortTextMessages
      ),
      minTextLength: Math.round(
        clamp(
          readNumber('minTextLength', current.minTextLength),
          SETTINGS_LIMITS.minTextLength.min,
          SETTINGS_LIMITS.minTextLength.max
        )
      ),
      logLevel: this.getLogLevel('logLevel', current.logLevel),
      showAuthor: {
        normal: this.getCheckbox('showAuthor-normal', current.showAuthor.normal),
        member: this.getCheckbox('showAuthor-member', current.showAuthor.member),
        moderator: this.getCheckbox('showAuthor-moderator', current.showAuthor.moderator),
        owner: this.getCheckbox('showAuthor-owner', current.showAuthor.owner),
        verified: this.getCheckbox('showAuthor-verified', current.showAuthor.verified),
        superChat: this.getCheckbox('showAuthor-superChat', current.showAuthor.superChat),
      },
      colors: {
        normal: this.getColor('color-normal', current.colors.normal),
        member: this.getColor('color-member', current.colors.member),
        moderator: this.getColor('color-moderator', current.colors.moderator),
        owner: this.getColor('color-owner', current.colors.owner),
        verified: this.getColor('color-verified', current.colors.verified),
      },
      outline: {
        enabled: this.getCheckbox('outline-enabled', current.outline.enabled),
        widthPx: clamp(
          readNumber('outline-widthPx', current.outline.widthPx),
          SETTINGS_LIMITS.outlineWidthPx.min,
          SETTINGS_LIMITS.outlineWidthPx.max
        ),
        blurPx: clamp(
          readNumber('outline-blurPx', current.outline.blurPx),
          SETTINGS_LIMITS.outlineBlurPx.min,
          SETTINGS_LIMITS.outlineBlurPx.max
        ),
        opacity: clamp(
          readNumber('outline-opacity', current.outline.opacity),
          SETTINGS_LIMITS.outlineOpacity.min,
          SETTINGS_LIMITS.outlineOpacity.max
        ),
      },
    };
  }

  private getFocusableElements(): HTMLElement[] {
    if (!this.modal) return [];

    const selectors =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

    return Array.from(this.modal.querySelectorAll<HTMLElement>(selectors)).filter((element) => {
      if (element.tabIndex < 0) return false;
      return !element.hasAttribute('hidden');
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

    if (select.value === 'warn' || select.value === 'info' || select.value === 'debug') {
      return select.value;
    }

    return fallback;
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

  /**
   * Destroy and cleanup all resources
   */
  destroy(): void {
    // Close modal and remove keydown listener
    this.close();

    // Remove button from DOM
    this.button?.remove();

    // Remove backdrop and modal from DOM
    this.backdrop?.remove();

    // Remove style element from DOM
    const styleElement = document.getElementById(STYLE_ID);
    styleElement?.remove();

    // Clear references
    this.button = null;
    this.backdrop = null;
    this.modal = null;
    this.playerElement = null;

    console.log('[SettingsUi] Destroyed');

    // Note: Constructor callback references (getSettings, updateSettings, resetSettings)
    // are readonly and will be garbage collected when this instance is no longer referenced
  }
}
