// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run as runFixture } from './profile.mjs';

const SCRIPT_NAME = 'YouTube Live Chat Overlay';

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
async function inspectLivePage(context, url, output, index) {
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.name));
  const observation = { url, status: 'not-run', mocked: false };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const rejectConsent = page.getByRole('button', { name: 'Reject all', exact: true });
    if (await rejectConsent.isVisible().catch(() => false)) await rejectConsent.click();
    await page.locator('#movie_player').waitFor({ state: 'visible', timeout: 20_000 });
    const settingsButton = page.locator('#yt-chat-overlay-settings-button');
    await settingsButton.waitFor({ state: 'visible', timeout: 20_000 });
    await settingsButton.click();
    const modal = page.locator('#yt-chat-overlay-settings-backdrop');
    await modal.waitFor({ state: 'visible' });
    const fontSize = modal.locator('input[name="fontSize"]');
    observation.fontSize = Number(await fontSize.inputValue());
    await page.keyboard.press('Escape');
    await page.waitForFunction(() =>
      document.querySelectorAll('.yt-live-chat-overlay-live-region > p').length > 0,
      undefined, { timeout: 30_000 });
    observation.renderedMessages = await page.locator('.yt-live-chat-overlay-live-region > p').count();
    observation.canvasAttached = await page.locator('#yt-live-chat-overlay canvas').count() === 1;
    observation.status = 'passed';
  } catch (error) {
    observation.status = 'unverified';
    observation.reason = error.name === 'TimeoutError' ? 'watch-page-or-chat-readiness-timeout' : 'navigation-or-render-error';
  } finally {
    observation.pageErrorTypes = [...new Set(pageErrors)];
    observation.screenshot = `live-${index}.png`;
    await page.screenshot({ path: join(output, observation.screenshot) }).catch(() => {});
    await page.close();
  }
  return observation;
}

/** Install real browser packages in an isolated profile and exercise their normal delivery. */
export async function runChromeInstallation({
  chromium, root, output, browserName = 'chrome', headless = false,
  installation, liveUrls = [],
}) {
  assert(['chrome', 'msedge'].includes(browserName), 'Unsupported Chromium channel');
  assert(['extension', 'userscript'].includes(installation), 'Unknown installation mode');
  const profile = await mkdtemp(join(root, 'chrome-install-'));
  let context;
  let cdp;
  let extensionId;
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
      result.live.push(await inspectLivePage(context, url, output, index));
    }
    return result;
  } finally {
    try {
      if (cdp && extensionId) {
        await cdp.send('Extensions.uninstall', { id: extensionId });
        result.cleanup.extensionUninstalled = true;
      }
    } finally {
      try {
        await context?.close();
        result.cleanup.browserClosed = true;
        await rm(profile, { recursive: true });
        result.cleanup.profileRemoved = await stat(profile).then(() => false, (error) => {
          if (error.code === 'ENOENT') return true;
          throw error;
        });
      } finally {
        await writeFile(join(output, 'installation-result.json'), JSON.stringify(result, null, 2));
      }
    }
  }
}
