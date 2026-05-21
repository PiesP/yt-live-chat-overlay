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

export const extractNextLiveContinuation = (
  continuations: unknown
): InnertubeContinuationData | null =>
  pickContinuation(continuations, [
    'invalidationContinuationData',
    'timedContinuationData',
    'reloadContinuationData',
  ]);

export const extractReplayContinuation = (
  continuations: unknown
): InnertubeContinuationData | null =>
  pickContinuation(continuations, ['liveChatReplayContinuationData']);

export const extractPlayerSeekContinuation = (
  continuations: unknown
): InnertubeContinuationData | null =>
  pickContinuation(continuations, ['playerSeekContinuationData']);
