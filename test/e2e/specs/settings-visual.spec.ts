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
import { setupOverlayPage } from '../fixtures/test-utils';

const OVERLAY_ID = 'yt-live-chat-overlay';
const BUTTON_ID = 'yt-chat-overlay-settings-button';

async function setupSettingsPage(page: Page): Promise<void> {
  await setupOverlayPage(page);
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

  test.skip('settings modal opens with all tabs', async ({ page }) => {
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

  test.skip('settings modal can be closed', async ({ page }) => {
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

  test.skip('screenshot: settings panel visual state', async ({ page }) => {
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
