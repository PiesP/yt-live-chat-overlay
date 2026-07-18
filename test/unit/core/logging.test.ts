/**
 * Tests for logging.ts — createLogger and setOverlayLogLevel.
 *
 * NOTE: test/setup.ts globally mocks @util/logging with noop loggers.
 * These tests override that mock with vi.mock to test the real implementation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════
// We explicitly NOT import from @util/logging here because test/setup.ts
// mocks it. Instead we test the internal pure function logic extracted below.
// ═══════════════════════════════════════════════════════════════════════

const LOG_LEVEL_RANK = {
  warn: 0,
  info: 1,
  debug: 2,
} as const;

type LogLevel = 'warn' | 'info' | 'debug';

function shouldEmit(currentLevel: LogLevel, messageLevel: 'debug' | 'info'): boolean {
  return LOG_LEVEL_RANK[currentLevel] >= LOG_LEVEL_RANK[messageLevel];
}

describe('logging — level emission logic', () => {
  describe('shouldEmit', () => {
    it('warn level suppresses debug messages', () => {
      expect(shouldEmit('warn', 'debug')).toBe(false);
    });

    it('warn level suppresses info messages', () => {
      expect(shouldEmit('warn', 'info')).toBe(false);
    });

    it('info level emits info messages', () => {
      expect(shouldEmit('info', 'info')).toBe(true);
    });

    it('info level suppresses debug messages', () => {
      expect(shouldEmit('info', 'debug')).toBe(false);
    });

    it('debug level emits all messages', () => {
      expect(shouldEmit('debug', 'info')).toBe(true);
      expect(shouldEmit('debug', 'debug')).toBe(true);
    });
  });

  describe('LOG_LEVEL_RANK ordering', () => {
    it('warn is the lowest rank (0)', () => {
      expect(LOG_LEVEL_RANK.warn).toBe(0);
    });

    it('debug is the highest rank (2)', () => {
      expect(LOG_LEVEL_RANK.debug).toBe(2);
    });

    it('warn < info < debug in rank order', () => {
      expect(LOG_LEVEL_RANK.warn).toBeLessThan(LOG_LEVEL_RANK.info);
      expect(LOG_LEVEL_RANK.info).toBeLessThan(LOG_LEVEL_RANK.debug);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Test the real logging module by unmocking and re-mocking with actual impl
// ═══════════════════════════════════════════════════════════════════════

describe('logging — createLogger (real module)', () => {
  let createLogger: (moduleName: string) => { debug: (...args: unknown[]) => void; info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  let setOverlayLogLevel: (level: LogLevel) => void;

  beforeEach(async () => {
    // Override the global mock from test/setup.ts by importing the actual module
    vi.doUnmock('@util/logging');
    const mod = await vi.importActual<typeof import('@util/logging')>('@util/logging');
    createLogger = mod.createLogger;
    setOverlayLogLevel = mod.setOverlayLogLevel;

    // Set to debug so all messages are emitted
    setOverlayLogLevel('debug');
  });

  it('creates a logger with module prefix', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const logger = createLogger('TestModule');
    logger.info('hello');
    expect(spy).toHaveBeenCalledWith('[TestModule]', 'hello');
    spy.mockRestore();
  });

  it('warn and error always emit regardless of log level', () => {
    setOverlayLogLevel('warn');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const logger = createLogger('Test');
    logger.warn('warning message');
    logger.error('error message');

    expect(warnSpy).toHaveBeenCalledWith('[Test]', 'warning message');
    expect(errorSpy).toHaveBeenCalledWith('[Test]', 'error message');

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('debug messages are suppressed at warn log level', () => {
    setOverlayLogLevel('warn');
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const logger = createLogger('Test');
    logger.debug('should not appear');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('debug messages appear at debug log level', () => {
    setOverlayLogLevel('debug');
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const logger = createLogger('Test');
    logger.debug('should appear');

    expect(spy).toHaveBeenCalledWith('[Test]', 'should appear');
    spy.mockRestore();
  });

  it('info messages are suppressed at warn log level', () => {
    setOverlayLogLevel('warn');
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const logger = createLogger('Test');
    logger.info('should not appear');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('setOverlayLogLevel changes the threshold globally', () => {
    setOverlayLogLevel('warn');
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const logger = createLogger('Test');
    logger.debug('suppressed');
    expect(spy).not.toHaveBeenCalled();

    setOverlayLogLevel('debug');
    logger.debug('now visible');
    expect(spy).toHaveBeenCalledWith('[Test]', 'now visible');

    spy.mockRestore();
  });

  it('multiple arguments are passed through', () => {
    setOverlayLogLevel('debug');
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const logger = createLogger('Test');
    logger.debug('a', 'b', 'c');

    expect(spy).toHaveBeenCalledWith('[Test]', 'a', 'b', 'c');
    spy.mockRestore();
  });
});
