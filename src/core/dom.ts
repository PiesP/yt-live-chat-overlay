import { overlayLog } from "@core/logging";

export interface SelectorMatch<T extends Element> {
  readonly element: T;
  readonly selector: string;
}

export interface ElementMatchOptions<T extends Element> {
  root?: ParentNode;
  predicate?: (element: T) => boolean;
}

export interface WaitForElementMatchOptions<
  T extends Element,
> extends ElementMatchOptions<T> {
  attempts?: number;
  intervalMs?: number;
}

export interface PollForValueOptions {
  attempts?: number;
  intervalMs?: number;
}

const DEFAULT_WAIT_ATTEMPTS = 5;
const DEFAULT_WAIT_INTERVAL_MS = 500;

export const PLAYER_CONTAINER_SELECTORS = [
  "#movie_player",
  ".html5-video-player",
  "ytd-player",
  "#player-container",
] as const;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const isVisibleElement = (element: HTMLElement): boolean =>
  element.offsetWidth > 0 && element.offsetHeight > 0;

const normalizeWaitOptions = <T extends Element>(
  options: WaitForElementMatchOptions<T>,
) => ({
  root: options.root ?? document,
  predicate: options.predicate,
  attempts: Math.max(1, Math.trunc(options.attempts ?? DEFAULT_WAIT_ATTEMPTS)),
  intervalMs: Math.max(0, options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS),
});

const normalizePollOptions = (options: PollForValueOptions = {}) => ({
  attempts: Math.max(1, Math.trunc(options.attempts ?? DEFAULT_WAIT_ATTEMPTS)),
  intervalMs: Math.max(0, options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS),
});

export const findElementMatch = <T extends Element>(
  selectors: readonly string[],
  options: ElementMatchOptions<T> = {},
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
  options: WaitForElementMatchOptions<T> = {},
): Promise<SelectorMatch<T> | null> => {
  const { attempts, intervalMs, root, predicate } =
    normalizeWaitOptions(options);
  const matchOptions = predicate ? { root, predicate } : { root };

  return pollForValue(() => findElementMatch<T>(selectors, matchOptions), {
    attempts,
    intervalMs,
  });
};

export const pollForValue = async <T>(
  readValue: () => T | null | undefined,
  options: PollForValueOptions = {},
): Promise<T | null> => {
  const { attempts, intervalMs } = normalizePollOptions(options);

  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = readValue();
    if (value !== null && value !== undefined) return value;

    if (attempt === attempts - 1) {
      break;
    }

    await sleep(intervalMs);
  }

  return null;
};

/**
 * Ensure a player element has CSS positioning so absolutely-positioned
 * children (overlay, settings button) are placed relative to it.
 */
export const ensurePlayerPositioning = (element: HTMLElement): void => {
  if (window.getComputedStyle(element).position === "static") {
    element.style.position = "relative";
  }
};

/**
 * Find the YouTube player container element.
 * Shared by Overlay and SettingsUi to avoid duplicated lookup logic.
 */
export const findPlayerContainerElement = async (
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<HTMLElement | null> => {
  const match = await waitForElementMatch<HTMLElement>(
    PLAYER_CONTAINER_SELECTORS,
    {
      attempts: options.attempts ?? DEFAULT_WAIT_ATTEMPTS,
      intervalMs: options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS,
      predicate: isVisibleElement,
    },
  );

  if (!match) {
    console.warn("[YT Chat Overlay] No player container found");
    return null;
  }

  overlayLog.info(
    "[YT Chat Overlay] Player found with selector:",
    match.selector,
  );
  return match.element;
};
