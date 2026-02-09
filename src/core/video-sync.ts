/**
 * VideoSync
 *
 * Detects and monitors YouTube video element for playback state changes.
 * Provides callbacks for pause/play events to synchronize overlay animations.
 */

import { findElementMatch, waitForElementMatch } from '@core/dom';

/**
 * Callbacks for video state changes
 */
interface VideoSyncCallbacks {
  onPause?: () => void;
  onPlay?: () => void;
  onSeeking?: () => void;
  onRateChange?: (rate: number) => void;
}

/**
 * Video element selectors (in priority order)
 */
const VIDEO_SELECTORS = [
  '#movie_player video',
  '.html5-video-player video',
  'video.html5-main-video',
  'video[src]',
] as const;

/**
 * VideoSync class
 *
 * Manages video element detection and playback state synchronization.
 * Handles edge cases like delayed video loading and element replacement.
 */
export class VideoSync {
  private videoElement: HTMLVideoElement | null = null;
  private callbacks: VideoSyncCallbacks;
  private initialized = false;
  private detectInterval: number | null = null;
  private mutationObserver: MutationObserver | null = null;
  private boundHandlers = {
    pause: () => this.handlePause(),
    play: () => this.handlePlay(),
    seeking: () => this.handleSeeking(),
    ratechange: () => this.handleRateChange(),
  };

  constructor(callbacks: VideoSyncCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Initialize video synchronization
   * @returns true if video element found, false if periodic detection started
   */
  async init(): Promise<boolean> {
    // Detect video element (with retry)
    this.videoElement = await this.detectVideoElement();

    if (!this.videoElement) {
      console.warn('[VideoSync] Video element not found, starting periodic detection');
      this.startPeriodicDetection();
      return false;
    }

    this.attachListeners();
    this.observeVideoReplacement();
    this.initialized = true;
    console.log('[VideoSync] Initialized with video element');
    return true;
  }

  /**
   * Detect video element in player container
   * Retries multiple times to handle slow page loads
   */
  private async detectVideoElement(): Promise<HTMLVideoElement | null> {
    const match = await waitForElementMatch<HTMLVideoElement>(VIDEO_SELECTORS, {
      attempts: 5,
      intervalMs: 500,
      predicate: (video) => {
        // Validate video is ready and has dimensions
        return video.readyState >= 2 && video.videoWidth > 0;
      },
    });

    if (match) {
      console.log('[VideoSync] Found video element:', match.selector);
      return match.element;
    }

    return null;
  }

  /**
   * Start periodic detection for video element
   * Used when video is not immediately available (ads, live stream loading, etc.)
   */
  private startPeriodicDetection(): void {
    if (this.detectInterval !== null) return;

    this.detectInterval = window.setInterval(() => {
      if (this.initialized) {
        this.stopPeriodicDetection();
        return;
      }

      // Try immediate detection (no wait)
      const match = findElementMatch<HTMLVideoElement>(VIDEO_SELECTORS, {
        predicate: (video) => video.readyState >= 2 && video.videoWidth > 0,
      });

      if (match) {
        this.videoElement = match.element;
        this.attachListeners();
        this.observeVideoReplacement();
        this.initialized = true;
        this.stopPeriodicDetection();
        console.log('[VideoSync] Video element detected via periodic check:', match.selector);
      }
    }, 2000);

    console.log('[VideoSync] Periodic detection started (every 2 seconds)');
  }

  /**
   * Stop periodic detection interval
   */
  private stopPeriodicDetection(): void {
    if (this.detectInterval !== null) {
      window.clearInterval(this.detectInterval);
      this.detectInterval = null;
      console.log('[VideoSync] Periodic detection stopped');
    }
  }

  /**
   * Attach event listeners to video element
   */
  private attachListeners(): void {
    if (!this.videoElement) return;

    this.videoElement.addEventListener('pause', this.boundHandlers.pause);
    this.videoElement.addEventListener('play', this.boundHandlers.play);
    this.videoElement.addEventListener('seeking', this.boundHandlers.seeking);
    this.videoElement.addEventListener('ratechange', this.boundHandlers.ratechange);

    console.log('[VideoSync] Event listeners attached');
  }

  /**
   * Observe video element replacement
   * Detects when video element is removed from DOM (e.g., during ad transitions)
   */
  private observeVideoReplacement(): void {
    if (!this.videoElement) return;

    // Find the player container to observe
    const playerContainer = document.querySelector('#movie_player, .html5-video-player');
    if (!playerContainer) {
      console.warn('[VideoSync] Player container not found, cannot observe video replacement');
      return;
    }

    // Create MutationObserver to watch for video element removal
    this.mutationObserver = new MutationObserver(() => {
      if (this.videoElement && !document.contains(this.videoElement)) {
        console.log('[VideoSync] Video element removed from DOM, reinitializing...');
        this.handleVideoReplacement();
      }
    });

    // Observe the player container for child changes
    this.mutationObserver.observe(playerContainer, {
      childList: true,
      subtree: true,
    });

    console.log('[VideoSync] Video replacement observer attached');
  }

  /**
   * Stop observing video replacement
   */
  private stopObservingReplacement(): void {
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
      console.log('[VideoSync] Video replacement observer stopped');
    }
  }

