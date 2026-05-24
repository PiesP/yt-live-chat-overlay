import { getNumber, getString, isRecord } from '@core/youtubei-json';

export interface InnertubeContinuationData {
  readonly continuation: string;
  readonly clickTrackingParams?: string;
  readonly timeoutMs?: number;
}

const toContinuationData = (value: unknown): InnertubeContinuationData | null => {
  if (!isRecord(value)) {
    return null;
  }

  const continuation = getString(value.continuation);
  if (!continuation) {
    return null;
  }

  const result: {
    continuation: string;
    clickTrackingParams?: string;
    timeoutMs?: number;
  } = { continuation };

  const clickTrackingParams = getString(value.clickTrackingParams);
  if (clickTrackingParams) {
    result.clickTrackingParams = clickTrackingParams;
  }

  const timeoutMs = getNumber(value.timeoutMs);
  if (timeoutMs !== undefined) {
    result.timeoutMs = timeoutMs;
  }

  return result;
};

const pickContinuation = (
  continuations: unknown,
  keys: readonly string[]
): InnertubeContinuationData | null => {
  if (!Array.isArray(continuations)) {
    return null;
  }

  for (const item of continuations) {
    if (!isRecord(item)) {
      continue;
    }

    for (const key of keys) {
      const continuation = toContinuationData(item[key]);
      if (continuation) {
        return continuation;
      }
    }
  }

  return null;
};

/**
 * Extracts the initial chat continuation token from a YouTube live chat bootstrap response.
 * @param renderer - The liveChatRenderer object from the bootstrap payload.
 */
export const extractInitialChatContinuation = (
  renderer: Record<string, unknown>
): InnertubeContinuationData | null =>
  pickContinuation(renderer.continuations, [
    'reloadContinuationData',
    'invalidationContinuationData',
    'timedContinuationData',
    'liveChatReplayContinuationData',
    'playerSeekContinuationData',
  ]);

/**
 * Extracts the next live chat continuation token from a polling response.
 * @param continuations - The continuations array from the Innertube response.
 */
export const extractNextLiveContinuation = (
  continuations: unknown
): InnertubeContinuationData | null =>
  pickContinuation(continuations, [
    'invalidationContinuationData',
    'timedContinuationData',
    'reloadContinuationData',
  ]);

/**
 * Extracts the replay chat continuation token for sequential page fetching.
 * @param continuations - The continuations array from the Innertube response.
 */
export const extractReplayContinuation = (
  continuations: unknown
): InnertubeContinuationData | null =>
  pickContinuation(continuations, ['liveChatReplayContinuationData']);

/**
 * Extracts the player seek continuation token for seeking in replay chat.
 * @param continuations - The continuations array from the Innertube response.
 */
export const extractPlayerSeekContinuation = (
  continuations: unknown
): InnertubeContinuationData | null =>
  pickContinuation(continuations, ['playerSeekContinuationData']);
