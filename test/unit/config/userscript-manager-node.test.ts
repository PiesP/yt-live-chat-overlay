// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import * as https from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { crc32, deflateRawSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
  assertQualifiedRuntime,
  downloadPackage,
  EXTENSION_ID,
  MAX_ARCHIVE_BYTES,
  MAX_REDIRECTS,
  prepare,
  SHA256,
  storeUrl,
  unpackPackage,
  URL as STORE_URL,
  VERSION,
} from '../../../validation/windows/prepare-userscript-manager.ts';

const testRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    testRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'yt-manager-test-'));
  testRoots.push(root);
  return root;
}

interface FixtureEntry {
  name: string;
  content?: string | Buffer;
  method?: 0 | 8;
  mode?: number;
  crc?: number;
  declaredSize?: number;
}

// Write local and central ZIP headers directly so malformed names, duplicate
// members, checksums and declared sizes survive fixture construction.
function archive(entries: FixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content ?? '');
    const method = entry.method ?? 0;
    const stored = method === 8 ? deflateRawSync(content) : content;
    const checksum = entry.crc ?? crc32(content);
    const size = entry.declaredSize ?? content.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function packageBytes(
  extra: FixtureEntry[] = [],
  manifest: unknown = { version: VERSION, manifest_version: 3 }
): Buffer {
  const crx = Buffer.alloc(12);
  crx.write('Cr24');
  crx.writeUInt32LE(3, 4);
  return Buffer.concat([
    crx,
    archive([
      { name: 'manifest.json', content: JSON.stringify(manifest), method: 8 },
      { name: 'background.js', content: 'trusted fixture' },
      { name: '_metadata/verified_contents.json', content: '{}' },
      ...extra,
    ]),
  ]);
}

