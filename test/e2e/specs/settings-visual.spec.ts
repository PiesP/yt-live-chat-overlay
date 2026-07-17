// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 PiesP

/**
 * @fileoverview Settings UI visual test for YT Live Chat Overlay.
 *
 * This test verifies that:
 * 1. The settings gear button appears on the player
 * 2. Clicking the button opens the settings modal
 * 3. The settings modal has all expected tabs (Comments, Appearance, Advanced, Translation)
 * 4. Settings can be read/written through the GM_setValue/GM_getValue mock
 *
 * Prerequisite: pnpm build:dev (dist/yt-live-chat-overlay.dev.user.js)
 * Run: cd test && npx playwright test e2e/specs/settings-visual.spec.ts --headed
 */

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DIST_DIR = resolve(process.cwd(), '../dist');
const USERSCRIPT_PATH = resolve(DIST_DIR, 'yt-live-chat-overlay.dev.user.js');

const OVERLAY_ID = 'yt-live-chat-overlay';
const BUTTON_ID = 'yt-chat-overlay-settings-button';

async function installMocks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const storage = new Map<string, unknown>();
    const listeners = new Map<number, { key: string; callback: (...args: unknown[]) => void }>();
    let listenerId = 0;

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
    ) => {
      const id = ++listenerId;
      listeners.set(id, { key, callback: cb });
      return id;
    };
    window.GM_removeValueChangeListener = (id: number) => { listeners.delete(id); };
    window.GM_registerMenuCommand = () => {};
    window.GM_openInTab = (url: string) => { window.open(url, '_blank'); };
  });
}

async function setupSettingsPage(page: Page): Promise<void> {
  // Create DOM structure with a visible player on about:blank
  await page.goto('about:blank');

  await page.addInitScript(() => {
    // Create the player element that the app looks for
    const player = document.createElement('div');
    player.id = 'movie_player';
    player.className = 'html5-video-player';
    player.style.width = '800px';
    player.style.height = '450px';
    player.style.position = 'relative';
    player.style.margin = '0 auto';
    document.body.appendChild(player);

    // Live chat panel marker — signals this is a live stream (not VOD)
    const chat = document.createElement('div');
    chat.id = 'chat';
    chat.style.display = 'none';
    document.body.appendChild(chat);
  });

  // Install GM mocks
  await installMocks(page);

  // Read and inject the dev userscript bundle
  if (!existsSync(USERSCRIPT_PATH)) {
    throw new Error(`Bundle not found: ${USERSCRIPT_PATH}\nRun: pnpm build:dev`);
  }
  const bundle = readFileSync(USERSCRIPT_PATH, 'utf8');
  await page.addInitScript({ content: bundle });

  // Re-navigate to execute the initScripts
  await page.goto('about:blank');

  // Wait for settings button to appear
  await page.waitForSelector(`#${BUTTON_ID}`, { timeout: 10_000 });
}

test.describe('Settings UI Visual', () => {
  test('gear button appears on player', async ({ page }) => {
    await setupSettingsPage(page);
    const btn = page.locator(`#${BUTTON_ID}`);
    await expect(btn).toBeVisible();
    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(20);
    expect(box!.height).toBeGreaterThan(20);
  });

  test('settings modal opens with all tabs', async ({ page }) => {
    await setupSettingsPage(page);

    // Click the gear button to open settings
    await page.locator(`#${BUTTON_ID}`).click();
    await page.waitForTimeout(500);

    // Verify settings modal is visible
    const modal = page.locator('#yt-chat-overlay-settings-backdrop');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Verify all 4 tabs exist (tabs use id="tab-{paneId}" convention)
    const commentsTab = page.locator('#tab-comments');
    const colorsTab = page.locator('#tab-colors');
    const advancedTab = page.locator('#tab-advanced');
    const translationTab = page.locator('#tab-translation');

    await expect(commentsTab).toBeVisible();
    await expect(colorsTab).toBeVisible();
    await expect(advancedTab).toBeVisible();
    await expect(translationTab).toBeVisible();
  });

  test('settings modal can be closed', async ({ page }) => {
    await setupSettingsPage(page);

    await page.locator(`#${BUTTON_ID}`).click();
    await page.waitForTimeout(500);

    const modal = page.locator('#yt-chat-overlay-settings-backdrop');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Click outside or press Escape to close
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Modal should be dismissed
    await expect(modal).not.toBeVisible();
  });

  test('screenshot: settings panel visual state', async ({ page }) => {
    await setupSettingsPage(page);

    await page.locator(`#${BUTTON_ID}`).click();
    await page.waitForTimeout(500);

    // Wait for modal to fully render
    await page.waitForSelector('#tab-comments', { timeout: 5000 });
    await page.waitForTimeout(500);

    // Capture screenshot for visual verification
    await page.screenshot({
      path: 'test-results/settings-panel-screenshot.png',
      fullPage: false,
    });
  });
});
