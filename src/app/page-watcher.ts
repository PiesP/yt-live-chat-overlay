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
type HistoryMethodName = 'pushState' | 'replaceState';
type HistoryMethod = typeof history.pushState;

interface HistoryPatchState {
  readonly methodName: HistoryMethodName;
  readonly owner: PageWatcher;
  readonly previous: HistoryMethod;
  wrapper: HistoryMethod;
  readonly generation: number;
  active: boolean;
}

const YT_NAVIGATE_FINISH_EVENT = 'yt-navigate-finish';

export class PageWatcher {
  private currentUrl = location.href;
  private callbacks: Set<PageChangeCallback> = new Set();
  private restorePushState?: () => void;
  private restoreReplaceState?: () => void;
  /** Per-method generation counters prevent one history method's patch from
   * affecting the other method's cleanup. */
  private readonly patchGenerations: Record<HistoryMethodName, number> = {
    pushState: 0,
    replaceState: 0,
  };

  /** Per-instance marker for wrapper identity — avoids the static-marker
   *  problem where a second PageWatcher skips patching because the first
   *  watcher's marker is still on history.pushState/replaceState. */
  private static wrapperToState = new WeakMap<HistoryMethod, HistoryPatchState>();

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

  private patchHistoryMethod(methodName: HistoryMethodName): () => void {
    const previous = history[methodName] as HistoryMethod;
    const currentState = PageWatcher.wrapperToState.get(previous);
    // A watcher can only install one wrapper for each method. A different
    // watcher must still be allowed to wrap the current method.
    if (currentState?.owner === this && currentState.active) {
      return () => {
        /* no-op: already patched by this instance */
      };
    }

    const generation = ++this.patchGenerations[methodName];
    const state: HistoryPatchState = {
      methodName,
      owner: this,
      previous,
      wrapper: undefined as unknown as HistoryMethod,
      generation,
      active: true,
    } satisfies HistoryPatchState;
    const patched: HistoryMethod = (...args: Parameters<HistoryMethod>) => {
      const result = state.previous.apply(history, args);
      if (state.active) {
        this.handlePotentialUrlChange(methodName);
      }
      return result;
    };
    state.wrapper = patched;
    PageWatcher.wrapperToState.set(patched, state);
    history[methodName] = patched;

    return () => {
      if (!state.active) {
        return;
      }
      // An older watcher may be destroyed while a newer wrapper is active.
      // Marking this state inactive prevents the newer wrapper from invoking
      // the old watcher's callback, but does not overwrite the newer method.
      state.active = false;
      if (
        history[methodName] !== state.wrapper ||
        this.patchGenerations[methodName] !== state.generation
      ) {
        return;
      }

      // Skip inactive wrappers when unwrapping. This lets the newest watcher
      // restore the native method even if an older nested watcher was already
      // destroyed.
      let restored = state.previous;
      while (true) {
        const previousState = PageWatcher.wrapperToState.get(restored);
        if (!previousState || previousState.active) {
          break;
        }
        restored = previousState.previous;
      }
      history[methodName] = restored;
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
