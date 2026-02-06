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
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = (...args) => {
      originalPushState.apply(history, args);
      this.checkUrlChange();
    };

    history.replaceState = (...args) => {
      originalReplaceState.apply(history, args);
      this.checkUrlChange();
    };

    // Also monitor popstate (back/forward buttons)
    window.addEventListener('popstate', () => {
      this.checkUrlChange();
    });

    // Listen to YouTube's custom navigation event (more reliable for SPA navigation)
    window.addEventListener('yt-navigate-finish', () => {
      console.log('[YT Chat Overlay] YouTube navigation finished');
      this.checkUrlChange(true);
    });

    // Periodic check as fallback (every 2 seconds)
    setInterval(() => {
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
    this.callbacks.clear();
  }
}
