// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { run as runFixture } from './profile.mjs';
import { runPlacementTimingFixture } from './placement-timing.mjs';
import { countUnexpectedLiveErrors, isYouTubeHostError, redactDiagnosticText, validateLiveRenderer } from './live-rendering.mjs';
import { captureOwnedChromeProcess, terminateOwnedChromeProcess } from './chrome-process.mjs';

const SCRIPT_NAME = 'YouTube Live Chat Overlay';
const CHROME_PROFILE_PREFIX = 'chrome-install-';
const GRACEFUL_PROCESS_EXIT_MS = 2_000;
const PROCESS_EXIT_TIMEOUT_MS = 5_000;

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function assertOwnedProfile(root, profile) {
  const resolvedRoot = resolve(root);
  const resolvedProfile = resolve(profile);
  if (
    dirname(resolvedProfile) !== resolvedRoot ||
    !basename(resolvedProfile).startsWith(CHROME_PROFILE_PREFIX)
  ) {
    throw new Error('Refusing to remove a Chrome profile outside the task root');
  }
}

export function readOwnedBrowserProcessId(response) {
  const browsers = Array.isArray(response?.processInfo)
    ? response.processInfo.filter(({ type }) => type === 'browser')
    : [];
  if (
    browsers.length !== 1 ||
    !Number.isSafeInteger(browsers[0]?.id) ||
    browsers[0].id <= 0
  ) {
    throw new Error('Browser CDP did not expose one task-owned browser process');
  }
  return browsers[0].id;
}

async function isProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessExit(
  processId,
  checkAlive = isProcessAlive,
  timeoutMs = PROCESS_EXIT_TIMEOUT_MS
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await checkAlive(processId))) return true;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  return !(await checkAlive(processId));
}

export async function removeOwnedChromeProfile(root, profile) {
  assertOwnedProfile(root, profile);
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const removed = await stat(profile).then(() => false, (error) => {
    if (error.code === 'ENOENT') return true;
    throw error;
  });
  if (!removed) throw new Error('Task-owned Chrome profile remained after bounded cleanup');
}

export async function enableDeveloperMode(context, browserName) {
  const page = await context.newPage();
  try {
    await page.goto(browserName === 'msedge' ? 'edge://extensions/' : 'chrome://extensions/');
    const toggle = page.locator(browserName === 'msedge' ? '#dev-switch:visible' : '#devMode');
    await toggle.waitFor({ state: 'visible' });
    if (!(await toggle.evaluate((element) => element.checked))) await toggle.click();
    assert(await toggle.evaluate((element) => element.checked), 'Developer mode is disabled');
  } finally {
    await page.close();
  }
}

async function installUserscript(context, id, root, output) {
  const managerRoot = join(root, 'test-tools/userscript-manager');
  const managerManifest = JSON.parse(await readFile(join(managerRoot, 'manifest.json'), 'utf8'));
  const page = await context.newPage();
  try {
    await page.goto(`chrome://extensions/?id=${id}`);
    const toggle = page.locator('#allow-user-scripts cr-toggle');
    await toggle.waitFor({ state: 'visible' });
    if (!(await toggle.evaluate((element) => element.checked))) await toggle.click();
    assert(await toggle.evaluate((element) => element.checked), 'User scripts permission is disabled');
    const keep = page.getByRole('button', { name: 'Keep', exact: true });
    if (await keep.isVisible()) await keep.click();
    const restarted = context.waitForEvent('serviceworker', {
      predicate: (worker) => worker.url().startsWith(`chrome-extension://${id}/`),
      timeout: 15_000,
    });
    await page.locator('extensions-detail-view #dev-reload-button').click();
    await restarted;
    await page.goto(`chrome-extension://${id}/options.html`);
    await page.getByText('Utilities', { exact: true }).click();
    const confirmationPromise = context.waitForEvent('page');
    await page.locator('input[type=file]').setInputFiles(join(root, 'dist/yt-live-chat-overlay.user.js'));
    const confirmation = await confirmationPromise;
    await confirmation.waitForURL(`chrome-extension://${id}/ask.html*`);
    const closed = confirmation.waitForEvent('close');
    await confirmation.getByRole('button', { name: 'Install', exact: true }).click();
    await closed;
    await page.reload();
    await page.getByText('Installed Userscripts', { exact: true }).first().click();
    await page.getByText(SCRIPT_NAME, { exact: true }).first().waitFor({ state: 'visible' });
    await page.screenshot({ path: join(output, 'userscript-installed.png') });
    return { id, managerVersion: managerManifest.version, scriptName: SCRIPT_NAME };
  } catch (error) {
    await page.screenshot({ path: join(output, 'userscript-install-error.png') }).catch(() => {});
    throw error;
  } finally {
    await page.close();
  }
}

