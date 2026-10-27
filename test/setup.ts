/**
 * Vitest Global Setup — YT Live Chat Overlay
 *
 * Mocks the userscript and logging boundaries shared by Node and browser tests.
 */

import { afterAll, beforeEach, vi } from 'vite-plus/test';

// ═══════════════════════════════════════════════════════════
// GM_* API Mocks
// ═══════════════════════════════════════════════════════════

const gmStorage = new Map<string, unknown>();

(globalThis as Record<string, unknown>).GM_getValue = <T>(key: string, defaultValue?: T): T => {
  return (gmStorage.get(key) as T) ?? (defaultValue as T);
};

(globalThis as Record<string, unknown>).GM_setValue = (key: string, value: unknown): void => {
  gmStorage.set(key, value);
};

(globalThis as Record<string, unknown>).GM_deleteValue = (key: string): void => {
  gmStorage.delete(key);
};

(globalThis as Record<string, unknown>).GM_listValues = (): string[] => {
  return Array.from(gmStorage.keys());
};

(globalThis as Record<string, unknown>).GM_xmlhttpRequest = (_details: {
  url: string;
  method?: string;
  onload?: (response: { status: number; responseText: string }) => void;
  onerror?: (error: unknown) => void;
}) => {
  return { abort: (): void => {} };
};

(globalThis as Record<string, unknown>).GM_download = (
  _arg1: string | { url: string; name: string },
  _name?: string
) => {
  return { abort: (): void => {} };
};

(globalThis as Record<string, unknown>).GM_notification = (
  _details: { title?: string; text?: string },
  _ondone?: () => void
): void => {};

(globalThis as Record<string, unknown>).GM_info = {
  script: {
    version: '1.0.0',
    name: 'YT Live Chat Overlay',
  },
};

// ═══════════════════════════════════════════════════════════
// Mock Logger (suppress log noise in tests)
// ═══════════════════════════════════════════════════════════

const loggerMock = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('@util/logging', () => ({
  createLogger: vi.fn(() => loggerMock),
  logger: loggerMock,
}));

// ═══════════════════════════════════════════════════════════
// Lifecycle Hooks
// ═══════════════════════════════════════════════════════════

beforeEach(() => {
  gmStorage.clear();
  if (typeof document !== 'undefined') {
    document.body.innerHTML = '';
  }
});

afterAll(() => {
  gmStorage.clear();
});