  /**
   * Handle video element replacement
   * Called when video element is removed from DOM
   */
  private handleVideoReplacement(): void {
    // Clean up existing video
    this.detachListeners();
    this.stopObservingReplacement();
    this.videoElement = null;
    this.initialized = false;

    // Try to reinitialize after a short delay
    setTimeout(() => {
      console.log('[VideoSync] Attempting to reacquire video element...');
      this.init().catch((error) => {
        console.warn('[VideoSync] Failed to reinitialize after video replacement:', error);
      });
    }, 1000);
  }

  /**
   * Detach event listeners from video element
   */
  private detachListeners(): void {
    if (!this.videoElement) return;

    this.videoElement.removeEventListener('pause', this.boundHandlers.pause);
    this.videoElement.removeEventListener('play', this.boundHandlers.play);
    this.videoElement.removeEventListener('seeking', this.boundHandlers.seeking);
    this.videoElement.removeEventListener('ratechange', this.boundHandlers.ratechange);

    console.log('[VideoSync] Event listeners detached');
  }

  /**
   * Handle pause event
   */
  private handlePause(): void {
    console.log('[VideoSync] Video paused');
    if (this.callbacks.onPause) {
      this.callbacks.onPause();
    }
  }

  /**
   * Handle play event
   */
  private handlePlay(): void {
    console.log('[VideoSync] Video playing');
    if (this.callbacks.onPlay) {
      this.callbacks.onPlay();
    }
  }

  /**
   * Handle seeking event
   */
  private handleSeeking(): void {
    console.log('[VideoSync] Video seeking');
    if (this.callbacks.onSeeking) {
      this.callbacks.onSeeking();
    }
  }

  /**
   * Handle playback rate change event
   */
  private handleRateChange(): void {
    const rate = this.videoElement?.playbackRate ?? 1.0;
    console.log('[VideoSync] Playback rate changed:', rate);
    if (this.callbacks.onRateChange) {
      this.callbacks.onRateChange(rate);
    }
  }

  /**
   * Check if video is currently paused
   * @returns true if paused or video not found, false if playing
   */
  isPaused(): boolean {
    return this.videoElement?.paused ?? true;
  }

  /**
   * Get current playback rate
   * @returns playback rate (1.0 = normal speed), defaults to 1.0 if no video
   */
  getPlaybackRate(): number {
    return this.videoElement?.playbackRate ?? 1.0;
  }

  /**
   * Check if video sync is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Destroy and cleanup
   */
  destroy(): void {
    this.stopPeriodicDetection();
    this.stopObservingReplacement();
    this.detachListeners();
    this.videoElement = null;
    this.initialized = false;
    console.log('[VideoSync] Destroyed');
  }
}
