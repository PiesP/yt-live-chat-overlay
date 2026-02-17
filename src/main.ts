/**
 * YouTube Live Chat Overlay - Main Entry Point
 *
 * 100% local processing, no external requests or data storage (except settings).
 * Displays YouTube live chat messages in Nico-nico style flowing overlay.
 */

import { DEFAULT_SETTINGS, type OverlaySettings } from '@app-types';
import { ChatSource } from '@core/chat-source';
import { sleep } from '@core/dom';
import { Overlay } from '@core/overlay';
import { PageWatcher } from '@core/page-watcher';
import { Renderer } from '@core/renderer';
import { Settings } from '@core/settings';
import { SettingsUi } from '@core/settings-ui';
import { VideoSync } from '@core/video-sync';

/**
 * Application state
 */
class App {
  private pageWatcher: PageWatcher;
  private settings: Settings;
  private chatSource: ChatSource | null = null;
  private overlay: Overlay | null = null;
  private _renderer: Renderer | null = null;
  private videoSync: VideoSync | null = null;
  private settingsUi: SettingsUi;
  private isInitialized = false;
  private restartTimer: number | null = null;
  private restartInProgress = false;
  private pendingRestart = false;
  private lastStartedUrl: string | null = null;

  constructor() {
    this.pageWatcher = new PageWatcher();
    this.settings = new Settings();
    this.settingsUi = new SettingsUi(
      () => this.settings.get(),
      (partial) => this.updateSettings(partial),
      () => this.resetSettings()
    );

    // Register page change handler
    this.pageWatcher.onChange(() => {
      this.handlePageChange();
    });

    console.log('[App] Initialized');
  }

  /**
   * Start application
   */
  async start(): Promise<void> {
    // Check if we're on a valid page
    if (!this.pageWatcher.isValidPage()) {
      console.log('[App] Not on a video page, waiting...');
      return;
    }

    await this.ensureSettingsUi();

    // Check if already initialized
    if (this.isInitialized) {
      console.log('[App] Already initialized');
      return;
    }

    // Check if enabled
    const currentSettings = this.settings.get();
    if (!currentSettings.enabled) {
      console.log('[App] Overlay is disabled');
      return;
    }

    // Initialize components
    try {
      // Create overlay
      this.overlay = new Overlay();
      const overlayCreated = await this.overlay.create(currentSettings);
      if (!overlayCreated) {
        console.warn('[App] Failed to create overlay');
        this.cleanup();
        return;
      }

      // Create renderer
      this._renderer = new Renderer(this.overlay, currentSettings);

      // Initialize video sync
      this.videoSync = new VideoSync({
        onPause: () => {
          if (this._renderer) {
            this._renderer.pause();
          }
        },
        onPlay: () => {
          if (this._renderer) {
            this._renderer.resume();
          }
        },
        onSeeking: () => {
          // Optional: no action needed for now
        },
        onRateChange: (rate) => {
          console.log('[App] Video playback rate changed:', rate);
          if (this._renderer) {
            this._renderer.setPlaybackRate(rate);
          }
        },
      });

      // Try to initialize (non-blocking)
      await this.videoSync.init();

      // Start chat source
      this.chatSource = new ChatSource();
      const chatStarted = await this.chatSource.start((message) => {
        if (this._renderer) {
          this._renderer.addMessage(message);
        }
      });

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

  /**
   * Handle page change (SPA navigation)
   */
  private handlePageChange(): void {
    if (this.restartInProgress) {
      this.pendingRestart = true;
      return;
    }

    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
    }

    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null;
      void this.restartAfterNavigation();
    }, 500);
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
      const currentUrl = location.href;
      if (this.isInitialized && this.lastStartedUrl === currentUrl) {
        console.log('[App] Navigation event on same URL, skipping restart');
        return;
      }

      console.log('[App] Page changed, restarting...');

      // Cleanup existing instances thoroughly
      this.cleanup();

      // Wait longer for YouTube's SPA navigation to complete
      // YouTube needs time to load the new page structure
      await sleep(2000);

