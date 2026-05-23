/**
 * VideoPauseController
 *
 * Manages video pause/play event listeners for the overlay runtime.
 * Handles element rebinding (SPA navigation, ad transitions) and
 * periodic polling as a safety net for missed events.
 */

import type { Pauseable } from '@app-types';
import { findElementMatch, PLAYER_CONTAINER_SELECTORS, VIDEO_SELECTORS } from '@core/dom';
import { createLogger } from '@core/logging';

const log = createLogger('VideoPauseController');

const REBIND_DEBOUNCE_MS = 100;

interface VideoPauseCallbacks {
  pauseable: Pauseable;
  isDisposed: () => boolean;
}

export class VideoPauseController {
  private videoPauseCleanup: (() => void) | null = null;
  private rebindTimer: ReturnType<typeof setTimeout> | null = null;

  start(callbacks: VideoPauseCallbacks): void {
    const handlePause = (): void => {
      if (callbacks.isDisposed()) return;
      log.debug('Video paused — pausing comment flow');
      callbacks.pauseable.setPaused(true);
    };

    const handlePlay = (): void => {
      if (callbacks.isDisposed()) return;
      log.debug('Video playing — resuming comment flow');
      callbacks.pauseable.setPaused(false);
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

    const scheduleRebind = (): void => {
      if (this.rebindTimer) return;
      this.rebindTimer = setTimeout(() => {
        this.rebindTimer = null;
        rebindVideo();
      }, REBIND_DEBOUNCE_MS);
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

    const playerContainer =
      findElementMatch<HTMLElement>(PLAYER_CONTAINER_SELECTORS)?.element ?? null;

    if (playerContainer) {
      const observer = new MutationObserver(() => scheduleRebind());
      observer.observe(playerContainer, { childList: true, subtree: true });

      this.videoPauseCleanup = () => {
        if (this.rebindTimer !== null) {
          clearTimeout(this.rebindTimer);
          this.rebindTimer = null;
        }
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
