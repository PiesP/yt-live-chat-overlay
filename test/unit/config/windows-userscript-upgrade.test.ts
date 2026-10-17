// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

// @ts-expect-error Portable Windows acceptance runtime is intentionally plain ESM.
import * as chromeInstall from '../../../validation/windows/chrome-install.mjs';
import * as upgrade from '../../../validation/windows/release-upgrade/upgrade.ts';

const roots: string[] = [];
const baselineVersion = '0.45.6';
const candidateVersion = '0.45.7';
const assetUrl =
  'https://github.com/PiesP/yt-live-chat-overlay/releases/download/v0.45.6/yt-live-chat-overlay.user.js';
const candidateDownloadUrl =
  'https://github.com/PiesP/yt-live-chat-overlay/releases/latest/download/yt-live-chat-overlay.user.js';
const metadata = (version: string, unsafeWindow: boolean, downloadUrl: string) => `// ==UserScript==
// @name         YouTube Live Chat Overlay
// @namespace    https://github.com/PiesP
// @version      ${version}
// @updateURL    https://github.com/PiesP/yt-live-chat-overlay/releases/latest/download/yt-live-chat-overlay.meta.js
// @downloadURL  ${downloadUrl}
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
  const baseline = overrides.baseline ?? metadata(baselineVersion, true, assetUrl);
  const candidate = overrides.candidate ?? metadata(candidateVersion, true, candidateDownloadUrl);
  const input = overrides.input ?? {
    schemaVersion: 1,
    baselineSha256: upgrade.sha256(Buffer.from(baseline)),
    candidateVersion,
    publishedAssetUrl: assetUrl,
  };
  await writeFile(join(directory, 'input.json'), JSON.stringify(input));
  await writeFile(join(directory, 'public-v0.45.6.user.js'), baseline);
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
    if (!inputs) throw new Error('Upgrade input fixture was not loaded');
    expect(inputs.baseline.version).toBe(baselineVersion);
    expect(inputs.candidate.version).toBe(candidateVersion);
    expect(inputs.candidate.grants).toContain('unsafeWindow');
    expect(inputs.baselineSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(inputs.candidateSha256).not.toBe(inputs.baselineSha256);
    expect(inputs.baseline.downloadUrl).toBe(assetUrl);
    expect(inputs.candidate.downloadUrl).toBe(candidateDownloadUrl);
  });

  it('rejects a changed public URL and versioned or unrelated candidate download URLs', async () => {
    for (const overrides of [
      { baseline: metadata(baselineVersion, true, candidateDownloadUrl) },
      {
        candidate: metadata(
          candidateVersion,
          true,
          `https://github.com/PiesP/yt-live-chat-overlay/releases/download/v${candidateVersion}/yt-live-chat-overlay.user.js`
        ),
      },
      { candidate: metadata(candidateVersion, true, 'https://example.com/other.user.js') },
    ]) {
      const { root } = await fixture(overrides);
      await expect(upgrade.loadUpgradeInputs(root)).rejects.toThrow('download URL changed');
    }
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
    await rm(join(linked.directory, 'public-v0.45.6.user.js'));
    await symlink(
      join(badDigest.directory, 'public-v0.45.6.user.js'),
      join(linked.directory, 'public-v0.45.6.user.js')
    );
    await expect(upgrade.loadUpgradeInputs(linked.root)).rejects.toThrow('Invalid upgrade file');
  });

  it('rejects a dangling input symlink instead of treating it as absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yt-dangling-input-test-'));
    roots.push(root);
    const directory = join(root, 'validation/windows/release-upgrade');
    await mkdir(directory, { recursive: true });
    await symlink(join(root, 'missing-input.json'), join(directory, 'input.json'));
    await expect(upgrade.loadUpgradeInputs(root)).rejects.toThrow('Invalid upgrade file');
  });

  it('rejects oversized input and candidate files before reading them', async () => {
    const oversizedInput = await fixture();
    await truncate(join(oversizedInput.directory, 'input.json'), 16 * 1024 * 1024 + 1);
    await expect(upgrade.loadUpgradeInputs(oversizedInput.root)).rejects.toThrow(
      'Upgrade file size rejected'
    );

    const oversizedCandidate = await fixture();
    await truncate(
      join(oversizedCandidate.root, 'dist/yt-live-chat-overlay.user.js'),
      16 * 1024 * 1024 + 1
    );
    await expect(upgrade.loadUpgradeInputs(oversizedCandidate.root)).rejects.toThrow(
      'Upgrade file size rejected'
    );
  });

  it('rejects an old candidate version, missing grant and changed script identity', async () => {
    for (const candidate of [
      metadata(baselineVersion, true, candidateDownloadUrl),
      metadata(candidateVersion, false, candidateDownloadUrl),
      metadata(candidateVersion, true, candidateDownloadUrl).replace(
        'YouTube Live Chat Overlay',
        'Other Script'
      ),
      metadata(candidateVersion, true, candidateDownloadUrl).replace(
        'https://github.com/PiesP\n',
        'https://example.com\n'
      ),
    ]) {
      const { root } = await fixture({ candidate });
      await expect(upgrade.loadUpgradeInputs(root)).rejects.toThrow();
    }
  });

  it('requires one displayed version and retained nondefault settings', () => {
    const row = '1  YouTube Live Chat Overlay  0.45.7  946 KB';
    expect(upgrade.requireInstalledScriptRow([row], candidateVersion).version).toBe(
      candidateVersion
    );
    expect(() => upgrade.requireInstalledScriptRow([row, row], candidateVersion)).toThrow();
    expect(() => upgrade.requireInstalledScriptRow([row], baselineVersion)).toThrow();
    const before = { fontSize: '36', opacity: '65', safeTop: '20' };
    expect(upgrade.requireRetainedSettings(before, { ...before })).toEqual(before);
    const displayed = { ...before, safeTop: '20.0' };
    expect(upgrade.requireRetainedSettings(displayed, before)).toEqual(before);
    expect(() => upgrade.requireRetainedSettings(before, { ...before, safeTop: '20.1' })).toThrow();
    expect(() => upgrade.requireRetainedSettings(before, { ...before, opacity: '100' })).toThrow();
  });

  it('requires all three persisted settings in a fresh UI readback', () => {
    const expected = { fontSize: '36', opacity: '65', safeTop: '20' };
    expect(upgrade.matchesStoredSettings({ ...expected, safeTop: '20.0' }, expected)).toBe(true);
    expect(upgrade.matchesStoredSettings({ ...expected, fontSize: '32' }, expected)).toBe(false);
    expect(upgrade.matchesStoredSettings({ ...expected, opacity: '' }, expected)).toBe(false);
    expect(upgrade.matchesStoredSettings({ ...expected, safeTop: 'NaN' }, expected)).toBe(false);
  });

  it('keeps the deferred update receipt after the later approval', () => {
    let prompt: ReturnType<typeof upgrade.appendPromptEvent> = {
      status: 'unobserved',
      deferred: false,
      approved: false,
      events: [],
    };
    expect(() =>
      upgrade.appendPromptEvent(prompt, { kind: 'approved', decision: 'approve' })
    ).toThrow('observed prompt');
    for (const event of [
      { kind: 'observed', decision: 'defer' },
      { kind: 'deferred', decision: 'defer' },
      { kind: 'observed', decision: 'approve' },
      { kind: 'approved', decision: 'approve' },
    ]) {
      prompt = upgrade.appendPromptEvent(prompt, event);
    }
    expect(prompt).toMatchObject({ status: 'observed', deferred: true, approved: true });
    expect(prompt.events).toHaveLength(4);
    expect(prompt.events[1]).toEqual({ kind: 'deferred', decision: 'defer' });
  });

  it('does not mistake source code or a generic update prompt for a grant display', () => {
    const row = { index: 0, visible: true, inSourceEditor: false, className: '', text: '' };
    expect(upgrade.classifyManagerGrantRows([{ ...row, text: 'Userscript update' }]).status).toBe(
      'not-observed'
    );
    expect(
      upgrade.classifyManagerGrantRows([
        { ...row, text: '// @grant unsafeWindow', inSourceEditor: true },
      ]).status
    ).toBe('not-observed');
    expect(
      upgrade.classifyManagerGrantRows([{ ...row, text: '// @grant unsafeWindow' }]).status
    ).toBe('not-observed');
    expect(
      upgrade.classifyManagerGrantRows([{ ...row, text: 'Grant: unsafeWindow', visible: false }])
        .status
    ).toBe('not-observed');
    expect(upgrade.classifyManagerGrantRows([{ ...row, text: 'Grant: unsafeWindow' }])).toEqual({
      status: 'observed',
      rowIndex: 0,
      visibleText: 'Grant: unsafeWindow',
    });
  });

  it('requires sustained page-fetch callbacks rather than only six initial polling messages', () => {
    const pollingOnly = {
      checks: { installedApplicationDelivery: true, sustainedViewingLifecycle: true },
      observations: { initialAdmission: { accessibility: { count: 6 } } },
    };
    expect(() => chromeInstall.requireInstalledPageFetchEvidence(pollingOnly)).toThrow();
    const ingress = [
      'windows-sustained-low-1',
      'windows-sustained-low-2',
      ...Array.from({ length: 8 }, (_, index) => `windows-sustained-burst-${index + 1}`),
      'windows-sustained-paused-1',
      'windows-sustained-paused-2',
      'windows-sustained-visible',
    ];
    const fixtureEvidence = {
      checks: { sustainedViewingLifecycle: true },
      observations: {
        sustainedViewing: {
          firstSessionIngressIds: ingress,
          firstSessionAccessibleIds: ingress,
          secondSessionIds: ['windows-sustained-second-video'],
          hiddenMessageSuppressed: true,
          oldCanvasDetached: true,
          videoPauseDropDelta: 2,
        },
      },
    };
    expect(chromeInstall.requireInstalledPageFetchEvidence(fixtureEvidence)).toMatchObject({
      callbackAssertionsCompleted: true,
      callbackPhases: ['low-1', 'low-2', 'burst', 'paused', 'hidden', 'visible', 'second-video'],
    });
    expect(() =>
      chromeInstall.requireInstalledPageFetchEvidence({
        ...fixtureEvidence,
        checks: { sustainedViewingLifecycle: false },
      })
    ).toThrow();
  });
});
