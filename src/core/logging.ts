import type { LogLevel } from '@app-types';

interface StoredSettingsLike {
  logLevel?: LogLevel;
  debugLogging?: boolean;
}

type ConsoleLogArgs = Parameters<Console['log']>;

const STORAGE_KEY = 'yt-live-chat-overlay-settings';
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
let isConsolePatched = false;
let originalConsoleLog: Console['log'] | null = null;

const getFirstMessage = (args: readonly unknown[]): string | null => {
  const [first] = args;
  return typeof first === 'string' ? first : null;
};

const isValidLogLevel = (value: unknown): value is LogLevel =>
  value === 'warn' || value === 'info' || value === 'debug';

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

const shouldAllowOverlayLog = (args: readonly unknown[]): boolean => {
  if (!isOverlayLogCall(args)) {
    return true;
  }

  if (currentLogLevel === 'debug') {
    return true;
  }

  if (currentLogLevel === 'info') {
    return !isVerboseOverlayLog(args);
  }

  return false;
};

const readStoredLogLevel = (): LogLevel => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return DEFAULT_LOG_LEVEL;
    }

    const parsed = JSON.parse(stored) as StoredSettingsLike;
    if (isValidLogLevel(parsed.logLevel)) {
      return parsed.logLevel;
    }

    // Legacy compatibility: old boolean true maps to verbose debug.
    if (parsed.debugLogging) {
      return 'debug';
    }
  } catch {
    return DEFAULT_LOG_LEVEL;
  }

  return DEFAULT_LOG_LEVEL;
};

const patchConsoleLog = (): void => {
  if (isConsolePatched) {
    return;
  }

  originalConsoleLog ??= console.log.bind(console);

  console.log = (...args: ConsoleLogArgs) => {
    if (shouldAllowOverlayLog(args)) {
      originalConsoleLog?.(...args);
    }
  };

  isConsolePatched = true;
};

export const setOverlayLogLevel = (level: LogLevel): void => {
  patchConsoleLog();
  currentLogLevel = level;
};

export const initOverlayLogLevel = (): void => {
  setOverlayLogLevel(readStoredLogLevel());
};
