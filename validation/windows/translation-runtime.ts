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
const LIFETIME_TEXT = {
  held: 'lifetime-held CJK 안녕하세요 日本語',
  queued: 'lifetime-queued RTL مرحبا emoji 🎉',
  replacement: 'lifetime-replacement 新しい 안녕 🎉',
  newHolder: 'lifetime-new-holder CJK 한국어 日本語 🌙',
  paid: 'lifetime-paid 후원 カード 🌙',
  released: 'lifetime-released temporary card',
} as const;
type AbortMode = 'supported' | 'ignored';
type RendererMode = 'natural' | 'forced-main';
type FixtureOptions = {
  abortMode?: AbortMode;
  rendererMode?: RendererMode;
  installWorkerProbe?: (expectedIds: string[]) => void;
  expectedIds?: string[];
};

export function fixtureChatAction(requestId: string): Record<string, unknown> {
  const replacement = requestId === 'lifetime-replace' || requestId === 'lifetime-held-replace';
  const id =
    requestId === 'lifetime-replace'
      ? 'lifetime-queued'
      : requestId === 'lifetime-held-replace'
        ? 'lifetime-held'
        : requestId;
  const text =
    requestId === 'lifetime-held'
      ? LIFETIME_TEXT.held
      : requestId === 'lifetime-queued'
        ? LIFETIME_TEXT.queued
        : requestId === 'lifetime-replace'
          ? LIFETIME_TEXT.replacement
          : requestId === 'lifetime-held-replace'
            ? LIFETIME_TEXT.newHolder
            : requestId === 'lifetime-paid'
              ? LIFETIME_TEXT.paid
              : requestId === 'lifetime-released'
                ? LIFETIME_TEXT.released
                : `Original chat ${requestId}`;
  const paid =
    requestId === 'lifetime-held' ||
    requestId === 'lifetime-held-replace' ||
    requestId === 'lifetime-paid';
  const item = paid
    ? {
        liveChatPaidMessageRenderer: {
          id,
          authorName: { simpleText: `Fixture Paid ${requestId}` },
          purchaseAmountText: { simpleText: '$5.00' },
          message: { simpleText: text },
        },
      }
    : {
        liveChatTextMessageRenderer: {
          id,
          authorName: { simpleText: `Fixture Viewer ${requestId}` },
          message: { runs: [{ text }] },
        },
      };
  return { [replacement ? 'replaceChatItemAction' : 'addChatItemAction']: { item } };
}

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
      createAborts: string[];
      createSettlements: string[];
      pendingCreateToken: (target: string) => string | null;
      translateCalls: Array<{ text: string; token: string }>;
      translateAborts: string[];
      translateSettlements: string[];
      hold: (text: string) => void;
      settleTranslate: (text: string, result: string) => string;
      abortMode: AbortMode;
    };
    __ytTranslationMainDraws?: {
      translatedTextDraws: number;
      staleTextDraws: number;
      cardRects: Array<{ width: number; height: number }>;
      maxCardHeight: number;
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
  servedChatIds: string[],
  options: FixtureOptions = {}
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
              actions: fixtureMessage ? [fixtureChatAction(fixtureMessage)] : [],
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
    ({ key, withApi, abortMode, rendererMode }) => {
      if (rendererMode === 'forced-main') {
        Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
          configurable: true,
          value: undefined,
        });
        const proof: NonNullable<Window['__ytTranslationMainDraws']> = {
          translatedTextDraws: 0,
          staleTextDraws: 0,
          cardRects: [],
          maxCardHeight: 0,
        };
        window.__ytTranslationMainDraws = proof;
        const nativeClearRect = CanvasRenderingContext2D.prototype.clearRect;
        CanvasRenderingContext2D.prototype.clearRect = function (x, y, width, height) {
          if (
            this.canvas instanceof HTMLCanvasElement &&
            this.canvas.closest('#yt-live-chat-overlay') &&
            x === 0 &&
            y === 0
          ) {
            proof.cardRects.length = 0;
          }
          return nativeClearRect.call(this, x, y, width, height);
        };
        const nativeRoundRect = CanvasRenderingContext2D.prototype.roundRect;
        CanvasRenderingContext2D.prototype.roundRect = function (x, y, width, height, radii) {
          if (
            this.canvas instanceof HTMLCanvasElement &&
            this.canvas.closest('#yt-live-chat-overlay') &&
            width >= 80 &&
            height >= 20 &&
            proof.cardRects.length < 64
          ) {
            proof.cardRects.push({ width, height });
            proof.maxCardHeight = Math.max(proof.maxCardHeight, height);
          }
          return nativeRoundRect.call(this, x, y, width, height, radii);
        };
        const original = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function (...args) {
          if (typeof args[0] === 'string' && args[0].includes('translated:lifetime-')) {
            proof.translatedTextDraws++;
          }
          if (typeof args[0] === 'string' && args[0].includes('STALE')) proof.staleTextDraws++;
          return Reflect.apply(original, this, args);
        };
      }
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
        {
          token: string;
          monitor: EventTarget;
          resolve: (value: unknown) => void;
          settled: boolean;
        }[]
      >();
      const creates: string[] = [];
      const destroyed: string[] = [];
      const createAborts: string[] = [];
      const createSettlements: string[] = [];
      const translateCalls: Array<{ text: string; token: string }> = [];
      const translateAborts: string[] = [];
      const translateSettlements: string[] = [];
      const held = new Set<string>();
      const pendingTranslations = new Map<
        string,
        Array<{
          token: string;
          settled: boolean;
          resolve: (value: string) => void;
        }>
      >();
      const translator = (token: string) => ({
        translate: (text: string, options?: { signal?: AbortSignal }) => {
          translateCalls.push({ text, token });
          if (options?.signal?.aborted) {
            translateSettlements.push(`${token}:AbortError`);
            return Promise.reject(new DOMException('Controlled preabort', 'AbortError'));
          }
          if (!held.has(text)) {
            translateSettlements.push(`${token}:fulfilled`);
            const output = text.startsWith('lifetime-')
              ? `translated:${text} ${'extended CJK RTL emoji card text '.repeat(5)}`
              : `translated:${text}`;
            return Promise.resolve(output);
          }
          return new Promise<string>((resolve, reject) => {
            const entry = {
              token,
              settled: false,
              resolve: (value: string) => {
                if (entry.settled) throw new Error('Controlled translation already settled');
                entry.settled = true;
                options?.signal?.removeEventListener('abort', onAbort);
                translateSettlements.push(`${token}:fulfilled`);
                resolve(value);
              },
            };
            const onAbort = () => {
              translateAborts.push(`${token}:${text}`);
              if (abortMode === 'supported' && !entry.settled) {
                entry.settled = true;
                options?.signal?.removeEventListener('abort', onAbort);
                translateSettlements.push(`${token}:AbortError`);
                reject(new DOMException('Controlled translation abort', 'AbortError'));
              }
            };
            options?.signal?.addEventListener('abort', onAbort, { once: true });
            const entries = pendingTranslations.get(text) ?? [];
            entries.push(entry);
            pendingTranslations.set(text, entries);
          });
        },
        destroy: () => {
          destroyed.push(token);
        },
      });
      const fixture = {
        abortMode,
        creates,
        destroyed,
        createAborts,
        createSettlements,
        pendingCreateToken(target: string) {
          return pending.get(target)?.find((entry) => !entry.settled)?.token ?? null;
        },
        translateCalls,
        translateAborts,
        translateSettlements,
        hold(text: string) {
          held.add(text);
        },
        settleTranslate(text: string, result: string) {
          const latest = pendingTranslations.get(text)?.find((entry) => !entry.settled);
          if (!latest) throw new Error('No unsettled controlled translation');
          latest.resolve(result);
          return latest.token;
        },
        emit(target: string, percent: number) {
          const latest = pending.get(target)?.at(-1);
          if (!latest) throw new Error(`No pending ${target} translator`);
          latest.monitor.dispatchEvent(
            Object.assign(new Event('downloadprogress'), { loaded: percent / 100, total: 1 })
          );
        },
        resolve(target: string) {
          const latest = pending.get(target)?.find((entry) => !entry.settled);
          if (!latest) throw new Error(`No pending ${target} translator`);
          latest.settled = true;
          createSettlements.push(latest.token);
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
            signal,
          }: {
            targetLanguage: string;
            monitor?: (target: EventTarget) => void;
            signal?: AbortSignal;
          }) => {
            creates.push(targetLanguage);
            const token = `${targetLanguage}-${creates.length}`;
            if (signal?.aborted) {
              createSettlements.push(`${token}:AbortError`);
              return Promise.reject(new DOMException('Controlled creation preabort', 'AbortError'));
            }
            if (targetLanguage === 'ja')
              return Promise.reject(
                new DOMException('Controlled interaction block', 'NotAllowedError')
              );
            if (targetLanguage === 'zh-CN')
              return Promise.reject(new DOMException('Controlled setup failure', 'NetworkError'));
            if (targetLanguage !== 'ko') {
              createSettlements.push(token);
              return Promise.resolve(translator(token));
            }
            const target = new EventTarget();
            monitor?.(target);
            return new Promise((resolve, reject) => {
              const onAbort = () => {
                createAborts.push(token);
                if (abortMode === 'supported' && !entry.settled) {
                  entry.settled = true;
                  signal?.removeEventListener('abort', onAbort);
                  createSettlements.push(`${token}:AbortError`);
                  reject(new DOMException('Controlled creation abort', 'AbortError'));
                }
              };
              const entry = {
                token,
                monitor: target,
                settled: false,
                resolve: (value: unknown) => {
                  signal?.removeEventListener('abort', onAbort);
                  resolve(value);
                },
              };
              signal?.addEventListener('abort', onAbort, { once: true });
              const entries = pending.get(targetLanguage) ?? [];
              entries.push(entry);
              pending.set(targetLanguage, entries);
            });
          },
        },
      });
    },
    {
      key: SETTINGS_KEY,
      withApi: api,
      abortMode: options.abortMode ?? 'ignored',
      rendererMode: options.rendererMode ?? 'natural',
    }
  );
  if (options.installWorkerProbe) {
    await context.addInitScript(options.installWorkerProbe, options.expectedIds ?? []);
  }
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

