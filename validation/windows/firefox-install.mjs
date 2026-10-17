// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, win32 } from 'node:path';

import { launchFirefoxBidi } from './firefox-bidi.ts';
import {
  countUnexpectedLiveErrors,
  isYouTubeHostError,
  redactDiagnosticText,
  validateLiveRenderer,
} from './live-rendering.ts';

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
    if (
      !value.startsWith('https://www.youtube.com/') ||
      /\s/u.test(value) ||
      value.includes('\\')
    ) {
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

export function selectPublicSeekTarget(
  { currentTime, start, end },
  { preferBackward = false } = {}
) {
  if (![currentTime, start, end].every(Number.isFinite) || end - start < 5) return null;
  const backward = Math.max(start + 1, currentTime - 3);
  if (preferBackward && backward <= end - 1 && currentTime - backward >= 1) return backward;
  const forward = Math.min(end - 1, Math.max(start + 1, currentTime + 3));
  if (Math.abs(forward - currentTime) >= 1) return forward;
  return backward <= end - 1 && Math.abs(backward - currentTime) >= 1 ? backward : null;
}

export function requireFirefoxPublicCoverage(observations) {
  const modes = new Set(observations.map((item) => item.provider?.chatMode));
  assert(
    observations.length >= 2 &&
      modes.has('live') &&
      modes.has('replay') &&
      observations.some(
        (item) =>
          item.workflow?.navigation?.kind === 'full-document-cross-watch' &&
          item.workflow?.navigation?.status === 'passed'
      ) &&
      observations.every(
        (item) =>
          item.status === 'passed' &&
          ['startup', 'settings', 'pause', 'resume', 'seek'].every(
            (stage) => item.workflow?.[stage]?.status === 'passed'
          )
      ),
    'Firefox public live/replay workflow coverage is incomplete'
  );
}

async function readPublicPageState(session) {
  return session.evaluateJson(`(() => {
    const initialData = window.ytInitialData;
    let renderer = initialData?.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer;
    if (!renderer && initialData && typeof initialData === 'object') {
      const pending = [initialData];
      const seen = new Set();
      for (let visited = 0; pending.length && visited < 1000; visited++) {
        const value = pending.pop();
        if (!value || typeof value !== 'object' || seen.has(value)) continue;
        seen.add(value);
        if (value.liveChatRenderer?.continuations) {
          renderer = value.liveChatRenderer;
          break;
        }
        for (const child of Object.values(value)) {
          if (child && typeof child === 'object') pending.push(child);
        }
      }
    }
    const hostname = location.hostname;
    return {
      finalUrl: location.href,
      chatMode: renderer ? (renderer.isReplay === true ? 'replay' : 'live') : 'unknown',
      chatRendererFound: Boolean(renderer),
      playabilityStatus: window.ytInitialPlayerResponse?.playabilityStatus?.status ?? null,
      loginRedirect: hostname === 'accounts.google.com',
      consentRedirect: hostname === 'consent.youtube.com' || hostname === 'consent.google.com'
    };
  })()`);
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

async function waitForStoredPublicFontSize(session, target) {
  await session.waitFor(
    `new Promise((resolve) => {
      const nonce = window.__ytExtensionBridge?.nonce;
      if (!nonce) { resolve(false); return; }
      const requestId = 730002;
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
        try { resolve(JSON.parse(data.value).fontSize === ${target}); }
        catch { resolve(false); }
      };
      window.addEventListener('message', onMessage);
      window.postMessage({
        source: 'yt-storage-relay', nonce, requestId, method: 'get', key: '${SETTINGS_KEY}'
      }, location.origin);
    })`,
    'the public UI font size to persist in extension storage'
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

async function admitPublicPlayback(session, observation, description) {
  await session.waitFor('Boolean(document.querySelector("video"))', 'the public video element');
  Object.assign(
    observation,
    await session.evaluateJson(`(() => {
      const video = document.querySelector('video');
      video.muted = true;
      return { paused: video.paused, readyState: video.readyState };
    })()`)
  );
  await session.waitFor(
    `(() => {
      const video = document.querySelector('video');
      if (video && !video.paused && video.readyState >= 2) return true;
      const button = document.querySelector('.ytp-large-play-button');
      const rect = button?.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0 &&
        button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)));
    })()`,
    `${description} or a clickable YouTube play button`
  );
  const playPoint = await session.evaluateJson(`(() => {
    const video = document.querySelector('video');
    if (video && !video.paused && video.readyState >= 2) return null;
    const button = document.querySelector('.ytp-large-play-button');
    const rect = button?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0
      ? { x: Math.floor(rect.x + rect.width / 2), y: Math.floor(rect.y + rect.height / 2) }
      : null;
  })()`);
  if (playPoint) {
    observation.inputMethod = 'native-pointer';
    try {
      await session.command('input.performActions', {
        context: session.context,
        actions: [
          {
            type: 'pointer',
            id: 'acceptance-player',
            parameters: { pointerType: 'mouse' },
            actions: [
              { type: 'pointerMove', origin: 'viewport', x: playPoint.x, y: playPoint.y },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      });
    } finally {
      await session.command('input.releaseActions', { context: session.context });
    }
  }
  await session.waitFor(
    `Boolean(document.querySelector('video') &&
      !document.querySelector('video').paused && document.querySelector('video').readyState >= 2)`,
    description
  );
  observation.playbackStarted = true;
  observation.status = 'passed';
  observation.reason = null;
}

function publicContentStateExpression(expectedVideoId, isReplay) {
  return `(() => {
    const expectedVideoId = ${JSON.stringify(expectedVideoId)};
    const player = document.querySelector('#movie_player');
    const video = player?.querySelector('video.html5-main-video');
    const response = window.ytInitialPlayerResponse?.videoDetails;
    const responseVideoId = response?.videoId ?? null;
    let playerVideoId = null;
    try { playerVideoId = player?.getVideoData?.()?.video_id ?? null; } catch {}
    const adShowing = player?.classList.contains('ad-showing') ?? null;
    const videoDuration = Number.isFinite(video?.duration) ? video.duration : null;
    const metadataDuration = Number(response?.lengthSeconds) > 0
      ? Number(response.lengthSeconds) : null;
    const identityObserved = Boolean(responseVideoId || playerVideoId);
    const identityMatches = Boolean(expectedVideoId && identityObserved &&
      (!responseVideoId || responseVideoId === expectedVideoId) &&
      (!playerVideoId || playerVideoId === expectedVideoId));
    const durationMatches = !${isReplay} || videoDuration === null || metadataDuration === null ||
      Math.abs(videoDuration - metadataDuration) <= Math.max(5, metadataDuration * 0.01);
    const reason = !player || !video ? 'content-player-unavailable'
      : adShowing ? 'ad-showing'
      : video.paused !== false || !(video.readyState >= 2) ? 'content-playback-not-ready'
      : !identityObserved || !expectedVideoId ? 'content-identity-unavailable'
      : !identityMatches ? 'content-identity-mismatch'
      : !durationMatches ? 'content-duration-mismatch' : null;
    return {
      status: reason ? 'unverified' : 'passed', reason, adShowing,
      expectedVideoId, responseVideoId, playerVideoId,
      videoDuration, metadataDuration
    };
  })()`;
}

async function readPublicContentState(session, expectedVideoId, isReplay) {
  return session.evaluateJson(publicContentStateExpression(expectedVideoId, isReplay));
}

async function runLivePhase(session, liveEntries, output) {
  const observations = [];
  let previousMarker = null;
  let previousUrl = null;
  for (const [index, entry] of liveEntries.entries()) {
    const url = new URL(entry.url);
    const expectedVideoId =
      entry.kind === 'watch' ? url.searchParams.get('v') : url.pathname.slice(6);
    session.clearPageLogs();
    let loaded = false;
    let state;
    let player;
    let workerReady = false;
    let provider;
    let phase = 'navigation';
    const workflow = {
      startup: { status: 'not-run' },
      settings: { status: 'not-run' },
      pause: { status: 'not-run' },
      resume: { status: 'not-run' },
      seek: { status: 'not-run' },
      navigation: { status: 'not-run' },
    };
    try {
      await session.navigate(entry.url, { wait: 'interactive', timeoutMs: 45_000 });
      loaded = true;
      phase = 'provider';
      provider = await readPublicPageState(session);
      phase = 'playback';
      player = { status: 'unverified', reason: 'playback-not-observed' };
      await admitPublicPlayback(session, player, 'public video playback to start');
      phase = 'render';
      await session.waitFor(
        `Boolean(${publicContentStateExpression(expectedVideoId, provider.chatMode === 'replay')}.status === 'passed' &&
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
      player.content = await readPublicContentState(
        session,
        expectedVideoId,
        provider.chatMode === 'replay'
      );
      if (player.content.status !== 'passed') {
        throw new Error(`Public content was not ready: ${player.content.reason}`);
      }
      state = await session.evaluateJson(`(() => ({
        videoPaused: document.querySelector('#movie_player video.html5-main-video')?.paused ?? true,
        videoReadyState: document.querySelector('#movie_player video.html5-main-video')?.readyState ?? 0,
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
      workerReady = session.pageLogs.some(({ text }) =>
        text.includes('[RenderWorkerManager] renderer.worker.started')
      );
      if (
        state.overlayCount !== 1 ||
        state.canvasCount !== 1 ||
        state.settingsButtonCount !== 1 ||
        state.pageScriptCount !== 1 ||
        state.workerBridgeReady !== true ||
        state.renderedMessageCount < 1 ||
        state.videoPaused !== false ||
        state.videoReadyState < 2 ||
        (state.renderer === 'worker' && !workerReady)
      ) {
        throw new Error('The public YouTube page did not prove installed rendering');
      }
      const rendererResult = validateLiveRenderer(
        state.renderer,
        'extension',
        session.pageLogs,
        state.workerBridgeReady
      );
      provider = await readPublicPageState(session);
      workflow.startup = {
        status: provider.chatMode === 'unknown' ? 'unverified' : 'passed',
        reason: provider.chatMode === 'unknown' ? 'chat-mode-unknown' : null,
        chatMode: provider.chatMode,
        renderedMessages: state.renderedMessageCount,
      };
      if (previousMarker !== null) {
        phase = 'fresh-document-canvas-isolation';
        const freshDocumentCanvasIsolated = await session.evaluateJson(`(() => {
          const canvas = document.querySelector('#${OVERLAY_ID} canvas');
          return Boolean(canvas && canvas.getAttribute('data-firefox-live-session') !== '${previousMarker}' &&
            !document.querySelector('#${OVERLAY_ID} canvas[data-firefox-live-session="${previousMarker}"]'));
        })()`);
        const crossWatch = previousUrl !== entry.url;
        workflow.navigation = {
          status: freshDocumentCanvasIsolated && crossWatch ? 'passed' : 'unverified',
          reason: !crossWatch
            ? 'same-public-url'
            : freshDocumentCanvasIsolated
              ? null
              : 'prior-document-canvas-marker-present',
          kind: crossWatch ? 'full-document-cross-watch' : 'full-document-reload',
          documentNavigation: 'browsingContext.navigate',
          freshDocumentCanvasIsolation: freshDocumentCanvasIsolated ? 'passed' : 'unverified',
          spaRetirement: { status: 'unverified', reason: 'full-document-navigation' },
        };
      }

      phase = 'pause';
      await session.waitFor(
        `Boolean(document.querySelector('#movie_player video.html5-main-video') &&
          !document.querySelector('#movie_player video.html5-main-video').paused &&
          document.querySelector('#movie_player video.html5-main-video').readyState >= 2)`,
        'public video playback before pausing'
      );
      workflow.pause = await session.evaluateJson(`(() => {
        const video = document.querySelector('#movie_player video.html5-main-video');
        if (!video) return { status: 'unverified', reason: 'video-unavailable' };
        video.pause();
        return { status: video.paused ? 'passed' : 'unverified', paused: video.paused };
      })()`);
      phase = 'resume';
      workflow.resume = await session.evaluateJson(`(async () => {
        const video = document.querySelector('#movie_player video.html5-main-video');
        if (!video) return { status: 'unverified', reason: 'video-unavailable' };
        try { await video.play(); }
        catch { return { status: 'unverified', reason: 'play-rejected' }; }
        return { status: video.paused ? 'unverified' : 'passed', paused: video.paused };
      })()`);
      phase = 'seek';
      const seekContent = await readPublicContentState(
        session,
        expectedVideoId,
        provider.chatMode === 'replay'
      );
      if (seekContent.status !== 'passed') {
        workflow.seek = { status: 'unverified', reason: seekContent.reason, content: seekContent };
        throw new Error(`Public seek content was not ready: ${seekContent.reason}`);
      }
      const seekRange = await session.evaluateJson(`(() => {
        const video = document.querySelector('#movie_player video.html5-main-video');
        if (!video?.seekable.length) return null;
        const last = video.seekable.length - 1;
        return { currentTime: video.currentTime, start: video.seekable.start(last),
          end: video.seekable.end(last) };
      })()`);
      const seekTarget =
        seekRange &&
        selectPublicSeekTarget(seekRange, { preferBackward: provider.chatMode === 'live' });
      workflow.seek =
        seekTarget === null
          ? { status: 'unverified', reason: 'seek-range-unavailable', range: seekRange }
          : await session.evaluateJson(`(async () => {
              const content = ${publicContentStateExpression(expectedVideoId, provider.chatMode === 'replay')};
              if (content.status !== 'passed') {
                return { status: 'unverified', reason: content.reason, content, seekedEvent: false };
              }
              const video = document.querySelector('#movie_player video.html5-main-video');
              if (!video) return { status: 'unverified', reason: 'video-unavailable' };
              const preSeekTime = video.currentTime;
              const last = video.seekable.length - 1;
              const range = last >= 0
                ? { start: video.seekable.start(last), end: video.seekable.end(last) } : null;
              if (!range || ${seekTarget} < range.start || ${seekTarget} > range.end) {
                return { status: 'unverified', reason: 'seek-target-out-of-range',
                  target: ${seekTarget}, range, preSeekTime, afterTime: preSeekTime,
                  seekedEvent: false };
              }
              if (Math.abs(${seekTarget} - preSeekTime) < 1) {
                return { status: 'unverified', reason: 'seek-target-no-longer-distinct',
                  target: ${seekTarget}, range, preSeekTime, afterTime: preSeekTime,
                  seekedEvent: false };
              }
              const completed = new Promise((resolve) => {
                const timeout = setTimeout(() => resolve(false), 8000);
                video.addEventListener('seeked', () => { clearTimeout(timeout); resolve(true); }, { once: true });
              });
              video.currentTime = ${seekTarget};
              const seeked = await completed;
              const afterTime = video.currentTime;
              const positionMatched = Math.abs(afterTime - ${seekTarget}) < 2;
              return { status: seeked && positionMatched ? 'passed' : 'unverified',
                reason: !seeked ? 'seeked-event-timeout' : positionMatched
                  ? null : 'seek-position-mismatch', target: ${seekTarget}, range,
                preSeekTime, afterTime, seekedEvent: seeked, currentTime: afterTime };
            })()`);
      workflow.seek.selectionRange = seekRange;
      workflow.seek.content ??= seekContent;
      phase = 'settings';
      const changed = await session.evaluateJson(`(() => {
        const button = document.querySelector('#yt-chat-overlay-settings-button');
        if (!(button instanceof HTMLButtonElement)) throw new Error('Public settings button is missing');
        button.click();
        const modal = document.querySelector('#yt-chat-overlay-settings-backdrop');
        const input = modal?.querySelector('input[name="fontSize"]');
        const close = modal?.querySelector('button[data-action="close"]');
        if (!(modal instanceof HTMLDialogElement) || !(input instanceof HTMLInputElement) ||
            !(close instanceof HTMLButtonElement) || !modal.open) {
          throw new Error('Public settings dialog is unavailable');
        }
        const before = input.value;
        const target = before === '36' ? '34' : '36';
        input.value = target;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        close.click();
        return { before, target, modalClosed: !modal.open };
      })()`);
      assert(
        ['34', '36'].includes(changed.target),
        'Public settings UI returned an invalid font size'
      );
      await session.waitFor(
        `window.__ytChatOverlay?.getSettings()?.fontSize === Number('${changed.target}')`,
        'public UI font size to apply'
      );
      await waitForStoredPublicFontSize(session, Number(changed.target));
      const postReloadPlayback = { status: 'unverified', reason: 'playback-not-observed' };
      workflow.settings.postReloadPlayback = postReloadPlayback;
      await session.reload();
      phase = 'settings-reload-playback';
      await admitPublicPlayback(
        session,
        postReloadPlayback,
        'public video playback after settings reload'
      );
      phase = 'settings';
      await session.waitFor(
        `Boolean(window.__ytChatOverlay && document.querySelector('#${OVERLAY_ID} canvas') &&
          document.querySelector('#yt-chat-overlay-settings-button') &&
          document.querySelectorAll('#${OVERLAY_ID} .yt-live-chat-overlay-live-region > p').length > 0)`,
        'the public overlay to reload with settings'
      );
      await session.waitFor(
        `Boolean(document.querySelector('video')?.readyState >= 2)`,
        'the public video to be ready after settings reload'
      );
      const persisted = await session.evaluateJson(`(() => {
        const button = document.querySelector('#yt-chat-overlay-settings-button');
        button?.click();
        const modal = document.querySelector('#yt-chat-overlay-settings-backdrop');
        const value = modal?.querySelector('input[name="fontSize"]')?.value ?? null;
        modal?.querySelector('button[data-action="close"]')?.click();
        return { value, effective: window.__ytChatOverlay?.getSettings()?.fontSize ?? null };
      })()`);
      workflow.settings = {
        status:
          changed.modalClosed &&
          persisted.value === changed.target &&
          persisted.effective === Number(changed.target)
            ? 'passed'
            : 'unverified',
        before: changed.before,
        target: changed.target,
        persisted,
        postReloadPlayback,
      };
      phase = 'capture';
      const marker = String(index + 1);
      await session.evaluateJson(`(() => {
        const canvas = document.querySelector('#${OVERLAY_ID} canvas');
        if (!canvas) throw new Error('Public overlay canvas is missing after reload');
        canvas.setAttribute('data-firefox-live-session', '${marker}');
        return true;
      })()`);
      previousMarker = marker;
      previousUrl = entry.url;
      const screenshot = `firefox-live-${String(index + 1).padStart(2, '0')}.png`;
      await writeFile(join(output, screenshot), await session.captureScreenshot());
      assert.equal(
        countUnexpectedLiveErrors(session.pageLogs, rendererResult.workerPolicyFallback),
        0,
        'The public page logged unexpected errors'
      );
      const failedStage = Object.entries(workflow).find(
        ([stage, value]) => (stage !== 'navigation' || index > 0) && value.status !== 'passed'
      );
      observations.push({
        index,
        kind: entry.kind,
        loaded: true,
        player,
        ...state,
        ...rendererResult,
        screenshot,
        workerReady,
        provider,
        workflow,
        status: failedStage ? 'unverified' : 'passed',
        ...(failedStage
          ? {
              failureCategory: `${failedStage[0]}-${failedStage[1].reason ?? 'state-not-observed'}`,
            }
          : {}),
        hostErrorCount: session.pageLogs.filter(isYouTubeHostError).length,
        unexpectedErrorCount: 0,
        errorCategories: categorizeErrors(session.pageLogs),
        errorCount: session.pageLogs.filter(({ level }) => level === 'error').length,
      });
    } catch (error) {
      if (phase === 'render' && player && !player.content) {
        player.content = await readPublicContentState(
          session,
          expectedVideoId,
          provider?.chatMode === 'replay'
        ).catch(() => null);
      }
      if (loaded && player) {
        player.finalState = await session
          .evaluateJson(`(() => {
          const video = document.querySelector('video');
          return {
            paused: video?.paused ?? null,
            readyState: video?.readyState ?? null,
            networkState: video?.networkState ?? null,
            mediaErrorCode: video?.error?.code ?? null,
            playability: window.ytInitialPlayerResponse?.playabilityStatus?.status ?? null,
            playerError: document.querySelector('.ytp-error-content-wrap')?.textContent?.slice(0, 300) ?? null
          };
        })()`)
          .catch(() => null);
      }
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
        provider,
        workflow,
        phase,
        status: 'unverified',
        failureCategory: provider?.loginRedirect
          ? 'provider-login-redirect'
          : provider?.consentRedirect
            ? 'provider-consent-redirect'
            : provider?.playabilityStatus && provider.playabilityStatus !== 'OK'
              ? 'provider-playability-unavailable'
              : provider?.chatRendererFound === false
                ? 'provider-chat-renderer-unavailable'
                : /timed out/i.test(errorMessage(error))
                  ? `${phase}-timeout`
                  : `${phase}-error`,
        errorCategories: categorizeErrors(session.pageLogs),
        errorCount: session.pageLogs.filter(({ level }) => level === 'error').length,
        failure: describeFailure(error),
        diagnostics: session.pageLogs
          .filter(({ level, text }) => level === 'error' || /worker/i.test(text))
          .slice(0, 20)
          .map(({ level, text }) => ({ level, text: redactDiagnosticText(text) })),
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
    livePagesLoaded: liveEntries.length === 0 ? null : false,
    liveRenderingPassed: liveEntries.length === 0 ? null : false,
    liveWorkflowCoverage: liveEntries.length === 0 ? null : false,
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
    if (liveEntries.length > 0) {
      checks.livePagesLoaded =
        live.length === liveEntries.length && live.every(({ loaded }) => loaded);
      checks.liveRenderingPassed =
        live.length === liveEntries.length && live.every(({ status }) => status === 'passed');
      if (checks.liveRenderingPassed) {
        requireFirefoxPublicCoverage(live);
        checks.liveWorkflowCoverage = true;
      }
      assert.equal(
        checks.liveRenderingPassed && checks.liveWorkflowCoverage,
        true,
        'A public YouTube page did not prove installed rendering and workflow coverage'
      );
    }
  } catch (error) {
    primaryError = error;
    if (!checks.deterministicErrorsAbsent && session)
      diagnostics.errorLogs = session.pageLogs
        .filter((entry) => entry.level === 'error' || /worker/i.test(entry.text))
        .slice(0, 20)
        .map((entry) => ({ level: entry.level, text: entry.text.slice(0, 1000) }));
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
    cleanupErrors.push(
      new Error(`Failed to persist Firefox installation result: ${errorMessage(error)}`)
    );
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
