// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 PiesP

import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST_DIR = resolve(import.meta.dirname, '../../dist');
const EXTENSION_DIR = resolve(import.meta.dirname, '../../../dist-extension');

export default defineConfig({
  testDir: resolve(import.meta.dirname, 'specs'),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'https://www.youtube.com',
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      slowMo: 300,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--no-sandbox',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
  metadata: {
    distDir: DIST_DIR,
    extensionDir: EXTENSION_DIR,
    userscriptPath: resolve(DIST_DIR, 'yt-live-chat-overlay.user.js'),
  },
});
