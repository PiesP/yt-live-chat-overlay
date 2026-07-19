// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * @fileoverview Shared test utilities for YT Live Chat Overlay E2E tests.
 *
 * Provides helpers to:
 * - Set up a mock YouTube watch page via page.route()
 * - Install GM_* + chrome.* mocks via addInitScript
 * - Inject the userscript bundle
 * - Reload with preserved settings
 * - Access the debug handle (window.__ytChatOverlay)
 * - Create mock chat messages
 */

import { type Page, type Route } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Paths ───────────────────────────────────────────────────────────────────

export const DIST_DIR = resolve(process.cwd(), 'dist');
export const USERSCRIPT_PATH = resolve(DIST_DIR, 'yt-live-chat-overlay.dev.user.js');
export const EXTENSION_DIR = resolve(process.cwd(), 'dist-extension');

// ─── Constants ───────────────────────────────────────────────────────────────

export const OVERLAY_ID = 'yt-live-chat-overlay';
export const BUTTON_ID = 'yt-chat-overlay-settings-button';

export const MOCK_WATCH_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
export const MOCK_NON_WATCH_URL = 'https://www.youtube.com/feed/trending';
export const SETTINGS_STORAGE_KEY = 'yt-live-chat-overlay-settings';

/**
 * Minimal mock YouTube watch page HTML.
 * Includes #movie_player, a video element, and #chat (live panel marker)
 * so that the overlay can initialize correctly.
 */
export const MOCK_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>YouTube</title></head>
<body>
  <div id="page-manager">
    <div id="content">
      <div id="primary">
        <div id="player-container">
          <div id="movie_player" class="html5-video-player" style="width:800px;height:450px;position:relative;overflow:hidden">
            <video style="width:100%;height:100%" src="about:blank"></video>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div id="chat" style="display:none"></div>
</body>
</html>`;

/** Minimal non-video page used to prove the app's page gating. */
export const MOCK_NON_WATCH_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>YouTube</title></head>
<body><div id="page-manager"><div id="content"><h1>Trending</h1></div></div></body>
</html>`;

// ─── Actual Default Settings (from the app) ──────────────────────────────────

/**
 * OverlaySettings default values imported directly from the source code.
 * This eliminates the maintenance burden of keeping test fixtures in sync
 * with src/settings/defaults.ts — any production default changes
 * automatically propagate to E2E tests.
 */
import { DEFAULT_SETTINGS as SRC_DEFAULTS } from '@settings/defaults';
export const DEFAULT_SETTINGS: Record<string, unknown> = {
  ...SRC_DEFAULTS,
  // Deep-copy nested objects so tests can mutate without side effects
  showAuthor: { ...SRC_DEFAULTS.showAuthor },
  colors: { ...SRC_DEFAULTS.colors },
  outline: { ...SRC_DEFAULTS.outline },
};

// ─── Mock Setup ──────────────────────────────────────────────────────────────

/**
 * Install GM_* and chrome.* mock APIs on the page.
 * Must be called via page.addInitScript() before navigation.
 * If preSeedSettings is provided, those settings are stored in the mock
 * storage before any page scripts run (useful for cross-reload persistence).
 */
