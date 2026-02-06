export interface SelectorMatch<T extends Element> {
  element: T;
  selector: string;
}

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

export const findElementMatch = <T extends Element>(
  selectors: readonly string[],
  options: { root?: ParentNode; predicate?: (element: T) => boolean } = {}
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
  options: {
    root?: ParentNode;
    predicate?: (element: T) => boolean;
    attempts?: number;
    intervalMs?: number;
  } = {}
): Promise<SelectorMatch<T> | null> => {
  const { attempts = 5, intervalMs = 500, root, predicate } = options;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const match = findElementMatch<T>(selectors, {
      ...(root ? { root } : {}),
      ...(predicate ? { predicate } : {}),
    });
    if (match) return match;
    await sleep(intervalMs);
  }

  return null;
};
