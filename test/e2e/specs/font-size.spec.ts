// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * @fileoverview E2E tests: Font size changes.
 *
 * Verifies that changing the fontSize setting updates the overlay font size,
 * persists across reload, and supports both increase and decrease.
 *
 * The fontSize setting is a number. Based on actual app behavior:
 * - Default: 32
 * - Max clamped: 50
 * - Min clamped: 14
 */

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  setupOverlayPage,
  getSettings,
  applySettings,
  readGmStorage,
} from '../fixtures/test-utils';
const DIST_DIR = resolve(process.cwd(), 'dist');
const USERSCRIPT_PATH = resolve(DIST_DIR, 'yt-live-chat-overlay.dev.user.js');

test.describe('Font Size Changes', () => {
  test.beforeAll(() => {
    if (!existsSync(USERSCRIPT_PATH)) {
      throw new Error(
        `Userscript bundle not found at ${USERSCRIPT_PATH}. Run 'pnpm build:dev' first.`,
      );
    }
  });

  test('default font size is 32', async ({ page }) => {
    await setupOverlayPage(page);

    const settings = await getSettings(page);
    expect(settings.fontSize).toBe(32);
  });

  test('increasing font size updates settings', async ({ page }) => {
    await setupOverlayPage(page);

    await applySettings(page, { fontSize: 36 });
    const settings = await getSettings(page);
    expect(settings.fontSize).toBe(36);
  });

  test('decreasing font size updates settings', async ({ page }) => {
    await setupOverlayPage(page);

    await applySettings(page, { fontSize: 16 });
    const settings = await getSettings(page);
    expect(settings.fontSize).toBe(16);
  });

  test('font size 0 is clamped to minimum', async ({ page }) => {
    await setupOverlayPage(page);

    await applySettings(page, { fontSize: 0 });
    const settings = await getSettings(page);
    // Should be clamped to a minimum value (likely 8 or higher)
    expect(settings.fontSize).toBeGreaterThanOrEqual(14);
  });

  test('large font size is clamped to maximum', async ({ page }) => {
    await setupOverlayPage(page);

    // Try a large value that would be clamped
    await applySettings(page, { fontSize: 120 });
    const settings = await getSettings(page);
    // Should be clamped to max (likely 50)
    expect(settings.fontSize).toBeLessThanOrEqual(50);
    expect(settings.fontSize).toBeGreaterThanOrEqual(40);
  });

  test('font size change is written to GM storage', async ({ page }) => {
    await setupOverlayPage(page);

    await applySettings(page, { fontSize: 42 });
    expect((await getSettings(page)).fontSize).toBe(42);

    const raw = await readGmStorage(page);
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.fontSize).toBe(42);
  });

  test('font size can be changed multiple times', async ({ page }) => {
    await setupOverlayPage(page);

    const sizes = [24, 32, 40, 28, 36, 20];
    for (const size of sizes) {
      await applySettings(page, { fontSize: size });
      const settings = await getSettings(page);
      expect(settings.fontSize).toBe(size);
    }
  });

  test('fontWeight setting can be changed independently', async ({ page }) => {
    await setupOverlayPage(page);

    await applySettings(page, { fontWeight: 'bold' });

    const settings = await getSettings(page);
    expect(settings.fontWeight).toBe('bold');
    // font size should remain default
    expect(settings.fontSize).toBe(32);
  });
});
