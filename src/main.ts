/**
 * YouTube Live Chat Overlay - Main Entry Point
 *
 * 100% local processing, no external requests or data storage (except settings).
 * Displays YouTube live chat messages in Nico-nico style flowing overlay.
 */

import { DEFAULT_SETTINGS, type OverlaySettings } from '@app-types';
import { ChatSource } from '@core/chat-source';
import { sleep } from '@core/dom';
import { initOverlayLogLevel, setOverlayLogLevel } from '@core/logging';
import { Overlay } from '@core/overlay';
import { PageWatcher } from '@core/page-watcher';
import { Renderer } from '@core/renderer';
import { Settings } from '@core/settings';
import { SettingsUi } from '@core/settings-ui';
import { VideoSync } from '@core/video-sync';

const RESTART_DEBOUNCE_MS = 500;
const NAVIGATION_SETTLE_DELAY_MS = 2000;
const RESTART_RETRY_DELAY_MS = 2000;
const MAX_RESTART_ATTEMPTS = 3;
const APP_INIT_DELAY_MS = 500;
const OVERLAY_SELECTOR = '#yt-live-chat-overlay';

interface StartGuard {
  isCancelled(): boolean;
}

/**
 * Application state
 */
class App {
  private readonly pageWatcher: PageWatcher;
  private readonly settings: Settings;
  private chatSource: ChatSource | null = null;
  private overlay: Overlay | null = null;
  private renderer: Renderer | null = null;
  private videoSync: VideoSync | null = null;
  private readonly settingsUi: SettingsUi;
  private isInitialized = false;
  private restartTimer: number | null = null;
  private restartInProgress = false;
  private pendingRestart = false;
  private lastStartedUrl: string | null = null;
  /**
   * Incremented on every cleanup(). Each start() captures the generation at
   * entry and aborts if it no longer matches, preventing stale async tasks
   * from corrupting state after cleanup has been called.
   */
  private startGeneration = 0;
  private readonly handlePageWatcherChange = (): void => {
    this.handlePageChange();
  };
  private readonly handleVideoPause = (): void => {
    this.renderer?.pause();
  };
  private readonly handleVideoPlay = (): void => {
    this.renderer?.resume();
  };
  private readonly handleVideoRateChange = (rate: number): void => {
    console.log('[App] Video playback rate changed:', rate);
    this.renderer?.setPlaybackRate(rate);
  };

  constructor() {
    this.pageWatcher = new PageWatcher();
    this.settings = new Settings();
    this.settingsUi = new SettingsUi(
      () => this.settings.get(),
      (partial) => this.updateSettings(partial),
      () => this.resetSettings()
    );

    setOverlayLogLevel(this.settings.get().logLevel);

    this.pageWatcher.onChange(this.handlePageWatcherChange);

    console.log('[App] Initialized');
  }

  private createStartGuard(): StartGuard {
    const generation = this.startGeneration;

    return {
      isCancelled: () => this.startGeneration !== generation,
    };
  }

  /**
   * Start application
   */
  async start(): Promise<void> {
    const guard = this.createStartGuard();

    if (!this.pageWatcher.isValidPage()) {
      console.log('[App] Not on a video page, waiting...');
      return;
    }

    await this.ensureSettingsUi();
    if (guard.isCancelled()) return;

    if (this.isInitialized) {
      console.log('[App] Already initialized');
      return;
    }

    const currentSettings = this.settings.get();
    if (!currentSettings.enabled) {
      console.log('[App] Overlay is disabled');
      return;
    }

    try {
      const overlayCreated = await this.createOverlayRuntime(currentSettings);
      if (guard.isCancelled()) return;
      if (!overlayCreated) {
        console.warn('[App] Failed to create overlay');
        this.cleanup();
        return;
      }

      this.videoSync = this.createVideoSync();
      await this.videoSync.init();
      if (guard.isCancelled()) return;

      const chatStarted = await this.startChatSource();
      if (guard.isCancelled()) return;

      if (!chatStarted) {
        console.warn('[App] Failed to start chat monitoring');
        this.cleanup();
        return;
      }

      this.isInitialized = true;
      this.lastStartedUrl = location.href;
      console.log('[App] Started successfully');
    } catch (error) {
      console.error('[App] Initialization error:', error);
      this.cleanup();
    }
  }

  private createOverlayRuntime(settings: OverlaySettings): Promise<boolean> | false {
    const overlay = new Overlay();
    return overlay.create(settings).then((created) => {
      if (!created) {
        overlay.destroy();
        return false;
      }
      this.overlay = overlay;
      this.renderer = new Renderer(overlay, settings);
      return true;
    });
  }

  private createVideoSync(): VideoSync {
    return new VideoSync({
      onPause: this.handleVideoPause,
      onPlay: this.handleVideoPlay,
      onRateChange: this.handleVideoRateChange,
    });
  }

