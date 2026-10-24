// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Browser, BrowserContext, Page } from '@playwright/test';

import { mediaResponse } from './reload-feedback.ts';

const WATCH_URL = 'https://www.youtube.com/watch?v=windowsAcceptance';
const SETTINGS_KEY = 'yt-live-chat-overlay-settings';
const STATUS = '.yt-chat-overlay-settings-runtime-status';
const VIDEO_PATH = 'validation/windows/fixtures/autoplay-av.webm';
const VIDEO_SHA256 = '38d4e4e22c8aa3712a75c92bc70d461e3d6d0568fb75a146dfec2b91bd1b9cfe';
const VIDEO_URL = '/translation-fixture.webm';

type MediaRequest = { range: string | null; status: number };
type ChatProof = {
  id: string;
  original: string;
  rendered: string;
  canvas: { width: number; height: number };
};

declare global {
  interface Window {
    __ytTranslationFixture?: {
      emit: (target: string, percent: number) => void;
      resolve: (target: string) => string;
      creates: string[];
      destroyed: string[];
    };
  }
}

async function makeContext(
  browser: Browser,
  userscript: string,
  watchHtml: string,
  api: boolean,
  video: Buffer,
  mediaRequests: MediaRequest[],
  servedChatIds: string[]
): Promise<BrowserContext> {
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 720 },
  });
  await context.route(/^https?:\/\//u, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.youtube.com' && route.request().resourceType() === 'document') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: watchHtml });
    } else if (url.hostname === 'www.youtube.com' && url.pathname === VIDEO_URL) {
      const range = route.request().headers()['range'] ?? null;
      const response = mediaResponse(video, range);
      mediaRequests.push({ range, status: response.status });
      await route.fulfill({ ...response, contentType: 'video/webm' });
    } else if (url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat')) {
      const fixtureMessage = url.searchParams.get('fixture-message');
      if (fixtureMessage) servedChatIds.push(fixtureMessage);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          continuationContents: {
            liveChatContinuation: {
              actions: fixtureMessage
                ? [
                    {
                      addChatItemAction: {
                        item: {
                          liveChatTextMessageRenderer: {
                            id: fixtureMessage,
                            // Keep each state probe independent of the product's
                            // per-author chat rate limit (five messages per 5s).
                            authorName: { simpleText: `Fixture Viewer ${fixtureMessage}` },
                            message: { runs: [{ text: `Original chat ${fixtureMessage}` }] },
                          },
                        },
                      },
                    },
                  ]
                : [],
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
          translationTarget: 'es',
        })
      );
      if (!withApi) {
        Object.defineProperty(window, 'Translator', { configurable: true, value: undefined });
        return;
      }
      const pending = new Map<
        string,
        { token: string; monitor: EventTarget; resolve: (value: unknown) => void }[]
      >();
      const creates: string[] = [];
      const destroyed: string[] = [];
      const translator = (token: string) => ({
        translate: async (text: string) => `translated:${text}`,
        destroy: () => {
          destroyed.push(token);
        },
      });
      const fixture = {
        creates,
        destroyed,
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
          latest.resolve(translator(latest.token));
          return latest.token;
        },
      };
      window.__ytTranslationFixture = fixture;
      Object.defineProperty(window, 'Translator', {
        configurable: true,
        value: {
          availability: async ({
            sourceLanguage,
            targetLanguage,
          }: {
            sourceLanguage: string;
            targetLanguage: string;
          }) =>
            sourceLanguage === targetLanguage || targetLanguage === 'ar'
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
            const token = `${targetLanguage}-${creates.length}`;
            if (targetLanguage === 'ja')
              return Promise.reject(
                new DOMException('Controlled interaction block', 'NotAllowedError')
              );
            if (targetLanguage === 'zh-CN')
              return Promise.reject(new DOMException('Controlled setup failure', 'NetworkError'));
            if (targetLanguage !== 'ko') return Promise.resolve(translator(token));
            const target = new EventTarget();
            monitor?.(target);
            return new Promise((resolve) => {
              const entries = pending.get(targetLanguage) ?? [];
              entries.push({ token, monitor: target, resolve });
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
  await page
    .locator('#yt-live-chat-overlay canvas')
    .waitFor({ state: 'attached', timeout: 15_000 });
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

async function proveOriginalChat(page: Page, caseId: string): Promise<ChatProof> {
  const id = `translation-${caseId}`;
  const original = `Original chat ${id}`;
  await page.evaluate(async (messageId) => {
    const response = await fetch(
      `/youtubei/v1/live_chat/get_live_chat?key=translation-fixture-key&fixture-message=${encodeURIComponent(messageId)}`
    );
    if (!response.ok) throw new Error(`Fixture chat response: ${response.status}`);
    await response.json();
  }, id);
  await page.waitForFunction(
    ({ messageId, messageText }) => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>(
          '#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p'
        )
      ).find((element) => element.dataset.messageId === messageId);
      const canvas = document.querySelector<HTMLCanvasElement>('#yt-live-chat-overlay canvas');
      return Boolean(
        row?.textContent?.includes(messageText) && canvas && canvas.width > 0 && canvas.height > 0
      );
    },
    { messageId: id, messageText: original },
    { timeout: 15_000 }
  );
  return page.evaluate((messageId) => {
    const row = Array.from(
      document.querySelectorAll<HTMLElement>(
        '#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p'
      )
    ).find((element) => element.dataset.messageId === messageId);
    const canvas = document.querySelector<HTMLCanvasElement>('#yt-live-chat-overlay canvas');
    if (!row || !canvas) throw new Error('Original chat row or canvas disappeared');
    return {
      id: messageId,
      original: `Original chat ${messageId}`,
      rendered: row.textContent ?? '',
      canvas: { width: canvas.width, height: canvas.height },
    };
  }, id);
}

async function readVideo(page: Page) {
  return page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    if (!video) throw new Error('Native fixture video is missing');
    return {
      original: video.dataset.translationFixtureIdentity === 'original',
      paused: video.paused,
      time: video.currentTime,
      readyState: video.readyState,
      currentSrc: video.currentSrc,
      seekable: Array.from({ length: video.seekable.length }, (_, index) => ({
        start: video.seekable.start(index),
        end: video.seekable.end(index),
      })),
    };
  });
}

async function prepareVideo(page: Page) {
  await page.evaluate(async (src) => {
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    if (!video) throw new Error('Native fixture video is missing');
    video.dataset.translationFixtureIdentity = 'original';
    video.src = src;
    video.muted = true;
    video.loop = true;
    await video.play();
  }, VIDEO_URL);
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    return Boolean(video && video.readyState >= 2 && video.currentTime > 0.05);
  });
  const progressing = await readVideo(page);
  assert(progressing.original && !progressing.paused && progressing.time > 0.05);
  await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    if (!video) throw new Error('Native fixture video is missing');
    video.pause();
    video.currentTime = 0.8;
  });
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    return Boolean(
      video && video.paused && !video.seeking && Math.abs(video.currentTime - 0.8) < 0.15
    );
  });
  const seeked = await readVideo(page);
  assert(seeked.original && seeked.paused && seeked.seekable.length > 0);
  await page.evaluate(async () => {
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    if (!video) throw new Error('Native fixture video is missing');
    await video.play();
  });
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    return Boolean(video && !video.paused && video.currentTime > 0.9);
  });
  const resumed = await readVideo(page);
  assert(resumed.original && !resumed.paused && resumed.currentSrc === progressing.currentSrc);
  return { progressing, seeked, resumed };
}

