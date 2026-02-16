import type { OverlaySettings } from '@app-types';
import { isVisibleElement, PLAYER_CONTAINER_SELECTORS, waitForElementMatch } from '@core/dom';
import { borderRadius, colors, shadows, spacing, typography, zIndex } from './design-tokens.js';

const STYLE_ID = 'yt-chat-overlay-settings-style';
const BUTTON_ID = 'yt-chat-overlay-settings-button';
const BACKDROP_ID = 'yt-chat-overlay-settings-backdrop';

export class SettingsUi {
  private playerElement: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private backdrop: HTMLDivElement | null = null;
  private modal: HTMLDivElement | null = null;

  private readonly handleKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      this.close();
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
    document.removeEventListener('keydown', this.handleKeydown);
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
      this.button.parentElement.removeChild(this.button);
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
    this.backdrop.addEventListener('click', (event) => {
      if (event.target === this.backdrop) {
        this.close();
      }
    });

    this.modal = document.createElement('div');
    this.modal.className = 'yt-chat-overlay-settings-modal';
    this.modal.innerHTML = `
      <div class="yt-chat-overlay-settings-header">
        <div>Chat Overlay Settings</div>
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
          <input type="number" name="speedPxPerSec" min="100" max="400" step="10" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Font size (px)</span>
          <input type="number" name="fontSize" min="18" max="40" step="2" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Opacity</span>
          <input type="number" name="opacity" min="0.5" max="1" step="0.05" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Super Chat color opacity (%)</span>
          <input type="number" name="superChatOpacity" min="40" max="100" step="5" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Safe top (%)</span>
          <input type="number" name="safeTop" min="0" max="25" step="1" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Safe bottom (%)</span>
          <input type="number" name="safeBottom" min="0" max="25" step="1" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Warning threshold</span>
          <input
            type="number"
            name="maxConcurrentMessages"
            min="30"
            max="100"
            step="10"
            title="Performance warning threshold (not enforced)"
          />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Max messages/s</span>
          <input
            type="number"
            name="maxMessagesPerSecond"
            min="5"
            max="20"
            step="1"
            title="Rate limit for new messages (enforced)"
          />
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
          <input type="number" name="outline-widthPx" min="0" max="5" step="0.5" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Blur (px)</span>
          <input type="number" name="outline-blurPx" min="0" max="8" step="0.5" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Opacity</span>
          <input type="number" name="outline-opacity" min="0" max="1" step="0.1" />
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
    if (!this.backdrop) return;
    this.populateForm(this.getSettings());
    this.backdrop.style.display = 'flex';
    this.backdrop.hidden = false;
    document.addEventListener('keydown', this.handleKeydown);
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
      speedPxPerSec: clamp(readNumber('speedPxPerSec', current.speedPxPerSec), 100, 400),
      fontSize: clamp(readNumber('fontSize', current.fontSize), 18, 40),
      opacity: clamp(readNumber('opacity', current.opacity), 0.5, 1),
      superChatOpacity:
        clamp(readNumber('superChatOpacity', current.superChatOpacity * 100), 40, 100) / 100,
      safeTop: clamp(readNumber('safeTop', current.safeTop * 100), 0, 25) / 100,
      safeBottom: clamp(readNumber('safeBottom', current.safeBottom * 100), 0, 25) / 100,
      maxConcurrentMessages: Math.round(
        clamp(readNumber('maxConcurrentMessages', current.maxConcurrentMessages), 30, 100)
      ),
      maxMessagesPerSecond: Math.round(
        clamp(readNumber('maxMessagesPerSecond', current.maxMessagesPerSecond), 5, 20)
      ),
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
        widthPx: clamp(readNumber('outline-widthPx', current.outline.widthPx), 0, 5),
        blurPx: clamp(readNumber('outline-blurPx', current.outline.blurPx), 0, 8),
        opacity: clamp(readNumber('outline-opacity', current.outline.opacity), 0, 1),
      },
    };
  }

  private getInput(name: string): HTMLInputElement | null {
    return this.modal?.querySelector<HTMLInputElement>(`input[name="${name}"]`) ?? null;
  }

  private getCheckbox(name: string, fallback: boolean): boolean {
    const input = this.getInput(name);
    return input ? input.checked : fallback;
  }

  private getColor(name: string, fallback: string): string {
    const input = this.getInput(name);
    return input?.value || fallback;
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

  /**
   * Destroy settings UI and clean up all resources
   */
  destroy(): void {
    // Close modal and remove keydown listener
    this.close();

    // Remove button from DOM
    if (this.button) {
      if (this.button.parentElement) {
        this.button.parentElement.removeChild(this.button);
      }
      this.button = null;
    }

    // Remove backdrop and modal from DOM
    if (this.backdrop) {
      if (this.backdrop.parentElement) {
        this.backdrop.parentElement.removeChild(this.backdrop);
      }
      this.backdrop = null;
    }
    this.modal = null;

    // Remove style element from DOM
    const styleElement = document.getElementById(STYLE_ID);
    if (styleElement) {
      styleElement.remove();
    }

    this.playerElement = null;

    // Note: Constructor callback references (getSettings, updateSettings, resetSettings)
    // are readonly and cannot be cleared. They will be garbage collected when this
    // SettingsUi instance is no longer referenced.
  }
}
