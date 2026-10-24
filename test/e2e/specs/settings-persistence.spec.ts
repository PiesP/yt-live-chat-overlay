// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * @fileoverview E2E tests: Settings persistence.
 *
 * Verifies that overlay settings changes are written to the active storage backend
 * and can be read back. Tests the storage round-trip mechanism.
 *
 * Note: Cross-reload persistence tests require real persistent storage
 * (not in-memory mocks). The storage round-trip tests verify the
 * save/load mechanism works correctly.
 */

import { existsSync } from 'node:fs';

import { expect, type Page, test } from '@playwright/test';

import {
  applySettings,
  BUTTON_ID,
  DEFAULT_SETTINGS,
  getSettings,
  injectUserscript,
  MOCK_WATCH_URL,
  readStoredSettings,
  SETTINGS_STORAGE_KEY,
  setupMockPageRoute,
  setupOverlayPage,
  USERSCRIPT_PATH,
  waitForStoredSettings,
} from '../fixtures/test-utils';

const CACHE_KEYS = ['emojiCacheMb', 'photoCacheMb', 'stickerCacheMb', 'textCacheMb'] as const;

function installPersistentSettings(init: { settings: string }): void {
  if (localStorage.getItem('yt-live-chat-overlay-settings') === null) {
    localStorage.setItem('yt-live-chat-overlay-settings', init.settings);
  }
}

