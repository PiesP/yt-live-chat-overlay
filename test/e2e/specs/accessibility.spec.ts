// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 PiesP

/**
 * @fileoverview Accessibility E2E tests for YT Live Chat Overlay.
 *
 * Tests verify that the overlay implements proper accessibility features:
 * 1. Overlay container has a localized region name
 * 2. Canvas is hidden from the accessibility tree
 * 3. aria-live region exists for connection status announcements
 * 4. Settings modal exposes the native dialog accessibility contract
 * 5. Reset confirmation uses a native dialog with a real accessible description
 * 6. ignoreReducedMotion setting exists in settings panel (checkbox)
 * 7. Reload affordance remains operable and restarts the runtime
 *
 * Test approach:
 * - Build the development userscript first (pnpm test:e2e does this automatically)
 * - Navigate to a mock YouTube watch page and inject the bundle via shared setup
 * - Verify accessibility attributes on the overlay/canvas elements
 */

import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';

import { getSettings, setupOverlayPage, USERSCRIPT_PATH, waitForStoredSettings } from '../fixtures/test-utils';

const OVERLAY_ID = 'yt-live-chat-overlay';
const BUTTON_ID = 'yt-chat-overlay-settings-button';

async function openSettingsModal(page: Page): Promise<Locator> {
  await page.locator('#movie_player').hover();

  const settingsButton = page.locator(`#${BUTTON_ID}`);
  await expect(settingsButton).toBeAttached();
  await expect(settingsButton).toBeVisible();
  await settingsButton.click();

  const modal = page.locator('.yt-chat-overlay-settings-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAttribute('open', '');
  // Axe evaluates effective composited colors, so wait until the entrance
  // animation is fully opaque before measuring contrast.
  await expect(modal).toHaveCSS('opacity', '1');
  return modal;
}

async function closeSettingsModal(page: Page, modal: Locator): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(modal).not.toBeVisible();
  await expect(modal).not.toHaveAttribute('open', '');
}

