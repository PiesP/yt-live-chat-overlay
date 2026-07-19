// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 PiesP

/**
 * @fileoverview E2E tests for YT Live Chat Overlay userscript.
 *
 * Tests overlay initialization on YouTube pages by:
 * 1. Navigating to YouTube
 * 2. Injecting GM_* + chrome.* mocks
 * 3. Injecting the built userscript
 * 4. Verifying overlay initialization and state
 */

import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import {
  USERSCRIPT_PATH,
  setupOverlayPage,
  injectUserscript,
  MOCK_WATCH_URL,
} from '../fixtures/test-utils';

test.describe('YT Live Chat Overlay E2E', () => {
  test.beforeAll(() => {
    if (!existsSync(USERSCRIPT_PATH)) {
      throw new Error(
        `Dev userscript bundle not found at ${USERSCRIPT_PATH}. Run 'pnpm build:dev' first.`
      );
    }
  });

  test('userscript injects without errors on YouTube homepage', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await setupOverlayPage(page);

    const overlayErrors = errors.filter((e) =>
      e.includes('ytco') || e.includes('overlay') || e.includes('chat-overlay')
    );
    expect(overlayErrors).toHaveLength(0);
  });

  test('GM_* mock APIs are available after injection', async ({ page }) => {
    await setupOverlayPage(page);

    const gmAvailable = await page.evaluate(() => ({
      GM_setValue: typeof window.GM_setValue === 'function',
      GM_getValue: typeof window.GM_getValue === 'function',
      GM_deleteValue: typeof window.GM_deleteValue === 'function',
      GM_listValues: typeof window.GM_listValues === 'function',
      GM_addValueChangeListener: typeof window.GM_addValueChangeListener === 'function',
      GM_cookie: typeof window.GM_cookie === 'object',
    }));

    expect(gmAvailable.GM_setValue).toBe(true);
    expect(gmAvailable.GM_getValue).toBe(true);
    expect(gmAvailable.GM_addValueChangeListener).toBe(true);
  });

  test('chrome.* mock APIs are available after injection', async ({ page }) => {
    await setupOverlayPage(page);

    const chromeAvailable = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const chrome = w.chrome as Record<string, unknown> | undefined;
      return {
        hasChrome: typeof chrome === 'object',
        runtime: typeof chrome?.runtime === 'object',
        storage: typeof chrome?.storage === 'object',
        i18n: typeof chrome?.i18n === 'object',
        contextMenus: typeof chrome?.contextMenus === 'object',
      };
    });

    expect(chromeAvailable.hasChrome).toBe(true);
    expect(chromeAvailable.runtime).toBe(true);
    expect(chromeAvailable.storage).toBe(true);
    expect(chromeAvailable.i18n).toBe(true);
  });

  test('GM_setValue/GM_getValue roundtrip works', async ({ page }) => {
    await setupOverlayPage(page);

    const result = await page.evaluate(() => {
      window.GM_setValue!('test_overlay_key', 'test_value');
      return window.GM_getValue!('test_overlay_key');
    });

    expect(result).toBe('test_value');
  });

  test('chrome.storage.local roundtrip works', async ({ page }) => {
    await setupOverlayPage(page);

    const result = await page.evaluate(async () => {
      const w = window as unknown as Record<string, unknown>;
      const chrome = w.chrome as { storage: { local: { set: (items: Record<string, unknown>) => Promise<void>; get: (keys: string | string[]) => Promise<Record<string, unknown>> } } };
      await chrome.storage.local.set({ chrome_test_key: 'chrome_value' });
      const stored = await chrome.storage.local.get('chrome_test_key');
      return (stored as Record<string, unknown>).chrome_test_key as string;
    });

    expect(result).toBe('chrome_value');
  });

  test('userscript does not crash on YouTube navigation', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await setupOverlayPage(page);
    await page.goto('https://www.youtube.com/feed/trending', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#yt-live-chat-overlay')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__ytChatOverlay)).toBeUndefined();

    const overlayErrors = errors.filter((e) =>
      e.includes('ytco') || e.includes('overlay') || e.includes('chat-overlay')
    );
    expect(overlayErrors).toHaveLength(0);
  });

  test('userscript bundle contains expected code', async ({ page }) => {
    await setupOverlayPage(page);

    // addInitScript injects code directly (no <script> tag in DOM)
    // Verify the script ran by checking that the App initialized
    const scriptRan = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      // The App class exposes window.__ytChatOverlay for debugging
      return w.__ytChatOverlay !== undefined;
    });

    expect(scriptRan).toBe(true);
  });

  test('App exposes debug handle on window', async ({ page }) => {
    await setupOverlayPage(page);

    // The App class exposes window.__ytChatOverlay for debugging
    const hasDebugHandle = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return typeof w.__ytChatOverlay === 'object';
    });

    expect(hasDebugHandle).toBe(true);
  });
});
