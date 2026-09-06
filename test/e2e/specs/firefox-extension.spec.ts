// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchFirefoxBidi, type FirefoxBidiSession } from '../fixtures/firefox-bidi';
import {
  MOCK_HTML,
  MOCK_NON_WATCH_HTML,
  MOCK_WATCH_URL,
  OVERLAY_ID,
  SETTINGS_STORAGE_KEY,
} from '../fixtures/test-utils';

const FIREFOX_EXTENSION_ID = 'yt-live-chat-overlay@piesp.github.io';
const FIREFOX_EXTENSION_PATH = resolve(process.cwd(), 'dist-extension-firefox');
const LIVE_CONTINUATION = {
  timedContinuationData: {
    continuation: 'firefox-extension-live',
    timeoutMs: 30_000,
  },
};
const FIREFOX_MOCK_HTML = MOCK_HTML.replace(
  '<head>',
  `<head><script>
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
      configurable: true,
      get: () => false
    });
    globalThis.ytcfg = { data_: {
      INNERTUBE_API_KEY: 'firefox-e2e-key',
      INNERTUBE_CONTEXT_CLIENT_NAME: '1',
      INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
      INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } }
    } };
    globalThis.ytInitialData = {
      currentVideoEndpoint: { watchEndpoint: { videoId: 'dQw4w9WgXcQ' } },
      contents: { twoColumnWatchNextResults: { conversationBar: { liveChatRenderer: {
        isReplay: false,
        continuations: [${JSON.stringify(LIVE_CONTINUATION)}]
      } } } }
    };
  </script>`
);
const EMPTY_LIVE_CHAT_RESPONSE = JSON.stringify({
  continuationContents: {
    liveChatContinuation: {
      actions: [
        {
          addChatItemAction: {
            item: {
              liveChatTextMessageRenderer: {
                id: 'firefox-extension-message',
                authorName: { simpleText: 'Firefox Extension' },
                message: { simpleText: 'Firefox extension BiDi rendering smoke' },
              },
            },
          },
        },
      ],
      continuations: [LIVE_CONTINUATION],
    },
  },
});

