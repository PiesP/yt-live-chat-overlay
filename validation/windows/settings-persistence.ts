// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

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
  // Keep the fixture on its one accepted HTTP host. Browser-internal settings
  // pages must not be intercepted while the owned Chrome profile changes zoom.
  await context.route(/^https?:\/\//u, async (route) => {
    await route.fulfill({ status: 204 });
  });
  await context.route('https://www.youtube.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().resourceType() === 'document') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: watchHtml });
    } else if (url.hostname === 'www.youtube.com' && url.pathname.includes('/live_chat/')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          continuationContents: { liveChatContinuation: { actions: [], continuations: [] } },
        },
      });
    } else await route.fulfill({ status: 204 });
  });
}

async function installFixtureScripts(
  context: BrowserContext,
  userscript: string,
  language: Pick<FixtureLanguage, 'locale' | 'language' | 'width'>
): Promise<void> {
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
  await installFixtureScripts(context, userscript, language);
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

type NoticeObservation = Awaited<ReturnType<typeof readNotice>>;

function noticeAnomalies(observation: NoticeObservation) {
  const { notice, actionBounds, viewport, content } = observation;
  return {
    noticeOutsideViewport:
      notice.x < -1 ||
      notice.right > viewport.width + 1 ||
      notice.y < -1 ||
      notice.bottom > viewport.height + 1,
    actionOutsideViewport:
      actionBounds === null ||
      actionBounds.x < -1 ||
      actionBounds.right > viewport.width + 1 ||
      actionBounds.y < -1 ||
      actionBounds.bottom > viewport.height + 1,
    noticeContentOverflow:
      content.scrollWidth > content.width + 1 || content.scrollHeight > content.height + 1,
    documentHorizontalOverflow: observation.documentScrollWidth > viewport.width + 1,
  };
}

async function captureNativeZoomScreenshot(page: Page, output: string, file: string) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Page.bringToFront');
    // Playwright's screenshot clip may retain the pre-zoom viewport dimensions.
    const { data } = await session.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(data, 'base64');
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await writeFile(join(output, file), bytes);
    return {
      file,
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      method: 'cdp-page-capture-screenshot-no-clip',
    };
  } finally {
    await session.detach();
  }
}

async function zoomMetrics(page: Page) {
  return page.evaluate(() => ({
    devicePixelRatio,
    width: innerWidth,
    visualViewportScale: visualViewport?.scale ?? null,
  }));
}

async function triggerUnsavedNotice(page: Page, language: FixtureLanguage): Promise<Locator> {
  await openSettings(page);
  await page.locator('#yt-chat-overlay-settings-backdrop input[name="fontSize"]').fill('44');
  await page.waitForFunction(() => window.__ytChatOverlay?.getSettings?.().fontSize === 44);
  await page.evaluate(() => {
    window.__ytAcceptanceDenySettings = true;
  });
  await page.keyboard.press('Escape');
  const notice = page.locator(NOTICE_SELECTOR);
  await notice.getByRole('button', { name: language.retry }).waitFor({ state: 'visible' });
  assert((await notice.textContent())?.includes(language.unsaved));
  await focusNoticeAction(page, notice.getByRole('button', { name: language.retry }));
  return notice;
}

