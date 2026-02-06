/**
 * Overlay Manager
 *
 * Creates and manages the overlay container on top of the video player.
 * Handles resizing and fullscreen changes.
 */

import type { OverlayDimensions, OverlaySettings } from '@app-types';

export class Overlay {
  private container: HTMLDivElement | null = null;
  private playerElement: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private dimensions: OverlayDimensions | null = null;

  /**
   * Find player container
   */
  private findPlayerContainer(): HTMLElement | null {
    const candidates = ['#movie_player', '.html5-video-player', 'ytd-player', '#player-container'];

    console.log('[YT Chat Overlay] Looking for player container...');

    for (const selector of candidates) {
      const element = document.querySelector<HTMLElement>(selector);
      if (element && element.offsetWidth > 0 && element.offsetHeight > 0) {
        console.log('[YT Chat Overlay] Player found with selector:', selector, {
          width: element.offsetWidth,
          height: element.offsetHeight,
        });
        return element;
      }
    }

    console.warn('[YT Chat Overlay] No player container found');
    return null;
  }

  /**
   * Create overlay container
   */
  async create(settings: OverlaySettings): Promise<boolean> {
    // Find player
    for (let i = 0; i < 5; i++) {
      this.playerElement = this.findPlayerContainer();
      if (this.playerElement) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!this.playerElement) {
      console.warn('[YT Chat Overlay] Player container not found');
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

    const laneHeight = settings.fontSize * 1.4;
    const usableHeight = height * (1 - settings.safeTop - settings.safeBottom);
    const laneCount = Math.floor(usableHeight / laneHeight);

    this.dimensions = {
      width,
      height,
      laneHeight,
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
