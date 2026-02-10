/**
 * Overlay Manager
 *
 * Creates and manages the overlay container on top of the video player.
 * Handles resizing and fullscreen changes.
 */

import type { OverlayDimensions, OverlaySettings } from '@app-types';
import { isVisibleElement, PLAYER_CONTAINER_SELECTORS, waitForElementMatch } from '@core/dom';

export class Overlay {
  private container: HTMLDivElement | null = null;
  private playerElement: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private dimensions: OverlayDimensions | null = null;

  /**
   * Find player container
   */
  private async findPlayerContainer(): Promise<HTMLElement | null> {
    console.log('[YT Chat Overlay] Looking for player container...');

    const match = await waitForElementMatch<HTMLElement>(PLAYER_CONTAINER_SELECTORS, {
      attempts: 5,
      intervalMs: 1000,
      predicate: isVisibleElement,
    });

    if (!match) {
      console.warn('[YT Chat Overlay] No player container found');
      return null;
    }

    console.log('[YT Chat Overlay] Player found with selector:', match.selector, {
      width: match.element.offsetWidth,
      height: match.element.offsetHeight,
    });
    return match.element;
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
    this.container = document.createElement('div');
    this.container.id = 'yt-live-chat-overlay';
    this.container.style.cssText = `
      position: absolute;
      inset: 0;
      pointer-events: none;
      overflow: hidden;
      z-index: 100;
      contain: layout style paint;
    `;

    // Insert into player
    this.playerElement.style.position = 'relative';
    this.playerElement.appendChild(this.container);

    // Setup resize observer
    this.resizeObserver = new ResizeObserver(() => {
      this.updateDimensions(settings);
    });
    this.resizeObserver.observe(this.playerElement);

    // Monitor fullscreen changes
    document.addEventListener('fullscreenchange', () => {
      setTimeout(() => this.updateDimensions(settings), 100);
    });

    this.updateDimensions(settings);

    console.log('[YT Chat Overlay] Overlay created');
    return true;
  }

  /**
   * Update overlay dimensions
   */
  private updateDimensions(settings: OverlaySettings): void {
    if (!this.container || !this.playerElement) return;

    const width = this.playerElement.offsetWidth;
    const height = this.playerElement.offsetHeight;

    if (width === 0 || height === 0) return;

    // Base lane height for dynamic allocation
    // Single-line messages (without author) will use 1 lane (~1.4x fontSize)
    // Two-line messages (with author info) will use 2 lanes (~2.8x fontSize)
    // This allows more efficient space utilization - approximately 2x more lanes available
    // The renderer will dynamically allocate multiple lanes based on actual message height
    const baseLaneHeight = settings.fontSize * 1.4;
    const usableHeight = height * (1 - settings.safeTop - settings.safeBottom);
    const laneCount = Math.floor(usableHeight / baseLaneHeight);

    this.dimensions = {
      width,
      height,
      laneHeight: baseLaneHeight,
      laneCount: Math.max(1, laneCount),
    };
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
   * Destroy overlay
   */
  destroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    if (this.container?.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }

    this.container = null;
    this.playerElement = null;
    this.dimensions = null;
    console.log('[YT Chat Overlay] Overlay destroyed');
  }
}
