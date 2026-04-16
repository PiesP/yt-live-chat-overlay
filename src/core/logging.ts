import type { LogLevel } from '@app-types';
import { readStoredLogLevel } from '@core/settings';

type ConsoleLogArgs = Parameters<Console['log']>;
type ConsoleWarnArgs = Parameters<Console['warn']>;
type ConsoleErrorArgs = Parameters<Console['error']>;

const DEFAULT_LOG_LEVEL: LogLevel = 'warn';

const LOG_PREFIXES = [
  '[YT Chat Overlay]',
  '[App]',
  '[Overlay]',
  '[PageWatcher]',
  '[SettingsUi]',
  '[Renderer]',
  '[VideoSync]',
] as const;

const VERBOSE_LOG_MARKERS = [
  'attempt',
  'waiting',
  'selector',
  'current url',
  'iframe',
  'chat frame',
  'debug:',
  'watching for new messages',
  'rendering message',
  'no available lane',
  'paused',
  'resumed',
] as const;

let currentLogLevel: LogLevel = DEFAULT_LOG_LEVEL;

const getFirstMessage = (args: readonly unknown[]): string | null => {
  const [first] = args;
  return typeof first === 'string' ? first : null;
};

const isOverlayLogCall = (args: readonly unknown[]): boolean => {
  const firstMessage = getFirstMessage(args);
  if (!firstMessage) {
    return false;
  }

  return LOG_PREFIXES.some((prefix) => firstMessage.startsWith(prefix));
};

const isVerboseOverlayLog = (args: readonly unknown[]): boolean => {
  const firstMessage = getFirstMessage(args);
  if (!firstMessage) {
    return false;
  }

  const normalized = firstMessage.toLowerCase();
  return VERBOSE_LOG_MARKERS.some((marker) => normalized.includes(marker));
};

const shouldEmitInfo = (args: readonly unknown[]): boolean => {
  if (currentLogLevel === 'warn') {
    return false;
  }

  if (currentLogLevel === 'debug') {
    return true;
  }

  if (!isOverlayLogCall(args)) {
    return true;
  }

  return !isVerboseOverlayLog(args);
};

export const overlayLog = {
  debug: (...args: ConsoleLogArgs): void => {
    if (currentLogLevel === 'debug') {
      console.log(...args);
    }
  },
  info: (...args: ConsoleLogArgs): void => {
    if (shouldEmitInfo(args)) {
      console.log(...args);
    }
  },
  warn: (...args: ConsoleWarnArgs): void => {
    console.warn(...args);
  },
  error: (...args: ConsoleErrorArgs): void => {
    console.error(...args);
  },
} as const;

export const setOverlayLogLevel = (level: LogLevel): void => {
  currentLogLevel = level;
};

export const initOverlayLogLevel = (): void => {
  setOverlayLogLevel(readStoredLogLevel());
};
