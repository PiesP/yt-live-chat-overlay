// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 PiesP

/**
 * @fileoverview E2E tests for YT Live Chat Overlay userscript.
 *
 * Tests overlay initialization on YouTube pages by:
 * 1. Navigating to YouTube
 * 2. Injecting the platform fixture
 * 3. Injecting the built userscript
 * 4. Verifying overlay initialization and state
 */

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import {
  USERSCRIPT_PATH,
  setupOverlayPage,
} from '../fixtures/test-utils';

test.describe('YT Live Chat Overlay E2E', () => {
  test.beforeAll(() => {
    if (!existsSync(USERSCRIPT_PATH)) {
      throw new Error(
        `Dev userscript bundle not found at ${USERSCRIPT_PATH}. Run 'pnpm build:dev' first.`
      );
    }
  });

  test('userscript injects without errors on YouTube homepage', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await setupOverlayPage(page);

    const overlayErrors = errors.filter((e) =>
      e.includes('ytco') || e.includes('overlay') || e.includes('chat-overlay')
    );
    expect(overlayErrors).toHaveLength(0);
  });

  test('userscript does not crash on YouTube navigation', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await setupOverlayPage(page);
    await page.goto('https://www.youtube.com/feed/trending', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#yt-live-chat-overlay')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__ytChatOverlay)).toBeUndefined();

    const overlayErrors = errors.filter((e) =>
      e.includes('ytco') || e.includes('overlay') || e.includes('chat-overlay')
    );
    expect(overlayErrors).toHaveLength(0);
  });

});
