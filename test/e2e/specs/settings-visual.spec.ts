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
 * Run: pnpm exec playwright test --config test/e2e/playwright.config.ts settings-visual --headed
 */

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { setupOverlayPage } from '../fixtures/test-utils';

const BUTTON_ID = 'yt-chat-overlay-settings-button';

async function setupSettingsPage(page: Page): Promise<void> {
  await setupOverlayPage(page);
  // Wait for settings button to appear
  await page.waitForSelector(`#${BUTTON_ID}`, { timeout: 10_000 });
}

async function openSettingsModal(page: Page): Promise<void> {
  await setupSettingsPage(page);
  // The mock video can win hit-testing even while the overlay button is visible.
  // Force only this synthetic interaction; real pointer hit-testing is outside
  // the mock page's contract.
  await page.locator(`#${BUTTON_ID}`).click({ force: true });
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
    await openSettingsModal(page);

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
    await openSettingsModal(page);

    const modal = page.locator('#yt-chat-overlay-settings-backdrop');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Click outside or press Escape to close
    await page.keyboard.press('Escape');
    // Modal should be dismissed
    await expect(modal).not.toBeVisible();
  });

  test('settings panel exposes a stable layout contract', async ({ page }) => {
    await openSettingsModal(page);

    const modal = page.locator('#yt-chat-overlay-settings-backdrop');
    await expect(modal).toHaveRole('dialog');
    await expect(modal).toHaveAttribute('aria-modal', 'true');
    await expect(modal.locator('.yt-chat-overlay-settings-close')).toBeVisible();
    await expect(modal.locator('.yt-chat-overlay-settings-tabs')).toBeVisible();

    const box = await modal.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(280);
    expect(box!.height).toBeGreaterThan(180);
  });

  test('exports the current settings as a versioned JSON download', async ({ page }) => {
    await openSettingsModal(page);

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#yt-chat-overlay-settings-backdrop button[data-action="export"]').click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('yt-chat-overlay-settings.json');
    const path = await download.path();
    expect(path).toBeTruthy();

    const exported = JSON.parse(readFileSync(path!, 'utf8')) as Record<string, unknown>;
    expect(exported._version).toBe(2);
    expect(exported.enabled).toBe(true);
    expect(exported.colors).toBeTruthy();
  });

  test('imports valid JSON and applies the settings to the running overlay', async ({ page }) => {
    await openSettingsModal(page);

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('#yt-chat-overlay-settings-backdrop button[data-action="import"]').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: 'overlay-settings.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ fontSize: 44, opacity: 0.6 })),
    });

    const toast = page.locator('#yt-chat-overlay-settings-backdrop [role="status"]');
    await expect(toast).toContainText(/Settings imported successfully/i);

    const settings = await page.evaluate(() => {
      const handle = (window as unknown as { __ytChatOverlay?: { getSettings: () => Record<string, unknown> } })
        .__ytChatOverlay;
      return handle?.getSettings();
    });
    expect(settings?.fontSize).toBe(44);
    expect(settings?.opacity).toBe(0.6);
  });
});
