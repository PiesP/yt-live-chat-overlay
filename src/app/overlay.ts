// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Overlay Manager
 *
 * Creates and manages the overlay container on top of the video player.
 * Handles resizing and fullscreen changes.
 */

import type { OverlayDimensions, OverlaySettings } from '@app-types';
import { getActiveLanguage, t } from '@i18n/index';
import { rendererLayout } from '@util/design-tokens';
import {
  clearSafeTimeout,
  ensurePlayerPositioning,
  findPlayerContainerElement,
  PLAYER_LOOKUP_INTERVAL_MS,
  SCREEN_READER_CSS,
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
  private static readonly LIVE_REGION_DEBOUNCE_MS = 500;

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
    container.setAttribute('aria-label', t('Chat Overlay'));
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
    this.liveRegion.setAttribute('aria-label', t('Chat messages'));
    this.liveRegion.className = 'yt-live-chat-overlay-live-region';
    this.liveRegion.style.cssText = SCREEN_READER_CSS;
    this.container.appendChild(this.liveRegion);

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
      this.container.setAttribute(
        'aria-label',
        `${t('Live chat overlay')} — ${getLocalizedName(lang)}`
      );
      this.announceLanguageChange(lang);
    }
  }

  /**
   * Announce a language change to screen readers via the aria-live region.
   */
  private announceLanguageChange(lang: string): void {
    if (!this.liveRegion) return;
    const langName = getLocalizedName(lang);
    this.liveRegion.textContent = `${t('Interface language changed to')}${langName}`;
  }

  /**
   * Update the aria-live region with snippets from visible canvas messages.
   * Called by the renderer so screen readers, find-in-page, and translation
   * tools can discover canvas-rendered text content. Debounced to avoid
   * flooding the accessibility tree during rapid chat.
   * Mirrors the last N visible messages as a simple text list.
   */
  updateLiveRegion(snippets: string[]): void {
    if (!this.liveRegion) return;
    if (this.liveRegionTimer !== null) {
      clearTimeout(this.liveRegionTimer);
    }
    this.liveRegionTimer = setTimeout(() => {
      this.liveRegionTimer = null;
      // Update text content with pipe-separated snippets.
      // Defend against TOCTOU: liveRegion may have been set to null by
      // destroy() between the outer null check and this callback.
      if (this.liveRegion) {
        this.liveRegion.textContent = snippets.join(' | ');
      }
    }, Overlay.LIVE_REGION_DEBOUNCE_MS);
  }

  /**
   * Get current dimensions
   */
  getDimensions(): OverlayDimensions | null {
    return this.dimensions;
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

    log.debug('app.overlay.destroyed');
  }
}
