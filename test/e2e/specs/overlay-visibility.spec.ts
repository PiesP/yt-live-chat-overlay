// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * @fileoverview E2E tests: Overlay visibility toggle.
 *
 * Verifies that toggling the `enabled` setting is reflected in the
 * settings object and the GM storage.
 */

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import {
  setupOverlayPage,
  OVERLAY_ID,
  BUTTON_ID,
  getSettings,
  applySettings,
  readGmStorage,
  DIST_DIR,
  USERSCRIPT_PATH,
} from '../fixtures/test-utils';


test.describe('Overlay Visibility Toggle', () => {
  test.beforeAll(() => {
    if (!existsSync(USERSCRIPT_PATH)) {
      throw new Error(
        `Userscript bundle not found at ${USERSCRIPT_PATH}. Run 'pnpm build:dev' first.`,
      );
    }
  });

  test('overlay is initialized with enabled=true by default', async ({ page }) => {
    await setupOverlayPage(page);

    const settings = await getSettings(page);
    expect(settings.enabled).toBe(true);

    // The overlay container should be in the DOM
    const overlay = page.locator(`#${OVERLAY_ID}`);
    await expect(overlay).toBeAttached({ timeout: 5000 });
  });

  test('settings button is visible when overlay is enabled', async ({ page }) => {
    await setupOverlayPage(page);

    const btn = page.locator(`#${BUTTON_ID}`);
    await expect(btn).toBeVisible({ timeout: 10000 });
  });

  test('disabling overlay updates in-memory setting', async ({ page }) => {
    await setupOverlayPage(page);

    await applySettings(page, { enabled: false });

    const settings = await getSettings(page);
    expect(settings.enabled).toBe(false);
  });

  test('disabling overlay writes to GM storage', async ({ page }) => {
    await setupOverlayPage(page);

    await applySettings(page, { enabled: false });

    const raw = await readGmStorage(page);
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.enabled).toBe(false);
  });

  test('re-enabling overlay restores enabled setting', async ({ page }) => {
    await setupOverlayPage(page);

    // Disable
    await applySettings(page, { enabled: false });
    expect((await getSettings(page)).enabled).toBe(false);

    // Re-enable
    await applySettings(page, { enabled: true });
    expect((await getSettings(page)).enabled).toBe(true);
  });

  test('toggling enabled on/off multiple times works correctly', async ({ page }) => {
    await setupOverlayPage(page);

    for (const expected of [false, true, false, true]) {
      await applySettings(page, { enabled: expected });
      const settings = await getSettings(page);
      expect(settings.enabled).toBe(expected);
    }
  });
});
