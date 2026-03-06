export interface SelectorMatch<T extends Element> {
  readonly element: T;
  readonly selector: string;
}

export interface ElementMatchOptions<T extends Element> {
  root?: ParentNode;
  predicate?: (element: T) => boolean;
}

export interface WaitForElementMatchOptions<T extends Element> extends ElementMatchOptions<T> {
  attempts?: number;
  intervalMs?: number;
}

const DEFAULT_WAIT_ATTEMPTS = 5;
const DEFAULT_WAIT_INTERVAL_MS = 500;

export const PLAYER_CONTAINER_SELECTORS = [
  '#movie_player',
  '.html5-video-player',
  'ytd-player',
  '#player-container',
] as const;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const isVisibleElement = (element: HTMLElement): boolean =>
  element.offsetWidth > 0 && element.offsetHeight > 0;

const normalizeWaitOptions = <T extends Element>(options: WaitForElementMatchOptions<T>) => ({
  root: options.root ?? document,
  predicate: options.predicate,
  attempts: Math.max(1, Math.trunc(options.attempts ?? DEFAULT_WAIT_ATTEMPTS)),
  intervalMs: Math.max(0, options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS),
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

export const waitForElementMatch = async <T extends Element>(
  selectors: readonly string[],
  options: WaitForElementMatchOptions<T> = {}
): Promise<SelectorMatch<T> | null> => {
  const { attempts, intervalMs, root, predicate } = normalizeWaitOptions(options);

  for (let attempt = 0; attempt < attempts; attempt++) {
    const match = findElementMatch<T>(selectors, { root, predicate });
    if (match) return match;

    if (attempt === attempts - 1) {
      break;
    }

    await sleep(intervalMs);
  }

  return null;
};
