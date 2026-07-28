// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * @fileoverview E2E tests for the Chrome extension deployment path.
 *
 * These tests load the built Chrome extension (dist-extension/) and verify
 * that the content script injects the page script on a real youtube.com page,
 * exercising the actual extension manifest + service worker + content
 * script + MAIN-world bridge pipeline.
 *
 * Note: Extension E2E requires a distinct browser context because the
 * extension must be loaded at browser launch time. The standard E2E
 * fixture (setupOverlayPage) tests the userscript path with mocked
 * chrome.* APIs — this file tests the real extension path.
 */

import { chromium, test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXTENSION_PATH = resolve(process.cwd(), 'dist-extension');

test.describe('Chrome Extension', () => {
  test('extension directory exists and contains manifest.json', () => {
    test.skip(!existsSync(EXTENSION_PATH), `Extension not found at ${EXTENSION_PATH}. Run pnpm build:extension first.`);

    const manifestPath = resolve(EXTENSION_PATH, 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.content_scripts).toBeDefined();
  });

  test('extension injects page script on youtube.com', async () => {
    test.skip(!existsSync(EXTENSION_PATH), `Extension not found at ${EXTENSION_PATH}. Run pnpm build:extension first.`);

    // Extensions are loaded at browser launch time. A normal browser fixture
    // context cannot load an unpacked MV3 extension after the browser starts.
    const context = await chromium.launchPersistentContext('', {
      // The default Playwright headless shell does not support extensions.
      // The full Chromium channel does, including under xvfb in CI.
      channel: 'chromium',
      viewport: { width: 1280, height: 720 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--no-sandbox',
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });

    try {
      const page = await context.newPage();
      await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });

      await expect.poll(
        () => page.evaluate(() => typeof window.__ytExtensionBridge === 'object'),
        { timeout: 15_000 },
      ).toBe(true);
      const bridge = await page.evaluate(() => window.__ytExtensionBridge);
      expect(bridge).toMatchObject({
        workerSupported: true,
        storageType: 'chrome.storage.local',
      });
      expect(bridge?.workerUrl).toMatch(/^chrome-extension:\/\/.*\/workers\/renderer\.js$/);
      await expect(page.locator('script[src^="chrome-extension://"][src$="/page-script.js"]'))
        .toHaveCount(1);
    } finally {
      await context.close();
    }
  });
});