async function runChromeZoomCase({
  browser,
  root,
  output,
  userscript,
  watchHtml,
}: {
  browser: Browser;
  root: string;
  output: string;
  userscript: string;
  watchHtml: string;
}) {
  const korean = LANGUAGES[0];
  const japanese = LANGUAGES[1];
  assert(korean && japanese);
  const bundle: unknown = JSON.parse(await readFile(join(root, 'bundle.json'), 'utf8'));
  assert(bundle && typeof bundle === 'object' && 'mode' in bundle);
  const mode = bundle.mode;
  assert(mode === 'desktop' || mode === 'headless-diagnostic');
  const profilePath = await mkdtemp(join(root, 'yt-notice-zoom-chrome-'));
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let settingsPage: Page | undefined;
  let previousZoom: string | undefined;
  let baseline: Awaited<ReturnType<typeof zoomMetrics>> | undefined;
  let result: Record<string, unknown> | undefined;
  let primaryError: unknown;
  let stage = 'launch-owned-chrome';
  let zoomRestored = false;
  let contextClosed = false;
  let profileRemoved = false;
  const pageErrors: string[] = [];
  const cleanupErrors: unknown[] = [];
  try {
    context = await browser.browserType().launchPersistentContext(profilePath, {
      channel: 'chrome',
      headless: mode === 'headless-diagnostic',
      args: ['--mute-audio'],
      locale: 'ko-KR',
      viewport: { width: 780, height: 720 },
    });
    await installFixtureScripts(context, userscript, {
      locale: 'ko-KR',
      language: 'ko',
      width: 780,
    });
    await routeFixture(context, watchHtml);
    page = context.pages()[0] ?? (await context.newPage());
    page.on('pageerror', (error) => pageErrors.push(error.message));
    stage = 'observe-korean-at-100';
    await page.goto(WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('#yt-live-chat-overlay').waitFor({ state: 'attached', timeout: 15_000 });
    let notice = await triggerUnsavedNotice(page, korean);
    const ko100 = await readNotice(notice);
    const ko100Screenshot = await captureNativeZoomScreenshot(
      page,
      output,
      'settings-zoom-ko-100.png'
    );
    baseline = await zoomMetrics(page);

    stage = 'set-real-browser-zoom';
    settingsPage = await context.newPage();
    await settingsPage.goto('chrome://settings/appearance');
    const zoom = settingsPage.locator('select#zoomLevel');
    previousZoom = await zoom.inputValue();
    assert.equal(Number(previousZoom), 1, 'Owned Chrome profile did not start at 100% zoom');
    await zoom.selectOption('2');
    await page.bringToFront();
    await page.waitForFunction(
      (before) =>
        Math.abs(devicePixelRatio / before.devicePixelRatio - 2) < 0.02 &&
        Math.abs(innerWidth / before.width - 0.5) < 0.02 &&
        Math.abs((visualViewport?.scale ?? 0) - 1) < 0.02,
      baseline,
      { timeout: 10_000 }
    );
    const zoomed = await zoomMetrics(page);
    stage = 'observe-korean-at-200';
    await focusNoticeAction(page, notice.getByRole('button', { name: korean.retry }));
    const ko200 = await readNotice(notice);
    const ko200Screenshot = await captureNativeZoomScreenshot(
      page,
      output,
      'settings-zoom-ko-200.png'
    );
    assert.equal(ko100Screenshot.width, ko200Screenshot.width);
    assert.equal(ko100Screenshot.height, ko200Screenshot.height);

    stage = 'observe-japanese-at-200';
    await page.evaluate(() => {
      window.__ytAcceptanceDenySettings = false;
    });
    await notice.getByRole('button', { name: korean.retry }).click();
    await notice.getByText(korean.saved).waitFor({ state: 'visible' });
    await page.evaluate((key) => {
      const previous = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      localStorage.setItem(key, JSON.stringify({ ...previous, fontSize: 32, language: 'ja' }));
    }, SETTINGS_KEY);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#yt-live-chat-overlay').waitFor({ state: 'attached', timeout: 15_000 });
    notice = await triggerUnsavedNotice(page, japanese);
    const ja200 = await readNotice(notice);
    const ja200Screenshot = await captureNativeZoomScreenshot(
      page,
      output,
      'settings-zoom-ja-200.png'
    );

    stage = 'observe-japanese-conflict-at-200';
    const remote = await openFixturePage(context, pageErrors);
    await remote.evaluate((key) => {
      const previous = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      localStorage.setItem(key, JSON.stringify({ ...previous, fontSize: 52 }));
    }, SETTINGS_KEY);
    const keepMine = notice.getByRole('button', { name: '自分の設定を保存' });
    await keepMine.waitFor({ state: 'visible' });
    await page.bringToFront();
    await focusNoticeAction(page, keepMine);
    const jaConflict200 = await readNotice(notice);
    const conflictScreenshot = await captureNativeZoomScreenshot(
      page,
      output,
      'settings-zoom-ja-conflict-200.png'
    );
    assert.equal(
      await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? '{}').fontSize,
        SETTINGS_KEY
      ),
      52
    );
    await page.evaluate(() => {
      window.__ytAcceptanceDenySettings = false;
    });
    await keepMine.click();
    await page.waitForFunction(
      (key) => JSON.parse(localStorage.getItem(key) ?? 'null')?.fontSize === 44,
      SETTINGS_KEY
    );
    await notice.getByText(japanese.saved).waitFor({ state: 'visible' });
    assert.deepEqual(pageErrors, []);
    result = {
      method: 'owned-persistent-chrome-settings-page',
      viewportAtLaunch: { width: 780, height: 720 },
      baseline,
      zoomed,
      observations: {
        ko100: { notice: ko100, anomalies: noticeAnomalies(ko100), screenshot: ko100Screenshot },
        ko200: { notice: ko200, anomalies: noticeAnomalies(ko200), screenshot: ko200Screenshot },
        ja200: { notice: ja200, anomalies: noticeAnomalies(ja200), screenshot: ja200Screenshot },
        jaConflict200: {
          notice: jaConflict200,
          anomalies: noticeAnomalies(jaConflict200),
          screenshot: conflictScreenshot,
        },
      },
      screenshots: [
        ko100Screenshot.file,
        ko200Screenshot.file,
        ja200Screenshot.file,
        conflictScreenshot.file,
      ],
      pageErrors,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (previousZoom !== undefined && settingsPage) {
      try {
        await settingsPage.locator('select#zoomLevel').selectOption(previousZoom);
        if (baseline && page) {
          await page.bringToFront();
          await page.waitForFunction(
            (before) =>
              Math.abs(devicePixelRatio / before.devicePixelRatio - 1) < 0.02 &&
              Math.abs(innerWidth / before.width - 1) < 0.02 &&
              Math.abs((visualViewport?.scale ?? 0) - 1) < 0.02,
            baseline,
            { timeout: 10_000 }
          );
        }
        zoomRestored = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (settingsPage) {
      try {
        await settingsPage.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (context) {
      try {
        await context.close();
        contextClosed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (contextClosed) {
      try {
        assert.equal(dirname(profilePath), root);
        assert(basename(profilePath).startsWith('yt-notice-zoom-chrome-'));
        await rm(profilePath, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
        profileRemoved = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (primaryError || cleanupErrors.length) {
      try {
        await writeFile(
          join(output, 'settings-zoom-failure.json'),
          `${JSON.stringify(
            {
              stage,
              error:
                primaryError === undefined
                  ? null
                  : primaryError instanceof Error
                    ? primaryError.message
                    : String(primaryError),
              cleanupErrors: cleanupErrors.map((error) =>
                error instanceof Error ? error.message : String(error)
              ),
              profileName: basename(profilePath),
              zoomRestored,
              contextClosed,
              profileRemoved,
            },
            null,
            2
          )}\n`
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (cleanupErrors.length) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors].filter((error) => error !== undefined),
      'Owned Chrome zoom validation or cleanup failed'
    );
  }
  if (primaryError) throw primaryError;
  assert(result);
  return { ...result, cleanup: { zoomRestored, contextClosed, profileRemoved } };
}

/** Bounded built-userscript fixture selected by a bundle-hashed local input. */
export async function runSettingsPersistenceFixture({
  browser,
  root,
  output,
  userscript,
  watchHtml,
}: {
  browser: Browser;
  root: string;
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
    const browserZoom200 = await runChromeZoomCase({
      browser,
      root,
      output,
      userscript,
      watchHtml,
    });
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
        realBrowserZoom200Observed: true,
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
        browserZoom200,
        installedExtension: 'not-run: focused selector exercises the built userscript',
        screenshots: [
          'settings-unsaved.png',
          'settings-saved.png',
          ...localized.flatMap((item) => item.screenshots),
          ...conflict.screenshots,
          'settings-zoom-ko-100.png',
          'settings-zoom-ko-200.png',
          'settings-zoom-ja-200.png',
          'settings-zoom-ja-conflict-200.png',
        ],
      },
    };
  } finally {
    await context.close();
  }
}
