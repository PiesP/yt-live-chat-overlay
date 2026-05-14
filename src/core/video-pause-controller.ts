/**
 * VideoPauseController
 *
 * Manages video pause/play event listeners for the overlay runtime.
 * Handles element rebinding (SPA navigation, ad transitions) and
 * periodic polling as a safety net for missed events.
 */

import { findElementMatch, VIDEO_SELECTORS } from '@core/dom';
import { createLogger } from '@core/logging';

const log = createLogger('VideoPauseController');

export interface VideoPauseCallbacks {
  onVideoPause: () => void;
  onVideoPlay: () => void;
  isDisposed: () => boolean;
}

export class VideoPauseController {
  private videoPauseCleanup: (() => void) | null = null;

  start(callbacks: VideoPauseCallbacks): void {
    const handlePause = (): void => {
      if (callbacks.isDisposed()) return;
      log.debug('Video paused — pausing comment flow');
      callbacks.onVideoPause();
    };

    const handlePlay = (): void => {
      if (callbacks.isDisposed()) return;
      log.debug('Video playing — resuming comment flow');
      callbacks.onVideoPlay();
    };

    const attachListeners = (video: HTMLVideoElement): void => {
      video.addEventListener('pause', handlePause);
      video.addEventListener('play', handlePlay);
    };

    const detachListeners = (video: HTMLVideoElement | undefined): void => {
      if (!video) return;
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('play', handlePlay);
    };

    const initial = findElementMatch<HTMLVideoElement>(VIDEO_SELECTORS)?.element;
    if (!initial) {
      log.debug('No video element found — video pause handling disabled');
      return;
    }

    let currentVideo: HTMLVideoElement | undefined = initial;
    attachListeners(currentVideo);

    const rebindVideo = (): void => {
      const nextVideo = findElementMatch<HTMLVideoElement>(VIDEO_SELECTORS)?.element;
      if (nextVideo && nextVideo !== currentVideo) {
        detachListeners(currentVideo);
        currentVideo = nextVideo;
        attachListeners(currentVideo);
        log.debug('Re-bound video pause/play listeners to new <video> element');
      }
    };

    const playerContainer = document.querySelector<HTMLElement>(
      '#movie_player, .html5-video-player'
    );

    if (playerContainer) {
      const observer = new MutationObserver(() => rebindVideo());
      observer.observe(playerContainer, { childList: true, subtree: true });

      this.videoPauseCleanup = () => {
        detachListeners(currentVideo);
        observer.disconnect();
        this.videoPauseCleanup = null;
      };
    } else {
      this.videoPauseCleanup = () => {
        detachListeners(currentVideo);
        this.videoPauseCleanup = null;
      };
    }
  }

  stop(): void {
    this.videoPauseCleanup?.();
  }
}
