// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MOCK_WATCH_URL = 'https://www.youtube.com/watch?v=windowsAcceptance';
const USERSCRIPT_PATH = 'dist/yt-live-chat-overlay.user.js';
const PREVIEW_PATH = 'test/visual/preview.html';
const GM_MOCKS_PATH = 'test/visual/gm-mocks.js';
const EXPECTED_MESSAGE_COUNT = 6;

const CHAT_ACTIONS = [
  messageAction('acceptance-korean', '한국어', [{ text: '안녕하세요 Windows 화면 검증입니다 🌙' }]),
  messageAction('acceptance-japanese', '日本語', [{ text: '日本語の描画を確認します ✨' }]),
  messageAction('acceptance-rtl', 'العربية', [{ text: 'مرحبا بكم — RTL + English 123' }]),
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
];

function chatResponse(actions, timeoutMs = 30_000) {
  return {
    continuationContents: {
      liveChatContinuation: {
        actions,
        continuations: [
          {
            timedContinuationData: {
              continuation: 'windows-acceptance-next',
              timeoutMs,
            },
          },
        ],
      },
    },
  };
}

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

async function assertForcedColorsDisclosure(page, summary) {
  await page.emulateMedia({ forcedColors: 'active' });
  try {
    const colors = await summary.evaluate((element) => {
      const reference = document.createElement('button');
      reference.style.backgroundColor = 'ButtonFace';
      reference.style.color = 'ButtonText';
      reference.style.forcedColorAdjust = 'none';
      document.body.appendChild(reference);
      const referenceStyle = getComputedStyle(reference);
      const summaryStyle = getComputedStyle(element);
      const result = {
        background: summaryStyle.backgroundColor,
        color: summaryStyle.color,
        forcedColorAdjust: summaryStyle.forcedColorAdjust,
        markerColor: getComputedStyle(element, '::marker').color,
        systemBackground: referenceStyle.backgroundColor,
        systemText: referenceStyle.color,
      };
      reference.remove();
      return result;
    });
    assert.equal(colors.forcedColorAdjust, 'none');
    assert.equal(colors.background, colors.systemBackground);
    assert.equal(colors.color, colors.systemText);
    assert.equal(colors.markerColor, colors.systemText);
  } finally {
    await page.emulateMedia({ forcedColors: 'none' });
  }
}

