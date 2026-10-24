// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { join } from 'node:path';

import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';

const SETTINGS_KEY = 'yt-live-chat-overlay-settings';
const WATCH_URL = 'https://www.youtube.com/watch?v=windowsAcceptance';
const NOTICE_SELECTOR = '.yt-chat-overlay-settings-persistence-notice';

type FixtureLanguage = {
  id: string;
  locale: string;
  language: string;
  width: number;
  unsaved: string;
  retry: string;
  saved: string;
};

const LANGUAGES: FixtureLanguage[] = [
  {
    id: 'ko',
    locale: 'ko-KR',
    language: 'ko',
    width: 390,
    unsaved: '저장되지 않았습니다',
    retry: '저장 다시 시도',
    saved: '설정을 저장했습니다.',
  },
  {
    id: 'ja',
    locale: 'ja-JP',
    language: 'ja',
    width: 390,
    unsaved: '保存されていません',
    retry: '保存を再試行',
    saved: '設定を保存しました。',
  },
];

declare global {
  interface Window {
    __ytAcceptanceDenySettings?: boolean;
    __ytAcceptanceDeniedWrites?: number;
    __ytAcceptanceDeniedWriteStacks?: string[];
  }
}

async function readNotice(notice: Locator) {
  return notice.evaluate((element) => {
    const message = element.querySelector('span');
    const action = element.querySelector('button');
    const player = document.querySelector('#movie_player');
    if (!message || !player) throw new Error('Persistence notice is incomplete');
    const box = (node: Element) => {
      const bounds = node.getBoundingClientRect();
      return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        right: bounds.right,
        bottom: bounds.bottom,
      };
    };
    const style = getComputedStyle(element);
    const actionStyle = action ? getComputedStyle(action) : null;
    return {
      message: message.textContent,
      action: action?.textContent ?? null,
      font: style.font,
      fontSize: style.fontSize,
      fontFamily: style.fontFamily,
      lineHeight: style.lineHeight,
      actionFontSize: actionStyle?.fontSize ?? null,
      actionOutlineWidth: actionStyle?.outlineWidth ?? null,
      notice: box(element),
      messageBounds: box(message),
      actionBounds: action ? box(action) : null,
      player: box(player),
      viewport: { width: innerWidth, height: innerHeight },
      documentScrollWidth: document.documentElement.scrollWidth,
      content: {
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
      },
      focusedAction: action !== null && document.activeElement === action,
    };
  });
}

async function focusNoticeAction(page: Page, action: Locator): Promise<void> {
  await action.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  assert(await action.evaluate((button) => document.activeElement === button));
}

