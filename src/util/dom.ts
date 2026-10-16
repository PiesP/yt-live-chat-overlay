// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { throwIfAborted } from '@piesp/browser-core/error';
import { createLogger } from '@util/logging';

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
const MAX_WAIT_ATTEMPTS = 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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

export async function findPlayerContainerElement(
  options: { attempts?: number; intervalMs?: number; signal?: AbortSignal | undefined } = {}
): Promise<HTMLElement | null> {
  // Invalid or extreme inputs cannot define a practical bounded timer schedule.
  const requestedAttempts = options.attempts ?? DEFAULT_WAIT_ATTEMPTS;
  const attempts =
    Number.isFinite(requestedAttempts) && requestedAttempts <= MAX_WAIT_ATTEMPTS
      ? Math.max(1, Math.trunc(requestedAttempts))
      : DEFAULT_WAIT_ATTEMPTS;
  const requestedInterval = options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
  const intervalMs =
    Number.isFinite(requestedInterval) &&
    Math.max(0, requestedInterval) * (2 * attempts - 1) <= MAX_TIMER_DELAY_MS
      ? Math.max(0, requestedInterval)
      : DEFAULT_WAIT_INTERVAL_MS;
  const { signal } = options;

  // Fast path: try immediate lookup before setting up observer or polling.
  const immediate = findElementMatch<HTMLElement>(PLAYER_CONTAINER_SELECTORS, {
    predicate: isVisibleElement,
  });
  if (immediate) {
    log.debug('dom.player.found-immediate', { selector: immediate.selector });
    return immediate.element;
  }

  throwIfAborted(signal);

  const canObserve = typeof MutationObserver !== 'undefined';
  // The old observer window and its subsequent polling allowed the last lookup
  // at (2 * attempts - 1) intervals. Without an observer it was attempts - 1.
  const lastProbe = canObserve ? 2 * attempts - 1 : attempts - 1;

  return new Promise<HTMLElement | null>((resolve, reject) => {
    let observer: MutationObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let listening = false;
    let nextProbe = 1;
    const startedAt = performance.now();

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      observer?.disconnect();
      if (listening) signal?.removeEventListener('abort', onAbort);
      listening = false;
    };
    const settle = (outcome: { element: HTMLElement | null } | { error: unknown }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if ('error' in outcome) reject(outcome.error);
      else resolve(outcome.element);
    };
    const onAbort = (): void => {
      // The former observer phase created AbortError; the polling path's sleep
      // preserved DOMException reasons. Keep that distinction at the boundary.
      const reason = observer
        ? new DOMException('Aborted', 'AbortError')
        : signal?.reason instanceof DOMException
          ? signal.reason
          : new DOMException('The operation was aborted.', 'AbortError');
      settle({ error: reason });
    };
    const probe = (): void => {
      if (settled) return;
      try {
        const match = findElementMatch<HTMLElement>(PLAYER_CONTAINER_SELECTORS, {
          predicate: isVisibleElement,
        });
        if (match) {
          log.debug('dom.player.found-waiting', { selector: match.selector });
          settle({ element: match.element });
        }
      } catch (error: unknown) {
        settle({ error });
      }
    };
    const schedule = (): void => {
      if (settled) return;
      if (nextProbe > lastProbe) {
        log.debug('dom.player.not-found');
        settle({ element: null });
        return;
      }
      const target = startedAt + nextProbe * intervalMs;
      timer = setTimeout(
        () => {
          timer = undefined;
          probe();
          if (settled) return;
          if (observer && nextProbe >= attempts) {
            observer.disconnect();
            observer = undefined;
          }
          // Skip missed ticks after throttling, but never skip the final lookup.
          const elapsed = performance.now() - startedAt;
          if (nextProbe < lastProbe && intervalMs > 0) {
            nextProbe = Math.min(
              lastProbe,
              Math.max(nextProbe + 1, Math.floor(elapsed / intervalMs) + 1)
            );
          } else {
            nextProbe++;
          }
          schedule();
        },
        Math.max(0, target - performance.now())
      );
    };

    try {
      if (canObserve) {
        observer = new MutationObserver(probe);
        observer.observe(document.body, { childList: true, subtree: true });
      }
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        listening = true;
      }
      if (signal?.aborted) onAbort();
      if (lastProbe === 0 || intervalMs === 0) {
        probe();
        if (!settled) settle({ element: null });
      } else {
        schedule();
      }
    } catch (error: unknown) {
      settle({ error });
    }
  });
}

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
