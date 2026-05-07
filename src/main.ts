/**
 * YouTube Live Chat Overlay - Main Entry Point
 *
 * 100% local processing, no external requests or data storage (except settings).
 * Displays YouTube live chat messages in Nico-nico style flowing overlay.
 */

import type { OverlaySettings } from '@app-types';
import { createLogger, initOverlayLogLevel, setOverlayLogLevel } from '@core/logging';
import { PageWatcher } from '@core/page-watcher';
import { RuntimeManager } from '@core/runtime-manager';
import { Settings } from '@core/settings';
import { DEFAULT_SETTINGS } from '@core/settings-definitions';
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
    (partial) => this.updateSettings(partial),
    () => this.resetSettings()
  );

  private readonly handlePageWatcherChange = (): void => {
    if (this.pageWatcher.isValidPage()) {
      void this.ensureSettingsUi();
    } else {
      this.settingsUi.destroy();
    }

    this.runtimeManager.requestReconcile('page-change');
  };

  constructor() {
    setOverlayLogLevel(this.settings.get().logLevel);
    this.pageWatcher.onChange(this.handlePageWatcherChange);
    log.debug('Initialized');
  }

  async start(): Promise<void> {
    if (this.pageWatcher.isValidPage()) {
      await this.ensureSettingsUi();
    }

    await this.runtimeManager.start();
  }

  stop(): void {
    this.runtimeManager.destroy();
    this.pageWatcher.destroy();
    this.settingsUi.destroy();
    log.debug('Stopped');
  }

  getSettings(): Readonly<OverlaySettings> {
    return this.settings.get();
  }

  updateSettings(partial: Partial<OverlaySettings>): void {
    this.settings.update(partial);

    const nextSettings = this.settings.get();
    if (partial.logLevel !== undefined) {
      setOverlayLogLevel(nextSettings.logLevel);
    }

    if (this.pageWatcher.isValidPage()) {
      void this.ensureSettingsUi();
    }

    this.runtimeManager.requestReconcile('settings-change');
    log.debug('Settings updated');
  }

  resetSettings(): void {
    this.updateSettings(DEFAULT_SETTINGS);
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
    throw error;
  }
}

try {
  initOverlayLogLevel();
  main();
} catch (error) {
  log.error('Failed to start:', error);
}
