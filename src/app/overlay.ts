// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Overlay Manager
 *
 * Creates and manages the overlay container on top of the video player.
 * Handles resizing and fullscreen changes.
 */

import type { AccessibleChatMessage, OverlayDimensions, OverlaySettings } from '@app-types';
import { getActiveLanguage, t } from '@i18n/index';
import { rendererLayout } from '@util/design-tokens';
import {
  clearSafeTimeout,
  ensurePlayerPositioning,
  findPlayerContainerElement,
  PLAYER_LOOKUP_INTERVAL_MS,
  SCREEN_READER_CSS,
  throwIfAborted,
} from '@util/dom';
import { createLogger } from '@util/logging';

const log = createLogger('Overlay');

const OVERLAY_ID = 'yt-live-chat-overlay';
export const OVERLAY_SELECTOR = `#${OVERLAY_ID}`;

/** Return the native/endonym name for a supported language code, translated to the current UI language. */
const getLocalizedName = (lang: string): string =>
  lang === 'ar'
    ? t('العربية')
    : lang === 'zh-CN'
      ? t('中文')
      : lang === 'ko'
        ? t('한국어')
        : lang === 'ja'
          ? t('日本語')
          : lang === 'es'
            ? t('Español')
            : t('English');

const calculateOverlayDimensionsFromRect = (
  width: number,
  height: number
): OverlayDimensions | null => {
  if (width === 0 || height === 0) {
    return null;
  }
  return { width: Math.round(width), height: Math.round(height) };
};

type OverlayDimensionsChangeCallback = (dimensions: OverlayDimensions | null) => void;

const areOverlayDimensionsEqual = (
  previous: OverlayDimensions | null,
  next: OverlayDimensions | null
): boolean => previous?.width === next?.width && previous?.height === next?.height;

export class Overlay {
  private container: HTMLDivElement | null = null;
  private playerElement: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private dimensions: OverlayDimensions | null = null;
  private settings: OverlaySettings | null = null;
  private fullscreenHandler: (() => void) | null = null;
  private fullscreenUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly dimensionChangeCallbacks = new Set<OverlayDimensionsChangeCallback>();
  /** rAF-based resize coalescing to avoid cascading updates during drag-resize. */
  private resizePending = false;
  private resizeRafId: number | null = null;
  /** Aria-live region for announcing new chat messages to screen readers. */
  private liveRegion: HTMLDivElement | null = null;
  /** Debounce timer for live region updates. */
  private liveRegionTimer: ReturnType<typeof setTimeout> | null = null;
  /** Stable identities of recently announced messages. */
  private seenMessageIds = new Set<string>();
  private static readonly LIVE_REGION_DEBOUNCE_MS = 500;
  private static readonly SEEN_SNIPPET_MAX = 200;

  /** User-initiated pause (Space key toggle). Independent from tab/video pause. */
  private isUserPaused = false;
  private readonly userPauseCallbacks = new Set<(paused: boolean) => void>();
  private pauseIndicatorEl: HTMLDivElement | null = null;
  private keyboardHandler: ((e: KeyboardEvent) => void) | null = null;

  /**
   * Find player container
   */
  private async findPlayerContainer(signal?: AbortSignal): Promise<HTMLElement | null> {
    const player = await findPlayerContainerElement({
      intervalMs: PLAYER_LOOKUP_INTERVAL_MS,
      signal,
    });
    if (player) {
      log.debug('Player dimensions:', {
        width: player.offsetWidth,
        height: player.offsetHeight,
      });
    }
    return player;
  }

  private createContainerElement(): HTMLDivElement {
    const container = document.createElement('div');
    container.id = OVERLAY_ID;
    container.style.position = 'absolute';
    container.style.inset = '0';
    container.style.pointerEvents = 'none';
    container.style.overflow = 'hidden';
    container.style.zIndex = rendererLayout.overlayZIndex;
    container.style.contain = 'layout style paint';
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', t('app.title'));
    // Set lang attribute to match active language for screen readers
    const initialLang = getActiveLanguage();
    container.lang = initialLang;
    container.dir = initialLang === 'ar' ? 'rtl' : 'ltr';
    return container;
  }