/** Select an in-range move that differs materially from current playback. */
export function selectPublicSeekTarget({ currentTime, start, end }) {
  if (![currentTime, start, end].every(Number.isFinite) || end - start < 5) return null;
  const forward = Math.min(end - 1, Math.max(start + 1, currentTime + 3));
  if (Math.abs(forward - currentTime) >= 1) return forward;
  const backward = Math.max(start + 1, currentTime - 3);
  return Math.abs(backward - currentTime) >= 1 ? backward : null;
}

export async function readPublicPageState(page) {
  return page.evaluate(() => {
    const initialData = window.ytInitialData;
    let renderer = initialData?.contents?.twoColumnWatchNextResults
      ?.conversationBar?.liveChatRenderer;
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
    const hostname = new URL(location.href).hostname;
    return {
      chatMode: renderer ? renderer.isReplay === true ? 'replay' : 'live' : 'unknown',
      chatRendererFound: Boolean(renderer),
      playabilityStatus: window.ytInitialPlayerResponse?.playabilityStatus?.status ?? null,
      loginRedirect: hostname === 'accounts.google.com',
      consentRedirect: hostname === 'consent.youtube.com' || hostname === 'consent.google.com',
    };
  }).catch(() => ({ chatMode: 'unknown', chatRendererFound: false,
    playabilityStatus: null, loginRedirect: false, consentRedirect: false }));
}

