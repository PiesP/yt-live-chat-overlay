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
    __ytAcceptanceAllowSettingsRead?: boolean;
    __ytAcceptanceDeniedReads?: number;
    __ytAcceptanceActualSettings?: () => string | null;
    __ytAcceptanceDeferredRecovery?: {
      reads: number;
      waiting: boolean;
      released: boolean;
      writes: number;
      release: () => void;
    };
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
  language: Pick<FixtureLanguage, 'locale' | 'language' | 'width'>,
  initialReadFailure = false
): Promise<void> {
  await context.addInitScript(
    ({ storageKey, selectedLanguage, denyInitialRead }) => {
      (window as Window & { unsafeWindow?: Window }).unsafeWindow = window;
      window.__ytAcceptanceDenySettings = false;
      window.__ytAcceptanceDeniedWrites = 0;
      window.__ytAcceptanceDeniedWriteStacks = [];
      if (localStorage.getItem(storageKey) === null) {
        localStorage.setItem(
          storageKey,
          JSON.stringify(
            denyInitialRead
              ? { fontSize: 48, speedPxPerSec: 420, opacity: 0.75, language: selectedLanguage }
              : { fontSize: 32, language: selectedLanguage }
          )
        );
      }
      if (denyInitialRead) {
        const originalGet = Storage.prototype.getItem;
        window.__ytAcceptanceDeniedReads = 0;
        window.__ytAcceptanceAllowSettingsRead =
          sessionStorage.getItem('__ytAcceptanceAllowSettingsRead') === '1';
        window.__ytAcceptanceActualSettings = () => originalGet.call(localStorage, storageKey);
        Storage.prototype.getItem = function (key: string): string | null {
          const value = originalGet.call(this, key);
          if (key === storageKey && value !== null && !window.__ytAcceptanceAllowSettingsRead) {
            window.__ytAcceptanceDeniedReads = (window.__ytAcceptanceDeniedReads ?? 0) + 1;
            throw new Error('Controlled initial settings read denial');
          }
          return value;
        };
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
    {
      storageKey: SETTINGS_KEY,
      selectedLanguage: language.language,
      denyInitialRead: initialReadFailure,
    }
  );
  await context.addInitScript({ content: userscript });
}

async function createFixtureContext(
  browser: Browser,
  userscript: string,
  language: Pick<FixtureLanguage, 'locale' | 'language' | 'width'>,
  initialReadFailure = false
): Promise<BrowserContext> {
  const context = await browser.newContext({
    locale: language.locale,
    viewport: { width: language.width, height: 720 },
  });
  await installFixtureScripts(context, userscript, language, initialReadFailure);
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
    assertNoticePresentation(unsaved, `${language.id} narrow unsaved`);
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
    assert.equal(saved.fontSize, '14px', `${language.id} narrow saved notice font`);
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
    assertNoticePresentation(conflict, 'English narrow conflict');
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

function assertNoticePresentation(observation: NoticeObservation, scenario: string): void {
  assert.equal(
    observation.fontSize,
    '14px',
    `${scenario}: notice body font differs from the token`
  );
  assert(observation.focusedAction, `${scenario}: recovery action lost keyboard focus`);
  assert(
    Number.parseFloat(observation.actionOutlineWidth ?? '0') > 0,
    `${scenario}: keyboard focus ring is not visible`
  );
  assert.deepEqual(
    noticeAnomalies(observation),
    {
      noticeOutsideViewport: false,
      actionOutsideViewport: false,
      noticeContentOverflow: false,
      documentHorizontalOverflow: false,
    },
    `${scenario}: notice text or action is clipped`
  );
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
    assertNoticePresentation(ko100, 'Korean 100% zoom');
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
    assertNoticePresentation(ko200, 'Korean 200% zoom');
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
    assertNoticePresentation(ja200, 'Japanese 200% zoom');
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
    assertNoticePresentation(jaConflict200, 'Japanese conflict at 200% zoom');
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

async function runInitialReadRecoveryCase({
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
  const context = await createFixtureContext(
    browser,
    userscript,
    { locale: 'en-US', language: 'en', width: 1280 },
    true
  );
  const pageErrors: string[] = [];
  try {
    await routeFixture(context, watchHtml);
    const page = await openFixturePage(context, pageErrors);
    const before = await page.evaluate(() => window.__ytAcceptanceActualSettings?.());
    assert(before, 'Initial-read fixture did not seed existing preferences');
    assert.equal(JSON.parse(before).fontSize, 48);
    await page.waitForFunction(() => window.__ytChatOverlay?.getSettings?.().fontSize !== 48);

    await openSettings(page);
    await page.locator('#yt-chat-overlay-settings-backdrop input[name="opacity"]').fill('50');
    await page.waitForFunction(() => window.__ytChatOverlay?.getSettings?.().opacity === 0.5);
    await page.keyboard.press('Escape');
    const notice = page.locator(NOTICE_SELECTOR);
    const retry = notice.getByRole('button', { name: 'Retry save' });
    await retry.waitFor({ state: 'visible' });
    assert.match((await notice.textContent()) ?? '', /were not saved/u);
    assert.equal(await page.evaluate(() => window.__ytAcceptanceActualSettings?.()), before);
    const deniedReads = await page.evaluate(() => window.__ytAcceptanceDeniedReads ?? 0);
    assert(deniedReads >= 2, 'Initial load and persistence must each attempt a real read');
    await page.screenshot({ path: join(output, 'settings-initial-read-unsaved.png') });

    await page.evaluate(() => {
      window.__ytAcceptanceAllowSettingsRead = true;
      sessionStorage.setItem('__ytAcceptanceAllowSettingsRead', '1');
    });
    await retry.click();
    await notice.getByText('Settings saved.').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const raw = window.__ytAcceptanceActualSettings?.();
      if (!raw) return false;
      const stored = JSON.parse(raw) as {
        fontSize: number;
        speedPxPerSec: number;
        opacity: number;
      };
      return stored.fontSize === 48 && stored.speedPxPerSec === 420 && stored.opacity === 0.5;
    });
    await page.screenshot({ path: join(output, 'settings-initial-read-saved.png') });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#yt-live-chat-overlay').waitFor({ state: 'attached', timeout: 15_000 });
    await page.waitForFunction(() => {
      const settings = window.__ytChatOverlay?.getSettings?.();
      return (
        settings?.fontSize === 48 && settings.speedPxPerSec === 420 && settings.opacity === 0.5
      );
    });
    assert.deepEqual(pageErrors, []);
    return {
      deniedReads,
      before: { fontSize: 48, speedPxPerSec: 420, opacity: 0.75 },
      after: { fontSize: 48, speedPxPerSec: 420, opacity: 0.5 },
      screenshots: ['settings-initial-read-unsaved.png', 'settings-initial-read-saved.png'],
      pageErrors,
    };
  } finally {
    await context.close();
  }
}

async function runQueuedInputRecoveryCase({
  browser,
  output,
  userscript,
  watchHtml,
  timing,
}: {
  browser: Browser;
  output: string;
  userscript: string;
  watchHtml: string;
  timing: 'before-preview' | 'after-preview';
}) {
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 720 },
  });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const expectedReadWarnings: string[] = [];
  const otherWarnings: string[] = [];
  let stage = 'initialize';
  try {
    // The maintained Chrome storage adapter awaits get(). This controlled
    // page boundary supplies one failed initial read and one deferred recovery
    // read while the real App, Settings, and form execute from the built script.
    await context.addInitScript((storageKey) => {
      const seed = JSON.stringify({ fontSize: 48, speedPxPerSec: 420, opacity: 0.75 });
      if (localStorage.getItem(storageKey) === null) localStorage.setItem(storageKey, seed);
      let releaseRead: (() => void) | undefined;
      const state = {
        reads: 0,
        waiting: false,
        released: false,
        writes: 0,
        release: () => releaseRead?.(),
      };
      window.__ytAcceptanceDeferredRecovery = state;
      const local = {
        async get(key: string): Promise<Record<string, unknown>> {
          if (key !== storageKey) return {};
          state.reads++;
          if (sessionStorage.getItem('__ytAcceptanceRecoveryFinished') !== '1') {
            if (state.reads === 1) throw new Error('Controlled initial settings read denial');
            if (state.reads === 2) {
              return new Promise<Record<string, unknown>>((resolve) => {
                state.waiting = true;
                releaseRead = () => {
                  state.waiting = false;
                  state.released = true;
                  resolve({ [key]: localStorage.getItem(key) });
                };
              });
            }
          }
          return { [key]: localStorage.getItem(key) };
        },
        async set(items: Record<string, unknown>): Promise<void> {
          const value = items[storageKey];
          if (typeof value !== 'string') throw new Error('Settings write lacked a string value');
          state.writes++;
          localStorage.setItem(storageKey, value);
        },
      };
      const existingChrome = (window as Window & { chrome?: Record<string, unknown> }).chrome ?? {};
      Object.defineProperty(window, 'chrome', {
        configurable: true,
        value: { ...existingChrome, storage: { local } },
      });
    }, SETTINGS_KEY);
    await context.addInitScript({ content: userscript });
    await routeFixture(context, watchHtml);
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
      if (message.type() === 'warning') {
        const warning = message.text();
        if (warning.includes('Controlled initial settings read denial')) {
          expectedReadWarnings.push(warning);
        } else {
          otherWarnings.push(warning);
        }
      }
    });
    await page.goto(WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('#yt-live-chat-overlay').waitFor({ state: 'attached', timeout: 15_000 });
    const seed = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
    assert(seed, 'Deferred-recovery fixture did not seed preferences');
    assert.equal(JSON.parse(seed).fontSize, 48);
    await page.waitForFunction(() => window.__ytAcceptanceDeferredRecovery?.reads === 1);
    assert.equal(await page.evaluate(() => window.__ytChatOverlay?.getSettings?.().fontSize), 32);

    stage = 'accept-opacity-and-hold-recovery';
    await openSettings(page);
    await page.locator('#yt-chat-overlay-settings-backdrop input[name="opacity"]').fill('50');
    await page.waitForFunction(() => window.__ytChatOverlay?.getSettings?.().opacity === 0.5);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__ytAcceptanceDeferredRecovery?.waiting === true);
    assert.equal(await page.evaluate(() => window.__ytAcceptanceDeferredRecovery?.reads), 2);
    assert.equal(await page.evaluate(() => window.__ytAcceptanceDeferredRecovery?.writes), 0);

    stage = 'reopen-and-enter-font';
    await openSettings(page);
    const fontInput = page.locator('#yt-chat-overlay-settings-backdrop input[name="fontSize"]');
    let atRelease: { font: number | undefined; form: string; released: boolean };
    if (timing === 'before-preview') {
      // Dispatch and release in one browser task. The deferred read settles in
      // microtasks, before the 100 ms preview timer can possibly fire.
      atRelease = await page.evaluate(() => {
        const field = document.querySelector<HTMLInputElement>(
          '#yt-chat-overlay-settings-backdrop input[name="fontSize"]'
        );
        const recovery = window.__ytAcceptanceDeferredRecovery;
        if (!field || !recovery?.waiting) throw new Error('Recovery/input fixture was not ready');
        field.value = '36';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        const font = window.__ytChatOverlay?.getSettings?.().fontSize;
        recovery.release();
        return { font, form: field.value, released: recovery.released };
      });
      assert.equal(atRelease.font, 32, 'Preview ran before recovery was released');
    } else {
      await fontInput.fill('36');
      await page.waitForFunction(() => window.__ytChatOverlay?.getSettings?.().fontSize === 36);
      atRelease = await page.evaluate(() => {
        const recovery = window.__ytAcceptanceDeferredRecovery;
        if (!recovery?.waiting) throw new Error('Recovery was not waiting after preview');
        const form = document.querySelector<HTMLInputElement>(
          '#yt-chat-overlay-settings-backdrop input[name="fontSize"]'
        );
        recovery.release();
        return {
          font: window.__ytChatOverlay?.getSettings?.().fontSize,
          form: form?.value ?? '',
          released: recovery.released,
        };
      });
      assert.equal(atRelease.font, 36);
    }
    assert.equal(atRelease.form, '36');
    assert(atRelease.released);

    stage = 'observe-recovery-and-preview';
    if (timing === 'before-preview') {
      await page.waitForFunction((key) => {
        const raw = localStorage.getItem(key);
        if (!raw) return false;
        const stored = JSON.parse(raw) as { opacity: number; fontSize: number };
        return stored.opacity === 0.5 && stored.fontSize === 48;
      }, SETTINGS_KEY);
    }
    await page.waitForFunction(() => window.__ytChatOverlay?.getSettings?.().fontSize === 36);
    assert.equal(await fontInput.inputValue(), '36');
    const beforeClose = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      const stored = raw ? (JSON.parse(raw) as { fontSize: number; opacity: number }) : null;
      const recovery = window.__ytAcceptanceDeferredRecovery;
      return {
        stored,
        memoryFont: window.__ytChatOverlay?.getSettings?.().fontSize,
        formFont: document.querySelector<HTMLInputElement>(
          '#yt-chat-overlay-settings-backdrop input[name="fontSize"]'
        )?.value,
        recovery: recovery
          ? {
              reads: recovery.reads,
              waiting: recovery.waiting,
              released: recovery.released,
              writes: recovery.writes,
            }
          : null,
      };
    }, SETTINGS_KEY);
    assert(beforeClose.stored);
    assert.equal(beforeClose.stored.fontSize, 48, 'An unaccepted font draft was persisted');
    assert.equal(beforeClose.memoryFont, 36);
    assert.equal(beforeClose.formFont, '36');
    assert.deepEqual(beforeClose.recovery?.reads, 2);
    assert.equal(beforeClose.recovery?.waiting, false);
    assert.equal(beforeClose.recovery?.released, true);
    const openFormScreenshot = `settings-queued-recovery-${timing}-open.png`;
    await page.screenshot({ path: join(output, openFormScreenshot) });

    stage = 'close-and-read-fresh-document';
    await page.keyboard.press('Escape');
    await page.waitForFunction((key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return false;
      const stored = JSON.parse(raw) as {
        fontSize: number;
        speedPxPerSec: number;
        opacity: number;
      };
      return stored.fontSize === 36 && stored.speedPxPerSec === 420 && stored.opacity === 0.5;
    }, SETTINGS_KEY);
    const afterClose = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? 'null'),
      SETTINGS_KEY
    );
    const originalDocumentTimeOrigin = await page.evaluate(() => performance.timeOrigin);
    await page.evaluate(() => sessionStorage.setItem('__ytAcceptanceRecoveryFinished', '1'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#yt-live-chat-overlay').waitFor({ state: 'attached', timeout: 15_000 });
    const freshDocumentTimeOrigin = await page.evaluate(() => performance.timeOrigin);
    assert(
      freshDocumentTimeOrigin > originalDocumentTimeOrigin,
      'The final read did not execute in a fresh document'
    );
    await page.waitForFunction(() => {
      const settings = window.__ytChatOverlay?.getSettings?.();
      return (
        settings?.fontSize === 36 && settings.speedPxPerSec === 420 && settings.opacity === 0.5
      );
    });
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
    return {
      timing,
      atRelease,
      beforeClose,
      afterClose: {
        fontSize: afterClose.fontSize,
        speedPxPerSec: afterClose.speedPxPerSec,
        opacity: afterClose.opacity,
      },
      freshDocument: { originalDocumentTimeOrigin, freshDocumentTimeOrigin },
      screenshots: [openFormScreenshot],
      pageErrors,
      consoleErrors,
      expectedReadWarnings,
      otherWarnings,
    };
  } catch (error) {
    await writeFile(
      join(output, `settings-queued-recovery-${timing}-failure.json`),
      `${JSON.stringify(
        {
          stage,
          error: error instanceof Error ? error.message : String(error),
          pageErrors,
          consoleErrors,
          expectedReadWarnings,
          otherWarnings,
        },
        null,
        2
      )}\n`
    );
    throw error;
  } finally {
    await context.close();
  }
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
    assertNoticePresentation(unsaved, 'English unsaved');
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
    assert.equal(repeatedUnsaved.fontSize, '14px', 'English repeated failure font');

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
    assert.equal(saved.fontSize, '14px', 'English saved notice font');
    await page.screenshot({ path: join(output, 'settings-saved.png') });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#yt-live-chat-overlay').waitFor({ state: 'attached', timeout: 15_000 });
    await page.waitForFunction(() => window.__ytChatOverlay?.getSettings?.().fontSize === 44);
    const localized = [];
    for (const language of LANGUAGES) {
      localized.push(await runLocalizedCase({ browser, output, userscript, watchHtml, language }));
    }
    const conflict = await runConflictCase({ browser, output, userscript, watchHtml });
    const initialReadRecovery = await runInitialReadRecoveryCase({
      browser,
      output,
      userscript,
      watchHtml,
    });
    const queuedInputBeforePreview = await runQueuedInputRecoveryCase({
      browser,
      output,
      userscript,
      watchHtml,
      timing: 'before-preview',
    });
    const queuedInputAfterPreview = await runQueuedInputRecoveryCase({
      browser,
      output,
      userscript,
      watchHtml,
      timing: 'after-preview',
    });
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
        deniedInitialReadPreservesPreferences: true,
        queuedInputSurvivesBeforePreviewRecovery: true,
        queuedInputSurvivesAfterPreviewRecovery: true,
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
        notice: { unsaved, repeatedUnsaved, saved, localized, conflict, initialReadRecovery },
        queuedInputBeforePreview,
        queuedInputAfterPreview,
        browserZoom200,
        installedExtension: 'not-run: focused selector exercises the built userscript',
        screenshots: [
          'settings-unsaved.png',
          'settings-saved.png',
          ...initialReadRecovery.screenshots,
          ...queuedInputBeforePreview.screenshots,
          ...queuedInputAfterPreview.screenshots,
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
