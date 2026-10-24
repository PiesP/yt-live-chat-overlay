// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { join } from 'node:path';

import type { Browser, BrowserContext, Page } from '@playwright/test';

const WATCH_URL = 'https://www.youtube.com/watch?v=windowsAcceptance';
const SETTINGS_KEY = 'yt-live-chat-overlay-settings';
const STATUS = '.yt-chat-overlay-settings-runtime-status';

declare global {
  interface Window {
    __ytTranslationFixture?: {
      emit: (target: string, percent: number) => void;
      resolve: (target: string) => void;
      creates: string[];
    };
  }
}

async function makeContext(
  browser: Browser,
  userscript: string,
  watchHtml: string,
  api: boolean
): Promise<BrowserContext> {
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 720 },
  });
  await context.route(/^https?:\/\//u, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.youtube.com' && route.request().resourceType() === 'document') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: watchHtml });
    } else if (url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          continuationContents: {
            liveChatContinuation: {
              actions: [],
              continuations: [
                {
                  timedContinuationData: {
                    continuation: 'translation-fixture-next',
                    timeoutMs: 30_000,
                  },
                },
              ],
            },
          },
        },
      });
    } else {
      await route.fulfill({ status: 204 });
    }
  });
  await context.addInitScript(
    ({ key, withApi }) => {
      (window as Window & { unsafeWindow?: Window }).unsafeWindow = window;
      window.ytcfg = {
        data_: {
          INNERTUBE_API_KEY: 'translation-fixture-key',
          INNERTUBE_CONTEXT_CLIENT_NAME: '1',
          INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
          INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
        },
      };
      window.ytInitialData = {
        currentVideoEndpoint: { watchEndpoint: { videoId: 'windowsAcceptance' } },
        contents: {
          twoColumnWatchNextResults: {
            conversationBar: {
              liveChatRenderer: {
                isReplay: false,
                continuations: [
                  {
                    timedContinuationData: {
                      continuation: 'translation-fixture-live',
                      timeoutMs: 30_000,
                    },
                  },
                ],
              },
            },
          },
        },
      };
      localStorage.setItem(
        key,
        JSON.stringify({
          language: 'en',
          translationEnabled: true,
          translationService: 'auto',
          translationSource: 'en',
          translationTarget: 'en',
        })
      );
      if (!withApi) {
        Object.defineProperty(window, 'Translator', { configurable: true, value: undefined });
        return;
      }
      const pending = new Map<
        string,
        { monitor: EventTarget; resolve: (value: unknown) => void }[]
      >();
      const creates: string[] = [];
      const translator = {
        translate: async (text: string) => `translated:${text}`,
        destroy: () => undefined,
      };
      const fixture = {
        creates,
        emit(target: string, percent: number) {
          const latest = pending.get(target)?.at(-1);
          if (!latest) throw new Error(`No pending ${target} translator`);
          latest.monitor.dispatchEvent(
            Object.assign(new Event('downloadprogress'), { loaded: percent / 100, total: 1 })
          );
        },
        resolve(target: string) {
          const latest = pending.get(target)?.at(-1);
          if (!latest) throw new Error(`No pending ${target} translator`);
          latest.resolve(translator);
        },
      };
      window.__ytTranslationFixture = fixture;
      Object.defineProperty(window, 'Translator', {
        configurable: true,
        value: {
          availability: async ({ targetLanguage }: { targetLanguage: string }) =>
            targetLanguage === 'ar'
              ? 'unavailable'
              : targetLanguage === 'ko'
                ? 'downloadable'
                : 'available',
          create: ({
            targetLanguage,
            monitor,
          }: {
            targetLanguage: string;
            monitor?: (target: EventTarget) => void;
          }) => {
            creates.push(targetLanguage);
            if (targetLanguage === 'ja')
              return Promise.reject(
                new DOMException('Controlled interaction block', 'NotAllowedError')
              );
            if (targetLanguage !== 'ko') return Promise.resolve(translator);
            const target = new EventTarget();
            monitor?.(target);
            return new Promise((resolve) => {
              const entries = pending.get(targetLanguage) ?? [];
              entries.push({ monitor: target, resolve });
              pending.set(targetLanguage, entries);
            });
          },
        },
      });
    },
    { key: SETTINGS_KEY, withApi: api }
  );
  await context.addInitScript({ content: userscript });
  return context;
}