/** Observe a real watch page without supplying application code or site responses. */
async function inspectLivePage(context, url, output, index, installation, nextUrl = url) {
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  const workerDiagnostics = [];
  const consoleErrors = [];
  let consoleErrorOverflow = 0;
  page.on('pageerror', (error) => pageErrors.push(error.name));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error') {
      if (consoleErrors.length < 32) consoleErrors.push({ type: 'error', text: text.slice(0, 1000), url: message.location().url });
      else consoleErrorOverflow++;
    }
    if (/worker|TrustedScriptURL/i.test(text) && workerDiagnostics.length < 20) {
      workerDiagnostics.push({ type: message.type(), text: redactDiagnosticText(text), url: redactDiagnosticText(message.location().url) });
    }
  });
  const observation = { url, status: 'not-run', mocked: false };
  let deadlineReached = false;
  let deadlineCleanup;
  const screenshot = `live-${index}.png`;
  const deadline = setTimeout(() => {
    deadlineReached = true;
    deadlineCleanup = page.screenshot({ path: join(output, screenshot), timeout: 3000 })
      .then(() => { observation.screenshot = screenshot; }, () => {})
      .finally(() => page.close().catch(() => {}));
  }, 120_000);
  try {
    observation.phase = 'navigation';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    observation.finalUrl = page.url();
    observation.title = await page.title();
    const rejectConsent = page.getByRole('button', { name: 'Reject all', exact: true });
    if (await rejectConsent.isVisible().catch(() => false)) await rejectConsent.click();
    observation.phase = 'player';
    await page.locator('#movie_player').waitFor({ state: 'visible', timeout: 20_000 });
    observation.video = await page.locator('video').first().evaluate((video) => {
      video.muted = true;
      void video.play().catch(() => {});
      return { paused: video.paused, readyState: video.readyState, errorCode: video.error?.code ?? null };
    });
    observation.phase = 'settings';
    const settingsButton = page.locator('#yt-chat-overlay-settings-button');
    await settingsButton.waitFor({ state: 'visible', timeout: 20_000 });
    await settingsButton.focus();
    await page.keyboard.press('Enter');
    const modal = page.locator('#yt-chat-overlay-settings-backdrop');
    await modal.waitFor({ state: 'visible' });
    const fontSize = modal.locator('input[name="fontSize"]');
    observation.fontSize = Number(await fontSize.inputValue());
    await page.keyboard.press('Escape');
    observation.phase = 'chat';
    await page.waitForFunction(() =>
      document.querySelectorAll('.yt-live-chat-overlay-live-region > p').length > 0,
      undefined, { timeout: 30_000 });
    observation.renderedMessages = await page.locator('.yt-live-chat-overlay-live-region > p').count();
    observation.canvasAttached = await page.locator('#yt-live-chat-overlay canvas').count() === 1;
    const renderer = await page.locator('#yt-chat-overlay-debug').innerText();
    observation.renderer = renderer.includes('Render: n/a') ? 'worker' : 'main';
    observation.installedBridgeReady = await page.evaluate(() => Boolean(
      window.__ytExtensionBridge?.workerSupported === true &&
      window.__ytExtensionBridge?.storageType === 'chrome.storage.local' &&
      window.__ytExtensionBridge?.workerUrl?.startsWith('blob:' + location.origin + '/')
    ));
    Object.assign(observation, validateLiveRenderer(observation.renderer, installation,
      workerDiagnostics, observation.installedBridgeReady));
    const pageState = await readPublicPageState(page);
    observation.chatMode = pageState.chatMode;
    observation.provider = pageState;
    observation.workflow = { startup: { status: 'passed', chatMode: observation.chatMode,
      renderedMessages: observation.renderedMessages } };
    observation.phase = 'pause';
    observation.workflow.pause = await page.locator('video').first().evaluate((video) => {
      video.pause();
      return { status: video.paused ? 'passed' : 'unverified', paused: video.paused };
    });
    observation.phase = 'resume';
    observation.workflow.resume = await page.locator('video').first().evaluate(async (video) => {
      try { await video.play(); } catch { return { status: 'unverified', reason: 'play-rejected' }; }
      return { status: video.paused ? 'unverified' : 'passed', paused: video.paused };
    });
    observation.phase = 'seek';
    const seekRange = await page.locator('video').first().evaluate((video) => {
      if (!video.seekable.length) return null;
      const last = video.seekable.length - 1;
      return { currentTime: video.currentTime, start: video.seekable.start(last),
        end: video.seekable.end(last) };
    });
    const target = seekRange && selectPublicSeekTarget(seekRange);
    if (target === null) {
      observation.workflow.seek = { status: 'unverified', reason: 'seek-range-unavailable',
        range: seekRange };
    } else {
      observation.workflow.seek = await page.locator('video').first().evaluate(async (video, seekTo) => {
        const completed = new Promise((resolve) => {
          const timeout = setTimeout(() => resolve(false), 8000);
          video.addEventListener('seeked', () => { clearTimeout(timeout); resolve(true); }, { once: true });
        });
        video.currentTime = seekTo;
        const seeked = await completed;
        return { status: seeked && Math.abs(video.currentTime - seekTo) < 2 ? 'passed' : 'unverified',
          reason: seeked ? null : 'seeked-event-timeout', target: seekTo,
          currentTime: video.currentTime };
      }, target);
    }
    observation.phase = 'navigation-transition';
    const diagnosticStart = workerDiagnostics.length;
    await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.locator('#movie_player').waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator('#yt-live-chat-overlay canvas').waitFor({ state: 'attached', timeout: 20_000 });
    await page.waitForFunction(() =>
      document.querySelectorAll('.yt-live-chat-overlay-live-region > p').length > 0,
    undefined, { timeout: 30_000 });
    const nextPageState = await readPublicPageState(page);
    const nextRendererText = await page.locator('#yt-chat-overlay-debug').innerText();
    const nextRenderer = nextRendererText.includes('Render: n/a') ? 'worker' : 'main';
    const nextBridgeReady = await page.evaluate(() => Boolean(
      window.__ytExtensionBridge?.workerSupported === true &&
      window.__ytExtensionBridge?.storageType === 'chrome.storage.local' &&
      window.__ytExtensionBridge?.workerUrl?.startsWith('blob:' + location.origin + '/')
    ));
    const nextRendererPolicy = validateLiveRenderer(nextRenderer, installation,
      workerDiagnostics.slice(diagnosticStart), nextBridgeReady);
    observation.workflow.navigation = { status: nextPageState.chatMode === 'unknown' ? 'unverified' : 'passed',
      reason: nextPageState.chatMode === 'unknown' ? 'chat-mode-unknown' : null,
      kind: nextUrl === url ? 'reload' : 'cross-watch', chatMode: nextPageState.chatMode,
      canvasAttached: true, renderer: nextRenderer,
      installedBridgeReady: nextBridgeReady, ...nextRendererPolicy,
      renderedMessages: await page.locator('.yt-live-chat-overlay-live-region > p').count() };
    if (pageState.chatMode === 'unknown') {
      observation.workflow.startup.status = 'unverified';
      observation.workflow.startup.reason = 'chat-mode-unknown';
    }
    const failedStage = Object.entries(observation.workflow)
      .find(([, stage]) => stage.status !== 'passed');
    if (failedStage) {
      observation.status = 'unverified';
      observation.reason = `${failedStage[0]}-${failedStage[1].reason ?? 'state-not-observed'}`;
      observation.phase = failedStage[0];
      return observation;
    }
    observation.status = 'passed';
    observation.phase = 'complete';
  } catch (error) {
    observation.status = 'unverified';
    observation.provider = await readPublicPageState(page);
    observation.reason = deadlineReached ? 'live-url-deadline'
      : observation.provider.loginRedirect ? 'provider-login-redirect'
        : observation.provider.consentRedirect ? 'provider-consent-redirect'
          : observation.provider.playabilityStatus && observation.provider.playabilityStatus !== 'OK'
            ? 'provider-playability-unavailable'
            : !observation.provider.chatRendererFound && observation.phase === 'chat'
              ? 'provider-chat-renderer-unavailable'
              : error.name === 'TimeoutError' ? `${observation.phase}-timeout`
                : `${observation.phase}-error`;
  } finally {
    clearTimeout(deadline);
    if (deadlineCleanup) await deadlineCleanup;
    observation.workerDiagnostics = workerDiagnostics;
    if (!page.isClosed()) {
      await page.screenshot({ path: join(output, screenshot) }).then(() => {
        observation.screenshot = screenshot;
      }, () => {});
    }
    await page.close();
    observation.pageErrorTypes = [...new Set(pageErrors)];
    observation.unexpectedConsoleErrors = consoleErrorOverflow +
      countUnexpectedLiveErrors(consoleErrors, observation.workerPolicyFallback);
    observation.hostConsoleErrors = consoleErrors.filter(isYouTubeHostError).length;
    observation.consoleErrors = consoleErrors.map(({ type, text, url }) => ({
      type, text: redactDiagnosticText(text), url: redactDiagnosticText(url),
    }));
    if (observation.status === 'passed' && (observation.pageErrorTypes.length > 0 || observation.unexpectedConsoleErrors > 0)) {
      observation.status = 'unverified';
      observation.reason = 'unexpected-page-errors';
    }
  }
  return observation;
}

