// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * YouTube Live Chat Overlay - Main Entry Point
 *
 * 100% local processing, no external requests or data storage (except settings).
 * Displays YouTube live chat messages in Nico-nico style flowing overlay.
 */

import type { OverlaySettings } from '@app-types';
import { resolveActiveLanguage, t } from '@core/i18n';
import { createLogger, setOverlayLogLevel } from '@core/logging';
import { PageWatcher } from '@core/page-watcher';
import { RuntimeManager } from '@core/runtime-manager';
import { Settings } from '@core/settings';
import { SettingsUi } from '@core/settings-ui';
import { isYouTubeLive, isYouTubeWatch } from '@core/youtube-url-pattern';
import { getMenuAdapter } from '@platform/menu-adapters';

const log = createLogger('App');

/** YouTube SPA navigation signal event name — matches PageWatcher's internal constant. */
const YT_NAVIGATE_FINISH_EVENT = 'yt-navigate-finish';

/** Guard against duplicate SPA bootstrap listener installation. */
let spaBootstrapInstalled = false;

function isVideoPage(): boolean {
  return isYouTubeWatch(location.href) || isYouTubeLive(location.href);
}

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
    (partial) => this.applySettings(partial),
    () => this.restartRuntime()
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
    await this.settings.initialize();
    resolveActiveLanguage(this.settings.get().language);
    setOverlayLogLevel(this.settings.get().logLevel);

    // Subscribe to cross-tab settings sync — reconcile runtime when
    // another tab changes settings via localStorage or GM storage.
    this.unsubscribeCrossTab = this.settings.subscribe(() => {
      log.debug('Cross-tab settings change — reconciling runtime');
      resolveActiveLanguage(this.settings.get().language);
      setOverlayLogLevel(this.settings.get().logLevel);
      // Sync the settings form if it is open, so cross-tab changes are
      // visible and don't get overwritten by stale form values on close.
      this.settingsUi.syncForm();
      this.settingsUi.syncLanguage();
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
    const prevLanguage = this.settings.get().language;
    this.settings.set(partial);
    // Re-resolve language when it changes so t() picks up the new locale
    // on the next open (DOM strings are baked at construction time, so a
    // dialog close/reopen cycle is required for visible effect — the
    // caller (close/handleImport) already handles dialog lifecycle).
    if (partial.language !== undefined && partial.language !== prevLanguage) {
      resolveActiveLanguage(this.settings.get().language);
    }
    this.applySettingsSideEffects(partial);
  }

  /**
   * Preview settings changes — applies to memory + live side-effects
   * (log level, runtime reconcile) but no storage write. Settings are
   * persisted to storage only when the user explicitly closes the
   * settings dialog (onPersist → applySettings).
   */
  previewSettings(partial: Partial<OverlaySettings>): void {
    const prevLanguage = this.settings.get().language;
    this.settings.preview(partial);
    // Re-resolve language and rebuild modal in-place so translated
    // strings take effect immediately (no storage write — memory only).
    if (partial.language !== undefined && partial.language !== prevLanguage) {
      resolveActiveLanguage(partial.language);
      this.settingsUi.syncLanguage();
    }
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
    this.settings.reset();
    resolveActiveLanguage(this.settings.get().language);
    this.applySettingsSideEffects({});
  }

  /**
   * Dispose the current runtime session and start a fresh one.
   *
   * Handy for recovering from degraded states (e.g. Translator API
   * death-loop, render stall) without a full page reload.  YouTube
   * playback and user scroll position are preserved.
   */
  async restartRuntime(): Promise<void> {
    log.info('Manual restart — disposing current runtime');
    await this.runtimeManager.restartSession();
    log.info('Manual restart completed');
  }

  private async ensureSettingsUi(): Promise<void> {
    try {
      await this.settingsUi.attach();
    } catch (error: unknown) {
      log.info('Settings UI error:', error);
    }
  }
}

/**
 * Install a lightweight SPA navigation listener on non-video pages.
 *
 * Avoids creating the full App (Settings, RuntimeManager, SettingsUiForm)
 * on the YouTube main page whose hero section contains a #movie_player
 * video element.  That player would satisfy findPlayerContainerElement()
 * and cause SettingsUi.attach() → ensureModal() → createModalContent()
 * → buildFontChips() to execute pointlessly, producing a TypeError.
 *
 * When the user SPA-navigates to a /watch or /live page this listener
 * bootstraps the full App, which then manages all subsequent navigation
 * via its own internal PageWatcher.
 */
function setupSpaBootstrap(): void {
  if (spaBootstrapInstalled) return;
  spaBootstrapInstalled = true;

  const onNavigate = (): void => {
    if (!isVideoPage() || window.__ytChatOverlay) return;

    // Tear down the lightweight watcher before handing control to App.
    window.removeEventListener(YT_NAVIGATE_FINISH_EVENT, onNavigate);
    window.removeEventListener('popstate', onNavigate);
    spaBootstrapInstalled = false;

    log.info('SPA navigation reached video page — bootstrapping App');
    void initApp();
  };

  window.addEventListener(YT_NAVIGATE_FINISH_EVENT, onNavigate);
  window.addEventListener('popstate', onNavigate);
  log.debug('SPA bootstrap watcher installed on non-video page');
}

function main(): void {
  if (!location.hostname.endsWith('youtube.com')) {
    return;
  }

  log.debug('Script loaded', {
    readyState: document.readyState,
    url: location.href,
  });

  // On non-video pages (YouTube homepage, channel pages, etc.) defer
  // full App initialization.  The page may still have video elements
  // (hero section autoplay) that would incorrectly trigger settings
  // UI / runtime setup via findPlayerContainerElement().
  //
  // The lightweight SPA bootstrap listener watches for yt-navigate-finish
  // and popstate events, and promotes to the full App on the first
  // navigation to a /watch or /live URL.
  if (!isVideoPage()) {
    setupSpaBootstrap();
    return;
  }

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
  try {
    window.__ytChatOverlay.stop();
  } finally {
    window.__ytChatOverlay = undefined;
  }
};

async function initApp(): Promise<void> {
  log.debug('Initializing application...');

  try {
    stopPreviousAppInstance();

    const app = new App();
    await app.start();
    registerMenuCommands();

    // Expose a frozen debug handle — limits the surface to YtChatOverlayDebugHandle
    // and prevents malicious MAIN-world scripts from reassigning or extending it.
    window.__ytChatOverlay = Object.freeze({
      start: () => app.start(),
      stop: () => app.stop(),
      restartRuntime: () => app.restartRuntime(),
      getSettings: () => app.getSettings(),
      applySettings: (partial: Parameters<typeof app.applySettings>[0]) =>
        app.applySettings(partial),
      resetSettings: () => app.resetSettings(),
    });
    log.info('App instance exposed to window.__ytChatOverlay');
  } catch (error: unknown) {
    log.error('Fatal error:', error);
  }
}

main();

function registerMenuCommands(): void {
  const adapter = getMenuAdapter();
  if (!adapter.isSupported()) return;

  adapter.register([
    {
      name: t('Reset overlay settings'),
      action: () => {
        const app = window.__ytChatOverlay;
        if (app) {
          app.resetSettings();
        }
      },
    },
    {
      name: t('Reload overlay'),
      action: () => {
        const app = window.__ytChatOverlay;
        if (app?.restartRuntime) {
          void app.restartRuntime();
        }
      },
    },
  ]);
}
