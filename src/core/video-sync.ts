/**
 * VideoSync
 *
 * Detects and monitors YouTube video element for playback state changes.
 * Provides callbacks for pause/play events to synchronize overlay animations.
 */

import {
  findElementMatch,
  PLAYER_CONTAINER_SELECTORS,
  throwIfAborted,
  VIDEO_SELECTORS,
  waitForElementMatch,
} from '@core/dom';
import { createLogger } from '@core/logging';

const log = createLogger('VideoSync');

interface VideoSyncCallbacks {
  onPause?: () => void;
  onPlay?: () => void;
  onSeeking?: () => void;
  onRateChange?: (rate: number) => void;
}

const DETECTION_ATTEMPTS = 5;
const DETECTION_INTERVAL_MS = 500;
const PERIODIC_DETECTION_INTERVAL_MS = 2000;
const REINITIALIZATION_DELAY_MS = 1000;
const MIN_READY_STATE = 2;

const isVideoReady = (video: HTMLVideoElement): boolean =>
  video.readyState >= MIN_READY_STATE && video.videoWidth > 0;

const findReadyVideoElement = (): HTMLVideoElement | null =>
  findElementMatch<HTMLVideoElement>(VIDEO_SELECTORS, { predicate: isVideoReady })?.element ?? null;

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
  private initPromise: Promise<boolean> | null = null;
  private detectInterval: number | null = null;
  private mutationObserver: MutationObserver | null = null;
  private reinitializeTimer: number | null = null;
  private lifecycleSignal: AbortSignal | null = null;
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
  async init(signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);

    if (this.initPromise) {
      return this.initPromise;
    }

    const initPromise = this.runInit(signal).finally(() => {
      if (this.initPromise === initPromise) {
        this.initPromise = null;
      }
    });

    this.initPromise = initPromise;
    return initPromise;
  }

  private async runInit(signal?: AbortSignal): Promise<boolean> {
    this.lifecycleSignal = signal ?? null;

    const videoElement = await this.detectVideoElement(signal);
    throwIfAborted(signal);

    if (!videoElement) {
      log.warn('Video element not found, starting periodic detection');
      this.startPeriodicDetection();
      return false;
    }

    this.setupVideoElement(videoElement);
    log.debug('Initialized with video element');
    return true;
  }

  /**
   * Detect video element in player container
   * Retries multiple times to handle slow page loads
   */
  private async detectVideoElement(signal?: AbortSignal): Promise<HTMLVideoElement | null> {
    const match = await waitForElementMatch<HTMLVideoElement>(VIDEO_SELECTORS, {
      attempts: DETECTION_ATTEMPTS,
      intervalMs: DETECTION_INTERVAL_MS,
      predicate: isVideoReady,
      signal,
    });

    if (match) {
      log.debug('Found video element:', match.selector);
      return match.element;
    }

    return null;
  }

  private findPlayerContainer(): HTMLElement | null {
    return findElementMatch<HTMLElement>(PLAYER_CONTAINER_SELECTORS)?.element ?? null;
  }

  private syncInitialPlaybackState(video: HTMLVideoElement): void {
    this.callbacks.onRateChange?.(video.playbackRate || 1.0);

    if (video.paused) {
      this.callbacks.onPause?.();
      return;
    }

    this.callbacks.onPlay?.();
  }

  private clearReinitializationTimer(): void {
    if (this.reinitializeTimer !== null) {
      window.clearTimeout(this.reinitializeTimer);
      this.reinitializeTimer = null;
    }
  }

  private resetVideoState(): void {
    const videoElement = this.videoElement;
    if (videoElement !== null) {
      this.detachListeners(videoElement);
    }
    this.stopObservingReplacement();
    this.videoElement = null;
    this.initialized = false;
  }

  /**
   * Setup video element with listeners and observers
   */
  private setupVideoElement(video: HTMLVideoElement): void {
    this.resetVideoState();
    this.videoElement = video;
    this.attachListeners(video);
    this.observeVideoReplacement(video);
    this.initialized = true;
    this.syncInitialPlaybackState(video);
  }

  /**
   * Start periodic detection for video element
   * Used when video is not immediately available (ads, live stream loading, etc.)
   */
  private startPeriodicDetection(): void {
    if (this.detectInterval !== null) return;

    const intervalId = window.setInterval(() => {
      if (this.initialized) {
        this.stopPeriodicDetection();
        return;
      }

      const video = findReadyVideoElement();

      if (video) {
        this.setupVideoElement(video);
        this.stopPeriodicDetection();
        log.debug('Video element detected via periodic check');
      }
    }, PERIODIC_DETECTION_INTERVAL_MS);

    this.detectInterval = intervalId;
    log.debug('Periodic detection started (every 2 seconds)');
  }

  /**
   * Stop periodic detection interval
   */
  private stopPeriodicDetection(): void {
    if (this.detectInterval !== null) {
      window.clearInterval(this.detectInterval);
      this.detectInterval = null;
      log.debug('Periodic detection stopped');
    }
  }

  /**
   * Attach event listeners to video element
   */
  private attachListeners(video: HTMLVideoElement): void {
    video.addEventListener('pause', this.boundHandlers.pause);
    video.addEventListener('play', this.boundHandlers.play);
    video.addEventListener('seeking', this.boundHandlers.seeking);
    video.addEventListener('ratechange', this.boundHandlers.ratechange);

    log.debug('Event listeners attached');
  }

  /**
   * Detach event listeners from video element
   */
  private detachListeners(video: HTMLVideoElement): void {
    video.removeEventListener('pause', this.boundHandlers.pause);
    video.removeEventListener('play', this.boundHandlers.play);
    video.removeEventListener('seeking', this.boundHandlers.seeking);
    video.removeEventListener('ratechange', this.boundHandlers.ratechange);

    log.debug('Event listeners detached');
  }

  /**
   * Observe video element replacement
   * Detects when video element is removed from DOM (e.g., during ad transitions)
   */
  private observeVideoReplacement(video: HTMLVideoElement): void {
    const playerContainer = this.findPlayerContainer();
    if (!playerContainer) {
      log.warn('Player container not found, cannot observe video replacement');
      return;
    }

    this.mutationObserver = new MutationObserver(() => {
      if (!document.contains(video)) {
        log.debug('Video element removed from DOM, reinitializing...');
        this.handleVideoReplacement();
      }
    });

    this.mutationObserver.observe(playerContainer, {
      childList: true,
      subtree: true,
    });

    log.debug('Video replacement observer attached');
  }

  /**
   * Stop observing video replacement
   */
  private stopObservingReplacement(): void {
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
      log.debug('Video replacement observer stopped');
    }
  }

  /**
   * Handle video element replacement
   * Called when video element is removed from DOM
   */
  private handleVideoReplacement(): void {
    this.resetVideoState();
    this.clearReinitializationTimer();

    this.reinitializeTimer = window.setTimeout(() => {
      this.reinitializeTimer = null;
      log.debug('Attempting to reacquire video element...');
      this.init(this.lifecycleSignal ?? undefined).catch((error) => {
        log.warn('Failed to reinitialize after video replacement:', error);
      });
    }, REINITIALIZATION_DELAY_MS);
  }

  /**
   * Event handlers
   */
  private handlePause(): void {
    this.callbacks.onPause?.();
  }

  private handlePlay(): void {
    this.callbacks.onPlay?.();
  }

  private handleSeeking(): void {
    this.callbacks.onSeeking?.();
  }

  private handleRateChange(): void {
    this.callbacks.onRateChange?.(this.videoElement?.playbackRate ?? 1.0);
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

  hasVideoElement(): boolean {
    return this.videoElement !== null;
  }

  /**
   * Destroy and cleanup all resources
   */
  destroy(): void {
    this.stopPeriodicDetection();
    this.clearReinitializationTimer();
    this.resetVideoState();
    log.debug('Destroyed');
  }
}
