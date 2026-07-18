// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * @fileoverview E2E tests: Renderer lifecycle and canvas state verification.
 *
 * Verifies that the overlay renderer initializes in a valid state,
 * responds to settings changes, and maintains canvas integrity
 * across the render loop cycle.
 */

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import {
  setupOverlayPage,
  applySettings,
  getSettings,
  OVERLAY_ID,
  USERSCRIPT_PATH,
} from '../fixtures/test-utils';

test.describe('Renderer Lifecycle', () => {
  test.beforeAll(() => {
    if (!existsSync(USERSCRIPT_PATH)) {
      throw new Error(
        `Userscript bundle not found at ${USERSCRIPT_PATH}. Run 'pnpm build:dev' first.`,
      );
    }
  });

  test('canvas has valid dimensions after initialization', async ({ page }) => {
    await setupOverlayPage(page);

    const canvas = page.locator(`#${OVERLAY_ID} canvas`);
    await expect(canvas).toBeAttached({ timeout: 5000 });

    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);

    // Verify canvas is not zero-sized or negative
    const dims = await page.evaluate(() => {
      const c = document.querySelector('#yt-live-chat-overlay canvas') as HTMLCanvasElement | null;
      if (!c) return null;
      return { width: c.width, height: c.height };
    });
    expect(dims).not.toBeNull();
    expect(dims!.width).toBeGreaterThan(100);
    expect(dims!.height).toBeGreaterThan(100);
  });

  test('renderer restart restores canvas', async ({ page }) => {
    await setupOverlayPage(page);

    // Verify initial canvas
    const canvas = page.locator(`#${OVERLAY_ID} canvas`);
    await expect(canvas).toBeAttached({ timeout: 5000 });

    // Restart the overlay
    await page.evaluate(() => {
      const w = (window as unknown) as Record<string, unknown>;
      const handle = w.__ytChatOverlay as { restartRuntime?: () => Promise<void> } | undefined;
      return handle?.restartRuntime?.();
    });
    await page.waitForTimeout(3000);

    // Canvas should still exist after restart
    await expect(canvas).toBeAttached({ timeout: 5000 });
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
  });

  test('settings change does not crash renderer', async ({ page }) => {
    await setupOverlayPage(page);

    const canvas = page.locator(`#${OVERLAY_ID} canvas`);
    await expect(canvas).toBeAttached({ timeout: 5000 });

    // Apply aggressive settings changes
    await applySettings(page, { fontSize: 48 });
    await expect(canvas).toBeAttached({ timeout: 3000 });

    await applySettings(page, { fontSize: 16, opacity: 0.5 });
    await expect(canvas).toBeAttached({ timeout: 3000 });

    await applySettings(page, { speedPxPerSec: 100, safeTop: 0.2 });
    await expect(canvas).toBeAttached({ timeout: 3000 });

    // Verify settings were applied
    const settings = await getSettings(page);
    expect(settings.fontSize).toBe(16);
    expect(settings.opacity).toBe(0.5);
    expect(settings.speedPxPerSec).toBe(100);
  });

  test('stop is one-shot — start after stop is a no-op', async ({ page }) => {
    await setupOverlayPage(page);

    // Step 1: overlay starts normally, canvas is present
    const canvas = page.locator(`#${OVERLAY_ID} canvas`);
    await expect(canvas).toBeAttached({ timeout: 5000 });

    // Step 2: stop the overlay
    await page.evaluate(() => {
      const w = (window as unknown) as Record<string, unknown>;
      const handle = w.__ytChatOverlay as { stop?: () => Promise<void> } | undefined;
      return handle?.stop?.();
    });
    await page.waitForTimeout(1000);

    // Step 3: canvas should be gone after stop
    await expect(canvas).not.toBeAttached({ timeout: 3000 });

    // Step 4: start() after stop() is a no-op — runtime was destroyed
    await page.evaluate(() => {
      const w = (window as unknown) as Record<string, unknown>;
      const handle = w.__ytChatOverlay as { start?: () => Promise<void> } | undefined;
      return handle?.start?.();
    });
    await page.waitForTimeout(2000);

    // Canvas should NOT reappear — destroyed instances cannot be reused
    await expect(canvas).not.toBeAttached({ timeout: 3000 });
  });

  test('renderer handles min and max settings extremes', async ({ page }) => {
    await setupOverlayPage(page);

    const canvas = page.locator(`#${OVERLAY_ID} canvas`);

    // Minimum values
    await applySettings(page, {
      fontSize: 10,
      opacity: 0.05,
      speedPxPerSec: 50,
      laneSpacing: 0,
      safeTop: 0,
      safeBottom: 0,
      scrollDurationMinMs: 1000,
      scrollDurationMaxMs: 2000,
    });
    await expect(canvas).toBeAttached({ timeout: 3000 });

    // Maximum values
    await applySettings(page, {
      fontSize: 120,
      opacity: 1,
      speedPxPerSec: 1000,
      laneSpacing: 50,
      safeTop: 0.5,
      safeBottom: 0.5,
      scrollDurationMinMs: 30000,
      scrollDurationMaxMs: 60000,
    });
    await expect(canvas).toBeAttached({ timeout: 3000 });
  });

  test('rapid mode switching does not crash renderer', async ({ page }) => {
    await setupOverlayPage(page);

    const canvas = page.locator(`#${OVERLAY_ID} canvas`);

    const modes = ['scroll', 'reverse', 'top', 'bottom'];
    for (let i = 0; i < 3; i++) {
      for (const mode of modes) {
        await applySettings(page, { danmakuMode: mode });
        await expect(canvas).toBeAttached({ timeout: 3000 });
      }
    }
  });

  test('rapid settings toggling does not crash renderer', async ({ page }) => {
    await setupOverlayPage(page);

    const canvas = page.locator(`#${OVERLAY_ID} canvas`);

    // Toggle depth layers on/off rapidly
    for (let i = 0; i < 4; i++) {
      await applySettings(page, { depthLayersEnabled: i % 2 === 0 });
      await expect(canvas).toBeAttached({ timeout: 2000 });
    }

    // Toggle outline on/off rapidly
    for (let i = 0; i < 4; i++) {
      await applySettings(page, {
        outline: { enabled: i % 2 === 0, widthPx: 2, opacity: 0.7 },
      });
      await expect(canvas).toBeAttached({ timeout: 2000 });
    }

    // Toggle motion blur on/off rapidly
    for (let i = 0; i < 4; i++) {
      await applySettings(page, { motionBlurEnabled: i % 2 === 0 });
      await expect(canvas).toBeAttached({ timeout: 2000 });
    }
  });

  test('overlay survives disable/re-enable via settings', async ({ page }) => {
    await setupOverlayPage(page);

    const canvas = page.locator(`#${OVERLAY_ID} canvas`);
    await expect(canvas).toBeAttached({ timeout: 5000 });

    // Disable
    await applySettings(page, { enabled: false });
    await page.waitForTimeout(1000);

    // Re-enable
    await applySettings(page, { enabled: true });
    await page.waitForTimeout(2000);

    // Canvas should be recreated
    await expect(canvas).toBeAttached({ timeout: 5000 });
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
  });
});