export function requireLiveSuccess(observations) {
  assert(observations.every((item) => item.status === 'passed' && item.canvasAttached && item.renderedMessages > 0 &&
    (item.pageErrorTypes?.length ?? 0) === 0 && (item.unexpectedConsoleErrors ?? 0) === 0),
    'One or more requested live pages did not prove installed application rendering');
}

/** Attempt every owned cleanup stage even when an earlier operation fails. */
export async function cleanupChromeInstallation(
  { browserProcessId, browserProcessIdentity, context, cdp, extensionId, profile, output, result, root },
  {
    checkProcessAlive = isProcessAlive,
    terminateProcessTree = () => terminateOwnedChromeProcess(browserProcessIdentity),
    waitForExit,
  } = {}
) {
  const errors = [];
  const errorTypes = [];
  const recordError = (stage, error) => {
    errors.push(error);
    errorTypes.push({ stage, errorType: error instanceof Error ? error.name : typeof error });
  };
  if (cdp && extensionId) {
    try {
      await cdp.send('Extensions.uninstall', { id: extensionId });
      result.cleanup.extensionUninstalled = true;
    } catch (error) { recordError('extension-uninstall', error); }
  }
  try {
    await context?.close();
    result.cleanup.browserClosed = true;
  } catch (error) {
    recordError('context-close', error);
    try {
      const ownedBrowser = context?.browser();
      if (!ownedBrowser) throw new Error('Owned browser cleanup handle is unavailable');
      await ownedBrowser.close();
      result.cleanup.browserClosed = true;
    } catch (fallbackError) { recordError('browser-close', fallbackError); }
  }
  let browserProcessExited = result.cleanup.browserClosed === true;
  if (browserProcessId !== undefined) {
    try {
      if (result.cleanup.browserClosed === true) {
        browserProcessExited = waitForExit
          ? await waitForExit(browserProcessId, GRACEFUL_PROCESS_EXIT_MS)
          : await waitForProcessExit(
              browserProcessId,
              checkProcessAlive,
              GRACEFUL_PROCESS_EXIT_MS
            );
      } else {
        browserProcessExited = !(await checkProcessAlive(browserProcessId));
      }
    } catch (error) {
      browserProcessExited = false;
      recordError('browser-process-exit-check', error);
    }
    if (!browserProcessExited) {
      let terminationError;
      let terminationErrorStage;
      try {
        await terminateProcessTree(browserProcessId);
      } catch (error) {
        terminationError = error;
        terminationErrorStage = 'browser-process-tree-termination';
      }
      try {
        browserProcessExited = waitForExit
          ? await waitForExit(browserProcessId, PROCESS_EXIT_TIMEOUT_MS)
          : await waitForProcessExit(browserProcessId, checkProcessAlive);
      } catch (error) {
        terminationError ??= error;
        terminationErrorStage ??= 'browser-process-exit-check';
        browserProcessExited = false;
      }
      if (!browserProcessExited) {
        recordError(
          terminationErrorStage ?? 'browser-process-tree-exit',
          terminationError ?? new Error('Task-owned browser process tree did not terminate')
        );
      }
    }
  } else if (!browserProcessExited) {
    recordError(
      'browser-process-identity',
      new Error('Task-owned browser process identity is unavailable')
    );
  }
  result.cleanup.browserProcessExited = browserProcessExited;
  if (browserProcessExited) {
    try {
      await removeOwnedChromeProfile(root, profile);
      result.cleanup.profileRemoved = true;
    } catch (error) { recordError('profile-remove', error); }
  } else {
    result.cleanup.profilePreserved = true;
  }
  result.cleanup.errorCount = errors.length;
  result.cleanup.errorTypes = errorTypes;
  await writeFile(join(output, 'installation-result.json'), JSON.stringify(result, null, 2));
  if (errors.length) throw new AggregateError(errors, 'Chrome installation cleanup failed');
}

