// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MOCK_WATCH_URL = 'https://www.youtube.com/watch?v=windowsAcceptance';
const USERSCRIPT_PATH = 'dist/yt-live-chat-overlay.user.js';
const PREVIEW_PATH = 'test/visual/preview.html';
const GM_MOCKS_PATH = 'test/visual/gm-mocks.js';
const EXPECTED_MESSAGE_COUNT = 6;

const CHAT_RESPONSE = {
  continuationContents: {
    liveChatContinuation: {
      actions: [
        messageAction('acceptance-korean', '한국어', [{ text: '안녕하세요 Windows 화면 검증입니다 🌙' }]),
        messageAction('acceptance-japanese', '日本語', [{ text: '日本語の描画を確認します ✨' }]),
        messageAction('acceptance-rtl', 'العربية', [
          { text: 'مرحبا بكم — RTL + English 123' },
        ]),
        messageAction('acceptance-emoji', 'Emoji', [
          { text: 'Custom ' },
          {
            emoji: {
              shortcuts: [':party:'],
              image: {
                accessibility: { accessibilityData: { label: 'party emoji' } },
                thumbnails: [
                  {
                    url: 'https://yt3.ggpht.com/windows-acceptance-party=s32',
                    width: 32,
                    height: 32,
                  },
                ],
              },
            },
          },
          { text: ' emoji 🎉' },
        ]),
        {
          addChatItemAction: {
            item: {
              liveChatPaidMessageRenderer: {
                id: 'acceptance-superchat',
                authorName: { simpleText: 'Super Chat' },
                purchaseAmountText: { simpleText: '$5.00' },
                message: { simpleText: '후원 카드의 긴 본문과 경계가 잘 보이는지 확인합니다.' },
              },
            },
          },
        },
        {
          addChatItemAction: {
            item: {
              liveChatMembershipItemRenderer: {
                id: 'acceptance-membership',
                authorName: { simpleText: 'Member' },
                headerPrimaryText: { simpleText: 'Member for 12 months' },
                message: { simpleText: 'メンバーシップ 카드 렌더링' },
              },
            },
          },
        },
      ],
      continuations: [
        {
          timedContinuationData: {
            continuation: 'windows-acceptance-next',
            timeoutMs: 30_000,
          },
        },
      ],
    },
  },
};

function messageAction(id, author, runs) {
  return {
    addChatItemAction: {
      item: {
        liveChatTextMessageRenderer: {
          id,
          authorName: { simpleText: author },
          message: { runs },
        },
      },
    },
  };
}

function createMockWatchHtml(previewHtml) {
  const withVideo = previewHtml.replace(
    '<div class="player-inner">Video Player Placeholder</div>',
    '<video aria-label="Acceptance fixture video" style="width:100%;height:100%"></video>',
  );
  assert.notEqual(withVideo, previewHtml, 'Preview fixture no longer contains the expected player');

  const chat = `
  <div id="chat" style="display:block;position:absolute;left:-10000px;top:0">
    <yt-live-chat-item-list-renderer><div id="items"></div></yt-live-chat-item-list-renderer>
  </div>`;
  assert.match(withVideo, /<\/body>/u, 'Preview fixture does not contain a body element');
  return withVideo.replace(
    '</head>',
    '<style>.player-wrapper{max-width:1150px}#movie_player{height:640px;aspect-ratio:auto}</style></head>',
  ).replace('</body>', `${chat}\n</body>`);
}

