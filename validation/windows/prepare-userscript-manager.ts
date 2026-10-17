// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as https from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as zlib from 'node:zlib';

export const VERSION = '5.5.1';
export const SHA256 = 'b5167937817e636adeba462ed9bf9b32ff01c2888f78a9afc6aa4f8e655fe872';
export const EXTENSION_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
export const URL =
  'https://clients2.google.com/service/update2/crx?response=redirect' +
  '&prodversion=152.0.7977.83&acceptformat=crx3&prod=chromecrx&prodchannel=stable' +
  '&os=win&arch=x64&x=id%3Ddhdgffkkebhmkfjojejmpbldmpobfkfo%26uc';

export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
const MAX_ENTRIES = 1_000;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const REQUEST_DEADLINE_MS = 60_000;
const STORE_HOSTS = new Set(['clients2.google.com', 'clients2.googleusercontent.com']);

// @types/node 26.6.2 predates Node 26.8's experimental ZIP API. Keep the
// boundary local, qualify the real runtime, and never bind a missing named export.
interface ZipEntryView {
  readonly name: string;
  readonly nameBuffer: Buffer;
  readonly size: number;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymlink: boolean;
  content(options: { verify: true; maxSize: number }): Promise<Buffer>;
}

const zipApi = zlib as typeof zlib & {
  ZipEntry?: { read(buffer: Buffer): Iterable<ZipEntryView> };
};

export function assertQualifiedRuntime(version: string = process.versions.node): void {
  if (version !== '26.9.0' || typeof zipApi.ZipEntry?.read !== 'function') {
    throw new Error('Userscript manager preparation requires the pinned Node 26.9.0 ZIP runtime.');
  }
}

export function storeUrl(value: string | undefined, base: string = URL): globalThis.URL {
  if (
    !value ||
    value.includes('\\') ||
    [...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  ) {
    throw new Error('Invalid Store download URL.');
  }
  let target: globalThis.URL;
  try {
    target = new globalThis.URL(value, base);
  } catch {
    throw new Error('Invalid Store download URL.');
  }
  if (
    target.protocol !== 'https:' ||
    !STORE_HOSTS.has(target.hostname) ||
    target.username !== '' ||
    target.password !== '' ||
    (target.port !== '' && target.port !== '443')
  ) {
    throw new Error('Store downloads require an approved HTTPS origin.');
  }
  return target;
}

type Requester = typeof https.request;

function requestOnce(
  target: globalThis.URL,
  requester: Requester,
  deadlineMs: number
): Promise<{
  status: number;
  location?: string;
  body?: Buffer;
}> {
  // A private agent with an empty proxyEnv ignores even NODE_USE_ENV_PROXY=1.
  // Destroy it after each response so redirects cannot reuse a stale socket.
  const agent = new https.Agent({ proxyEnv: {}, keepAlive: false, maxCachedSessions: 0 });
  return new Promise((resolveResult, rejectResult) => {
    let settled = false;
    let request: ReturnType<Requester>;
    const finish = (
      error?: Error,
      value?: { status: number; location?: string; body?: Buffer }
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      agent.destroy();
      if (error) rejectResult(error);
      else if (value) resolveResult(value);
    };
    const deadline = setTimeout(() => {
      const error = new Error('Store download exceeded the 60-second request deadline.');
      request.destroy(error);
      finish(error);
    }, deadlineMs);
    try {
      request = requester(target, { method: 'GET', agent }, (response) => {
        response.on('error', (error) => finish(error));
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.destroy();
          finish(undefined, { status, ...(typeof location === 'string' ? { location } : {}) });
          return;
        }
        if (status !== 200) {
          response.destroy();
          finish(new Error(`Store download failed with HTTP ${status}.`));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_ARCHIVE_BYTES) {
            response.destroy();
            request.destroy();
            finish(new Error('The Store package exceeds the 16 MiB download limit.'));
          } else {
            chunks.push(chunk);
          }
        });
        response.on('end', () =>
          finish(undefined, { status, body: Buffer.concat(chunks, length) })
        );
      });
      request.on('error', (error) => finish(error));
      request.end();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function downloadPackage(
  start: string = URL,
  requester: Requester = https.request,
  deadlineMs: number = REQUEST_DEADLINE_MS
): Promise<Buffer> {
  assertQualifiedRuntime();
  let target = storeUrl(start);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await requestOnce(target, requester, deadlineMs);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === MAX_REDIRECTS) throw new Error('Too many Store download redirects.');
      target = storeUrl(response.location, target.href);
      continue;
    }
    if (!response.body) throw new Error('Store download returned no package.');
    return response.body;
  }
  throw new Error('Too many Store download redirects.');
}

