// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 PiesP

import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: resolve(import.meta.dirname, 'specs'),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: true,
  // Keep local runs deterministic while allowing the isolated CI fixtures to
  // share the browser workload. Each test owns its own page and mock storage.
  workers: process.env.CI ? 2 : 1,
  reporter: [['list']],
  use: {
    baseURL: 'https://www.youtube.com',
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /firefox-userscript-smoke\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          slowMo: 0,
          args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--no-sandbox',
          ],
        },
      },
    },
    {
      // Firefox extensions cannot be loaded through Playwright's persistent
      // extension fixture. Exercise the shipped userscript bundle instead so
      // Gecko still covers startup, DOM ingestion, and Canvas rendering.
      name: 'firefox-userscript',
      testMatch: /firefox-userscript-smoke\.spec\.ts/,
      use: {
        ...devices['Desktop Firefox'],
      },
    },
  ],
});
