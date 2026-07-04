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
  type ActionType,
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
const RELOAD_FEEDBACK_DURATION_MS = 1500;

export class SettingsUi {
  /** Popover API feature detection — checked once at construction. */
  private static readonly supportsHints: boolean =
    typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;

  private static readonly SETTINGS_TOOLTIP_ID = 'yt-chat-overlay-settings-tooltip';
  private static readonly RELOAD_TOOLTIP_ID = 'yt-chat-overlay-reload-tooltip';

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
  private _backdropClickHandler: ((event: MouseEvent) => void) | null = null;
  /** Element focused before confirm dialog opened; restored on close. */
  private confirmPreviousFocus: HTMLElement | null = null;
  /** Keydown handler bound to confirm dialog for focus trap + ESC. */
  private confirmKeydownHandler: ((event: KeyboardEvent) => void) | null = null;

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
    this.form = new SettingsUiForm(getSettings, () => {
      this.queuePreview();
    });
  }

  /** Debounced live preview — applies settings immediately (memory only, no storage write). */
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly PREVIEW_DEBOUNCE_MS = 100;

  private queuePreview(): void {
    this.previewTimer = clearSafeTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      const preview = this.form.collectSettings();
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
    this.restoreDocumentLangDir();

    // Remove keydown listener to prevent accumulation across SPA navigations.
    // ensureModal() registers this listener and close() is called on modal
    // hide; destroy() also removes it as a safety net.
    // Must use capture=true to match the addEventListener call in ensureModal().
    document.removeEventListener('keydown', this.handleKeydown, true);

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
      // Native Popover API tooltip with interestfor (Chrome 133+).
      // Falls back to traditional title attribute on unsupported browsers.
      if (SettingsUi.supportsHints) {
        this.button.setAttribute('interestfor', SettingsUi.SETTINGS_TOOLTIP_ID);
      } else {
        this.button.title = t('Chat overlay settings');
      }
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
      // Native Popover API tooltip with interestfor (Chrome 133+).
      // Falls back to traditional title attribute on unsupported browsers.
      if (SettingsUi.supportsHints) {
        this.reloadButton.setAttribute('interestfor', SettingsUi.RELOAD_TOOLTIP_ID);
      } else {
        this.reloadButton.title = t('Reload overlay');
      }
      this.reloadButton.addEventListener('click', () => {
        this.handleReloadClick();
      });
    } else if (this.reloadButton?.parentElement) {
      this.reloadButton.remove();
    }

    ensurePlayerPositioning(player);

    // Append popover tooltip elements when supported
    if (SettingsUi.supportsHints) {
      this.ensureTooltips(player);
    }

    player.appendChild(this.button);
    if (this.reloadButton) {
      player.appendChild(this.reloadButton);
    }
  }

  /** Create popover tooltip elements for settings and reload buttons. */
  private ensureTooltips(container: HTMLElement): void {
    const existingSettingsTip = document.getElementById(SettingsUi.SETTINGS_TOOLTIP_ID);
    if (!existingSettingsTip) {
      const settingsTip = document.createElement('div');
      settingsTip.id = SettingsUi.SETTINGS_TOOLTIP_ID;
      settingsTip.className = 'yt-chat-overlay-tooltip';
      settingsTip.setAttribute('popover', 'hint');
      settingsTip.textContent = t('Chat overlay settings');
      container.appendChild(settingsTip);
    }

    const existingReloadTip = document.getElementById(SettingsUi.RELOAD_TOOLTIP_ID);
    if (!existingReloadTip) {
      const reloadTip = document.createElement('div');
      reloadTip.id = SettingsUi.RELOAD_TOOLTIP_ID;
      reloadTip.className = 'yt-chat-overlay-tooltip';
      reloadTip.setAttribute('popover', 'hint');
      reloadTip.textContent = t('Reload overlay');
      container.appendChild(reloadTip);
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
    // Capture the original icon as a constant so rapid double-clicks don't
    // capture the checkmark itself and get stuck on ✓ permanently.
    this.reloadButton.textContent = '\u2713';
    this.reloadButton.classList.add('yt-chat-overlay-reload-button--done');

    this.clearReloadFeedbackTimer();
    this.reloadFeedbackTimer = setTimeout(() => {
      this.reloadFeedbackTimer = null;
      if (this.reloadButton) {
        this.reloadButton.textContent = '\u21BB';
        this.reloadButton.classList.remove('yt-chat-overlay-reload-button--done');
      }
    }, RELOAD_FEEDBACK_DURATION_MS);

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
        const action = actionBtn.dataset.action as ActionType | undefined;
        switch (action) {
          case 'close':
            this.close();
            break;
          case 'reset':
            this.handleReset();
            break;
          case 'export':
            this.handleExport();
            break;
          case 'import':
            this.handleImport();
            break;
        }
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
    this._backdropClickHandler = (event: MouseEvent) => {
      // Only respond to genuine left-button mouse clicks. Touch events
      // generate synthetic MouseEvent with button === 0 but detail === 0;
      // filtering detail === 0 prevents accidental modal dismissal from
      // touch scrolls/taps that trigger synthetic click events.
      if (event.button !== 0) return;
      if (event.detail === 0) return;
      if (event.target === this.backdrop) {
        this.close();
      }
    };
    this.backdrop.addEventListener('click', this._backdropClickHandler);

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

    // Activate keydown listener now that modal DOM exists.
    // Use capture phase so ESC fires before any page-level handlers and
    // the focus trap's Tab handler intercepts keys before YouTube's own listeners.
    document.addEventListener('keydown', this.handleKeydown, true);
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
    this.updateDocumentLangDir();
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
    this.updateDocumentLangDir();
  }

  /** Update the settings modal's lang and dir to match the active language.
   *  Arabic ('ar') is RTL; all other supported languages are LTR.
   *  Scoped to .yt-chat-overlay-settings-modal rather than
   *  document.documentElement so the direction change does not affect the
   *  entire YouTube page layout. */
  private updateDocumentLangDir(): void {
    if (!this.modal) return;
    const lang = getActiveLanguage();
    this.modal.lang = lang;
    this.modal.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }

  /** Restore modal lang/dir to default. No-op since we never touched the document root. */
  private restoreDocumentLangDir(): void {
    if (!this.modal) return;
    this.modal.lang = '';
    this.modal.dir = '';
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
    const messageId = 'yt-chat-overlay-confirm-msg';
    message.className = 'yt-chat-overlay-settings-confirm-message';
    message.textContent = t(options.message);
    message.id = messageId;
    dialog.setAttribute('aria-describedby', messageId);

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

    // Save focus before opening confirm dialog; restore on close
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.confirmPreviousFocus = previouslyFocused;

    const closeDialog = () => {
      // Remove ESC / Tab handler
      if (this.confirmKeydownHandler) {
        document.removeEventListener('keydown', this.confirmKeydownHandler, true);
        this.confirmKeydownHandler = null;
      }
      dialog.remove();
      // Restore focus to element that was active before confirm opened
      if (this.confirmPreviousFocus?.isConnected) {
        this.confirmPreviousFocus.focus();
      }
      this.confirmPreviousFocus = null;
    };

    // Focus trap + ESC handler (capture phase so it fires before the
    // parent modal's keydown listener and prevents Escape from closing
    // the parent modal while the confirm dialog is open).
    this.confirmKeydownHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeDialog();
        return;
      }
      if (event.key === 'Tab') {
        // Trap focus within confirm dialog buttons
        const focusableInDialog = [cancelBtn, okBtn];
        const first = focusableInDialog[0];
        const last = focusableInDialog[focusableInDialog.length - 1];
        if (!first || !last) {
          event.preventDefault();
          return;
        }
        const active = document.activeElement;
        if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', this.confirmKeydownHandler, true);

    cancelBtn.addEventListener('click', () => closeDialog());
    okBtn.addEventListener('click', () => {
      closeDialog();
      options.onConfirm();
    });

    cancelBtn.focus();
    return dialog;
  }

  private handleReset(): void {
    if (!this.modal) return;

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
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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

    // Focus the active tab button first — this gives screen reader users
    // context about which tab panel they're in. Fall back to close button,
    // then first focusable element, then the modal itself.
    const activeTabBtn = this.modal.querySelector<HTMLButtonElement>(
      '.yt-chat-overlay-settings-tab.active'
    );
    if (activeTabBtn) {
      activeTabBtn.focus();
      return;
    }

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
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  private showToast(message: string, isError = false): void {
    if (!this.modal) return;
    const existing = this.modal.querySelector('.yt-chat-overlay-settings-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'yt-chat-overlay-settings-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', isError ? 'assertive' : 'polite');
    toast.textContent = message;
    this.modal.appendChild(toast);
    this.toastTimer = clearSafeTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      toast.remove();
      this.toastTimer = null;
    }, TOAST_DURATION_MS);
  }

  destroy(): void {
    // Close dialog first to persist settings and restore scroll lock
    // if it was open (e.g., SPA navigation while dialog is visible).
    if (this.isDialogOpen()) {
      this.close();
    }
    if (this.previewTimer !== null) {
      this.previewTimer = clearSafeTimeout(this.previewTimer);
    }
    this.button?.remove();
    this.reloadButton?.remove();
    this.clearReloadFeedbackTimer();
    this.toastTimer = clearSafeTimeout(this.toastTimer);
    if (this.backdrop && this._backdropClickHandler) {
      this.backdrop.removeEventListener('click', this._backdropClickHandler);
      this._backdropClickHandler = null;
    }
    this.backdrop?.remove();
    document.removeEventListener('keydown', this.handleKeydown, true);
    this.restoreDocumentLangDir();

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