function digest(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

interface FakeReply {
  status?: number;
  location?: string;
  body?: Buffer;
  error?: Error;
  stall?: boolean;
}

function fakeRequests(replies: FakeReply[]): {
  request: typeof https.request;
  calls: {
    url: string;
    options: https.RequestOptions;
    requestDestroyed: () => boolean;
    response?: PassThrough;
  }[];
} {
  const calls: {
    url: string;
    options: https.RequestOptions;
    requestDestroyed: () => boolean;
    response?: PassThrough;
  }[] = [];
  const request = ((
    url: globalThis.URL,
    options: https.RequestOptions,
    listener: (res: IncomingMessage) => void
  ) => {
    const reply = replies.shift();
    let destroyed = false;
    const call: (typeof calls)[number] = {
      url: url.href,
      options,
      requestDestroyed: () => destroyed,
    };
    calls.push(call);
    const client = Object.assign(new EventEmitter(), {
      end: () => {
        queueMicrotask(() => {
          if (reply?.stall) return;
          if (reply?.error) {
            client.emit('error', reply.error);
            return;
          }
          const response = Object.assign(new PassThrough(), {
            statusCode: reply?.status ?? 200,
            headers: { ...(reply?.location === undefined ? {} : { location: reply.location }) },
          });
          call.response = response;
          listener(response as unknown as IncomingMessage);
          if (!response.destroyed) response.end(reply?.body ?? Buffer.alloc(0));
        });
      },
      destroy: (error?: Error) => {
        destroyed = true;
        if (error) client.emit('error', error);
        return client;
      },
    });
    return client;
  }) as unknown as typeof https.request;
  return { request, calls };
}

async function expectCleanFailure(body: Buffer, message?: RegExp): Promise<void> {
  const root = await fixtureRoot();
  const output = join(root, 'manager');
  await fs.writeFile(join(root, 'keep'), 'existing');
  await expect(
    prepare(output, { download: async () => body, expectedSha256: digest(body) })
  ).rejects.toThrow(message);
  expect((await fs.readdir(root)).sort()).toEqual(['keep']);
  expect(await fs.readFile(join(root, 'keep'), 'utf8')).toBe('existing');
}

describe('pinned Node userscript manager preparation', () => {
  it('pins the reviewed package and rejects unsupported preparation runtimes', () => {
    expect(VERSION).toBe('5.5.1');
    expect(SHA256).toBe('b5167937817e636adeba462ed9bf9b32ff01c2888f78a9afc6aa4f8e655fe872');
    expect(EXTENSION_ID).toBe('dhdgffkkebhmkfjojejmpbldmpobfkfo');
    expect(() => assertQualifiedRuntime('22.22.2')).toThrow('pinned Node 26.9.0');
    expect(() => assertQualifiedRuntime('24.15.0')).toThrow('pinned Node 26.9.0');
    assertQualifiedRuntime();
  });

  it('imports without network or filesystem side effects and rejects a changed pin', async () => {
    const root = await fixtureRoot();
    const output = join(root, 'manager');
    let downloads = 0;
    await expect(
      prepare(output, {
        download: async () => {
          downloads += 1;
          return Buffer.from('unreviewed');
        },
      })
    ).rejects.toThrow('reviewed pin');
    expect(downloads).toBe(1);
    expect(await fs.readdir(root)).toEqual([]);
    const imported = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(new globalThis.URL('../../../validation/windows/prepare-userscript-manager.ts', import.meta.url).href)})`,
      ],
      { encoding: 'utf8' }
    );
    expect(imported.status).toBe(0);
    expect(imported.stdout).toBe('');
  });

  it('refuses an existing destination before downloading', async () => {
    const root = await fixtureRoot();
    await fs.writeFile(join(root, 'keep'), 'existing');
    await expect(
      prepare(root, {
        download: async () => {
          throw new Error('network reached');
        },
      })
    ).rejects.toThrow('new output');
    expect(await fs.readFile(join(root, 'keep'), 'utf8')).toBe('existing');
  });

  it('extracts application files and preserves the CLI receipt fields', async () => {
    const root = await fixtureRoot();
    const output = join(root, 'manager');
    const body = packageBytes();
    const result = await prepare(output, {
      download: async () => body,
      expectedSha256: digest(body),
    });
    expect(result).toEqual({ directory: output, version: VERSION, crx_sha256: digest(body) });
    expect(await fs.readFile(join(output, 'background.js'), 'utf8')).toBe('trusted fixture');
    await expect(fs.lstat(join(output, '_metadata'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      JSON.parse(await fs.readFile(join(output, 'installation-source.json'), 'utf8'))
    ).toMatchObject({
      name: 'Tampermonkey',
      version: VERSION,
      store_extension_id: EXTENSION_ID,
      source_url: STORE_URL,
      crx_sha256: digest(body),
      installation_method: 'unpacked-from-pinned-store-crx',
      omitted_directory: '_metadata',
    });
  });

  it('rejects traversal, absolute, backslash, colon, NUL and Windows reserved names', async () => {
    for (const name of [
      '../escaped',
      '/absolute',
      'dir\\entry',
      'C:entry',
      'bad\0entry',
      'CON',
      'trailing.',
    ]) {
      await expectCleanFailure(packageBytes([{ name, content: 'escape' }]), /Unsafe package entry/);
    }
  });

  it('rejects wrong manifest versions and malformed CRX headers', async () => {
    await expectCleanFailure(
      packageBytes([], { version: '0.0.0', manifest_version: 3 }),
      /Unexpected manager manifest/
    );
    await expectCleanFailure(
      packageBytes([], { version: VERSION, manifest_version: 2 }),
      /Unexpected manager manifest/
    );
    const good = packageBytes();
    const wrongVersion = Buffer.from(good);
    wrongVersion.writeUInt32LE(2, 4);
    const wrongHeader = Buffer.from(good);
    wrongHeader.writeUInt32LE(good.length, 8);
    for (const bad of [
      Buffer.concat([Buffer.from('Bad!'), good.subarray(4)]),
      good.subarray(0, 10),
      wrongVersion,
      wrongHeader,
    ]) {
      await expectCleanFailure(bad);
    }
  });

  it('rejects corrupt or truncated ZIP, symlinks and declared limits', async () => {
    const good = packageBytes();
    await expectCleanFailure(Buffer.concat([good.subarray(0, 12), Buffer.from('not-a-zip')]));
    await expectCleanFailure(good.subarray(0, -22));
    await expectCleanFailure(packageBytes([{ name: 'link', content: 'target', mode: 0o120777 }]));
    await expectCleanFailure(
      packageBytes(
        Array.from({ length: 998 }, (_, index) => ({ name: `files/${index}`, content: 'x' }))
      ),
      /Unexpected package size/
    );
    await expectCleanFailure(
      packageBytes([{ name: 'huge', content: 'x', declaredSize: 64 * 1024 * 1024 + 1 }]),
      /Unexpected package size/
    );
  });

  it('detects duplicate names, case collisions, Unicode normalization and file-directory conflicts before omission', async () => {
    for (const entries of [
      [
        { name: 'dup', content: 'a' },
        { name: 'dup', content: 'b' },
      ],
      [
        { name: 'A', content: 'a' },
        { name: 'a', content: 'b' },
      ],
      [
        { name: 'é', content: 'a' },
        { name: 'e\u0301', content: 'b' },
      ],
      [
        { name: 'node', content: 'a' },
        { name: 'node/child', content: 'b' },
      ],
      [
        { name: '_metadata/Dup', content: 'a' },
        { name: '_metadata/dup', content: 'b' },
      ],
    ]) {
      await expectCleanFailure(packageBytes(entries), /Duplicate or colliding/);
    }
  });

  it('rejects local header names that disagree with the central directory, including omitted metadata', async () => {
    for (const name of ['manifest.json', '_metadata/verified_contents.json']) {
      const body = packageBytes();
      const localName = body.indexOf(Buffer.from(name));
      expect(localName).toBeGreaterThan(0);
      body[localName] = (body[localName] ?? 0) ^ 1;
      await expectCleanFailure(body, /Local and central ZIP entry names disagree/);
    }
  });

  it('verifies CRC, truncation and dishonest size with the actual Node ZIP reader', async () => {
    await expectCleanFailure(
      packageBytes([{ name: 'bad-crc', content: 'payload', crc: 1 }]),
      /corrupt|checksum|CRC/i
    );
    await expectCleanFailure(
      packageBytes([{ name: 'bad-size', content: 'payload', declaredSize: 6 }])
    );
    const truncated = packageBytes([{ name: 'truncated', content: 'payload' }]);
    const dataOffset = truncated.indexOf(Buffer.from('payload'));
    const missingDataByte = Buffer.concat([
      truncated.subarray(0, dataOffset + 3),
      truncated.subarray(dataOffset + 4),
    ]);
    missingDataByte.writeUInt32LE(
      truncated.readUInt32LE(truncated.length - 6) - 1,
      missingDataByte.length - 6
    );
    await expectCleanFailure(missingDataByte);
    const compressed = packageBytes([
      { name: 'compressed', content: 'long'.repeat(1_000), method: 8 },
    ]);
    const files = await unpackPackage(compressed, digest(compressed));
    expect(files.find((file) => file.parts.join('/') === 'compressed')?.content.length).toBe(4_000);
    const short = Buffer.from(compressed);
    const start = short.indexOf(Buffer.from('compressed'));
    const corruptedOffset = start + 'compressed'.length + 1;
    short[corruptedOffset] = (short[corruptedOffset] ?? 0) ^ 0xff;
    await expectCleanFailure(short);
  });

  it('removes only its owned staging directory after extraction, receipt or rename failure', async () => {
    const body = packageBytes();
    for (const fault of ['extract', 'receipt', 'rename']) {
      const root = await fixtureRoot();
      const output = join(root, 'manager');
      await fs.writeFile(join(root, 'keep'), 'existing');
      const files = new Proxy(fs, {
        get(target, property) {
          if (property === 'writeFile')
            return async (path: string, content: string | Buffer) => {
              if (
                (fault === 'extract' && path.endsWith('background.js')) ||
                (fault === 'receipt' && path.endsWith('installation-source.json'))
              ) {
                throw new Error(`${fault} failed`);
              }
              return fs.writeFile(path, content);
            };
          if (property === 'rename' && fault === 'rename')
            return async () => {
              throw new Error('rename failed');
            };
          return Reflect.get(target, property);
        },
      });
      await expect(
        prepare(output, { download: async () => body, expectedSha256: digest(body), files })
      ).rejects.toThrow(`${fault} failed`);
      expect(await fs.readdir(root)).toEqual(['keep']);
    }
  });

  it('follows only approved HTTPS redirects without consuming redirect bodies', async () => {
    const fake = fakeRequests([
      {
        status: 302,
        location: 'https://clients2.googleusercontent.com/package',
        body: Buffer.from('ignore'),
      },
      { status: 307, location: '/reviewed.crx?version=5.5.1', body: Buffer.from('ignore') },
      { body: Buffer.from('reviewed') },
    ]);
    expect(await downloadPackage(STORE_URL, fake.request)).toEqual(Buffer.from('reviewed'));
    expect(fake.calls.map((call) => call.url)).toEqual([
      STORE_URL,
      'https://clients2.googleusercontent.com/package',
      'https://clients2.googleusercontent.com/reviewed.crx?version=5.5.1',
    ]);
    expect(fake.calls.every((call) => call.options.method === 'GET')).toBe(true);
    expect(fake.calls.slice(0, 2).every((call) => call.response?.destroyed)).toBe(true);
  });

  it('rejects unsafe initial and redirect URLs before accessing their destination', async () => {
    const unsafe = [
      'file:///not-opened',
      'ftp://clients2.googleusercontent.com/package',
      'http://clients2.googleusercontent.com/package',
      'https://example.invalid/package',
      '//example.invalid/package',
      'https://clients2.google.com.example.invalid/package',
      'https://clients2.google.com@127.0.0.1/package',
      'https://user@clients2.google.com/package',
      'https://clients2.google.com:8443/package',
      'https://clients2.google.com:invalid/package',
      'https://clients2.google.com\\@example.invalid/package',
      ' https://clients2.google.com/package',
      'https://clients2.google.com/\r\npackage',
    ];
    for (const value of unsafe) {
      expect(() => storeUrl(value)).toThrow();
      const fake = fakeRequests([]);
      await expect(downloadPackage(value, fake.request)).rejects.toThrow();
      expect(fake.calls).toHaveLength(0);
      const redirect = fakeRequests([{ status: 302, location: value }]);
      await expect(downloadPackage(STORE_URL, redirect.request)).rejects.toThrow();
      expect(redirect.calls).toHaveLength(1);
    }
    for (const value of [undefined, '']) {
      const redirect = fakeRequests([
        { status: 302, ...(value === undefined ? {} : { location: value }) },
      ]);
      await expect(downloadPackage(STORE_URL, redirect.request)).rejects.toThrow();
      expect(redirect.calls).toHaveLength(1);
    }
  });

  it('bounds redirect count, HTTP status and response body', async () => {
    const loops = fakeRequests(
      Array.from({ length: MAX_REDIRECTS + 1 }, () => ({ status: 302, location: '/loop' }))
    );
    await expect(downloadPackage(STORE_URL, loops.request)).rejects.toThrow('Too many');
    expect(loops.calls).toHaveLength(MAX_REDIRECTS + 1);
    const failed = fakeRequests([{ status: 404, body: Buffer.from('error') }]);
    await expect(downloadPackage(STORE_URL, failed.request)).rejects.toThrow('HTTP 404');
    expect(failed.calls[0]?.response?.destroyed).toBe(true);
    const tooLarge = fakeRequests([{ body: Buffer.alloc(MAX_ARCHIVE_BYTES + 1) }]);
    await expect(downloadPackage(STORE_URL, tooLarge.request)).rejects.toThrow('16 MiB');
    expect(tooLarge.calls[0]?.requestDestroyed()).toBe(true);
  });

  it('uses a direct private agent and destroys stalled requests on the deadline', async () => {
    const priorProxy = process.env.HTTPS_PROXY;
    const priorEnable = process.env.NODE_USE_ENV_PROXY;
    process.env.HTTPS_PROXY = 'http://attacker.invalid:8080';
    process.env.NODE_USE_ENV_PROXY = '1';
    try {
      const fake = fakeRequests([{ stall: true }]);
      await expect(downloadPackage(STORE_URL, fake.request, 5)).rejects.toThrow('deadline');
      expect(fake.calls[0]?.requestDestroyed()).toBe(true);
      const agent = fake.calls[0]?.options.agent;
      expect(agent).toBeInstanceOf(https.Agent);
      expect((agent as https.Agent).options.proxyEnv).toEqual({});
    } finally {
      if (priorProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = priorProxy;
      if (priorEnable === undefined) delete process.env.NODE_USE_ENV_PROXY;
      else process.env.NODE_USE_ENV_PROXY = priorEnable;
    }
  });

  it('preserves output state after a transport failure and checks CLI arguments', async () => {
    const root = await fixtureRoot();
    const output = join(root, 'manager');
    const fake = fakeRequests([{ error: new Error('connection lost') }]);
    await expect(
      prepare(output, { download: () => downloadPackage(STORE_URL, fake.request) })
    ).rejects.toThrow('connection lost');
    expect(await fs.readdir(root)).toEqual([]);
    const cli = spawnSync(
      process.execPath,
      [resolve('validation/windows/prepare-userscript-manager.ts')],
      { encoding: 'utf8' }
    );
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain('Usage:');
  });
});
