// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { run as runFixture } from './profile.mjs';
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

async function removeOwnedProfile(root, profile) {
  assertOwnedProfile(root, profile);
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const removed = await stat(profile).then(() => false, (error) => {
    if (error.code === 'ENOENT') return true;
    throw error;
  });
  if (!removed) throw new Error('Task-owned Chrome profile remained after bounded cleanup');
}

async function enableDeveloperMode(context) {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions/');
    const toggle = page.locator('#devMode');
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

/** Observe a real watch page without supplying application code or site responses. */
async function inspectLivePage(context, url, output, index, installation) {
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
      if (consoleErrors.length < 32) consoleErrors.push({ type: 'error', text: text.slice(0, 1000) });
      else consoleErrorOverflow++;
    }
    if (/worker|TrustedScriptURL/i.test(text) && workerDiagnostics.length < 20) {
      workerDiagnostics.push({ type: message.type(), text: redactDiagnosticText(text) });
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
  }, 60_000);
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
    observation.status = 'passed';
    observation.phase = 'complete';
  } catch (error) {
    observation.status = 'unverified';
    observation.reason = deadlineReached ? 'live-url-deadline'
      : error.name === 'TimeoutError' ? 'watch-page-or-chat-readiness-timeout' : 'navigation-or-render-error';
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
  if (cdp && extensionId) {
    try {
      await cdp.send('Extensions.uninstall', { id: extensionId });
      result.cleanup.extensionUninstalled = true;
    } catch (error) { errors.push(error); }
  }
  try {
    await context?.close();
    result.cleanup.browserClosed = true;
  } catch (error) {
    errors.push(error);
    try {
      const ownedBrowser = context?.browser();
      if (!ownedBrowser) throw new Error('Owned browser cleanup handle is unavailable');
      await ownedBrowser.close();
      result.cleanup.browserClosed = true;
    } catch (fallbackError) { errors.push(fallbackError); }
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
      errors.push(error);
    }
    if (!browserProcessExited) {
      let terminationError;
      try {
        await terminateProcessTree(browserProcessId);
      } catch (error) {
        terminationError = error;
      }
      try {
        browserProcessExited = waitForExit
          ? await waitForExit(browserProcessId, PROCESS_EXIT_TIMEOUT_MS)
          : await waitForProcessExit(browserProcessId, checkProcessAlive);
      } catch (error) {
        terminationError ??= error;
        browserProcessExited = false;
      }
      if (!browserProcessExited) {
        errors.push(
          terminationError ?? new Error('Task-owned browser process tree did not terminate')
        );
      }
    }
  } else if (!browserProcessExited) {
    errors.push(new Error('Task-owned browser process identity is unavailable'));
  }
  result.cleanup.browserProcessExited = browserProcessExited;
  if (browserProcessExited) {
    try {
      await removeOwnedProfile(root, profile);
      result.cleanup.profileRemoved = true;
    } catch (error) { errors.push(error); }
  } else {
    result.cleanup.profilePreserved = true;
  }
  result.cleanup.errorCount = errors.length;
  await writeFile(join(output, 'installation-result.json'), JSON.stringify(result, null, 2));
  if (errors.length) throw new AggregateError(errors, 'Chrome installation cleanup failed');
}

/** Install real browser packages in an isolated profile and exercise their normal delivery. */
export async function runChromeInstallation({
  chromium, root, output, browserName = 'chrome', headless = false,
  installation, liveUrls = [],
}) {
  assert(['chrome', 'msedge'].includes(browserName), 'Unsupported Chromium channel');
  assert(['extension', 'userscript'].includes(installation), 'Unknown installation mode');
  assert(Array.isArray(liveUrls) && liveUrls.length <= 3,
    'At most three live URLs can run within the guest deadline');
  const profile = await mkdtemp(join(root, 'chrome-install-'));
  let context;
  let cdp;
  let extensionId;
  let browserProcessId;
  let browserProcessIdentity;
  let primaryError;
  const result = { installation, fixture: null, live: [], cleanup: {} };
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: browserName,
      headless,
      locale: 'en-US',
      viewport: { width: 1280, height: 720 },
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging'],
    });
    result.browserVersion = context.browser().version();
    cdp = await context.browser().newBrowserCDPSession();
    browserProcessId = readOwnedBrowserProcessId(await cdp.send('SystemInfo.getProcessInfo'));
    browserProcessIdentity = await captureOwnedChromeProcess(browserProcessId, profile);
    result.cleanup.browserProcessIdentified = true;
    await enableDeveloperMode(context);
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
    for (const [index, url] of liveUrls.entries()) {
      result.live.push(await inspectLivePage(context, url, output, index, installation));
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
