// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { isYouTubeLive, isYouTubeWatch } from '@chat/youtube/url-pattern';
import { createLogger } from '@util/logging';

const log = createLogger('PageWatcher');

/**
 * Page Watcher
 *
 * Monitors URL changes (YouTube SPA navigation) and triggers
 * re-initialization when navigating between videos.
 */

type PageChangeCallback = () => void;

const YT_NAVIGATE_FINISH_EVENT = 'yt-navigate-finish';

export class PageWatcher {
  private currentUrl: string;
  private callbacks: Set<PageChangeCallback> = new Set();
  private readonly handleUrlMutation = (): void => {
    this.handlePotentialUrlChange('currententrychange');
  };

  private readonly handleYouTubeNavigateFinish = (): void => {
    log.debug('app.page-watcher.navigation-finished');
    // Always notify — yt-navigate-finish signals data-ready even when URL is unchanged
    // (e.g., VOD→live transitions where pushState already updated the URL).
    const newUrl = this.readUrl();
    if (newUrl !== this.currentUrl) {
      this.currentUrl = newUrl;
    }
    this.notifyCallbacks();
  };

  constructor(private readonly readUrl: () => string = () => location.href) {
    this.currentUrl = this.readUrl();
    window.navigation.addEventListener('currententrychange', this.handleUrlMutation);
    window.addEventListener(YT_NAVIGATE_FINISH_EVENT, this.handleYouTubeNavigateFinish);
  }

  private handlePotentialUrlChange(source: 'currententrychange'): void {
    const newUrl = this.readUrl();
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
      } catch (error: unknown) {
        log.warn('app.page-watcher.callback-error', { error: String(error) });
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
    const url = this.readUrl();
    return isYouTubeWatch(url) || isYouTubeLive(url);
  }

  /**
   * Destroy and cleanup all resources
   */
  destroy(): void {
    window.navigation.removeEventListener('currententrychange', this.handleUrlMutation);
    window.removeEventListener(YT_NAVIGATE_FINISH_EVENT, this.handleYouTubeNavigateFinish);
    this.callbacks.clear();

    log.debug('app.page-watcher.destroyed');
  }
}
