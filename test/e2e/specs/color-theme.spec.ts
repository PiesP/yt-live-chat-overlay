// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * @fileoverview E2E tests: Color theme switching.
 *
 * Verifies that changing color settings for different author types (normal,
 * moderator, owner, verified, member) correctly updates the settings
 * and persists across reload.
 *
 * Colors are stored as hex strings like '#FFFFFF' in the settings.
 */

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import {
  setupOverlayPage,
  getSettings,
  applySettings,
  readGmStorage,
  DIST_DIR,
  USERSCRIPT_PATH,
} from '../fixtures/test-utils';

test.describe('Color Theme Switching', () => {
  test.beforeAll(() => {
    if (!existsSync(USERSCRIPT_PATH)) {
      throw new Error(
        `Userscript bundle not found at ${USERSCRIPT_PATH}. Run 'pnpm build:dev' first.`,
      );
    }
  });

  test('default colors are present in settings', async ({ page }) => {
    await setupOverlayPage(page);

    const settings = await getSettings(page);
    const colors = settings.colors as Record<string, string>;

    expect(colors).toBeTruthy();
    expect(colors.normal).toBe('#FFFFFF');
    expect(colors.moderator).toBe('#5E84F1');
    expect(colors.owner).toBe('#FFD600');
    expect(colors.verified).toBe('#AAAAAA');
    expect(colors.member).toBe('#0F9D58');
  });

  test('changing normal author color updates settings', async ({ page }) => {
    await setupOverlayPage(page);

    // Change normal message color to a custom value
    const currentSettings = await getSettings(page);
    const newColors = {
      ...(currentSettings.colors as Record<string, string>),
      normal: '#ffaa00',
    };
    await applySettings(page, { colors: newColors });

    const settings = await getSettings(page);
    const colors = settings.colors as Record<string, string>;
    expect(colors.normal).toBe('#ffaa00');
  });

  test('changing all author colors persists', async ({ page }) => {
    await setupOverlayPage(page);

    // Apply a completely different color palette
    const darkPalette = {
      normal: '#cccccc',
      moderator: '#66ff66',
      owner: '#ff6666',
      verified: '#ff66ff',
      member: '#66ffff',
    };
    await applySettings(page, { colors: darkPalette });

    const settings = await getSettings(page);
    const colors = settings.colors as Record<string, string>;

    expect(colors.normal).toBe('#cccccc');
    expect(colors.moderator).toBe('#66ff66');
    expect(colors.owner).toBe('#ff6666');
    expect(colors.verified).toBe('#ff66ff');
    expect(colors.member).toBe('#66ffff');
  });

  test('color theme is written to GM storage', async ({ page }) => {
    await setupOverlayPage(page);

    const newPalette = {
      normal: '#aaaaaa',
      moderator: '#bbbbbb',
      owner: '#cccccc',
      verified: '#dddddd',
      member: '#eeeeee',
    };
    await applySettings(page, { colors: newPalette });

    // Verify in-memory
    const settings = await getSettings(page);
    const colors = settings.colors as Record<string, string>;
    expect(colors.normal).toBe('#aaaaaa');
    expect(colors.moderator).toBe('#bbbbbb');
    expect(colors.owner).toBe('#cccccc');
    expect(colors.verified).toBe('#dddddd');
    expect(colors.member).toBe('#eeeeee');

    // Verify in GM storage
    const raw = await readGmStorage(page);
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    const storedColors = parsed.colors as Record<string, string>;
    expect(storedColors.normal).toBe('#aaaaaa');
  });

  test('changing single author color does not affect others', async ({ page }) => {
    await setupOverlayPage(page);

    // Get original colors
    const currentSettings = await getSettings(page);
    const originalColors = { ...(currentSettings.colors as Record<string, string>) };

    // Change only the moderator color
    const newColors = { ...originalColors, moderator: '#ff6600' };
    await applySettings(page, { colors: newColors });

    const settings = await getSettings(page);
    const colors = settings.colors as Record<string, string>;

    // Moderator changed
    expect(colors.moderator).toBe('#ff6600');
    // Others unchanged
    expect(colors.normal).toBe(originalColors.normal);
    expect(colors.owner).toBe(originalColors.owner);
    expect(colors.verified).toBe(originalColors.verified);
  });

  test('outline settings are independent of color settings', async ({ page }) => {
    await setupOverlayPage(page);

    // Change outline settings
    await applySettings(page, {
      outline: { enabled: false, widthPx: 1, opacity: 0.5 },
    });

    const settings = await getSettings(page);
    const outline = settings.outline as Record<string, unknown>;
    expect(outline.enabled).toBe(false);
    expect(outline.widthPx).toBe(1);
    expect(outline.opacity).toBe(0.5);

    // Colors should remain at their defaults
    const colors = settings.colors as Record<string, string>;
    expect(colors.normal).toBe('#FFFFFF');
  });
});
