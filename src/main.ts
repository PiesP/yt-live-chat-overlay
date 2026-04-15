/**
 * YouTube Live Chat Overlay - Main Entry Point
 *
 * 100% local processing, no external requests or data storage (except settings).
 * Displays YouTube live chat messages in Nico-nico style flowing overlay.
 */

import { DEFAULT_SETTINGS, type OverlaySettings } from '@app-types';
import { ChatSource } from '@core/chat-source';
import { sleep } from '@core/dom';
import { initOverlayLogLevel, overlayLog, setOverlayLogLevel } from '@core/logging';
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
const RESUME_SYNC_MESSAGE_LIMIT = 20;

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
  private visibilityHandler: (() => void) | null = null;
  private chatWatchdogInterval: number | null = null;
  private hiddenWhilePlaying = false;
  private visibilityRecoveryInProgress = false;
  private resumeSyncInProgress = false;
  private readonly handlePageWatcherChange = (): void => {
    this.handlePageChange();
  };
  private readonly handleVideoPause = (): void => {
    this.renderer?.pause();
  };
  private readonly handleVideoPlay = (): void => {
    void this.syncLatestMessagesOnResume();
  };
  private readonly handleVideoRateChange = (rate: number): void => {
    overlayLog.info('[App] Video playback rate changed:', rate);
    this.renderer?.setPlaybackRate(rate);
  };
  private readonly handleVideoSeeking = (): void => {
    this.renderer?.flushQueue();
  };

  private async recoverAfterVisibilityReturn(): Promise<void> {
    if (this.visibilityRecoveryInProgress) {
      return;
    }

    if (!this.hiddenWhilePlaying || this.videoSync?.isPaused()) {
      this.hiddenWhilePlaying = false;
      return;
    }

    this.visibilityRecoveryInProgress = true;

    try {
      if (this.chatSource && !this.chatSource.isObserverAlive()) {
        overlayLog.info('[App] Chat observer dead on visibility return, reconnecting now');
        const reconnected = await this.chatSource.reconnect();
        if (!reconnected) {
          console.warn('[App] Failed to reconnect chat observer on visibility return');
        }
      }

      await this.syncLatestMessagesOnResume();
    } finally {
      this.hiddenWhilePlaying = false;
      this.visibilityRecoveryInProgress = false;
    }
  }

  /**
   * Re-synchronize overlay content when playback resumes.
   *
   * Goal: avoid replaying stale paused backlog and instead render the latest
   * visible chat state.
   */
  private async syncLatestMessagesOnResume(): Promise<void> {
    if (this.resumeSyncInProgress) {
      this.renderer?.resume();
      return;
    }

    this.resumeSyncInProgress = true;

    try {
      const renderer = this.renderer;
      if (!renderer) return;

      renderer.resetForResync();
      renderer.resume();

      const latestMessages = this.chatSource?.getLatestMessages(RESUME_SYNC_MESSAGE_LIMIT) ?? [];
      for (const message of latestMessages) {
        renderer.addMessage(message);
      }
    } catch (error) {
      console.warn('[App] Failed to sync latest messages on resume:', error);
      this.renderer?.resume();
    } finally {
      this.resumeSyncInProgress = false;
    }
  }

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

    overlayLog.info('[App] Initialized');
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
      overlayLog.info('[App] Not on a video page, waiting...');
      return;
    }

    await this.ensureSettingsUi();
    if (guard.isCancelled()) return;

    if (this.isInitialized) {
      overlayLog.info('[App] Already initialized');
      return;
    }

    const currentSettings = this.settings.get();
    if (!currentSettings.enabled) {
      overlayLog.info('[App] Overlay is disabled');
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

      this.setupVisibilityHandler();

      const chatStarted = await this.startChatSource();
      if (guard.isCancelled()) return;

      if (!chatStarted) {
        console.warn('[App] Failed to start chat monitoring');
        this.cleanup();
        return;
      }

      this.setupChatWatchdog();

      this.isInitialized = true;
      this.lastStartedUrl = location.href;
      overlayLog.info('[App] Started successfully');
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
      onSeeking: this.handleVideoSeeking,
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

  /**
   * Listen for tab visibility changes. Pauses the renderer when the tab is
   * hidden so that background timer throttling does not cause a burst of
   * animations on return. Resumes only if the video is also playing.
   */
  private setupVisibilityHandler(): void {
    this.visibilityHandler = () => {
      if (document.hidden) {
        if (!this.renderer?.isPausedState()) {
          this.renderer?.pause();
          this.hiddenWhilePlaying = true;
        }
      } else {
        void this.recoverAfterVisibilityReturn();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  /**
   * Start a periodic check that re-attaches the MutationObserver if YouTube
   * unmounts the chat #items container (e.g. on tab hide / chat collapse).
   */
  private setupChatWatchdog(): void {
    const WATCHDOG_INTERVAL_MS = 15_000;
    this.chatWatchdogInterval = window.setInterval(() => {
      if (!this.chatSource || !this.isInitialized) return;
      if (!this.chatSource.isObserverAlive()) {
        console.warn('[App] Chat observer dead — attempting reconnect');
        this.chatSource.reconnect().catch((err: unknown) => {
          console.warn('[App] Chat reconnect failed:', err);
        });
      }
    }, WATCHDOG_INTERVAL_MS);
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
      overlayLog.info('[App] Navigation event on same URL, skipping restart');
      return true;
    }

    return false;
  }

  private canRestartAfterNavigation(): boolean {
    if (!this.pageWatcher.isValidPage()) {
      overlayLog.info('[App] Not on a valid page after navigation');
      return false;
    }

    if (!this.settings.get().enabled) {
      overlayLog.info('[App] Overlay is disabled, not restarting');
      return false;
    }

    return true;
  }

  private async attemptRestart(): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_RESTART_ATTEMPTS; attempt++) {
      overlayLog.info(`[App] Restart attempt ${attempt}/${MAX_RESTART_ATTEMPTS}`);

      try {
        await this.start();

        if (this.isInitialized) {
          overlayLog.info('[App] Successfully restarted after navigation');
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

      overlayLog.info('[App] Page changed, restarting...');
      this.cleanup();
      await sleep(NAVIGATION_SETTLE_DELAY_MS);

      if (location.href !== targetUrl) {
        overlayLog.info('[App] URL changed during settle delay, skipping stale restart');
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

    overlayLog.info('[App] Settings updated');
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
      overlayLog.info('[App] Overlay disabled');
      return true;
    }

    if (!wasEnabled && isEnabled) {
      void this.start();
      overlayLog.info('[App] Overlay enabled');
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

    overlayLog.info(`[App] Removed ${leftoverOverlays.length} leftover overlay element(s)`);
  }

  /**
   * Cleanup all components
   */
  private cleanup(): void {
    overlayLog.info('[App] Starting cleanup...');

    this.startGeneration++;
    this.clearRestartTimer();
    this.pendingRestart = false;
    this.settingsUi.close();
    this.resumeSyncInProgress = false;

    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    this.hiddenWhilePlaying = false;
    this.visibilityRecoveryInProgress = false;

    if (this.chatWatchdogInterval !== null) {
      window.clearInterval(this.chatWatchdogInterval);
      this.chatWatchdogInterval = null;
    }

    this.destroyChatSource();
    this.destroyVideoSync();
    this.destroyRenderer();
    this.destroyOverlay();
    this.removeLeftoverOverlays();

    this.isInitialized = false;
    overlayLog.info('[App] Cleanup completed');
  }

  /**
   * Stop application and destroy all resources
   */
  stop(): void {
    this.cleanup();
    this.pageWatcher.destroy();
    this.settingsUi.destroy();
    overlayLog.info('[App] Stopped');
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
  overlayLog.info('[YT Chat Overlay] Script loaded', {
    readyState: document.readyState,
    url: location.href,
  });

  // Wait for page to be ready
  if (document.readyState === 'loading') {
    overlayLog.info('[YT Chat Overlay] Waiting for DOMContentLoaded...');
    document.addEventListener('DOMContentLoaded', () => {
      overlayLog.info('[YT Chat Overlay] DOMContentLoaded fired');
      scheduleAppInitialization();
    });
  } else {
    overlayLog.info('[YT Chat Overlay] Document already ready, initializing...');
    scheduleAppInitialization();
  }
}

const stopPreviousAppInstance = (): void => {
  if (!window.__ytChatOverlay) {
    return;
  }

  overlayLog.info('[YT Chat Overlay] Stopping previous instance before re-init');
  window.__ytChatOverlay.stop();
  window.__ytChatOverlay = undefined;
};

/**
 * Initialize application
 */
async function initApp(): Promise<void> {
  overlayLog.info('[YT Chat Overlay] Initializing application...');

  try {
    stopPreviousAppInstance();

    const app = new App();
    await app.start();

    // Expose to window for debugging (type declared in globals.d.ts)
    window.__ytChatOverlay = app;
    overlayLog.info('[YT Chat Overlay] App instance exposed to window.__ytChatOverlay');
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
