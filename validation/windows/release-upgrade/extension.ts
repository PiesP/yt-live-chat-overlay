// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { cp, lstat, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import type { BrowserContext, CDPSession, Page } from '@playwright/test';

import { buildVisibleWatchHtml } from '../visible-watch.ts';

const INPUT = 'validation/windows/release-upgrade/extension-input.json';
const ARCHIVE = 'validation/windows/release-upgrade/public-v0.45.7-chrome/artifact.zip';
const BASELINE = 'validation/windows/release-upgrade/public-v0.45.7-chrome/unpacked';
const CANDIDATE = 'dist-extension';
const PUBLIC_URL =
  'https://github.com/PiesP/yt-live-chat-overlay/releases/download/v0.45.7/yt-live-chat-overlay-chrome.zip';
const STORAGE_KEY = 'yt-live-chat-overlay-settings';
const FIXTURE_URL = 'https://www.youtube.com/watch?v=windowsExtensionUpgrade';
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const FILES = [
  'background.js',
  'content-script.js',
  'icons/icon128.png',
  'icons/icon16.png',
  'icons/icon48.png',
  'manifest.json',
  'page-script.js',
  'workers/renderer.js',
] as const;
const DIRECTORIES = ['icons', 'workers'] as const;

type ExtensionInput = {
  schemaVersion: 1;
  previousVersion: '0.45.7';
  candidateVersion: '0.45.8';
  publicAssetUrl: typeof PUBLIC_URL;
  publicArchive: { path: typeof ARCHIVE; sha256: string };
  previousExtension: { path: typeof BASELINE; inventorySha256: string };
  candidateExtension: { inventorySha256: string };
};
type Inventory = { sha256: string; files: Record<string, string> };

function digest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid extension input');
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: string[]): void {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    'Unexpected extension input fields'
  );
}

function sha(value: unknown): asserts value is string {
  assert(typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value), 'Invalid SHA-256 input');
}

export function validateExtensionUpgradeInput(value: unknown): ExtensionInput {
  const input = object(value);
  keys(input, [
    'schemaVersion',
    'previousVersion',
    'candidateVersion',
    'publicAssetUrl',
    'publicArchive',
    'previousExtension',
    'candidateExtension',
  ]);
  assert.equal(input.schemaVersion, 1);
  assert.equal(input.previousVersion, '0.45.7');
  assert.equal(input.candidateVersion, '0.45.8');
  assert.equal(input.publicAssetUrl, PUBLIC_URL);
  const archive = object(input.publicArchive);
  keys(archive, ['path', 'sha256']);
  assert.equal(archive.path, ARCHIVE);
  sha(archive.sha256);
  const baseline = object(input.previousExtension);
  keys(baseline, ['path', 'inventorySha256']);
  assert.equal(baseline.path, BASELINE);
  sha(baseline.inventorySha256);
  const candidate = object(input.candidateExtension);
  keys(candidate, ['inventorySha256']);
  sha(candidate.inventorySha256);
  return input as ExtensionInput;
}

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.isFile() &&
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs
  );
}

async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const before = await lstat(path, { bigint: true });
  assert(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.size > 0n &&
      before.size <= BigInt(maximum),
    'Extension input must be a bounded regular file'
  );
  const flags =
    process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags);
  try {
    assert(
      sameFile(before, await handle.stat({ bigint: true })),
      'Extension file changed during inspection'
    );
    const bytes = await handle.readFile();
    assert(
      bytes.length === Number(before.size) &&
        sameFile(before, await handle.stat({ bigint: true })) &&
        sameFile(before, await lstat(path, { bigint: true })),
      'Extension file changed during read'
    );
    return bytes;
  } finally {
    await handle.close();
  }
}

async function ordinaryParents(root: string, relativePath: string): Promise<void> {
  const rootInfo = await lstat(root);
  assert(
    rootInfo.isDirectory() && !rootInfo.isSymbolicLink(),
    'Extension bundle root is not ordinary'
  );
  let parent = root;
  for (const component of relativePath.split('/').slice(0, -1)) {
    parent = join(parent, component);
    const info = await lstat(parent);
    assert(info.isDirectory() && !info.isSymbolicLink(), 'Extension input parent is not ordinary');
  }
}

