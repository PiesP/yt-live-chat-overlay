// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { validateLiveRenderer } from './live-rendering.mjs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, win32 } from 'node:path';
import { launchFirefoxBidi } from './firefox-bidi.mjs';

const EXTENSION_ID = 'yt-live-chat-overlay@piesp.github.io';
const OVERLAY_ID = 'yt-live-chat-overlay';
const SETTINGS_KEY = 'yt-live-chat-overlay-settings';
const FIXTURE_URL = 'https://www.youtube.com/watch?v=windowsFirefoxExtension';
const MAX_LIVE_URLS = 3;

const CONTINUATION = {
  timedContinuationData: {
    continuation: 'windows-firefox-extension-next',
    timeoutMs: 30_000,
  },
};

const CHAT_RESPONSE_JSON = JSON.stringify({
  continuationContents: {
    liveChatContinuation: {
      actions: [
        {
          addChatItemAction: {
            item: {
              liveChatTextMessageRenderer: {
                id: 'windows-firefox-extension-message',
                authorName: { simpleText: 'Extension fixture' },
                message: { simpleText: 'Installed Firefox extension render check' },
              },
            },
          },
        },
      ],
      continuations: [CONTINUATION],
    },
  },
});

const WATCH_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Firefox extension fixture</title>
  <script>
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
      configurable: true,
      get: () => false
    });
    globalThis.ytcfg = { data_: {
      INNERTUBE_API_KEY: 'windows-firefox-extension-key',
      INNERTUBE_CONTEXT_CLIENT_NAME: '1',
      INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
      INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } }
    } };
    globalThis.ytInitialData = {
      currentVideoEndpoint: { watchEndpoint: { videoId: 'windowsFirefoxExtension' } },
      contents: { twoColumnWatchNextResults: { conversationBar: { liveChatRenderer: {
        isReplay: false,
        continuations: [${JSON.stringify(CONTINUATION)}]
      } } } }
    };
  </script>
</head>
<body>
  <div id="page-manager"><div id="content"><div id="primary"><div id="player-container">
    <div id="movie_player" class="html5-video-player" style="width:800px;height:450px;position:relative;overflow:hidden">
      <video style="width:100%;height:100%" src="about:blank"></video>
    </div>
  </div></div></div></div>
  <div id="chat" style="display:none"><yt-live-chat-item-list-renderer><div id="items"></div></yt-live-chat-item-list-renderer></div>
</body>
</html>`;

const NON_WATCH_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Firefox extension fixture</title></head>
<body><div id="page-manager"><div id="content"><h1>Fixture page</h1></div></div></body></html>`;

