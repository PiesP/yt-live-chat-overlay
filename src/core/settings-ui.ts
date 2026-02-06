import type { OverlaySettings } from '@app-types';
import { isVisibleElement, PLAYER_CONTAINER_SELECTORS, waitForElementMatch } from '@core/dom';

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
          top: 8px;
          right: 8px;
          width: 32px;
          height: 32px;
          border-radius: 6px;
          border: 1px solid rgba(255, 255, 255, 0.25);
          background: rgba(0, 0, 0, 0.6);
          color: #fff;
          font-size: 16px;
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
          z-index: 9999;
        }
        .yt-chat-overlay-settings-modal {
          width: 380px;
          max-height: 82vh;
          overflow: auto;
          background: rgba(20, 20, 20, 0.96);
          color: #fff;
          border-radius: 10px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 14px;
          font-family: system-ui, -apple-system, sans-serif;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
        }
        .yt-chat-overlay-settings-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-weight: 700;
          font-size: 16px;
        }
        .yt-chat-overlay-settings-close {
          border: none;
          background: transparent;
          color: #fff;
          font-size: 18px;
          cursor: pointer;
        }
        .yt-chat-overlay-settings-section {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .yt-chat-overlay-settings-section-title {
          font-size: 13px;
          color: rgba(255, 255, 255, 0.7);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .yt-chat-overlay-settings-field {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          font-size: 14px;
        }
        .yt-chat-overlay-settings-field input[type="number"] {
          width: 110px;
          padding: 4px 6px;
          border-radius: 6px;
          border: 1px solid rgba(255, 255, 255, 0.2);
          background: rgba(0, 0, 0, 0.4);
          color: #fff;
        }
        .yt-chat-overlay-settings-field input[type="color"] {
          width: 48px;
          height: 28px;
          border: none;
          background: transparent;
          padding: 0;
        }
        .yt-chat-overlay-settings-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          padding-top: 4px;
        }
        .yt-chat-overlay-settings-actions button {
          border: none;
          border-radius: 6px;
          padding: 6px 12px;
          cursor: pointer;
          font-weight: 600;
        }
        .yt-chat-overlay-settings-actions button[data-action="reset"] {
          background: rgba(255, 255, 255, 0.15);
          color: #fff;
        }
        .yt-chat-overlay-settings-actions button[data-action="apply"] {
          background: #3ea6ff;
          color: #111;
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
          <input type="number" name="speedPxPerSec" min="120" max="500" step="5" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Font size (px)</span>
          <input type="number" name="fontSize" min="16" max="48" step="1" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Opacity</span>
          <input type="number" name="opacity" min="0.4" max="1" step="0.02" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Safe top (%)</span>
          <input type="number" name="safeTop" min="0" max="30" step="0.5" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Safe bottom (%)</span>
          <input type="number" name="safeBottom" min="0" max="30" step="0.5" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Max concurrent</span>
          <input type="number" name="maxConcurrentMessages" min="5" max="60" step="1" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Max messages/s</span>
          <input type="number" name="maxMessagesPerSecond" min="1" max="20" step="1" />
        </label>
      </div>
      <div class="yt-chat-overlay-settings-section">
        <div class="yt-chat-overlay-settings-section-title">Colors</div>
        <label class="yt-chat-overlay-settings-field">
          <span>Normal</span>
          <input type="color" name="color-normal" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Member</span>
          <input type="color" name="color-member" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Moderator</span>
          <input type="color" name="color-moderator" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Owner</span>
          <input type="color" name="color-owner" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Verified</span>
          <input type="color" name="color-verified" />
        </label>
      </div>
      <div class="yt-chat-overlay-settings-section">
        <div class="yt-chat-overlay-settings-section-title">Outline</div>
        <label class="yt-chat-overlay-settings-field">
          <span>Enabled</span>
          <input type="checkbox" name="outline-enabled" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Width (px)</span>
          <input type="number" name="outline-widthPx" min="0" max="6" step="0.5" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Blur (px)</span>
          <input type="number" name="outline-blurPx" min="0" max="10" step="0.5" />
        </label>
        <label class="yt-chat-overlay-settings-field">
          <span>Opacity</span>
          <input type="number" name="outline-opacity" min="0" max="1" step="0.05" />
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
    this.setValue('safeTop', (settings.safeTop * 100).toFixed(1));
    this.setValue('safeBottom', (settings.safeBottom * 100).toFixed(1));
    this.setValue('maxConcurrentMessages', settings.maxConcurrentMessages);
    this.setValue('maxMessagesPerSecond', settings.maxMessagesPerSecond);

    this.setValue('color-normal', settings.colors.normal);
    this.setValue('color-member', settings.colors.member);
    this.setValue('color-moderator', settings.colors.moderator);
    this.setValue('color-owner', settings.colors.owner);
    this.setValue('color-verified', settings.colors.verified);

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
      speedPxPerSec: clamp(readNumber('speedPxPerSec', current.speedPxPerSec), 120, 500),
      fontSize: clamp(readNumber('fontSize', current.fontSize), 16, 48),
      opacity: clamp(readNumber('opacity', current.opacity), 0.4, 1),
      safeTop: clamp(readNumber('safeTop', current.safeTop * 100), 0, 30) / 100,
      safeBottom: clamp(readNumber('safeBottom', current.safeBottom * 100), 0, 30) / 100,
      maxConcurrentMessages: Math.round(
        clamp(readNumber('maxConcurrentMessages', current.maxConcurrentMessages), 5, 60)
      ),
      maxMessagesPerSecond: Math.round(
        clamp(readNumber('maxMessagesPerSecond', current.maxMessagesPerSecond), 1, 20)
      ),
      colors: {
        normal: this.getColor('color-normal', current.colors.normal),
        member: this.getColor('color-member', current.colors.member),
        moderator: this.getColor('color-moderator', current.colors.moderator),
        owner: this.getColor('color-owner', current.colors.owner),
        verified: this.getColor('color-verified', current.colors.verified),
      },
      outline: {
        enabled: this.getCheckbox('outline-enabled', current.outline.enabled),
        widthPx: clamp(readNumber('outline-widthPx', current.outline.widthPx), 0, 6),
        blurPx: clamp(readNumber('outline-blurPx', current.outline.blurPx), 0, 10),
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
}
