import { createLogger } from '@core/logging';

const log = createLogger('Dom');

export interface SelectorMatch<T extends Element> {
  readonly element: T;
  readonly selector: string;
}

export interface ElementMatchOptions<T extends Element> {
  root?: ParentNode;
  predicate?: (element: T) => boolean;
}

export interface PollForValueOptions {
  attempts?: number;
  intervalMs?: number;
  signal?: AbortSignal | undefined;
}

const DEFAULT_WAIT_ATTEMPTS = 5;
const DEFAULT_WAIT_INTERVAL_MS = 500;

/** Interval (ms) between player element lookup retries in the overlay. */
export const PLAYER_LOOKUP_INTERVAL_MS = 1000;

export const PLAYER_CONTAINER_SELECTORS = ['#movie_player', '.html5-video-player'] as const;

export const VIDEO_SELECTORS = ['#movie_player video', 'video.html5-main-video'] as const;

const createAbortError = (reason?: unknown): DOMException => {
  if (reason instanceof DOMException) {
    return reason;
  }

  if (reason instanceof Error) {
    return new DOMException(reason.message, 'AbortError');
  }

  return new DOMException('The operation was aborted.', 'AbortError');
};

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
};

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError(signal?.reason));
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

const normalizeCommonOptions = (options: PollForValueOptions) => ({
  attempts: Math.max(1, Math.trunc(options.attempts ?? DEFAULT_WAIT_ATTEMPTS)),
  intervalMs: Math.max(0, options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS),
  signal: options.signal,
});

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

export const pollForValue = async <T>(
  readValue: () => T | null | undefined,
  options: PollForValueOptions = {}
): Promise<T | null> => {
  const { attempts, intervalMs, signal } = normalizeCommonOptions(options);

  for (let attempt = 0; attempt < attempts; attempt++) {
    throwIfAborted(signal);

    const value = readValue();
    if (value !== null && value !== undefined) return value;

    if (attempt === attempts - 1) break;

    await sleep(intervalMs, signal);
  }

  return null;
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

/**
 * Find the YouTube player container element.
 * Shared by Overlay and SettingsUi to avoid duplicated lookup logic.
 */
export const findPlayerContainerElement = async (
  options: { attempts?: number; intervalMs?: number; signal?: AbortSignal | undefined } = {}
): Promise<HTMLElement | null> => {
  const match = await pollForValue<SelectorMatch<HTMLElement>>(
    () =>
      findElementMatch<HTMLElement>(PLAYER_CONTAINER_SELECTORS, {
        predicate: isVisibleElement,
      }),
    {
      attempts: options.attempts ?? DEFAULT_WAIT_ATTEMPTS,
      intervalMs: options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS,
      signal: options.signal,
    }
  );

  if (!match) {
    log.warn('No player container found');
    return null;
  }

  log.debug('Player found with selector:', match.selector);
  return match.element;
};

export const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

export const combineAbortSignals = (
  ...signals: Array<AbortSignal | null | undefined>
): AbortSignal | undefined => {
  const active = signals.filter((s): s is AbortSignal => Boolean(s));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
};
