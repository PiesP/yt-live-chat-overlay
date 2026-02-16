/**
 * Page Watcher
 *
 * Monitors URL changes (YouTube SPA navigation) and triggers
 * re-initialization when navigating between videos.
 */

export type PageChangeCallback = () => void;

export class PageWatcher {
  private currentUrl: string;
  private callbacks: Set<PageChangeCallback>;
  private originalPushState: typeof history.pushState | null = null;
  private originalReplaceState: typeof history.replaceState | null = null;
  private popstateHandler: (() => void) | null = null;
  private ytNavigateHandler: (() => void) | null = null;
  private intervalId: number | null = null;

  constructor() {
    this.currentUrl = location.href;
    this.callbacks = new Set();
    this.init();
  }

  /**
   * Initialize page watcher
   */
  private init(): void {
    // Monitor History API changes (YouTube uses soft navigation)
    this.originalPushState = history.pushState;
    this.originalReplaceState = history.replaceState;

    history.pushState = (...args) => {
      this.originalPushState!.apply(history, args);
      this.checkUrlChange();
    };

    history.replaceState = (...args) => {
      this.originalReplaceState!.apply(history, args);
      this.checkUrlChange();
    };

    // Also monitor popstate (back/forward buttons)
    this.popstateHandler = () => {
      this.checkUrlChange();
    };
    window.addEventListener('popstate', this.popstateHandler);

    // Listen to YouTube's custom navigation event (more reliable for SPA navigation)
    this.ytNavigateHandler = () => {
      console.log('[YT Chat Overlay] YouTube navigation finished');
      this.checkUrlChange(true);
    };
    window.addEventListener('yt-navigate-finish', this.ytNavigateHandler);

    // Periodic check as fallback (every 2 seconds)
    this.intervalId = window.setInterval(() => {
      this.checkUrlChange();
    }, 2000);
  }

  /**
   * Check if URL has changed
   */
  private checkUrlChange(forceNotify = false): void {
    const newUrl = location.href;
    if (newUrl !== this.currentUrl) {
      this.currentUrl = newUrl;
      this.notifyCallbacks();
      return;
    }
    if (forceNotify) {
      this.notifyCallbacks();
    }
  }

  /**
   * Notify all registered callbacks
   */
  private notifyCallbacks(): void {
    for (const callback of this.callbacks) {
      try {
        callback();
      } catch (error) {
        console.error('[YT Chat Overlay] Page change callback error:', error);
      }
    }
  }

  /**
   * Register a callback for page changes
   */
  onChange(callback: PageChangeCallback): void {
    this.callbacks.add(callback);
  }

  /**
   * Unregister a callback
   */
  offChange(callback: PageChangeCallback): void {
    this.callbacks.delete(callback);
  }

  /**
   * Check if current page is a valid target (live/watch page)
   */
  isValidPage(): boolean {
    const url = this.currentUrl;
    return url.includes('/watch') || url.includes('/live/');
  }

  /**
   * Cleanup
   */
  destroy(): void {
    // Restore original history methods
    if (this.originalPushState) {
      history.pushState = this.originalPushState;
      this.originalPushState = null;
    }
    if (this.originalReplaceState) {
      history.replaceState = this.originalReplaceState;
      this.originalReplaceState = null;
    }

    // Remove event listeners
    if (this.popstateHandler) {
      window.removeEventListener('popstate', this.popstateHandler);
      this.popstateHandler = null;
    }
    if (this.ytNavigateHandler) {
      window.removeEventListener('yt-navigate-finish', this.ytNavigateHandler);
      this.ytNavigateHandler = null;
    }

    // Clear interval
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.callbacks.clear();
  }
}