function describeFailure(error, depth = 0) {
  return {
    name: error?.name ?? 'Error',
    message: String(error?.message ?? error).slice(0, 2000),
    ...(depth < 3 && error?.cause ? { cause: describeFailure(error.cause, depth + 1) } : {}),
    ...(depth < 3 && Array.isArray(error?.errors)
      ? { errors: error.errors.slice(0, 10).map((entry) => describeFailure(entry, depth + 1)) }
      : {}),
  };
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function errorMessage(reason) {
  return reason instanceof Error ? reason.message : String(reason);
}

export function resolveSystemFirefoxExecutable({
  executablePath,
  env = process.env,
  platform = process.platform,
} = {}) {
  if (executablePath !== undefined) {
    if (typeof executablePath !== 'string' || !isAbsolute(executablePath)) {
      throw new TypeError('executablePath must be an absolute path');
    }
    return executablePath;
  }
  if (platform !== 'win32') {
    throw new Error('An explicit Firefox executable path is required outside Windows');
  }
  const programFiles = env.ProgramW6432 ?? env.ProgramFiles;
  if (typeof programFiles !== 'string' || !win32.isAbsolute(programFiles)) {
    throw new Error('Windows did not expose an absolute Program Files directory');
  }
  return win32.join(programFiles, 'Mozilla Firefox', 'firefox.exe');
}

export function normalizeLiveUrls(liveUrls = []) {
  if (!Array.isArray(liveUrls)) throw new TypeError('liveUrls must be an array');
  if (liveUrls.length > MAX_LIVE_URLS) {
    throw new RangeError(`liveUrls supports at most ${MAX_LIVE_URLS} entries`);
  }
  return liveUrls.map((value, index) => {
    if (typeof value !== 'string') throw new TypeError(`liveUrls[${index}] must be a string`);
    if (!value.startsWith('https://www.youtube.com/') || /\s/u.test(value) || value.includes('\\')) {
      throw new Error(`liveUrls[${index}] must be a public https://www.youtube.com URL`);
    }
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'www.youtube.com' ||
      (url.port !== '' && url.port !== '443') ||
      url.username !== '' ||
      url.password !== ''
    ) {
      throw new Error(`liveUrls[${index}] must be a public https://www.youtube.com URL`);
    }
    if (url.hash !== '') {
      throw new Error(`liveUrls[${index}] must not contain a fragment`);
    }
    if (url.pathname !== '/watch' && !/^\/live\/[A-Za-z0-9_-]{1,64}$/u.test(url.pathname)) {
      throw new Error(`liveUrls[${index}] must identify a public watch or live page`);
    }
    const kind = url.pathname === '/watch' ? 'watch' : 'live';
    return { kind, url: url.href };
  });
}