/** Install real browser packages in an isolated profile and exercise their normal delivery. */
export async function runChromeInstallation({
  chromium, root, output, browserName = 'chrome', headless = false,
  installation, liveUrls = [], liveObservation = null,
}) {
  assert(['chrome', 'msedge'].includes(browserName), 'Unsupported Chromium channel');
  assert(['extension', 'userscript'].includes(installation), 'Unknown installation mode');
  assert(Array.isArray(liveUrls) && liveUrls.length <= 3,
    'At most three live URLs can run within the guest deadline');
  if (liveObservation !== null) {
    assert.deepEqual(liveObservation, { mode: 'duration', duration_seconds: 1200 });
    assert.equal(browserName, 'chrome', 'Duration observation requires installed Chrome');
    assert.equal(headless, false, 'Duration observation requires a headed browser');
    assert.equal(installation, 'extension', 'Duration observation requires the extension');
    assert.equal(liveUrls.length, 1, 'Duration observation requires one public live URL');
    return runChromeDurationInstallation({
      chromium, root, output, installation, liveUrls, liveObservation,
    });
  }
  const profile = await mkdtemp(join(root, 'chrome-install-'));
  let context;
  let cdp;
  let extensionId;
  let browserProcessId;
  let browserProcessIdentity;
  let primaryError;
  const result = { installation, fixture: null, placementTiming: null,
    live: [], liveWorkflowCoverage: null, cleanup: {} };
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: browserName,
      headless,
      locale: 'en-US',
      viewport: { width: 1280, height: 720 },
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', '--mute-audio'],
    });
    result.browserVersion = context.browser().version();
    cdp = await context.browser().newBrowserCDPSession();
    browserProcessId = readOwnedBrowserProcessId(await cdp.send('SystemInfo.getProcessInfo'));
    browserProcessIdentity = await captureOwnedChromeProcess(browserProcessId, profile);
    result.cleanup.browserProcessIdentified = true;
    await enableDeveloperMode(context, browserName);
    if (installation === 'extension') {
      ({ id: extensionId } = await cdp.send('Extensions.loadUnpacked', {
        path: join(root, 'dist-extension'),
      }));
      assert.equal(typeof extensionId, 'string');
      result.installationMethod = 'cdp-unpacked-extension';
    } else {
      ({ id: extensionId } = await cdp.send('Extensions.loadUnpacked', {
        path: join(root, 'test-tools/userscript-manager'),
      }));
      const installed = await installUserscript(context, extensionId, root, output);
      result.userscriptManager = installed;
      result.installationMethod = 'real-manager-ui-import';
    }
    result.fixture = await runFixture({ browser: context.browser(), root, output,
      installedContext: context, installedExtensionId: extensionId,
      expectedRenderer: installation === 'extension' ? 'worker' : 'main' });
    if (browserName === 'msedge' && installation === 'extension') {
      // A baseline-only harness commit can set this to true with the same probe bytes.
      const comparisonOnly = false;
      result.placementTiming = await runPlacementTimingFixture({
        context, root, output, extensionId, comparisonOnly,
      });
      assert.equal(result.placementTiming.status, 'passed',
        'Installed Edge placement or replay fixture did not satisfy its observations');
    }
    for (const [index, url] of liveUrls.entries()) {
      const nextUrl = liveUrls.length > 1 ? liveUrls[(index + 1) % liveUrls.length] : url;
      result.live.push(await inspectLivePage(context, url, output, index, installation, nextUrl));
    }
    if (liveUrls.length > 0) {
      const observedModes = [...new Set(result.live.map((item) => item.chatMode))];
      const crossWatch = result.live.some((item) => item.workflow?.navigation?.kind === 'cross-watch' &&
        item.workflow.navigation.status === 'passed');
      result.liveWorkflowCoverage = { observedModes, crossWatch,
        status: observedModes.includes('live') && observedModes.includes('replay') && crossWatch &&
          result.live.every((item) => item.status === 'passed') ? 'complete' : 'partial' };
      if (browserName === 'msedge' && installation === 'extension' && liveUrls.length >= 2) {
        assert.equal(result.liveWorkflowCoverage.status, 'complete',
          'Public live and replay workflow coverage is incomplete');
      }
    }
    requireLiveSuccess(result.live);
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await cleanupChromeInstallation({
        browserProcessId,
        browserProcessIdentity,
        context,
        cdp,
        extensionId,
        profile,
        output,
        result,
        root,
      });
    } catch (cleanupError) {
      if (primaryError) throw new AggregateError([primaryError, cleanupError], 'Installation and cleanup failed');
      throw cleanupError;
    }
  }
}