async function requestFixtureChat(page: Page, requestId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const response = await fetch(
      `/youtubei/v1/live_chat/get_live_chat?key=translation-fixture-key&fixture-message=${encodeURIComponent(id)}`
    );
    if (!response.ok) throw new Error(`Fixture chat response: ${response.status}`);
    await response.json();
  }, requestId);
}

async function waitForChatRow(page: Page, id: string, text: string): Promise<void> {
  await page.waitForFunction(
    ({ messageId, content }) =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p'
        )
      ).some((row) => row.dataset.messageId === messageId && row.textContent?.includes(content)),
    { messageId: id, content: text },
    { timeout: 15_000 }
  );
}

async function sampleCanvasInk(
  page: Page
): Promise<{ status: 'sampled' | 'unavailable'; alphaPixels: number }> {
  return page.evaluate(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>('#yt-live-chat-overlay canvas');
    if (!canvas || canvas.width < 1 || canvas.height < 1)
      return { status: 'unavailable', alphaPixels: 0 };
    try {
      const bitmap = await createImageBitmap(canvas);
      try {
        const scratch = new OffscreenCanvas(192, 108);
        const context = scratch.getContext('2d', { willReadFrequently: true });
        if (!context) return { status: 'unavailable', alphaPixels: 0 };
        context.drawImage(bitmap, 0, 0, 192, 108);
        const pixels = context.getImageData(0, 0, 192, 108).data;
        let alphaPixels = 0;
        for (let index = 3; index < pixels.length; index += 4) {
          if ((pixels[index] ?? 0) > 8) alphaPixels++;
        }
        return { status: 'sampled', alphaPixels };
      } finally {
        bitmap.close();
      }
    } catch {
      return { status: 'unavailable', alphaPixels: 0 };
    }
  });
}

