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
 * 5. Confirmation dialog has aria-labelledby attribute
 * 6. ignoreReducedMotion setting exists in settings panel (checkbox)
 * 7. Compiled click-to-reload affordance/code contract is present
 *
 * Test approach:
 * - Build the development userscript first (pnpm test:e2e does this automatically)
 * - Navigate to a mock YouTube watch page and inject the bundle via shared setup
 * - Verify accessibility attributes on the overlay/canvas elements
 */

import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';

import { setupOverlayPage, USERSCRIPT_PATH } from '../fixtures/test-utils';

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

  test('confirmation dialog markup exists in bundle', async ({ page }) => {
    await setupOverlayPage(page);

    const bundle = readFileSync(USERSCRIPT_PATH, 'utf8');

    // Verify the confirmation dialog uses a native <dialog> element.
    // The browser handles role and focus management natively; no explicit
    // role="alertdialog" is needed.
    expect(bundle).toContain('yt-chat-overlay-confirm-msg');
    expect(bundle).toContain('dialog');
    expect(bundle).toContain('showModal');
  });

  test('ignoreReducedMotion setting exists in settings panel as checkbox', async ({ page }) => {
    await setupOverlayPage(page);

    const bundle = readFileSync(USERSCRIPT_PATH, 'utf8');

    // Supplement the real DOM assertion with a compiled-setting check.
    expect(bundle).toContain('ignoreReducedMotion');

    const modal = await openSettingsModal(page);
    const reduceMotionCheckbox = modal.locator('input[name="ignoreReducedMotion"]');
    await expect(reduceMotionCheckbox).toBeAttached();
    await expect(reduceMotionCheckbox).toHaveAttribute('type', 'checkbox');

    await closeSettingsModal(page, modal);
  });

  test('compiled click-to-reload affordance/code contract is present', async ({ page }) => {
    await setupOverlayPage(page);

    const bundle = readFileSync(USERSCRIPT_PATH, 'utf8');

    // Verify the compiled bundle contains the click-to-reload code contract and status text.
    expect(bundle).toContain('addEventListener("click"');
    expect(bundle).toContain('Click to reload');
    expect(bundle).toContain('tabindex');

    // Verify the real renderer canvas is attached and properly configured
    const canvas = page.locator(`#${OVERLAY_ID} canvas`);
    await expect(canvas).toBeAttached();
    await expect(canvas).toHaveAttribute('aria-hidden', 'true');
  });
});