async function configureThroughSettingsUi(page) {
  const button = page.locator('#yt-chat-overlay-settings-button');
  await button.waitFor({ state: 'visible', timeout: 15_000 });
  await button.focus();
  await page.keyboard.press('Enter');

  const modal = page.locator('#yt-chat-overlay-settings-backdrop');
  await modal.waitFor({ state: 'visible', timeout: 5_000 });
  assert.equal(await modal.getAttribute('aria-modal'), 'true');

  await modal.locator('select[name="danmakuMode"]').selectOption('scroll');
  const fontSize = modal.locator('input[name="fontSize"]');
  await fontSize.fill('36');
  await fontSize.blur();
  const topBottomDuration = modal.locator('input[name="topBottomDurationMs"]');
  await topBottomDuration.fill('30000');
  await topBottomDuration.blur();
  await modal.locator('#tab-advanced').click();
  const depthLayers = modal.locator('input[name="depthLayersEnabled"]');
  if (await depthLayers.isChecked()) await depthLayers.uncheck();
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden', timeout: 5_000 });

  await page.waitForFunction(() => {
    const handle = window.__ytChatOverlay;
    const settings = handle?.getSettings?.();
    return (
      settings?.fontSize === 36 &&
      settings?.danmakuMode === 'scroll' &&
      settings?.depthLayersEnabled === false &&
      settings?.topBottomDurationMs === 30_000
    );
  });
}