type LifetimeRoute = {
  renderer: 'forced-main' | 'natural-worker';
  abortMode: AbortMode;
  status: 'observed' | 'worker-unavailable';
  nativeCallsBeforeRawSettlement: number;
  nativeCallsAfterRawSettlement: number;
  abortedHeld: boolean;
  rawHeldSettlement: string;
  releasedQueuedNeverStarted: boolean;
  replacedQueuedNeverStarted: boolean;
  staleTranslationDrawn: boolean;
  worker: {
    ready: boolean;
    addedIds: string[];
    activeIds: string[];
    translationUpdates: number;
    geometryReflows: number;
  } | null;
  mainTranslatedDraws: number | null;
  mainGeometryReflow: number | null;
  ink: { status: 'sampled' | 'unavailable'; alphaPixels: number };
  video: { before: number; after: number; sameSource: boolean };
};

export function countWorkerTranslationReflows(
  sent: readonly { id: string; width: number; height: number; sequence: number }[],
  updates: readonly {
    id: string;
    width: number;
    height: number;
    translationHeight: number;
    sequence: number;
  }[]
): number {
  return updates.filter((entry) => {
    const base = sent
      .filter((item) => item.id === entry.id && item.sequence < entry.sequence)
      .at(-1);
    return Boolean(
      base &&
      entry.translationHeight > 0 &&
      (entry.width > base.width || entry.height > base.height)
    );
  }).length;
}

