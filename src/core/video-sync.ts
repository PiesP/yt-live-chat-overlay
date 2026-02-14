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
 * Player container selectors for MutationObserver
 */
const PLAYER_CONTAINER_SELECTORS = '#movie_player, .html5-video-player';

/**
 * Configuration constants
 */
const CONFIG = {
  /** Number of detection attempts with delay */
  DETECTION_ATTEMPTS: 5,
  /** Delay between detection attempts (ms) */
  DETECTION_INTERVAL_MS: 500,
  /** Periodic detection interval (ms) */
  PERIODIC_DETECTION_INTERVAL_MS: 2000,
  /** Delay before reinitializing after video replacement (ms) */
  REINITIALIZATION_DELAY_MS: 1000,
  /** Minimum video readyState for acceptance */
  MIN_READY_STATE: 2,
} as const;

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
    const videoElement = await this.detectVideoElement();

    if (!videoElement) {
      console.warn('[VideoSync] Video element not found, starting periodic detection');
      this.startPeriodicDetection();
      return false;
    }

    this.setupVideoElement(videoElement);
    console.log('[VideoSync] Initialized with video element');
    return true;
  }

  /**
   * Detect video element in player container
   * Retries multiple times to handle slow page loads
   */
  private async detectVideoElement(): Promise<HTMLVideoElement | null> {
    const match = await waitForElementMatch<HTMLVideoElement>(VIDEO_SELECTORS, {
      attempts: CONFIG.DETECTION_ATTEMPTS,
      intervalMs: CONFIG.DETECTION_INTERVAL_MS,
      predicate: this.isVideoReady,
    });

    if (match) {
      console.log('[VideoSync] Found video element:', match.selector);
      return match.element;
    }

    return null;
  }

  /**
   * Check if video element is ready for use
   */
  private isVideoReady(video: HTMLVideoElement): boolean {
    return video.readyState >= CONFIG.MIN_READY_STATE && video.videoWidth > 0;
  }

  /**
   * Setup video element with listeners and observers
   */
  private setupVideoElement(video: HTMLVideoElement): void {
    this.videoElement = video;
    this.attachListeners();
    this.observeVideoReplacement();
    this.initialized = true;

    // Sync initial playback state immediately (covers already-paused videos)
    this.callbacks.onRateChange?.(video.playbackRate || 1.0);
    if (video.paused) {
      this.callbacks.onPause?.();
    } else {
      this.callbacks.onPlay?.();
    }
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

      const match = findElementMatch<HTMLVideoElement>(VIDEO_SELECTORS, {
        predicate: this.isVideoReady,
      });

      if (match) {
        this.setupVideoElement(match.element);
        this.stopPeriodicDetection();
        console.log('[VideoSync] Video element detected via periodic check:', match.selector);
      }
    }, CONFIG.PERIODIC_DETECTION_INTERVAL_MS);

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
   * Observe video element replacement
   * Detects when video element is removed from DOM (e.g., during ad transitions)
   */
  private observeVideoReplacement(): void {
    if (!this.videoElement) return;

    const playerContainer = document.querySelector(PLAYER_CONTAINER_SELECTORS);
    if (!playerContainer) {
      console.warn('[VideoSync] Player container not found, cannot observe video replacement');
      return;
    }

    this.mutationObserver = new MutationObserver(() => {
      if (this.videoElement && !document.contains(this.videoElement)) {
        console.log('[VideoSync] Video element removed from DOM, reinitializing...');
        this.handleVideoReplacement();
      }
    });

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
    this.cleanup();

    setTimeout(() => {
      console.log('[VideoSync] Attempting to reacquire video element...');
      this.init().catch((error) => {
        console.warn('[VideoSync] Failed to reinitialize after video replacement:', error);
      });
    }, CONFIG.REINITIALIZATION_DELAY_MS);
  }

  /**
   * Clean up video element state
   */
  private cleanup(): void {
    this.detachListeners();
    this.stopObservingReplacement();
    this.videoElement = null;
    this.initialized = false;
  }

  /**
   * Event handlers
   */
  private handlePause(): void {
    console.log('[VideoSync] Video paused');
    this.callbacks.onPause?.();
  }

  private handlePlay(): void {
    console.log('[VideoSync] Video playing');
    this.callbacks.onPlay?.();
  }

  private handleSeeking(): void {
    console.log('[VideoSync] Video seeking');
    this.callbacks.onSeeking?.();
  }

  private handleRateChange(): void {
    const rate = this.videoElement?.playbackRate ?? 1.0;
    console.log('[VideoSync] Playback rate changed:', rate);
    this.callbacks.onRateChange?.(rate);
  }

  /**
   * Public API
   */

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
   * Destroy and cleanup all resources
   */
  destroy(): void {
    this.stopPeriodicDetection();
    this.cleanup();
    console.log('[VideoSync] Destroyed');
  }
}
