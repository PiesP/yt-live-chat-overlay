export const clearTimeoutHandle = (handle: number | null): null => {
  if (handle !== null) {
    window.clearTimeout(handle);
  }

  return null;
};

export const clearIntervalHandle = (handle: number | null): null => {
  if (handle !== null) {
    window.clearInterval(handle);
  }

  return null;
};