async function runLifetimeRoute({
  browser,
  userscript,
  watchHtml,
  video,
  mediaRequests,
  servedChatIds,
  renderer,
  abortMode,
  installWorkerProbe,
  output,
}: {
  browser: Browser;
  userscript: string;
  watchHtml: string;
  video: Buffer;
  mediaRequests: MediaRequest[];
  servedChatIds: string[];
  renderer: LifetimeRoute['renderer'];
  abortMode: AbortMode;
  installWorkerProbe?: (expectedIds: string[]) => void;
  output: string;
}): Promise<LifetimeRoute> {
  const ids = ['lifetime-held', 'lifetime-queued', 'lifetime-released', 'lifetime-paid'];
  const context = await makeContext(
    browser,
    userscript,
    watchHtml,
    true,
    video,
    mediaRequests,
    servedChatIds,
    {
      abortMode,
      rendererMode: renderer === 'forced-main' ? 'forced-main' : 'natural',
      ...(installWorkerProbe ? { installWorkerProbe } : {}),
      expectedIds: ids,
    }
  );
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.name));
  try {
    await openSettings(page);
    const player = await prepareVideo(page);
    await waitPhase(page, 'active', /en → es/u);
    await page.evaluate(async () => {
      const app = window.__ytChatOverlay;
      if (!app) throw new Error('Product app handle is missing');
      await app.applySettings({ topBottomDurationMs: 30_000, showDebugOverlay: false });
    });
    if (renderer === 'natural-worker') {
      try {
        await page.waitForFunction(
          () => window.__ytAcceptanceWorkers?.some((record) => record.ready),
          null,
          { timeout: 10_000 }
        );
      } catch {
        return {
          renderer,
          abortMode,
          status: 'worker-unavailable',
          nativeCallsBeforeRawSettlement: 0,
          nativeCallsAfterRawSettlement: 0,
          abortedHeld: false,
          rawHeldSettlement: 'not-run',
          releasedQueuedNeverStarted: false,
          replacedQueuedNeverStarted: false,
          staleTranslationDrawn: false,
          worker: null,
          mainTranslatedDraws: null,
          mainGeometryReflow: null,
          ink: { status: 'unavailable', alphaPixels: 0 },
          video: { before: player.resumed.time, after: player.resumed.time, sameSource: true },
        };
      }
    }
    await page.evaluate((text) => {
      const fixture = window.__ytTranslationFixture;
      if (!fixture) throw new Error('Controlled Translator is missing');
      fixture.hold(text);
    }, LIFETIME_TEXT.held);
    await requestFixtureChat(page, 'lifetime-held');
    await waitForChatRow(page, 'lifetime-held', LIFETIME_TEXT.held);
    await page.waitForFunction(
      (text) => window.__ytTranslationFixture?.translateCalls.some((entry) => entry.text === text),
      LIFETIME_TEXT.held,
      { timeout: 15_000 }
    );
    const heldToken = await page.evaluate(
      (text) =>
        window.__ytTranslationFixture?.translateCalls.find((entry) => entry.text === text)?.token ??
        null,
      LIFETIME_TEXT.held
    );
    assert(heldToken, 'Held native translation token is missing');
    await page.evaluate(async () => {
      const app = window.__ytChatOverlay;
      if (!app) throw new Error('Product app handle is missing');
      const settings = app.getSettings();
      await app.applySettings({ showDebugOverlay: !settings.showDebugOverlay });
    });
    assert.equal(
      await page.evaluate(
        (text) =>
          window.__ytTranslationFixture?.translateAborts.some((entry) =>
            entry.endsWith(`:${text}`)
          ),
        LIFETIME_TEXT.held
      ),
      false,
      'Unrelated nonvisual setting cancelled pending translation'
    );
    await page.waitForFunction(
      (workerExpected) => {
        const status = document.querySelector('#yt-chat-overlay-debug')?.textContent ?? '';
        return status.includes('Render:') && status.includes('Render: n/a') === workerExpected;
      },
      renderer === 'natural-worker',
      { timeout: 15_000 }
    );
    await requestFixtureChat(page, 'lifetime-queued');
    await waitForChatRow(page, 'lifetime-queued', LIFETIME_TEXT.queued);
    await requestFixtureChat(page, 'lifetime-released');
    await waitForChatRow(page, 'lifetime-released', LIFETIME_TEXT.released);
    await requestFixtureChat(page, 'lifetime-paid');
    await waitForChatRow(page, 'lifetime-paid', LIFETIME_TEXT.paid);
    await requestFixtureChat(page, 'lifetime-replace');
    await waitForChatRow(page, 'lifetime-queued', LIFETIME_TEXT.replacement);
    await page.waitForFunction(
      () =>
        !Array.from(
          document.querySelectorAll<HTMLElement>(
            '#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p'
          )
        ).some((row) => row.dataset.messageId === 'lifetime-released'),
      null,
      { timeout: 15_000 }
    );
    const before = await page.evaluate(
      () => window.__ytTranslationFixture?.translateCalls.length ?? 0
    );
    assert.equal(before, 1, 'Queued native work started before the held native call settled');
    assert.equal(
      await page.evaluate(
        (text) =>
          window.__ytTranslationFixture?.translateAborts.some((entry) =>
            entry.endsWith(`:${text}`)
          ),
        LIFETIME_TEXT.held
      ),
      false,
      'Nonvisual setting or unrelated ingress cancelled the held translation'
    );
    await requestFixtureChat(page, 'lifetime-held-replace');
    await waitForChatRow(page, 'lifetime-held', LIFETIME_TEXT.newHolder);
    await page.waitForFunction(
      (text) =>
        window.__ytTranslationFixture?.translateAborts.some((entry) => entry.endsWith(`:${text}`)),
      LIFETIME_TEXT.held,
      { timeout: 15_000 }
    );
    let baselineCardHeight: number | null = null;
    if (renderer === 'forced-main') {
      await page.waitForFunction(
        () => (window.__ytTranslationMainDraws?.cardRects.length ?? 0) > 0,
        null,
        { timeout: 5_000 }
      );
      baselineCardHeight = await page.evaluate(() =>
        Math.max(
          0,
          ...(window.__ytTranslationMainDraws?.cardRects.map((rect) => rect.height) ?? [])
        )
      );
      assert(baselineCardHeight > 0, 'Main paid-card baseline geometry is missing');
      await page.evaluate((baseline) => {
        if (window.__ytTranslationMainDraws)
          window.__ytTranslationMainDraws.maxCardHeight = baseline;
      }, baselineCardHeight);
    }
    let rawHeldSettlement: string;
    if (abortMode === 'ignored') {
      const pendingRaw = await page.evaluate((token) => {
        const fixture = window.__ytTranslationFixture;
        return {
          calls: fixture?.translateCalls.length ?? 0,
          settled:
            fixture?.translateSettlements.some((entry) => entry.startsWith(`${token}:`)) ?? false,
        };
      }, heldToken);
      assert.equal(
        pendingRaw.calls,
        before,
        'Local caller cancellation was mistaken for native settlement'
      );
      assert.equal(pendingRaw.settled, false, 'Ignored abort settled the raw native Promise');
      await page.evaluate(
        (text) =>
          window.__ytTranslationFixture?.settleTranslate(
            text,
            'translated:STALE old holder result'
          ),
        LIFETIME_TEXT.held
      );
      rawHeldSettlement = `${heldToken}:fulfilled`;
    } else {
      rawHeldSettlement = `${heldToken}:AbortError`;
    }
    await page.waitForFunction(
      (expected) => window.__ytTranslationFixture?.translateSettlements.includes(expected),
      rawHeldSettlement,
      { timeout: 15_000 }
    );
    await page.waitForFunction(
      (text) => window.__ytTranslationFixture?.translateCalls.some((entry) => entry.text === text),
      LIFETIME_TEXT.newHolder,
      { timeout: 15_000 }
    );
    await page.waitForFunction(
      (text) => window.__ytTranslationFixture?.translateCalls.some((entry) => entry.text === text),
      LIFETIME_TEXT.paid,
      { timeout: 15_000 }
    );
    if (renderer === 'natural-worker') {
      await page.waitForFunction(
        () => {
          const record = window.__ytAcceptanceWorkers?.at(-1);
          return Boolean(
            record?.ready &&
            record.translationUpdates.some(
              (entry) => entry.id === 'lifetime-paid' || entry.id === 'lifetime-held'
            ) &&
            record.recentStats.some(
              (entry) =>
                Array.isArray(entry.activeDeclaredIds) &&
                entry.activeDeclaredIds.includes('lifetime-paid')
            )
          );
        },
        null,
        { timeout: 15_000 }
      );
    } else {
      await page.waitForFunction(
        () => (window.__ytTranslationMainDraws?.translatedTextDraws ?? 0) > 0,
        null,
        { timeout: 15_000 }
      );
    }
    const native = await page.evaluate(() => {
      const fixture = window.__ytTranslationFixture;
      if (!fixture) throw new Error('Controlled Translator is missing');
      return {
        calls: fixture.translateCalls.map((entry) => entry.text),
        aborts: fixture.translateAborts.slice(),
        settlements: fixture.translateSettlements.slice(),
      };
    });
    assert(
      !native.calls.includes(LIFETIME_TEXT.queued),
      'Replaced queued work reached native translate'
    );
    assert(
      !native.calls.includes(LIFETIME_TEXT.released),
      'Released queued work reached native translate'
    );
    const ink = await sampleCanvasInk(page);
    assert(
      ink.status === 'sampled' && ink.alphaPixels >= 8,
      `${renderer}: positive overlay ink was not observed`
    );
    const renderProof = await page.evaluate(() => ({
      main: window.__ytTranslationMainDraws ?? null,
      worker: window.__ytAcceptanceWorkers?.at(-1) ?? null,
    }));
    let worker: LifetimeRoute['worker'] = null;
    let mainTranslatedDraws: number | null = null;
    let mainGeometryReflow: number | null = null;
    let staleTranslationDrawn = false;
    if (renderer === 'natural-worker') {
      const record = renderProof.worker;
      assert(record?.ready, 'Product Worker never became ready');
      const addedIds = record.addedMessageIds.flat();
      const activeIds = record.recentStats.flatMap((entry) =>
        Array.isArray(entry.activeDeclaredIds) ? (entry.activeDeclaredIds as string[]) : []
      );
      const updates = record.translationUpdates.filter(
        (entry) =>
          (entry.id === 'lifetime-held' || entry.id === 'lifetime-paid') &&
          entry.textLength > 0 &&
          entry.width > 0 &&
          entry.height > 0
      );
      const geometryReflows = countWorkerTranslationReflows(record.sentGeometries, updates);
      assert(
        addedIds.includes('lifetime-held') && addedIds.includes('lifetime-paid'),
        'Product Worker did not receive the paid-card fixture IDs'
      );
      assert(activeIds.includes('lifetime-paid'), 'Product Worker paid card was not active');
      assert(updates.length > 0, 'Product Worker translation geometry update was not observed');
      assert(geometryReflows > 0, 'Product Worker translated card did not reflow');
      staleTranslationDrawn = record.translationUpdates.some((entry) => entry.staleMarker);
      worker = {
        ready: true,
        addedIds: addedIds.filter((id) => ids.includes(id)).slice(0, 16),
        activeIds: activeIds.filter((id) => ids.includes(id)).slice(-16),
        translationUpdates: updates.length,
        geometryReflows,
      };
    } else {
      mainTranslatedDraws = renderProof.main?.translatedTextDraws ?? null;
      assert(
        mainTranslatedDraws && mainTranslatedDraws > 0,
        'Main-thread renderer did not draw controlled translated text'
      );
      assert.equal(
        renderProof.worker?.ready ?? false,
        false,
        'Forced Main fallback unexpectedly started a Worker'
      );
      assert(baselineCardHeight !== null);
      await page.waitForFunction(
        (base) => (window.__ytTranslationMainDraws?.maxCardHeight ?? 0) > base + 2,
        baselineCardHeight,
        { timeout: 10_000 }
      );
      mainGeometryReflow =
        (await page.evaluate(() => window.__ytTranslationMainDraws?.maxCardHeight ?? 0)) -
        baselineCardHeight;
      staleTranslationDrawn = (renderProof.main?.staleTextDraws ?? 0) > 0;
    }
    assert.equal(staleTranslationDrawn, false, 'Late old-message translation was rendered');
    const start = player.resumed.time;
    await page.waitForFunction(
      (time) => {
        const video = document.querySelector<HTMLVideoElement>('#movie_player video');
        return Boolean(
          video &&
          !video.paused &&
          (video.currentTime > time + 0.1 || video.currentTime < time - 0.5)
        );
      },
      start,
      { timeout: 15_000 }
    );
    const finalVideo = await readVideo(page);
    assert(
      finalVideo.original &&
        !finalVideo.paused &&
        finalVideo.currentSrc === player.resumed.currentSrc
    );
    assert.deepEqual(pageErrors, [], `${renderer}: product page errors`);
    return {
      renderer,
      abortMode,
      status: 'observed',
      nativeCallsBeforeRawSettlement: before,
      nativeCallsAfterRawSettlement: native.calls.length,
      abortedHeld: native.aborts.some((entry) => entry === `${heldToken}:${LIFETIME_TEXT.held}`),
      rawHeldSettlement,
      releasedQueuedNeverStarted: !native.calls.includes(LIFETIME_TEXT.released),
      replacedQueuedNeverStarted: !native.calls.includes(LIFETIME_TEXT.queued),
      staleTranslationDrawn,
      worker,
      mainTranslatedDraws,
      mainGeometryReflow,
      ink,
      video: {
        before: start,
        after: finalVideo.time,
        sameSource: finalVideo.currentSrc === player.resumed.currentSrc,
      },
    };
  } catch (error) {
    await page
      .screenshot({ path: join(output, `translation-lifetime-${renderer}-error.png`) })
      .catch(() => undefined);
    await writeFile(
      join(output, `translation-lifetime-${renderer}-error.json`),
      JSON.stringify(
        {
          renderer,
          abortMode,
          error: String(error),
          pageErrors,
          controlled: await page
            .evaluate(() => {
              const fixture = window.__ytTranslationFixture;
              return fixture
                ? {
                    creates: fixture.creates,
                    createSettlements: fixture.createSettlements,
                    translateCalls: fixture.translateCalls.map((entry) => entry.text),
                    translateAborts: fixture.translateAborts,
                    translateSettlements: fixture.translateSettlements,
                  }
                : null;
            })
            .catch(() => null),
        },
        null,
        2
      )
    );
    throw error;
  } finally {
    await context.close();
  }
}

