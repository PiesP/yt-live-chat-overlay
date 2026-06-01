// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { OverlaySettings } from '@app-types';
import {
  clearSafeTimeout,
  ensurePlayerPositioning,
  findPlayerContainerElement,
  PLAYER_LOOKUP_INTERVAL_MS,
} from '@core/dom';
import { getActiveLanguage, t } from '@core/i18n';
import { createLogger } from '@core/logging';
import { normalizeStoredSettings, SETTINGS_VERSION } from '@core/settings-schema';
import {
  BACKDROP_ID,
  BUTTON_ID,
  RELOAD_BUTTON_ID,
  SettingsUiForm,
  STYLE_ID,
} from '@core/settings-ui-form';
import { PANES } from '@core/settings-ui-panes';
import { SETTINGS_UI_STYLES } from '@core/settings-ui-styles';

const log = createLogger('SettingsUi');

const TOAST_DURATION_MS = 2500;

export class SettingsUi {
  private playerElement: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private reloadButton: HTMLButtonElement | null = null;
  /** Timer for reload-complete checkmark → icon restoration. */
  private reloadFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private backdrop: HTMLDivElement | null = null;
  private modal: HTMLDivElement | null = null;
  private previousFocus: HTMLElement | null = null;
  private activeTab: string;
  /** Language code that was active when the modal content was last built. */
  private modalLanguage: string | null = null;
  /** Saved body overflow before scroll lock. Restored on close/destroy. */
  private savedBodyOverflow: string | null = null;
  /** Saved body padding-right before scrollbar compensation. */
  private savedBodyPaddingRight: string | null = null;

  private get defaultTabId(): string {
    const first = PANES[0];
    return first ? first.id : 'comments';
  }

  private readonly form: SettingsUiForm;