  private async startChatSource(): Promise<boolean> {
    const generation = this.startGeneration;
    const chatSource = new ChatSource(() => this.settings.get());

    // Register immediately so cleanup() can stop in-flight start() work.
    this.chatSource = chatSource;

    const started = await chatSource.start((message) => {
      if (this.startGeneration !== generation) return;
      this.renderer?.addMessage(message);
    });

    // If ownership changed during async start, ensure stale source is stopped.
    if (this.chatSource !== chatSource) {
      chatSource.stop();
      return false;
    }

    if (!started) {
      chatSource.stop();
      if (this.chatSource === chatSource) {
        this.chatSource = null;
      }
      return false;
    }

    return true;
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private queueRestart(): void {
    this.clearRestartTimer();
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null;
      void this.restartAfterNavigation();
    }, RESTART_DEBOUNCE_MS);
  }

  /**
   * Handle page change (SPA navigation)
   */
  private handlePageChange(): void {
    if (this.restartInProgress) {
      this.pendingRestart = true;
      return;
    }

    this.queueRestart();
  }

  private shouldSkipRestart(currentUrl: string): boolean {
    if (this.isInitialized && this.lastStartedUrl === currentUrl) {
      console.log('[App] Navigation event on same URL, skipping restart');
      return true;
    }

    return false;
  }

  private canRestartAfterNavigation(): boolean {
    if (!this.pageWatcher.isValidPage()) {
      console.log('[App] Not on a valid page after navigation');
      return false;
    }

    if (!this.settings.get().enabled) {
      console.log('[App] Overlay is disabled, not restarting');
      return false;
    }

    return true;
  }

  private async attemptRestart(): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_RESTART_ATTEMPTS; attempt++) {
      console.log(`[App] Restart attempt ${attempt}/${MAX_RESTART_ATTEMPTS}`);

      try {
        await this.start();

        if (this.isInitialized) {
          console.log('[App] Successfully restarted after navigation');
          return true;
        }
      } catch (error) {
        console.warn(`[App] Restart attempt ${attempt} failed:`, error);
      }

      if (attempt < MAX_RESTART_ATTEMPTS) {
        await sleep(RESTART_RETRY_DELAY_MS);
      }
    }

    return false;
  }

  /**
   * Restart after navigation settles
   */
  private async restartAfterNavigation(): Promise<void> {
    if (this.restartInProgress) {
      this.pendingRestart = true;
      return;
    }

    this.restartInProgress = true;
    this.pendingRestart = false;

    try {
      const targetUrl = location.href;
      if (this.shouldSkipRestart(targetUrl)) {
        return;
      }

      console.log('[App] Page changed, restarting...');
      this.cleanup();
      await sleep(NAVIGATION_SETTLE_DELAY_MS);

      if (location.href !== targetUrl) {
        console.log('[App] URL changed during settle delay, skipping stale restart');
        return;
      }

      if (!this.canRestartAfterNavigation()) {
        return;
      }

      if (!(await this.attemptRestart())) {
        console.warn('[App] Failed to restart after all retry attempts');
      }
    } catch (error) {
      console.warn('[App] Restart error:', error);
    } finally {
      this.restartInProgress = false;
      if (this.pendingRestart) {
        this.pendingRestart = false;
        this.handlePageChange();
      }
    }
  }

  /**
   * Get current settings
   */
  getSettings(): Readonly<OverlaySettings> {
    return this.settings.get();
  }

  /**
   * Update settings (for console access)
   */
  updateSettings(partial: Partial<OverlaySettings>): void {
    const previousSettings = this.settings.get();
    const wasEnabled = previousSettings.enabled;
    this.settings.update(partial);
    const nextSettings = this.settings.get();

    this.syncLogLevel(partial, nextSettings);

    if (this.handleEnabledStateChange(wasEnabled, nextSettings.enabled)) {
      return;
    }

    if (this.shouldRefreshOverlay(partial)) {
      void this.recreateOverlay(nextSettings);
    } else if (this.renderer) {
      this.renderer.updateSettings(nextSettings);
    }

    console.log('[App] Settings updated');
  }

  private syncLogLevel(
    partial: Partial<OverlaySettings>,
    nextSettings: Readonly<OverlaySettings>
  ): void {
    if (partial.logLevel !== undefined) {
      setOverlayLogLevel(nextSettings.logLevel);
    }
  }

  private handleEnabledStateChange(wasEnabled: boolean, isEnabled: boolean): boolean {
    if (wasEnabled && !isEnabled) {
      this.cleanup();
      console.log('[App] Overlay disabled');
      return true;
    }

    if (!wasEnabled && isEnabled) {
      void this.start();
      console.log('[App] Overlay enabled');
      return true;
    }

    return false;
  }

  private shouldRefreshOverlay(partial: Partial<OverlaySettings>): boolean {
    return (
      this.overlay !== null &&
      (partial.safeTop !== undefined ||
        partial.safeBottom !== undefined ||
        partial.fontSize !== undefined)
    );
  }

  private async recreateOverlay(settings: OverlaySettings): Promise<void> {
    const currentOverlay = this.overlay;
    if (!currentOverlay) return;

    this.destroyRenderer();
    currentOverlay.destroy();

    const overlay = new Overlay();
    this.overlay = overlay;

    try {
      const created = await overlay.create(settings);
      if (!created) {
        if (this.overlay === overlay) {
          this.overlay = null;
        }
        console.warn('[App] Failed to recreate overlay');
        return;
      }

      if (this.overlay !== overlay) {
        overlay.destroy();
        return;
      }

      this.renderer = new Renderer(overlay, settings);
    } catch (error) {
      if (this.overlay === overlay) {
        this.overlay = null;
      }
      console.error('[App] Failed to recreate overlay:', error);
    }
  }

  resetSettings(): void {
    this.updateSettings(DEFAULT_SETTINGS);
  }

  private destroyChatSource(): void {
    if (!this.chatSource) return;

    this.chatSource.stop();
    this.chatSource = null;
  }

  private destroyVideoSync(): void {
    if (!this.videoSync) return;

    this.videoSync.destroy();
    this.videoSync = null;
  }

  private destroyRenderer(): void {
    if (!this.renderer) return;

    this.renderer.destroy();
    this.renderer = null;
  }

  private destroyOverlay(): void {
    if (!this.overlay) return;

    this.overlay.destroy();
    this.overlay = null;
  }

  private removeLeftoverOverlays(): void {
    const leftoverOverlays = document.querySelectorAll(OVERLAY_SELECTOR);
    if (leftoverOverlays.length === 0) return;

    for (const element of leftoverOverlays) {
      element.remove();
    }

    console.log(`[App] Removed ${leftoverOverlays.length} leftover overlay element(s)`);
  }

  /**
   * Cleanup all components
   */
  private cleanup(): void {
    console.log('[App] Starting cleanup...');

    this.startGeneration++;
    this.clearRestartTimer();
    this.pendingRestart = false;
    this.settingsUi.close();

    this.destroyChatSource();
    this.destroyVideoSync();
    this.destroyRenderer();
    this.destroyOverlay();
    this.removeLeftoverOverlays();

    this.isInitialized = false;
    console.log('[App] Cleanup completed');
  }

  /**
   * Stop application and destroy all resources
   */
  stop(): void {
    this.cleanup();
    this.pageWatcher.destroy();
    this.settingsUi.destroy();
    console.log('[App] Stopped');
  }

  private async ensureSettingsUi(): Promise<void> {
    try {
      await this.settingsUi.attach();
    } catch (error) {
      console.warn('[App] Settings UI error:', error);
    }
  }
}

