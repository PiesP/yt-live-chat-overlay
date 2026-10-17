// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, Locator, Page } from '@playwright/test';

type UpgradeInput = {
  schemaVersion: number;
  baselineSha256: string;
  candidateVersion: string;
  publishedAssetUrl: string;
};

type UserscriptMetadata = {
  name: string;
  namespace: string;
  version: string;
  updateUrl: string;
  downloadUrl: string;
  grants: string[];
};

type Settings = Record<string, string>;
type PromptEvent = { kind: string; decision: string };
type PromptState = {
  status: string;
  deferred: boolean;
  approved: boolean;
  events: PromptEvent[];
};
type GrantRow = {
  index: number;
  visible: boolean;
  inSourceEditor: boolean;
  text: string;
  className?: string;
};
type GrantDisplay = {
  status: string;
  rowIndex?: number;
  visibleText?: string;
  reason?: string;
};
type UpgradeObservation = {
  status: string;
  baselineSha256: string;
  candidateSha256: string;
  baselineVersion: string;
  candidateVersion: string;
  publishedAssetUrl: string;
  scriptName: string;
  namespace: string;
  candidateUnsafeWindowGrant: boolean;
  prompt: PromptState;
  permissionDisplay: {
    status: string;
    attempts: (GrantDisplay & {
      scanScope: string;
      scanOverflow: number;
      rowScrolled: boolean | null;
      screenshot: string | null;
    })[];
  };
  stages: { kind: string; prompt: string; actionLabel?: string }[];
  installedRowDiagnostics?: object[];
  confirmationDiagnostics?: object[];
  before?: object;
  afterDeferral?: object;
  after?: object;
  settingsOriginal?: Settings;
  settingsBefore?: Settings;
  settingsAfterDeferral?: Settings;
  settingsAfter?: Settings;
  settingsRestoredForFixture?: Settings;
  activeStage?: string;
  cleanupErrors?: string[];
};

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

const DIRECTORY = 'validation/windows/release-upgrade';
const INPUT_FILE = `${DIRECTORY}/input.json`;
const BASELINE_FILE = `${DIRECTORY}/public-v0.45.6.user.js`;
const CANDIDATE_FILE = 'dist/yt-live-chat-overlay.user.js';
const SCRIPT_NAME = 'YouTube Live Chat Overlay';
const SCRIPT_NAMESPACE = 'https://github.com/PiesP';
const BASELINE_VERSION = '0.45.6';
const PUBLIC_ASSET_URL =
  'https://github.com/PiesP/yt-live-chat-overlay/releases/download/v0.45.6/yt-live-chat-overlay.user.js';
const UPDATE_URL =
  'https://github.com/PiesP/yt-live-chat-overlay/releases/latest/download/yt-live-chat-overlay.meta.js';
const CANDIDATE_DOWNLOAD_URL =
  'https://github.com/PiesP/yt-live-chat-overlay/releases/latest/download/yt-live-chat-overlay.user.js';
const MAX_SCRIPT_BYTES = 16 * 1024 * 1024;

export function sha256(bytes: Buffer | Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function validateUpgradeInput(value: unknown): UpgradeInput {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid upgrade input');
  const input = value as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(input).sort(),
    ['baselineSha256', 'candidateVersion', 'publishedAssetUrl', 'schemaVersion'],
    'Unknown or missing upgrade input fields'
  );
  assert.equal(input.schemaVersion, 1, 'Unsupported upgrade input schema');
  assert(typeof input.baselineSha256 === 'string');
  assert.match(input.baselineSha256, /^[a-f0-9]{64}$/u, 'Invalid public baseline SHA-256');
  assert.equal(input.candidateVersion, '0.45.7', 'Unexpected candidate version');
  assert.equal(input.publishedAssetUrl, PUBLIC_ASSET_URL, 'Unexpected public asset URL');
  return input as UpgradeInput;
}

