// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  extensionInventory,
  readExtensionStoredFontSize,
  readExtensionUpgradeInput,
  validateExtensionUpgradeInput,
  verifyExtensionZip,
} from '../../../validation/windows/release-upgrade/extension.ts';

const INPUT = 'validation/windows/release-upgrade/extension-input.json';
const PUBLIC = 'validation/windows/release-upgrade/public-v0.45.7-chrome';
const URL =
  'https://github.com/PiesP/yt-live-chat-overlay/releases/download/v0.45.7/yt-live-chat-overlay-chrome.zip';
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
const roots: string[] = [];

function sha(bytes: string | Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Small store-only ZIP with the same fixed file and directory layout as the public asset. */
function archive(files: Record<string, Buffer>, replacement?: { name: string; bytes: Buffer }) {
  const names = ['icons/', 'workers/', ...FILES];
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const file = replacement?.name === name ? replacement.bytes : (files[name] ?? Buffer.alloc(0));
    const bytes = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(file.length, 18);
    header.writeUInt32LE(file.length, 22);
    header.writeUInt16LE(bytes.length, 26);
    local.push(header, bytes, file);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(file.length, 20);
    directory.writeUInt32LE(file.length, 24);
    directory.writeUInt16LE(bytes.length, 28);
    directory.writeUInt32LE((name.endsWith('/') ? 0x4000 : 0x8000) * 65536, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, bytes);
    offset += header.length + bytes.length + file.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'yt-extension-upgrade-'));
  roots.push(root);
  const baseline = join(root, PUBLIC, 'unpacked');
  const candidate = join(root, 'dist-extension');
  for (const directory of [baseline, candidate]) {
    await mkdir(join(directory, 'icons'), { recursive: true });
    await mkdir(join(directory, 'workers'), { recursive: true });
  }
  const files: Record<string, Buffer> = {};
  for (const name of FILES) {
    const previous =
      name === 'manifest.json'
        ? JSON.stringify({
            manifest_version: 3,
            name: 'YouTube Live Chat Overlay',
            version: '0.45.7',
          })
        : `public-${name}`;
    const next =
      name === 'manifest.json'
        ? JSON.stringify({
            manifest_version: 3,
            name: 'YouTube Live Chat Overlay',
            version: '0.45.8',
          })
        : `candidate-${name}`;
    files[name] = Buffer.from(previous);
    await writeFile(join(baseline, name), previous);
    await writeFile(join(candidate, name), next);
  }
  const zip = archive(files);
  const baselineInventory = await extensionInventory(baseline);
  const candidateInventory = await extensionInventory(candidate);
  const input = {
    schemaVersion: 1,
    previousVersion: '0.45.7',
    candidateVersion: '0.45.8',
    publicAssetUrl: URL,
    publicArchive: { path: `${PUBLIC}/artifact.zip`, sha256: sha(zip) },
    previousExtension: { path: `${PUBLIC}/unpacked`, inventorySha256: baselineInventory.sha256 },
    candidateExtension: { inventorySha256: candidateInventory.sha256 },
  };
  await writeFile(join(root, PUBLIC, 'artifact.zip'), zip);
  await writeFile(join(root, INPUT), JSON.stringify(input));
  return { root, baseline, candidate, files, input, zip };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('optional public Chrome extension update inputs', () => {
  it('stays optional and pins both exact inventories to the public ZIP bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yt-extension-no-input-'));
    roots.push(root);
    expect(await readExtensionUpgradeInput(root)).toBeNull();
    const fixture = await makeFixture();
    const checked = await readExtensionUpgradeInput(fixture.root);
    expect(checked?.input.publicAssetUrl).toBe(URL);
    expect(checked?.baseline.files['manifest.json']).toBe(sha(fixture.files['manifest.json']!));
    expect(Object.keys(checked?.candidate.files ?? {})).toHaveLength(8);
  });

  it('rejects unapproved identity fields and changed versions', async () => {
    const fixture = await makeFixture();
    expect(() =>
      validateExtensionUpgradeInput({ ...fixture.input, previousUserscript: {} })
    ).toThrow();
    expect(() =>
      validateExtensionUpgradeInput({
        ...fixture.input,
        publicAssetUrl: URL.replace('v0.45.7', 'latest'),
      })
    ).toThrow();
    expect(() =>
      validateExtensionUpgradeInput({ ...fixture.input, previousVersion: '0.45.6' })
    ).toThrow();
    expect(() =>
      validateExtensionUpgradeInput({
        ...fixture.input,
        publicArchive: { ...fixture.input.publicArchive, path: '../artifact.zip' },
      })
    ).toThrow();
  });

  it('rejects mismatched ZIP bytes even when the claimed ZIP digest is updated', async () => {
    const fixture = await makeFixture();
    const altered = archive(fixture.files, {
      name: 'page-script.js',
      bytes: Buffer.from('different'),
    });
    await writeFile(join(fixture.root, PUBLIC, 'artifact.zip'), altered);
    await writeFile(
      join(fixture.root, INPUT),
      JSON.stringify({
        ...fixture.input,
        publicArchive: { ...fixture.input.publicArchive, sha256: sha(altered) },
      })
    );
    await expect(readExtensionUpgradeInput(fixture.root)).rejects.toThrow(
      'Published ZIP and unpacked extension bytes differ'
    );
  });

  it('rejects an extra file or a candidate manifest with the wrong version', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.baseline, 'unexpected.js'), 'x');
    await expect(extensionInventory(fixture.baseline)).rejects.toThrow('Unexpected extension root');
    await rm(join(fixture.baseline, 'unexpected.js'));
    await writeFile(join(fixture.candidate, 'manifest.json'), fixture.files['manifest.json']!);
    const changed = await extensionInventory(fixture.candidate);
    await writeFile(
      join(fixture.root, INPUT),
      JSON.stringify({
        ...fixture.input,
        candidateExtension: { inventorySha256: changed.sha256 },
      })
    );
    await expect(readExtensionUpgradeInput(fixture.root)).rejects.toThrow();
  });

  it('rejects a symlinked parent of the public input tree', async () => {
    if (process.platform === 'win32') return;
    const fixture = await makeFixture();
    const publicPath = join(fixture.root, PUBLIC);
    const moved = join(fixture.root, 'moved-public-input');
    await rename(publicPath, moved);
    await symlink(moved, publicPath);
    await expect(readExtensionUpgradeInput(fixture.root)).rejects.toThrow(
      'Extension input parent is not ordinary'
    );
  });

  it('rejects unapproved or traversing ZIP members', async () => {
    const fixture = await makeFixture();
    const inventory = await extensionInventory(fixture.baseline);
    verifyExtensionZip(fixture.zip, inventory);
    const unapproved = Buffer.from(fixture.zip);
    const central = unapproved.readUInt32LE(unapproved.length - 22 + 16);
    const first = central + 46;
    unapproved.write('other/', first, 'ascii');
    expect(() => verifyExtensionZip(unapproved, inventory)).toThrow();
    const traversal = Buffer.from(fixture.zip);
    traversal.write('../', first, 'ascii');
    expect(() => verifyExtensionZip(traversal, inventory)).toThrow();
  });

  it('rejects high-bit ZIP filename bytes even when the ZIP digest is re-pinned', async () => {
    const fixture = await makeFixture();
    const altered = Buffer.from(fixture.zip);
    const central = altered.readUInt32LE(altered.length - 22 + 16);
    const local = altered.readUInt32LE(central + 42);
    altered[central + 46] = altered[central + 46]! | 0x80;
    altered[local + 30] = altered[local + 30]! | 0x80;
    await writeFile(join(fixture.root, PUBLIC, 'artifact.zip'), altered);
    await writeFile(
      join(fixture.root, INPUT),
      JSON.stringify({
        ...fixture.input,
        publicArchive: { ...fixture.input.publicArchive, sha256: sha(altered) },
      })
    );
    await expect(readExtensionUpgradeInput(fixture.root)).rejects.toThrow(
      'ZIP filename is not ASCII'
    );
  });

  it('includes the native CDP import in the Windows bundle and ignores private inputs', async () => {
    const profile = JSON.parse(await readFile('validation/windows/profile.json', 'utf8')) as {
      installation: { assets: string[] };
    };
    expect(profile.installation.assets).toContain(
      'validation/windows/chromium-network-diagnostics.ts'
    );
    expect(profile.installation.assets).toContain('validation/windows/release-upgrade');
    const ignore = await readFile('.gitignore', 'utf8');
    expect(ignore).toContain('/validation/windows/release-upgrade/extension-input.json');
    expect(ignore).toContain('/validation/windows/release-upgrade/public-v0.45.7-chrome/');
  });

  it('reads only the saved font size from the extension storage JSON string', async () => {
    let stored: unknown = JSON.stringify({ fontSize: 36, privateValue: 'never-export' });
    vi.stubGlobal('chrome', {
      storage: { local: { get: async (key: string) => ({ [key]: stored }) } },
    });
    const page = {
      evaluate: async (fn: (key: string) => Promise<number | null>, key: string) => fn(key),
    } as unknown as Page;
    expect(await readExtensionStoredFontSize(page)).toBe(36);
    stored = { fontSize: 36 };
    expect(await readExtensionStoredFontSize(page)).toBeNull();
    stored = '{private';
    expect(await readExtensionStoredFontSize(page)).toBeNull();
  });
});