async function configureThroughSettingsUi(page, installed, output, inspectRenderer) {
  const button = page.locator('#yt-chat-overlay-settings-button');
  await button.waitFor({ state: 'visible', timeout: 15_000 });
  await button.focus();
  await page.keyboard.press('Enter');

  const modal = page.locator('#yt-chat-overlay-settings-backdrop');
  await modal.waitFor({ state: 'visible', timeout: 5_000 });
  assert.equal(await modal.getAttribute('aria-modal'), 'true');
  await modal.screenshot({ path: join(output, 'yt-settings-basic.png'), animations: 'disabled' });

  const disclosure = modal.locator('.yt-chat-overlay-settings-disclosure');
  assert.equal(await disclosure.getAttribute('open'), null, 'Fine tuning must start collapsed');
  assert.equal(
    await modal.locator('details input[name="fontSize"]').count(),
    0,
    'Font size must remain in the primary settings area',
  );
  const disclosureSummary = disclosure.locator('summary');
  await disclosureSummary.focus();
  await page.keyboard.press('Enter');
  assert.equal(await disclosure.getAttribute('open'), '', 'Fine tuning did not open from keyboard');
  await assertForcedColorsDisclosure(page, disclosureSummary);

  await modal.locator('select[name="danmakuMode"]').selectOption('scroll');
  const fontSize = modal.locator('input[name="fontSize"]');
  await fontSize.fill('36');
  await fontSize.blur();
  const opacity = modal.locator('input[name="opacity"]');
  await opacity.fill('65');
  await opacity.blur();
  const safeTop = modal.locator('input[name="safeTop"]');
  await safeTop.fill('20');
  await safeTop.blur();
  const safeBottom = modal.locator('input[name="safeBottom"]');
  await safeBottom.fill('10');
  await safeBottom.blur();
  const topBottomDuration = modal.locator('input[name="topBottomDurationMs"]');
  await topBottomDuration.fill('30000');
  await topBottomDuration.blur();
  if (installed) {
    const minimumDuration = modal.locator('input[name="scrollDurationMinMs"]');
    await minimumDuration.fill('15000');
    await minimumDuration.blur();
  }

  await modal.locator('#tab-colors').click();
  const outlineEnabled = modal.locator('input[name="outline-enabled"]');
  if (!(await outlineEnabled.isChecked())) await outlineEnabled.check();
  const outlineWidth = modal.locator('input[name="outline-widthPx"]');
  await outlineWidth.fill('3');
  await outlineWidth.blur();
  const outlineOpacity = modal.locator('input[name="outline-opacity"]');
  await outlineOpacity.fill('60');
  await outlineOpacity.blur();

  await modal.locator('#tab-comments').click();
  const previewState = await modal.locator('.yt-chat-overlay-settings-font-preview').evaluate(
    (element) => {
      const stage = element.querySelector('.yt-chat-overlay-settings-font-preview-stage');
      const text = element.querySelector('.yt-chat-overlay-settings-font-preview-text');
      const top = element.querySelector('[data-preview-zone="top"]');
      const bottom = element.querySelector('[data-preview-zone="bottom"]');
      if (!(stage instanceof HTMLElement) || !(text instanceof HTMLElement) ||
          !(top instanceof HTMLElement) || !(bottom instanceof HTMLElement)) {
        throw new Error('Settings preview DOM is incomplete');
      }
      const stageHeight = stage.getBoundingClientRect().height;
      return {
        availableBottom: bottom.getBoundingClientRect().top,
        availableTop: top.getBoundingClientRect().bottom,
        bottomFraction: bottom.getBoundingClientRect().height / stageHeight,
        message: text.textContent?.trim() ?? '',
        metrics: element.querySelector('[data-preview-metrics]')?.textContent ?? '',
        opacity: text.style.opacity,
        stroke: text.style.getPropertyValue('-webkit-text-stroke'),
        textBottom: text.getBoundingClientRect().bottom,
        textTop: text.getBoundingClientRect().top,
        topFraction: top.getBoundingClientRect().height / stageHeight,
      };
    },
  );
  assert(previewState.message.length > 0, 'The fixed preview message is missing');
  assert(previewState.metrics.includes('65%'), 'Preview does not report normalized opacity');
  assert(previewState.metrics.includes('3px / 60%'), 'Preview does not report outline state');
  assert.equal(previewState.opacity, '0.65');
  assert.equal(previewState.stroke, '2.55px rgba(0, 0, 0, 0.6)');
  assert(previewState.textTop >= previewState.availableTop - 1,
    'Preview text overlaps the top safe zone');
  assert(previewState.textBottom <= previewState.availableBottom + 1,
    'Preview text overlaps the bottom safe zone');
  assert(Math.abs(previewState.topFraction - 0.2) < 0.02, 'Top safe-zone mask is inaccurate');
  assert(Math.abs(previewState.bottomFraction - 0.1) < 0.02, 'Bottom safe-zone mask is inaccurate');
  await modal.locator('.yt-chat-overlay-settings-font-preview').scrollIntoViewIfNeeded();
  await modal.screenshot({ path: join(output, 'yt-settings-preview.png'), animations: 'disabled' });

  await modal.locator('#tab-translation').click();
  const capability = modal.locator('.yt-chat-overlay-settings-capability');
  assert.match(await capability.getAttribute('data-supported'), /^(?:true|false)$/u);
  assert.equal(await capability.getAttribute('role'), 'note');
  assert((await capability.textContent())?.trim(), 'Translation capability status is empty');
  assert.equal(await modal.locator('input[name="translationEnabled"]').count(), 1);
  assert.equal(
    await modal.locator('select[name="translationService"] option[value="off"]').count(),
    1,
    'Translation off option is missing',
  );

  await modal.locator('#tab-advanced').click();
  const depthLayers = modal.locator('input[name="depthLayersEnabled"]');
  if (await depthLayers.isChecked()) await depthLayers.uncheck();
  if (installed || inspectRenderer) await modal.locator('input[name="showDebugOverlay"]').check();
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden', timeout: 5_000 });

  if (installed) return;
  await page.waitForFunction(() => {
    const handle = window.__ytChatOverlay;
    const settings = handle?.getSettings?.();
    return (
      settings?.fontSize === 36 &&
      settings?.opacity === 0.65 &&
      settings?.safeTop === 0.2 &&
      settings?.safeBottom === 0.1 &&
      settings?.outline?.enabled === true &&
      settings?.outline?.widthPx === 3 &&
      settings?.outline?.opacity === 0.6 &&
      settings?.danmakuMode === 'scroll' &&
      settings?.depthLayersEnabled === false &&
      settings?.topBottomDurationMs === 30_000
    );
  });
}