function archivePath(name: string, isDirectory: boolean): string[] {
  if (
    name.length === 0 ||
    name.startsWith('/') ||
    /[\\:<>"|?*]/u.test(name) ||
    [...name].some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127) ||
    (isDirectory && !name.endsWith('/'))
  ) {
    throw new Error('Unsafe package entry.');
  }
  const parts = (isDirectory ? name.slice(0, -1) : name).split('/');
  if (
    parts.some(
      (part) =>
        part === '' ||
        part === '.' ||
        part === '..' ||
        /[. ]$/u.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)
    )
  ) {
    throw new Error('Unsafe package entry.');
  }
  return parts;
}

interface ExtractedFile {
  parts: string[];
  content: Buffer;
}

// Node 26.9 checks local method, flags and sizes against the central directory,
// but does not compare their filenames. Check that one field before extracting.
function assertLocalNames(zip: Buffer, entries: ZipEntryView[]): void {
  let end = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 22 - 0xffff); offset -= 1) {
    if (
      zip.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + zip.readUInt16LE(offset + 20) === zip.length
    ) {
      if (end !== -1) throw new Error('Ambiguous ZIP directory end.');
      end = offset;
    }
  }
  if (end < 0 || zip.readUInt16LE(end + 10) !== entries.length) {
    throw new Error('Invalid ZIP directory.');
  }
  const centralSize = zip.readUInt32LE(end + 12);
  const centralOffset = zip.readUInt32LE(end + 16);
  const centralStart = end - centralSize;
  const prefix = centralStart - centralOffset;
  if (centralSize === 0xffffffff || centralOffset === 0xffffffff || prefix < 0) {
    throw new Error('Unsupported ZIP directory layout.');
  }
  let cursor = centralStart;
  for (const entry of entries) {
    if (cursor < 0 || cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Invalid ZIP directory.');
    }
    const nameLength = zip.readUInt16LE(cursor + 28);
    const recordEnd =
      cursor + 46 + nameLength + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
    const centralName = zip.subarray(cursor + 46, cursor + 46 + nameLength);
    const localOffset = prefix + zip.readUInt32LE(cursor + 42);
    if (
      recordEnd > end ||
      !centralName.equals(entry.nameBuffer) ||
      localOffset < 0 ||
      localOffset + 30 > centralStart ||
      zip.readUInt32LE(localOffset) !== 0x04034b50
    ) {
      throw new Error('Invalid ZIP entry header.');
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localNameStart = localOffset + 30;
    if (
      localNameStart + localNameLength + zip.readUInt16LE(localOffset + 28) > centralStart ||
      !zip.subarray(localNameStart, localNameStart + localNameLength).equals(centralName)
    ) {
      throw new Error('Local and central ZIP entry names disagree.');
    }
    cursor = recordEnd;
  }
  if (cursor !== end) throw new Error('Invalid ZIP directory.');
}

