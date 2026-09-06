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
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'https://www.youtube.com',
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
    video: process.env.CI ? 'on-first-retry' : 'off',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /firefox-(?:userscript-smoke|extension)\.spec\.ts/,
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
      // Exercise the userscript separately from the installed-extension lane.
      name: 'firefox-userscript',
      testMatch: /firefox-userscript-smoke\.spec\.ts/,
      use: {
        ...devices['Desktop Firefox'],
      },
    },
    {
      // The fixture starts the pinned Firefox binary through its native BiDi
      // endpoint so the packaged extension runs in a real extension context.
      name: 'firefox-extension',
      testMatch: /firefox-extension\.spec\.ts/,
      use: {
        ...devices['Desktop Firefox'],
      },
    },
  ],
});
