/**
 * YouTube Live Chat Overlay - Main Entry Point
 *
 * 100% local processing, no external requests or data storage (except settings).
 * Displays YouTube live chat messages in Nico-nico style flowing overlay.
 */

import { DEFAULT_SETTINGS, type OverlaySettings } from '@app-types';
import { initOverlayLogLevel, overlayLog, setOverlayLogLevel } from '@core/logging';
import { PageWatcher } from '@core/page-watcher';
import { RuntimeManager } from '@core/runtime-manager';
import { Settings } from '@core/settings';
import { SettingsUi } from '@core/settings-ui';

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
    overlayLog.debug('[App] Initialized');
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
    overlayLog.debug('[App] Stopped');
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
    overlayLog.debug('[App] Settings updated');
  }

  resetSettings(): void {
    this.updateSettings(DEFAULT_SETTINGS);
  }

  private async ensureSettingsUi(): Promise<void> {
    try {
      await this.settingsUi.attach();
    } catch (error) {
      overlayLog.warn('[App] Settings UI error:', error);
    }
  }
}

function main(): void {
  overlayLog.debug('[YT Chat Overlay] Script loaded', {
    readyState: document.readyState,
    url: location.href,
  });

  if (document.readyState === 'loading') {
    overlayLog.debug('[YT Chat Overlay] Waiting for DOMContentLoaded...');
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        overlayLog.debug('[YT Chat Overlay] DOMContentLoaded fired');
        void initApp();
      },
      { once: true }
    );
  } else {
    overlayLog.debug('[YT Chat Overlay] Document already ready, initializing...');
    void initApp();
  }
}

const stopPreviousAppInstance = (): void => {
  if (!window.__ytChatOverlay) {
    return;
  }

  overlayLog.debug('[YT Chat Overlay] Stopping previous instance before re-init');
  window.__ytChatOverlay.stop();
  window.__ytChatOverlay = undefined;
};

async function initApp(): Promise<void> {
  overlayLog.debug('[YT Chat Overlay] Initializing application...');
  let app: App | null = null;

  try {
    stopPreviousAppInstance();

    app = new App();
    await app.start();

    window.__ytChatOverlay = app;
    overlayLog.info('[YT Chat Overlay] App instance exposed to window.__ytChatOverlay');
  } catch (error) {
    if (app) {
      try {
        app.stop();
      } catch (cleanupError) {
        overlayLog.error('[YT Chat Overlay] Cleanup after failed init also failed:', cleanupError);
      }
    }

    overlayLog.error('[YT Chat Overlay] Fatal error:', error);
    throw error;
  }
}

try {
  initOverlayLogLevel();
  main();
} catch (error) {
  overlayLog.error('[YT Chat Overlay] Failed to start:', error);
}
