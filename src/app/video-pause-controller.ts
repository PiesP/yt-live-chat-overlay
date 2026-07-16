// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * VideoPauseController
 *
 * Manages video pause/play event listeners for the overlay runtime.
 * Handles element rebinding (SPA navigation, ad transitions) and
 * periodic polling as a safety net for missed events.
 *
 * Also handles 'waiting' (buffering) and 'playing' (resume from buffer)
 * events to prevent message accumulation during network stalls.
 */

import type { Pauseable } from '@app-types';
import {
  clearSafeTimeout,
  findElementMatch,
  PLAYER_CONTAINER_SELECTORS,
  VIDEO_SELECTORS,
} from '@util/dom';
import { createLogger } from '@util/logging';

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
    // Clean up any previous observer/listeners from a prior start() call
    this.videoPauseCleanup?.();
    const handlePause = (): void => {
      if (callbacks.isDisposed()) return;
      log.debug('app.video.paused');
      callbacks.pauseable.setPaused(true);
    };

    const handlePlay = (): void => {
      if (callbacks.isDisposed()) return;
      log.debug('app.video.playing');
      callbacks.pauseable.setPaused(false);
    };

    // M5: Handle video buffering — pause comment flow during 'waiting' to
    // prevent message accumulation that causes a burst flood on resume.
    // The 'playing' event fires when buffering completes and playback resumes.
    const handleWaiting = (): void => {
      if (callbacks.isDisposed()) return;
      log.debug('app.video.buffering');
      callbacks.pauseable.setPaused(true);
    };

    // M6: When entering PiP mode, the video leaves the page viewport — pause
    // rendering to save CPU/GPU. On exit, resume normally.
    const handleEnterPiP = (): void => {
      if (callbacks.isDisposed()) return;
      log.debug('app.video.pip-enter');
      callbacks.pauseable.setPaused(true);
    };

    const handleLeavePiP = (): void => {
      if (callbacks.isDisposed()) return;
      // Only resume if the video is actually playing (not paused in PiP)
      if (currentVideo && !currentVideo.paused) {
        log.debug('app.video.pip-leave');
        callbacks.pauseable.setPaused(false);
      } else {
        log.debug('app.video.pip-leave-still-paused');
      }
    };

    const attachListeners = (video: HTMLVideoElement): void => {
      video.addEventListener('pause', handlePause);
      video.addEventListener('play', handlePlay);
      video.addEventListener('waiting', handleWaiting);
      video.addEventListener('playing', handlePlay);
      video.addEventListener('enterpictureinpicture', handleEnterPiP);
      video.addEventListener('leavepictureinpicture', handleLeavePiP);
    };

    const detachListeners = (video: HTMLVideoElement | undefined): void => {
      if (!video) return;
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('playing', handlePlay);
      video.removeEventListener('enterpictureinpicture', handleEnterPiP);
      video.removeEventListener('leavepictureinpicture', handleLeavePiP);
    };

    const scheduleRebind = (): void => {
      if (this.rebindTimer) return;
      this.rebindTimer = setTimeout(() => {
        this.rebindTimer = null;
        rebindVideo();
      }, REBIND_DEBOUNCE_MS);
    };

    const initial = findElementMatch<HTMLVideoElement>(VIDEO_SELECTORS)?.element;

    // Declare currentVideo BEFORE closures that reference it (handleLeavePiP
    // at line ~71, rebindVideo at line ~117) to avoid TDZ fragility.
    let currentVideo: HTMLVideoElement | undefined = initial;
    if (initial) {
      attachListeners(initial);
    } else {
      log.debug('app.video.no-element');
    }

    const rebindVideo = (): void => {
      const nextVideo = findElementMatch<HTMLVideoElement>(VIDEO_SELECTORS)?.element;
      if (nextVideo && nextVideo !== currentVideo) {
        detachListeners(currentVideo);
        currentVideo = nextVideo;
        attachListeners(currentVideo);
        log.debug('app.video.rebound-listeners');
      }
    };

    const playerContainer =
      findElementMatch<HTMLElement>(PLAYER_CONTAINER_SELECTORS)?.element ?? null;

    if (playerContainer) {
      // Guard: disconnect any observer from a prior start() call
      if (this.videoPauseCleanup) {
        this.videoPauseCleanup();
        this.videoPauseCleanup = null;
      }
      const observer = new MutationObserver(() => scheduleRebind());
      observer.observe(playerContainer, { childList: true, subtree: true });

      this.videoPauseCleanup = () => {
        this.rebindTimer = clearSafeTimeout(this.rebindTimer);
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
