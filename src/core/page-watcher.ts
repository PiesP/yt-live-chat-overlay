import { createLogger } from '@core/logging';

const log = createLogger('PageWatcher');

/**
 * Page Watcher
 *
 * Monitors URL changes (YouTube SPA navigation) and triggers
 * re-initialization when navigating between videos.
 */

export type PageChangeCallback = () => void;

type NavigationSignalSource = 'pushState' | 'replaceState' | 'popstate' | 'yt-navigate-finish';

const YT_NAVIGATE_FINISH_EVENT = 'yt-navigate-finish';
const isSupportedYouTubePath = (pathname: string): boolean =>
  pathname === '/watch' || pathname.startsWith('/live/');

export class PageWatcher {
  private currentUrl = location.href;
  private callbacks: Set<PageChangeCallback> = new Set();
  private restorePushState?: () => void;
  private restoreReplaceState?: () => void;

  private readonly handleUrlMutation = (): void => {
    this.handlePotentialUrlChange('popstate');
  };

  private readonly handleYouTubeNavigateFinish = (): void => {
    log.debug('YouTube navigation finished');
    this.handlePotentialUrlChange('yt-navigate-finish');
  };

  constructor() {
    this.restorePushState = this.patchHistoryMethod('pushState');
    this.restoreReplaceState = this.patchHistoryMethod('replaceState');
    window.addEventListener('popstate', this.handleUrlMutation);
    window.addEventListener(YT_NAVIGATE_FINISH_EVENT, this.handleYouTubeNavigateFinish);
  }

  private patchHistoryMethod(methodName: 'pushState' | 'replaceState'): () => void {
    const original = history[methodName];
    history[methodName] = (...args: Parameters<typeof history.pushState>) => {
      original.apply(history, args);
      this.handlePotentialUrlChange(methodName);
    };
    return () => {
      history[methodName] = original;
    };
  }

  private handlePotentialUrlChange(source: NavigationSignalSource): void {
    const newUrl = location.href;
    if (newUrl === this.currentUrl) {
      return;
    }

    const previousUrl = this.currentUrl;
    this.currentUrl = newUrl;
    log.info('URL changed', {
      source,
      from: previousUrl,
      to: newUrl,
    });

    this.notifyCallbacks();
  }

  /**
   * Notify all registered callbacks
   */
  private notifyCallbacks(): void {
    for (const callback of this.callbacks) {
      try {
        callback();
      } catch (error) {
        log.warn('Page change callback error:', error);
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
   * Check if current page is a valid target (live/watch page)
   */
  isValidPage(): boolean {
    return isSupportedYouTubePath(location.pathname);
  }

  /**
   * Destroy and cleanup all resources
   */
  destroy(): void {
    window.removeEventListener('popstate', this.handleUrlMutation);
    window.removeEventListener(YT_NAVIGATE_FINISH_EVENT, this.handleYouTubeNavigateFinish);
    this.restorePushState?.();
    this.restoreReplaceState?.();
    this.callbacks.clear();

    log.debug('Destroyed');
  }
}
