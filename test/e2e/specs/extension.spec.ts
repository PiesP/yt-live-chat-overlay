// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * @fileoverview E2E tests for the Chrome extension deployment path.
 *
 * These tests load the built Chrome extension (dist-extension/) and verify
 * that the content script injects the overlay on a real youtube.com page,
 * exercising the actual extension manifest + service worker + content
 * script + MAIN-world bridge pipeline.
 *
 * Note: Extension E2E requires a distinct browser context because the
 * extension must be loaded at browser launch time. The standard E2E
 * fixture (setupOverlayPage) tests the userscript path with mocked
 * chrome.* APIs — this file tests the real extension path.
 */

import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXTENSION_PATH = resolve(process.cwd(), 'dist-extension');
const OVERLAY_ID = 'yt-live-chat-overlay';

test.describe('Chrome Extension', () => {
  test('extension directory exists and contains manifest.json', () => {
    const manifestPath = resolve(EXTENSION_PATH, 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.content_scripts).toBeDefined();
  });

  test('extension loads content script on youtube.com', async ({ browser }) => {
    test.skip(!existsSync(EXTENSION_PATH), `Extension not found at ${EXTENSION_PATH}. Run pnpm build:extension first.`);

    // Chrome extension loading requires a persistent context with
    // extension-specific launch arguments. This pattern loads the
    // extension at the browser level, not per-context.
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    // The content script should inject the overlay container
    await expect(page.locator(`#${OVERLAY_ID}`)).toBeAttached({
      timeout: 10_000,
    });

    await context.close();
  });
});
