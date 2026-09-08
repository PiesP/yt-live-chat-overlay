// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Portable Windows acceptance runtime is intentionally plain ESM.
import { cleanupChromeInstallation, requireLiveSuccess } from '../../../validation/windows/chrome-install.mjs';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'yt-chrome-profile-test-'));
  roots.push(root);
  const profile = join(root, 'chrome-install-owned');
  const output = join(root, 'output');
  await mkdir(profile);
  await mkdir(output);
  await writeFile(join(root, 'keep'), 'unrelated fixture');
  return { root, profile, output };
}

describe('installed Chrome acceptance outcomes', () => {
  it('rejects a loaded page that did not render the installed application', () => {
    expect(() => requireLiveSuccess([{ status: 'unverified', canvasAttached: false }])).toThrow();
    expect(() => requireLiveSuccess([{ status: 'passed', canvasAttached: true, renderedMessages: 0 }])).toThrow();
    expect(() => requireLiveSuccess([{ status: 'passed', canvasAttached: true, renderedMessages: 1 }])).not.toThrow();
  });

  it('still closes the browser and removes its profile when uninstall fails', async () => {
    const paths = await fixture();
    const close = vi.fn(async () => {});
    const result = { cleanup: {} };
    await expect(cleanupChromeInstallation({
      context: { close }, cdp: { send: async () => { throw new Error('uninstall failed'); } },
      extensionId: 'owned', ...paths, result,
    })).rejects.toThrow(AggregateError);
    expect(close).toHaveBeenCalledOnce();
    await expect(stat(paths.profile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(paths.root, 'keep'), 'utf8')).toBe('unrelated fixture');
    const evidence = JSON.parse(await readFile(join(paths.output, 'installation-result.json'), 'utf8'));
    expect(evidence.cleanup).toMatchObject({ browserClosed: true, profileRemoved: true, errorCount: 1 });
  });

  it('attempts the owned browser fallback and profile removal after context close fails', async () => {
    const paths = await fixture();
    const browserClose = vi.fn(async () => {});
    await expect(cleanupChromeInstallation({
      context: { close: async () => { throw new Error('context failed'); }, browser: () => ({ close: browserClose }) },
      cdp: null, extensionId: null, ...paths, result: { cleanup: {} },
    })).rejects.toThrow(AggregateError);
    expect(browserClose).toHaveBeenCalledOnce();
    await expect(stat(paths.profile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
