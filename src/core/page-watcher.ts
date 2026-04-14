import { overlayLog } from "@core/logging";

/**
 * Page Watcher
 *
 * Monitors URL changes (YouTube SPA navigation) and triggers
 * re-initialization when navigating between videos.
 */

export type PageChangeCallback = () => void;

type HistoryMethodName = "pushState" | "replaceState";
type HistoryStateMethod = typeof history.pushState;

const YT_NAVIGATE_FINISH_EVENT = "yt-navigate-finish";
const URL_POLL_INTERVAL_MS = 2000;

const isValidYouTubePageUrl = (url: string): boolean => {
  try {
    const { pathname } = new URL(url);
    return pathname === "/watch" || pathname.startsWith("/live/");
  } catch {
    return url.includes("/watch") || url.includes("/live/");
  }
};

export class PageWatcher {
  private currentUrl = location.href;
  private callbacks: Set<PageChangeCallback> = new Set();
  private originalPushState: typeof history.pushState | null = null;
  private originalReplaceState: typeof history.replaceState | null = null;
  private intervalId: number | null = null;

  private readonly handleUrlMutation = (): void => {
    this.checkUrlChange();
  };

  private readonly handleYouTubeNavigateFinish = (): void => {
    overlayLog.info("[YT Chat Overlay] YouTube navigation finished");
    // Do NOT force notification here. YouTube fires yt-navigate-finish on the
    // same URL during initial page setup, which would trigger an unnecessary
    // cleanup+restart race. URL changes are already detected by the pushState,
    // replaceState, and popstate listeners.
    this.checkUrlChange();
  };

  constructor() {
    this.init();
  }

  /**
   * Initialize page watcher
   */
  private init(): void {
    this.patchHistoryMethod("pushState");
    this.patchHistoryMethod("replaceState");
    this.attachEventListeners();
    this.startPolling();
  }

  private patchHistoryMethod(methodName: HistoryMethodName): void {
    const originalMethod = history[methodName].bind(
      history,
    ) as HistoryStateMethod;

    if (methodName === "pushState") {
      this.originalPushState = history.pushState;
    } else {
      this.originalReplaceState = history.replaceState;
    }

    history[methodName] = ((...args: Parameters<HistoryStateMethod>) => {
      originalMethod(...args);
      this.checkUrlChange();
    }) as HistoryStateMethod;
  }

  private attachEventListeners(): void {
    window.addEventListener("popstate", this.handleUrlMutation);
    window.addEventListener(
      YT_NAVIGATE_FINISH_EVENT,
      this.handleYouTubeNavigateFinish,
    );
  }

  private detachEventListeners(): void {
    window.removeEventListener("popstate", this.handleUrlMutation);
    window.removeEventListener(
      YT_NAVIGATE_FINISH_EVENT,
      this.handleYouTubeNavigateFinish,
    );
  }

  private startPolling(): void {
    this.intervalId = window.setInterval(() => {
      this.checkUrlChange();
    }, URL_POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.intervalId === null) {
      return;
    }

    window.clearInterval(this.intervalId);
    this.intervalId = null;
  }

  private restoreHistoryMethods(): void {
    if (this.originalPushState) {
      history.pushState = this.originalPushState;
      this.originalPushState = null;
    }

    if (this.originalReplaceState) {
      history.replaceState = this.originalReplaceState;
      this.originalReplaceState = null;
    }
  }

  /**
   * Check if URL has changed
   */
  private checkUrlChange(): void {
    const newUrl = location.href;

    if (newUrl === this.currentUrl) {
      return;
    }

    this.currentUrl = newUrl;
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
        console.error("[YT Chat Overlay] Page change callback error:", error);
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
    return isValidYouTubePageUrl(location.href);
  }

  /**
   * Destroy and cleanup all resources
   */
  destroy(): void {
    this.stopPolling();
    this.detachEventListeners();
    this.restoreHistoryMethods();

    // Clear callbacks
    this.callbacks.clear();

    overlayLog.info("[PageWatcher] Destroyed");
  }
}
