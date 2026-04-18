export const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

export const combineAbortSignals = (
  ...signals: Array<AbortSignal | null | undefined>
): AbortSignal | undefined => {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));

  if (activeSignals.length === 0) {
    return undefined;
  }

  if (activeSignals.length === 1) {
    return activeSignals[0];
  }

  return AbortSignal.any(activeSignals);
};