test.describe('Firefox extension runtime', () => {
  test.beforeAll(() => {
    if (!existsSync(resolve(FIREFOX_EXTENSION_PATH, 'manifest.json'))) {
      throw new Error(
        `Firefox extension not found at ${FIREFOX_EXTENSION_PATH}. Run pnpm build:extension:firefox first.`
      );
    }
  });

  test('injects, persists normalized cache settings, renders chat, and survives SPA navigation', async ({}, testInfo) => {
    let browser: FirefoxBidiSession | null = null;
    try {
      browser = await launchFirefoxBidi();
      await browser.serveMockYouTube({
        chatResponseJson: EMPTY_LIVE_CHAT_RESPONSE,
        nonWatchHtml: MOCK_NON_WATCH_HTML,
        watchHtml: FIREFOX_MOCK_HTML,
      });

      await expect(browser.installExtension(FIREFOX_EXTENSION_PATH)).resolves.toBe(
        FIREFOX_EXTENSION_ID
      );
      await browser.navigate(MOCK_WATCH_URL);
      await browser.waitFor(
        `Boolean(
          window.__ytChatOverlay &&
          document.querySelector('#${OVERLAY_ID} canvas') &&
          document.querySelector('#yt-chat-overlay-settings-button')
        )`,
        'the Firefox extension overlay to initialize'
      );

      const startup = await browser.evaluateJson<{
        canvasAriaHidden: string | null;
        pageScriptCount: number;
        storageType: string | null;
        workerSupported: boolean;
        workerUrl: string | null;
      }>(`(() => {
        const bridge = window.__ytExtensionBridge;
        return {
          canvasAriaHidden: document.querySelector('#${OVERLAY_ID} canvas')?.getAttribute('aria-hidden') ?? null,
          pageScriptCount: document.querySelectorAll('script[src^="moz-extension://"][src$="/page-script.js"]').length,
          storageType: bridge?.storageType ?? null,
          workerSupported: bridge?.workerSupported === true,
          workerUrl: bridge?.workerUrl ?? null,
        };
      })()`);
      expect(startup).toMatchObject({
        canvasAriaHidden: 'true',
        pageScriptCount: 1,
        storageType: 'chrome.storage.local',
        workerSupported: true,
      });
      expect(startup.workerUrl).toMatch(/^moz-extension:\/\/[^/]+\/workers\/renderer\.js$/);

      const settingsInteraction = await browser.evaluateJson<{
        advancedTabSelected: string | null;
        modalOpen: boolean;
      }>(`(() => {
        const settingsButton = document.querySelector('#yt-chat-overlay-settings-button');
        if (!(settingsButton instanceof HTMLButtonElement)) throw new Error('Settings button is missing');
        settingsButton.click();
        const modal = document.querySelector('#yt-chat-overlay-settings-backdrop');
        const advancedTab = document.querySelector('#tab-advanced');
        if (!(modal instanceof HTMLDialogElement) || !(advancedTab instanceof HTMLButtonElement)) {
          throw new Error('Settings dialog did not expose its advanced pane');
        }
        advancedTab.click();
        const setControl = (name, value, type = 'input') => {
          const control = modal.querySelector('[name="' + name + '"]');
          if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLSelectElement)) {
            throw new Error('Missing setting control: ' + name);
          }
          if (control instanceof HTMLInputElement && control.type === 'checkbox') {
            control.checked = Boolean(value);
          } else {
            control.value = String(value);
          }
          control.dispatchEvent(new Event(type, { bubbles: true }));
        };
        setControl('emojiCacheMb', 1.000001);
        setControl('textCacheMb', 2.999999);
        setControl('allowShortTextMessages', true, 'change');
        setControl('showDebugOverlay', true, 'change');
        setControl('logLevel', 'debug', 'change');
        const result = {
          advancedTabSelected: advancedTab.getAttribute('aria-selected'),
          modalOpen: modal.open,
        };
        const close = modal.querySelector('button[data-action="close"]');
        if (!(close instanceof HTMLButtonElement)) throw new Error('Settings close button is missing');
        close.click();
        return result;
      })()`);
      expect(settingsInteraction).toEqual({ advancedTabSelected: 'true', modalOpen: true });

      await browser.waitFor(
        `(() => {
          const settings = window.__ytChatOverlay?.getSettings();
          return settings?.emojiCacheMb === 1 &&
            settings?.textCacheMb === 3 &&
            settings?.allowShortTextMessages === true &&
            settings?.showDebugOverlay === true &&
            settings?.logLevel === 'debug' &&
            !document.querySelector('#yt-chat-overlay-settings-backdrop')?.hasAttribute('open');
        })()`,
        'normalized settings to apply after closing the dialog'
      );

      await browser.waitFor(
        `new Promise((resolve) => {
          const nonce = window.__ytExtensionBridge?.nonce;
          if (!nonce) { resolve(false); return; }
          const requestId = 900000 + Math.floor(Math.random() * 100000);
          const timeout = setTimeout(() => { cleanup(); resolve(false); }, 500);
          const cleanup = () => {
            clearTimeout(timeout);
            window.removeEventListener('message', onMessage);
          };
          const onMessage = (event) => {
            const data = event.data;
            if (event.source !== window || event.origin !== location.origin ||
                data?.source !== 'yt-storage-relay-response' ||
                data?.nonce !== nonce || data?.requestId !== requestId) return;
            cleanup();
            try {
              const stored = JSON.parse(data.value);
              resolve(stored.emojiCacheMb === 1 && stored.textCacheMb === 3 &&
                stored.allowShortTextMessages === true && stored.showDebugOverlay === true &&
                stored.logLevel === 'debug');
            } catch { resolve(false); }
          };
          window.addEventListener('message', onMessage);
          window.postMessage({
            source: 'yt-storage-relay', nonce, requestId, method: 'get', key: '${SETTINGS_STORAGE_KEY}'
          }, location.origin);
        })`,
        'the real Firefox extension storage write'
      );

      browser.clearPageLogs();
      await browser.reload();
      await browser.waitFor(
        `Boolean(window.__ytChatOverlay && document.querySelector('#${OVERLAY_ID} canvas'))`,
        'the Firefox extension overlay to reload from extension storage'
      );
      const reloadedSettings = await browser.evaluateJson<Record<string, unknown>>(
        `window.__ytChatOverlay?.getSettings() ?? {}`
      );
      expect(reloadedSettings).toMatchObject({
        allowShortTextMessages: true,
        emojiCacheMb: 1,
        logLevel: 'debug',
        showDebugOverlay: true,
        textCacheMb: 3,
      });

      try {
        await browser.waitFor(
          `document.querySelector('#yt-chat-overlay-debug > div')?.textContent === 'Rcvd: 1 | Rndr: 1'`,
          'a real Firefox extension chat message to be ingested and rendered'
        );
      } catch (error: unknown) {
        const diagnostics = await browser.evaluateJson<{
          canvasContextState: string;
          debugText: string | null;
          liveRegionText: string | null;
          videoPaused: boolean | null;
        }>(`(() => {
          const canvas = document.querySelector('#${OVERLAY_ID} canvas');
          let canvasContextState = 'missing';
          if (canvas instanceof HTMLCanvasElement) {
            try {
              canvasContextState = canvas.getContext('2d') === null ? 'transferred' : 'main-thread';
            } catch (contextError) {
              canvasContextState = contextError instanceof DOMException ? contextError.name : String(contextError);
            }
          }
          return {
            canvasContextState,
            debugText: document.querySelector('#yt-chat-overlay-debug > div')?.textContent ?? null,
            liveRegionText: document.querySelector('#${OVERLAY_ID} .yt-live-chat-overlay-live-region')?.textContent ?? null,
            videoPaused: document.querySelector('video') instanceof HTMLVideoElement
              ? document.querySelector('video').paused
              : null,
          };
        })()`);
        const diagnosticLogs = browser.pageLogs.filter(
          ({ level, text }) =>
            level === 'error' || level === 'warn' || text.includes('[RenderWorkerManager]')
        );
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n` +
            `Firefox runtime diagnostics: ${JSON.stringify({ diagnostics, diagnosticLogs })}`
        );
      }
      const reloadLogs = browser.pageLogs;
      const workerStarted = reloadLogs.some(({ text }) =>
        text.includes('[RenderWorkerManager] renderer.worker.started')
      );
      const handledFirefoxFallback = reloadLogs.some(
        ({ args, text }) =>
          text.includes('[RendererCanvas] renderer.fallback.started') &&
          JSON.stringify(args).includes('worker-load-error')
      );
      expect(workerStarted || handledFirefoxFallback).toBe(true);
      expect(
        reloadLogs.filter(({ text }) => text.includes('[RuntimeManager] runtime.session.started'))
      ).toHaveLength(1);

      await browser.evaluateJson(`(() => {
        const canvas = document.querySelector('#${OVERLAY_ID} canvas');
        if (!canvas) throw new Error('Overlay canvas is missing before SPA navigation');
        canvas.setAttribute('data-firefox-session', 'before-navigation');
        history.pushState({}, '', '/feed/trending');
        window.dispatchEvent(new Event('yt-navigate-finish'));
        return true;
      })()`);
      await browser.waitFor(
        `!document.querySelector('#${OVERLAY_ID}')`,
        'the Firefox extension runtime to clean up on SPA navigation'
      );
      await browser.evaluateJson(`(() => {
        window.ytInitialData.currentVideoEndpoint.watchEndpoint.videoId = 'firefox-extension-second';
        history.pushState({}, '', '/watch?v=firefox-extension-second');
        window.dispatchEvent(new Event('yt-navigate-finish'));
        return true;
      })()`);
      await browser.waitFor(
        `Boolean(
          window.__ytChatOverlay &&
          document.querySelector('#${OVERLAY_ID} canvas') &&
          !document.querySelector('#${OVERLAY_ID} canvas[data-firefox-session="before-navigation"]')
        )`,
        'the Firefox extension runtime to restart after SPA navigation'
      );

      await browser.evaluateJson('true');
      expect(browser.pageErrors).toEqual([]);
    } catch (error: unknown) {
      if (browser) {
        try {
          await testInfo.attach('firefox-extension-failure', {
            body: await browser.captureScreenshot(),
            contentType: 'image/png',
          });
        } catch {
          // Preserve the original failure when Firefox already exited.
        }
      }
      throw error;
    } finally {
      await browser?.close();
    }
  });
});
