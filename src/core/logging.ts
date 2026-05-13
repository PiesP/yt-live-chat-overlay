import type { LogLevel } from '@app-types';

type ConsoleLogArgs = Parameters<Console['log']>;
type ConsoleWarnArgs = Parameters<Console['warn']>;
type ConsoleErrorArgs = Parameters<Console['error']>;

const DEFAULT_LOG_LEVEL: LogLevel = 'warn';

let currentLogLevel: LogLevel = DEFAULT_LOG_LEVEL;

const LOG_LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  warn: 0,
  info: 1,
  debug: 2,
};

const shouldEmit = (level: 'debug' | 'info'): boolean =>
  LOG_LEVEL_RANK[currentLogLevel] >= LOG_LEVEL_RANK[level];

const overlayLog = {
  debug: (...args: ConsoleLogArgs): void => {
    if (shouldEmit('debug')) {
      console.debug(...args);
    }
  },
  info: (...args: ConsoleLogArgs): void => {
    if (shouldEmit('info')) {
      console.info(...args);
    }
  },
  warn: (...args: ConsoleWarnArgs): void => {
    console.warn(...args);
  },
  error: (...args: ConsoleErrorArgs): void => {
    console.error(...args);
  },
};

export const setOverlayLogLevel = (level: LogLevel): void => {
  currentLogLevel = level;
};

interface ModuleLogger {
  debug: (...args: ConsoleLogArgs) => void;
  info: (...args: ConsoleLogArgs) => void;
  warn: (...args: ConsoleWarnArgs) => void;
  error: (...args: ConsoleErrorArgs) => void;
}

export const createLogger = (moduleName: string): ModuleLogger => {
  const prefix = `[${moduleName}]`;
  return {
    debug: (...args) => overlayLog.debug(prefix, ...args),
    info: (...args) => overlayLog.info(prefix, ...args),
    warn: (...args) => overlayLog.warn(prefix, ...args),
    error: (...args) => overlayLog.error(prefix, ...args),
  };
};