export function installYTMock(init: {
  preSeedSettings?: string;
  defaults: Record<string, unknown>;
}): void {
  const { preSeedSettings, defaults } = init;
  const storage = new Map<string, unknown>();
  const listeners = new Map<number, {
    key: string;
    callback: (key: string, oldVal: unknown, newVal: unknown, remote: boolean) => void;
  }>();
  let listenerId = 0;

  // Pre-seed settings if provided (for cross-reload persistence)
  if (preSeedSettings) {
    storage.set('yt-live-chat-overlay-settings', preSeedSettings);
  }

  // GM_* API mocks
  window.GM_setValue = (key: string, value: unknown) => {
    const oldVal = storage.get(key);
    storage.set(key, value);
    for (const [, { key: k, callback }] of listeners) {
      if (k === key) callback(key, oldVal, value, false);
    }
  };
  window.GM_getValue = <T = unknown>(key: string, defaultValue?: T): T | undefined =>
    storage.has(key) ? (storage.get(key) as T) : defaultValue;
  window.GM_deleteValue = (key: string) => { storage.delete(key); };
  window.GM_listValues = () => Array.from(storage.keys());
  window.GM_addValueChangeListener = (
    key: string,
    cb: (key: string, oldVal: unknown, newVal: unknown, remote: boolean) => void,
  ): number => {
    const id = ++listenerId;
    listeners.set(id, { key, callback: cb });
    return id;
  };
  window.GM_removeValueChangeListener = (id: number) => { listeners.delete(id); };
  window.GM_registerMenuCommand = () => 0;
  window.GM_openInTab = (url: string) => { window.open(url, '_blank'); };
  window.GM_cookie = {
    list: () => document.cookie.split(';').filter(Boolean).map((c) => {
      const [name, ...rest] = c.trim().split('=');
      return { name: name!.trim(), value: rest.join('=').trim() };
    }),
    set: (cookie: { name: string; value: string }) => { document.cookie = `${cookie.name}=${cookie.value}`; },
    delete: (name: string) => { document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`; },
  };

  // chrome.* API mocks (extension path)
  (window as unknown as Record<string, unknown>).chrome = {
    runtime: {
      id: 'test-extension-id',
      getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
      onMessage: { addListener: () => {}, removeListener: () => {} },
      sendMessage: () => {},
      lastError: undefined,
    },
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const result: Record<string, unknown> = {};
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const k of keyList) { if (storage.has(k)) result[k] = storage.get(k); }
          return result;
        },
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) storage.set(k, v);
        },
        remove: async (keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const k of keyList) storage.delete(k);
        },
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    i18n: {
      getUILanguage: () => 'en',
      getAcceptLanguages: async () => ['en', 'en-US'],
    },
    contextMenus: { create: () => {}, removeAll: () => {}, onClicked: { addListener: () => {} } },
    menus: { create: () => {}, removeAll: () => {}, onClicked: { addListener: () => {} } },
  };

  // If no pre-seed, seed with defaults
  if (!preSeedSettings) {
    storage.set('yt-live-chat-overlay-settings', JSON.stringify(defaults));
  }
}

// ─── Route Interception ──────────────────────────────────────────────────────

/**
 * Register a route handler that intercepts YouTube requests and serves
 * the mock HTML page so the userscript initializes on a youtube.com domain.
 * Aborts non-document requests to prevent unnecessary network errors.
 */
export async function setupMockPageRoute(page: Page): Promise<void> {
  await page.route('https://www.youtube.com/**', async (route: Route) => {
    const request = route.request();
    if (request.resourceType() === 'document') {
      const url = new URL(request.url());
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: url.pathname === '/watch' || url.pathname.startsWith('/live/')
          ? MOCK_HTML
          : MOCK_NON_WATCH_HTML,
      });
    } else {
      // Abort JS, CSS, image, font, etc. requests — we don't need real YouTube resources
      await route.abort('blockedbyclient');
    }
  });
}

// ─── Userscript Injection ────────────────────────────────────────────────────

/**
 * Read the userscript bundle and inject it via addInitScript.
 */
export async function injectUserscript(page: Page): Promise<void> {
  if (!existsSync(USERSCRIPT_PATH)) {
    throw new Error(
      `Dev userscript bundle not found at ${USERSCRIPT_PATH}. Run 'pnpm build:dev' first.`,
    );
  }
  const bundle = readFileSync(USERSCRIPT_PATH, 'utf8');
  await page.addInitScript({ content: bundle });
}

// ─── Full Setup ──────────────────────────────────────────────────────────────

/**
 * Complete E2E setup: route mocks → install GM mocks → inject userscript → navigate.
 * Uses pre-seeded settings from DEFAULT_SETTINGS.
 */
export async function setupOverlayPage(page: Page): Promise<void> {
  // 1. Register mock route (must be before navigation)
  await setupMockPageRoute(page);

  // 2. Install GM + chrome mocks with default settings
  await page.addInitScript(installYTMock, { defaults: DEFAULT_SETTINGS });

  // 3. Inject userscript
  await injectUserscript(page);

  // 4. Navigate to mock YouTube watch page
  await page.goto(MOCK_WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  // 5. Wait for the real overlay container to initialize
  await page.locator(`#${OVERLAY_ID}`).waitFor({ state: 'attached', timeout: 15_000 });

  // The runtime creates the container before initApp() exposes its debug
  // handle. Wait for both signals so tests that inspect or mutate settings do
  // not race the final part of application startup.
  await page.waitForFunction(
    () => {
      const w = window as unknown as Record<string, unknown>;
      const handle = w.__ytChatOverlay;
      return typeof handle === 'object' && handle !== null;
    },
    undefined,
    { timeout: 15_000 },
  );
}

// ─── Debug Handle Helpers ────────────────────────────────────────────────────

/**
 * Read settings via the debug handle.
 */
export async function getSettings(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const w = (window as unknown) as Record<string, unknown>;
    const handle = w.__ytChatOverlay as { getSettings?: () => Record<string, unknown> } | undefined;
    return handle?.getSettings?.() ?? {};
  });
}