async function routeFixture(context: BrowserContext, watchHtml: string): Promise<void> {
  await context.route('**/*', async (route) => {
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
}

async function createFixtureContext(
  browser: Browser,
  userscript: string,
  language: Pick<FixtureLanguage, 'locale' | 'language' | 'width'>
): Promise<BrowserContext> {
  const context = await browser.newContext({
    locale: language.locale,
    viewport: { width: language.width, height: 720 },
  });
  await context.addInitScript(
    ({ storageKey, selectedLanguage }) => {
      (window as Window & { unsafeWindow?: Window }).unsafeWindow = window;
      window.__ytAcceptanceDenySettings = false;
      window.__ytAcceptanceDeniedWrites = 0;
      window.__ytAcceptanceDeniedWriteStacks = [];
      if (localStorage.getItem(storageKey) === null) {
        localStorage.setItem(
          storageKey,
          JSON.stringify({ fontSize: 32, language: selectedLanguage })
        );
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
    },
    { storageKey: SETTINGS_KEY, selectedLanguage: language.language }
  );
  await context.addInitScript({ content: userscript });
  return context;
}

async function openFixturePage(context: BrowserContext, pageErrors: string[]): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('#yt-live-chat-overlay').waitFor({ state: 'attached', timeout: 15_000 });
  return page;
}

async function openSettings(page: Page): Promise<void> {
  await page.locator('#movie_player').hover();
  await page.locator('#yt-chat-overlay-settings-button').click();
}

async function runLocalizedCase({
  browser,
  output,
  userscript,
  watchHtml,
  language,
}: {
  browser: Browser;
  output: string;
  userscript: string;
  watchHtml: string;
  language: FixtureLanguage;
}) {
  const context = await createFixtureContext(browser, userscript, language);
  const pageErrors: string[] = [];
  try {
    await routeFixture(context, watchHtml);
    const page = await openFixturePage(context, pageErrors);
    const before = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
    assert(before);
    await openSettings(page);
    await page.locator('#yt-chat-overlay-settings-backdrop input[name="fontSize"]').fill('44');
    await page.waitForFunction(() => window.__ytChatOverlay?.getSettings?.().fontSize === 44);
    await page.evaluate(() => {
      window.__ytAcceptanceDenySettings = true;
    });
    await page.keyboard.press('Escape');
    const notice = page.locator(NOTICE_SELECTOR);
    const retry = notice.getByRole('button', { name: language.retry });
    await retry.waitFor({ state: 'visible' });
    assert((await notice.textContent())?.includes(language.unsaved));
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY), before);
    assert.equal(await page.evaluate(() => window.__ytChatOverlay?.getSettings?.().fontSize), 44);
    await focusNoticeAction(page, retry);
    const unsaved = await readNotice(notice);
    const unsavedScreenshot = `settings-${language.id}-narrow-unsaved.png`;
    await page.screenshot({ path: join(output, unsavedScreenshot) });
    await page.evaluate(() => {
      window.__ytAcceptanceDenySettings = false;
    });
    await retry.click();
    await page.waitForFunction(
      (key) => JSON.parse(localStorage.getItem(key) ?? 'null')?.fontSize === 44,
      SETTINGS_KEY
    );
    await notice.getByText(language.saved).waitFor({ state: 'visible' });
    const saved = await readNotice(notice);
    const savedScreenshot = `settings-${language.id}-narrow-saved.png`;
    await page.screenshot({ path: join(output, savedScreenshot) });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#yt-live-chat-overlay').waitFor({ state: 'attached', timeout: 15_000 });
    await page.waitForFunction(() => window.__ytChatOverlay?.getSettings?.().fontSize === 44);
    assert.deepEqual(pageErrors, []);
    return {
      id: language.id,
      locale: language.locale,
      unsaved,
      saved,
      screenshots: [unsavedScreenshot, savedScreenshot],
      pageErrors,
    };
  } finally {
    await context.close();
  }
}

