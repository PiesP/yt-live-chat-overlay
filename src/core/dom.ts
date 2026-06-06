// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createLogger } from '@core/logging';

const log = createLogger('Dom');

interface SelectorMatch<T extends Element> {
  readonly element: T;
  readonly selector: string;
}

interface ElementMatchOptions<T extends Element> {
  root?: ParentNode;
  predicate?: (element: T) => boolean;
}

const DEFAULT_WAIT_ATTEMPTS = 5;
const DEFAULT_WAIT_INTERVAL_MS = 500;

/** Interval (ms) between player element lookup retries in the overlay. */
export const PLAYER_LOOKUP_INTERVAL_MS = 1000;

export const PLAYER_CONTAINER_SELECTORS = ['#movie_player', '.html5-video-player'] as const;

export const VIDEO_SELECTORS = ['#movie_player video', 'video.html5-main-video'] as const;

const createAbortError = (reason?: unknown): DOMException => {
  if (reason instanceof DOMException) return reason;
  const message = reason instanceof Error ? reason.message : 'The operation was aborted.';
  return new DOMException(message, 'AbortError');
};

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
};

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError(signal.reason));
      return;
    }

    const timeoutId: ReturnType<typeof setTimeout> = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, ms);

    const handleAbort = (): void => {
      clearTimeout(timeoutId);
      reject(createAbortError(signal?.reason));
    };

    signal?.addEventListener('abort', handleAbort, { once: true });
  });

export const isVisibleElement = (element: HTMLElement): boolean =>
  element.offsetWidth > 0 && element.offsetHeight > 0;

export const findElementMatch = <T extends Element>(
  selectors: readonly string[],
  options: ElementMatchOptions<T> = {}
): SelectorMatch<T> | null => {
  const { root = document, predicate } = options;

  for (const selector of selectors) {
    const element = root.querySelector<T>(selector);
    if (!element) continue;
    if (predicate && !predicate(element)) continue;
    return { element, selector };
  }

  return null;
};

async function pollForPlayerContainer(
  attempts: number,
  intervalMs: number,
  signal?: AbortSignal
): Promise<HTMLElement | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    throwIfAborted(signal);

    const element = findElementMatch<HTMLElement>(PLAYER_CONTAINER_SELECTORS, {
      predicate: isVisibleElement,
    });

    if (element) {
      log.debug('Player found via polling with selector:', element.selector);
      return element.element;
    }

    if (attempt === attempts - 1) break;

    await sleep(intervalMs, signal);
  }

  log.warn('No player container found');
  return null;
}

export const findPlayerContainerElement = async (
  options: { attempts?: number; intervalMs?: number; signal?: AbortSignal | undefined } = {}
): Promise<HTMLElement | null> => {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? DEFAULT_WAIT_ATTEMPTS));
  const intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS);
  const { signal } = options;

  // Fast path: try immediate lookup before setting up observer or polling.
  const immediate = findElementMatch<HTMLElement>(PLAYER_CONTAINER_SELECTORS, {
    predicate: isVisibleElement,
  });
  if (immediate) {
    log.debug('Player found immediately with selector:', immediate.selector);
    return immediate.element;
  }

  // Use MutationObserver for instant detection when the player element
  // appears in the DOM (SPA navigation, slow rendering). Falls back to
  // polling if MutationObserver is not available or times out.
  if (typeof MutationObserver !== 'undefined') {
    return new Promise<HTMLElement | null>(
      (resolve: (value: HTMLElement | null) => void, reject: (reason: DOMException) => void) => {
        let fallbackTimer: ReturnType<typeof setTimeout>;

        const observer = new MutationObserver(() => {
          const element = findElementMatch<HTMLElement>(PLAYER_CONTAINER_SELECTORS, {
            predicate: isVisibleElement,
          });
          if (element) {
            observer.disconnect();
            clearTimeout(fallbackTimer);
            log.debug('Player found via MutationObserver with selector:', element.selector);
            resolve(element.element);
          }
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true,
        });

        // Fallback polling timer: if the observer doesn't find the element
        // within the polling window, clean up and switch to polling.
        fallbackTimer = setTimeout(() => {
          observer.disconnect();
          resolve(null); // will trigger polling fallback below
        }, intervalMs * attempts);

        signal?.addEventListener(
          'abort',
          () => {
            observer.disconnect();
            clearTimeout(fallbackTimer);
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true }
        );
      }
    ).then((found) => {
      if (found) return found;
      // Fall back to polling if observer didn't find anything.
      return pollForPlayerContainer(attempts, intervalMs, signal);
    });
  }

  return pollForPlayerContainer(attempts, intervalMs, signal);
};

/** Check whether an error is an AbortError (used to ignore abort-related rejections). */
export const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

/** Clear a timeout timer and null the reference. Idempotent if already null. */
export const clearSafeTimeout = (timer: ReturnType<typeof setTimeout> | null): null => {
  if (timer !== null) clearTimeout(timer);
  return null;
};

/** Clear an interval timer and null the reference. Idempotent if already null. */
export const clearSafeInterval = (timer: ReturnType<typeof setInterval> | null): null => {
  if (timer !== null) clearInterval(timer);
  return null;
};

/** Cancel an animation frame handle and null the reference. */
export const clearSafeAnimationFrame = (handle: number | null): null => {
  if (handle !== null) cancelAnimationFrame(handle);
  return null;
};

/** Iterate over slot indices for a multi-slot placement. */
export const forEachSlot = (
  laneIndex: number,
  slotCount: number,
  fn: (slotIndex: number, slotOffset: number) => void
): void => {
  for (let offset = 0; offset < slotCount; offset++) {
    fn(laneIndex + offset, offset);
  }
};

/**
 * Ensure a player element has CSS positioning so absolutely-positioned
 * children (overlay, settings button) are placed relative to it.
 */
export const ensurePlayerPositioning = (element: HTMLElement): void => {
  if (window.getComputedStyle(element).position === 'static') {
    element.style.position = 'relative';
  }
};