      // Check if we're still on a valid page after delay
      if (!this.pageWatcher.isValidPage()) {
        console.log('[App] Not on a valid page after navigation');
        return;
      }

      // Check if enabled before trying to restart
      if (!this.settings.get().enabled) {
        console.log('[App] Overlay is disabled, not restarting');
        return;
      }

      // Try to restart with retry logic
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`[App] Restart attempt ${attempt}/${maxRetries}`);

        try {
          await this.start();

          // If successful, break out of retry loop
          if (this.isInitialized) {
            console.log('[App] Successfully restarted after navigation');
            return;
          }
        } catch (error) {
          console.warn(`[App] Restart attempt ${attempt} failed:`, error);
        }

        // Wait before next retry
        if (attempt < maxRetries) {
          await sleep(2000);
        }
      }

      console.warn('[App] Failed to restart after all retry attempts');
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
    const wasEnabled = this.settings.get().enabled;
    this.settings.update(partial);
    const nextSettings = this.settings.get();

    if (wasEnabled && !nextSettings.enabled) {
      this.cleanup();
      console.log('[App] Overlay disabled');
      return;
    }

    if (!wasEnabled && nextSettings.enabled) {
      void this.start();
      console.log('[App] Overlay enabled');
      return;
    }

    const currentOverlay = this.overlay;
    const needsOverlayRefresh =
      currentOverlay &&
      (partial.safeTop !== undefined ||
        partial.safeBottom !== undefined ||
        partial.fontSize !== undefined);

    if (needsOverlayRefresh) {
      if (this._renderer) {
        this._renderer.destroy();
        this._renderer = null;
      }

      currentOverlay.destroy();
      this.overlay = new Overlay();
      this.overlay
        .create(nextSettings)
        .then((created) => {
          if (!created) {
            console.warn('[App] Failed to recreate overlay');
            return;
          }
          const overlay = this.overlay;
          if (!overlay) return;
          this._renderer = new Renderer(overlay, nextSettings);
        })
        .catch((error) => {
          console.error('[App] Failed to recreate overlay:', error);
        });
    } else if (this._renderer) {
      this._renderer.updateSettings(nextSettings);
    }

    console.log('[App] Settings updated');
  }

  resetSettings(): void {
    this.updateSettings(DEFAULT_SETTINGS);
  }

  /**
   * Public access to renderer for manual testing
   */
  get renderer(): Renderer | null {
    return this._renderer;
  }

  /**
   * Cleanup all components
   */
  private cleanup(): void {
    console.log('[App] Starting cleanup...');

    // Close settings UI
    this.settingsUi.close();

    // Stop chat monitoring first to prevent new messages
    if (this.chatSource) {
      this.chatSource.stop();
      this.chatSource = null;
    }

    // Stop video sync
    if (this.videoSync) {
      this.videoSync.destroy();
      this.videoSync = null;
    }

    // Destroy renderer to clear all active messages
    if (this._renderer) {
      this._renderer.destroy();
      this._renderer = null;
    }

    // Destroy overlay last
    if (this.overlay) {
      this.overlay.destroy();
      this.overlay = null;
    }

    // Force remove any leftover overlay elements from DOM
    const leftoverOverlays = document.querySelectorAll('#yt-live-chat-overlay');
    if (leftoverOverlays.length > 0) {
      for (const element of leftoverOverlays) {
        element.remove();
      }
      console.log(`[App] Removed ${leftoverOverlays.length} leftover overlay element(s)`);
    }

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
      // Small delay to let YouTube initialize
      setTimeout(() => initApp(), 500);
    });
  } else {
    console.log('[YT Chat Overlay] Document already ready, initializing...');
    // Small delay to let YouTube initialize
    setTimeout(() => initApp(), 500);
  }
}

/**
 * Initialize application
 */
async function initApp(): Promise<void> {
  console.log('[YT Chat Overlay] Initializing application...');

  try {
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
  main();
} catch (error) {
  console.error('[YT Chat Overlay] Failed to start:', error);
}