async function openSettings(page: Page): Promise<void> {
  await page.goto(WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('#yt-live-chat-overlay').waitFor({ state: 'attached', timeout: 15_000 });
  await page.locator('#movie_player').hover();
  await page.locator('#yt-chat-overlay-settings-button').click();
  await page.locator('#yt-chat-overlay-settings-backdrop #tab-translation').click();
}

async function waitPhase(page: Page, phase: string, text: RegExp): Promise<string> {
  await page.waitForFunction(
    ({ selector, expected }) =>
      document.querySelector<HTMLElement>(selector)?.dataset.phase === expected,
    { selector: STATUS, expected: phase },
    { timeout: 15_000 }
  );
  const actual = (await page.locator(STATUS).textContent())?.trim() ?? '';
  assert.match(actual, text);
  return actual;
}

/** Exercise actual built userscript state wiring with only the browser Translator API controlled. */
export async function runTranslationRuntimeFixture({
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
  const observations: { case: string; text: string }[] = [];
  const errors: string[] = [];
  const noApi = await makeContext(browser, userscript, watchHtml, false);
  try {
    const page = await noApi.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await openSettings(page);
    observations.push({
      case: 'api-unavailable',
      text: await waitPhase(page, 'unavailable', /no Translator API/u),
    });
    await page.screenshot({ path: join(output, 'translation-api-unavailable.png') });
  } finally {
    await noApi.close();
  }

  const supported = await makeContext(browser, userscript, watchHtml, true);
  try {
    const page = await supported.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await openSettings(page);
    observations.push({ case: 'active', text: await waitPhase(page, 'active', /en → en/u) });
    const target = page.locator(
      '#yt-chat-overlay-settings-backdrop select[name="translationTarget"]'
    );
    await target.selectOption('ko');
    observations.push({
      case: 'preparing',
      text: await waitPhase(page, 'preparing', /preparing/u),
    });
    await page.waitForFunction(() => window.__ytTranslationFixture?.creates.includes('ko'));
    await page.evaluate(() => window.__ytTranslationFixture?.emit('ko', 37));
    observations.push({
      case: 'download-progress',
      text: await waitPhase(page, 'downloading', /37%/u),
    });
    await page.evaluate(() => window.__ytTranslationFixture?.resolve('ko'));
    observations.push({
      case: 'download-complete',
      text: await waitPhase(page, 'active', /en → ko/u),
    });
    await target.selectOption('ja');
    observations.push({
      case: 'interaction-blocked',
      text: await waitPhase(page, 'needs-action', /blocked/u),
    });
    await target.selectOption('ko');
    await page.waitForFunction(
      () =>
        (window.__ytTranslationFixture?.creates.filter((value) => value === 'ko').length ?? 0) === 2
    );
    await target.selectOption('ar');
    observations.push({
      case: 'pair-unavailable',
      text: await waitPhase(page, 'unavailable', /selected language pair/u),
    });
    await page.evaluate(() => {
      window.__ytTranslationFixture?.emit('ko', 89);
      window.__ytTranslationFixture?.resolve('ko');
    });
    // Allow the superseded create() continuation to settle before checking the visible state.
    await page.waitForTimeout(150);
    observations.push({
      case: 'stale-result-discarded',
      text: await waitPhase(page, 'unavailable', /selected language pair/u),
    });
    const service = page.locator(
      '#yt-chat-overlay-settings-backdrop select[name="translationService"]'
    );
    await service.selectOption('off');
    observations.push({
      case: 'enabled-service-off',
      text: await waitPhase(page, 'off', /Service is Off/u),
    });
    await page.screenshot({ path: join(output, 'translation-service-off.png') });
    const enabled = page.locator(
      '#yt-chat-overlay-settings-backdrop input[name="translationEnabled"]'
    );
    await enabled.uncheck();
    observations.push({
      case: 'disabled',
      text: await waitPhase(page, 'off', /Translation is off/u),
    });
  } finally {
    await supported.close();
  }
  assert.deepEqual(errors, [], `Page errors: ${errors.join(' | ')}`);
  return {
    checks: {
      installedApplicationDelivery: false,
      sustainedViewingLifecycle: false,
      builtUserscriptFixture: true as const,
      builtUserscriptTranslationRuntime: true,
      translatorApiBoundaryControlled: true,
      staleModelProgressDiscarded: true,
      pageErrors: errors.length,
    },
    observations: { cases: observations, pageErrors: errors },
  };
}
