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
const CANDIDATE = 'dist-extension';
const PUBLIC_RELEASES = {
  '0.45.7': {
    candidateVersions: ['0.45.8'],
    archive: 'validation/windows/release-upgrade/public-v0.45.7-chrome/artifact.zip',
    baseline: 'validation/windows/release-upgrade/public-v0.45.7-chrome/unpacked',
    url: 'https://github.com/PiesP/yt-live-chat-overlay/releases/download/v0.45.7/yt-live-chat-overlay-chrome.zip',
  },
  '0.45.8': {
    candidateVersions: ['0.45.8', '0.45.9'],
    archive: 'validation/windows/release-upgrade/public-v0.45.8-chrome/artifact.zip',
    baseline: 'validation/windows/release-upgrade/public-v0.45.8-chrome/unpacked',
    url: 'https://github.com/PiesP/yt-live-chat-overlay/releases/download/v0.45.8/yt-live-chat-overlay-chrome.zip',
  },
} as const;
type PublicVersion = keyof typeof PUBLIC_RELEASES;
type PublicRelease = (typeof PUBLIC_RELEASES)[PublicVersion];
const STORAGE_KEY = 'yt-live-chat-overlay-settings';
const FIXTURE_URL = 'https://www.youtube.com/watch?v=windowsExtensionUpgrade';
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const RUNTIME_SCRIPT_NAMES = ['content-script.js', 'page-script.js'] as const;
type RuntimeScriptName = (typeof RUNTIME_SCRIPT_NAMES)[number];
type RuntimeScriptRecord = {
  expectedSha256: string;
  observedSha256: string | null;
  observedBytes: number | null;
  parsedCount: number;
};
type RuntimeScriptEvidence = Record<RuntimeScriptName, RuntimeScriptRecord>;

async function runtimeCommandDeadline<T>(request: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
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
  previousVersion: PublicVersion;
  candidateVersion: '0.45.8' | '0.45.9';
  publicAssetUrl: PublicRelease['url'];
  publicArchive: { path: PublicRelease['archive']; sha256: string };
  previousExtension: { path: PublicRelease['baseline']; inventorySha256: string };
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
  assert(input.previousVersion === '0.45.7' || input.previousVersion === '0.45.8');
  const release = PUBLIC_RELEASES[input.previousVersion];
  assert(
    release.candidateVersions.some((version) => version === input.candidateVersion),
    'Unsupported extension upgrade transition'
  );
  assert.equal(input.publicAssetUrl, release.url);
  const archive = object(input.publicArchive);
  keys(archive, ['path', 'sha256']);
  assert.equal(archive.path, release.archive);
  sha(archive.sha256);
  const baseline = object(input.previousExtension);
  keys(baseline, ['path', 'inventorySha256']);
  assert.equal(baseline.path, release.baseline);
  sha(baseline.inventorySha256);
  const candidate = object(input.candidateExtension);
  keys(candidate, ['inventorySha256']);
  sha(candidate.inventorySha256);
  return input as ExtensionInput;
}

