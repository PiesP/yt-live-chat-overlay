// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * @fileoverview E2E tests: Settings persistence.
 *
 * Verifies that overlay settings changes are written to GM storage
 * and can be read back. Tests the storage round-trip mechanism.
 *
 * Note: Cross-reload persistence tests require real persistent storage
 * (not in-memory mocks). The GM storage round-trip tests verify the
 * save/load mechanism works correctly.
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

const DIST_DIR = resolve(process.cwd(), '../dist');
const USERSCRIPT_PATH = resolve(DIST_DIR, 'yt-live-chat-overlay.dev.user.js');

test.describe('Settings Persistence', () => {
  test.beforeAll(() => {
    if (!existsSync(USERSCRIPT_PATH)) {
      throw new Error(
        `Userscript bundle not found at ${USERSCRIPT_PATH}. Run 'pnpm build:dev' first.`,
      );
    }
  });

  test('opacity change is reflected in settings and GM storage', async ({ page }) => {
    await setupOverlayPage(page);

    // Change opacity from default (0.9) to 0.5
    await applySettings(page, { opacity: 0.5 });

    // Verify in-memory
    const settings = await getSettings(page);
    expect(settings.opacity).toBe(0.5);

    // Verify in GM storage
    const raw = await readGmStorage(page);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.opacity).toBe(0.5);
  });

  test('scroll speed change is written to GM storage', async ({ page }) => {
    await setupOverlayPage(page);

    await applySettings(page, { speedPxPerSec: 250 });

    const raw = await readGmStorage(page);
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.speedPxPerSec).toBe(250);
  });

  test('font size change is written to GM storage', async ({ page }) => {
    await setupOverlayPage(page);

    await applySettings(page, { fontSize: 36 });

    const raw = await readGmStorage(page);
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.fontSize).toBe(36);
  });

  test('multiple settings are persisted together', async ({ page }) => {
    await setupOverlayPage(page);

    await applySettings(page, {
      opacity: 0.5,
      speedPxPerSec: 200,
      fontSize: 32,
    });

    const raw = await readGmStorage(page);
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.opacity).toBe(0.5);
    expect(parsed.speedPxPerSec).toBe(200);
    expect(parsed.fontSize).toBe(32);
  });

  test('enabled setting change is written to GM storage', async ({ page }) => {
    await setupOverlayPage(page);

    await applySettings(page, { enabled: false });

    const raw = await readGmStorage(page);
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.enabled).toBe(false);
  });

  test('reset settings restores defaults in memory and storage', async ({ page }) => {
    await setupOverlayPage(page);

    // First change a setting
    await applySettings(page, { opacity: 0.2 });

    // Then reset to defaults
    await page.evaluate(() => {
      const w = (window as unknown) as Record<string, unknown>;
      const handle = w.__ytChatOverlay as { resetSettings?: () => void } | undefined;
      handle?.resetSettings?.();
    });
    await page.waitForTimeout(500);

    // Verify in memory
    const afterReset = await getSettings(page);
    expect(afterReset.opacity).toBe(1);

    // Verify in storage
    const raw = await readGmStorage(page);
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.opacity).toBe(1);
  });

  test('colors change is written to GM storage', async ({ page }) => {
    await setupOverlayPage(page);

    const newColors = {
      normal: '#ffaa00',
      moderator: '#ff6600',
      owner: '#ff0000',
      verified: '#ff00ff',
      member: '#00ffff',
    };
    await applySettings(page, { colors: newColors });

    const raw = await readGmStorage(page);
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    const storedColors = parsed.colors as Record<string, string>;
    expect(storedColors.normal).toBe('#ffaa00');
    expect(storedColors.moderator).toBe('#ff6600');
  });
});