async function verifyIsolatedPaidCardInk(page, output) {
  await page.evaluate(async () => {
    const app = window.__ytChatOverlay;
    if (!app?.restartRuntime || !app.applySettings) throw new Error('Runtime restart hook is unavailable');
    app.applySettings({ danmakuMode: 'top' });
    await app.restartRuntime();
    if (window.__ytAcceptancePaidCardProbe) window.__ytAcceptancePaidCardProbe.rects.length = 0;
  });
  const paused = page.locator('#yt-live-chat-overlay').getByText('Paused', { exact: true });
  if (await paused.isVisible()) await page.keyboard.press('Control+Space');
  const previousDraws = await page.evaluate(() => window.__ytAcceptancePaidCardProbe?.cachedBitmapDraws ?? 0);
  const index = CHAT_ACTIONS.findIndex((action) => action.addChatItemAction?.item?.liveChatPaidMessageRenderer);
  assert(index >= 0, 'Super Chat fixture is unavailable');
  await page.evaluate(async (messageIndex) => {
    const response = await fetch(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=windows-acceptance&message=${messageIndex}&ink-probe=1`);
    if (!response.ok) throw new Error('Isolated Super Chat request failed');
    await response.json();
  }, index);
  await page.waitForFunction(() =>
    document.querySelector('#yt-chat-overlay-debug')?.textContent?.includes('Rcvd: 1 | Rndr: 1'),
  );
  const resultHandle = await page.waitForFunction((before) => {
    const element = document.querySelector('#yt-live-chat-overlay canvas');
    const probe = window.__ytAcceptancePaidCardProbe;
    if (!(element instanceof HTMLCanvasElement) || !probe || probe.cachedBitmapDraws <= before) return null;
    const context = element.getContext('2d');
    if (!context) return null;
    const candidates = probe.rects.filter((rect) => {
      const x = Math.floor((rect.left + rect.right) / 2);
      const y = Math.floor(rect.top) + 2;
      if (x < 0 || x >= element.width || y < 0 || y >= element.height) return false;
      const [red, green, blue, alpha] = context.getImageData(x, y, 1, 1).data;
      return alpha >= 128 && blue > green + 10 && blue > red + 10;
    });
    if (candidates.length !== 1) return null;
    const rect = candidates[0];
    const startX = Math.min(element.width, Math.ceil(rect.right) + 1);
    const startY = Math.max(0, Math.floor(rect.top));
    const endY = Math.min(element.height, Math.ceil(rect.bottom));
    if (startX >= element.width || startY >= endY) return null;
    const pixels = context.getImageData(startX, startY, element.width - startX, endY - startY).data;
    let outsideAlphaPixels = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 8) outsideAlphaPixels++;
    return { cachedBitmapDraws: probe.cachedBitmapDraws - before, outsideAlphaPixels, rect };
  }, previousDraws, { timeout: 10_000 });
  const result = await resultHandle.jsonValue();
  await resultHandle.dispose();
  assert.equal(result.outsideAlphaPixels, 0, 'Isolated outlined Super Chat ink escaped the card');
  await page.locator('#yt-live-chat-overlay canvas').screenshot({
    path: join(output, 'yt-paid-card-ink.png'), animations: 'disabled',
  });
  return result;
}

export async function run({ browser, root, output, installedContext, installedExtensionId, expectedRenderer = 'main' }) {
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
  const installedEmoji = installedContext
    ? await readFile(join(root, 'dist-extension/icons/icon48.png'))
    : null;
  const mockWatchHtml = createMockWatchHtml(previewHtml);
  await mkdir(output, { recursive: true });

  const pageErrors = [];
  const consoleErrors = [];
  let chatApiRequests = 0;
  let explicitChatRequests = 0;
  let backgroundChatRequests = 0;
  const backgroundRequestTimes = [];
  let customEmojiAssetRequests = 0;
  let deliverInstalledFixture = false;
  let installedFixtureDelivered = false;
  let installedFixtureCursor = 0;
  const context = installedContext ?? await browser.newContext({
    colorScheme: 'dark',
    locale: 'en-US',
    viewport: { width: 1280, height: 720 },
  });

  let page;
  try {
    page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (installedContext && url.protocol === 'chrome-extension:' && url.hostname === installedExtensionId) {
        await route.continue();
        return;
      }
      if (
        url.hostname === 'www.youtube.com' &&
        url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat')
      ) {
        chatApiRequests++;
        const messageIndex = Number(url.searchParams.get('message'));
        const action = CHAT_ACTIONS[messageIndex];
        if (url.searchParams.get('key') === 'windows-acceptance' && action) {
          explicitChatRequests++;
          const deliveredAction = url.searchParams.has('ink-probe') ? structuredClone(action) : action;
          if (url.searchParams.has('ink-probe')) {
            const paid = deliveredAction.addChatItemAction.item.liveChatPaidMessageRenderer;
            assert(paid, 'The isolated ink fixture must be a Super Chat');
            paid.id += '-isolated-ink';
          }
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            json: chatResponse([deliveredAction]),
          });
        } else {
          backgroundChatRequests++;
          backgroundRequestTimes.push(performance.now());
          const actions = deliverInstalledFixture && !installedFixtureDelivered
            ? [CHAT_ACTIONS[installedFixtureCursor++]]
            : [];
          if (actions.length) installedFixtureDelivered = installedFixtureCursor === CHAT_ACTIONS.length;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            json: chatResponse(actions, installedContext ? 1000 : 30_000),
          });
        }
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
          contentType: installedEmoji ? 'image/png' : 'image/svg+xml',
          headers: { 'access-control-allow-origin': '*' },
          body: installedEmoji ?? '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#ffd54f"/><path d="M9 19q7 8 14 0" fill="none" stroke="#382f18" stroke-width="2"/><circle cx="11" cy="12" r="2"/><circle cx="21" cy="12" r="2"/></svg>',
        });
        return;
      }
      await route.fulfill({ status: 403, contentType: 'text/plain', body: 'Blocked by fixture' });
    });

    if (installedContext) await page.addInitScript(() => {
      const workers = [];
      window.__ytAcceptanceWorkers = workers;
      const NativeWorker = window.Worker;
      window.Worker = new Proxy(NativeWorker, {
        construct(target, args) {
          const record = { url: String(args[0]), ready: false };
          if (workers.length < 16) workers.push(record);
          try {
            const worker = Reflect.construct(target, args);
            worker.addEventListener('message', (event) => {
              if (event.data?.type === 'ready') record.ready = true;
            });
            worker.addEventListener('error', (event) => { record.error = event.message; });
            return worker;
          } catch (error) {
            record.error = String(error);
            throw error;
          }
        },
      });
    });
    await page.addInitScript((inspectPaidCardInk) => {
      Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
        configurable: true,
        get: () => false,
      });
      if (inspectPaidCardInk) {
        Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
          configurable: true,
          value: () => {
            throw new Error('Select the main renderer for fixture pixel inspection');
          },
        });
        const rects = [];
        let paintedCanvas = null;
        let cachedBitmapDraws = 0;
        const originalClearRect = CanvasRenderingContext2D.prototype.clearRect;
        CanvasRenderingContext2D.prototype.clearRect = function (x, y, width, height) {
          if (this.canvas === paintedCanvas && x === 0 && y === 0) rects.length = 0;
          originalClearRect.call(this, x, y, width, height);
        };
        const originalRoundRect = CanvasRenderingContext2D.prototype.roundRect;
        CanvasRenderingContext2D.prototype.roundRect = function (x, y, width, height, radii) {
          if (
            width > 0 &&
            typeof this.fillStyle !== 'string' &&
            rects.length < 512
          ) {
            if (paintedCanvas !== this.canvas) {
              rects.length = 0;
              paintedCanvas = this.canvas;
            }
            const transform = this.getTransform();
            rects.push({
              left: x * transform.a + transform.e,
              top: y * transform.d + transform.f,
              right: (x + width) * transform.a + transform.e,
              bottom: (y + height) * transform.d + transform.f,
            });
          }
          originalRoundRect.call(this, x, y, width, height, radii);
        };
        const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (...args) {
          if (
            args.length >= 5 &&
            typeof OffscreenCanvas !== 'undefined' &&
            args[0] instanceof OffscreenCanvas
          ) {
            cachedBitmapDraws++;
          }
          Reflect.apply(originalDrawImage, this, args);
        };
        window.__ytAcceptancePaidCardProbe = {
          rects,
          get cachedBitmapDraws() { return cachedBitmapDraws; },
        };
      }
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
    }, expectedRenderer === 'main');
    if (!installedContext) {
      await page.addInitScript({ content: gmMocks });
      await page.addInitScript({ content: userscript });
    }
    await page.goto(MOCK_WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    await page.locator('#yt-live-chat-overlay canvas').waitFor({
      state: 'attached',
      timeout: 15_000,
    });
    if (!installedContext) await page.waitForFunction(() => {
      const handle = window.__ytChatOverlay;
      return Boolean(handle && typeof handle.getSettings === 'function');
    });

    await configureThroughSettingsUi(page, Boolean(installedContext), output, Boolean(expectedRenderer));
    await page.locator('#yt-live-chat-overlay canvas').waitFor({ state: 'attached' });
    await page.waitForTimeout(500);

    deliverInstalledFixture = Boolean(installedContext);
    const apiStatuses = installedContext ? [] : await page.evaluate(async (count) => {
      const statuses = [];
      for (let index = 0; index < count; index++) {
        const response = await fetch(
          `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=windows-acceptance&message=${index}`,
        );
        await response.json();
        statuses.push(response.status);
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      return statuses;
    }, EXPECTED_MESSAGE_COUNT);
    if (!installedContext) assert.deepEqual(
      apiStatuses,
      Array.from({ length: EXPECTED_MESSAGE_COUNT }, () => 200),
      'Deterministic live-chat API fixtures did not load',
    );
    assert.equal(explicitChatRequests, installedContext ? 0 : EXPECTED_MESSAGE_COUNT);

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
    let rendererStatus;
    if (expectedRenderer) {
      await page.waitForFunction((worker) => {
        const status = document.querySelector('#yt-chat-overlay-debug')?.textContent ?? '';
        return status.includes('Render:') && status.includes('Render: n/a') === worker;
      }, expectedRenderer === 'worker');
      rendererStatus = expectedRenderer;
    }

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

    let settings;
    if (installedContext) {
      assert(installedFixtureDelivered, 'The installed application did not consume fixture data');
      // Reload proves persistence through the real extension/userscript manager.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#yt-chat-overlay-settings-button').focus();
      await page.keyboard.press('Enter');
      const modal = page.locator('#yt-chat-overlay-settings-backdrop');
      await modal.waitFor({ state: 'visible' });
      settings = {
        fontSize: Number(await modal.locator('input[name="fontSize"]').inputValue()),
        opacity: Number(await modal.locator('input[name="opacity"]').inputValue()) / 100,
        safeTop: Number(await modal.locator('input[name="safeTop"]').inputValue()) / 100,
        safeBottom: Number(await modal.locator('input[name="safeBottom"]').inputValue()) / 100,
        outline: {
          enabled: await modal.locator('input[name="outline-enabled"]').isChecked(),
          widthPx: Number(await modal.locator('input[name="outline-widthPx"]').inputValue()),
          opacity: Number(await modal.locator('input[name="outline-opacity"]').inputValue()) / 100,
        },
        danmakuMode: await modal.locator('select[name="danmakuMode"]').inputValue(),
        depthLayersEnabled: await modal.locator('input[name="depthLayersEnabled"]').isChecked(),
      };
      await page.keyboard.press('Escape');
    } else {
      settings = await page.evaluate(() => window.__ytChatOverlay?.getSettings?.());
    }
    assert.equal(settings?.fontSize, 36);
    assert.equal(settings?.opacity, 0.65);
    assert.equal(settings?.safeTop, 0.2);
    assert.equal(settings?.safeBottom, 0.1);
    assert.deepEqual(settings?.outline, { enabled: true, opacity: 0.6, widthPx: 3 });
    assert.equal(settings?.danmakuMode, 'scroll');
    assert.equal(settings?.depthLayersEnabled, false);

    const paidCardInkContainment = expectedRenderer === 'main' && !installedContext
      ? await verifyIsolatedPaidCardInk(page, output)
      : null;
    assert.deepEqual(pageErrors, [], `Page errors: ${pageErrors.join(' | ')}`);
    assert.deepEqual(consoleErrors, [], `Console errors: ${consoleErrors.join(' | ')}`);
    const backgroundObservationMs = backgroundRequestTimes.length
      ? performance.now() - backgroundRequestTimes[0]
      : 0;
    const minimumPollInterval = installedContext ? null : await page.evaluate(
      () => window.__ytChatOverlay?.getSettings?.().minPollIntervalMs,
    );
    if (!installedContext) {
      assert(Number.isFinite(minimumPollInterval) && minimumPollInterval > 0,
        'The runtime minimum polling interval is unavailable');
    }
    // Longer settings interactions permit more polls, but never a faster
    // average request rate than the configured minimum polling interval.
    const backgroundRequestBudget = installedContext
      ? 100
      : 1 + Math.floor(backgroundObservationMs / minimumPollInterval);
    assert(backgroundChatRequests <= backgroundRequestBudget,
      `Background chat requests flooded: ${backgroundChatRequests}/${backgroundRequestBudget}`);


    return {
      checks: {
        productionUserscriptInjected: !installedContext,
        installedApplicationDelivery: Boolean(installedContext),
        persistedAcrossReload: Boolean(installedContext),
        renderer: rendererStatus,
        settingsUiInteraction: true,
        settingsDisclosureKeyboardInteraction: true,
        settingsPreviewState: true,
        translationCapabilitySeparatedFromPreference: true,
        settingsOpenMethod: 'keyboard',
        deterministicChatApi: true,
        chatApiRequests,
        explicitChatRequests,
        backgroundChatRequests,
        backgroundRequestBudget,
        accessibleRenderedMessages: accessibleMessages.length,
        renderingPausedForCapture: true,
        pauseIndicatorText: 'Paused',
        pageErrors: pageErrors.length,
        consoleErrors: consoleErrors.length,
        customEmojiAssetRequests,
        paidCardInkContained: paidCardInkContainment?.outsideAlphaPixels === 0,
        screenshotsWritten: paidCardInkContainment ? 5 : 4,
      },
      observations: {
        browserVersion: browser.version(),
        canvas: canvasBox,
        fixtureContent: ['Korean', 'Japanese', 'RTL', 'emoji', 'Super Chat', 'membership'],
        screenshots: ['yt-settings-basic.png', 'yt-settings-preview.png', 'yt-visual-canvas.png', 'yt-visual-page.png', ...(paidCardInkContainment ? ['yt-paid-card-ink.png'] : [])],
        backgroundObservationMs,
        paidCardInkContainment,
        backgroundRequestIntervalsMs: backgroundRequestTimes.slice(1).map(
          (time, index) => time - backgroundRequestTimes[index],
        ),
      },
    };
  } catch (error) {
    await page?.screenshot({ path: join(output, 'fixture-error.png') }).catch(() => {});
    await writeFile(join(output, 'fixture-error.json'), JSON.stringify({
      pageErrors, consoleErrors, chatApiRequests, installedFixtureDelivered,
      workers: await page?.evaluate(() => window.__ytAcceptanceWorkers).catch(() => []),
    }, null, 2));
    throw error;
  } finally {
    if (installedContext) await page?.close();
    else await context.close();
  }
}
