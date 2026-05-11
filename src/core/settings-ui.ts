import type { OverlaySettings } from '@app-types';
import {
  ensurePlayerPositioning,
  findPlayerContainerElement,
  PLAYER_LOOKUP_INTERVAL_MS,
} from '@core/dom';
import { createLogger } from '@core/logging';
import { BACKDROP_ID, BUTTON_ID, SettingsUiForm, STYLE_ID } from '@core/settings-ui-form';
import { SETTINGS_UI_STYLES } from '@core/settings-ui-styles';

const log = createLogger('SettingsUi');

export class SettingsUi {
  private playerElement: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private backdrop: HTMLDivElement | null = null;
  private modal: HTMLDivElement | null = null;
  private previousFocus: HTMLElement | null = null;
  private activeTab = 'comments';
  private readonly form: SettingsUiForm;

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
  ) {
    this.form = new SettingsUiForm(getSettings, (preview) => {
      this.queuePreview(preview);
    });
  }

  /** Debounced live preview — applies settings immediately but persists on close. */
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly PREVIEW_DEBOUNCE_MS = 250;

  private queuePreview(preview: OverlaySettings): void {
    if (this.previewTimer !== null) {
      clearTimeout(this.previewTimer);
    }
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      this.updateSettings(preview);
      // Sync form with normalized values from the settings system
      this.form.populateForm(this.getSettings());
    }, this.PREVIEW_DEBOUNCE_MS);
  }

  private cancelPreview(): void {
    if (this.previewTimer !== null) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
  }

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
    this.cancelPreview();
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
    style.textContent = SETTINGS_UI_STYLES;
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
    if (!this.modal) return;
    for (const btn of this.modal.querySelectorAll<HTMLButtonElement>(
      '.yt-chat-overlay-settings-tab'
    )) {
      btn.addEventListener('click', () => {
        const tabId = btn.dataset.tab;
        if (tabId) this.switchTab(tabId);
      });
    }
  }

  private switchTab(tabId: string): void {
    if (!this.modal) return;
    this.activeTab = tabId;

    for (const btn of this.modal.querySelectorAll<HTMLButtonElement>(
      '.yt-chat-overlay-settings-tab'
    )) {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
      btn.setAttribute('aria-selected', `${btn.dataset.tab === tabId}`);
    }

    for (const pane of this.modal.querySelectorAll<HTMLDivElement>(
      '.yt-chat-overlay-settings-pane'
    )) {
      pane.toggleAttribute('hidden', pane.dataset.pane !== tabId);
    }
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
      ?.addEventListener('change', () => this.form.syncMinTextLengthState());

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
    this.modal.setAttribute('aria-labelledby', 'yt-chat-overlay-settings-title');
    this.modal.append(...this.form.createModalContent());

    this.form.setModal(this.modal);
    this.bindModalEvents();

    this.backdrop.appendChild(this.modal);
    document.body.appendChild(this.backdrop);
    this.setDialogOpen(false);
  }

  private open(): void {
    if (!this.backdrop || !this.modal) return;

    const activeElement = document.activeElement;
    this.previousFocus = activeElement instanceof HTMLElement ? activeElement : null;

    // Reset apply button state from any previous close-apply cycle
    this.resetApplyButton();

    this.form.populateForm(this.getSettings());
    this.switchTab(this.activeTab);
    this.setDialogOpen(true);
    this.focusInitialElement();
  }

  /**
   * Reset the apply button to its initial state so it's interactive
   * when the modal is reopened after a previous apply-then-close cycle.
   */
  private resetApplyButton(): void {
    const applyButton = this.modal?.querySelector<HTMLButtonElement>('button[data-action="apply"]');
    if (applyButton) {
      applyButton.textContent = 'Done';
      applyButton.disabled = false;
    }
  }

  private apply(): void {
    // Settings are already applied via live preview.
    // Show brief save confirmation, then close.
    const applyButton = this.modal?.querySelector<HTMLButtonElement>('button[data-action="apply"]');
    if (applyButton) {
      applyButton.textContent = '✓ Saved';
      applyButton.disabled = true;
    }
    setTimeout(() => this.close(), 400);
  }

  private handleReset(): void {
    if (!window.confirm('Reset all settings to defaults?')) {
      return;
    }
    this.resetSettings();
    this.form.populateForm(this.getSettings());
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

    const [first] = this.form.getFocusableElements();
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

    const focusableElements = this.form.getFocusableElements();
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

  destroy(): void {
    this.close();
    this.cancelPreview();
    this.button?.remove();
    this.backdrop?.remove();

    const styleElement = document.getElementById(STYLE_ID);
    styleElement?.remove();

    this.button = null;
    this.backdrop = null;
    this.modal = null;
    this.playerElement = null;

    log.info('Destroyed');
  }
}