async function runConflictCase({
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
  const context = await createFixtureContext(browser, userscript, {
    locale: 'en-US',
    language: 'en',
    width: 390,
  });
  const pageErrors: string[] = [];
  try {
    await routeFixture(context, watchHtml);
    const page = await openFixturePage(context, pageErrors);
    await openSettings(page);
    await page.locator('#yt-chat-overlay-settings-backdrop input[name="fontSize"]').fill('44');
    await page.waitForFunction(() => window.__ytChatOverlay?.getSettings?.().fontSize === 44);
    await page.evaluate(() => {
      window.__ytAcceptanceDenySettings = true;
    });
    await page.keyboard.press('Escape');
    const notice = page.locator(NOTICE_SELECTOR);
    await notice.getByRole('button', { name: 'Retry save' }).waitFor({ state: 'visible' });
    const remote = await openFixturePage(context, pageErrors);
    // The browser delivers a real cross-tab storage event to the first tab.
    await remote.evaluate((key) => {
      const previous = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      localStorage.setItem(key, JSON.stringify({ ...previous, fontSize: 52 }));
    }, SETTINGS_KEY);
    const keepMine = notice.getByRole('button', { name: 'Save my values' });
    await keepMine.waitFor({ state: 'visible' });
    assert((await notice.textContent())?.includes('Another tab changed settings'));
    await openSettings(page);
    await page.keyboard.press('Escape');
    await keepMine.waitFor({ state: 'visible' });
    assert.equal(
      await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? '{}').fontSize,
        SETTINGS_KEY
      ),
      52,
      'Ordinary close silently replaced the remote value'
    );
    assert.equal(await page.evaluate(() => window.__ytChatOverlay?.getSettings?.().fontSize), 44);
    await focusNoticeAction(page, keepMine);
    const conflict = await readNotice(notice);
    await page.screenshot({ path: join(output, 'settings-en-narrow-conflict.png') });
    await page.evaluate(() => {
      window.__ytAcceptanceDenySettings = false;
    });
    await keepMine.click();
    await page.waitForFunction(
      (key) => JSON.parse(localStorage.getItem(key) ?? 'null')?.fontSize === 44,
      SETTINGS_KEY
    );
    await notice.getByText('Settings saved.').waitFor({ state: 'visible' });
    assert.deepEqual(pageErrors, []);
    return {
      remoteFontSize: 52,
      localFontSize: 44,
      conflict,
      screenshots: ['settings-en-narrow-conflict.png'],
      pageErrors,
    };
  } finally {
    await context.close();
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
  const context = await createFixtureContext(browser, userscript, {
    locale: 'en-US',
    language: 'en',
    width: 1280,
  });
  const pageErrors: string[] = [];
  try {
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await routeFixture(context, watchHtml);
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
    const notice = page.locator(NOTICE_SELECTOR);
    const retry = notice.getByRole('button', { name: 'Retry save' });
    await retry.waitFor({ state: 'visible' });
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
    await focusNoticeAction(page, retry);
    const unsaved = await readNotice(notice);
    await page.screenshot({ path: join(output, 'settings-unsaved.png') });

    await retry.click();
    await page.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '.yt-chat-overlay-settings-persistence-notice button'
      );
      return window.__ytAcceptanceDeniedWrites === 2 && button && !button.disabled;
    });
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY), before);
    const repeatedUnsaved = await readNotice(notice);

    await page.evaluate(() => {
      window.__ytAcceptanceDenySettings = false;
    });
    await retry.click();
    await page.waitForFunction(
      (key) => JSON.parse(localStorage.getItem(key) ?? 'null')?.fontSize === 44,
      SETTINGS_KEY
    );
    await notice.getByText('Settings saved.').waitFor({ state: 'visible' });
    const saved = await readNotice(notice);
    await page.screenshot({ path: join(output, 'settings-saved.png') });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#yt-live-chat-overlay').waitFor({ state: 'attached', timeout: 15_000 });
    await page.waitForFunction(() => window.__ytChatOverlay?.getSettings?.().fontSize === 44);
    const localized = [];
    for (const language of LANGUAGES) {
      localized.push(await runLocalizedCase({ browser, output, userscript, watchHtml, language }));
    }
    const conflict = await runConflictCase({ browser, output, userscript, watchHtml });
    assert.deepEqual(pageErrors, [], `Page errors: ${pageErrors.join(' | ')}`);
    return {
      checks: {
        installedApplicationDelivery: false,
        sustainedViewingLifecycle: false,
        builtUserscriptFixture: true,
        previewBeforeClose: true,
        denialVisibleAfterClose: true,
        oldStoredValuePreserved: true,
        oneDeniedWriteBeforeRetry: true,
        repeatedDenialRemainsRecoverable: true,
        crossTabConflictRequiresDecision: true,
        retryPersisted: true,
        reloadReadPersisted: true,
        pageErrors: 0,
      },
      observations: {
        browserVersion: browser.version(),
        deniedWrites: 2,
        beforeFontSize: JSON.parse(before).fontSize,
        afterFontSize: 44,
        notice: { unsaved, repeatedUnsaved, saved, localized, conflict },
        browserZoom200: 'not-run: artifact-only fixture has no per-tab zoom helper',
        installedExtension: 'not-run: focused selector exercises the built userscript',
        screenshots: [
          'settings-unsaved.png',
          'settings-saved.png',
          ...localized.flatMap((item) => item.screenshots),
          ...conflict.screenshots,
        ],
      },
    };
  } finally {
    await context.close();
  }
}