export function readUserscriptMetadata(source: string): UserscriptMetadata {
  const header = /^\/\/ ==UserScript==\r?\n([\s\S]*?)^\/\/ ==\/UserScript==/mu.exec(source);
  assert(header, 'Userscript metadata header is missing');
  const fields = new Map<string, string[]>();
  for (const line of header[1]?.split(/\r?\n/u) ?? []) {
    const entry = /^\/\/\s+@([A-Za-z-]+)\s+(.+)$/u.exec(line);
    if (!entry) continue;
    const key = entry[1];
    const value = entry[2];
    if (!key || !value) continue;
    const values = fields.get(key) ?? [];
    values.push(value.trim());
    fields.set(key, values);
  }
  const exactlyOne = (key: string) => {
    const values = fields.get(key) ?? [];
    assert.equal(values.length, 1, `Userscript metadata requires one @${key}`);
    return values[0] ?? '';
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

export function requireUpgradeMetadata(
  baseline: UserscriptMetadata,
  candidate: UserscriptMetadata,
  candidateVersion: string
) {
  const scripts: [string, UserscriptMetadata, string][] = [
    ['baseline', baseline, BASELINE_VERSION],
    ['candidate', candidate, candidateVersion],
  ];
  for (const [label, metadata, version] of scripts) {
    assert.equal(metadata.name, SCRIPT_NAME, `${label} script name changed`);
    assert.equal(metadata.namespace, SCRIPT_NAMESPACE, `${label} script namespace changed`);
    assert.equal(metadata.version, version, `${label} script version changed`);
    assert.equal(metadata.updateUrl, UPDATE_URL, `${label} update URL changed`);
  }
  assert.equal(baseline.downloadUrl, PUBLIC_ASSET_URL, 'baseline download URL changed');
  assert.equal(candidate.downloadUrl, CANDIDATE_DOWNLOAD_URL, 'candidate download URL changed');
  assert(candidate.grants.includes('unsafeWindow'), 'Candidate lacks unsafeWindow grant');
  assert.equal(
    new Set(candidate.grants).size,
    candidate.grants.length,
    'Duplicate candidate grant'
  );
}

async function readBoundedFile(root: string, relativePath: string) {
  const file = join(root, relativePath);
  const flags =
    process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(file, flags);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ELOOP')
      assert.fail(`Invalid upgrade file: ${relativePath}`);
    if (isNodeError(error) && error.code === 'ENOENT') {
      try {
        // A dangling symlink is an invalid supplied file, not absent input.
        await lstat(file);
      } catch (inspectionError) {
        if (isNodeError(inspectionError) && inspectionError.code === 'ENOENT') throw error;
        throw inspectionError;
      }
      assert.fail(`Invalid upgrade file: ${relativePath}`);
    }
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    assert(opened.isFile(), `Invalid upgrade file: ${relativePath}`);
    assert(
      opened.size > 0n && opened.size <= BigInt(MAX_SCRIPT_BYTES),
      `Upgrade file size rejected: ${relativePath}`
    );
    let entry;
    try {
      entry = await lstat(file, { bigint: true });
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT')
        assert.fail(`Upgrade file changed since inspection: ${relativePath}`);
      throw error;
    }
    assert(
      entry.isFile() &&
        !entry.isSymbolicLink() &&
        opened.dev === entry.dev &&
        opened.ino === entry.ino &&
        opened.mtimeNs === entry.mtimeNs &&
        opened.size === entry.size,
      `Upgrade file changed since inspection: ${relativePath}`
    );
    const expectedBytes = Number(entry.size);
    const bounded = Buffer.alloc(expectedBytes + 1);
    let offset = 0;
    while (offset < bounded.length) {
      const { bytesRead } = await handle.read(bounded, offset, bounded.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    assert.equal(offset, expectedBytes, `Upgrade file changed size while reading: ${relativePath}`);
    const after = await handle.stat({ bigint: true });
    assert(
      after.isFile() &&
        after.dev === opened.dev &&
        after.ino === opened.ino &&
        after.mtimeNs === opened.mtimeNs &&
        after.size === opened.size,
      `Upgrade file changed while reading: ${relativePath}`
    );
    return bounded.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/** No input means the existing fresh installation path. A supplied input is all-or-nothing. */
export async function loadUpgradeInputs(root: string) {
  let inputBytes;
  try {
    inputBytes = await readBoundedFile(root, INPUT_FILE);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
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

export function requireInstalledScriptRow(rows: string[], version: string) {
  assert.equal(rows.length, 1, 'Manager must show one installation for the script identity');
  const words = rows[0]?.replace(/\s+/gu, ' ').trim() ?? '';
  assert(
    words.split(/\s+/u).includes(version),
    `Manager did not show installed version ${version}`
  );
  return { scriptName: SCRIPT_NAME, version, rowText: words.slice(0, 200) };
}

// Tampermonkey's dashboard renders each installed script as tr.scripttr.
// Its separate action-menu renderer also uses tr.script, so that is not a list entry.
export const INSTALLED_SCRIPT_ROW_SELECTOR = 'tr.scripttr';

export function requireRetainedSettings(before: Settings, after: Settings) {
  const numericValues = (values: Settings) => {
    assert.deepEqual(Object.keys(values).sort(), ['fontSize', 'opacity', 'safeTop']);
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => {
        const numeric = Number(value);
        assert(Number.isFinite(numeric), `Invalid numeric setting ${key}`);
        return [key, numeric];
      })
    );
  };
  const expected = numericValues(before);
  assert.deepEqual(expected, { fontSize: 36, opacity: 65, safeTop: 20 });
  assert.deepEqual(numericValues(after), expected, 'Preferences changed on upgrade');
  return after;
}

export function appendPromptEvent(prompt: PromptState, event: PromptEvent): PromptState {
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

export function classifyManagerGrantRows(rows: GrantRow[]): GrantDisplay {
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

async function observeManagerGrantDisplay(page: Page, output: string, attempt: number) {
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
        text: ((element as HTMLElement).innerText ?? '').trim().slice(0, 351),
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
    assert(typeof evidence.rowIndex === 'number');
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

async function installedRow(
  page: Page,
  labels: { installedUserscripts: string },
  version: string,
  observation: UpgradeObservation,
  output: string,
  stage: string
) {
  await page.getByText(labels.installedUserscripts, { exact: true }).first().click();
  const scriptName = page.locator('span.nameNname16:visible').filter({
    hasText: /^YouTube Live Chat Overlay$/u,
  });
  await scriptName
    .first()
    .waitFor({
      state: 'visible',
      timeout: 10_000,
    })
    .catch(() => {});
  const row = page.locator(`${INSTALLED_SCRIPT_ROW_SELECTOR}:visible`).filter({
    has: scriptName,
  });
  const count = await row.count();
  if (count !== 1) {
    const candidates = page.locator('tr:visible').filter({
      has: scriptName,
    });
    const totalCandidates = await candidates.count();
    const rows = await candidates.evaluateAll((elements) =>
      elements.slice(0, 12).map((element) => ({
        className: typeof element.className === 'string' ? element.className.slice(0, 120) : '',
        installedEntryDescendants: element.querySelectorAll('tr.scripttr').length,
        text: ((element as HTMLElement).innerText ?? '').replace(/\s+/gu, ' ').trim().slice(0, 240),
      }))
    );
    const screenshot = `userscript-installed-rows-${stage}.png`;
    const captured = await page
      .screenshot({ path: join(output, screenshot), timeout: 10_000 })
      .then(
        () => true,
        () => false
      );
    observation.installedRowDiagnostics ??= [];
    observation.installedRowDiagnostics.push({
      stage,
      selector: `${INSTALLED_SCRIPT_ROW_SELECTOR}:visible`,
      count,
      totalCandidateRows: totalCandidates,
      candidateRows: rows,
      screenshot: captured ? screenshot : null,
    });
  }
  const rows = count === 1 ? [await row.innerText()] : Array.from({ length: count }, () => '');
  requireInstalledScriptRow(rows, version);
  return row;
}

async function readInstalledEditorSource(page: Page, row: Locator) {
  await row
    .locator('span.nameNname16')
    .filter({ hasText: /^YouTube Live Chat Overlay$/u })
    .click();
  const editor = page.locator('.CodeMirror:visible').first();
  await editor.waitFor({ state: 'visible' });
  const source = await editor.evaluate((element) =>
    (element as HTMLElement & { CodeMirror?: { getValue: () => string } }).CodeMirror?.getValue()
  );
  assert(typeof source === 'string' && source.length > 0, 'Manager editor source is unavailable');
  return source;
}

async function observeInstalledScript(
  page: Page,
  managerId: string,
  version: string,
  expectedSha256: string,
  observation: UpgradeObservation,
  output: string,
  stage: string
) {
  const optionsUrl = `chrome-extension://${managerId}/options.html`;
  await page.goto(optionsUrl);
  assert.equal(page.url(), optionsUrl, 'Manager options page navigated away');
  const labels = await page.evaluate(() => {
    const managerChrome = (
      globalThis as typeof globalThis & {
        chrome: { i18n: { getMessage: (key: string) => string } };
      }
    ).chrome;
    return { installedUserscripts: managerChrome.i18n.getMessage('Installed_userscripts') };
  });
  assert.equal(page.url(), optionsUrl, 'Manager options page navigated during label lookup');
  assert(typeof labels.installedUserscripts === 'string' && labels.installedUserscripts.length > 0);
  const row = await installedRow(page, labels, version, observation, output, stage);
  const rowObservation = requireInstalledScriptRow([await row.innerText()], version);
  const source = await readInstalledEditorSource(page, row);
  const editorSha256 = sha256(Buffer.from(source, 'utf8'));
  assert.equal(editorSha256, expectedSha256, 'Manager editor bytes differ from imported file');
  return { ...rowObservation, editorSha256 };
}

async function importThroughManager(
  page: Page,
  context: BrowserContext,
  managerId: string,
  filePath: string,
  expectedKind: 'install' | 'update',
  decision: 'approve' | 'defer' = 'approve',
  observation: UpgradeObservation | null = null,
  output: string | null = null
) {
  const optionsUrl = `chrome-extension://${managerId}/options.html`;
  await page.goto(optionsUrl);
  assert.equal(page.url(), optionsUrl, 'Manager options page navigated away');
  const labels = await page.evaluate(() => {
    const managerChrome = (
      globalThis as typeof globalThis & {
        chrome: { i18n: { getMessage: (key: string) => string } };
      }
    ).chrome;
    return {
      utilities: managerChrome.i18n.getMessage('Utilities'),
      install: managerChrome.i18n.getMessage('Install'),
      update: managerChrome.i18n.getMessage('Update'),
      updateHeading: managerChrome.i18n.getMessage('You_are_about_to_update_a_UserScript_'),
    };
  });
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
        assert(output, 'Upgrade output directory is required for observation');
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
    // ask.html navigates before its translated confirmation controls are rendered.
    await (expectedKind === 'update' ? updateAction.or(installAction) : installAction).waitFor({
      state: 'visible',
      timeout: 10_000,
    });
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
  } catch (error) {
    if (observation && output && !confirmation.isClosed()) {
      const screenshot = `manager-confirmation-${expectedKind}-${decision}-failure.png`;
      const captured = await confirmation.screenshot({ path: join(output, screenshot) }).then(
        () => true,
        () => false
      );
      const buttons = await confirmation
        .getByRole('button')
        .allTextContents()
        .then(
          (values) => values.slice(0, 12).map((value) => value.trim().slice(0, 128)),
          () => []
        );
      observation.confirmationDiagnostics ??= [];
      observation.confirmationDiagnostics.push({
        expectedKind,
        decision,
        buttons,
        screenshot: captured ? screenshot : null,
      });
    }
    throw error;
  } finally {
    if (!confirmation.isClosed()) await confirmation.close();
  }
}

async function openSettingsAndRead(page: Page, timeout = 15_000): Promise<Settings> {
  const button = page.locator('#yt-chat-overlay-settings-button');
  await button.waitFor({ state: 'visible', timeout });
  await page.locator('#movie_player').hover({ timeout });
  await button.click({ timeout });
  const modal = page.locator('#yt-chat-overlay-settings-backdrop');
  await modal.waitFor({ state: 'visible', timeout });
  const values = {
    fontSize: await modal.locator('input[name="fontSize"]').inputValue({ timeout }),
    opacity: await modal.locator('input[name="opacity"]').inputValue({ timeout }),
    safeTop: await modal.locator('input[name="safeTop"]').inputValue({ timeout }),
  };
  return values;
}

async function observeSettings(page: Page) {
  const values = await openSettingsAndRead(page);
  const modal = page.locator('#yt-chat-overlay-settings-backdrop');
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
  return values;
}

export function matchesStoredSettings(stored: Settings | null | undefined, values: Settings) {
  return Boolean(
    stored &&
    ['fontSize', 'opacity', 'safeTop'].every((key) => {
      const actual = stored[key];
      return (
        typeof actual === 'string' &&
        actual.trim() !== '' &&
        Number.isFinite(Number(actual)) &&
        Number(actual) === Number(values[key])
      );
    })
  );
}

async function waitForStoredSettings(
  page: Page,
  managerId: string,
  root: string,
  values: Settings
) {
  // A fresh userscript instance reads the manager's persisted settings into
  // its UI. Keep the original tab alive so its idle save can run; never close
  // the readback dialog through the UI because a stale copy would be saved.
  const readback = await openOwnedWatchFixture(page.context(), managerId, root);
  try {
    await page.bringToFront();
    const deadline = Date.now() + 10_000;
    let consecutiveReads = 0;
    let lastStored;
    while (Date.now() < deadline) {
      lastStored = await openSettingsAndRead(readback, Math.max(1, deadline - Date.now()));
      consecutiveReads = matchesStoredSettings(lastStored, values) ? consecutiveReads + 1 : 0;
      if (consecutiveReads === 2) return;
      await readback.reload({
        waitUntil: 'domcontentloaded',
        timeout: Math.max(1, deadline - Date.now()),
      });
    }
    assert.fail(`Settings did not reach manager storage: ${JSON.stringify(lastStored)}`);
  } finally {
    await readback.close();
  }
}

async function setSettingsThroughUi(page: Page, values: Settings, managerId: string, root: string) {
  await page.locator('#yt-chat-overlay-settings-button').waitFor({ state: 'visible' });
  await page.locator('#movie_player').hover();
  await page.locator('#yt-chat-overlay-settings-button').click();
  const modal = page.locator('#yt-chat-overlay-settings-backdrop');
  await modal.waitFor({ state: 'visible' });
  for (const [name, value] of Object.entries(values)) {
    const control = modal.locator(`input[name="${name}"]`);
    if (!(await control.isVisible())) {
      const disclosure = modal.locator('details').filter({
        has: page.locator(`input[name="${name}"]`),
      });
      assert.equal(await disclosure.count(), 1, 'Hidden setting has no unique disclosure');
      await disclosure.locator(':scope > summary').click();
    }
    await control.fill(value);
    await control.blur();
  }
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
  await waitForStoredSettings(page, managerId, root, values);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const observed = await observeSettings(page);
  for (const [name, value] of Object.entries(values)) {
    assert(Number.isFinite(Number(observed[name])) && Number.isFinite(Number(value)));
    assert.equal(Number(observed[name]), Number(value), `Settings UI did not persist ${name}`);
  }
  return observed;
}

async function openOwnedWatchFixture(context: BrowserContext, managerId: string, root: string) {
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
export async function runManagerUpgrade(
  context: BrowserContext,
  managerId: string,
  root: string,
  inputs: NonNullable<Awaited<ReturnType<typeof loadUpgradeInputs>>>,
  output: string
) {
  const manager = await context.newPage();
  let fixture: Page | undefined;
  const result: UpgradeObservation = {
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
  let primaryError: unknown;
  let cleanupErrors: unknown[] = [];
  try {
    result.stages.push(
      await importThroughManager(
        manager,
        context,
        managerId,
        inputs.baselinePath,
        'install',
        'approve',
        result,
        output
      )
    );
    result.before = await observeInstalledScript(
      manager,
      managerId,
      inputs.baseline.version,
      inputs.baselineSha256,
      result,
      output,
      'before'
    );
    fixture = await openOwnedWatchFixture(context, managerId, root);
    result.settingsOriginal = await observeSettings(fixture);
    result.settingsBefore = await setSettingsThroughUi(
      fixture,
      {
        fontSize: '36',
        opacity: '65',
        safeTop: '20',
      },
      managerId,
      root
    );
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
      inputs.baselineSha256,
      result,
      output,
      'after-deferral'
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
      inputs.candidateSha256,
      result,
      output,
      'after-update'
    );
    await fixture.reload({ waitUntil: 'domcontentloaded' });
    result.settingsAfter = await observeSettings(fixture);
    requireRetainedSettings(result.settingsBefore, result.settingsAfter);
    result.settingsRestoredForFixture = await setSettingsThroughUi(
      fixture,
      result.settingsOriginal,
      managerId,
      root
    );
    result.activeStage = 'complete';
    result.status = 'passed';
  } catch (error) {
    primaryError = error;
    if (error && typeof error === 'object') Object.assign(error, { upgradeObservation: result });
  } finally {
    const cleanup = await Promise.allSettled([fixture?.close(), manager.close()]);
    cleanupErrors = cleanup.filter((item) => item.status === 'rejected').map((item) => item.reason);
    if (cleanupErrors.length)
      result.cleanupErrors = cleanupErrors.map((error) =>
        error instanceof Error ? error.name : 'Error'
      );
  }
  if (cleanupErrors.length) {
    const combined = new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      primaryError ? 'Upgrade and UI cleanup failed' : 'Upgrade UI cleanup failed'
    );
    Object.assign(combined, { upgradeObservation: result });
    throw combined;
  }
  if (primaryError) throw primaryError;
  return result;
}
