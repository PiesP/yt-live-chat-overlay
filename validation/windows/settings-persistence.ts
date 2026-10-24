// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { join } from 'node:path';

import type { Browser } from '@playwright/test';

const SETTINGS_KEY = 'yt-live-chat-overlay-settings';
const WATCH_URL = 'https://www.youtube.com/watch?v=windowsAcceptance';

declare global {
  interface Window {
    __ytAcceptanceDenySettings?: boolean;
    __ytAcceptanceDeniedWrites?: number;
    __ytAcceptanceDeniedWriteStacks?: string[];
  }
}

/** Bounded built-userscript fixture selected by a bundle-hashed local input. */
export async function runSettingsPersistenceFixture({
  browser,
  output,
  userscript,
  watchHtml,
}: {
  browser: Browser;
  output: string;
  userscript: string;
  watchHtml: string;
}) {
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 720 },
  });
  const pageErrors: string[] = [];
  try {
    await context.addInitScript((storageKey) => {
      (window as Window & { unsafeWindow?: Window }).unsafeWindow = window;
      window.__ytAcceptanceDenySettings = false;
      window.__ytAcceptanceDeniedWrites = 0;
      window.__ytAcceptanceDeniedWriteStacks = [];
      if (localStorage.getItem(storageKey) === null) {
        localStorage.setItem(storageKey, JSON.stringify({ fontSize: 32, language: 'en' }));
      }
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string): void {
        if (key === storageKey && window.__ytAcceptanceDenySettings) {
          window.__ytAcceptanceDeniedWrites = (window.__ytAcceptanceDeniedWrites ?? 0) + 1;
          if ((window.__ytAcceptanceDeniedWriteStacks?.length ?? 0) < 3) {
            window.__ytAcceptanceDeniedWriteStacks?.push((new Error().stack ?? '').slice(0, 1200));
          }
          throw new DOMException('Controlled settings write denial', 'QuotaExceededError');
        }
        original.call(this, key, value);
      };
    }, SETTINGS_KEY);
    await context.addInitScript({ content: userscript });
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'www.youtube.com' && route.request().resourceType() === 'document') {
        await route.fulfill({ status: 200, contentType: 'text/html', body: watchHtml });
      } else if (url.hostname === 'www.youtube.com' && url.pathname.includes('/live_chat/')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          json: {
            continuationContents: { liveChatContinuation: { actions: [], continuations: [] } },
          },
        });
      } else {
        await route.fulfill({ status: 204 });
      }
    });
    await page.goto(WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('#yt-live-chat-overlay').waitFor({ state: 'attached', timeout: 15_000 });
    const before = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
    assert(before, 'The fixture settings seed was not installed');

    await page.locator('#movie_player').hover();
    await page.locator('#yt-chat-overlay-settings-button').click();
    const modal = page.locator('#yt-chat-overlay-settings-backdrop');
    await modal.locator('input[name="fontSize"]').fill('44');
    await page.waitForFunction(() => window.__ytChatOverlay?.getSettings?.().fontSize === 44);
    await page.evaluate(() => {
      window.__ytAcceptanceDenySettings = true;
    });
    await page.keyboard.press('Escape');
    const notice = page.locator('.yt-chat-overlay-settings-persistence-notice');
    await notice.getByRole('button', { name: 'Retry save' }).waitFor({ state: 'visible' });
    assert.match((await notice.textContent()) ?? '', /were not saved/u);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY), before);
    const deniedWrites = await page.evaluate(() => ({
      count: window.__ytAcceptanceDeniedWrites,
      stacks: window.__ytAcceptanceDeniedWriteStacks,
    }));
    assert.equal(
      deniedWrites.count,
      1,
      `Unexpected settings write attempts: ${JSON.stringify(deniedWrites)}`
    );
    assert.equal(await page.evaluate(() => window.__ytChatOverlay?.getSettings?.().fontSize), 44);
    await page.screenshot({ path: join(output, 'settings-unsaved.png') });

    await page.evaluate(() => {
      window.__ytAcceptanceDenySettings = false;
    });
    await notice.getByRole('button', { name: 'Retry save' }).click();
    await page.waitForFunction(
      (key) => JSON.parse(localStorage.getItem(key) ?? 'null')?.fontSize === 44,
      SETTINGS_KEY
    );
    await notice.getByText('Settings saved.').waitFor({ state: 'visible' });
    await page.screenshot({ path: join(output, 'settings-saved.png') });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#yt-live-chat-overlay').waitFor({ state: 'attached', timeout: 15_000 });
    await page.waitForFunction(() => window.__ytChatOverlay?.getSettings?.().fontSize === 44);
    assert.deepEqual(pageErrors, [], `Page errors: ${pageErrors.join(' | ')}`);
    return {
      checks: {
        installedApplicationDelivery: false,
        sustainedViewingLifecycle: false,
        builtUserscriptFixture: true,
        previewBeforeClose: true,
        denialVisibleAfterClose: true,
        oldStoredValuePreserved: true,
        oneDeniedWrite: true,
        retryPersisted: true,
        reloadReadPersisted: true,
        pageErrors: 0,
      },
      observations: {
        browserVersion: browser.version(),
        deniedWrites: 1,
        beforeFontSize: JSON.parse(before).fontSize,
        afterFontSize: 44,
        screenshots: ['settings-unsaved.png', 'settings-saved.png'],
      },
    };
  } finally {
    await context.close();
  }
}
