/**
 * VideoSync
 *
 * Detects YouTube video element and monitors playback state changes.
 * Provides callbacks for pause/play/seek/rate events to synchronize overlay.
 *
 * Element replacement handling is delegated to RuntimeManager's session restart.
 */

import { throwIfAborted, VIDEO_SELECTORS, waitForElementMatch } from '@core/dom';
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
const MIN_READY_STATE = 2;

const isVideoReady = (video: HTMLVideoElement): boolean =>
  video.readyState >= MIN_READY_STATE && video.videoWidth > 0;

export class VideoSync {
  private videoElement: HTMLVideoElement | null = null;
  private readonly callbacks: VideoSyncCallbacks;
  private initPromise: Promise<boolean> | null = null;
  private readonly boundHandlers = {
    pause: () => this.callbacks.onPause?.(),
    play: () => this.callbacks.onPlay?.(),
    seeking: () => {
      this.callbacks.onSeeking?.();
    },
    ratechange: () => this.callbacks.onRateChange?.(this.videoElement?.playbackRate ?? 1.0),
  };

  constructor(callbacks: VideoSyncCallbacks) {
    this.callbacks = callbacks;
  }

  async init(signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.runInit(signal).finally(() => {
      this.initPromise = null;
    });

    return this.initPromise;
  }

  private async runInit(signal?: AbortSignal): Promise<boolean> {
    const match = await waitForElementMatch<HTMLVideoElement>(VIDEO_SELECTORS, {
      attempts: DETECTION_ATTEMPTS,
      intervalMs: DETECTION_INTERVAL_MS,
      predicate: isVideoReady,
      signal,
    });

    throwIfAborted(signal);

    if (!match) {
      log.warn('Video element not found after retries');
      return false;
    }

    const video = match.element;
    this.videoElement = video;
    video.addEventListener('pause', this.boundHandlers.pause);
    video.addEventListener('play', this.boundHandlers.play);
    video.addEventListener('seeking', this.boundHandlers.seeking);
    video.addEventListener('ratechange', this.boundHandlers.ratechange);

    this.callbacks.onRateChange?.(video.playbackRate || 1.0);
    if (video.paused) {
      this.callbacks.onPause?.();
    } else {
      this.callbacks.onPlay?.();
    }

    log.debug('Initialized');
    return true;
  }

  isPaused(): boolean {
    return this.videoElement?.paused ?? true;
  }

  hasVideoElement(): boolean {
    return this.videoElement !== null;
  }

  destroy(): void {
    const video = this.videoElement;
    if (video) {
      video.removeEventListener('pause', this.boundHandlers.pause);
      video.removeEventListener('play', this.boundHandlers.play);
      video.removeEventListener('seeking', this.boundHandlers.seeking);
      video.removeEventListener('ratechange', this.boundHandlers.ratechange);
    }

    this.videoElement = null;
    this.initPromise = null;
    log.debug('Destroyed');
  }
}