export async function unpackPackage(
  body: Buffer,
  expectedSha256: string = SHA256
): Promise<ExtractedFile[]> {
  assertQualifiedRuntime();
  if (
    body.length > MAX_ARCHIVE_BYTES ||
    createHash('sha256').update(body).digest('hex') !== expectedSha256
  ) {
    throw new Error(
      'The Store package does not match the reviewed pin; review a new version first.'
    );
  }
  if (body.length < 12 || body.toString('ascii', 0, 4) !== 'Cr24') {
    throw new Error('Expected a Chrome CRX package.');
  }
  const headerSize = body.readUInt32LE(8);
  if (body.readUInt32LE(4) !== 3 || headerSize > body.length - 12) {
    throw new Error('Invalid CRX3 header.');
  }
  const reader = zipApi.ZipEntry;
  if (!reader) throw new Error('The pinned Node ZIP reader is unavailable.');
  const entries: ZipEntryView[] = [];
  const zip = body.subarray(12 + headerSize);
  for (const entry of reader.read(zip)) {
    if (entries.length === MAX_ENTRIES) throw new Error('Unexpected package size.');
    entries.push(entry);
  }
  assertLocalNames(zip, entries);
  let declared = 0;
  const names = new Map<string, { name: string; kind: 'file' | 'directory'; explicit: boolean }>();
  const selected: { parts: string[]; entry: ZipEntryView }[] = [];
  for (const entry of entries) {
    const parts = archivePath(entry.name, entry.isDirectory);
    if (entry.isSymlink || (!entry.isDirectory && !entry.isFile))
      throw new Error('Unsafe package entry.');
    if (!Number.isSafeInteger(entry.size) || entry.size < 0)
      throw new Error('Unexpected package size.');
    declared += entry.size;
    if (declared > MAX_EXPANDED_BYTES) throw new Error('Unexpected package size.');
    for (let index = 0; index < parts.length; index += 1) {
      const path = parts.slice(0, index + 1).join('/');
      const key = path.normalize('NFC').toLowerCase();
      const kind = index === parts.length - 1 && !entry.isDirectory ? 'file' : 'directory';
      const prior = names.get(key);
      if (
        prior &&
        (prior.name !== path ||
          prior.kind !== kind ||
          (index === parts.length - 1 && prior.explicit))
      ) {
        throw new Error('Duplicate or colliding package entry.');
      }
      names.set(key, {
        name: path,
        kind,
        explicit: index === parts.length - 1 || (prior?.explicit ?? false),
      });
    }
    if (!entry.isDirectory && parts[0] !== '_metadata') selected.push({ parts, entry });
  }
  let expanded = 0;
  const files: ExtractedFile[] = [];
  for (const { parts, entry } of selected) {
    const content = await entry.content({ verify: true, maxSize: MAX_EXPANDED_BYTES - expanded });
    if (content.length !== entry.size) throw new Error('Corrupt package entry size.');
    expanded += content.length;
    if (expanded > MAX_EXPANDED_BYTES) throw new Error('Unexpected package size.');
    files.push({ parts, content });
  }
  const manifestFile = files.find(
    (file) => file.parts.length === 1 && file.parts[0] === 'manifest.json'
  );
  if (!manifestFile) throw new Error('Unexpected manager manifest.');
  const manifest: unknown = JSON.parse(manifestFile.content.toString('utf8'));
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('version' in manifest) ||
    manifest.version !== VERSION ||
    !('manifest_version' in manifest) ||
    manifest.manifest_version !== 3
  ) {
    throw new Error('Unexpected manager manifest.');
  }
  return files;
}

type FileOperations = Pick<
  typeof fs,
  'lstat' | 'mkdir' | 'mkdtemp' | 'writeFile' | 'rename' | 'rm'
>;

async function exists(path: string, files: FileOperations): Promise<boolean> {
  try {
    await files.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function prepare(
  outputPath: string,
  options: {
    download?: () => Promise<Buffer>;
    expectedSha256?: string;
    files?: FileOperations;
  } = {}
): Promise<{ directory: string; version: string; crx_sha256: string }> {
  assertQualifiedRuntime();
  const output = resolve(outputPath);
  const files = options.files ?? fs;
  if (await exists(output, files)) throw new Error('Choose a new output directory.');
  const body = await (options.download ?? downloadPackage)();
  const expectedSha256 = options.expectedSha256 ?? SHA256;
  const entries = await unpackPackage(body, expectedSha256);
  await files.mkdir(dirname(output), { recursive: true });
  const temporary = await files.mkdtemp(join(dirname(output), 'userscript-manager-'));
  try {
    for (const { parts, content } of entries) {
      const destination = join(temporary, ...parts);
      await files.mkdir(dirname(destination), { recursive: true });
      await files.writeFile(destination, content);
    }
    await files.writeFile(
      join(temporary, 'installation-source.json'),
      JSON.stringify(
        {
          name: 'Tampermonkey',
          version: VERSION,
          store_extension_id: EXTENSION_ID,
          source_url: URL,
          crx_sha256: expectedSha256,
          installation_method: 'unpacked-from-pinned-store-crx',
          omitted_directory: '_metadata',
        },
        null,
        2
      )
    );
    if (await exists(output, files)) throw new Error('Choose a new output directory.');
    await files.rename(temporary, output);
  } catch (error) {
    try {
      await files.rm(temporary, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Manager staging cleanup failed.');
    }
    throw error;
  }
  return { directory: output, version: VERSION, crx_sha256: expectedSha256 };
}

async function main(): Promise<void> {
  assertQualifiedRuntime();
  if (process.argv.length !== 4 || process.argv[2] !== '--output' || !process.argv[3]) {
    throw new Error(
      'Usage: node validation/windows/prepare-userscript-manager.ts --output <new-directory>'
    );
  }
  const result = await prepare(process.argv[3]);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