async function setupPersistentSettingsPage(
  page: Page,
  settings: Record<string, unknown>
): Promise<void> {
  await setupMockPageRoute(page);
  await page.addInitScript(installPersistentSettings, {
    settings: JSON.stringify(settings),
  });
  await injectUserscript(page);
  await page.goto(MOCK_WATCH_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#yt-live-chat-overlay').waitFor({ state: 'attached' });
  await page.waitForFunction(() => {
    const handle = (window as unknown as Record<string, unknown>).__ytChatOverlay;
    return typeof handle === 'object' && handle !== null;
  });
}

async function expectNormalizedCacheSettings(page: Page, unrelatedOpacity: number): Promise<void> {
  await expect
    .poll(async () => {
      const settings = await getSettings(page);
      return {
        cacheValues: CACHE_KEYS.map((key) => settings[key]),
        opacity: settings.opacity,
      };
    })
    .toEqual({ cacheValues: [1, 1, 1, 1], opacity: unrelatedOpacity });
}

async function appendRenderableMessage(page: Page, id: string): Promise<void> {
  await page.evaluate((messageId) => {
    const items = document.querySelector('yt-live-chat-item-list-renderer #items');
    if (!items) throw new Error('Mock live chat items container is missing');
    const renderer = document.createElement('yt-live-chat-text-message-renderer');
    renderer.id = messageId;
    const author = document.createElement('span');
    author.id = 'author-name';
    author.textContent = 'Settings E2E';
    const message = document.createElement('span');
    message.id = 'message';
    message.textContent = 'Cache settings render after startup';
    renderer.append(author, message);
    items.append(renderer);
  }, id);
}

test.describe('Settings Persistence', () => {
  test.beforeAll(() => {
    if (!existsSync(USERSCRIPT_PATH)) {
      throw new Error(
        `Userscript bundle not found at ${USERSCRIPT_PATH}. Run 'pnpm build:dev' first.`
      );
    }
  });

  test('keeps preview usable after a denied write, then retries and reloads the saved value', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((key) => {
      const testWindow = window as Window & { denySettingsWrite?: boolean; deniedWrites?: number };
      testWindow.denySettingsWrite = false;
      testWindow.deniedWrites = 0;
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name: string, value: string): void {
        if (name === key && testWindow.denySettingsWrite) {
          testWindow.deniedWrites = (testWindow.deniedWrites ?? 0) + 1;
          throw new DOMException('Controlled settings denial', 'QuotaExceededError');
        }
        original.call(this, name, value);
      };
    }, SETTINGS_STORAGE_KEY);
    await setupPersistentSettingsPage(page, { ...DEFAULT_SETTINGS, language: 'en', fontSize: 32 });
    const before = await readStoredSettings(page);
    await page.locator('#movie_player').hover();
    await page.locator(`#${BUTTON_ID}`).click();
    const dialog = page.locator('#yt-chat-overlay-settings-backdrop');
    await dialog.locator('input[name="fontSize"]').fill('44');
    await expect.poll(async () => (await getSettings(page)).fontSize).toBe(44);
    await page.evaluate(() => {
      (window as Window & { denySettingsWrite?: boolean }).denySettingsWrite = true;
    });
    await page.keyboard.press('Escape');
    const notice = page.locator('.yt-chat-overlay-settings-persistence-notice');
    await expect(notice).toContainText('were not saved');
    expect((await getSettings(page)).fontSize).toBe(44);
    expect(await readStoredSettings(page)).toBe(before);
    expect(
      await page.evaluate(() => (window as Window & { deniedWrites?: number }).deniedWrites)
    ).toBe(1);

    await page.evaluate(() => {
      (window as Window & { denySettingsWrite?: boolean }).denySettingsWrite = false;
    });
    await notice.getByRole('button', { name: 'Retry save' }).click();
    await expect(notice).toContainText('Settings saved.');
    await waitForStoredSettings(page, { fontSize: 44 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#yt-live-chat-overlay').waitFor({ state: 'attached' });
    await expect.poll(async () => (await getSettings(page)).fontSize).toBe(44);
    expect(errors).toEqual([]);
  });

  test('opacity change is reflected in settings and storage', async ({ page }) => {
    await setupOverlayPage(page);

    // Change opacity from default (0.9) to 0.5
    await applySettings(page, { opacity: 0.5 });

    // Verify in-memory
    const settings = await getSettings(page);
    expect(settings.opacity).toBe(0.5);

    // Verify in the active storage backend
    const raw = await readStoredSettings(page);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.opacity).toBe(0.5);
  });

  test('scroll speed change is written to storage', async ({ page }) => {
    await setupOverlayPage(page);

    await applySettings(page, { speedPxPerSec: 250 });

    const raw = await readStoredSettings(page);
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.speedPxPerSec).toBe(250);
  });

  test('font size change is written to storage', async ({ page }) => {
    await setupOverlayPage(page);

    await applySettings(page, { fontSize: 36 });

    const raw = await readStoredSettings(page);
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.fontSize).toBe(36);
  });

  test('multiple settings are persisted together', async ({ page }) => {
    await setupOverlayPage(page);

    await applySettings(page, {
      opacity: 0.5,
      speedPxPerSec: 200,
      fontSize: 32,
    });

    const raw = await readStoredSettings(page);
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.opacity).toBe(0.5);
    expect(parsed.speedPxPerSec).toBe(200);
    expect(parsed.fontSize).toBe(32);
  });

  test('enabled setting change is written to storage', async ({ page }) => {
    await setupOverlayPage(page);

    await applySettings(page, { enabled: false });

    const raw = await readStoredSettings(page);
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.enabled).toBe(false);
  });

  for (const persistedOverride of [false, true]) {
    test(`preserves the existing reduced-motion override ${persistedOverride} through the settings form`, async ({
      page,
    }) => {
      await setupPersistentSettingsPage(page, {
        ...DEFAULT_SETTINGS,
        language: 'en',
        ignoreReducedMotion: persistedOverride,
      });
      await page.locator('#movie_player').hover();
      await page.locator(`#${BUTTON_ID}`).click();
      const modal = page.locator('#yt-chat-overlay-settings-backdrop');
      await modal.locator('#tab-advanced').click();
      const checkbox = modal.getByRole('checkbox', { name: 'Always animate scrolling comments' });
      await expect(checkbox).toBeChecked({ checked: persistedOverride });
      await expect(modal.locator('.yt-chat-overlay-settings-autosave-hint')).toContainText(
        'saving starts when you close settings'
      );
      await page.keyboard.press('Escape');
      await waitForStoredSettings(page, { ignoreReducedMotion: persistedOverride });

      await page.locator(`#${BUTTON_ID}`).click();
      await expect(checkbox).toBeChecked({ checked: persistedOverride });
      await page.keyboard.press('Escape');
    });
  }

  test('reset settings restores defaults in memory and storage', async ({ page }) => {
    await setupOverlayPage(page);

    // First change a setting
    await applySettings(page, { opacity: 0.5 });

    // Then reset to defaults
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const handle = w.__ytChatOverlay as { resetSettings?: () => void } | undefined;
      handle?.resetSettings?.();
    });
    // Verify in memory
    const afterReset = await getSettings(page);
    expect(afterReset.opacity).toBe(1);

    // Verify in storage
    await waitForStoredSettings(page, { opacity: 1 });
    const raw = await readStoredSettings(page);
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.opacity).toBe(1);
  });

  test('colors change is written to storage', async ({ page }) => {
    await setupOverlayPage(page);

    const newColors = {
      normal: '#ffaa00',
      moderator: '#ff6600',
      owner: '#ff0000',
      verified: '#ff00ff',
      member: '#00ffff',
    };
    await applySettings(page, { colors: newColors });

    const raw = await readStoredSettings(page);
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    const storedColors = parsed.colors as Record<string, string>;
    expect(storedColors.normal).toBe('#ffaa00');
    expect(storedColors.moderator).toBe('#ff6600');
  });

  test('normalizes fractional cache budgets imported through the UI and reloads cleanly', async ({
    page,
  }) => {
    const runtimeErrors: string[] = [];
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    const unrelatedOpacity = 0.612345;
    await setupPersistentSettingsPage(page, DEFAULT_SETTINGS);

    await page.locator('#movie_player').hover();
    await page.locator(`#${BUTTON_ID}`).click();
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('#yt-chat-overlay-settings-backdrop button[data-action="import"]').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: 'fractional-cache-settings.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          emojiCacheMb: 1.000001,
          photoCacheMb: 1.000001,
          stickerCacheMb: 1.000001,
          textCacheMb: 1.000001,
          opacity: unrelatedOpacity,
          allowShortTextMessages: true,
          showDebugOverlay: true,
        })
      ),
    });

    await expectNormalizedCacheSettings(page, unrelatedOpacity);
    await expect
      .poll(() =>
        page.evaluate(
          ({ cacheKeys, storageKey }) => {
            const raw = localStorage.getItem(storageKey);
            if (!raw) return null;
            const stored = JSON.parse(raw) as Record<string, unknown>;
            return {
              cacheValues: cacheKeys.map((key) => stored[key]),
              opacity: stored.opacity,
            };
          },
          { cacheKeys: CACHE_KEYS, storageKey: SETTINGS_STORAGE_KEY }
        )
      )
      .toEqual({ cacheValues: [1, 1, 1, 1], opacity: unrelatedOpacity });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#yt-live-chat-overlay').waitFor({ state: 'attached' });
    await expectNormalizedCacheSettings(page, unrelatedOpacity);
    await expect(page.locator('#yt-live-chat-overlay canvas')).toBeAttached();
    await appendRenderableMessage(page, 'settings-import-reload-message');
    await expect(page.locator('#yt-chat-overlay-debug > div').first()).toHaveText(
      'Rcvd: 1 | Rndr: 1'
    );
    expect(runtimeErrors).toEqual([]);
  });

  test('starts and renders from pre-seeded fractional cache budgets', async ({ page }) => {
    const runtimeErrors: string[] = [];
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    const unrelatedOpacity = 0.734567;
    await setupPersistentSettingsPage(page, {
      ...DEFAULT_SETTINGS,
      emojiCacheMb: 1.000001,
      photoCacheMb: 1.000001,
      stickerCacheMb: 1.000001,
      textCacheMb: 1.000001,
      opacity: unrelatedOpacity,
      allowShortTextMessages: true,
      showDebugOverlay: true,
    });

    await expectNormalizedCacheSettings(page, unrelatedOpacity);
    await expect(page.locator('#yt-live-chat-overlay canvas')).toBeAttached();
    await appendRenderableMessage(page, 'settings-preseed-startup-message');
    await expect(page.locator('#yt-chat-overlay-debug > div').first()).toHaveText(
      'Rcvd: 1 | Rndr: 1'
    );
    expect(runtimeErrors).toEqual([]);
  });
});