export async function run({ browser, root, output }) {
  assert(
    browser && typeof browser.newContext === 'function',
    'A launched Playwright browser is required',
  );
  assert.equal(typeof root, 'string', 'root must be the extracted bundle directory');
  assert.equal(typeof output, 'string', 'output must be an artifact directory');

  const [userscript, previewHtml, gmMocks] = await Promise.all([
    readFile(join(root, USERSCRIPT_PATH), 'utf8'),
    readFile(join(root, PREVIEW_PATH), 'utf8'),
    readFile(join(root, GM_MOCKS_PATH), 'utf8'),
  ]);
  assert.match(userscript, /==UserScript==/u, 'Production userscript metadata is missing');
  const mockWatchHtml = createMockWatchHtml(previewHtml);
  await mkdir(output, { recursive: true });

  const pageErrors = [];
  const consoleErrors = [];
  let chatApiRequests = 0;
  let customEmojiAssetRequests = 0;
  const context = await browser.newContext({
    colorScheme: 'dark',
    locale: 'en-US',
    viewport: { width: 1280, height: 720 },
  });

  try {
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (
        url.hostname === 'www.youtube.com' &&
        url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat')
      ) {
        chatApiRequests++;
        await route.fulfill({ status: 200, contentType: 'application/json', json: CHAT_RESPONSE });
        return;
      }
      if (url.hostname === 'www.youtube.com' && route.request().resourceType() === 'document') {
        await route.fulfill({ status: 200, contentType: 'text/html', body: mockWatchHtml });
        return;
      }
      if (url.hostname === 'yt3.ggpht.com') {
        customEmojiAssetRequests++;
        await route.fulfill({
          status: 200,
          contentType: 'image/svg+xml',
          headers: { 'access-control-allow-origin': '*' },
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#ffd54f"/><path d="M9 19q7 8 14 0" fill="none" stroke="#382f18" stroke-width="2"/><circle cx="11" cy="12" r="2"/><circle cx="21" cy="12" r="2"/></svg>',
        });
        return;
      }
      await route.fulfill({ status: 403, contentType: 'text/plain', body: 'Blocked by fixture' });
    });

    await page.addInitScript(() => {
      Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
        configurable: true,
        get: () => false,
      });
      window.ytcfg = {
        data_: {
          INNERTUBE_API_KEY: 'windows-acceptance-key',
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
                      continuation: 'windows-acceptance-live',
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
    await page.addInitScript({ content: gmMocks });
    await page.addInitScript({ content: userscript });
    await page.goto(MOCK_WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    await page.locator('#yt-live-chat-overlay canvas').waitFor({
      state: 'attached',
      timeout: 15_000,
    });
    await page.waitForFunction(() => {
      const handle = window.__ytChatOverlay;
      return Boolean(handle && typeof handle.getSettings === 'function');
    });

    await configureThroughSettingsUi(page);
    await page.locator('#yt-live-chat-overlay canvas').waitFor({ state: 'attached' });
    await page.waitForTimeout(500);

    const apiStatus = await page.evaluate(async () => {
      const response = await fetch(
        'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=windows-acceptance',
      );
      await response.json();
      return response.status;
    });
    assert.equal(apiStatus, 200, 'Deterministic live-chat API fixture did not load');
    assert(chatApiRequests > 0, 'The deterministic chat API route was not exercised');

    try {
      await page.waitForFunction(
        (expected) =>
          document.querySelectorAll('.yt-live-chat-overlay-live-region > p').length >= expected,
        EXPECTED_MESSAGE_COUNT,
        { timeout: 15_000 },
      );
    } catch (error) {
      const state = await page.evaluate(() => ({
        accessibleMessages: Array.from(
          document.querySelectorAll('.yt-live-chat-overlay-live-region > p'),
          (element) => element.textContent,
        ),
        hasCanvas: Boolean(document.querySelector('#yt-live-chat-overlay canvas')),
        paused: document.querySelector('video')?.paused,
        settings: window.__ytChatOverlay?.getSettings?.(),
      }));
      throw new Error(`Renderer readiness failed: ${JSON.stringify({ chatApiRequests, state })}`, {
        cause: error,
      });
    }

    const accessibleMessages = await page
      .locator('.yt-live-chat-overlay-live-region > p')
      .allTextContents();
    assert(accessibleMessages.some((text) => text.includes('한국어')));
    assert(accessibleMessages.some((text) => text.includes('日本語')));
    assert(accessibleMessages.some((text) => text.includes('العربية')));
    assert(accessibleMessages.some((text) => text.includes('Super Chat')));
    assert(accessibleMessages.some((text) => text.includes('Membership')));
    assert(customEmojiAssetRequests > 0, 'The custom emoji asset was not requested');

    // Let scrolling messages enter the viewport, then use the product's pause
    // interaction so the two screenshots capture a stable visual state.
    await page.waitForTimeout(2_250);
    await page.keyboard.press('Control+Space');
    const pauseIndicator = page
      .locator('#yt-live-chat-overlay')
      .getByText('Paused', { exact: true });
    await pauseIndicator.waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await pauseIndicator.textContent(), 'Paused');

    const canvas = page.locator('#yt-live-chat-overlay canvas');
    const canvasBox = await canvas.boundingBox();
    assert(
      canvasBox && canvasBox.width > 0 && canvasBox.height > 0,
      'Overlay canvas has no visible area',
    );

    await page.waitForTimeout(250);
    const canvasPath = join(output, 'yt-visual-canvas.png');
    const pagePath = join(output, 'yt-visual-page.png');
    await canvas.screenshot({ path: canvasPath, animations: 'disabled' });
    await page.screenshot({ path: pagePath, fullPage: true, animations: 'disabled' });
    assert((await stat(canvasPath)).size > 1_000, 'Canvas screenshot is unexpectedly small');
    assert((await stat(pagePath)).size > 1_000, 'Page screenshot is unexpectedly small');

    assert.deepEqual(pageErrors, [], `Page errors: ${pageErrors.join(' | ')}`);
    assert.deepEqual(consoleErrors, [], `Console errors: ${consoleErrors.join(' | ')}`);

    const settings = await page.evaluate(() => window.__ytChatOverlay?.getSettings?.());
    assert.equal(settings?.fontSize, 36);
    assert.equal(settings?.danmakuMode, 'scroll');
    assert.equal(settings?.depthLayersEnabled, false);

    return {
      checks: {
        productionUserscriptInjected: true,
        settingsUiInteraction: true,
        deterministicChatApi: true,
        chatApiRequests,
        accessibleRenderedMessages: accessibleMessages.length,
        renderingPausedForCapture: true,
        pauseIndicatorText: 'Paused',
        pageErrors: pageErrors.length,
        consoleErrors: consoleErrors.length,
        customEmojiAssetRequests,
        screenshotsWritten: 2,
      },
      observations: {
        browserVersion: browser.version(),
        canvas: canvasBox,
        fixtureContent: ['Korean', 'Japanese', 'RTL', 'emoji', 'Super Chat', 'membership'],
        screenshots: ['yt-visual-canvas.png', 'yt-visual-page.png'],
      },
    };
  } finally {
    await context.close();
  }
}
