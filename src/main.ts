/**
 * YouTube Live Chat Overlay - Main Entry Point
 *
 * 100% local processing, no external requests or data storage (except settings).
 * Displays YouTube live chat messages in Nico-nico style flowing overlay.
 */

import type { OverlaySettings } from '@app-types';
import { createLogger, setOverlayLogLevel } from '@core/logging';
import { PageWatcher } from '@core/page-watcher';
import { RuntimeManager } from '@core/runtime-manager';
import { Settings } from '@core/settings';
import { DEFAULT_SETTINGS } from '@core/settings-schema';
import { SettingsUi } from '@core/settings-ui';

const log = createLogger('App');

/**
 * Thin application shell.
 *
 * Responsibilities:
 * - Own Settings, SettingsUi, PageWatcher, and RuntimeManager
 * - Route page/settings changes into RuntimeManager.reconcile()
 * - Expose a small debug handle on window.__ytChatOverlay
 */
class App {
  private readonly pageWatcher = new PageWatcher();
  private readonly settings = new Settings();
  private readonly runtimeManager = new RuntimeManager({
    getCurrentUrl: () => location.href,
    getSettings: () => this.settings.get(),
    isValidPage: () => this.pageWatcher.isValidPage(),
  });
  private readonly settingsUi = new SettingsUi(
    () => this.settings.get(),
    (partial) => this.previewSettings(partial),
    () => this.resetSettings(),
    (partial) => this.applySettings(partial)
  );
  /** Unsubscribe from cross-tab settings sync. */
  private unsubscribeCrossTab: (() => void) | null = null;

  private readonly handlePageWatcherChange = (): void => {
    if (this.pageWatcher.isValidPage()) {
      void this.ensureSettingsUi();
    } else {
      this.settingsUi.destroy();
    }

    this.runtimeManager.requestReconcile('page-change');
  };

  constructor() {
    this.pageWatcher.onChange(this.handlePageWatcherChange);
    log.debug('Initialized');
  }

  async start(): Promise<void> {
    this.settings.initialize();
    setOverlayLogLevel(this.settings.get().logLevel);

    // Subscribe to cross-tab settings sync — reconcile runtime when
    // another tab changes settings via localStorage or GM storage.
    this.unsubscribeCrossTab = this.settings.subscribe(() => {
      log.debug('Cross-tab settings change — reconciling runtime');
      setOverlayLogLevel(this.settings.get().logLevel);
      // Sync the settings form if it is open, so cross-tab changes are
      // visible and don't get overwritten by stale form values on close.
      this.settingsUi.syncForm();
      this.runtimeManager.requestReconcile('settings-change');
    });

    if (this.pageWatcher.isValidPage()) {
      await this.ensureSettingsUi();
    }

    await this.runtimeManager.start();
  }

  stop(): void {
    this.runtimeManager.destroy();
    this.pageWatcher.destroy();
    this.settingsUi.destroy();
    this.unsubscribeCrossTab?.();
    this.settings.destroy();
    log.debug('Stopped');
  }

  getSettings(): Readonly<OverlaySettings> {
    return this.settings.get();
  }

  /**
   * Apply settings changes — updates memory, persists, and applies side-effects.
   */
  applySettings(partial: Partial<OverlaySettings>): void {
    this.settings.set(partial);
    this.applySettingsSideEffects(partial);
  }

  /**
   * Preview settings changes — memory only. Side-effects still apply
   * (log level, settings UI, runtime reconcile) but no storage write.
   */
  previewSettings(partial: Partial<OverlaySettings>): void {
    this.settings.preview(partial);
    this.applySettingsSideEffects(partial);
  }

  private applySettingsSideEffects(partial: Partial<OverlaySettings>): void {
    if (partial.logLevel !== undefined) {
      setOverlayLogLevel(this.settings.get().logLevel);
    }
    if (this.pageWatcher.isValidPage()) {
      void this.ensureSettingsUi();
    }
    this.runtimeManager.requestReconcile('settings-change');
  }

  resetSettings(): void {
    this.applySettings(DEFAULT_SETTINGS);
  }

  private async ensureSettingsUi(): Promise<void> {
    try {
      await this.settingsUi.attach();
    } catch (error) {
      log.warn('Settings UI error:', error);
    }
  }
}

function main(): void {
  log.debug('Script loaded', {
    readyState: document.readyState,
    url: location.href,
  });

  if (document.readyState === 'loading') {
    log.debug('Waiting for DOMContentLoaded...');
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        log.debug('DOMContentLoaded fired');
        void initApp();
      },
      { once: true }
    );
  } else {
    log.debug('Document already ready, initializing...');
    void initApp();
  }
}

const stopPreviousAppInstance = (): void => {
  if (!window.__ytChatOverlay) {
    return;
  }

  log.debug('Stopping previous instance before re-init');
  window.__ytChatOverlay.stop();
  window.__ytChatOverlay = undefined;
};

async function initApp(): Promise<void> {
  log.debug('Initializing application...');

  try {
    stopPreviousAppInstance();

    const app = new App();
    await app.start();

    window.__ytChatOverlay = app;
    log.info('App instance exposed to window.__ytChatOverlay');
  } catch (error) {
    log.error('Fatal error:', error);
  }
}

registerMenuCommands();
main();

function registerMenuCommands(): void {
  if (typeof GM_registerMenuCommand === 'undefined') return;
  GM_registerMenuCommand('Reset overlay settings', () => {
    const app = window.__ytChatOverlay;
    if (app) {
      app.resetSettings();
    }
  });
}