async function tabTo(page: Page, target: Locator, limit = 60): Promise<void> {
  for (let step = 0; step < limit; step++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

test.describe('YT Live Chat Overlay Accessibility', () => {
  test.beforeAll(() => {
    if (!existsSync(USERSCRIPT_PATH)) {
      throw new Error(
        `Development userscript bundle not found at ${USERSCRIPT_PATH}. Run 'pnpm test:e2e' first.`,
      );
    }
  });

  test('overlay container has a region role and localized accessible name', async ({ page }) => {
    await setupOverlayPage(page);

    const container = page.locator(`#${OVERLAY_ID}`);

    await expect(container).toBeAttached();
    await expect(container).toHaveAttribute('role', 'region');

    const ariaLabel = await container.getAttribute('aria-label');
    expect(ariaLabel?.trim()).toBeTruthy();
  });

  test('settings dialog has no automated WCAG A/AA violations', async ({ page }) => {
    await setupOverlayPage(page);
    const modal = await openSettingsModal(page);
    const modalResults = await new AxeBuilder({ page })
      .include('.yt-chat-overlay-settings-modal')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(modalResults.violations).toEqual([]);

    await closeSettingsModal(page, modal);
  });

  test('renderer canvas is attached and hidden from the accessibility tree', async ({ page }) => {
    await setupOverlayPage(page);

    const canvas = page.locator(`#${OVERLAY_ID} canvas`);

    await expect(canvas).toBeAttached();
    await expect(canvas).toHaveAttribute('aria-hidden', 'true');
  });

  test('aria-live region exists with correct attributes', async ({ page }) => {
    await setupOverlayPage(page);

    const liveRegion = page.locator(`#${OVERLAY_ID} .yt-live-chat-overlay-live-region`);

    await expect(liveRegion).toBeAttached();
    await expect(liveRegion).toHaveAttribute('role', 'log');
    await expect(liveRegion).toHaveAttribute('aria-live', 'polite');

    const ariaLabel = await liveRegion.getAttribute('aria-label');
    expect(ariaLabel?.trim()).toBeTruthy();
  });

  test('settings modal exposes the native dialog accessibility contract', async ({ page }) => {
    await setupOverlayPage(page);

    const modal = await openSettingsModal(page);

    await expect(modal).toHaveAttribute('aria-modal', 'true');
    await expect(modal).toHaveAttribute('aria-labelledby', 'yt-chat-overlay-settings-title');
    await expect(page.locator('#yt-chat-overlay-settings-title')).toBeAttached();

    await closeSettingsModal(page, modal);
  });

  test('reset confirmation exposes its native dialog contract and restores focus', async ({
    page,
  }) => {
    await setupOverlayPage(page);
    const modal = await openSettingsModal(page);
    const resetButton = modal.locator('button[data-action="reset"]');

    await resetButton.click();

    const confirmation = page.locator('dialog.yt-chat-overlay-settings-confirm');
    const cancelButton = confirmation.locator('.yt-chat-overlay-settings-confirm-cancel');
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toHaveAttribute('open', '');
    await expect(confirmation).toHaveAttribute('aria-describedby', 'yt-chat-overlay-confirm-msg');
    await expect(page.locator('#yt-chat-overlay-confirm-msg')).not.toBeEmpty();
    await expect(cancelButton).toBeFocused();

    await cancelButton.click();

    await expect(confirmation).toHaveCount(0);
    await expect(resetButton).toBeFocused();
    await closeSettingsModal(page, modal);
  });

  test('ignoreReducedMotion setting exists in settings panel as checkbox', async ({ page }) => {
    await setupOverlayPage(page);

    const modal = await openSettingsModal(page);
    const reduceMotionCheckbox = modal.locator('input[name="ignoreReducedMotion"]');
    await expect(reduceMotionCheckbox).toBeAttached();
    await expect(reduceMotionCheckbox).toHaveAttribute('type', 'checkbox');

    await closeSettingsModal(page, modal);
  });

  test('font groups have independent names and support keyboard edits through save and reopen', async ({ page }) => {
    await setupOverlayPage(page);
    const modal = await openSettingsModal(page);
    const firstTab = modal.locator('#tab-comments');
    await expect(firstTab).toBeFocused();
    await page.keyboard.press('End');
    await expect(modal.locator('#tab-translation')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(firstTab).toBeFocused();

    const disclosure = modal.locator('#pane-comments details.yt-chat-overlay-settings-disclosure');
    await tabTo(page, disclosure.locator('summary'));
    await page.keyboard.press('Enter');
    await expect(disclosure).toHaveAttribute('open', '');

    const weight = disclosure.getByRole('group', { name: 'Font weight' });
    const family = disclosure.getByRole('group', { name: 'Font family' });
    const bold = weight.getByRole('button', { name: 'Bold' });
    const regular = weight.getByRole('button', { name: 'Regular' });
    const monospace = family.getByRole('button', { name: 'Monospace' });
    const custom = family.getByRole('textbox', { name: 'Custom font stack…' });
    await expect(bold).toHaveAttribute('aria-pressed', 'true');
    await expect(regular).toHaveAttribute('aria-pressed', 'false');
    await expect(monospace).toHaveAttribute('aria-pressed', 'false');
    await expect(custom).toHaveAccessibleName('Custom font stack…');

    await tabTo(page, regular);
    await page.keyboard.press('Space');
    await expect(regular).toHaveAttribute('aria-pressed', 'true');
    await tabTo(page, monospace);
    await page.keyboard.press('Space');
    await expect(monospace).toHaveAttribute('aria-pressed', 'true');
    await tabTo(page, custom);
    await page.keyboard.type('Georgia, serif');
    await expect(monospace).toHaveAttribute('aria-pressed', 'false');
    await expect(modal.locator('.yt-chat-overlay-settings-font-preview-text')).toHaveCSS('font-family', /Georgia.*serif/);

    await closeSettingsModal(page, modal);
    await waitForStoredSettings(page, { fontWeight: 'normal', fontFamily: 'Georgia, serif' });
    await expect.poll(async () => (await getSettings(page)).fontFamily).toBe('Georgia, serif');
    await openSettingsModal(page);
    if (!(await disclosure.evaluate((details: HTMLDetailsElement) => details.open))) {
      await disclosure.locator('summary').click();
    }
    await expect(disclosure).toHaveAttribute('open', '');
    await expect(regular).toHaveAttribute('aria-pressed', 'true');
    await expect(custom).toHaveValue('Georgia, serif');
    await closeSettingsModal(page, modal);
  });

  test('reload button exposes an accessible control and restarts the runtime', async ({ page }) => {
    await setupOverlayPage(page);
    await page.locator('#movie_player').hover();

    const reloadButton = page.locator('#yt-chat-overlay-reload-button');
    await expect(reloadButton).toBeVisible();
    await expect(reloadButton).toHaveAttribute('type', 'button');
    const accessibleName = await reloadButton.getAttribute('aria-label');
    expect(accessibleName?.trim()).toBeTruthy();

    const canvas = page.locator(`#${OVERLAY_ID} canvas`);
    await expect(canvas).toBeAttached();
    await canvas.evaluate((element) => element.setAttribute('data-e2e-before-restart', 'true'));

    await reloadButton.click();

    await expect(reloadButton).toHaveText('✓');
    await expect(reloadButton).toHaveClass(/yt-chat-overlay-reload-button--done/);

    await expect(canvas).toBeAttached();
    await expect(canvas).not.toHaveAttribute('data-e2e-before-restart', 'true');
    await expect(canvas).toHaveAttribute('aria-hidden', 'true');
    await expect
      .poll(() => page.evaluate(() => typeof window.__ytChatOverlay?.getSettings === 'function'))
      .toBe(true);
  });
});