  private updateDimensions(): void {
    if (!this.playerElement || !this.container || !this.settings) {
      if (this.dimensions !== null) {
        this.dimensions = null;
        this.notifyDimensionChangeCallbacks();
      }
      return;
    }
    const rect = this.container.getBoundingClientRect();
    const nextDimensions = calculateOverlayDimensionsFromRect(rect.width, rect.height);

    if (areOverlayDimensionsEqual(this.dimensions, nextDimensions)) {
      return;
    }

    this.dimensions = nextDimensions;
    this.notifyDimensionChangeCallbacks();
  }

  private clearFullscreenUpdateTimer(): void {
    this.fullscreenUpdateTimer = clearSafeTimeout(this.fullscreenUpdateTimer);
  }

  private observeResize(): void {
    if (!this.playerElement) {
      return;
    }

    let latestEntry: ResizeObserverEntry | null = null;
    this.resizeObserver = new ResizeObserver((entries) => {
      // Use contentRect from the ResizeObserverEntry to avoid forced
      // synchronous layout that element.offsetWidth/offsetHeight triggers.
      const entry = entries[0];
      if (!entry) return;
      latestEntry = entry;

      // Coalesce multiple synchronised ResizeObserver callbacks into a single
      // rAF frame. During window drag-resize, the observer fires for every
      // intermediate size change. Without coalescing, each event triggers
      // updateDimensions() → notifyDimensionChangeCallbacks() →
      // canvas.applyDevicePixelRatio() + laneAllocator.reset(), which is
      // expensive when called dozens of times per second.
      if (this.resizePending) return;
      this.resizePending = true;
      // Cancel any previously scheduled rAF — only the latest resize matters.
      if (this.resizeRafId !== null) {
        cancelAnimationFrame(this.resizeRafId);
      }
      this.resizeRafId = requestAnimationFrame(() => {
        this.resizeRafId = null;
        this.resizePending = false;
        if (!latestEntry) return;
        const { width, height } = latestEntry.contentRect;
        this.updateDimensionsFromRect(width, height);
      });
    });
    this.resizeObserver.observe(this.playerElement);
  }

  private updateDimensionsFromRect(width: number, height: number): void {
    const nextDimensions = calculateOverlayDimensionsFromRect(width, height);

    if (areOverlayDimensionsEqual(this.dimensions, nextDimensions)) {
      return;
    }

    this.dimensions = nextDimensions;
    this.notifyDimensionChangeCallbacks();
  }

  private observeFullscreen(): void {
    this.fullscreenHandler = () => {
      this.clearFullscreenUpdateTimer();
      this.fullscreenUpdateTimer = setTimeout(() => {
        this.fullscreenUpdateTimer = null;
        this.updateDimensions();
      }, rendererLayout.fullscreenUpdateDelayMs);
    };

    document.addEventListener('fullscreenchange', this.fullscreenHandler);
  }

  private disconnectResizeObserver(): void {
    if (!this.resizeObserver) {
      return;
    }

    this.resizeObserver.disconnect();
    this.resizeObserver = null;
    // Cancel any pending rAF-scheduled resize update — without the observer
    // there is no source for future resize events, and the stale callback
    // would operate on a disconnected state.
    if (this.resizeRafId !== null) {
      cancelAnimationFrame(this.resizeRafId);
      this.resizeRafId = null;
    }
    this.resizePending = false;
  }

  private detachFullscreenHandler(): void {
    this.clearFullscreenUpdateTimer();

    if (!this.fullscreenHandler) {
      return;
    }

    document.removeEventListener('fullscreenchange', this.fullscreenHandler);
    this.fullscreenHandler = null;
  }

  /**
   * Create overlay container
   */
  async create(settings: OverlaySettings, signal?: AbortSignal): Promise<boolean> {
    // Ensure a clean observer state before re-initializing
    this.disconnectResizeObserver();
    this.detachFullscreenHandler();

    // Remove any existing container before creating a new one
    if (this.container) {
      this.container.remove();
      this.container = null;
    }

    // Clean up stray overlay elements from previous sessions where destroy()
    // was never called (e.g. RuntimeSession restart without full teardown)
    const strayOverlays = document.querySelectorAll(OVERLAY_SELECTOR);
    for (const el of strayOverlays) {
      el.remove();
    }

    // Find player
    this.playerElement = await this.findPlayerContainer(signal);
    throwIfAborted(signal);
    this.settings = settings;

    if (!this.playerElement) {
      return false;
    }

    // Always create a fresh container
    this.container = this.createContainerElement();

    // Insert into player
    ensurePlayerPositioning(this.playerElement);
    this.playerElement.appendChild(this.container);

    this.observeResize();
    this.observeFullscreen();

    this.updateDimensions();

    // Create aria-live region for screen reader announcements of new messages
    this.liveRegion = document.createElement('div');
    this.liveRegion.setAttribute('role', 'log');
    this.liveRegion.setAttribute('aria-live', 'polite');
    this.liveRegion.setAttribute('aria-label', t('chat.messages'));
    this.liveRegion.className = 'yt-live-chat-overlay-live-region';
    this.liveRegion.style.cssText = SCREEN_READER_CSS;
    this.container.appendChild(this.liveRegion);

    // Attach keyboard handler for Space-key pause toggle
    this.attachKeyboardHandler();

    log.info('app.overlay.created');
    return true;
  }