/** Inspect exactly the Chrome artifact's eight regular files and two parent directories. */
export async function extensionInventory(root: string): Promise<Inventory> {
  const top = await lstat(root);
  assert(top.isDirectory() && !top.isSymbolicLink(), 'Extension root is not an ordinary directory');
  const topNames = await readdir(root);
  assert.deepEqual(
    topNames.sort(),
    [
      'background.js',
      'content-script.js',
      'icons',
      'manifest.json',
      'page-script.js',
      'workers',
    ].sort(),
    'Unexpected extension root layout'
  );
  for (const directory of DIRECTORIES) {
    const path = join(root, directory);
    const info = await lstat(path);
    assert(info.isDirectory() && !info.isSymbolicLink(), 'Extension parent is not ordinary');
    const names = FILES.filter((file) => file.startsWith(`${directory}/`)).map((file) =>
      file.slice(directory.length + 1)
    );
    assert.deepEqual(
      (await readdir(path)).sort(),
      names.sort(),
      'Unexpected extension child layout'
    );
  }
  const files: Record<string, string> = {};
  for (const name of FILES)
    files[name] = digest(await boundedFile(join(root, name), MAX_FILE_BYTES));
  const rows = FILES.map((name) => `${name} ${files[name]}\n`).join('');
  return { sha256: digest(rows), files };
}

/** Compare all ZIP members with the independently inspected unpacked bytes. */
export function verifyExtensionZip(bytes: Buffer, inventory: Inventory): void {
  assert(bytes.length > 22 && bytes.length <= MAX_ARCHIVE_BYTES, 'Extension ZIP size is invalid');
  let end = -1;
  const first = Math.max(0, bytes.length - 65_557);
  for (let cursor = bytes.length - 22; cursor >= first; cursor--) {
    if (
      bytes.readUInt32LE(cursor) === 0x06054b50 &&
      cursor + 22 + bytes.readUInt16LE(cursor + 20) === bytes.length
    ) {
      end = cursor;
      break;
    }
  }
  assert(end >= 0, 'Extension ZIP end record is missing');
  assert.equal(bytes.readUInt16LE(end + 4), 0, 'Multi-disk ZIP is unsupported');
  assert.equal(bytes.readUInt16LE(end + 6), 0, 'Multi-disk ZIP is unsupported');
  const count = bytes.readUInt16LE(end + 10);
  assert.equal(count, bytes.readUInt16LE(end + 8), 'ZIP entry count differs');
  assert.equal(count, FILES.length + DIRECTORIES.length, 'Unexpected ZIP entry count');
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  assert(
    directoryOffset + directorySize === end && directorySize <= 16_384,
    'Unexpected ZIP directory layout'
  );
  let cursor = directoryOffset;
  const seen = new Set<string>();
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < count; index++) {
    assert(
      cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50,
      'Invalid ZIP central entry'
    );
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const expanded = bytes.readUInt32LE(cursor + 24);
    const mode = (bytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000;
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    assert(
      (flags & ~0x808) === 0 &&
        (method === 0 || method === 8) &&
        compressed <= MAX_FILE_BYTES &&
        expanded <= MAX_FILE_BYTES &&
        nameLength > 0 &&
        nameLength <= 64 &&
        extraLength <= 1024 &&
        commentLength <= 1024 &&
        cursor + 46 + nameLength + extraLength + commentLength <= end,
      'Unsupported ZIP entry'
    );
    const rawNameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    assert(
      rawNameBytes.every((byte) => byte <= 0x7f),
      'ZIP filename is not ASCII'
    );
    const rawName = rawNameBytes.toString('ascii');
    const name = rawName.startsWith('./') ? rawName.slice(2) : rawName;
    assert(!seen.has(name), 'Duplicate ZIP entry');
    seen.add(name);
    const isFile = FILES.includes(name as (typeof FILES)[number]);
    assert(isFile || ['icons/', 'workers/'].includes(name), 'Unexpected ZIP path');
    assert(
      isFile ? mode === 0 || mode === 0x8000 : mode === 0 || mode === 0x4000,
      'ZIP member is not an ordinary file or directory'
    );
    assert(
      local + 30 <= directoryOffset && bytes.readUInt32LE(local) === 0x04034b50,
      'Invalid ZIP local entry'
    );
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtraLength;
    assert(
      start + compressed <= directoryOffset &&
        localNameLength === nameLength &&
        bytes.readUInt16LE(local + 6) === flags &&
        bytes.readUInt16LE(local + 8) === method &&
        bytes.subarray(local + 30, local + 30 + localNameLength).equals(rawNameBytes),
      'ZIP local and central names differ'
    );
    ranges.push({ start: local, end: start + compressed });
    if (isFile) {
      const compressedBytes = bytes.subarray(start, start + compressed);
      const content =
        method === 0
          ? compressedBytes
          : inflateRawSync(compressedBytes, { maxOutputLength: MAX_FILE_BYTES });
      assert(
        content.length === expanded && digest(content) === inventory.files[name],
        'Published ZIP and unpacked extension bytes differ'
      );
    } else {
      assert(compressed === 0 && expanded === 0, 'ZIP directory has data');
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, end, 'Trailing ZIP central metadata');
  assert.deepEqual(
    FILES.filter((name) => !seen.has(name)),
    [],
    'ZIP is missing extension files'
  );
  assert(
    DIRECTORIES.every((name) => seen.has(`${name}/`)),
    'ZIP is missing parent directories'
  );
  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index++) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    assert(previous && current && previous.end <= current.start, 'Overlapping ZIP entries');
  }
}

