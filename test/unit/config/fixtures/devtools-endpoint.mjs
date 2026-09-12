// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { readDevToolsEndpoint } from '../../../../validation/windows/natural-chrome.mjs';

const actualFs = { open: fs.open, stat: fs.stat };
const record = '9222\n/devtools/browser/owned-browser\n';
const endpoint = 'ws://127.0.0.1:9222/devtools/browser/owned-browser';
const child = { exitCode: null, signalCode: null };
const childState = { spawnError: null };
let profile;
let portFile;
let opened;
let afterCheck;
let prepareHandle;

beforeEach(async () => {
  profile = await fs.mkdtemp(join(tmpdir(), 'yt-devtools-endpoint-'));
  portFile = join(profile, 'DevToolsActivePort');
  opened = [];
  afterCheck = async () => {};
  prepareHandle = () => {};
  // Intercept both the former path check and the descriptor check for regression proof.
  mock.method(fs, 'stat', async (...args) => {
    const metadata = await actualFs.stat(...args);
    await afterCheck();
    return metadata;
  });
  mock.method(fs, 'open', async (...args) => {
    const handle = await actualFs.open(...args);
    opened.push(handle);
    const stat = handle.stat.bind(handle);
    mock.method(handle, 'stat', async () => {
      const metadata = await stat();
      await afterCheck();
      return metadata;
    });
    prepareHandle(handle);
    return handle;
  });
  syncBuiltinESMExports();
});

afterEach(async () => {
  try {
    for (const handle of opened) assert.equal(handle.fd, -1, 'File handle leaked');
  } finally {
    await Promise.all(opened.map((handle) => handle.close()));
    mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(profile, { recursive: true, force: true });
  }
});

for (const [name, contents] of [
  ['LF', record],
  ['CRLF', record.replaceAll('\n', '\r\n')],
  ['maximum size', record.padEnd(4096, ' ')],
]) {
  test(`accepts a valid bounded record: ${name}`, async () => {
    await fs.writeFile(portFile, contents);
    assert.equal(await readDevToolsEndpoint(profile, child, childState), endpoint);
  });
}

test('reads the checked file even if its pathname is replaced', async () => {
  await fs.writeFile(portFile, record);
  afterCheck = async () => {
    await fs.rename(portFile, join(profile, 'original-port'));
    await fs.writeFile(portFile, '9333\n/devtools/browser/replacement\n');
  };
  assert.equal(await readDevToolsEndpoint(profile, child, childState), endpoint);
  assert.match(await fs.readFile(portFile, 'utf8'), /replacement/u);
});

test('rejects a file that grows beyond the limit after the check', async () => {
  await fs.writeFile(portFile, record);
  afterCheck = () => fs.appendFile(portFile, ' '.repeat(8192));
  await assert.rejects(readDevToolsEndpoint(profile, child, childState), /invalid file shape/u);
});

test('handles short reads without truncating the record', async () => {
  await fs.writeFile(portFile, record);
  prepareHandle = (handle) => {
    const read = handle.read.bind(handle);
    mock.method(handle, 'read', (buffer, offset, length, position) =>
      read(buffer, offset, Math.min(length, 2), position));
  };
  assert.equal(await readDevToolsEndpoint(profile, child, childState), endpoint);
});

test('closes the handle and preserves a read error', async () => {
  await fs.writeFile(portFile, record);
  const failure = Object.assign(new Error('read failed'), { code: 'EIO' });
  prepareHandle = (handle) => {
    mock.method(handle, 'read', async () => { throw failure; });
  };
  await assert.rejects(readDevToolsEndpoint(profile, child, childState), (error) => error === failure);
});

for (const [name, contents] of [
  ['empty', ''],
  ['oversized', record.padEnd(4097, ' ')],
  ['zero port', '0\n/devtools/browser/id'],
  ['large port', '65536\n/devtools/browser/id'],
  ['remote endpoint', '9222\nws://remote.example/devtools/browser/id'],
  ['query', '9222\n/devtools/browser/id?query'],
  ['extra record', `${record}extra`],
]) {
  test(`rejects invalid endpoint contents: ${name}`, async () => {
    await fs.writeFile(portFile, contents);
    await assert.rejects(readDevToolsEndpoint(profile, child, childState));
  });
}

test('rejects a directory', async () => {
  await fs.mkdir(portFile);
  await assert.rejects(readDevToolsEndpoint(profile, child, childState));
});

test('waits for a missing file to be created', async () => {
  const sleep = mock.fn(async () => { await fs.writeFile(portFile, record); });
  assert.equal(await readDevToolsEndpoint(profile, child, childState, { sleep }), endpoint);
  assert.equal(sleep.mock.callCount(), 1);
  assert.deepEqual(sleep.mock.calls[0].arguments, [100]);
});

test('preserves spawn and child-exit errors', async () => {
  const spawnError = new Error('spawn failed');
  await assert.rejects(readDevToolsEndpoint(profile, child, { spawnError }),
    (error) => error === spawnError);
  await assert.rejects(readDevToolsEndpoint(profile, { ...child, exitCode: 1 }, childState),
    /exited before/u);
  assert.equal(fs.open.mock.callCount(), 0);
});