/**
 * Apply settings via the debug handle.
 */
export async function applySettings(page: Page, partial: Record<string, unknown>): Promise<void> {
  await page.evaluate((settings) => {
    const w = (window as unknown) as Record<string, unknown>;
    const handle = w.__ytChatOverlay as { applySettings?: (s: Record<string, unknown>) => void } | undefined;
    handle?.applySettings?.(settings);
  }, partial);
  await waitForStoredSettings(page, partial);
}

/**
 * Wait for the debounced settings write to contain the expected values.
 */
export async function waitForStoredSettings(page: Page, expected: Record<string, unknown>): Promise<void> {
  // Wait for the debounced storage write instead of sleeping for a fixed
  // duration; this keeps the test fast and stable on slow CI runners.
  await page.waitForFunction(
    async ({ expected, storageKey }: { expected: Record<string, unknown>; storageKey: string }) => {
      const chromeStorage = (window as unknown as {
        chrome?: { storage?: { local?: { get: (key: string) => Promise<Record<string, unknown>> } } };
      }).chrome?.storage?.local;
      let raw: unknown;
      if (chromeStorage) {
        const stored = await chromeStorage?.get(storageKey);
        const chromeValue = stored?.[storageKey];
        raw = typeof chromeValue === 'string' ? chromeValue : undefined;
      }
      if (typeof raw !== 'string') raw = window.GM_getValue?.(storageKey);
      if (typeof raw !== 'string') return false;
      try {
        const saved = JSON.parse(raw) as Record<string, unknown>;
        const handle = (window as unknown as Record<string, unknown>).__ytChatOverlay as
          | { getSettings?: () => Record<string, unknown> }
          | undefined;
        const current = handle?.getSettings?.();
        if (!current) return false;
        return Object.keys(expected as Record<string, unknown>).every(
          (key) => JSON.stringify(saved[key]) === JSON.stringify(current[key]),
        );
      } catch {
        return false;
      }
    },
    { expected, storageKey: SETTINGS_STORAGE_KEY },
    { timeout: 5000 },
  );
}

/**
 * Read raw settings from the active storage backend.
 *
 * The E2E fixture exposes both browser APIs, so the adapter's priority order
 * must be mirrored here: Chrome storage first, then GM_* fallback.
 */
export async function readGmStorage(page: Page): Promise<string | undefined> {
  return page.evaluate(async (storageKey) => {
    const chromeStorage = (window as unknown as {
      chrome?: { storage?: { local?: { get: (key: string) => Promise<Record<string, unknown>> } } };
    }).chrome?.storage?.local;
    if (chromeStorage) {
      const stored = await chromeStorage.get(storageKey);
      const chromeValue = stored?.[storageKey];
      if (typeof chromeValue === 'string') return chromeValue;
    }
    const gmValue = window.GM_getValue?.(storageKey);
    return typeof gmValue === 'string' ? gmValue : undefined;
  }, SETTINGS_STORAGE_KEY);
}
