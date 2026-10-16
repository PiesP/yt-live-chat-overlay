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

import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  DEFAULT_SETTINGS,
  injectUserscript,
  installYTMock,
  MOCK_HTML,
  MOCK_WATCH_URL,
  setupOverlayPage,
  USERSCRIPT_PATH,
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

    const overlayErrors = errors.filter(
      (e) => e.includes('ytco') || e.includes('overlay') || e.includes('chat-overlay')
    );
    expect(overlayErrors).toHaveLength(0);
  });

  test('userscript does not crash on YouTube navigation', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await setupOverlayPage(page);
    await expect(page.locator('#yt-live-chat-overlay canvas')).toBeAttached();
    await page.goto('https://www.youtube.com/feed/trending', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#yt-live-chat-overlay')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__ytChatOverlay)).toBeUndefined();

    const overlayErrors = errors.filter(
      (e) => e.includes('ytco') || e.includes('overlay') || e.includes('chat-overlay')
    );
    expect(overlayErrors).toHaveLength(0);
  });

  for (const mode of ['style-reveal', 'style-late', 'insertion'] as const) {
    test(`built userscript attaches after delayed player ${mode}`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      const html =
        mode !== 'insertion'
          ? MOCK_HTML.replace('style="width:800px', 'style="display:none;width:800px')
          : MOCK_HTML.replace(/<div id="movie_player"[\s\S]*?<\/div>\s*<\/div>/, '</div>');
      await page.route('https://www.youtube.com/**', async (route) => {
        if (route.request().resourceType() === 'document') {
          await route.fulfill({ status: 200, contentType: 'text/html', body: html });
        } else {
          await route.abort('blockedbyclient');
        }
      });
      await page.addInitScript(() => {
        const NativeObserver = window.MutationObserver;
        const state = { observed: 0, revealedAt: 0, attachedAt: 0, unrelatedMutations: 0 };
        (window as unknown as { __playerLookupFixture: typeof state }).__playerLookupFixture =
          state;
        window.MutationObserver = class extends NativeObserver {
          override observe(target: Node, options?: MutationObserverInit): void {
            if (target === document.body && options?.childList && options.subtree) state.observed++;
            super.observe(target, options);
          }
        };
      });
      await page.addInitScript(installYTMock, { defaults: DEFAULT_SETTINGS });
      await injectUserscript(page);
      await page.goto(MOCK_WATCH_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => {
        const state = (window as unknown as { __playerLookupFixture?: { observed: number } })
          .__playerLookupFixture;
        return (state?.observed ?? 0) > 0;
      });
      // Let startup-owned DOM writes settle before isolating the reveal window.
      await page.waitForTimeout(300);
      if (mode === 'style-late') await page.waitForTimeout(7500);
      await page.evaluate((kind) => {
        const state = (
          window as unknown as {
            __playerLookupFixture: {
              revealedAt: number;
              attachedAt: number;
              unrelatedMutations: number;
            };
          }
        ).__playerLookupFixture;
        const player =
          document.querySelector<HTMLElement>('#movie_player') ?? document.createElement('div');
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            const attached = [...record.addedNodes].some(
              (node) =>
                node instanceof Element &&
                (node.id === 'yt-live-chat-overlay' ||
                  node.id.startsWith('yt-chat-overlay-settings-'))
            );
            if (attached) {
              state.attachedAt = performance.now();
              observer.disconnect();
              return;
            }
            if (record.type === 'childList') state.unrelatedMutations++;
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        state.revealedAt = performance.now();
        if (kind !== 'insertion') player.style.display = 'block';
        else {
          player.id = 'movie_player';
          player.className = 'html5-video-player';
          player.style.cssText = 'width:800px;height:450px;position:relative';
          document.querySelector('#player-container')?.append(player);
        }
      }, mode);
      await page.waitForFunction(() => {
        const state = (window as unknown as { __playerLookupFixture?: { attachedAt: number } })
          .__playerLookupFixture;
        return (state?.attachedAt ?? 0) > 0;
      });
      const observation = await page.evaluate(
        () =>
          (
            window as unknown as {
              __playerLookupFixture: {
                observed: number;
                revealedAt: number;
                attachedAt: number;
                unrelatedMutations: number;
              };
            }
          ).__playerLookupFixture
      );
      await test.info().attach('player-lookup-observation', {
        body: JSON.stringify({ mode, ...observation }),
        contentType: 'application/json',
      });
      expect(observation.observed).toBeGreaterThan(0);
      expect(observation.attachedAt - observation.revealedAt).toBeLessThan(2000);
      if (mode !== 'insertion') expect(observation.unrelatedMutations).toBe(0);
      await expect(page.locator('#yt-chat-overlay-settings-button')).toBeAttached();
      await page.goto('https://www.youtube.com/feed/trending', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#yt-live-chat-overlay')).toHaveCount(0);
      expect(pageErrors).toEqual([]);
    });
  }

  test('SPA cancellation prevents attachment from a later style reveal', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const hidden = MOCK_HTML.replace('style="width:800px', 'style="display:none;width:800px');
    await page.route('https://www.youtube.com/**', async (route) => {
      if (route.request().resourceType() === 'document') {
        await route.fulfill({ status: 200, contentType: 'text/html', body: hidden });
      } else {
        await route.abort('blockedbyclient');
      }
    });
    await page.addInitScript(installYTMock, { defaults: DEFAULT_SETTINGS });
    await injectUserscript(page);
    await page.goto(MOCK_WATCH_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#yt-live-chat-overlay')).toHaveCount(0);
    await page.evaluate(() => {
      history.pushState({}, '', '/feed/trending');
      window.dispatchEvent(new Event('yt-navigate-finish'));
    });
    await page.waitForTimeout(100);
    await page.locator('#movie_player').evaluate((player) => {
      (player as HTMLElement).style.display = 'block';
    });
    await page.waitForTimeout(1200);
    await expect(page.locator('#yt-live-chat-overlay')).toHaveCount(0);
    await expect(page.locator('#yt-chat-overlay-settings-button')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});