  updateSettings(settings: OverlaySettings): void {
    this.settings = settings;
    this.updateDimensions();
  }

  /**
   * Update the lang attribute on the overlay container to match the active language.
   * Call this when the language setting changes.
   * Sets dir="rtl" for Arabic, "ltr" otherwise, and announces the change
   * to screen readers via the live region.
   */
  updateLanguage(): void {
    if (this.container) {
      const lang = getActiveLanguage();
      this.container.lang = lang;
      this.container.dir = lang === 'ar' ? 'rtl' : 'ltr';
      this.container.setAttribute('aria-label', `${t('app.name')} — ${getLocalizedName(lang)}`);
      this.announceLanguageChange(lang);
    }
  }

  /**
   * Announce a language change to screen readers via the aria-live region.
   */
  private announceLanguageChange(lang: string): void {
    if (!this.liveRegion) return;
    const langName = getLocalizedName(lang);
    this.liveRegion.textContent = `${t('app.langChanged')}${langName}`;
  }

  /**
   * Update the aria-live region with structured alternatives for visible canvas messages.
   * Called by the renderer so screen readers, find-in-page, and translation
   * tools can discover canvas-rendered text content.
   *
   * Appends only new (previously unseen) messages as individual DOM
   * elements so screen readers announce only fresh content instead of
   * re-reading the entire visible-message list every cycle.
   *
   * Debounced to 500ms to avoid flooding the accessibility tree during
   * rapid chat.
   */
  updateLiveRegion(messages: AccessibleChatMessage[]): void {
    if (!this.liveRegion) return;
    if (this.liveRegionTimer !== null) {
      clearTimeout(this.liveRegionTimer);
    }
    this.liveRegionTimer = setTimeout(() => {
      this.liveRegionTimer = null;
      if (!this.liveRegion) return;

      // Filter by stable message identity so repeated text from different
      // chat messages remains available to assistive technology.
      const newMessages: AccessibleChatMessage[] = [];
      for (const message of messages) {
        if (!this.seenMessageIds.has(message.id)) {
          newMessages.push(message);
          this.seenMessageIds.add(message.id);
          // Trim oldest entries when set grows too large.
          if (this.seenMessageIds.size > Overlay.SEEN_SNIPPET_MAX) {
            let removed = 0;
            for (const id of this.seenMessageIds) {
              this.seenMessageIds.delete(id);
              if (++removed >= 50) break;
            }
          }
        }
      }

      if (newMessages.length === 0) return;

      // Append new snippets as individual <p> elements so screen readers
      // announce only the new content, not the entire list.
      const frag = document.createDocumentFragment();
      for (const message of newMessages) {
        const p = document.createElement('p');
        p.dataset.messageId = message.id;
        p.textContent = this.formatAccessibleMessage(message);
        frag.appendChild(p);
      }

      // Keep the live region manageable: remove old children if too many.
      const maxChildren = 30;
      while (this.liveRegion.children.length >= maxChildren) {
        const first = this.liveRegion.firstElementChild;
        if (first) first.remove();
        else break;
      }

      this.liveRegion.appendChild(frag);
    }, Overlay.LIVE_REGION_DEBOUNCE_MS);
  }

  private formatAccessibleMessage(message: AccessibleChatMessage): string {
    const parts: string[] = [];
    if (message.kind === 'superchat') {
      parts.push(t('chat.superChat'));
      if (message.superChatAmount) parts.push(message.superChatAmount);
    } else if (message.kind === 'membership') {
      parts.push(t('chat.membership'));
      if (message.membershipHeader) parts.push(message.membershipHeader);
    }
    if (message.author) parts.push(message.author);
    if (message.text) parts.push(message.text);
    return parts.join(' — ');
  }

