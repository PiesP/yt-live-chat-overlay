// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, test } from '@playwright/test';

import {
  DEFAULT_SETTINGS,
  injectUserscript,
  installYTMock,
  setupMockPageRoute,
} from '../fixtures/test-utils';

test('userscript intercepts real page fetches with foreign-realm Request and URL inputs', async ({
  page,
}) => {
  await setupMockPageRoute(page);
  await page.route('**/youtubei/v1/live_chat/get_live_chat**', async (route) => {
    const realm = new URL(route.request().url()).searchParams.get('realm');
    await route.fulfill({
      json: {
        continuationContents: {
          liveChatContinuation: {
            actions: realm
              ? [
                  {
                    addChatItemAction: {
                      item: {
                        liveChatTextMessageRenderer: {
                          id: `foreign-${realm}`,
                          authorName: { simpleText: 'Realm test' },
                          message: { runs: [{ text: `From ${realm}` }] },
                        },
                      },
                    },
                  },
                ]
              : [],
            continuations: [{ timedContinuationData: { continuation: 'next', timeoutMs: 30_000 } }],
          },
        },
      },
    });
  });
  await page.addInitScript(() => {
    window.ytcfg = {
      data_: {
        INNERTUBE_API_KEY: 'e2e-key',
        INNERTUBE_CONTEXT_CLIENT_NAME: '1',
        INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
        INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
      },
    };
    window.ytInitialData = {
      currentVideoEndpoint: { watchEndpoint: { videoId: 'realm-video' } },
      contents: {
        twoColumnWatchNextResults: {
          conversationBar: {
            liveChatRenderer: {
              isReplay: false,
              continuations: [
                {
                  timedContinuationData: {
                    continuation: 'initial-live',
                    timeoutMs: 30_000,
                  },
                },
              ],
            },
          },
        },
      },
    };
  });
  await page.addInitScript(installYTMock, {
    defaults: {
      ...DEFAULT_SETTINGS,
      allowShortTextMessages: true,
      authorRateLimit: 'off',
      logLevel: 'debug',
    },
    platform: 'userscript' as const,
  });
  await injectUserscript(page);
  await page.goto('https://www.youtube.com/watch?v=realm-video', {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => Boolean(window.__ytChatOverlay));

  for (const kind of ['Request', 'URL'] as const) {
    const received = page.waitForEvent('console', {
      predicate: (message) =>
        message.text().includes('[FetchInterceptor]') &&
        message.text().includes('chat.interceptor.messages-received'),
    });
    const [foreign, message] = await Promise.all([
      page.evaluate(async (inputKind) => {
        const iframe = document.createElement('iframe');
        document.body.append(iframe);
        try {
          const foreignWindow = iframe.contentWindow as (Window & typeof globalThis) | null;
          if (!foreignWindow) throw new Error('Foreign realm is unavailable');
          const url = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?realm=${inputKind}`;
          const input =
            inputKind === 'Request' ? new foreignWindow.Request(url) : new foreignWindow.URL(url);
          const isForeign =
            inputKind === 'Request' ? !(input instanceof Request) : !(input instanceof URL);
          const response = await fetch(input);
          await response.json();
          return isForeign;
        } finally {
          iframe.remove();
        }
      }, kind),
      received,
    ]);
    expect(foreign).toBe(true);
    expect(message.type()).toBe('debug');
    expect(await message.args()[2]?.jsonValue()).toMatchObject({ count: 1 });
  }
});
