// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Portable Windows acceptance runtime is intentionally plain ESM.
import * as upgrade from '../../../validation/windows/release-upgrade/upgrade.mjs';

const roots: string[] = [];
const baselineVersion = '0.45.5';
const candidateVersion = '0.45.6';
const assetUrl =
  'https://github.com/PiesP/yt-live-chat-overlay/releases/download/v0.45.5/yt-live-chat-overlay.user.js';
const metadata = (version: string, unsafeWindow: boolean) => `// ==UserScript==
// @name         YouTube Live Chat Overlay
// @namespace    https://github.com/PiesP
// @version      ${version}
// @updateURL    https://github.com/PiesP/yt-live-chat-overlay/releases/latest/download/yt-live-chat-overlay.meta.js
// @downloadURL  https://github.com/PiesP/yt-live-chat-overlay/releases/download/v${version}/yt-live-chat-overlay.user.js
// @grant        GM_getValue
${unsafeWindow ? '// @grant        unsafeWindow\n' : ''}// ==/UserScript==
console.log('fixture');
`;

async function fixture(
  overrides: { baseline?: string; candidate?: string; input?: Record<string, unknown> } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'yt-upgrade-input-test-'));
  roots.push(root);
  const directory = join(root, 'validation/windows/release-upgrade');
  await mkdir(directory, { recursive: true });
  await mkdir(join(root, 'dist'));
  const baseline = overrides.baseline ?? metadata(baselineVersion, false);
  const candidate = overrides.candidate ?? metadata(candidateVersion, true);
  const input = overrides.input ?? {
    schemaVersion: 1,
    baselineSha256: upgrade.sha256(Buffer.from(baseline)),
    candidateVersion,
    publishedAssetUrl: assetUrl,
  };
  await writeFile(join(directory, 'input.json'), JSON.stringify(input));
  await writeFile(join(directory, 'public-v0.45.5.user.js'), baseline);
  await writeFile(join(root, 'dist/yt-live-chat-overlay.user.js'), candidate);
  return { root, directory };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('installed manager upgrade inputs', () => {
  it('keeps the ordinary fresh install when no upgrade input exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yt-fresh-input-test-'));
    roots.push(root);
    expect(await upgrade.loadUpgradeInputs(root)).toBeNull();
  });

  it('accepts fixed public and candidate paths with byte hashes and matching identity', async () => {
    const { root } = await fixture();
    const inputs = await upgrade.loadUpgradeInputs(root);
    expect(inputs.baseline.version).toBe(baselineVersion);
    expect(inputs.candidate.version).toBe(candidateVersion);
    expect(inputs.candidate.grants).toContain('unsafeWindow');
    expect(inputs.baselineSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(inputs.candidateSha256).not.toBe(inputs.baselineSha256);
  });

  it('rejects an unknown field, wrong public URL, wrong version and missing baseline digest', () => {
    const valid = {
      schemaVersion: 1,
      baselineSha256: 'a'.repeat(64),
      candidateVersion,
      publishedAssetUrl: assetUrl,
    };
    for (const input of [
      { ...valid, path: '../other.user.js' },
      { ...valid, publishedAssetUrl: 'https://example.com/other.user.js' },
      { ...valid, candidateVersion: baselineVersion },
      { ...valid, baselineSha256: '' },
      { ...valid, schemaVersion: 2 },
    ]) {
      expect(() => upgrade.validateUpgradeInput(input)).toThrow();
    }
  });

  it('rejects public bytes that differ from the published digest and a symlinked baseline', async () => {
    const badDigest = await fixture({
      input: {
        schemaVersion: 1,
        baselineSha256: 'a'.repeat(64),
        candidateVersion,
        publishedAssetUrl: assetUrl,
      },
    });
    await expect(upgrade.loadUpgradeInputs(badDigest.root)).rejects.toThrow('SHA-256 differs');
    const linked = await fixture();
    await rm(join(linked.directory, 'public-v0.45.5.user.js'));
    await symlink(
      join(badDigest.directory, 'public-v0.45.5.user.js'),
      join(linked.directory, 'public-v0.45.5.user.js')
    );
    await expect(upgrade.loadUpgradeInputs(linked.root)).rejects.toThrow('Invalid upgrade file');
  });

  it('rejects an old candidate version, missing grant and changed script identity', async () => {
    for (const candidate of [
      metadata(baselineVersion, true),
      metadata(candidateVersion, false),
      metadata(candidateVersion, true).replace('YouTube Live Chat Overlay', 'Other Script'),
      metadata(candidateVersion, true).replace(
        'https://github.com/PiesP\n',
        'https://example.com\n'
      ),
    ]) {
      const { root } = await fixture({ candidate });
      await expect(upgrade.loadUpgradeInputs(root)).rejects.toThrow();
    }
  });

  it('requires one displayed version and retained nondefault settings', () => {
    const row = '1  YouTube Live Chat Overlay  0.45.6  946 KB';
    expect(upgrade.requireInstalledScriptRow([row], candidateVersion).version).toBe(
      candidateVersion
    );
    expect(() => upgrade.requireInstalledScriptRow([row, row], candidateVersion)).toThrow();
    expect(() => upgrade.requireInstalledScriptRow([row], baselineVersion)).toThrow();
    const before = { fontSize: '36', opacity: '65', safeTop: '20' };
    expect(upgrade.requireRetainedSettings(before, { ...before })).toEqual(before);
    expect(() => upgrade.requireRetainedSettings(before, { ...before, opacity: '100' })).toThrow();
  });
});
