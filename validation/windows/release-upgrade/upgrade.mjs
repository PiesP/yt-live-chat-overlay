// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const DIRECTORY = 'validation/windows/release-upgrade';
const INPUT_FILE = `${DIRECTORY}/input.json`;
const BASELINE_FILE = `${DIRECTORY}/public-v0.45.5.user.js`;
const CANDIDATE_FILE = 'dist/yt-live-chat-overlay.user.js';
const SCRIPT_NAME = 'YouTube Live Chat Overlay';
const SCRIPT_NAMESPACE = 'https://github.com/PiesP';
const BASELINE_VERSION = '0.45.5';
const PUBLIC_ASSET_URL =
  'https://github.com/PiesP/yt-live-chat-overlay/releases/download/v0.45.5/yt-live-chat-overlay.user.js';
const UPDATE_URL =
  'https://github.com/PiesP/yt-live-chat-overlay/releases/latest/download/yt-live-chat-overlay.meta.js';
const MAX_SCRIPT_BYTES = 16 * 1024 * 1024;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function validateUpgradeInput(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid upgrade input');
  assert.deepEqual(
    Object.keys(value).sort(),
    ['baselineSha256', 'candidateVersion', 'publishedAssetUrl', 'schemaVersion'],
    'Unknown or missing upgrade input fields'
  );
  assert.equal(value.schemaVersion, 1, 'Unsupported upgrade input schema');
  assert.match(value.baselineSha256, /^[a-f0-9]{64}$/u, 'Invalid public baseline SHA-256');
  assert.equal(value.candidateVersion, '0.45.6', 'Unexpected candidate version');
  assert.equal(value.publishedAssetUrl, PUBLIC_ASSET_URL, 'Unexpected public asset URL');
  return value;
}

export function readUserscriptMetadata(source) {
  const header = /^\/\/ ==UserScript==\r?\n([\s\S]*?)^\/\/ ==\/UserScript==/mu.exec(source);
  assert(header, 'Userscript metadata header is missing');
  const fields = new Map();
  for (const line of header[1].split(/\r?\n/u)) {
    const entry = /^\/\/\s+@([A-Za-z-]+)\s+(.+)$/u.exec(line);
    if (!entry) continue;
    const values = fields.get(entry[1]) ?? [];
    values.push(entry[2].trim());
    fields.set(entry[1], values);
  }
  const exactlyOne = (key) => {
    const values = fields.get(key) ?? [];
    assert.equal(values.length, 1, `Userscript metadata requires one @${key}`);
    return values[0];
  };
  return {
    name: exactlyOne('name'),
    namespace: exactlyOne('namespace'),
    version: exactlyOne('version'),
    updateUrl: exactlyOne('updateURL'),
    downloadUrl: exactlyOne('downloadURL'),
    grants: fields.get('grant') ?? [],
  };
}

export function requireUpgradeMetadata(baseline, candidate, candidateVersion) {
  for (const [label, metadata, version] of [
    ['baseline', baseline, BASELINE_VERSION],
    ['candidate', candidate, candidateVersion],
  ]) {
    assert.equal(metadata.name, SCRIPT_NAME, `${label} script name changed`);
    assert.equal(metadata.namespace, SCRIPT_NAMESPACE, `${label} script namespace changed`);
    assert.equal(metadata.version, version, `${label} script version changed`);
    assert.equal(metadata.updateUrl, UPDATE_URL, `${label} update URL changed`);
    assert.equal(
      metadata.downloadUrl,
      `https://github.com/PiesP/yt-live-chat-overlay/releases/download/v${version}/yt-live-chat-overlay.user.js`,
      `${label} download URL changed`
    );
  }
  assert(candidate.grants.includes('unsafeWindow'), 'Candidate lacks unsafeWindow grant');
  assert.equal(
    new Set(candidate.grants).size,
    candidate.grants.length,
    'Duplicate candidate grant'
  );
}

async function readBoundedFile(root, relativePath) {
  const file = join(root, relativePath);
  const entry = await lstat(file);
  assert(entry.isFile() && !entry.isSymbolicLink(), `Invalid upgrade file: ${relativePath}`);
  assert(
    entry.size > 0 && entry.size <= MAX_SCRIPT_BYTES,
    `Upgrade file size rejected: ${relativePath}`
  );
  return readFile(file);
}