function manifestVersion(bytes: Buffer): string {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  const manifest = object(value);
  assert.equal(manifest.name, 'YouTube Live Chat Overlay');
  assert.equal(manifest.manifest_version, 3);
  assert(typeof manifest.version === 'string');
  return manifest.version;
}

export async function readExtensionUpgradeInput(root: string): Promise<{
  input: ExtensionInput;
  baseline: Inventory;
  candidate: Inventory;
} | null> {
  let raw: Buffer;
  try {
    await ordinaryParents(root, INPUT);
    raw = await boundedFile(join(root, INPUT), 4096);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
  const input = validateExtensionUpgradeInput(JSON.parse(raw.toString('utf8')));
  await ordinaryParents(root, ARCHIVE);
  await ordinaryParents(root, BASELINE);
  const archive = await boundedFile(join(root, ARCHIVE), MAX_ARCHIVE_BYTES);
  assert.equal(digest(archive), input.publicArchive.sha256, 'Public Chrome ZIP SHA-256 differs');
  const baseline = await extensionInventory(join(root, BASELINE));
  assert.equal(
    baseline.sha256,
    input.previousExtension.inventorySha256,
    'Public Chrome inventory differs'
  );
  verifyExtensionZip(archive, baseline);
  const candidate = await extensionInventory(join(root, CANDIDATE));
  assert.equal(
    candidate.sha256,
    input.candidateExtension.inventorySha256,
    'Candidate Chrome inventory differs'
  );
  assert.equal(
    manifestVersion(await boundedFile(join(root, BASELINE, 'manifest.json'), 64_000)),
    input.previousVersion
  );
  assert.equal(
    manifestVersion(await boundedFile(join(root, CANDIDATE, 'manifest.json'), 64_000)),
    input.candidateVersion
  );
  return { input, baseline, candidate };
}

type VerifiedInput = NonNullable<Awaited<ReturnType<typeof readExtensionUpgradeInput>>>;
type UpgradeReceipt = {
  status: 'failed' | 'passed';
  transition: 'public-0.45.7-to-candidate-0.45.8';
  method: 'same-path-unpacked-runtime-reload';
  publicAssetUrl: typeof PUBLIC_URL;
  publicArchiveSha256: string;
  previousInventorySha256: string;
  candidateInventorySha256: string;
  extensionId: string | null;
  installedPathSha256: string;
  activeStage: string;
  originalFontSize: number | null;
  selectedFontSize: number | null;
  baselineStorageFontSize: number | null;
  candidateStorageFontSize: number | null;
  candidateUiFontSize: number | null;
  restoredFontSize: number | null;
  errorType?: string;
};

async function extensionDetails(page: Page, id: string): Promise<{ id: string; version: string }> {
  await page.goto(`chrome-extension://${id}/manifest.json`, {
    waitUntil: 'domcontentloaded',
    timeout: 10_000,
  });
  return page.evaluate(() => {
    const runtime = (
      globalThis as typeof globalThis & {
        chrome?: { runtime?: { id?: string; getManifest?: () => { version?: string } } };
      }
    ).chrome?.runtime;
    if (!runtime?.id || !runtime.getManifest) throw new Error('Extension manifest unavailable');
    return { id: runtime.id, version: runtime.getManifest().version ?? '' };
  });
}

export async function readExtensionStoredFontSize(page: Page): Promise<number | null> {
  return page.evaluate(async (key) => {
    const storage = (
      globalThis as typeof globalThis & {
        chrome?: {
          storage?: {
            local?: {
              get: (key: string) => Promise<Record<string, unknown>>;
            };
          };
        };
      }
    ).chrome?.storage?.local;
    if (!storage) throw new Error('Extension storage unavailable');
    const value = (await storage.get(key))[key];
    if (typeof value !== 'string' || value.length === 0 || value.length > 65_536) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const fontSize = (parsed as Record<string, unknown>).fontSize;
    return typeof fontSize === 'number' && Number.isFinite(fontSize) ? fontSize : null;
  }, STORAGE_KEY);
}

async function waitForStoredFont(page: Page, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  do {
    if ((await readExtensionStoredFontSize(page)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail('Extension UI preference did not persist to chrome.storage.local');
}

async function openWatchFixture(context: BrowserContext, root: string, id: string): Promise<Page> {
  const preview = await readFile(join(root, 'test/visual/preview.html'), 'utf8');
  const html = buildVisibleWatchHtml(preview, 'Extension upgrade fixture video');
  const page = await context.newPage();
  try {
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'chrome-extension:' && url.hostname === id) {
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
                      continuation: 'extension-upgrade-next',
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
          INNERTUBE_API_KEY: 'extension-upgrade-key',
          INNERTUBE_CONTEXT_CLIENT_NAME: '1',
          INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
          INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
        },
      };
      window.ytInitialData = {
        currentVideoEndpoint: {
          watchEndpoint: { videoId: 'windowsExtensionUpgrade' },
        },
        contents: {
          twoColumnWatchNextResults: {
            conversationBar: {
              liveChatRenderer: {
                isReplay: false,
                continuations: [
                  {
                    timedContinuationData: {
                      continuation: 'extension-upgrade-live',
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
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page
      .locator('#yt-chat-overlay-settings-button')
      .waitFor({ state: 'visible', timeout: 20_000 });
    return page;
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}

async function settingsFontSize(page: Page): Promise<number> {
  await page.locator('#yt-chat-overlay-settings-button').focus();
  await page.keyboard.press('Enter');
  const modal = page.locator('#yt-chat-overlay-settings-backdrop');
  await modal.waitFor({ state: 'visible' });
  const value = Number(await modal.locator('input[name="fontSize"]').inputValue());
  assert(
    Number.isInteger(value) && value >= 14 && value <= 50,
    'Extension settings UI font size is invalid'
  );
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
  return value;
}

async function setFontSizeThroughUi(page: Page, value: number): Promise<void> {
  await page.locator('#yt-chat-overlay-settings-button').focus();
  await page.keyboard.press('Enter');
  const modal = page.locator('#yt-chat-overlay-settings-backdrop');
  await modal.waitFor({ state: 'visible' });
  const input = modal.locator('input[name="fontSize"]');
  await input.fill(String(value));
  await input.blur();
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
}

async function candidateDetails(context: BrowserContext, id: string): Promise<Page> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  do {
    const page = await context.newPage();
    try {
      const details = await extensionDetails(page, id);
      assert.equal(details.id, id, 'Updated extension ID changed');
      assert.equal(details.version, '0.45.8', 'Updated runtime manifest did not activate');
      return page;
    } catch (error) {
      lastError = error;
      await page.close().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } while (Date.now() < deadline);
  throw lastError ?? new Error('Candidate extension runtime unavailable');
}

/** Exercise the documented same-path manual unpacked update before candidate fixtures. */
export async function runExtensionUpgrade({
  context,
  cdp,
  root,
  profile,
  verified,
  onLoaded,
}: {
  context: BrowserContext;
  cdp: CDPSession;
  root: string;
  profile: string;
  verified: VerifiedInput;
  onLoaded: (id: string) => void;
}): Promise<{ extensionId: string; receipt: UpgradeReceipt }> {
  const installedPath = join(profile, 'task-owned-extension');
  const receipt: UpgradeReceipt = {
    status: 'failed',
    transition: 'public-0.45.7-to-candidate-0.45.8',
    method: 'same-path-unpacked-runtime-reload',
    publicAssetUrl: PUBLIC_URL,
    publicArchiveSha256: verified.input.publicArchive.sha256,
    previousInventorySha256: verified.baseline.sha256,
    candidateInventorySha256: verified.candidate.sha256,
    extensionId: null,
    installedPathSha256: digest(installedPath),
    activeStage: 'copy-public-baseline',
    originalFontSize: null,
    selectedFontSize: null,
    baselineStorageFontSize: null,
    candidateStorageFontSize: null,
    candidateUiFontSize: null,
    restoredFontSize: null,
  };
  let baselinePage: Page | null = null;
  let extensionPage: Page | null = null;
  let candidatePage: Page | null = null;
  let candidateExtensionPage: Page | null = null;
  try {
    await mkdir(profile, { recursive: true });
    await cp(join(root, BASELINE), installedPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    assert.equal((await extensionInventory(installedPath)).sha256, verified.baseline.sha256);
    receipt.activeStage = 'load-public-baseline';
    const loaded = (await cdp.send('Extensions.loadUnpacked', { path: installedPath })) as {
      id?: unknown;
    };
    assert(
      typeof loaded.id === 'string' && /^[a-p]{32}$/u.test(loaded.id),
      'Baseline extension ID is invalid'
    );
    const id = loaded.id;
    receipt.extensionId = id;
    onLoaded(id);
    extensionPage = await context.newPage();
    const baselineDetails = await extensionDetails(extensionPage, id);
    assert.equal(baselineDetails.id, id);
    assert.equal(baselineDetails.version, verified.input.previousVersion);
    receipt.activeStage = 'save-baseline-settings-through-ui';
    baselinePage = await openWatchFixture(context, root, id);
    const original = await settingsFontSize(baselinePage);
    const selected = original === 36 ? 38 : 36;
    receipt.originalFontSize = original;
    receipt.selectedFontSize = selected;
    await setFontSizeThroughUi(baselinePage, selected);
    await waitForStoredFont(extensionPage, selected);
    receipt.baselineStorageFontSize = await readExtensionStoredFontSize(extensionPage);
    await baselinePage.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(
      await settingsFontSize(baselinePage),
      selected,
      'Public extension settings UI did not retain preference'
    );
    await baselinePage.close();
    baselinePage = null;
    receipt.activeStage = 'replace-same-unpacked-path';
    await rm(installedPath, { recursive: true });
    await cp(join(root, CANDIDATE), installedPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    assert.equal(
      (await extensionInventory(installedPath)).sha256,
      verified.candidate.sha256,
      'Installed candidate bytes differ from bundle'
    );
    receipt.activeStage = 'reload-extension-runtime';
    try {
      await extensionPage.evaluate((expectedId) => {
        const runtime = (
          globalThis as typeof globalThis & {
            chrome?: { runtime?: { id?: string; reload?: () => void } };
          }
        ).chrome?.runtime;
        if (runtime?.id !== expectedId || !runtime.reload)
          throw new Error('Extension runtime identity changed before reload');
        runtime.reload();
      }, id);
    } catch (error) {
      // Reload may destroy its own execution context before Playwright replies.
      assert(
        error instanceof Error &&
          /Execution context was destroyed|Target page, context or browser has been closed|Cannot find context with specified id/u.test(
            error.message
          ),
        'Extension runtime reload could not be requested'
      );
    }
    await extensionPage.close().catch(() => {});
    extensionPage = null;
    candidateExtensionPage = await candidateDetails(context, id);
    receipt.activeStage = 'verify-candidate-settings';
    receipt.candidateStorageFontSize = await readExtensionStoredFontSize(candidateExtensionPage);
    assert.equal(
      receipt.candidateStorageFontSize,
      selected,
      'Extension storage preference changed across update'
    );
    candidatePage = await openWatchFixture(context, root, id);
    receipt.candidateUiFontSize = await settingsFontSize(candidatePage);
    assert.equal(
      receipt.candidateUiFontSize,
      selected,
      'Fresh candidate page did not show retained preference'
    );
    receipt.activeStage = 'restore-fixture-settings-through-ui';
    await setFontSizeThroughUi(candidatePage, original);
    await waitForStoredFont(candidateExtensionPage, original);
    await candidatePage.reload({ waitUntil: 'domcontentloaded' });
    receipt.restoredFontSize = await settingsFontSize(candidatePage);
    assert.equal(
      receipt.restoredFontSize,
      original,
      'Candidate fixture preference was not restored through UI'
    );
    assert.equal(
      (await extensionInventory(installedPath)).sha256,
      verified.candidate.sha256,
      'Installed candidate bytes changed during upgrade'
    );
    receipt.status = 'passed';
    receipt.activeStage = 'complete';
    return { extensionId: id, receipt };
  } catch (error) {
    receipt.errorType = error instanceof Error ? error.name : 'Error';
    const failure = new Error(`Extension update failed at ${receipt.activeStage}`, {
      cause: error,
    });
    (failure as Error & { extensionUpgrade: UpgradeReceipt }).extensionUpgrade = receipt;
    throw failure;
  } finally {
    await Promise.allSettled([
      baselinePage?.close(),
      extensionPage?.close(),
      candidatePage?.close(),
      candidateExtensionPage?.close(),
    ]);
  }
}
