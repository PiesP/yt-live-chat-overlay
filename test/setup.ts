/**
 * Vitest Global Setup — YT Live Chat Overlay
 *
 * Mocks the userscript environment (GM_* APIs) and provides
 * Canvas2D API support for renderer tests via the `canvas` package.
 */

import { afterAll, afterEach, beforeEach, vi } from "vitest";

// ═══════════════════════════════════════════════════════════
// GM_* API Mocks
// ═══════════════════════════════════════════════════════════

const gmStorage = new Map<string, unknown>();

(globalThis as Record<string, unknown>).GM_getValue = <T>(
  key: string,
  defaultValue?: T
): T => {
  return (gmStorage.get(key) as T) ?? (defaultValue as T);
};

(globalThis as Record<string, unknown>).GM_setValue = (
  key: string,
  value: unknown
): void => {
  gmStorage.set(key, value);
};

(globalThis as Record<string, unknown>).GM_deleteValue = (key: string): void => {
  gmStorage.delete(key);
};

(globalThis as Record<string, unknown>).GM_listValues = (): string[] => {
  return Array.from(gmStorage.keys());
};

(globalThis as Record<string, unknown>).GM_xmlhttpRequest = (details: {
  url: string;
  method?: string;
  onload?: (response: { status: number; responseText: string }) => void;
  onerror?: (error: unknown) => void;
}) => {
  return { abort: (): void => {} };
};

(globalThis as Record<string, unknown>).GM_download = (
  arg1: string | { url: string; name: string },
  _name?: string
) => {
  return { abort: (): void => {} };
};

(globalThis as Record<string, unknown>).GM_notification = (
  details: { title?: string; text?: string },
  _ondone?: () => void
): void => {};

(globalThis as Record<string, unknown>).GM_info = {
  script: {
    version: "1.0.0",
    name: "YT Live Chat Overlay",
  },
};

// ═══════════════════════════════════════════════════════════
// Canvas2D API Support
// ═══════════════════════════════════════════════════════════
// jsdom provides HTMLCanvasElement, getContext('2d'), and basic
// CanvasRenderingContext2D. For advanced features (measureText,
// drawImage, createPattern), the `canvas` npm package provides
// a Node.js-native implementation. Install it as needed for
// renderer-specific tests.
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// DOM API Polyfills (jsdom gaps)
// ═══════════════════════════════════════════════════════════

// requestAnimationFrame
if (typeof globalThis.requestAnimationFrame !== "function") {
  (globalThis as unknown as {
    requestAnimationFrame: typeof requestAnimationFrame;
  }).requestAnimationFrame = (cb: FrameRequestCallback) => {
    return setTimeout(
      () => cb(typeof performance !== "undefined" ? performance.now() : Date.now()),
      16
    ) as unknown as number;
  };
}

if (typeof globalThis.cancelAnimationFrame !== "function") {
  (globalThis as unknown as {
    cancelAnimationFrame: typeof cancelAnimationFrame;
  }).cancelAnimationFrame = (id: number) => {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  };
}

// ResizeObserver
if (typeof globalThis.ResizeObserver !== "function") {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as {
    ResizeObserver: typeof ResizeObserverMock;
  }).ResizeObserver = ResizeObserverMock;
}

// IntersectionObserver
if (typeof globalThis.IntersectionObserver !== "function") {
  class IntersectionObserverMock {
    constructor(_cb: IntersectionObserverCallback) {}
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver =
    IntersectionObserverMock as unknown as typeof IntersectionObserver;
}

// MatchMedia
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (_query: string): MediaQueryList => {
    return {
      matches: false,
      media: "",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
  };
}

// ═══════════════════════════════════════════════════════════
// Mock Logger (suppress log noise in tests)
// ═══════════════════════════════════════════════════════════

const loggerMock = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock("@util/logging", () => ({
  createLogger: vi.fn(() => loggerMock),
  logger: loggerMock,
}));

// ═══════════════════════════════════════════════════════════
// Lifecycle Hooks
// ═══════════════════════════════════════════════════════════

beforeEach(() => {
  gmStorage.clear();
  if (typeof document !== "undefined") {
    document.body.innerHTML = "";
  }
});

afterAll(() => {
  gmStorage.clear();
});