/** No input means the existing fresh installation path. A supplied input is all-or-nothing. */
export async function loadUpgradeInputs(root) {
  let inputBytes;
  try {
    inputBytes = await readBoundedFile(root, INPUT_FILE);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const input = validateUpgradeInput(JSON.parse(inputBytes.toString('utf8')));
  const [baselineBytes, candidateBytes] = await Promise.all([
    readBoundedFile(root, BASELINE_FILE),
    readBoundedFile(root, CANDIDATE_FILE),
  ]);
  const baselineSha256 = sha256(baselineBytes);
  const candidateSha256 = sha256(candidateBytes);
  assert.equal(baselineSha256, input.baselineSha256, 'Public baseline SHA-256 differs');
  assert.notEqual(candidateSha256, baselineSha256, 'Candidate and baseline bytes are identical');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const baseline = readUserscriptMetadata(decoder.decode(baselineBytes));
  const candidate = readUserscriptMetadata(decoder.decode(candidateBytes));
  requireUpgradeMetadata(baseline, candidate, input.candidateVersion);
  return {
    baselinePath: join(root, BASELINE_FILE),
    candidatePath: join(root, CANDIDATE_FILE),
    baselineSha256,
    candidateSha256,
    baseline,
    candidate,
    publishedAssetUrl: input.publishedAssetUrl,
  };
}

export function requireInstalledScriptRow(rows, version) {
  assert.equal(rows.length, 1, 'Manager must show one installation for the script identity');
  const words = rows[0].replace(/\s+/gu, ' ').trim();
  const versionPattern = new RegExp(`(?:^|\\s)${version.replace(/\./gu, '\\.')}(?=\\s|$)`, 'u');
  assert(versionPattern.test(words), `Manager did not show installed version ${version}`);
  return { scriptName: SCRIPT_NAME, version, rowText: words.slice(0, 200) };
}

export function requireRetainedSettings(before, after) {
  assert.deepEqual(before, { fontSize: '36', opacity: '65', safeTop: '20' });
  assert.deepEqual(after, before, 'Preferences changed on upgrade');
  return after;
}

export function appendPromptEvent(prompt, event) {
  assert(['observed', 'deferred', 'approved'].includes(event.kind), 'Unknown manager prompt event');
  assert(['defer', 'approve'].includes(event.decision), 'Unknown manager prompt decision');
  if (event.kind !== 'observed')
    assert.equal(prompt.status, 'observed', 'Manager decision requires an observed prompt');
  const events = [...(prompt.events ?? []), event];
  return {
    status: 'observed',
    deferred: events.some((item) => item.kind === 'deferred'),
    approved: events.some((item) => item.kind === 'approved'),
    events,
  };
}

export function classifyManagerGrantRows(rows) {
  const found = rows.find(
    (row) =>
      row.visible === true &&
      row.inSourceEditor === false &&
      typeof row.text === 'string' &&
      row.text.length <= 350 &&
      /unsafeWindow/u.test(row.text) &&
      !/^\s*(?:\/\/|\/\*)/u.test(row.text) &&
      (/(?:@grant|grant|permission|권한|権限|許可)/iu.test(row.text) ||
        /grant|permission/iu.test(row.className ?? ''))
  );
  return found
    ? { status: 'observed', rowIndex: found.index, visibleText: found.text.slice(0, 250) }
    : { status: 'not-observed', reason: 'no-visible-permission-specific-unsafeWindow-row' };
}

async function observeManagerGrantDisplay(page, output, attempt) {
  const selector = 'tr,[role="row"],li,dl,[class*="grant"],[class*="permission"]';
  const scan = await page.evaluate((query) => {
    const elements = Array.from(document.querySelectorAll(query));
    const rows = elements.slice(0, 512).map((element, index) => {
      const style = getComputedStyle(element);
      return {
        index,
        visible:
          element.getClientRects().length > 0 &&
          style.display !== 'none' &&
          style.visibility === 'visible',
        inSourceEditor: Boolean(element.closest('.CodeMirror,pre,code,textarea')),
        text: (element.innerText ?? '').trim().slice(0, 351),
        className: typeof element.className === 'string' ? element.className.slice(0, 100) : '',
      };
    });
    return { rows, scanOverflow: Math.max(0, elements.length - rows.length) };
  }, selector);
  const evidence = classifyManagerGrantRows(scan.rows);
  if (evidence.status === 'not-observed' && scan.scanOverflow > 0)
    evidence.reason = 'bounded-permission-row-scan-overflow';
  let rowScrolled = null;
  if (evidence.status === 'observed') {
    rowScrolled = await page
      .locator(selector)
      .nth(evidence.rowIndex)
      .scrollIntoViewIfNeeded()
      .then(
        () => true,
        () => false
      );
  }
  const screenshot = `userscript-update-confirmation-${attempt}.png`;
  const captured = await page.screenshot({ path: join(output, screenshot), timeout: 10_000 }).then(
    () => true,
    () => false
  );
  return {
    ...evidence,
    scanScope: 'visible manager confirmation summary rows and grant or permission sections',
    scanOverflow: scan.scanOverflow,
    rowScrolled,
    screenshot: captured ? screenshot : null,
  };
}

async function installedRow(page, labels, version) {
  await page.getByText(labels.installedUserscripts, { exact: true }).first().click();
  const row = page.locator('tr:visible').filter({
    has: page.getByText(SCRIPT_NAME, { exact: true }),
  });
  await row.first().waitFor({ state: 'visible' });
  const count = await row.count();
  const rows = count === 1 ? [await row.innerText()] : Array.from({ length: count }, () => '');
  requireInstalledScriptRow(rows, version);
  return row;
}

async function readInstalledEditorSource(page, row) {
  await row.getByText(SCRIPT_NAME, { exact: true }).click();
  const editor = page.locator('.CodeMirror:visible').first();
  await editor.waitFor({ state: 'visible' });
  const source = await editor.evaluate((element) => element.CodeMirror?.getValue());
  assert(typeof source === 'string' && source.length > 0, 'Manager editor source is unavailable');
  return source;
}

async function observeInstalledScript(page, managerId, version, expectedSha256) {
  const optionsUrl = `chrome-extension://${managerId}/options.html`;
  await page.goto(optionsUrl);
  assert.equal(page.url(), optionsUrl, 'Manager options page navigated away');
  const labels = await page.evaluate(() => ({
    installedUserscripts: chrome.i18n.getMessage('Installed_userscripts'),
  }));
  assert.equal(page.url(), optionsUrl, 'Manager options page navigated during label lookup');
  assert(typeof labels.installedUserscripts === 'string' && labels.installedUserscripts.length > 0);
  const row = await installedRow(page, labels, version);
  const rowObservation = requireInstalledScriptRow([await row.innerText()], version);
  const source = await readInstalledEditorSource(page, row);
  const editorSha256 = sha256(Buffer.from(source, 'utf8'));
  assert.equal(editorSha256, expectedSha256, 'Manager editor bytes differ from imported file');
  return { ...rowObservation, editorSha256 };
}

async function importThroughManager(
  page,
  context,
  managerId,
  filePath,
  expectedKind,
  decision = 'approve',
  observation = null,
  output = null
) {
  const optionsUrl = `chrome-extension://${managerId}/options.html`;
  await page.goto(optionsUrl);
  assert.equal(page.url(), optionsUrl, 'Manager options page navigated away');
  const labels = await page.evaluate(() => ({
    utilities: chrome.i18n.getMessage('Utilities'),
    install: chrome.i18n.getMessage('Install'),
    update: chrome.i18n.getMessage('Update'),
    updateHeading: chrome.i18n.getMessage('You_are_about_to_update_a_UserScript_'),
  }));
  assert.equal(page.url(), optionsUrl, 'Manager options page navigated during label lookup');
  assert(Object.values(labels).every((value) => typeof value === 'string' && value.length > 0));
  await page.getByText(labels.utilities, { exact: true }).click();
  const confirmationPromise = context.waitForEvent('page');
  await page.locator('input[type=file]').setInputFiles(filePath);
  const confirmation = await confirmationPromise;
  try {
    await confirmation.waitForURL(`chrome-extension://${managerId}/ask.html*`);
    if (expectedKind === 'update') {
      if ((await confirmation.title()) !== labels.updateHeading) {
        await confirmation
          .getByText(labels.updateHeading, { exact: true })
          .first()
          .waitFor({ state: 'visible', timeout: 10_000 });
      }
      if (observation) {
        observation.prompt = appendPromptEvent(observation.prompt, {
          kind: 'observed',
          decision,
        });
        const grant = await observeManagerGrantDisplay(
          confirmation,
          output,
          observation.permissionDisplay.attempts.length + 1
        );
        observation.permissionDisplay.attempts.push(grant);
        if (grant.status === 'observed') observation.permissionDisplay.status = 'observed';
        else if (observation.permissionDisplay.status !== 'observed')
          observation.permissionDisplay.status = 'not-observed';
      }
    }
    if (decision === 'defer') {
      assert.equal(expectedKind, 'update', 'Only an update can be deferred');
      await confirmation.close();
      if (observation)
        observation.prompt = appendPromptEvent(observation.prompt, { kind: 'deferred', decision });
      return { kind: 'update', prompt: 'deferred-by-closing-manager-confirmation' };
    }
    const updateAction = confirmation.getByRole('button', { name: labels.update, exact: true });
    const installAction = confirmation.getByRole('button', { name: labels.install, exact: true });
    const updateVisible = expectedKind === 'update' && (await updateAction.isVisible());
    const installVisible = await installAction.isVisible();
    assert(
      updateVisible !== installVisible,
      'Manager confirmation has no unambiguous install or update action'
    );
    const action = updateVisible ? updateAction : installAction;
    await action.waitFor({ state: 'visible' });
    const closed = confirmation.waitForEvent('close');
    await action.click();
    await closed;
    if (expectedKind === 'update' && observation)
      observation.prompt = appendPromptEvent(observation.prompt, { kind: 'approved', decision });
    return {
      kind: expectedKind,
      prompt: 'approved-through-manager-ui',
      actionLabel: updateVisible ? labels.update : labels.install,
    };
  } finally {
    if (!confirmation.isClosed()) await confirmation.close();
  }
}

async function observeSettings(page) {
  const button = page.locator('#yt-chat-overlay-settings-button');
  await button.waitFor({ state: 'visible', timeout: 15_000 });
  await button.click();
  const modal = page.locator('#yt-chat-overlay-settings-backdrop');
  await modal.waitFor({ state: 'visible' });
  const values = {
    fontSize: await modal.locator('input[name="fontSize"]').inputValue(),
    opacity: await modal.locator('input[name="opacity"]').inputValue(),
    safeTop: await modal.locator('input[name="safeTop"]').inputValue(),
  };
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
  return values;
}

async function setSettingsThroughUi(page, values) {
  await page.locator('#yt-chat-overlay-settings-button').waitFor({ state: 'visible' });
  await page.locator('#yt-chat-overlay-settings-button').click();
  const modal = page.locator('#yt-chat-overlay-settings-backdrop');
  await modal.waitFor({ state: 'visible' });
  for (const [name, value] of Object.entries(values)) {
    const control = modal.locator(`input[name="${name}"]`);
    await control.fill(value);
    await control.blur();
  }
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const observed = await observeSettings(page);
  assert.deepEqual(observed, values, 'Settings UI did not persist the requested values');
  return observed;
}

async function openOwnedWatchFixture(context, managerId, root) {
  const preview = await readFile(join(root, 'test/visual/preview.html'), 'utf8');
  const withVideo = preview.replace(
    '<div class="player-inner">Video Player Placeholder</div>',
    '<video aria-label="Upgrade fixture video" style="width:100%;height:100%"></video>'
  );
  assert.notEqual(withVideo, preview, 'Upgrade fixture video placeholder changed');
  const html = withVideo.replace(
    '</body>',
    '<div id="chat"><yt-live-chat-item-list-renderer><div id="items"></div></yt-live-chat-item-list-renderer></div></body>'
  );
  assert.notEqual(html, withVideo, 'Upgrade fixture body changed');
  const page = await context.newPage();
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:' && url.hostname === managerId) {
      await route.continue();
    } else if (
      url.hostname === 'www.youtube.com' &&
      route.request().resourceType() === 'document'
    ) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
    } else if (url.hostname === 'www.youtube.com' && url.pathname.includes('/live_chat/')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          continuationContents: {
            liveChatContinuation: {
              actions: [],
              continuations: [
                {
                  timedContinuationData: {
                    continuation: 'windows-upgrade-next',
                    timeoutMs: 30_000,
                  },
                },
              ],
            },
          },
        },
      });
    } else {
      await route.fulfill({ status: 403, contentType: 'text/plain', body: 'Blocked by fixture' });
    }
  });
  await page.addInitScript(() => {
    window.ytcfg = {
      data_: {
        INNERTUBE_API_KEY: 'windows-upgrade-key',
        INNERTUBE_CONTEXT_CLIENT_NAME: '1',
        INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
        INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
      },
    };
    window.ytInitialData = {
      currentVideoEndpoint: { watchEndpoint: { videoId: 'windowsUpgrade' } },
      contents: {
        twoColumnWatchNextResults: {
          conversationBar: {
            liveChatRenderer: {
              isReplay: false,
              continuations: [
                {
                  timedContinuationData: {
                    continuation: 'windows-upgrade-live',
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
  try {
    await page.goto('https://www.youtube.com/watch?v=windowsUpgrade', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}

/** Perform a real UI import and update in one manager installation and browser profile. */
export async function runManagerUpgrade(context, managerId, root, inputs, output) {
  const manager = await context.newPage();
  let fixture;
  const result = {
    status: 'incomplete',
    baselineSha256: inputs.baselineSha256,
    candidateSha256: inputs.candidateSha256,
    baselineVersion: inputs.baseline.version,
    candidateVersion: inputs.candidate.version,
    publishedAssetUrl: inputs.publishedAssetUrl,
    scriptName: SCRIPT_NAME,
    namespace: SCRIPT_NAMESPACE,
    candidateUnsafeWindowGrant: inputs.candidate.grants.includes('unsafeWindow'),
    prompt: { status: 'unobserved', deferred: false, approved: false, events: [] },
    permissionDisplay: { status: 'not-run', attempts: [] },
    stages: [],
  };
  let primaryError;
  let cleanupErrors = [];
  try {
    result.stages.push(
      await importThroughManager(manager, context, managerId, inputs.baselinePath, 'install')
    );
    result.before = await observeInstalledScript(
      manager,
      managerId,
      inputs.baseline.version,
      inputs.baselineSha256
    );
    fixture = await openOwnedWatchFixture(context, managerId, root);
    result.settingsOriginal = await observeSettings(fixture);
    result.settingsBefore = await setSettingsThroughUi(fixture, {
      fontSize: '36',
      opacity: '65',
      safeTop: '20',
    });
    requireRetainedSettings(result.settingsBefore, result.settingsBefore);
    result.activeStage = 'defer-update';
    result.stages.push(
      await importThroughManager(
        manager,
        context,
        managerId,
        inputs.candidatePath,
        'update',
        'defer',
        result,
        output
      )
    );
    result.afterDeferral = await observeInstalledScript(
      manager,
      managerId,
      inputs.baseline.version,
      inputs.baselineSha256
    );
    await fixture.reload({ waitUntil: 'domcontentloaded' });
    result.settingsAfterDeferral = await observeSettings(fixture);
    requireRetainedSettings(result.settingsBefore, result.settingsAfterDeferral);
    result.activeStage = 'approve-update';
    result.stages.push(
      await importThroughManager(
        manager,
        context,
        managerId,
        inputs.candidatePath,
        'update',
        'approve',
        result,
        output
      )
    );
    result.after = await observeInstalledScript(
      manager,
      managerId,
      inputs.candidate.version,
      inputs.candidateSha256
    );
    await fixture.reload({ waitUntil: 'domcontentloaded' });
    result.settingsAfter = await observeSettings(fixture);
    requireRetainedSettings(result.settingsBefore, result.settingsAfter);
    result.settingsRestoredForFixture = await setSettingsThroughUi(
      fixture,
      result.settingsOriginal
    );
    result.activeStage = 'complete';
    result.status = 'passed';
  } catch (error) {
    primaryError = error;
    if (error && typeof error === 'object') error.upgradeObservation = result;
  } finally {
    const cleanup = await Promise.allSettled([fixture?.close(), manager.close()]);
    cleanupErrors = cleanup.filter((item) => item.status === 'rejected').map((item) => item.reason);
    if (cleanupErrors.length)
      result.cleanupErrors = cleanupErrors.map((error) => error?.name ?? 'Error');
  }
  if (cleanupErrors.length) {
    const combined = new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      primaryError ? 'Upgrade and UI cleanup failed' : 'Upgrade UI cleanup failed'
    );
    combined.upgradeObservation = result;
    throw combined;
  }
  if (primaryError) throw primaryError;
  return result;
}