const scheduleAppInitialization = (): void => {
  window.setTimeout(() => {
    void initApp();
  }, APP_INIT_DELAY_MS);
};

/**
 * Main entry point
 */
function main(): void {
  console.log('[YT Chat Overlay] Script loaded', {
    readyState: document.readyState,
    url: location.href,
  });

  // Wait for page to be ready
  if (document.readyState === 'loading') {
    console.log('[YT Chat Overlay] Waiting for DOMContentLoaded...');
    document.addEventListener('DOMContentLoaded', () => {
      console.log('[YT Chat Overlay] DOMContentLoaded fired');
      scheduleAppInitialization();
    });
  } else {
    console.log('[YT Chat Overlay] Document already ready, initializing...');
    scheduleAppInitialization();
  }
}

const stopPreviousAppInstance = (): void => {
  if (!window.__ytChatOverlay) {
    return;
  }

  console.log('[YT Chat Overlay] Stopping previous instance before re-init');
  window.__ytChatOverlay.stop();
  window.__ytChatOverlay = undefined;
};

/**
 * Initialize application
 */
async function initApp(): Promise<void> {
  console.log('[YT Chat Overlay] Initializing application...');

  try {
    stopPreviousAppInstance();

    const app = new App();
    await app.start();

    // Expose to window for debugging (type declared in globals.d.ts)
    window.__ytChatOverlay = app;
    console.log('[YT Chat Overlay] App instance exposed to window.__ytChatOverlay');
  } catch (error) {
    console.error('[YT Chat Overlay] Fatal error:', error);
    // Re-throw to see stack trace
    throw error;
  }
}

// Start the application
try {
  initOverlayLogLevel();
  main();
} catch (error) {
  console.error('[YT Chat Overlay] Failed to start:', error);
}
