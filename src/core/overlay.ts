/**
 * Overlay Manager
 *
 * Creates and manages the overlay container on top of the video player.
 * Handles resizing and fullscreen changes.
 */

import type { OverlayDimensions, OverlaySettings } from '@app-types';
import {
  ensurePlayerPositioning,
  findPlayerContainerElement,
  PLAYER_LOOKUP_INTERVAL_MS,
} from '@core/dom';
import { createLogger } from '@core/logging';

const log = createLogger('Overlay');

const OVERLAY_ID = 'yt-live-chat-overlay';
export const OVERLAY_SELECTOR = `#${OVERLAY_ID}`;

const FULLSCREEN_UPDATE_DELAY_MS = 100;
// line-height: 1.1 on messages; 1.12 adds just ~2% vertical slack so messages
// stay within their lane slot without visible inter-lane gaps.
const BASE_LANE_HEIGHT_MULTIPLIER = 1.12;
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

type OverlayDimensionsChangeCallback = (dimensions: OverlayDimensions | null) => void;

const areOverlayDimensionsEqual = (
  previous: OverlayDimensions | null,
  next: OverlayDimensions | null
): boolean =>
  previous?.width === next?.width &&
  previous?.height === next?.height &&
  Math.abs((previous?.laneHeight ?? 0) - (next?.laneHeight ?? 0)) < 0.0001 &&
  previous?.laneCount === next?.laneCount;

export class Overlay {
  private container: HTMLDivElement | null = null;
  private playerElement: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private dimensions: OverlayDimensions | null = null;
  private settings: OverlaySettings | null = null;
  private fullscreenHandler: (() => void) | null = null;
  private fullscreenUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly dimensionChangeCallbacks = new Set<OverlayDimensionsChangeCallback>();

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
    container.style.zIndex = OVERLAY_Z_INDEX;
    container.style.contain = 'layout style paint';
    return container;
  }

  private updateDimensions(): void {
    const nextDimensions =
      !this.playerElement || !this.container || !this.settings
        ? null
        : calculateOverlayDimensions(this.playerElement, this.settings);

    if (areOverlayDimensionsEqual(this.dimensions, nextDimensions)) {
      return;
    }

    this.dimensions = nextDimensions;
    this.notifyDimensionChangeCallbacks();
  }

  private clearFullscreenUpdateTimer(): void {
    if (this.fullscreenUpdateTimer !== null) {
      clearTimeout(this.fullscreenUpdateTimer);
      this.fullscreenUpdateTimer = null;
    }
  }

  private observeResize(): void {
    if (!this.playerElement) {
      return;
    }

    this.resizeObserver = new ResizeObserver(() => {
      this.updateDimensions();
    });
    this.resizeObserver.observe(this.playerElement);
  }

  private observeFullscreen(): void {
    this.fullscreenHandler = () => {
      this.clearFullscreenUpdateTimer();
      this.fullscreenUpdateTimer = setTimeout(() => {
        this.fullscreenUpdateTimer = null;
        this.updateDimensions();
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
  async create(settings: OverlaySettings, signal?: AbortSignal): Promise<boolean> {
    // Find player
    this.playerElement = await this.findPlayerContainer(signal);
    this.settings = settings;

    if (!this.playerElement) {
      return false;
    }

    // Ensure a clean observer state before registering new ones
    this.disconnectResizeObserver();
    this.detachFullscreenHandler();

    // Always create a fresh container (destroy() removes the previous one)
    this.container = this.createContainerElement();

    // Insert into player
    ensurePlayerPositioning(this.playerElement);
    this.playerElement.appendChild(this.container);

    this.observeResize();
    this.observeFullscreen();

    this.updateDimensions();

    log.info('Overlay created');
    return true;
  }

  updateSettings(settings: OverlaySettings): void {
    this.settings = settings;
    this.updateDimensions();
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
      } catch (error) {
        log.warn('Dimension change callback error:', error);
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

    log.debug('Destroyed');
  }
}
