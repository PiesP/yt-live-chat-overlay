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

type NavigationSignalSource = 'pushState' | 'replaceState' | 'popstate' | 'yt-navigate-finish';

const YT_NAVIGATE_FINISH_EVENT = 'yt-navigate-finish';

export class PageWatcher {
  private currentUrl = location.href;
  private callbacks: Set<PageChangeCallback> = new Set();
  private restorePushState?: () => void;
  private restoreReplaceState?: () => void;
  /**
   * Generation counter for history-patching guard.
   *
   * Each call to `patchHistoryMethod()` bumps this counter so we can detect
   * when a previous patch was already applied (e.g. if PageWatcher is
   * constructed multiple times during a SPA session). The restore function
   * checks the generation it was created at and refuses to roll back a
   * newer patch.
   */
  private patchGeneration = 0;
  /**
   * Unique marker stamped onto the patched history methods so we can tell
   * our patches apart from other code (e.g. YouTube's own wrappers) that
   * may also monkey-patch pushState/replaceState.
   */
  private static readonly PATCH_MARKER = '__yt_chat_overlay_patched__';

  private readonly handleUrlMutation = (): void => {
    this.handlePotentialUrlChange('popstate');
  };

  private readonly handleYouTubeNavigateFinish = (): void => {
    log.debug('app.page-watcher.navigation-finished');
    // Always notify — yt-navigate-finish signals data-ready even when URL is unchanged
    // (e.g., VOD→live transitions where pushState already updated the URL).
    const newUrl = location.href;
    if (newUrl !== this.currentUrl) {
      this.currentUrl = newUrl;
    }
    this.notifyCallbacks();
  };

  constructor() {
    this.restorePushState = this.patchHistoryMethod('pushState');
    this.restoreReplaceState = this.patchHistoryMethod('replaceState');
    window.addEventListener('popstate', this.handleUrlMutation);
    window.addEventListener(YT_NAVIGATE_FINISH_EVENT, this.handleYouTubeNavigateFinish);
  }

  private patchHistoryMethod(methodName: 'pushState' | 'replaceState'): () => void {
    const original = history[methodName];
    // Guard: if this method was already patched by us (marker present),
    // skip re-patching to avoid double-wrapping.
    const originalWithMarker = original as unknown as { [key: string]: unknown };
    if (originalWithMarker[PageWatcher.PATCH_MARKER] === true) {
      return () => {
        /* no-op: already patched */
      };
    }
    this.patchGeneration++;
    const myGeneration = this.patchGeneration;
    const patched = (...args: Parameters<typeof history.pushState>) => {
      const result = original.apply(history, args);
      this.handlePotentialUrlChange(methodName);
      return result;
    };
    // Stamp marker so future patches can detect this is our wrapper.
    const patchedWithMarker = patched as unknown as { [key: string]: unknown };
    patchedWithMarker[PageWatcher.PATCH_MARKER] = true;
    history[methodName] = patched;
    return () => {
      // Only restore if no newer patch has been applied since us.
      if (this.patchGeneration === myGeneration) {
        history[methodName] = original;
      }
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
    return isYouTubeWatch(location.href) || isYouTubeLive(location.href);
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

    log.debug('app.page-watcher.destroyed');
  }
}
