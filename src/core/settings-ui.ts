import type { OverlaySettings } from '@app-types';
import {
  ensurePlayerPositioning,
  findPlayerContainerElement,
  PLAYER_LOOKUP_INTERVAL_MS,
} from '@core/dom';
import { createLogger } from '@core/logging';
import { normalizeStoredSettings } from '@core/settings-schema';
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
    private readonly onChange: (partial: Partial<OverlaySettings>) => void,
    private readonly resetSettings: () => void,
    /** Called when settings should be persisted (modal close). Falls back to onChange. */
    private readonly onPersist?: (partial: Partial<OverlaySettings>) => void
  ) {
    this.form = new SettingsUiForm(getSettings, (preview) => {
      this.queuePreview(preview);
    });
  }

  /** Debounced live preview — applies settings immediately and persists. */
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly PREVIEW_DEBOUNCE_MS = 250;

  private queuePreview(preview: OverlaySettings): void {
    if (this.previewTimer !== null) {
      clearTimeout(this.previewTimer);
    }
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      this.onChange(preview);
      // Sync form with normalized values from the settings system
      this.form.populateForm(this.getSettings());
    }, this.PREVIEW_DEBOUNCE_MS);
  }

  async attach(): Promise<void> {
    const player = await this.findPlayerContainer();
    if (!player) return;

    if (this.playerElement === player && this.button?.isConnected && this.backdrop?.isConnected) {
      return;
    }

    this.playerElement = player;
    this.ensureButton(player);
    this.ensureModal();
    this.close();
  }

  close(): void {
    if (!this.backdrop) return;
    // Persist any pending preview changes
    if (this.previewTimer !== null) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
      const persist = this.onPersist ?? this.onChange;
      persist(this.form.collectSettings());
    }
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
    this.backdrop.setAttribute('aria-hidden', isOpen ? 'false' : 'true');

    if (isOpen) {
      if (!this.keydownBound) {
        document.addEventListener('keydown', this.handleKeydown);
        this.keydownBound = true;
      }
      return;
    }
    if (this.keydownBound) {
      document.removeEventListener('keydown', this.handleKeydown);
      this.keydownBound = false;
    }
  }

  private keydownBound = false;

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
      ?.querySelector<HTMLButtonElement>('button[data-action="close"]')
      ?.addEventListener('click', () => this.apply());
    this.modal
      ?.querySelector<HTMLButtonElement>('button[data-action="reset"]')
      ?.addEventListener('click', () => this.handleReset());

    this.modal
      ?.querySelector<HTMLButtonElement>('button[data-action="export"]')
      ?.addEventListener('click', () => this.handleExport());
    this.modal
      ?.querySelector<HTMLButtonElement>('button[data-action="import"]')
      ?.addEventListener('click', () => this.handleImport());

    this.modal
      ?.querySelector<HTMLInputElement>('input[name="allowShortTextMessages"]')
      ?.addEventListener('change', () => this.form.syncMinTextLengthState());

    this.bindTabEvents();
  }

  private ensureModal(): void {
    this.ensureStyles();

    if (this.backdrop?.isConnected) return;

    // Clean up previously detached DOM elements so they can be garbage-collected
    this.backdrop?.remove();
    this.backdrop = null;
    this.modal = null;

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

    this.form.populateForm(this.getSettings());
    this.switchTab(this.activeTab);
    this.setDialogOpen(true);
    this.focusInitialElement();
  }

  /**
   * Close button handler — persists preview settings and closes the modal.
   */
  private apply(): void {
    this.close();
  }

  /** Create a reusable confirmation dialog overlay for destructive actions. */
  private createConfirmDialog(options: {
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  }): HTMLDivElement {
    const dialog = document.createElement('div');
    dialog.className = 'yt-chat-overlay-settings-confirm';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', options.message);

    const backdrop = document.createElement('div');
    backdrop.className = 'yt-chat-overlay-settings-confirm-backdrop';

    const confirmDialog = document.createElement('div');
    confirmDialog.className = 'yt-chat-overlay-settings-confirm-dialog';

    const message = document.createElement('p');
    message.className = 'yt-chat-overlay-settings-confirm-message';
    message.textContent = options.message;

    const buttons = document.createElement('div');
    buttons.className = 'yt-chat-overlay-settings-confirm-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'yt-chat-overlay-settings-confirm-cancel';
    cancelBtn.textContent = 'Cancel';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'yt-chat-overlay-settings-confirm-ok';
    okBtn.textContent = options.confirmLabel;

    buttons.append(cancelBtn, okBtn);
    confirmDialog.append(message, buttons);
    dialog.append(backdrop, confirmDialog);

    cancelBtn.addEventListener('click', () => dialog.remove());
    okBtn.addEventListener('click', () => {
      dialog.remove();
      options.onConfirm();
    });

    cancelBtn.focus();
    return dialog;
  }

  private handleReset(): void {
    if (!this.modal) return;

    const existing = this.modal.querySelector('.yt-chat-overlay-settings-confirm');
    if (existing) existing.remove();

    const dialog = this.createConfirmDialog({
      message: 'Reset all settings to defaults?',
      confirmLabel: 'Reset',
      onConfirm: () => {
        this.resetSettings();
        this.form.populateForm(this.getSettings());
      },
    });

    this.modal.appendChild(dialog);
  }

  private handleExport(): void {
    const settings = this.getSettings();
    const json = JSON.stringify(settings, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'yt-chat-overlay-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  private handleImport(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        try {
          const text = reader.result;
          if (typeof text !== 'string') return;
          const parsed = JSON.parse(text) as Record<string, unknown>;
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            this.showToast('Import failed: invalid settings format');
            log.warn('Import failed: expected a settings object');
            return;
          }

          // Strip prototype-pollution keys before passing to normalizeStoredSettings
          const sanitized: Record<string, unknown> = {};
          for (const key of Object.keys(parsed)) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            sanitized[key] = parsed[key];
          }

          const settings = normalizeStoredSettings(sanitized);
          this.onChange(settings);
          this.form.populateForm(this.getSettings());
          const persist = this.onPersist ?? this.onChange;
          persist(settings);
          this.showToast('Settings imported successfully');
        } catch (error) {
          this.showToast('Import failed: invalid JSON');
          log.warn('Import failed: invalid JSON file', error);
        }
      });
      reader.readAsText(file);
    });
    input.click();
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

  /** Show a transient toast notification in the settings modal. */
  private showToast(message: string): void {
    if (!this.modal) return;
    const existing = this.modal.querySelector('.yt-chat-overlay-settings-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'yt-chat-overlay-settings-toast';
    toast.textContent = message;
    toast.style.cssText =
      'position:absolute;bottom:60px;left:50%;transform:translateX(-50%);' +
      'background:rgba(0,0,0,0.85);color:#fff;font:12px/1.4 sans-serif;' +
      'padding:6px 14px;border-radius:6px;z-index:2;pointer-events:none;' +
      'animation:yt-overlay-fade-in 0.15s ease-out';
    this.modal.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }

  destroy(): void {
    this.close();
    this.button?.remove();
    this.backdrop?.remove();
    document.removeEventListener('keydown', this.handleKeydown);

    const styleElement = document.getElementById(STYLE_ID);
    styleElement?.remove();

    this.button = null;
    this.backdrop = null;
    this.modal = null;
    this.playerElement = null;
    this.keydownBound = false;

    log.info('Destroyed');
  }
}
