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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MOCK_HTML } from '../fixtures/test-utils';

const EXTENSION_PATH = resolve(process.cwd(), 'dist-extension');

test.describe('Chrome Extension', () => {
  test.beforeAll(() => {
    if (!existsSync(resolve(EXTENSION_PATH, 'manifest.json'))) {
      throw new Error(`Extension not found at ${EXTENSION_PATH}. Run pnpm test:e2e.`);
    }
  });

  test('extension directory exists and contains manifest.json', () => {
    const manifestPath = resolve(EXTENSION_PATH, 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.content_scripts).toBeDefined();
  });

  test('extension injects page script on youtube.com', async () => {
    // Extensions are loaded at browser launch time. A normal browser fixture
    // context cannot load an unpacked MV3 extension after the browser starts.
    const userDataDir = mkdtempSync(join(tmpdir(), 'yt-overlay-extension-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
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
      await context.route('https://www.youtube.com/**', async (route) => {
        if (route.request().resourceType() === 'document') {
          await route.fulfill({ status: 200, contentType: 'text/html', body: MOCK_HTML });
        } else {
          await route.abort('blockedbyclient');
        }
      });

      const pageErrors: string[] = [];
      const page = await context.newPage();
      page.on('pageerror', (error) => pageErrors.push(error.message));
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
      await expect(page.locator('#yt-live-chat-overlay')).toBeAttached();
      await expect(page.locator('#yt-live-chat-overlay canvas')).toBeAttached();
      await expect(page.locator('#yt-chat-overlay-settings-button')).toBeVisible();
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
