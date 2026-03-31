/**
 * Overlay Manager
 *
 * Creates and manages the overlay container on top of the video player.
 * Handles resizing and fullscreen changes.
 */

import type { OverlayDimensions, OverlaySettings } from '@app-types';
import { ensurePlayerPositioning, findPlayerContainerElement } from '@core/dom';

const OVERLAY_ID = 'yt-live-chat-overlay';
const PLAYER_LOOKUP_INTERVAL_MS = 1000;
const FULLSCREEN_UPDATE_DELAY_MS = 100;
// Reduced from 1.3 → 1.2 to pack lanes more tightly (~8% more rows).
// Requires the renderer to set line-height: 1.1 on messages so that the
// rendered element height stays below (fontSize × 1.2 - padding), keeping
// single-line messages in exactly 1 lane at all supported font sizes.
const BASE_LANE_HEIGHT_MULTIPLIER = 1.2;
const OVERLAY_Z_INDEX = '100';

const calculateOverlayDimensions = (
  playerElement: HTMLElement,
  settings: OverlaySettings
): OverlayDimensions | null => {
  const width = playerElement.offsetWidth;
  const height = playerElement.offsetHeight;

  if (width === 0 || height === 0) {
    return null;
  }

  // Base lane height for dynamic allocation.
  // Single-line messages (without author) use 1 lane (~1.2x fontSize).
  // Two-line messages (with author info) use 2+ lanes dynamically.
  // line-height: 1.1 is set on message elements so rendered height stays
  // within one lane slot at all supported font sizes (18-40 px).
  const laneHeight = settings.fontSize * BASE_LANE_HEIGHT_MULTIPLIER + settings.laneSpacing;
  const usableHeight = height * (1 - settings.safeTop - settings.safeBottom);
  const laneCount = Math.max(1, Math.floor(usableHeight / laneHeight));

  return {
    width,
    height,
    laneHeight,
    laneCount,
  };
};

export class Overlay {
  private container: HTMLDivElement | null = null;
  private playerElement: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private dimensions: OverlayDimensions | null = null;
  private fullscreenHandler: (() => void) | null = null;
  private fullscreenUpdateTimer: number | null = null;

  /**
   * Find player container
   */
  private async findPlayerContainer(): Promise<HTMLElement | null> {
    const player = await findPlayerContainerElement({ intervalMs: PLAYER_LOOKUP_INTERVAL_MS });
    if (player) {
      console.log('[YT Chat Overlay] Player dimensions:', {
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
    container.style.zIndex = OVERLAY_Z_INDEX;
    container.style.contain = 'layout style paint';
    return container;
  }

  private updateDimensions(settings: OverlaySettings): void {
    if (!this.playerElement || !this.container) {
      this.dimensions = null;
      return;
    }

    this.dimensions = calculateOverlayDimensions(this.playerElement, settings);
  }

  private clearFullscreenUpdateTimer(): void {
    if (this.fullscreenUpdateTimer !== null) {
      window.clearTimeout(this.fullscreenUpdateTimer);
      this.fullscreenUpdateTimer = null;
    }
  }

  private observeResize(settings: OverlaySettings): void {
    if (!this.playerElement) {
      return;
    }

    this.resizeObserver = new ResizeObserver(() => {
      this.updateDimensions(settings);
    });
    this.resizeObserver.observe(this.playerElement);
  }

  private observeFullscreen(settings: OverlaySettings): void {
    this.fullscreenHandler = () => {
      this.clearFullscreenUpdateTimer();
      this.fullscreenUpdateTimer = window.setTimeout(() => {
        this.fullscreenUpdateTimer = null;
        this.updateDimensions(settings);
      }, FULLSCREEN_UPDATE_DELAY_MS);
    };

    document.addEventListener('fullscreenchange', this.fullscreenHandler);
  }

  private disconnectResizeObserver(): void {
    if (!this.resizeObserver) {
      return;
    }

    this.resizeObserver.disconnect();
    this.resizeObserver = null;
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
  async create(settings: OverlaySettings): Promise<boolean> {
    // Find player
    this.playerElement = await this.findPlayerContainer();

    if (!this.playerElement) {
      return false;
    }

    // Create overlay container
    this.container = this.createContainerElement();

    // Insert into player
    ensurePlayerPositioning(this.playerElement);
    this.playerElement.appendChild(this.container);

    this.observeResize(settings);
    this.observeFullscreen(settings);

    this.updateDimensions(settings);

    console.log('[YT Chat Overlay] Overlay created');
    return true;
  }

  /**
   * Get current dimensions
   */
  getDimensions(): OverlayDimensions | null {
    return this.dimensions;
  }

  /**
   * Get overlay container
   */
  getContainer(): HTMLDivElement | null {
    return this.container;
  }

  /**
   * Destroy and cleanup all resources
   */
  destroy(): void {
    this.disconnectResizeObserver();
    this.detachFullscreenHandler();

    // Remove DOM elements
    this.container?.remove();

    // Clear references
    this.container = null;
    this.playerElement = null;
    this.dimensions = null;

    console.log('[Overlay] Destroyed');
  }
}
