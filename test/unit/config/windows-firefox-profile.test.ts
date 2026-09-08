// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error The Windows acceptance runtime is intentionally plain ESM for portable Node.
import * as firefoxInstallModule from '../../../validation/windows/firefox-install.mjs';
// @ts-expect-error The Windows acceptance runtime is intentionally plain ESM for portable Node.
import * as firefoxBidiModule from '../../../validation/windows/firefox-bidi.mjs';

const {
  categorizeErrors,
  normalizeLiveUrls,
  resolveSystemFirefoxExecutable,
  runFirefoxInstallation,
} = firefoxInstallModule;
const { buildFirefoxLaunchArguments, extensionInstallParameters, extensionUninstallParameters } =
  firefoxBidiModule;

const temporaryDirectories: string[] = [];

async function createBundle(): Promise<{ output: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'yt-firefox-profile-test-'));
  temporaryDirectories.push(root);
  const output = join(root, 'output');
  await mkdir(join(root, 'dist-extension-firefox'), { recursive: true });
  await writeFile(join(root, 'dist-extension-firefox', 'manifest.json'), '{}');
  return { output, root };
}

function createSession(options: { failStartup?: boolean } = {}) {
  const calls: string[] = [];
  const pageLogs: Array<{ level: string; text: string; type: string }> = [];
  const pageErrors: Array<{ level: string; text: string; type: string }> = [];
  let evaluateIndex = 0;
  const session = {
    browserName: 'Firefox',
    browserVersion: '155.0.1',
    platformName: 'windows',
    pageErrors,
    pageLogs,
    captureScreenshot: vi.fn(async () => Buffer.from('screenshot')),
    clearPageLogs: vi.fn(() => {
      pageLogs.length = 0;
      calls.push('clear-logs');
    }),
    close: vi.fn(async () => {
      calls.push('close');
    }),
    evaluateJson: vi.fn(async () => {
      evaluateIndex++;
      if (options.failStartup && evaluateIndex === 1) throw new Error('fixture startup failed');
      switch (evaluateIndex) {
        case 1:
          return {
            canvasAriaHidden: 'true',
            pageScriptCount: 1,
            storageType: 'chrome.storage.local',
            workerSupported: true,
            workerUrlValid: true,
          };
        case 2:
          return { advancedTabSelected: 'true', modalOpen: true };
        case 3:
          return { accessibleMessageCount: 1, persisted: true };
        case 4:
          return 1;
        case 7:
          return {
            canvasCount: 1,
            overlayCount: 1,
            pageScriptCount: 1,
            settingsButtonCount: 1,
            workerBridgeReady: true,
          };
        default:
          return true;
      }
    }),
    installExtension: vi.fn(async () => {
      calls.push('install');
      return 'yt-live-chat-overlay@piesp.github.io';
    }),
    navigate: vi.fn(async (url: string) => {
      calls.push(url.includes('windowsFirefoxExtension') ? 'navigate-fixture' : 'navigate-live');
    }),
    reload: vi.fn(async () => {
      calls.push('reload');
      pageLogs.push({
        level: 'info',
        text: '[RenderWorkerManager] renderer.worker.started',
        type: 'console',
      });
    }),
    startMockYouTube: vi.fn(async () => {
      calls.push('start-mock');
      return async () => {
        calls.push('stop-mock');
      };
    }),
    uninstallExtension: vi.fn(async () => {
      calls.push('uninstall');
    }),
    waitFor: vi.fn(async () => {
      calls.push('wait');
    }),
  };
  return { calls, session };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe('Windows Firefox installation profile', () => {
  it('serializes native Firefox and extension lifecycle parameters', () => {
    expect(
      buildFirefoxLaunchArguments({ profileDir: 'C:\\task\\.firefox-install-profile-a' })
    ).toEqual([
      '--new-instance',
      '--no-remote',
      '--profile',
      'C:\\task\\.firefox-install-profile-a',
      '--remote-debugging-port',
      '0',
      '--remote-allow-system-access',
      'about:blank',
    ]);
    expect(
      buildFirefoxLaunchArguments({
        headless: true,
        profileDir: 'C:\\task\\.firefox-install-profile-b',
      })[0]
    ).toBe('--headless');
    expect(extensionInstallParameters('C:\\task\\dist-extension-firefox')).toEqual({
      extensionData: { path: 'C:\\task\\dist-extension-firefox', type: 'path' },
      'moz:permanent': false,
    });
    expect(extensionUninstallParameters('extension-id')).toEqual({ extension: 'extension-id' });
    expect(
      resolveSystemFirefoxExecutable({
        env: { ProgramW6432: 'C:\\Program Files' },
        platform: 'win32',
      })
    ).toBe('C:\\Program Files\\Mozilla Firefox\\firefox.exe');
  });

  it('rejects non-public live URLs and returns only categorized error counts', () => {
    expect(normalizeLiveUrls(['https://www.youtube.com/watch?v=public'])).toEqual([
      { kind: 'watch', url: 'https://www.youtube.com/watch?v=public' },
    ]);
    expect(() => normalizeLiveUrls(['https://youtube.com/watch?v=wrong-host'])).toThrow(
      /public https/u
    );
    expect(() => normalizeLiveUrls(['http://www.youtube.com/watch?v=insecure'])).toThrow(
      /public https/u
    );
    expect(() => normalizeLiveUrls(['https://www.youtube.com/account'])).toThrow(
      /public watch or live/u
    );
    expect(
      categorizeErrors([
        { level: 'error', text: 'Content Security Policy blocked data', type: 'console' },
        { level: 'error', text: 'Worker load failed', type: 'console' },
        { level: 'info', text: 'private chat text', type: 'console' },
      ])
    ).toEqual({ 'content-security-policy': 1, worker: 1 });
  });

  it('runs installation, deterministic behavior, live observation, uninstall, and close in order', async () => {
    const { output, root } = await createBundle();
    const { calls, session } = createSession();
    const launch = vi.fn(async () => session);

    const result = await runFirefoxInstallation(
      {
        executablePath: '/test/firefox.exe',
        headless: false,
        liveUrls: ['https://www.youtube.com/watch?v=public'],
        output,
        root,
      },
      { launch }
    );

    expect(launch).toHaveBeenCalledWith({
      executablePath: '/test/firefox.exe',
      headless: false,
      root,
    });
    expect(result.checks).toEqual(
      Object.fromEntries(Object.keys(result.checks).map((key) => [key, true]))
    );
    expect(result.observations.live).toEqual([
      {
        canvasCount: 1,
        errorCategories: {},
        errorCount: 0,
        index: 0,
        kind: 'watch',
        loaded: true,
        overlayCount: 1,
        pageScriptCount: 1,
        settingsButtonCount: 1,
        workerBridgeReady: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain('/test/firefox.exe');
    expect(calls.indexOf('stop-mock')).toBeLessThan(calls.indexOf('navigate-live'));
    expect(calls.slice(-2)).toEqual(['uninstall', 'close']);
  });

  it('retains a flat failure screenshot and still uninstalls and closes', async () => {
    const { output, root } = await createBundle();
    const { calls, session } = createSession({ failStartup: true });

    await expect(
      runFirefoxInstallation(
        { executablePath: '/test/firefox.exe', output, root },
        { launch: async () => session }
      )
    ).rejects.toThrow('fixture startup failed');

    expect(await readdir(output)).toEqual(['firefox-extension-failure.png']);
    expect(await readFile(join(output, 'firefox-extension-failure.png'), 'utf8')).toBe(
      'screenshot'
    );
    expect(calls.slice(-3)).toEqual(['stop-mock', 'uninstall', 'close']);
  });
});
