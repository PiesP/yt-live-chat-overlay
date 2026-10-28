// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, Route } from '@playwright/test';

import { installNativePageScriptProbe } from './native-page-script-probe.ts';
import { createMockWatchHtml } from './profile.ts';

const WATCH_URL = 'https://www.youtube.com/watch?v=windowsRequestDeadline';
const ENTRY = '\n\tmain();\n';
const SELECTOR = 'validation/windows/inputs/chat-request-deadline.json';
const RECOVERED_ID = 'windows-request-deadline-recovered';

type Source = {
  getHealthSnapshot(): { observerAlive: boolean; consecutiveErrors: number };
  getLatestMessages(count: number): Array<{ id?: string }>;
};
type Manager = { chatSource: Source | null; sessionGeneration: number };
declare global {
  interface Window {
    __ytRequestDeadline?: {
      manager: Manager | null;
      source: Source | null;
      app: Window['__ytChatOverlay'];
      generation: number | null;
    };
  }
}

export async function readChatRequestDeadlineSelector(root: string): Promise<boolean> {
  let input: string;
  try {
    input = await readFile(join(root, SELECTOR), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  assert.deepEqual(JSON.parse(input), { scenario: 'chat-request-deadline' });
  return true;
}

/** Real 20-second budget and retry sleep; only the HTTP fixture is delayed. */
export async function runChatRequestDeadline({
  context,
  root,
  output,
  extensionId,
}: {
  context: BrowserContext;
  root: string;
  output: string;
  extensionId: string;
}) {
  const source = await readFile(join(root, 'dist-extension/page-script.js'), 'utf8');
  assert.equal(source.split(ENTRY).length, 2);
  assert(source.includes('var RuntimeManager = class RuntimeManager'));
  const instrumented = source.replace(
    ENTRY,
    '\n\tconst deadlineState = window.__ytRequestDeadline;\n' +
      '\tif (!deadlineState) throw new Error("Deadline prelude unavailable");\n' +
      '\tconst originalDeadlineStart = RuntimeManager.prototype.start;\n' +
      '\tRuntimeManager.prototype.start = function(...args) {\n' +
      '\t\tdeadlineState.manager = this; return originalDeadlineStart.apply(this, args);\n' +
      `\t};${ENTRY}`
  );
  const html = createMockWatchHtml(await readFile(join(root, 'test/visual/preview.html'), 'utf8'));
  const page = await context.newPage();
  const requests: Array<{
    id: number;
    startedMs: number;
    finishedMs: number | null;
    status: number;
  }> = [];
  const errors: string[] = [];
  let overflow = 0;
  page.on('pageerror', (error) => {
    if (errors.length < 12) errors.push(error.name);
    else overflow++;
  });
  page.on('console', (entry) => {
    if (entry.type() !== 'error') return;
    if (/Failed to load resource: the server responded with a status of 503/u.test(entry.text()))
      return;
    if (errors.length < 12) errors.push(entry.text().slice(0, 200));
    else overflow++;
  });
  const routeHandler = async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:' && url.hostname === extensionId)
      return route.continue();
    if (url.href === WATCH_URL && route.request().resourceType() === 'document')
      return route.fulfill({ contentType: 'text/html', body: html });
    if (url.origin === 'https://www.youtube.com' && url.pathname === '/favicon.ico')
      return route.fulfill({ status: 204 });
    if (
      url.origin === 'https://www.youtube.com' &&
      url.pathname === '/youtubei/v1/live_chat/get_live_chat'
    ) {
      assert.equal(route.request().method(), 'POST');
      assert(requests.length < 12, 'Deadline fixture request bound exceeded');
      const record = {
        id: requests.length + 1,
        startedMs: performance.now(),
        finishedMs: null as number | null,
        status: requests.length === 1 ? 503 : 200,
      };
      requests.push(record);
      if (record.id === 2) await new Promise<void>((resolve) => setTimeout(resolve, 19_250));
      await route.fulfill({
        status: record.status,
        contentType: 'application/json',
        json:
          record.status === 503
            ? {}
            : {
                continuationContents: {
                  liveChatContinuation: {
                    actions:
                      record.id > 2
                        ? [
                            {
                              addChatItemAction: {
                                item: {
                                  liveChatTextMessageRenderer: {
                                    id: RECOVERED_ID,
                                    authorName: { simpleText: 'Deadline fixture' },
                                    message: { simpleText: 'Healthy chat after request timeout' },
                                  },
                                },
                              },
                            },
                          ]
                        : [],
                    continuations: [
                      {
                        timedContinuationData: { continuation: 'deadline-next', timeoutMs: 1_000 },
                      },
                    ],
                  },
                },
              },
      });
      record.finishedMs = performance.now();
      return;
    }
    if (errors.length < 12) errors.push(`Unexpected request: ${url.origin}${url.pathname}`);
    else overflow++;
    return route.fulfill({ status: 403, body: 'Blocked by deadline fixture' });
  };
  let probe: Awaited<ReturnType<typeof installNativePageScriptProbe>> | undefined;
  let result: Record<string, unknown> = { status: 'failed' };
  let primaryError: unknown;
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.route('**/*', routeHandler);
    await page.addInitScript(() => {
      window.__ytRequestDeadline = {
        manager: null,
        source: null,
        app: undefined,
        generation: null,
      };
      // Match the existing acquisition fixture's isolated playback prerequisite.
      Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
        configurable: true,
        get: () => false,
      });
      window.ytcfg = {
        data_: {
          INNERTUBE_API_KEY: 'windows-deadline-key',
          INNERTUBE_CONTEXT_CLIENT_NAME: '1',
          INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
        },
      };
      window.ytInitialData = {
        currentVideoEndpoint: { watchEndpoint: { videoId: 'windowsRequestDeadline' } },
        contents: {
          twoColumnWatchNextResults: {
            conversationBar: {
              liveChatRenderer: {
                isReplay: false,
                continuations: [
                  { timedContinuationData: { continuation: 'deadline-initial', timeoutMs: 1_000 } },
                ],
              },
            },
          },
        },
      };
    });
    probe = await installNativePageScriptProbe({
      context,
      root,
      extensionId,
      fixtureUrl: WATCH_URL,
      instrumentedSource: instrumented,
    });
    await probe.assertReady();
    await page.goto(WATCH_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        window.__ytChatOverlay &&
        window.__ytRequestDeadline?.manager?.chatSource?.getHealthSnapshot().observerAlive
    );
    const timeOrigin = await page.evaluate(() => {
      const state = window.__ytRequestDeadline;
      if (!state?.manager?.chatSource) throw new Error('Deadline source unavailable');
      state.source = state.manager.chatSource;
      state.app = window.__ytChatOverlay;
      state.generation = state.manager.sessionGeneration;
      return performance.timeOrigin;
    });
    await page.waitForFunction(
      () => window.__ytRequestDeadline?.source?.getHealthSnapshot().consecutiveErrors === 1,
      {},
      { timeout: 30_000 }
    );
    const failedHealth = await page.evaluate(() =>
      window.__ytRequestDeadline?.source?.getHealthSnapshot()
    );
    assert.equal(failedHealth?.observerAlive, true, 'Deadline retired the live poll loop');
    assert.equal(requests.length, 2, 'Expired API request issued an internal retry');
    const slow = requests[1];
    assert(
      slow?.finishedMs &&
        slow.finishedMs - slow.startedMs >= 19_250 &&
        slow.finishedMs - slow.startedMs < 20_000,
      '503 did not arrive inside the request deadline'
    );
    await page.waitForFunction(
      (id) =>
        window.__ytRequestDeadline?.source
          ?.getLatestMessages(10)
          .some((message) => message.id === id),
      RECOVERED_ID,
      { timeout: 15_000 }
    );
    const healthy = await page.evaluate(() => {
      const state = window.__ytRequestDeadline;
      return {
        timeOrigin: performance.timeOrigin,
        sameSource: state?.source === state?.manager?.chatSource,
        sameApp: state?.app === window.__ytChatOverlay,
        sameGeneration: state?.generation === state?.manager?.sessionGeneration,
        health: state?.source?.getHealthSnapshot(),
      };
    });
    assert.equal(healthy.timeOrigin, timeOrigin);
    assert.equal(healthy.sameSource, true);
    assert.equal(healthy.sameApp, true);
    assert.equal(healthy.sameGeneration, true);
    assert.equal(healthy.health?.consecutiveErrors, 0);
    assert.equal(healthy.health.observerAlive, true);
    assert.deepEqual(errors, []);
    assert.equal(overflow, 0);
    await probe.assertInjected();
    await page.screenshot({ path: join(output, 'chat-request-deadline.png') });
    await page.evaluate(async () => window.__ytChatOverlay?.stop());
    const atStop = requests.length;
    await page.waitForTimeout(1_200);
    assert.equal(requests.length, atStop, 'Stopped source issued another request');
    assert.equal(
      await page.evaluate(
        () => window.__ytRequestDeadline?.source?.getHealthSnapshot().observerAlive
      ),
      false
    );
    result = {
      status: 'passed',
      evidenceLayer: 'installed-extension-controlled-http',
      provenance: probe.provenance,
      timeOrigin,
      requests,
      failedHealth,
      healthy,
      errors,
      overflow,
      stoppedWithoutFurtherRequests: true,
    };
  } catch (error) {
    primaryError = error;
    result = { ...result, requests, errors, overflow, error: String(error).slice(0, 400) };
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    async () => {
      if (!page.isClosed()) await page.evaluate(async () => window.__ytChatOverlay?.stop());
    },
    async () => probe?.restore(),
    async () => page.unroute('**/*', routeHandler),
    async () => page.close(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await writeFile(
      join(output, 'chat-request-deadline.json'),
      JSON.stringify(
        { ...result, cleanup: { pageClosed: page.isClosed(), errors: cleanupErrors.map(String) } },
        null,
        2
      )
    );
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(primaryError ? [primaryError] : []), ...cleanupErrors],
      'Deadline fixture cleanup failed'
    );
  if (primaryError) throw primaryError;
  return result;
}