async function runChromeDurationInstallation({
  chromium, root, output, installation, liveUrls, liveObservation,
}) {
  const [{ launchOwnedNaturalChrome }, { runLiveDuration }] = await Promise.all([
    import('./natural-chrome.mjs'),
    import('./live-duration.mjs'),
  ]);
  let ownedChrome;
  let extensionId;
  let primaryError;
  const result = {
    installation,
    fixture: null,
    live: [],
    liveObservation,
    cleanup: {},
  };
  try {
    ownedChrome = await launchOwnedNaturalChrome({ chromium, root, output });
    const { browser, context } = ownedChrome;
    result.browserVersion = browser.version();
    result.naturalChrome = ownedChrome.launchEvidence;
    result.cleanup.browserProcessIdentified = true;
    await enableDeveloperMode(context, 'chrome');
    ({ id: extensionId } = await ownedChrome.cleanupCdp.send('Extensions.loadUnpacked', {
      path: join(root, 'dist-extension'),
    }));
    assert.equal(typeof extensionId, 'string');
    result.installationMethod = 'cdp-unpacked-extension';
    result.fixture = await runFixture({
      browser,
      root,
      output,
      installedContext: context,
      installedExtensionId: extensionId,
      expectedRenderer: 'worker',
    });
    const observation = await runLiveDuration({
      context,
      url: liveUrls[0],
      output,
      installation,
    });
    result.live.push(observation);
    assert.equal(
      observation.evidenceStatus,
      'observed',
      `Duration observation remained unverified: ${observation.evidenceStatusReasons?.join(', ')}`
    );
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (ownedChrome) {
      try {
        await cleanupChromeInstallation({
          browserProcessId: ownedChrome.browserProcessId,
          browserProcessIdentity: ownedChrome.browserProcessIdentity,
          context: ownedChrome.cleanupContext,
          cdp: ownedChrome.cleanupCdp,
          extensionId,
          profile: ownedChrome.profile,
          output,
          result,
          root,
        });
      } catch (cleanupError) {
        if (primaryError) {
          throw new AggregateError(
            [primaryError, cleanupError],
            'Duration observation and cleanup failed'
          );
        }
        throw cleanupError;
      }
    }
  }
}
