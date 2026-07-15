// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { OverlaySettings } from '@app-types';
import { getActiveLanguage, t } from '@i18n/index';
import { normalizeStoredSettings, SETTINGS_VERSION } from '@settings/schema';
import {
  type ActionType,
  BACKDROP_ID,
  BUTTON_ID,
  RELOAD_BUTTON_ID,
  SettingsUiForm,
  STYLE_ID,
} from '@settings/ui/form';
import { PANES } from '@settings/ui/panes';
import { SETTINGS_UI_STYLES } from '@settings/ui/styles';
import {
  clearSafeTimeout,
  ensurePlayerPositioning,
  findPlayerContainerElement,
  PLAYER_LOOKUP_INTERVAL_MS,
} from '@util/dom';
import { createLogger } from '@util/logging';

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
  private modal: HTMLDialogElement | null = null;
  private previousFocus: HTMLElement | null = null;
  private activeTab: string;
  /** Language code that was active when the modal content was last built. */
  private modalLanguage: string | null = null;
  /** Element focused before confirm dialog opened; restored on close. */
  private confirmPreviousFocus: HTMLElement | null = null;
  /** Guard against re-entrant close() calls from the native dialog 'close' event. */
  private closing = false;

  private get defaultTabId(): string {
    const first = PANES[0];
    return first ? first.id : 'comments';
  }

  private readonly form: SettingsUiForm;

  /**
   * Check whether the settings dialog is currently visible to the user.
   * Uses the native dialog `open` property for accurate state.
   */
  private isDialogOpen(): boolean {
    return this.modal?.open === true;
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
      this.modal?.isConnected &&
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
    if (!this.modal) return;

    // Guard against re-entry from the native dialog's 'close' event
    // (fires synchronously inside this.modal.close()).
    if (this.closing) return;
    this.closing = true;

    // Only persist form state when the dialog is actually visible.
    // attach() and destroy() call close() even when the dialog has never
    // been opened — in that case the form inputs are unpopulated and
    // collectSettings() would return minimum values (Number('') → 0),
    // corrupting saved settings on every page load / SPA navigation.
    if (!this.modal.open) {
      this.closing = false;
      return;
    }
    // Persist current form state on close. This is the only path that
    // writes settings to storage — preview (memory only) never writes.
    // Covers: X button, Close button, Escape (cancel event), and
    // SPA navigation (destroy() calls close()).
    if (this.previewTimer !== null) {
      this.previewTimer = clearSafeTimeout(this.previewTimer);
    }
    const persist = this.onPersist ?? this.onChange;
    persist(this.form.collectSettings());

    // Close the native dialog (fires 'close' event synchronously, but
    // the closing guard prevents re-entry).
    this.modal.close();

    this.restoreDocumentLangDir();

    if (this.previousFocus?.isConnected) {
      this.previousFocus.focus();
    }
    this.previousFocus = null;
    this.closing = false;
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
      // commandfor Invoker Commands (Chrome 134+) as progressive enhancement.
      // When supported, lets the settings button open the native dialog declaratively
      // without JavaScript. Falls back to the click handler above.
      if ('commandFor' in HTMLElement.prototype) {
        this.button.setAttribute('commandfor', BACKDROP_ID);
        this.button.setAttribute('command', 'show-modal');
      }
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
    // CSP NOTE: style.textContent may violate strict style-src in MV3
    // extension context. A future improvement should use
    // CSSStyleSheet.insertRule() or Constructable Stylesheets
    // (new CSSStyleSheet()) to inject styles without inline content,
    // bypassing style-src restrictions entirely.
    style.textContent = SETTINGS_UI_STYLES;
    document.head.appendChild(style);
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

    if (this.modal?.isConnected) return;

    // Clean up previously detached DOM elements so they can be garbage-collected
    this.modal?.remove();
    this.modal = null;

    this.modal = document.createElement('dialog');
    this.modal.id = BACKDROP_ID;
    this.modal.className = 'yt-chat-overlay-settings-modal';
    // autocomplete="off" prevents password managers (Bitwarden, 1Password, etc.)
    // from scanning the settings form inputs as credential fields.
    this.modal.setAttribute('autocomplete', 'off');
    // closedby="any" enables light dismiss via backdrop click (Chrome 133+)
    // and ESC, both handled natively by the dialog element.
    this.modal.setAttribute('closedby', 'any');
    this.modal.setAttribute('aria-labelledby', 'yt-chat-overlay-settings-title');
    this.modal.setAttribute('aria-modal', 'true');
    this.modal.append(...this.form.createModalContent());

    this.form.setModal(this.modal);
    this.bindModalEvents();
    this.modalLanguage = getActiveLanguage();

    // When the user presses Escape, the native dialog fires a 'cancel'
    // event. We intercept it, prevent the default UA close, and call
    // our custom close() which persists settings first.
    this.modal.addEventListener('cancel', (event: Event) => {
      event.preventDefault();
      this.close();
    });

    // Handle native dialog close from backdrop click (closedby="any").
    // The browser fires 'close' (not 'cancel') for light dismiss.
    // At this point modal.open is already false, so we bypass the guard
    // in close() and persist directly.
    this.modal.addEventListener('close', () => {
      if (this.closing) return;
      // Only handle backdrop-initiated closes — our own code sets closing=true
      // before calling modal.close(), which would re-enter here harmlessly.
      this.closing = true;
      if (this.previewTimer !== null) {
        this.previewTimer = clearSafeTimeout(this.previewTimer);
      }
      const persist = this.onPersist ?? this.onChange;
      persist(this.form.collectSettings());
      this.restoreDocumentLangDir();
      if (this.previousFocus?.isConnected) {
        this.previousFocus.focus();
      }
      this.previousFocus = null;
      this.closing = false;
    });

    document.body.appendChild(this.modal);
  }

  private open(): void {
    if (!this.modal) return;

    // Rebuild modal content when language changed — DOM strings are
    // baked at construction time so a full rebuild is required.
    if (this.modalLanguage !== getActiveLanguage()) {
      this.rebuildModalContent();
    }

    const activeElement = document.activeElement;
    this.previousFocus = activeElement instanceof HTMLElement ? activeElement : null;

    this.form.populateForm(this.getSettings());
    this.switchTab(this.activeTab);
    // showModal() opens the dialog in the top layer with native backdrop,
    // automatic focus trap, scroll lock, and inert handling.
    this.modal.showModal();
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

  /** Create a reusable confirmation dialog for destructive actions using native <dialog>. */
  private createConfirmDialog(options: {
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  }): HTMLDialogElement {
    const dialog = document.createElement('dialog');
    dialog.className = 'yt-chat-overlay-settings-confirm';
    dialog.setAttribute('aria-label', t(options.message));

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
    dialog.append(message, buttons);

    // Save focus before opening confirm dialog; restore on close
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.confirmPreviousFocus = previouslyFocused;

    const closeDialog = () => {
      dialog.close();
      dialog.remove();
      // Restore focus to element that was active before confirm opened
      if (this.confirmPreviousFocus?.isConnected) {
        this.confirmPreviousFocus.focus();
      }
      this.confirmPreviousFocus = null;
    };

    // Native dialog handles ESC and focus trap automatically.
    // Clean up on close (covers ESC, backdrop click, and manual close).
    dialog.addEventListener('close', () => {
      closeDialog();
    });

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

    // Append to body and use showModal() so it stacks on top of the
    // settings dialog in the top layer.
    document.body.appendChild(dialog);
    dialog.showModal();
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
    input.autocomplete = 'off';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      // Clean up the transient <input> element now that we have the file handle.
      // It was never appended to the DOM but keeping it alive in memory leaks.
      input.remove();
      if (!file) return;
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        try {
          const text = reader.result;
          if (typeof text !== 'string') return;
          const parsed = JSON.parse(text) as Record<string, unknown>;
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            this.showToast(t('Import failed: invalid settings format'));
            log.warn('settings.import.invalid-format');
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
          log.warn('settings.import.invalid-json', { error: String(error) });
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
    this.modal?.close();
    this.modal?.remove();
    this.restoreDocumentLangDir();

    const styleElement = document.getElementById(STYLE_ID);
    styleElement?.remove();

    this.button = null;
    this.reloadButton = null;
    this.modal = null;
    this.playerElement = null;

    log.info('settings.controller.destroyed');
  }
}