/** Exercise actual built userscript state wiring with only the browser Translator API controlled. */
export async function runTranslationRuntimeFixture({
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
  const observations: {
    case: string;
    text: string;
    chat?: ChatProof;
    video: Awaited<ReturnType<typeof readVideo>>;
  }[] = [];
  const errors: string[] = [];
  const mediaRequests: MediaRequest[] = [];
  const servedChatIds: string[] = [];
  const discardedTokens: string[] = [];
  let phase = 'setup';
  let page: Page | null = null;
  let noApi: BrowserContext | null = null;
  let supported: BrowserContext | null = null;
  const media: {
    noApi?: Awaited<ReturnType<typeof prepareVideo>>;
    supported?: Awaited<ReturnType<typeof prepareVideo>>;
    final?: Awaited<ReturnType<typeof readVideo>>;
  } = {};
  const observe = async (caseName: string, expected: string, pattern: RegExp, chat = false) => {
    if (!page) throw new Error('Fixture page is unavailable');
    phase = caseName;
    const text = await waitPhase(page, expected, pattern);
    const proof = chat ? await proveOriginalChat(page, caseName) : undefined;
    const nativeVideo = await readVideo(page);
    assert(
      nativeVideo.original &&
        !nativeVideo.paused &&
        nativeVideo.readyState >= 2 &&
        nativeVideo.currentSrc.endsWith(VIDEO_URL),
      `${caseName}: native video did not remain playable`
    );
    observations.push({
      case: caseName,
      text,
      video: nativeVideo,
      ...(proof ? { chat: proof } : {}),
    });
  };
  try {
    const video = await readFile(join(root, VIDEO_PATH));
    assert.equal(createHash('sha256').update(video).digest('hex'), VIDEO_SHA256);
    noApi = await makeContext(
      browser,
      userscript,
      watchHtml,
      false,
      video,
      mediaRequests,
      servedChatIds
    );
    page = await noApi.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await openSettings(page);
    media.noApi = await prepareVideo(page);
    await observe('api-unavailable', 'unavailable', /no Translator API/u, true);
    await page.screenshot({ path: join(output, 'translation-api-unavailable.png') });
    await noApi.close();
    noApi = null;
    page = null;

    supported = await makeContext(
      browser,
      userscript,
      watchHtml,
      true,
      video,
      mediaRequests,
      servedChatIds
    );
    page = await supported.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await openSettings(page);
    media.supported = await prepareVideo(page);
    await observe('active', 'active', /en → es/u, true);
    const target = page.locator(
      '#yt-chat-overlay-settings-backdrop select[name="translationTarget"]'
    );
    await target.selectOption('ko');
    await observe('preparing', 'preparing', /preparing/u, true);
    await page.screenshot({ path: join(output, 'translation-preparing-original-chat.png') });
    await page.waitForFunction(() => window.__ytTranslationFixture?.creates.includes('ko'));
    await page.evaluate(() => window.__ytTranslationFixture?.emit('ko', 37));
    await observe('download-progress', 'downloading', /37%/u, true);
    await page.evaluate(() => window.__ytTranslationFixture?.resolve('ko'));
    await observe('download-complete', 'active', /en → ko/u, true);
    await target.selectOption('ja');
    await observe('interaction-blocked', 'needs-action', /blocked/u, true);
    await target.selectOption('zh-CN');
    await observe('create-failed', 'failed', /setup failed/u, true);
    await page.screenshot({ path: join(output, 'translation-failed-original-chat.png') });
    await target.selectOption('ko');
    await page.waitForFunction(
      () =>
        (window.__ytTranslationFixture?.creates.filter((value) => value === 'ko').length ?? 0) === 2
    );
    await target.selectOption('ar');
    await observe('pair-unavailable', 'unavailable', /selected language pair/u, true);
    const staleToken = await page.evaluate(() => {
      const fixture = window.__ytTranslationFixture;
      if (!fixture) throw new Error('Translator fixture control is missing');
      fixture.emit('ko', 89);
      return fixture.resolve('ko');
    });
    await page.waitForFunction(
      (token) => window.__ytTranslationFixture?.destroyed.includes(token),
      staleToken
    );
    discardedTokens.push(staleToken);
    await observe('stale-result-discarded', 'unavailable', /selected language pair/u);
    await target.selectOption('ko');
    await page.waitForFunction(
      () =>
        (window.__ytTranslationFixture?.creates.filter((value) => value === 'ko').length ?? 0) === 3
    );
    await page.evaluate(() => window.__ytTranslationFixture?.emit('ko', 18));
    await observe('service-off-pending-progress', 'downloading', /18%/u);
    const service = page.locator(
      '#yt-chat-overlay-settings-backdrop select[name="translationService"]'
    );
    await service.selectOption('off');
    await observe('enabled-service-off', 'off', /Service is Off/u, true);
    const serviceOffToken = await page.evaluate(() => {
      const fixture = window.__ytTranslationFixture;
      if (!fixture) throw new Error('Translator fixture control is missing');
      fixture.emit('ko', 91);
      return fixture.resolve('ko');
    });
    await page.waitForFunction(
      (token) => window.__ytTranslationFixture?.destroyed.includes(token),
      serviceOffToken
    );
    discardedTokens.push(serviceOffToken);
    await observe('service-off-late-result-discarded', 'off', /Service is Off/u);
    await page.screenshot({ path: join(output, 'translation-service-off.png') });
    await service.selectOption('auto');
    await page.waitForFunction(
      () =>
        (window.__ytTranslationFixture?.creates.filter((value) => value === 'ko').length ?? 0) === 4
    );
    await observe('disable-pending-create', 'preparing', /preparing/u);
    const enabled = page.locator(
      '#yt-chat-overlay-settings-backdrop input[name="translationEnabled"]'
    );
    await enabled.uncheck();
    await observe('disabled', 'off', /Translation is off/u, true);
    const disabledToken = await page.evaluate(() => {
      const fixture = window.__ytTranslationFixture;
      if (!fixture) throw new Error('Translator fixture control is missing');
      fixture.emit('ko', 82);
      return fixture.resolve('ko');
    });
    await page.waitForFunction(
      (token) => window.__ytTranslationFixture?.destroyed.includes(token),
      disabledToken
    );
    discardedTokens.push(disabledToken);
    await observe('disabled-late-result-discarded', 'off', /Translation is off/u);
    await enabled.check();
    await page.waitForFunction(
      () =>
        (window.__ytTranslationFixture?.creates.filter((value) => value === 'ko').length ?? 0) === 5
    );
    await page.evaluate(() => window.__ytTranslationFixture?.resolve('ko'));
    await observe('fresh-creation-after-disable', 'active', /en → ko/u);
    await enabled.uncheck();
    await observe('disabled-final', 'off', /Translation is off/u);

    media.final = await readVideo(page);
    assert(
      media.final.original && !media.final.paused,
      'Translation settings stopped native video'
    );
    assert.equal(media.final.currentSrc, media.supported.progressing.currentSrc);
    const previousTime = media.final.time;
    await page.waitForFunction((start) => {
      const video = document.querySelector<HTMLVideoElement>('#movie_player video');
      return Boolean(
        video &&
        !video.paused &&
        video.currentTime > 0.05 &&
        (video.currentTime > start + 0.1 || video.currentTime < start - 0.5)
      );
    }, previousTime);
    assert(mediaRequests.some((request) => request.range && request.status === 206));
    assert.deepEqual(errors, [], `Page errors: ${errors.join(' | ')}`);
    assert(observations.every((entry) => !entry.chat || servedChatIds.includes(entry.chat.id)));
    await page.screenshot({ path: join(output, 'translation-final-original-chat.png') });
    return {
      checks: {
        installedApplicationDelivery: false,
        sustainedViewingLifecycle: false,
        builtUserscriptFixture: true as const,
        builtUserscriptTranslationRuntime: true,
        translatorApiBoundaryControlled: true,
        originalChatRenderedAcrossStates: true,
        nativeVideoPreserved: true,
        staleModelProgressDiscarded: true,
        pendingDisableDiscarded: true,
        pageErrors: errors.length,
      },
      observations: {
        cases: observations,
        media,
        mediaRequests,
        servedChatIds,
        discardedTokens,
        videoSha256: VIDEO_SHA256,
        pageErrors: errors,
        browserVersion: browser.version(),
        scope:
          'built userscript with controlled Translator API; no real model download or live YouTube',
      },
    };
  } catch (error) {
    if (page)
      await page
        .screenshot({ path: join(output, 'translation-runtime-error.png') })
        .catch(() => undefined);
    await writeFile(
      join(output, 'translation-runtime-error.json'),
      JSON.stringify(
        {
          phase,
          error: String(error),
          cases: observations,
          media,
          mediaRequests,
          servedChatIds,
          discardedTokens,
          pageErrors: errors,
        },
        null,
        2
      )
    );
    throw error;
  } finally {
    await noApi?.close();
    await supported?.close();
  }
}