  /**
   * Get current dimensions
   */
  getDimensions(): OverlayDimensions | null {
    return this.dimensions;
  }

  /**
   * Toggle user-initiated pause. Returns new state.
   * Press Ctrl+Space to pause/resume overlay scrolling.
   * Independent from tab visibility and video pause.
   */
  toggleUserPause(): boolean {
    this.isUserPaused = !this.isUserPaused;
    for (const cb of this.userPauseCallbacks) {
      try {
        cb(this.isUserPaused);
      } catch {
        // Ignore errors in individual callbacks
      }
    }
    this.showPauseIndicator(this.isUserPaused);
    return this.isUserPaused;
  }

  /** Subscribe to user-pause state changes. Returns unsubscribe function. */
  onUserPauseChanged(callback: (paused: boolean) => void): () => void {
    this.userPauseCallbacks.add(callback);
    return () => {
      this.userPauseCallbacks.delete(callback);
    };
  }

  /** Show/hide the pause indicator in the overlay corner. */
  private showPauseIndicator(show: boolean): void {
    if (!this.container) return;
    if (show) {
      if (!this.pauseIndicatorEl) {
        const el = document.createElement('div');
        el.textContent = t('app.paused');
        el.style.cssText =
          'position:absolute;top:8px;right:8px;z-index:100;background:rgba(0,0,0,0.7);color:#fff;font:14px/1.4 sans-serif;padding:4px 10px;border-radius:4px;pointer-events:none';
        this.container.appendChild(el);
        this.pauseIndicatorEl = el;
      }
      this.pauseIndicatorEl.style.display = 'block';
    } else if (this.pauseIndicatorEl) {
      this.pauseIndicatorEl.style.display = 'none';
    }
  }

  /**
   * Attach keyboard handler for Ctrl+Space overlay pause toggle.
   *
   * Plain Space is intentionally NOT intercepted — that would block
   * YouTube's native play/pause shortcut.  Ctrl+Space is the overlay-only
   * gesture that pauses/resumes chat scrolling without affecting the video.
   */
  private attachKeyboardHandler(): void {
    this.keyboardHandler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.target as HTMLElement)?.isContentEditable) return;

      // Require Ctrl modifier to avoid intercepting YouTube's Space shortcut
      if (e.code === 'Space' && e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        this.toggleUserPause();
      }
    };
    document.addEventListener('keydown', this.keyboardHandler);
  }

  onDimensionsChanged(callback: OverlayDimensionsChangeCallback): () => void {
    this.dimensionChangeCallbacks.add(callback);
    return () => {
      this.dimensionChangeCallbacks.delete(callback);
    };
  }

  /**
   * Get overlay container
   */
  getContainer(): HTMLDivElement | null {
    return this.container;
  }

  private notifyDimensionChangeCallbacks(): void {
    for (const callback of this.dimensionChangeCallbacks) {
      try {
        callback(this.dimensions);
      } catch (error: unknown) {
        log.warn('app.overlay.callback-error', { error: String(error) });
      }
    }
  }

  /**
   * Destroy and cleanup all resources
   */
  destroy(): void {
    this.disconnectResizeObserver();
    this.detachFullscreenHandler();

    // Remove the container from the DOM entirely so successive create() calls
    // always start from a clean slate (no hidden ghost containers). The
    // downstream RuntimeSession.removeLeftoverOverlays() provides a secondary
    // defense against strays.
    if (this.container) {
      this.container.remove();
    }

    // Clear references
    this.container = null;
    this.playerElement = null;
    this.dimensions = null;
    this.settings = null;
    this.dimensionChangeCallbacks.clear();
    this.liveRegion = null;

    // Clear any pending live-region update timer to prevent
    // a stale setTimeout callback from accessing the null liveRegion.
    if (this.liveRegionTimer !== null) {
      clearTimeout(this.liveRegionTimer);
      this.liveRegionTimer = null;
    }

    // Clear dedup set to free memory
    this.seenMessageIds.clear();

    // Detach keyboard handler
    if (this.keyboardHandler) {
      document.removeEventListener('keydown', this.keyboardHandler);
      this.keyboardHandler = null;
    }

    // Remove pause indicator
    if (this.pauseIndicatorEl) {
      this.pauseIndicatorEl.remove();
      this.pauseIndicatorEl = null;
    }

    log.debug('app.overlay.destroyed');
  }
}
