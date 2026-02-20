import type { LogLevel } from '@app-types';

interface StoredSettingsLike {
  logLevel?: LogLevel;
  debugLogging?: boolean;
}

const SETTINGS_STORAGE_KEY = 'yt-live-chat-overlay-settings';

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

const DEFAULT_LOG_LEVEL: LogLevel = 'warn';

let currentLogLevel: LogLevel = DEFAULT_LOG_LEVEL;
let isConsolePatched = false;
let originalConsoleLog: Console['log'] | null = null;

const isOverlayLogCall = (args: unknown[]): boolean => {
  const [first] = args;
  if (typeof first !== 'string') {
    return false;
  }

  return LOG_PREFIXES.some((prefix) => first.startsWith(prefix));
};

const isVerboseOverlayLog = (args: unknown[]): boolean => {
  const [first] = args;
  if (typeof first !== 'string') {
    return false;
  }

  const normalized = first.toLowerCase();
  return VERBOSE_LOG_MARKERS.some((marker) => normalized.includes(marker));
};

const shouldAllowOverlayLog = (args: unknown[]): boolean => {
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

const patchConsoleLog = (): void => {
  if (isConsolePatched) {
    return;
  }

  originalConsoleLog = console.log.bind(console);

  console.log = (...args: unknown[]) => {
    if (shouldAllowOverlayLog(args)) {
      originalConsoleLog?.(...(args as Parameters<Console['log']>));
    }
  };

  isConsolePatched = true;
};

export const setOverlayLogLevel = (level: LogLevel): void => {
  patchConsoleLog();
  currentLogLevel = level;
};

export const initOverlayLogLevel = (): void => {
  let level: LogLevel = DEFAULT_LOG_LEVEL;

  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as StoredSettingsLike;
      if (parsed.logLevel) {
        level = parsed.logLevel;
      } else if (parsed.debugLogging) {
        // Legacy compatibility: old boolean true maps to verbose debug.
        level = 'debug';
      }
    }
  } catch {
    level = DEFAULT_LOG_LEVEL;
  }

  setOverlayLogLevel(level);
};