export function extensionUpgradeTransition(input: ExtensionInput): string {
  validateExtensionUpgradeInput(input);
  return `public-${input.previousVersion}-to-candidate-${input.candidateVersion}`;
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

export async function boundedFile(
  path: string,
  maximum: number,
  { onOpened }: { onOpened?: () => Promise<void> } = {}
): Promise<Buffer> {
  const flags =
    process.platform === 'win32'
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    assert(
      opened.isFile() && opened.size > 0n && opened.size <= BigInt(maximum),
      'Extension input must be a bounded regular file'
    );
    const requirePathIdentity = async () => {
      let entry: BigIntStats;
      try {
        entry = await lstat(path, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
          assert.fail('Extension file changed during inspection');
        throw error;
      }
      assert(sameFile(opened, entry), 'Extension file changed during inspection');
    };
    await requirePathIdentity();
    await onOpened?.();
    const expected = Number(opened.size);
    const bounded = Buffer.alloc(expected + 1);
    let offset = 0;
    while (offset < bounded.length) {
      const { bytesRead } = await handle.read(bounded, offset, bounded.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    assert.equal(offset, expected, 'Extension file changed size while reading');
    assert(
      sameFile(opened, await handle.stat({ bigint: true })),
      'Extension file changed during read'
    );
    await requirePathIdentity();
    return bounded.subarray(0, offset);
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
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      try {
        await lstat(join(root, INPUT));
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw inspectionError;
      }
      assert.fail('Extension input path is invalid');
    }
    throw error;
  }
  const input = validateExtensionUpgradeInput(JSON.parse(raw.toString('utf8')));
  const release = PUBLIC_RELEASES[input.previousVersion];
  await ordinaryParents(root, release.archive);
  await ordinaryParents(root, release.baseline);
  const archive = await boundedFile(join(root, release.archive), MAX_ARCHIVE_BYTES);
  assert.equal(digest(archive), input.publicArchive.sha256, 'Public Chrome ZIP SHA-256 differs');
  const baseline = await extensionInventory(join(root, release.baseline));
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
  assert.notEqual(
    baseline.sha256,
    candidate.sha256,
    'Published and candidate extension inventories are identical'
  );
  assert.notEqual(
    baseline.files['page-script.js'],
    candidate.files['page-script.js'],
    'Published and candidate page scripts are identical'
  );
  assert.equal(
    manifestVersion(await boundedFile(join(root, release.baseline, 'manifest.json'), 64_000)),
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
  transition: string;
  method: 'same-path-unpacked-runtime-reload';
  publicAssetUrl: PublicRelease['url'];
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
  baselineRuntimeScripts: RuntimeScriptEvidence | null;
  candidateRuntimeScripts: RuntimeScriptEvidence | null;
  errorType?: string;
};

/** Hash the exact script source parsed by this page, with the CDP session attached before navigation. */
export async function beginExtensionRuntimeScriptCapture(
  context: Pick<BrowserContext, 'newCDPSession'>,
  page: Page,
  extensionId: string,
  expected: Inventory
): Promise<{
  verify: (timeoutMs?: number) => Promise<RuntimeScriptEvidence>;
  snapshot: () => RuntimeScriptEvidence;
  close: () => Promise<void>;
}> {
  assert.match(extensionId, /^[a-p]{32}$/u, 'Extension ID is invalid');
  const records: RuntimeScriptEvidence = {
    'content-script.js': {
      expectedSha256: expected.files['content-script.js'] ?? '',
      observedSha256: null,
      observedBytes: null,
      parsedCount: 0,
    },
    'page-script.js': {
      expectedSha256: expected.files['page-script.js'] ?? '',
      observedSha256: null,
      observedBytes: null,
      parsedCount: 0,
    },
  };
  for (const name of RUNTIME_SCRIPT_NAMES)
    assert.match(records[name].expectedSha256, /^[0-9a-f]{64}$/u, `Missing ${name} inventory`);
  const urls = new Map(
    RUNTIME_SCRIPT_NAMES.map((name) => [`chrome-extension://${extensionId}/${name}`, name])
  );
  const session = await runtimeCommandDeadline(context.newCDPSession(page), 'Debugger attach');
  const errors: unknown[] = [];
  let matchedCount = 0;
  let waiting: (() => void) | null = null;
  let closed = false;
  const changed = () => {
    const notify = waiting;
    waiting = null;
    notify?.();
  };
  const recordError = (error: unknown) => {
    if (errors.length < RUNTIME_SCRIPT_NAMES.length) errors.push(error);
    changed();
  };
  const onScriptParsed = ({ url, scriptId }: { url?: unknown; scriptId?: unknown }) => {
    const name = typeof url === 'string' ? urls.get(url) : undefined;
    if (!name || closed || errors.length) return;
    matchedCount = Math.min(matchedCount + 1, RUNTIME_SCRIPT_NAMES.length + 1);
    const record = records[name];
    record.parsedCount = Math.min(record.parsedCount + 1, 2);
    if (matchedCount > RUNTIME_SCRIPT_NAMES.length || record.parsedCount > 1) {
      recordError(new Error(`Ambiguous executed extension script: ${name}`));
      return;
    }
    if (typeof scriptId !== 'string' || scriptId.length === 0) {
      recordError(new Error(`Missing parsed script ID: ${name}`));
      return;
    }
    void session
      .send('Debugger.getScriptSource', { scriptId })
      .then((result: unknown) => {
        assert(result && typeof result === 'object' && 'scriptSource' in result);
        const source = result.scriptSource;
        assert(typeof source === 'string', `Missing executed script source: ${name}`);
        const bytes = Buffer.byteLength(source, 'utf8');
        assert(bytes > 0 && bytes <= MAX_FILE_BYTES, `Executed script size is invalid: ${name}`);
        record.observedBytes = bytes;
        record.observedSha256 = digest(source);
        assert.equal(
          record.observedSha256,
          record.expectedSha256,
          `Executed extension script differs from inventory: ${name}`
        );
      })
      .catch(recordError)
      .finally(changed);
  };
  session.on('Debugger.scriptParsed', onScriptParsed);
  try {
    await runtimeCommandDeadline(session.send('Debugger.enable'), 'Debugger enable');
  } catch (error) {
    session.removeListener('Debugger.scriptParsed', onScriptParsed);
    try {
      await runtimeCommandDeadline(session.detach(), 'Debugger setup detach');
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Debugger setup and cleanup failed');
    }
    throw error;
  }
  return {
    snapshot: () => ({
      'content-script.js': { ...records['content-script.js'] },
      'page-script.js': { ...records['page-script.js'] },
    }),
    verify: async (timeoutMs = 10_000) => {
      assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10_000);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (errors.length) throw errors[0];
        if (
          RUNTIME_SCRIPT_NAMES.every(
            (name) => records[name].observedSha256 === records[name].expectedSha256
          )
        )
          return {
            'content-script.js': { ...records['content-script.js'] },
            'page-script.js': { ...records['page-script.js'] },
          };
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          const missing = RUNTIME_SCRIPT_NAMES.filter(
            (name) => records[name].observedSha256 === null
          );
          throw new Error(`Executed extension scripts were not observed: ${missing.join(', ')}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            waiting = null;
            resolve();
          }, remaining);
          waiting = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      session.removeListener('Debugger.scriptParsed', onScriptParsed);
      changed();
      const cleanupErrors: unknown[] = [];
      try {
        await runtimeCommandDeadline(session.send('Debugger.disable'), 'Debugger disable');
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await runtimeCommandDeadline(session.detach(), 'Debugger detach');
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length)
        throw new AggregateError(cleanupErrors, 'Extension script debugger cleanup failed');
    },
  };
}

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

async function openWatchFixture(page: Page, root: string, id: string): Promise<void> {
  const preview = await readFile(join(root, 'test/visual/preview.html'), 'utf8');
  const html = buildVisibleWatchHtml(preview, 'Extension upgrade fixture video');
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

async function candidateDetails(
  context: BrowserContext,
  id: string,
  candidateVersion: ExtensionInput['candidateVersion']
): Promise<Page> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  do {
    const page = await context.newPage();
    try {
      const details = await extensionDetails(page, id);
      assert.equal(details.id, id, 'Updated extension ID changed');
      assert.equal(details.version, candidateVersion, 'Updated runtime manifest did not activate');
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
  const release = PUBLIC_RELEASES[verified.input.previousVersion];
  const receipt: UpgradeReceipt = {
    status: 'failed',
    transition: extensionUpgradeTransition(verified.input),
    method: 'same-path-unpacked-runtime-reload',
    publicAssetUrl: release.url,
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
    baselineRuntimeScripts: null,
    candidateRuntimeScripts: null,
  };
  let baselinePage: Page | null = null;
  let extensionPage: Page | null = null;
  let candidatePage: Page | null = null;
  let candidateExtensionPage: Page | null = null;
  let baselineCapture: Awaited<ReturnType<typeof beginExtensionRuntimeScriptCapture>> | null = null;
  let candidateCapture: Awaited<ReturnType<typeof beginExtensionRuntimeScriptCapture>> | null =
    null;
  let primaryFailure: Error | null = null;
  let completed: { extensionId: string; receipt: UpgradeReceipt } | null = null;
  try {
    await mkdir(profile, { recursive: true });
    await cp(join(root, release.baseline), installedPath, {
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
    receipt.activeStage = 'verify-public-runtime-scripts';
    baselinePage = await context.newPage();
    baselineCapture = await beginExtensionRuntimeScriptCapture(
      context,
      baselinePage,
      id,
      verified.baseline
    );
    await openWatchFixture(baselinePage, root, id);
    receipt.baselineRuntimeScripts = await baselineCapture.verify();
    await baselineCapture.close();
    baselineCapture = null;
    receipt.activeStage = 'save-baseline-settings-through-ui';
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
    candidateExtensionPage = await candidateDetails(context, id, verified.input.candidateVersion);
    receipt.activeStage = 'verify-candidate-settings';
    receipt.candidateStorageFontSize = await readExtensionStoredFontSize(candidateExtensionPage);
    assert.equal(
      receipt.candidateStorageFontSize,
      selected,
      'Extension storage preference changed across update'
    );
    receipt.activeStage = 'verify-candidate-runtime-scripts';
    candidatePage = await context.newPage();
    candidateCapture = await beginExtensionRuntimeScriptCapture(
      context,
      candidatePage,
      id,
      verified.candidate
    );
    await openWatchFixture(candidatePage, root, id);
    receipt.candidateRuntimeScripts = await candidateCapture.verify();
    await candidateCapture.close();
    candidateCapture = null;
    receipt.activeStage = 'verify-candidate-settings';
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
    completed = { extensionId: id, receipt };
  } catch (error) {
    receipt.baselineRuntimeScripts ??= baselineCapture?.snapshot() ?? null;
    receipt.candidateRuntimeScripts ??= candidateCapture?.snapshot() ?? null;
    receipt.errorType = error instanceof Error ? error.name : 'Error';
    const failure = new Error(`Extension update failed at ${receipt.activeStage}`, {
      cause: error,
    });
    (failure as Error & { extensionUpgrade: UpgradeReceipt }).extensionUpgrade = receipt;
    primaryFailure = failure;
  }
  const sessions = await Promise.allSettled([baselineCapture?.close(), candidateCapture?.close()]);
  const pages = await Promise.allSettled([
    baselinePage?.close(),
    extensionPage?.close(),
    candidatePage?.close(),
    candidateExtensionPage?.close(),
  ]);
  const cleanupErrors = [...sessions, ...pages]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (cleanupErrors.length) {
    receipt.status = 'failed';
    if (!primaryFailure) {
      receipt.activeStage = 'cleanup';
      receipt.errorType = 'AggregateError';
    }
    const failure = new AggregateError(
      primaryFailure ? [primaryFailure, ...cleanupErrors] : cleanupErrors,
      `Extension update failed at ${receipt.activeStage}`
    );
    (failure as AggregateError & { extensionUpgrade: UpgradeReceipt }).extensionUpgrade = receipt;
    throw failure;
  }
  if (primaryFailure) throw primaryFailure;
  assert(completed, 'Extension update did not complete');
  return completed;
}
