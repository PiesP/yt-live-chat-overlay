// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, test } from '@playwright/test';
import { applySettings, OVERLAY_ID, setupOverlayPage } from '../fixtures/test-utils';

test('Firefox userscript ingests and renders a live-chat message', async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });

  await setupOverlayPage(page, { platform: 'userscript' });
  await applySettings(page, {
    allowShortTextMessages: true,
    danmakuMode: 'top',
    showDebugOverlay: true,
  });
  const debugCounters = page.locator('#yt-chat-overlay-debug > div').first();
  await expect(debugCounters).toHaveText('Rcvd: 0 | Rndr: 0');

  await page.evaluate(() => {
    const items = document.querySelector('yt-live-chat-item-list-renderer #items');
    if (!items) throw new Error('Mock live chat items container is missing');

    const renderer = document.createElement('yt-live-chat-text-message-renderer');
    renderer.id = 'firefox-userscript-message';
    const author = document.createElement('span');
    author.id = 'author-name';
    author.textContent = 'Firefox Author';
    const message = document.createElement('span');
    message.id = 'message';
    message.textContent = 'Firefox userscript rendering smoke';
    renderer.append(author, message);
    items.append(renderer);
  });

  await expect(page.locator(`#${OVERLAY_ID} canvas`)).toBeAttached();
  await expect(debugCounters).toHaveText('Rcvd: 1 | Rndr: 1');
  expect(runtimeErrors).toEqual([]);
});
