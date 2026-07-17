// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * @fileoverview E2E tests: Danmaku appearance on mock chat messages.
 *
 * Verifies that when the overlay initializes on a mock YouTube page,
 * the container and canvas elements are present and the app's debug
 * handle exposes settings correctly.
 */

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  setupOverlayPage,
  OVERLAY_ID,
  getSettings,
} from '../fixtures/test-utils';

const DIST_DIR = resolve(process.cwd(), '../dist');
const USERSCRIPT_PATH = resolve(DIST_DIR, 'yt-live-chat-overlay.dev.user.js');

test.describe('Danmaku Rendering', () => {
  test.beforeAll(() => {
    if (!existsSync(USERSCRIPT_PATH)) {
      throw new Error(
        `Userscript bundle not found at ${USERSCRIPT_PATH}. Run 'pnpm build:dev' first.`,
      );
    }
  });

  test('overlay container is present in DOM after initialization', async ({ page }) => {
    await setupOverlayPage(page);

    const overlay = page.locator(`#${OVERLAY_ID}`);
    await expect(overlay).toBeAttached({ timeout: 5000 });
  });

  test('canvas element exists inside overlay container', async ({ page }) => {
    await setupOverlayPage(page);

    const canvas = page.locator(`#${OVERLAY_ID} canvas`);
    await expect(canvas).toBeAttached({ timeout: 5000 });

    // Canvas should have a non-zero size
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  });

  test('debug handle is accessible after setup', async ({ page }) => {
    await setupOverlayPage(page);

    const hasHandle = await page.evaluate(() => {
      const w = (window as unknown) as Record<string, unknown>;
      const handle = w.__ytChatOverlay;
      return typeof handle === 'object' && handle !== null;
    });
    expect(hasHandle).toBe(true);
  });

  test('debug handle getSettings returns valid settings object', async ({ page }) => {
    await setupOverlayPage(page);

    const settings = await getSettings(page);
    expect(settings).toBeTruthy();
    expect(typeof settings.enabled).toBe('boolean');
    expect(typeof settings.fontSize).toBe('number');
    expect(typeof settings.opacity).toBe('number');
    expect(typeof settings.speedPxPerSec).toBe('number');
    expect(typeof settings.colors).toBe('object');
  });

  test('overlay does not throw errors during initialization', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await setupOverlayPage(page);

    // Filter for overlay-related errors only
    const overlayErrors = errors.filter((e) =>
      e.toLowerCase().includes('yt-live-chat-overlay')
      || e.toLowerCase().includes('overlay')
      || e.toLowerCase().includes('danmaku')
    );

    expect(overlayErrors).toHaveLength(0);
  });

  test('overlay container has proper aria attributes', async ({ page }) => {
    await setupOverlayPage(page);

    const overlay = page.locator(`#${OVERLAY_ID}`);
    await expect(overlay).toBeAttached({ timeout: 5000 });

    // The overlay container gets role="region" and aria-label in overlay.ts
    const role = await overlay.getAttribute('role');
    expect(role).toBe('region');

    // Check aria-live region exists inside overlay
    const liveRegion = page.locator(`#${OVERLAY_ID}-status`);
    const exists = (await liveRegion.count()) > 0;
    // The status region may not be created on every setup, but check if it exists
    if (exists) {
      const ariaLive = await liveRegion.getAttribute('aria-live');
      expect(ariaLive).toBe('polite');
    }
  });
});
