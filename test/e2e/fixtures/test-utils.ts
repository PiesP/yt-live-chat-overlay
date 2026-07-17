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

const DIST_DIR = resolve(process.cwd(), '../dist');
const USERSCRIPT_PATH = resolve(DIST_DIR, 'yt-live-chat-overlay.dev.user.js');

// ─── Constants ───────────────────────────────────────────────────────────────

export const OVERLAY_ID = 'yt-live-chat-overlay';
export const BUTTON_ID = 'yt-chat-overlay-settings-button';

export const MOCK_WATCH_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

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

// ─── Actual Default Settings (from the app) ──────────────────────────────────

/**
 * OverlaySettings default values as produced by the running app.
 * Captured via debug-settings debug test so tests use accurate values.
 */
export const DEFAULT_SETTINGS: Record<string, unknown> = {
  enabled: true,
  danmakuMode: 'scroll',
  speedPxPerSec: 250,
  fontSize: 32,
  opacity: 1,
  superChatOpacity: 0.95,
  safeTop: 0,
  safeBottom: 0,
  maxConcurrentMessages: 100,
  allowShortTextMessages: true,
  minTextLength: 1,
  logLevel: 'warn',
  showAuthor: {
    normal: false,
    member: true,
    moderator: true,
    owner: true,
    verified: true,
    superChat: true,
  },
  colors: {
    normal: '#FFFFFF',
    member: '#0F9D58',
    moderator: '#5E84F1',
    owner: '#FFD600',
    verified: '#AAAAAA',
  },
  outline: { enabled: true, widthPx: 2, opacity: 0.7 },
  laneSpacing: 1,
  showDebugOverlay: false,
  ignoreReducedMotion: false,
  authorRateLimit: 'normal',
  backlogMaxRate: 10,
  backlogSpeedMultiplier: 1,
  backlogMode: 'playback',
  backlogRecentMinutes: 5,
  backlogOpacityMultiplier: 0.5,
  depthLayersEnabled: false,
  depthNearSpeedMul: 1.2,
  depthFarSpeedMul: 0.8,
  depthFarOpacityMul: 0.6,
  modOwnerDurationMultiplier: 1.5,
  showSuperChatAmount: true,
  fontWeight: 'normal',
  fontFamily: '',
  preserveUserColor: true,
  superChatMaxBodyLines: 3,
  membershipMaxBodyLines: 2,
  fadeDurationMs: 300,
  minPollIntervalMs: 1000,
  maxPollIntervalMs: 10000,
  language: 'en',
  translationEnabled: false,
  translationService: 'auto',
  translationSource: 'auto',
  translationTarget: 'en',
  translationMode: 'dual',
  exitPaddingPx: 50,
  scrollDurationMinMs: 3000,
  scrollDurationMaxMs: 15000,
  topBottomDurationMs: 5000,
  queueMaxSize: 500,
  backgroundQueueMax: 200,
  maxMessageAgeMs: 30000,
  headwayGapRatio: 0.3,
  emojiCacheMb: 20,
  photoCacheMb: 10,
  stickerCacheMb: 5,
  textCacheMb: 5,
  translationBatchSize: 5,
  emojiFetchLimit: 20,
  failedEmojiRetryMins: 5,
  burstSampleWindow: 60,
  burstElevatedThreshold: 5,
  burstHighThreshold: 15,
  burstExtremeThreshold: 30,
  backlogInjectionMax: 50,
  backlogDensityRampMs: 5000,
  livePollFallbackMs: 2000,
  livePollFailureLimit: 5,
  speedBoostThreshold: 2,
  backlogPauseThreshold: 0.3,
  backlogResumeThreshold: 0.1,
  activityTimeoutMs: 60000,
  staggerMaxDelayMs: 100,
  staggerMediumDelayMs: 50,
  emojiFetchTimeoutMs: 5000,
  backlogDensityRampMaxMs: 10000,
  backlogInjectionRateMin: 1,
  speedBoostMax: 1,
  speedBoostDenom: 2,
  backlogToggleCooldownMs: 2000,
  replayPrefetchPages: 50,
  replayBatchLimit: 50,
};

// ─── Mock Setup ──────────────────────────────────────────────────────────────

/**
 * Install GM_* and chrome.* mock APIs on the page.
 * Must be called via page.addInitScript() before navigation.
 * If preSeedSettings is provided, those settings are stored in the mock
 * storage before any page scripts run (useful for cross-reload persistence).
 */
export function installYTMock(preSeedSettings?: string): void {
  const storage = new Map<string, unknown>();
  const listeners = new Map<number, { key: string; callback: (...args: unknown[]) => void }>();
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
  window.GM_registerMenuCommand = () => {};
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
    storage.set('yt-live-chat-overlay-settings', JSON.stringify(DEFAULT_SETTINGS));
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
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: MOCK_HTML,
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
  await page.addInitScript(installYTMock);

  // 3. Inject userscript
  await injectUserscript(page);

  // 4. Navigate to mock YouTube watch page
  await page.goto(MOCK_WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  // 5. Wait for the overlay to initialize
  await page.waitForTimeout(5000);
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
  // Give the settings debounce time to persist to storage
  await page.waitForTimeout(1000);
}

/**
 * Read raw settings from GM storage.
 */
export async function readGmStorage(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    return window.GM_getValue?.('yt-live-chat-overlay-settings');
  });
}