  private readonly handleKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      this.close();
      return;
    }

    if (event.key === 'Tab' && this.backdrop && this.backdrop.style.display !== 'none') {
      this.trapFocus(event);
    }
  };

  /**
   * Check whether the settings dialog is currently visible to the user.
   */
  private isDialogOpen(): boolean {
    return this.backdrop !== null && this.backdrop.style.display !== 'none';
  }

  /**
   * Re-populate the settings form from current settings.
   * Called on cross-tab settings sync to keep the form in sync with
   * changes made in another tab. Only updates when the dialog is open.
   */
  syncForm(): void {
    if (!this.isDialogOpen()) return;
    this.form.populateForm(this.getSettings());
  }

  constructor(
    private readonly getSettings: () => Readonly<OverlaySettings>,
    private readonly onChange: (partial: Partial<OverlaySettings>) => void,
    private readonly resetSettings: () => void,
    /** Called when settings should be persisted (modal close). Falls back to onChange. */
    private readonly onPersist?: (partial: Partial<OverlaySettings>) => void,
    /** Called when the reload button is clicked. */
    private readonly onReload?: () => Promise<void>
  ) {
    this.activeTab = this.defaultTabId;
    this.form = new SettingsUiForm(getSettings, (preview) => {
      this.queuePreview(preview);
    });
  }

  /** Debounced live preview — applies settings immediately (memory only, no storage write). */
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly PREVIEW_DEBOUNCE_MS = 100;

  private queuePreview(preview: OverlaySettings): void {
    this.previewTimer = clearSafeTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      this.onChange(preview);
      // Sync form with normalized values from the settings system
      this.form.populateForm(this.getSettings());
    }, SettingsUi.PREVIEW_DEBOUNCE_MS);
  }

  async attach(): Promise<void> {
    const player = await this.findPlayerContainer();
    if (!player) return;

    if (
      this.playerElement === player &&
      this.button?.isConnected &&
      this.backdrop?.isConnected &&
      (this.reloadButton ? this.reloadButton.isConnected : true)
    ) {
      return;
    }

    this.playerElement = player;
    this.ensureButton(player);
    this.ensureModal();
    this.close();
  }

  close(): void {
    if (!this.backdrop) return;
    // Only persist form state when the dialog is actually visible.
    // attach() and destroy() call close() even when the dialog has never
    // been opened — in that case the form inputs are unpopulated and
    // collectSettings() would return minimum values (Number('') → 0),
    // corrupting saved settings on every page load / SPA navigation.
    if (!this.isDialogOpen()) {
      this.setDialogOpen(false);
      return;
    }
    // Persist current form state on close. This is the only path that
    // writes settings to storage — preview (memory only) never writes.
    // Covers: X button, Close button, Escape, backdrop click, and
    // SPA navigation (destroy() calls close()).
    if (this.previewTimer !== null) {
      this.previewTimer = clearSafeTimeout(this.previewTimer);
    }
    const persist = this.onPersist ?? this.onChange;
    persist(this.form.collectSettings());
    this.setDialogOpen(false);

    this.unlockBodyScroll();

    // Remove keydown listener to prevent accumulation across SPA navigations.
    // ensureModal() registers this listener and close() is called on modal
    // hide; destroy() also removes it as a safety net.
    document.removeEventListener('keydown', this.handleKeydown);

    if (this.previousFocus?.isConnected) {
      this.previousFocus.focus();
    }
    this.previousFocus = null;
  }

  private findPlayerContainer(): Promise<HTMLElement | null> {
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
      this.button.textContent = '\u2699';
      this.button.setAttribute('aria-label', t('Chat overlay settings'));
      this.button.title = t('Chat overlay settings');
      this.button.addEventListener('click', () => this.open());
    } else if (this.button.parentElement) {
      this.button.remove();
    }

    // Reload button — placed to the right of the settings gear button.
    // Allows users to restart the overlay runtime without a full page reload.
    if (!this.reloadButton && this.onReload) {
      this.reloadButton = document.createElement('button');
      this.reloadButton.id = RELOAD_BUTTON_ID;
      this.reloadButton.type = 'button';
      this.reloadButton.className = 'yt-chat-overlay-reload-button';
      this.reloadButton.textContent = '\u21BB';
      this.reloadButton.setAttribute('aria-label', t('Reload overlay'));
      this.reloadButton.title = t('Reload overlay');
      this.reloadButton.addEventListener('click', () => {
        this.handleReloadClick();
      });
    } else if (this.reloadButton?.parentElement) {
      this.reloadButton.remove();
    }

    ensurePlayerPositioning(player);

    player.appendChild(this.button);
    if (this.reloadButton) {
      player.appendChild(this.reloadButton);
    }
  }

  private clearReloadFeedbackTimer(): void {
    this.reloadFeedbackTimer = clearSafeTimeout(this.reloadFeedbackTimer);
  }

  private handleReloadClick(): void {
    if (!this.reloadButton) return;

    // Show immediate feedback — briefly switch to a checkmark so the user
    // knows the reload was triggered.  The runtime restart is async and
    // happens in the background; the checkmark confirms the action started.
    const icon = this.reloadButton.textContent;
    this.reloadButton.textContent = '\u2713';
    this.reloadButton.classList.add('yt-chat-overlay-reload-button--done');

    this.clearReloadFeedbackTimer();
    this.reloadFeedbackTimer = setTimeout(() => {
      this.reloadFeedbackTimer = null;
      if (this.reloadButton) {
        this.reloadButton.textContent = icon;
        this.reloadButton.classList.remove('yt-chat-overlay-reload-button--done');
      }
    }, 1500);

    void this.onReload?.();
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
  }

  /** Lock body scroll to prevent page scrolling behind the open modal.
   *  Compensates for scrollbar width to avoid layout shift. */
  private lockBodyScroll(): void {
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    this.savedBodyOverflow = document.body.style.overflow;
    this.savedBodyPaddingRight = document.body.style.paddingRight;
    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
  }

  /** Restore body scroll state saved by lockBodyScroll(). Idempotent. */
  private unlockBodyScroll(): void {
    if (this.savedBodyOverflow !== null) {
      document.body.style.overflow = this.savedBodyOverflow;
      this.savedBodyOverflow = null;
    }
    if (this.savedBodyPaddingRight !== null) {
      document.body.style.paddingRight = this.savedBodyPaddingRight;
      this.savedBodyPaddingRight = null;
    }
  }

  private bindTabEvents(): void {
    if (!this.modal) return;
    this.modal.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const tabBtn = target?.closest<HTMLButtonElement>('.yt-chat-overlay-settings-tab');
      if (tabBtn) {
        const tabId = tabBtn.dataset.tab;
        if (tabId) this.switchTab(tabId);
      }
    });
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
    if (!this.modal) return;

    // Single delegated handler for all action buttons
    this.modal.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const actionBtn = target?.closest<HTMLButtonElement>('button[data-action]');
      if (actionBtn) {
        const action = actionBtn.dataset.action;
        if (action === 'close') this.close();
        else if (action === 'reset') this.handleReset();
        else if (action === 'export') this.handleExport();
        else if (action === 'import') this.handleImport();
        return;
      }
    });

    // Delegated handler for allowShortTextMessages toggle
    this.modal.addEventListener('change', (event) => {
      const target = event.target as HTMLElement | null;
      if (target instanceof HTMLInputElement && target.name === 'allowShortTextMessages') {
        this.form.syncMinTextLengthState();
      }
    });

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
      if (event.button !== 0) return;
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
    this.modalLanguage = getActiveLanguage();

    this.backdrop.appendChild(this.modal);
    document.body.appendChild(this.backdrop);
    this.setDialogOpen(false);

    // Activate keydown listener now that modal DOM exists
    document.addEventListener('keydown', this.handleKeydown);
  }

  private open(): void {
    if (!this.backdrop || !this.modal) return;

    // Rebuild modal content when language changed — DOM strings are
    // baked at construction time so a full rebuild is required.
    if (this.modalLanguage !== getActiveLanguage()) {
      this.rebuildModalContent();
    }

    const activeElement = document.activeElement;
    this.previousFocus = activeElement instanceof HTMLElement ? activeElement : null;

    this.form.populateForm(this.getSettings());
    this.switchTab(this.activeTab);
    this.lockBodyScroll();
    this.setDialogOpen(true);
    this.focusInitialElement();
  }

  /** Rebuild modal DOM content from scratch (called on language change). */
  private rebuildModalContent(): void {
    if (!this.modal) return;
    // Clear existing content
    while (this.modal.firstChild) {
      this.modal.removeChild(this.modal.firstChild);
    }
    // Rebuild with current language.
    // Event listeners on the modal element itself (from bindModalEvents) are
    // retained — only children are replaced.
    this.modal.append(...this.form.createModalContent());
    this.form.setModal(this.modal);
    this.modalLanguage = getActiveLanguage();
  }

  /**
   * Rebuild the modal in-place when the language changes during preview.
   * Preserves the current tab and form values so the change appears seamless.
   * No storage write — only the in-memory DOM is updated.
   */
  syncLanguage(): void {
    if (!this.isDialogOpen() || !this.modal) return;
    if (this.modalLanguage === getActiveLanguage()) return;

    const savedTab = this.activeTab;
    this.rebuildModalContent();
    this.form.populateForm(this.getSettings());
    this.switchTab(savedTab);
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
    dialog.setAttribute('aria-label', t(options.message));

    const backdrop = document.createElement('div');
    backdrop.className = 'yt-chat-overlay-settings-confirm-backdrop';

    const confirmDialog = document.createElement('div');
    confirmDialog.className = 'yt-chat-overlay-settings-confirm-dialog';

    const message = document.createElement('p');
    message.className = 'yt-chat-overlay-settings-confirm-message';
    message.textContent = t(options.message);

    const buttons = document.createElement('div');
    buttons.className = 'yt-chat-overlay-settings-confirm-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'yt-chat-overlay-settings-confirm-cancel';
    cancelBtn.textContent = t('Cancel');

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'yt-chat-overlay-settings-confirm-ok';
    okBtn.textContent = t(options.confirmLabel);

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
    const json = JSON.stringify({ ...settings, _version: SETTINGS_VERSION }, null, 2);
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
            this.showToast(t('Import failed: invalid settings format'));
            log.warn('Import failed: expected a settings object');
            return;
          }

          // Strip prototype-pollution keys before passing to normalizeStoredSettings
          const sanitized: Record<string, unknown> = Object.create(null);
          for (const key of Object.keys(parsed)) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            sanitized[key] = parsed[key];
          }

          const settings = normalizeStoredSettings(sanitized);
          this.onChange(settings);
          this.form.populateForm(this.getSettings());
          const persist = this.onPersist ?? this.onChange;
          persist(settings);
          this.showToast(t('Settings imported successfully'));
        } catch (error: unknown) {
          this.showToast(t('Import failed: invalid JSON'));
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
    if (!this.backdrop || this.backdrop.style.display === 'none') {
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
    this.modal.appendChild(toast);
    setTimeout(() => toast.remove(), TOAST_DURATION_MS);
  }

  destroy(): void {
    // Explicit cleanup — does NOT persist settings. Policy: settings are
    // saved only when the user explicitly closes the dialog (Close button,
    // Escape, backdrop click). Implicit teardown from SPA navigation, page
    // refresh, or App.stop() must NOT write to storage.
    if (this.previewTimer !== null) {
      this.previewTimer = clearSafeTimeout(this.previewTimer);
    }
    this.button?.remove();
    this.reloadButton?.remove();
    this.clearReloadFeedbackTimer();
    this.backdrop?.remove();
    document.removeEventListener('keydown', this.handleKeydown);

    const styleElement = document.getElementById(STYLE_ID);
    styleElement?.remove();

    this.button = null;
    this.reloadButton = null;
    this.backdrop = null;
    this.modal = null;
    this.playerElement = null;

    log.info('Destroyed');
  }
}
