// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { sleep } from '@piesp/browser-core/async';
import { throwIfAborted as throwIfAbortedFn } from '@piesp/browser-core/error';
import { createLogger } from '@util/logging';

export { sleep } from '@piesp/browser-core/async';
export { isAbortError } from '@piesp/browser-core/error';

/** @deprecated Import from @piesp/browser-core/error instead. */
export { throwIfAborted as throwIfAborted } from '@piesp/browser-core/error';

// Re-export for internal module use
const throwIfAborted = throwIfAbortedFn;

const log = createLogger('Dom');

interface SelectorMatch<T extends Element> {
  readonly element: T;
  readonly selector: string;
}

interface ElementMatchOptions<T extends Element> {
  root?: ParentNode;
  predicate?: (element: T) => boolean;
}

/** Visually-hidden but screen-reader accessible — WCAG compliant. */
export const SCREEN_READER_CSS =
  'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';

const DEFAULT_WAIT_ATTEMPTS = 5;
const DEFAULT_WAIT_INTERVAL_MS = 500;

/** Interval (ms) between player element lookup retries in the overlay. */
export const PLAYER_LOOKUP_INTERVAL_MS = 1000;

export const PLAYER_CONTAINER_SELECTORS = ['#movie_player', '.html5-video-player'] as const;

export const VIDEO_SELECTORS = ['#movie_player video', 'video.html5-main-video'] as const;

export const isVisibleElement = (element: HTMLElement): boolean =>
  element.offsetWidth > 0 && element.offsetHeight > 0;

export function findElementMatch<T extends Element>(
  selectors: readonly string[],
  options: ElementMatchOptions<T> = {}
): SelectorMatch<T> | null {
  const { root = document, predicate } = options;

  for (const selector of selectors) {
    const element = root.querySelector<T>(selector);
    if (!element) continue;
    if (predicate && !predicate(element)) continue;
    return { element, selector };
  }

  return null;
}

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
      log.debug('dom.player.found-polling', { selector: element.selector });
      return element.element;
    }

    if (attempt === attempts - 1) break;

    await sleep(intervalMs, signal);
  }

  log.debug('dom.player.not-found');
  return null;
}

export async function findPlayerContainerElement(
  options: { attempts?: number; intervalMs?: number; signal?: AbortSignal | undefined } = {}
): Promise<HTMLElement | null> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? DEFAULT_WAIT_ATTEMPTS));
  const intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS);
  const { signal } = options;

  // Fast path: try immediate lookup before setting up observer or polling.
  const immediate = findElementMatch<HTMLElement>(PLAYER_CONTAINER_SELECTORS, {
    predicate: isVisibleElement,
  });
  if (immediate) {
    log.debug('dom.player.found-immediate', { selector: immediate.selector });
    return immediate.element;
  }

  // Guard against already-aborted signals before setting up the
  // MutationObserver + fallback timer (which can take up to
  // intervalMs * attempts before detecting the abort).
  throwIfAborted(signal);

  // Use MutationObserver for instant detection when the player element
  // appears in the DOM (SPA navigation, slow rendering). Falls back to
  // polling if MutationObserver is not available or times out.
  if (typeof MutationObserver !== 'undefined') {
    let onAbort: (() => void) | undefined;
    const promise = new Promise<HTMLElement | null>(
      (resolve: (value: HTMLElement | null) => void, reject: (reason: DOMException) => void) => {
        let fallbackTimer: ReturnType<typeof setTimeout>;

        const observer = new MutationObserver(() => {
          const element = findElementMatch<HTMLElement>(PLAYER_CONTAINER_SELECTORS, {
            predicate: isVisibleElement,
          });
          if (element) {
            observer.disconnect();
            clearTimeout(fallbackTimer);
            log.debug('dom.player.found-observer', { selector: element.selector });
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

        onAbort = () => {
          observer.disconnect();
          clearTimeout(fallbackTimer);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      }
    );
    return promise.then((found) => {
      if (onAbort) signal?.removeEventListener('abort', onAbort as EventListener);
      if (found) return found;
      // Fall back to polling if observer didn't find anything.
      return pollForPlayerContainer(attempts, intervalMs, signal);
    });
  }

  return pollForPlayerContainer(attempts, intervalMs, signal);
}

const clearSafe = <T>(value: T | null, clearFn: (v: T) => void): null => {
  if (value !== null) clearFn(value);
  return null;
};

/** Clear a timeout timer and null the reference. Idempotent if already null. */
export const clearSafeTimeout = (timer: ReturnType<typeof setTimeout> | null): null =>
  clearSafe(timer, clearTimeout);

/** Clear an interval timer and null the reference. Idempotent if already null. */
export const clearSafeInterval = (timer: ReturnType<typeof setInterval> | null): null =>
  clearSafe(timer, clearInterval);

/** Cancel an animation frame handle and null the reference. */
export const clearSafeAnimationFrame = (handle: number | null): null =>
  clearSafe(handle, cancelAnimationFrame);

/** Iterate over slot indices for a multi-slot placement. */
export function forEachSlot(
  laneIndex: number,
  slotCount: number,
  fn: (slotIndex: number, slotOffset: number) => void
): void {
  for (let offset = 0; offset < slotCount; offset++) {
    fn(laneIndex + offset, offset);
  }
}

/**
 * Ensure a player element has CSS positioning so absolutely-positioned
 * children (overlay, settings button) are placed relative to it.
 */
export function ensurePlayerPositioning(element: HTMLElement): void {
  if (window.getComputedStyle(element).position === 'static') {
    element.style.position = 'relative';
  }
}