export function categorizeErrors(logs) {
  const categories = {};
  for (const log of logs) {
    if (log.level !== 'error') continue;
    const message = log.text.toLowerCase();
    const category =
      message.includes('content security policy') || message.includes('csp')
        ? 'content-security-policy'
        : message.includes('worker')
          ? 'worker'
          : message.includes('network') || message.includes('fetch') || message.includes('http')
            ? 'network'
            : message.includes('extension') || message.includes('moz-extension')
              ? 'extension'
              : log.type === 'javascript'
                ? 'javascript'
                : 'other';
    categories[category] = (categories[category] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(categories).sort(([left], [right]) => left.localeCompare(right))
  );
}

async function writeFailureScreenshot(session, output, fileName) {
  try {
    const screenshot = await session.captureScreenshot();
    await writeFile(join(output, fileName), screenshot);
  } catch {
    // Preserve the original runtime failure when Firefox can no longer capture a frame.
  }
}

async function waitForLog(session, predicate, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.pageLogs.some(predicate)) return;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function verifyStoredSettings(session) {
  await session.waitFor(
    `new Promise((resolve) => {
      const nonce = window.__ytExtensionBridge?.nonce;
      if (!nonce) { resolve(false); return; }
      const requestId = 730001;
      const timeout = setTimeout(() => { cleanup(); resolve(false); }, 750);
      const cleanup = () => {
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
      };
      const onMessage = (event) => {
        const data = event.data;
        if (event.source !== window || event.origin !== location.origin ||
            data?.source !== 'yt-storage-relay-response' || data?.nonce !== nonce ||
            data?.requestId !== requestId) return;
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
        source: 'yt-storage-relay', nonce, requestId, method: 'get', key: '${SETTINGS_KEY}'
      }, location.origin);
    })`,
    'the Firefox extension storage write'
  );
}

async function runDeterministicPhase(session, checks, diagnostics) {
  await session.navigate(FIXTURE_URL);
  await session.waitFor(
    `Boolean(
      window.__ytChatOverlay &&
      document.querySelector('#${OVERLAY_ID} canvas') &&
      document.querySelector('#yt-chat-overlay-settings-button')
    )`,
    'the installed Firefox extension overlay'
  );

  const startupResult = await session.evaluateJson(`(() => {
    const bridge = window.__ytExtensionBridge;
    return {
      workerUrl: bridge?.workerUrl ?? null,
      canvasAriaHidden: document.querySelector('#${OVERLAY_ID} canvas')?.getAttribute('aria-hidden') ?? null,
      pageScriptCount: document.querySelectorAll('script[src^="moz-extension://"][src$="/page-script.js"]').length,
      storageType: bridge?.storageType ?? null,
      workerSupported: bridge?.workerSupported === true,
      workerUrlValid: typeof bridge?.workerUrl === 'string' && bridge.workerUrl.startsWith('blob:' + location.origin + '/')
    };
  })()`);
  const { workerUrl, ...startup } = startupResult;
  diagnostics.startup = startup;
  diagnostics.workerUrl = workerUrl;
  assert.deepEqual(startup, {
    canvasAriaHidden: 'true',
    pageScriptCount: 1,
    storageType: 'chrome.storage.local',
    workerSupported: true,
    workerUrlValid: true,
  });
  checks.bridgeReady = true;

  const settingsInteraction = await session.evaluateJson(`(() => {
    const button = document.querySelector('#yt-chat-overlay-settings-button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('Settings button is missing');
    button.click();
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
    const result = { advancedTabSelected: advancedTab.getAttribute('aria-selected'), modalOpen: modal.open };
    const close = modal.querySelector('button[data-action="close"]');
    if (!(close instanceof HTMLButtonElement)) throw new Error('Settings close button is missing');
    close.click();
    return result;
  })()`);
  assert.deepEqual(settingsInteraction, { advancedTabSelected: 'true', modalOpen: true });
  checks.settingsInteraction = true;

  await session.waitFor(
    `(() => {
      const settings = window.__ytChatOverlay?.getSettings();
      return settings?.emojiCacheMb === 1 && settings?.textCacheMb === 3 &&
        settings?.allowShortTextMessages === true && settings?.showDebugOverlay === true &&
        settings?.logLevel === 'debug' &&
        !document.querySelector('#yt-chat-overlay-settings-backdrop')?.hasAttribute('open');
    })()`,
    'normalized settings to apply'
  );
  await verifyStoredSettings(session);
  checks.settingsPersisted = true;

  session.clearPageLogs();
  await session.reload();
  await session.waitFor(
    `Boolean(window.__ytChatOverlay && document.querySelector('#${OVERLAY_ID} canvas'))`,
    'the installed Firefox extension overlay to reload'
  );
  const reloaded = await session.evaluateJson(
    `(() => {
      const settings = window.__ytChatOverlay?.getSettings();
      return {
        persisted: settings?.emojiCacheMb === 1 && settings?.textCacheMb === 3 &&
          settings?.allowShortTextMessages === true && settings?.showDebugOverlay === true &&
          settings?.logLevel === 'debug',
        accessibleMessageCount: document.querySelectorAll('#${OVERLAY_ID} .yt-live-chat-overlay-live-region > p').length
      };
    })()`
  );
  assert.equal(reloaded.persisted, true, 'Firefox extension settings did not survive reload');
  await session.waitFor(
    `document.querySelector('#yt-chat-overlay-debug > div')?.textContent === 'Rcvd: 1 | Rndr: 1'`,
    'the installed Firefox extension chat render'
  );
  const renderedCount = await session.evaluateJson(
    `document.querySelectorAll('#${OVERLAY_ID} .yt-live-chat-overlay-live-region > p').length`
  );
  assert.ok(renderedCount >= 1, 'The installed Firefox extension did not render chat');
  checks.reloadSucceeded = true;
  checks.chatRendered = true;

  await waitForLog(
    session,
    ({ text }) => text.includes('[RenderWorkerManager] renderer.worker.started'),
    'the installed extension render worker'
  );
  checks.workerReady = true;

  await session.evaluateJson(`(() => {
    const canvas = document.querySelector('#${OVERLAY_ID} canvas');
    if (!canvas) throw new Error('Overlay canvas is missing before SPA navigation');
    canvas.setAttribute('data-firefox-install-session', 'before-navigation');
    history.pushState({}, '', '/feed/trending');
    window.dispatchEvent(new Event('yt-navigate-finish'));
    return true;
  })()`);
  await session.waitFor(
    `!document.querySelector('#${OVERLAY_ID}')`,
    'the installed Firefox extension to clean up after SPA navigation'
  );
  await session.evaluateJson(`(() => {
    window.ytInitialData.currentVideoEndpoint.watchEndpoint.videoId = 'windowsFirefoxExtensionSecond';
    history.pushState({}, '', '/watch?v=windowsFirefoxExtensionSecond');
    window.dispatchEvent(new Event('yt-navigate-finish'));
    return true;
  })()`);
  await session.waitFor(
    `Boolean(
      window.__ytChatOverlay && document.querySelector('#${OVERLAY_ID} canvas') &&
      !document.querySelector('#${OVERLAY_ID} canvas[data-firefox-install-session="before-navigation"]')
    )`,
    'the installed Firefox extension to restart after SPA navigation'
  );
  checks.spaLifecycle = true;

  const errorCategories = categorizeErrors(session.pageErrors);
  const errorCount = Object.values(errorCategories).reduce((total, count) => total + count, 0);
  assert.equal(
    errorCount,
    0,
    `Firefox deterministic fixture logged errors: ${JSON.stringify(errorCategories)}`
  );
  return {
    accessibleMessageCount: renderedCount,
    errorCategories,
    errorCount,
  };
}

async function runLivePhase(session, liveEntries, output) {
  const observations = [];
  for (const [index, entry] of liveEntries.entries()) {
    session.clearPageLogs();
    let loaded = false;
    let state;
    let player;
    let workerReady = false;
    try {
      await session.navigate(entry.url, { wait: 'interactive', timeoutMs: 45_000 });
      loaded = true;
      await session.waitFor('Boolean(document.querySelector("video"))', 'the public video element');
      player = await session.evaluateJson(`(() => {
        const video = document.querySelector('video');
        video.muted = true;
        void video.play().catch(() => {});
        return { paused: video.paused, readyState: video.readyState };
      })()`);
      const playPoint = await session.evaluateJson(`(() => {
        const button = document.querySelector('.ytp-large-play-button');
        const rect = button?.getBoundingClientRect();
        return rect && rect.width > 0 && rect.height > 0
          ? { x: Math.floor(rect.x + rect.width / 2), y: Math.floor(rect.y + rect.height / 2) }
          : null;
      })()`);
      if (playPoint) {
        try {
          await session.command('input.performActions', { context: session.context, actions: [{
            type: 'pointer', id: 'acceptance-player', parameters: { pointerType: 'mouse' },
            actions: [
              { type: 'pointerMove', origin: 'viewport', x: playPoint.x, y: playPoint.y },
              { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
            ],
          }] });
        } finally {
          await session.command('input.releaseActions', { context: session.context });
        }
      }
      await session.waitFor(
        `Boolean(
          document.querySelectorAll('#${OVERLAY_ID}').length === 1 &&
          document.querySelectorAll('#${OVERLAY_ID} canvas').length === 1 &&
          document.querySelectorAll('#yt-chat-overlay-settings-button').length === 1 &&
          document.querySelectorAll('#${OVERLAY_ID} .yt-live-chat-overlay-live-region > p').length > 0 &&
          window.__ytExtensionBridge?.workerSupported === true &&
          (window.__ytExtensionBridge?.workerUrl ?? '').startsWith('blob:' + location.origin + '/')
        )`,
        'the installed Firefox extension to render public live chat',
        30_000
      );
      state = await session.evaluateJson(`(() => ({
        videoPaused: document.querySelector('video')?.paused ?? true,
        renderer: document.querySelector('#yt-chat-overlay-debug')?.textContent.includes('Render: n/a')
          ? 'worker' : /Render:\\s*\\d/.test(document.querySelector('#yt-chat-overlay-debug')?.textContent ?? '') ? 'main' : 'unknown',
        canvasCount: document.querySelectorAll('#${OVERLAY_ID} canvas').length,
        overlayCount: document.querySelectorAll('#${OVERLAY_ID}').length,
        pageScriptCount: document.querySelectorAll('script[src^="moz-extension://"][src$="/page-script.js"]').length,
        renderedMessageCount: document.querySelectorAll('#${OVERLAY_ID} .yt-live-chat-overlay-live-region > p').length,
        settingsButtonCount: document.querySelectorAll('#yt-chat-overlay-settings-button').length,
        workerBridgeReady: Boolean(window.__ytExtensionBridge?.workerSupported &&
          (window.__ytExtensionBridge?.workerUrl ?? '').startsWith('blob:' + location.origin + '/'))
      }))()`);
      workerReady = session.pageLogs.some(
        ({ text }) => text.includes('[RenderWorkerManager] renderer.worker.started')
      );
      if (
        state.overlayCount !== 1 ||
        state.canvasCount !== 1 ||
        state.settingsButtonCount !== 1 ||
        state.pageScriptCount !== 1 ||
        state.workerBridgeReady !== true ||
        state.renderedMessageCount < 1 ||
        (state.renderer === 'worker' && !workerReady)
      ) {
        throw new Error('The public YouTube page did not prove installed rendering');
      }
      const rendererResult = validateLiveRenderer(state.renderer, 'extension', session.pageLogs);
      const screenshot = `firefox-live-${String(index + 1).padStart(2, '0')}.png`;
      await writeFile(join(output, screenshot), await session.captureScreenshot());
      observations.push({
        index,
        kind: entry.kind,
        loaded: true,
        player,
        ...state,
        ...rendererResult,
        screenshot,
        workerReady,
        status: 'passed',
        errorCategories: categorizeErrors(session.pageLogs),
        errorCount: session.pageLogs.filter(({ level }) => level === 'error').length,
      });
    } catch (error) {
      await writeFailureScreenshot(
        session,
        output,
        `firefox-live-${String(index + 1).padStart(2, '0')}-failure.png`
      );
      observations.push({
        index,
        kind: entry.kind,
        loaded,
        player,
        ...(state ?? {}),
        workerReady,
        status: 'unverified',
        failureCategory: /timed out/i.test(errorMessage(error))
          ? 'readiness-timeout'
          : loaded
            ? 'installed-render-readiness'
            : 'navigation',
        errorCategories: categorizeErrors(session.pageLogs),
        errorCount: session.pageLogs.filter(({ level }) => level === 'error').length,
        failure: describeFailure(error),
        diagnostics: session.pageLogs.filter(({ level, text }) =>
          level === 'error' || /worker/i.test(text)).slice(0, 20)
          .map(({ level, text }) => ({ level, text: text.slice(0, 1000) })),
      });
    }
  }
  return observations;
}

export async function runFirefoxInstallation(
  { root, output, executablePath, headless = false, liveUrls = [] },
  { launch = launchFirefoxBidi } = {}
) {
  assert.equal(typeof root, 'string', 'root must be the extracted bundle directory');
  assert.equal(typeof output, 'string', 'output must be an artifact directory');
  assert.equal(isAbsolute(root), true, 'root must be an absolute path');
  assert.equal(isAbsolute(output), true, 'output must be an absolute path');
  assert.equal(typeof headless, 'boolean', 'headless must be a boolean');
  const resolvedExecutable = resolveSystemFirefoxExecutable({ executablePath });
  const extensionPath = join(root, 'dist-extension-firefox');
  const manifest = await stat(join(extensionPath, 'manifest.json'));
  assert.equal(manifest.isFile(), true, 'The Firefox extension manifest is missing');
  await mkdir(output, { recursive: true });
  const liveEntries = normalizeLiveUrls(liveUrls);

  const checks = {
    nativeBidi: false,
    extensionInstalled: false,
    extensionIdMatched: false,
    bridgeReady: false,
    workerReady: false,
    chatRendered: false,
    settingsInteraction: false,
    settingsPersisted: false,
    reloadSucceeded: false,
    spaLifecycle: false,
    deterministicErrorsAbsent: false,
    livePagesLoaded: liveEntries.length === 0,
    liveRenderingPassed: liveEntries.length === 0,
    extensionUninstalled: false,
    browserClosed: false,
  };
  const diagnostics = {};
  let session;
  let extensionId;
  let stopMock;
  let primaryError;
  const cleanupErrors = [];
  let deterministic;
  let live = [];

  try {
    session = await launch({ root, executablePath: resolvedExecutable, headless });
    checks.nativeBidi = true;
    stopMock = await session.startMockYouTube({
      chatResponseJson: CHAT_RESPONSE_JSON,
      nonWatchHtml: NON_WATCH_HTML,
      watchHtml: WATCH_HTML,
    });
    extensionId = await session.installExtension(extensionPath);
    checks.extensionInstalled = true;
    assert.equal(extensionId, EXTENSION_ID, 'Firefox installed an unexpected extension id');
    checks.extensionIdMatched = true;
    deterministic = await runDeterministicPhase(session, checks, diagnostics);
    checks.deterministicErrorsAbsent = true;

    await stopMock();
    stopMock = undefined;
    live = await runLivePhase(session, liveEntries, output);
    checks.livePagesLoaded = live.length === liveEntries.length && live.every(({ loaded }) => loaded);
    checks.liveRenderingPassed =
      live.length === liveEntries.length && live.every(({ status }) => status === 'passed');
    assert.equal(
      checks.liveRenderingPassed,
      true,
      'A public YouTube page did not prove installed rendering'
    );
  } catch (error) {
    primaryError = error;
    if (!checks.deterministicErrorsAbsent && session) diagnostics.errorLogs = session.pageLogs
      .filter((entry) => entry.level === 'error' || /worker/i.test(entry.text))
      .slice(0, 20).map((entry) => ({ level: entry.level, text: entry.text.slice(0, 1000) }));
    if (session) {
      await writeFailureScreenshot(session, output, 'firefox-extension-failure.png');
    }
  } finally {
    if (stopMock) {
      try {
        await stopMock();
      } catch (error) {
        cleanupErrors.push(
          new Error(`Failed to remove the fixture intercept: ${errorMessage(error)}`)
        );
      }
    }
    if (session && extensionId) {
      try {
        await session.uninstallExtension(extensionId);
        checks.extensionUninstalled = true;
      } catch (error) {
        cleanupErrors.push(
          new Error(`Failed to uninstall the Firefox extension: ${errorMessage(error)}`)
        );
      }
    }
    if (session) {
      try {
        await session.close();
        checks.browserClosed = true;
      } catch (error) {
        cleanupErrors.push(
          new Error(`Failed to close the Firefox session: ${errorMessage(error)}`, { cause: error })
        );
      }
    }
  }

  const result = {
    status: primaryError || cleanupErrors.length > 0 ? 'failed' : 'passed',
    errors: [primaryError, ...cleanupErrors].filter(Boolean).map((error) => describeFailure(error)),
    checks,
    observations: {
      browser: {
        name: session?.browserName ?? null,
        version: session?.browserVersion ?? null,
        platform: session?.platformName ?? null,
      },
      deterministic,
      diagnostics,
      execution: {
        headed: !headless,
        livePageCount: live.length,
      },
      live,
    },
  };
  try {
    await writeFile(
      join(output, 'firefox-installation-result.json'),
      JSON.stringify(result, null, 2)
    );
  } catch (error) {
    cleanupErrors.push(new Error(`Failed to persist Firefox installation result: ${errorMessage(error)}`));
  }
  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      'Firefox installation validation failed'
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Firefox installation cleanup failed');
  }
  return result;
}