/** Exercise actual built userscript state wiring with only the browser Translator API controlled. */
export async function runTranslationRuntimeFixture({
  browser,
  root,
  output,
  userscript,
  watchHtml,
  installWorkerProbe,
}: {
  browser: Browser;
  root: string;
  output: string;
  userscript: string;
  watchHtml: string;
  installWorkerProbe?: (expectedIds: string[]) => void;
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
  const lifetimeRoutes: LifetimeRoute[] = [];
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
    await target.selectOption('es');
    const beforeRawSettlement = await page.evaluate(() => {
      const fixture = window.__ytTranslationFixture;
      if (!fixture) throw new Error('Translator fixture control is missing');
      const token = fixture.pendingCreateToken('ko');
      if (!token) throw new Error('Unsettled controlled create was not observed');
      return {
        creates: fixture.creates.length,
        token,
        rawSettled: fixture.createSettlements.includes(token),
      };
    });
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(() => window.__ytTranslationFixture?.creates.length),
      beforeRawSettlement.creates,
      'Replacement create overlapped the old raw create'
    );
    assert.equal(beforeRawSettlement.rawSettled, false, 'Ignored abort settled raw creation');
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
    assert.equal(staleToken, beforeRawSettlement.token);
    await page.waitForFunction(
      (count) => window.__ytTranslationFixture?.creates.length === count + 1,
      beforeRawSettlement.creates
    );
    await observe('replacement-after-raw-settlement', 'active', /en → es/u);
    await target.selectOption('ar');
    await observe('pair-unavailable', 'unavailable', /selected language pair/u, true);
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
    for (const route of [
      { renderer: 'forced-main' as const, abortMode: 'ignored' as const },
      { renderer: 'natural-worker' as const, abortMode: 'supported' as const },
    ]) {
      const observed = await runLifetimeRoute({
        browser,
        userscript,
        watchHtml,
        video,
        mediaRequests,
        servedChatIds,
        output,
        ...route,
        ...(installWorkerProbe ? { installWorkerProbe } : {}),
      });
      lifetimeRoutes.push(observed);
    }
    assert(
      lifetimeRoutes.every((route) => route.status === 'observed'),
      'Worker translation runtime was unavailable; run existing deterministic Worker fixture separately'
    );
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
        lifetimeMainObserved: lifetimeRoutes[0]?.status === 'observed',
        lifetimeWorkerObserved: lifetimeRoutes[1]?.status === 'observed',
        pageErrors: errors.length,
      },
      observations: {
        cases: observations,
        media,
        mediaRequests,
        servedChatIds,
        discardedTokens,
        lifetimeRoutes,
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
          lifetimeRoutes,
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
