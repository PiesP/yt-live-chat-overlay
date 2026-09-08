// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Portable Windows acceptance runtime is intentionally plain ESM.
import * as chromeInstallModule from '../../../validation/windows/chrome-install.mjs';
// @ts-expect-error Portable Windows acceptance runtime is intentionally plain ESM.
import * as liveRenderingModule from '../../../validation/windows/live-rendering.mjs';

const { cleanupChromeInstallation, readOwnedBrowserProcessId, requireLiveSuccess } =
  chromeInstallModule;

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
  it('requires an observed page-policy restriction before accepting extension main rendering', () => {
    const { validateLiveRenderer, countUnexpectedLiveErrors } = liveRenderingModule;
    const blocked = { type: 'error', text: "This document requires 'TrustedScriptURL' assignment. The action has been blocked." };
    expect(validateLiveRenderer('worker', 'extension', [], true)).toEqual({ renderer: 'worker', workerPolicyFallback: false });
    expect(validateLiveRenderer('main', 'extension', [blocked], true))
      .toEqual({ renderer: 'main', workerPolicyFallback: true });
    expect(() => validateLiveRenderer('main', 'extension', [], true)).toThrow();
    expect(() => validateLiveRenderer('main', 'extension', [blocked], false)).toThrow();
    expect(() => validateLiveRenderer('main', 'extension', [{ ...blocked, type: 'info' }], true)).toThrow();
    expect(() => validateLiveRenderer('unknown', 'extension', [blocked], true)).toThrow();
    expect(countUnexpectedLiveErrors([blocked], true)).toBe(0);
    expect(countUnexpectedLiveErrors([blocked], false)).toBe(1);
    expect(countUnexpectedLiveErrors([blocked, { type: 'error', text: 'app crashed' }], true)).toBe(1);
  });
  it('rejects a loaded page that did not render the installed application', () => {
    expect(() => requireLiveSuccess([{ status: 'unverified', canvasAttached: false }])).toThrow();
    expect(() => requireLiveSuccess([{ status: 'passed', canvasAttached: true, renderedMessages: 0 }])).toThrow();
    expect(() => requireLiveSuccess([{ status: 'passed', canvasAttached: true, renderedMessages: 1 }])).not.toThrow();
    expect(() => requireLiveSuccess([{ status: 'passed', canvasAttached: true, renderedMessages: 1, pageErrorTypes: ['TypeError'] }])).toThrow();
    expect(() => requireLiveSuccess([{ status: 'passed', canvasAttached: true, renderedMessages: 1, unexpectedConsoleErrors: 1 }])).toThrow();
  });
  it('separates only named native YouTube failures and removes signed URL queries', () => {
    const { isYouTubeHostError, countUnexpectedLiveErrors, redactDiagnosticText } = liveRenderingModule;
    const prefix = 'Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at ';
    const host = { level: 'error', text: prefix + 'https://rr1.googlevideo.com/videoplayback?sig=private' };
    expect(isYouTubeHostError(host)).toBe(true);
    expect(isYouTubeHostError({ ...host, text: prefix + 'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat' })).toBe(false);
    expect(isYouTubeHostError({ ...host, text: prefix + 'https://googlevideo.com.attacker.example/videoplayback' })).toBe(false);
    expect(countUnexpectedLiveErrors([host, { level: 'error', text: '[Youtubei] app failed' }], false)).toBe(1);
    expect(redactDiagnosticText(host.text)).not.toContain('sig=');
  });

  it('accepts one exact browser process identity from the browser CDP session', () => {
    expect(readOwnedBrowserProcessId({
      processInfo: [
        { id: 123, type: 'renderer' },
        { id: 456, type: 'browser' },
      ],
    })).toBe(456);
    expect(() => readOwnedBrowserProcessId({ processInfo: [] })).toThrow();
    expect(() => readOwnedBrowserProcessId({
      processInfo: [{ id: 1, type: 'browser' }, { id: 2, type: 'browser' }],
    })).toThrow();
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

  it('terminates only the retained browser tree when both Playwright closes fail', async () => {
    const paths = await fixture();
    const terminateProcessTree = vi.fn(async () => {});
    const checkProcessAlive = vi.fn().mockResolvedValue(true);
    await expect(cleanupChromeInstallation({
      browserProcessId: 456,
      context: {
        close: async () => { throw new Error('context failed'); },
        browser: () => ({ close: async () => { throw new Error('browser failed'); } }),
      },
      cdp: null,
      extensionId: null,
      ...paths,
      result: { cleanup: {} },
      root: paths.root,
    }, {
      checkProcessAlive,
      terminateProcessTree,
      waitForExit: vi.fn().mockResolvedValue(true),
    })).rejects.toThrow(AggregateError);

    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(terminateProcessTree).toHaveBeenCalledWith(456);
    await expect(stat(paths.profile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves the owned profile when browser-tree termination cannot be proven', async () => {
    const paths = await fixture();
    const terminateProcessTree = vi.fn(async () => { throw new Error('tree remains'); });
    const result = { cleanup: {} };
    await expect(cleanupChromeInstallation({
      browserProcessId: 789,
      context: {
        close: async () => { throw new Error('context failed'); },
        browser: () => ({ close: async () => { throw new Error('browser failed'); } }),
      },
      cdp: null,
      extensionId: null,
      ...paths,
      result,
      root: paths.root,
    }, {
      checkProcessAlive: vi.fn().mockResolvedValue(true),
      terminateProcessTree,
      waitForExit: vi.fn().mockResolvedValue(false),
    })).rejects.toThrow(AggregateError);

    expect(terminateProcessTree).toHaveBeenCalledWith(789);
    expect(await stat(paths.profile)).toBeDefined();
    expect(result.cleanup).toMatchObject({ profilePreserved: true, browserProcessExited: false });
    const evidence = JSON.parse(
      await readFile(join(paths.output, 'installation-result.json'), 'utf8')
    );
    expect(evidence.cleanup).toMatchObject({
      browserProcessExited: false,
      profilePreserved: true,
    });
  });
});
