// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import * as firefoxBidiModule from '../../../validation/windows/firefox-bidi.ts';
// @ts-expect-error The Windows acceptance runtime is intentionally plain ESM for portable Node.
import * as firefoxInstallModule from '../../../validation/windows/firefox-install.mjs';

const {
  categorizeErrors,
  normalizeLiveUrls,
  requireFirefoxPublicCoverage,
  resolveSystemFirefoxExecutable,
  runFirefoxInstallation,
  selectPublicSeekTarget,
} = firefoxInstallModule;
const {
  buildFirefoxLaunchArguments,
  cleanupFirefoxResources,
  combineFirefoxCloseFailures,
  extensionInstallParameters,
  extensionUninstallParameters,
  parseFirefoxProfileEndpoint,
  readOwnedFirefoxEndpoint,
  removeOwnedProfile,
  selectOwnedFirefoxListener,
  selectOwnedFirefoxProcesses,
  terminateOwnedProcessTree,
  waitForWindowsEndpoint,
} = firefoxBidiModule;

const temporaryDirectories: string[] = [];

async function createBundle(): Promise<{ output: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'yt-firefox-profile-test-'));
  temporaryDirectories.push(root);
  const output = join(root, 'output');
  await mkdir(join(root, 'dist-extension-firefox'), { recursive: true });
  await writeFile(join(root, 'dist-extension-firefox', 'manifest.json'), '{}');
  return { output, root };
}

function createSession(
  options: {
    failStartup?: boolean;
    liveState?: Record<string, unknown>;
    seekRangeUnavailable?: boolean;
    secondChatMode?: 'live' | 'replay' | 'unknown';
    settingsPersisted?: boolean;
    postReloadPlaybackUnavailable?: boolean;
    adAtSeek?: boolean;
    missingContentIdentity?: boolean;
    durationConflict?: boolean;
  } = {}
) {
  const calls: string[] = [];
  const pageLogs: Array<{ level: string; text: string; type: string }> = [];
  const pageErrors: Array<{ level: string; text: string; type: string }> = [];
  let evaluateIndex = 0;
  let publicPage = -1;
  let contentReads = 0;
  const session = {
    context: 'owned-context',
    command: vi.fn(async (_method: string, _params?: unknown) => ({})),
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
    evaluateJson: vi.fn(async (expression: string) => {
      new Script(expression);
      if (expression.includes('video.muted = true')) return { paused: false, readyState: 4 };
      if (expression.includes('getBoundingClientRect')) return { x: 300, y: 200 };
      if (expression.includes('const initialData = window.ytInitialData'))
        return {
          finalUrl: `https://www.youtube.com/watch?v=public-${publicPage}`,
          chatMode: publicPage === 0 ? 'live' : (options.secondChatMode ?? 'replay'),
          chatRendererFound: true,
          playabilityStatus: 'OK',
          loginRedirect: false,
          consentRedirect: false,
        };
      if (
        expression.includes('const expectedVideoId =') &&
        !expression.includes('const completed = new Promise')
      ) {
        contentReads++;
        const expectedVideoId = JSON.parse(
          /const expectedVideoId = ("[^"]*"|null);/u.exec(expression)?.[1] ?? 'null'
        );
        const adShowing = options.adAtSeek === true && contentReads === 2;
        const missingIdentity = options.missingContentIdentity === true;
        const durationConflict = options.durationConflict === true && publicPage > 0;
        return {
          status: adShowing || missingIdentity || durationConflict ? 'unverified' : 'passed',
          reason: adShowing
            ? 'ad-showing'
            : missingIdentity
              ? 'content-identity-unavailable'
              : durationConflict
                ? 'content-duration-mismatch'
                : null,
          adShowing,
          expectedVideoId,
          responseVideoId: missingIdentity ? null : expectedVideoId,
          playerVideoId: null,
          videoDuration: durationConflict ? 30 : 120,
          metadataDuration: 120,
        };
      }
      if (expression.includes('videoPaused: document.querySelector'))
        return (
          options.liveState ?? {
            renderer: 'worker',
            videoPaused: false,
            videoReadyState: 4,
            canvasCount: 1,
            overlayCount: 1,
            pageScriptCount: 1,
            renderedMessageCount: 1,
            settingsButtonCount: 1,
            workerBridgeReady: true,
            workerReady: true,
          }
        );
      if (expression.includes('const before = input.value;'))
        return { before: '32', target: '36', modalClosed: true };
      if (expression.includes('const value = modal?'))
        return options.settingsPersisted === false
          ? { value: '32', effective: 32 }
          : { value: '36', effective: 36 };
      if (expression.includes('video.pause();')) return { status: 'passed', paused: true };
      if (expression.includes('try { await video.play(); }'))
        return { status: 'passed', paused: false };
      if (expression.includes('video?.seekable.length'))
        return options.seekRangeUnavailable ? null : { currentTime: 30, start: 0, end: 120 };
      if (expression.includes('const completed = new Promise')) {
        expect(expression.indexOf('const content =')).toBeLessThan(
          expression.indexOf('video.currentTime =')
        );
        const target = /video\.currentTime = (\d+(?:\.\d+)?);/u.exec(expression)?.[1];
        if (target === undefined) throw new Error('Seek expression has no numeric target');
        return {
          status: 'passed',
          reason: null,
          target: Number(target),
          currentTime: Number(target),
        };
      }
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
      if (!url.includes('windowsFirefoxExtension')) {
        publicPage++;
        contentReads = 0;
        pageLogs.push({
          level: 'info',
          text: '[RenderWorkerManager] renderer.worker.started',
          type: 'console',
        });
      }
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
    waitFor: vi.fn(async (expression: string, description?: string) => {
      new Script(expression);
      calls.push('wait');
      if (
        options.postReloadPlaybackUnavailable &&
        description === 'public video playback after settings reload'
      ) {
        throw new Error('post-reload video stayed paused');
      }
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
  it('accepts only a fresh ordinary profile endpoint with a loopback port', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yt-firefox-endpoint-test-'));
    temporaryDirectories.push(root);
    const endpoint = join(root, 'WebDriverBiDiServer.json');
    const spawnedAt = Date.now();
    await writeFile(endpoint, JSON.stringify({ ws_host: '127.0.0.1', ws_port: 50947 }));
    expect(await readOwnedFirefoxEndpoint(root, spawnedAt)).toEqual({
      host: '127.0.0.1',
      port: 50947,
    });
    expect(() => parseFirefoxProfileEndpoint('{"ws_host":"0.0.0.0","ws_port":50947}')).toThrow(
      /loopback/u
    );
    expect(() => parseFirefoxProfileEndpoint('{"ws_host":"127.0.0.1","ws_port":0}')).toThrow(
      /port/u
    );
    expect(() => parseFirefoxProfileEndpoint('x'.repeat(1025))).toThrow(/oversized/u);
    await rm(endpoint);
    const foreign = join(root, 'foreign.json');
    await writeFile(foreign, '{"ws_host":"127.0.0.1","ws_port":50947}');
    await symlink(foreign, endpoint);
    await expect(readOwnedFirefoxEndpoint(root, spawnedAt)).rejects.toThrow(/ordinary file/u);
  });

  it('binds the BiDi listener to the launched Firefox tree and rejects a foreign port', () => {
    const spawnedAt = Date.now();
    const createdUtc = new Date(spawnedAt + 10).toISOString();
    const profileDir = 'C:\\task\\.firefox-install-profile-test';
    const executablePath = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
    const ownership = { childPid: 10, executablePath, profileDir, spawnedAt };
    const process = (pid: number, parentPid: number, commandLine?: string) => ({
      pid,
      parentPid,
      createdUtc,
      startTicks: '133000000000000000',
      executablePath,
      commandLine: commandLine ?? `"${executablePath}" --profile "${profileDir}"`,
    });
    const processes = [process(20, 10), process(21, 20, `"${executablePath}" -contentproc`)];
    expect(
      selectOwnedFirefoxProcesses(processes, ownership).map((entry: { pid: number }) => entry.pid)
    ).toEqual([20, 21]);
    expect(
      selectOwnedFirefoxProcesses(
        [{ ...process(20, 10), commandLine: `"${executablePath}" -profile "${profileDir}"` }],
        ownership
      )
    ).toHaveLength(1);
    expect(
      selectOwnedFirefoxListener({ processes, listenerPids: [21] }, ownership, 50947).pid
    ).toBe(21);
    expect(() =>
      selectOwnedFirefoxListener({ processes, listenerPids: [999] }, ownership, 50947)
    ).toThrow(/verified task-owned listener/u);
    expect(() =>
      selectOwnedFirefoxListener({ processes, listenerPids: [21, 999] }, ownership, 50947)
    ).toThrow(/verified task-owned listener/u);
    expect(
      selectOwnedFirefoxProcesses(
        [{ ...process(21, 20), createdUtc: new Date(spawnedAt - 5000).toISOString() }],
        ownership
      )
    ).toEqual([]);
  });

  it('includes the spawned Firefox launcher when it owns the task profile', async () => {
    const spawnedAt = Date.now();
    const profileDir = 'C:\\task\\.firefox-install-profile-test';
    const executablePath = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
    const createdUtc = new Date(spawnedAt + 10).toISOString();
    const makeProcess = (pid: number, parentPid: number, commandLine: string) => ({
      pid,
      parentPid,
      createdUtc,
      startTicks: `1330000000000000${pid}`,
      executablePath,
      commandLine,
    });
    const launcher = makeProcess(10, 9, `"${executablePath}" --profile "${profileDir}"`);
    const browser = makeProcess(20, 10, `"${executablePath}" --profile "${profileDir}"`);
    const content = makeProcess(21, 20, `"${executablePath}" -contentproc`);
    const processes = [launcher, browser, content];
    const ownership: {
      executablePath: string;
      profileDir: string;
      spawnedAt: number;
      expectedProcesses?: typeof processes;
    } = { executablePath, profileDir, spawnedAt };
    const child = Object.assign(new EventEmitter(), { pid: 10, exitCode: 0, signalCode: null });
    expect(
      selectOwnedFirefoxProcesses(processes, { ...ownership, childPid: child.pid }).map(
        (entry: { pid: number }) => entry.pid
      )
    ).toEqual([10, 20, 21]);
    await expect(
      waitForWindowsEndpoint(child, ownership, {
        readEndpoint: async () => ({ host: '127.0.0.1', port: 50947 }),
        inspect: async () => ({ processes, listenerPids: [20] }),
      })
    ).resolves.toBe('ws://127.0.0.1:50947/session');
    expect(ownership.expectedProcesses).toEqual(processes);

    const stop = vi.fn(async (_entry: { pid: number }) => {});
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ processes })
      .mockResolvedValueOnce({ processes: [] });
    await terminateOwnedProcessTree(child, ownership, { platform: 'win32', inspect, stop });
    expect(stop.mock.calls.map(([entry]) => entry.pid)).toEqual([21, 20, 10]);

    const reusedLauncher = { ...launcher, startTicks: '133000000000099999' };
    const reusedProcesses = [reusedLauncher, browser, content];
    expect(
      selectOwnedFirefoxProcesses(reusedProcesses, { ...ownership, childPid: child.pid }).map(
        (entry: { pid: number }) => entry.pid
      )
    ).not.toContain(child.pid);
    await expect(
      terminateOwnedProcessTree(child, ownership, {
        platform: 'win32',
        inspect: async () => ({ processes: reusedProcesses }),
        stop,
      })
    ).rejects.toThrow(/Unverified Firefox process/u);
    expect(stop.mock.calls.map(([entry]) => entry.pid)).toEqual([21, 20, 10]);
  });

  it('finds the profile endpoint after the Firefox launcher exits successfully', async () => {
    const spawnedAt = Date.now();
    const profileDir = 'C:\\task\\.firefox-install-profile-test';
    const executablePath = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
    const browser = {
      pid: 21,
      parentPid: 10,
      createdUtc: new Date(spawnedAt + 10).toISOString(),
      startTicks: '133000000000000000',
      executablePath,
      commandLine: `"${executablePath}" --profile "${profileDir}"`,
    };
    const child = Object.assign(new EventEmitter(), { pid: 10, exitCode: 0, signalCode: null });
    const ownership = { executablePath, profileDir, spawnedAt };
    const endpoint = await waitForWindowsEndpoint(child, ownership, {
      readEndpoint: async () => ({ host: '127.0.0.1', port: 50947 }),
      inspect: async () => ({ processes: [browser], listenerPids: [21] }),
    });
    expect(endpoint).toBe('ws://127.0.0.1:50947/session');
    expect(ownership).toMatchObject({ browserPid: 21, expectedProcesses: [browser] });
  });

  it('terminates the verified browser after its launcher exits and rejects reused identities', async () => {
    const spawnedAt = Date.now();
    const createdUtc = new Date(spawnedAt + 10).toISOString();
    const profileDir = 'C:\\task\\.firefox-install-profile-test';
    const executablePath = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
    const owned = {
      pid: 21,
      parentPid: 10,
      createdUtc,
      startTicks: '133000000000000000',
      executablePath,
      commandLine: `"${executablePath}" --profile "${profileDir}"`,
    };
    const ownership = { executablePath, profileDir, spawnedAt, expectedProcesses: [owned] };
    const child = { pid: 10, exitCode: 0, signalCode: null };
    const stop = vi.fn(
      async (_entry: { pid: number }, _bound: { expectedProcesses?: unknown[] }) => {}
    );
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ processes: [owned] })
      .mockResolvedValueOnce({ processes: [] });
    await terminateOwnedProcessTree(child, ownership, { platform: 'win32', inspect, stop });
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith(owned, {
      ...ownership,
      childPid: 10,
      expectedProcesses: [owned],
    });
    const reused = { ...owned, createdUtc: new Date(spawnedAt + 1000).toISOString() };
    await expect(
      terminateOwnedProcessTree(child, ownership, {
        platform: 'win32',
        inspect: async () => ({ processes: [reused] }),
        stop,
      })
    ).rejects.toThrow(/Unverified Firefox process/u);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('snapshots and checks Firefox descendants without profile arguments before removing a profile', async () => {
    const spawnedAt = Date.now();
    const profileDir = 'C:\\task\\.firefox-install-profile-test';
    const executablePath = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
    const createdUtc = new Date(spawnedAt + 10).toISOString();
    const makeProcess = (pid: number, parentPid: number, commandLine: string) => ({
      pid,
      parentPid,
      createdUtc,
      startTicks: `1330000000000000${pid}`,
      executablePath,
      commandLine,
    });
    const root = makeProcess(20, 10, `"${executablePath}" --profile "${profileDir}"`);
    const browser = makeProcess(21, 20, `"${executablePath}" -contentproc`);
    const content = makeProcess(22, 21, `"${executablePath}" -contentproc`);
    const ownership = { executablePath, profileDir, spawnedAt, expectedProcesses: [root] };
    const child = { pid: 10, exitCode: 0, signalCode: null };
    const stop = vi.fn(
      async (_entry: { pid: number }, _bound: { expectedProcesses?: unknown[] }) => {}
    );
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ processes: [root, browser, content] })
      .mockResolvedValueOnce({ processes: [] });
    await terminateOwnedProcessTree(child, ownership, { platform: 'win32', inspect, stop });
    expect(stop.mock.calls.map(([entry]) => entry.pid)).toEqual([22, 21, 20]);
    expect(stop.mock.calls[0]?.[1].expectedProcesses).toEqual([root, browser, content]);

    const stillAlive = vi
      .fn()
      .mockResolvedValueOnce({ processes: [root, browser, content] })
      .mockResolvedValueOnce({ processes: [content] });
    await expect(
      terminateOwnedProcessTree(child, ownership, {
        platform: 'win32',
        inspect: stillAlive,
        stop,
      })
    ).rejects.toThrow(/remains alive/u);
  });

  it('preserves the profile when a late Firefox descendant loses its verified parent chain', async () => {
    const spawnedAt = Date.now();
    const profileDir = 'C:\\task\\.firefox-install-profile-test';
    const executablePath = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
    const createdUtc = new Date(spawnedAt + 10).toISOString();
    const root = {
      pid: 20,
      parentPid: 10,
      createdUtc,
      startTicks: '133000000000000020',
      executablePath,
      commandLine: `"${executablePath}" --profile "${profileDir}"`,
    };
    const late = {
      ...root,
      pid: 23,
      parentPid: 20,
      startTicks: '133000000000000023',
      commandLine: `"${executablePath}" -contentproc`,
    };
    const ambient = { ...late, pid: 99, parentPid: 999 };
    const ownership = { executablePath, profileDir, spawnedAt, expectedProcesses: [root] };
    const child = { pid: 10, exitCode: 0, signalCode: null };
    const stop = vi.fn(async (_entry: { pid: number }) => {});
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ processes: [root, ambient] })
      .mockResolvedValueOnce({ processes: [late, ambient] });
    await expect(
      terminateOwnedProcessTree(child, ownership, {
        platform: 'win32',
        inspect,
        stop,
      })
    ).rejects.toThrow(/Unverified Firefox descendant/u);
    expect(stop.mock.calls.map(([entry]) => entry.pid)).toEqual([20]);

    const ambientOnly = vi
      .fn()
      .mockResolvedValueOnce({ processes: [root, ambient] })
      .mockResolvedValueOnce({ processes: [ambient] });
    await expect(
      terminateOwnedProcessTree(child, ownership, {
        platform: 'win32',
        inspect: ambientOnly,
        stop,
      })
    ).resolves.toBeUndefined();
  });

  it('serializes native Firefox and extension lifecycle parameters', () => {
    expect(
      buildFirefoxLaunchArguments({
        platform: 'win32',
        profileDir: 'C:\\task\\.firefox-install-profile-a',
      })
    ).toEqual([
      '--wait-for-browser',
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
        platform: 'win32',
        profileDir: 'C:\\task\\.firefox-install-profile-b',
      })
    ).toEqual([
      '--headless',
      '--wait-for-browser',
      '--new-instance',
      '--no-remote',
      '--profile',
      'C:\\task\\.firefox-install-profile-b',
      '--remote-debugging-port',
      '0',
      '--remote-allow-system-access',
      'about:blank',
    ]);
    expect(
      buildFirefoxLaunchArguments({
        headless: true,
        platform: 'linux',
        profileDir: '/tmp/.firefox-install-profile-c',
      })
    ).toEqual([
      '--headless',
      '--new-instance',
      '--no-remote',
      '--profile',
      '/tmp/.firefox-install-profile-c',
      '--remote-debugging-port',
      '0',
      '--remote-allow-system-access',
      'about:blank',
    ]);
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
    expect(() => normalizeLiveUrls(['https://www.youtube.com/live'])).toThrow(
      /public watch or live/u
    );
    expect(() => normalizeLiveUrls(['https://www.youtube.com/watch?v=x#fragment'])).toThrow(
      /fragment/u
    );
    expect(() =>
      normalizeLiveUrls([
        'https://www.youtube.com/watch?v=1',
        'https://www.youtube.com/watch?v=2',
        'https://www.youtube.com/watch?v=3',
        'https://www.youtube.com/watch?v=4',
      ])
    ).toThrow(/at most 3/u);
    expect(
      categorizeErrors([
        { level: 'error', text: 'Content Security Policy blocked data', type: 'console' },
        { level: 'error', text: 'Worker load failed', type: 'console' },
        { level: 'info', text: 'private chat text', type: 'console' },
      ])
    ).toEqual({ 'content-security-policy': 1, worker: 1 });
    expect(selectPublicSeekTarget({ currentTime: 30, start: 0, end: 120 })).toBe(33);
    expect(
      selectPublicSeekTarget({ currentTime: 30, start: 0, end: 120 }, { preferBackward: true })
    ).toBe(27);
    expect(
      selectPublicSeekTarget({ currentTime: 1.5, start: 0, end: 120 }, { preferBackward: true })
    ).toBe(4.5);
    expect(
      selectPublicSeekTarget({ currentTime: 30, start: 30, end: 32 }, { preferBackward: true })
    ).toBeNull();
    expect(selectPublicSeekTarget({ currentTime: 30, start: 30, end: 32 })).toBeNull();
    expect(() => requireFirefoxPublicCoverage([{ provider: { chatMode: 'live' } }])).toThrow(
      'live/replay workflow coverage'
    );
  });

  it('runs installation, deterministic behavior, live observation, uninstall, and close in order', async () => {
    const { output, root } = await createBundle();
    const { calls, session } = createSession();
    const launch = vi.fn(async () => session);

    const result = await runFirefoxInstallation(
      {
        executablePath: '/test/firefox.exe',
        headless: false,
        liveUrls: [
          'https://www.youtube.com/watch?v=public-live',
          'https://www.youtube.com/watch?v=public-replay',
        ],
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
    expect(result.status).toBe('passed');
    expect(
      result.observations.live.map(
        (item: { workflow: { seek: { target: number } } }) => item.workflow.seek.target
      )
    ).toEqual([27, 33]);
    const liveSeekExpression = session.evaluateJson.mock.calls
      .map(([expression]) => expression)
      .find((expression) => expression.includes('const completed = new Promise'));
    if (!liveSeekExpression) throw new Error('Live seek expression was not evaluated');
    const seekContext = (
      video: object,
      videoId: string,
      adShowing = false,
      metadataLength = '120'
    ) => {
      const player = {
        querySelector: () => video,
        classList: { contains: () => adShowing },
        getVideoData: () => ({ video_id: videoId }),
      };
      return {
        document: {
          querySelector: (selector: string) => (selector === '#movie_player' ? player : video),
        },
        window: {
          ytInitialPlayerResponse: { videoDetails: { videoId, lengthSeconds: metadataLength } },
        },
      };
    };
    let seekedListener: (() => void) | undefined;
    let currentTime = 30;
    const video = {
      paused: false,
      readyState: 4,
      duration: 120,
      seekable: { length: 1, start: () => 0, end: () => 120 },
      get currentTime() {
        return currentTime;
      },
      set currentTime(target: number) {
        currentTime = target - 2.5;
        seekedListener?.();
      },
      addEventListener: (_event: string, listener: () => void) => {
        seekedListener = listener;
      },
    };
    const mismatchedSeek = await new Script(liveSeekExpression).runInNewContext({
      ...seekContext(video, 'public-live'),
      setTimeout,
      clearTimeout,
    });
    expect(mismatchedSeek).toMatchObject({
      status: 'unverified',
      reason: 'seek-position-mismatch',
      target: 27,
      range: { start: 0, end: 120 },
      preSeekTime: 30,
      afterTime: 24.5,
      seekedEvent: true,
    });
    const timedOutVideo = {
      paused: false,
      readyState: 4,
      duration: 120,
      currentTime: 30,
      seekable: { length: 1, start: () => 0, end: () => 120 },
      addEventListener: () => {},
    };
    const timedOutSeek = await new Script(liveSeekExpression).runInNewContext({
      ...seekContext(timedOutVideo, 'public-live'),
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      },
      clearTimeout: () => {},
    });
    expect(timedOutSeek).toMatchObject({
      status: 'unverified',
      reason: 'seeked-event-timeout',
      target: 27,
      preSeekTime: 30,
      afterTime: 27,
      seekedEvent: false,
    });
    const movedRangeSeek = await new Script(liveSeekExpression).runInNewContext({
      ...seekContext(
        {
          paused: false,
          readyState: 4,
          duration: 120,
          currentTime: 30,
          seekable: { length: 1, start: () => 0, end: () => 20 },
        },
        'public-live'
      ),
    });
    expect(movedRangeSeek).toMatchObject({
      status: 'unverified',
      reason: 'seek-target-out-of-range',
      target: 27,
      range: { start: 0, end: 20 },
      preSeekTime: 30,
      seekedEvent: false,
    });
    const replaySeekExpression = session.evaluateJson.mock.calls
      .map(([expression]) => expression)
      .filter((expression) => expression.includes('const completed = new Promise'))[1];
    if (!replaySeekExpression) throw new Error('Replay seek expression was not evaluated');
    let assignmentCount = 0;
    const staleVideo = {
      paused: false,
      readyState: 4,
      duration: 120,
      seekable: { length: 1, start: () => 0, end: () => 120 },
      get currentTime() {
        return 32.5;
      },
      set currentTime(_target: number) {
        assignmentCount++;
      },
    };
    const staleSeek = await new Script(replaySeekExpression).runInNewContext({
      ...seekContext(staleVideo, 'public-replay'),
    });
    expect(staleSeek).toMatchObject({
      status: 'unverified',
      reason: 'seek-target-no-longer-distinct',
      target: 33,
      range: { start: 0, end: 120 },
      preSeekTime: 32.5,
      afterTime: 32.5,
      seekedEvent: false,
    });
    expect(assignmentCount).toBe(0);
    const adSeek = await new Script(replaySeekExpression).runInNewContext({
      ...seekContext(
        {
          paused: false,
          readyState: 4,
          duration: 30,
          seekable: { length: 1, start: () => 0, end: () => 30 },
          get currentTime() {
            return 13;
          },
          set currentTime(_target: number) {
            throw new Error('ad must not be seeked');
          },
        },
        'public-replay',
        true
      ),
    });
    expect(adSeek).toMatchObject({ status: 'unverified', reason: 'ad-showing' });
    let boundaryTime = 32;
    let boundaryListener: (() => void) | undefined;
    const boundaryVideo = {
      paused: false,
      readyState: 4,
      duration: 120,
      seekable: { length: 1, start: () => 0, end: () => 120 },
      get currentTime() {
        return boundaryTime;
      },
      set currentTime(target: number) {
        boundaryTime = target;
        boundaryListener?.();
      },
      addEventListener: (_event: string, listener: () => void) => {
        boundaryListener = listener;
      },
    };
    const boundarySeek = await new Script(replaySeekExpression).runInNewContext({
      ...seekContext(boundaryVideo, 'public-replay'),
      setTimeout,
      clearTimeout,
    });
    expect(boundarySeek).toMatchObject({
      status: 'passed',
      target: 33,
      preSeekTime: 32,
      afterTime: 33,
      seekedEvent: true,
    });
    let partialRangeTime = 32;
    let partialRangeListener: (() => void) | undefined;
    const partialRangeSeek = await new Script(replaySeekExpression).runInNewContext({
      ...seekContext(
        {
          paused: false,
          readyState: 4,
          duration: 5168.121,
          seekable: { length: 1, start: () => 0, end: () => 35 },
          get currentTime() {
            return partialRangeTime;
          },
          set currentTime(target: number) {
            partialRangeTime = target;
            partialRangeListener?.();
          },
          addEventListener: (_event: string, listener: () => void) => {
            partialRangeListener = listener;
          },
        },
        'public-replay',
        false,
        '5168'
      ),
      setTimeout,
      clearTimeout,
    });
    expect(partialRangeSeek).toMatchObject({ status: 'passed', target: 33, afterTime: 33 });
    expect(session.waitFor).toHaveBeenCalledWith(
      expect.stringContaining('730002'),
      'the public UI font size to persist in extension storage'
    );
    expect(session.command).toHaveBeenCalledWith('input.performActions', {
      context: 'owned-context',
      actions: [
        {
          type: 'pointer',
          id: 'acceptance-player',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', origin: 'viewport', x: 300, y: 200 },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ],
    });
    expect(session.command).toHaveBeenCalledWith('input.releaseActions', {
      context: 'owned-context',
    });
    expect(result.observations.live).toMatchObject([
      {
        renderer: 'worker',
        workerPolicyFallback: false,
        hostErrorCount: 0,
        unexpectedErrorCount: 0,
        videoPaused: false,
        videoReadyState: 4,
        screenshot: 'firefox-live-01.png',
        player: {
          paused: false,
          readyState: 4,
          inputMethod: 'native-pointer',
          playbackStarted: true,
        },
        canvasCount: 1,
        errorCategories: {},
        errorCount: 0,
        index: 0,
        kind: 'watch',
        loaded: true,
        overlayCount: 1,
        pageScriptCount: 1,
        renderedMessageCount: 1,
        settingsButtonCount: 1,
        workerBridgeReady: true,
        workerReady: true,
        provider: { chatMode: 'live' },
        workflow: {
          startup: { status: 'passed' },
          settings: {
            status: 'passed',
            postReloadPlayback: {
              status: 'passed',
              inputMethod: 'native-pointer',
              playbackStarted: true,
            },
          },
          pause: { status: 'passed' },
          resume: { status: 'passed' },
          seek: { status: 'passed' },
          navigation: { status: 'not-run' },
        },
        status: 'passed',
      },
      {
        provider: { chatMode: 'replay' },
        workflow: {
          seek: {
            content: {
              status: 'passed',
              adShowing: false,
              expectedVideoId: 'public-replay',
              responseVideoId: 'public-replay',
              videoDuration: 120,
              metadataDuration: 120,
            },
          },
          settings: { postReloadPlayback: { status: 'passed', playbackStarted: true } },
          navigation: {
            status: 'passed',
            kind: 'full-document-cross-watch',
            documentNavigation: 'browsingContext.navigate',
            freshDocumentCanvasIsolation: 'passed',
            spaRetirement: { status: 'unverified', reason: 'full-document-navigation' },
          },
        },
        status: 'passed',
      },
    ]);
    expect(session.navigate.mock.calls.slice(-2).map(([url]) => url)).toEqual([
      'https://www.youtube.com/watch?v=public-live',
      'https://www.youtube.com/watch?v=public-replay',
    ]);
    const playbackWaits = session.waitFor.mock.calls
      .map(([, description], index) => ({ description, index }))
      .filter(({ description }) => description === 'public video playback after settings reload');
    const chatWaits = session.waitFor.mock.calls
      .map(([, description], index) => ({ description, index }))
      .filter(({ description }) => description === 'the public overlay to reload with settings');
    expect(playbackWaits).toHaveLength(2);
    expect(chatWaits).toHaveLength(2);
    expect(playbackWaits.every(({ index }, page) => index < (chatWaits[page]?.index ?? -1))).toBe(
      true
    );
    expect(
      session.command.mock.calls.filter(([method]) => method === 'input.performActions')
    ).toHaveLength(4);
    const renderPredicate = session.waitFor.mock.calls.find(
      ([, description]) =>
        description === 'the installed Firefox extension to render public live chat'
    )?.[0];
    expect(renderPredicate).toContain("classList.contains('ad-showing')");
    expect(renderPredicate).toContain('identityMatches');
    expect(renderPredicate).toContain('durationMatches');
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain('/test/firefox.exe');
    expect(calls.indexOf('stop-mock')).toBeLessThan(calls.indexOf('navigate-live'));
    expect(calls.slice(-2)).toEqual(['uninstall', 'close']);
    expect(
      JSON.parse(await readFile(join(output, 'firefox-installation-result.json'), 'utf8'))
    ).toEqual(result);
  });

  it('leaves public-page checks not-run when only the installed fixture was requested', async () => {
    const { output, root } = await createBundle();
    const { session } = createSession();
    const result = await runFirefoxInstallation(
      { executablePath: '/test/firefox.exe', output, root },
      { launch: async () => session }
    );
    expect(result.status).toBe('passed');
    expect(result.checks.livePagesLoaded).toBeNull();
    expect(result.checks.liveRenderingPassed).toBeNull();
    expect(result.checks.liveWorkflowCoverage).toBeNull();
    expect(result.observations.live).toEqual([]);
  });

  it('does not wait for post-reload chat when public video playback remains unobserved', async () => {
    const { output, root } = await createBundle();
    const { session } = createSession({ postReloadPlaybackUnavailable: true });
    await expect(
      runFirefoxInstallation(
        {
          executablePath: '/test/firefox.exe',
          liveUrls: ['https://www.youtube.com/watch?v=public-live'],
          output,
          root,
        },
        { launch: async () => session }
      )
    ).rejects.toThrow('public YouTube page did not prove installed rendering');
    const receipt = JSON.parse(
      await readFile(join(output, 'firefox-installation-result.json'), 'utf8')
    );
    expect(receipt.observations.live[0]).toMatchObject({
      failureCategory: 'settings-reload-playback-error',
      workflow: {
        settings: {
          status: 'not-run',
          postReloadPlayback: { status: 'unverified', reason: 'playback-not-observed' },
        },
      },
    });
    expect(
      session.waitFor.mock.calls.some(
        ([, description]) => description === 'the public overlay to reload with settings'
      )
    ).toBe(false);
  });

  it('does not seek if an ad starts after public content admission', async () => {
    const { output, root } = await createBundle();
    const { session } = createSession({ adAtSeek: true });
    await expect(
      runFirefoxInstallation(
        {
          executablePath: '/test/firefox.exe',
          liveUrls: ['https://www.youtube.com/watch?v=public-live'],
          output,
          root,
        },
        { launch: async () => session }
      )
    ).rejects.toThrow('public YouTube page did not prove installed rendering');
    const receipt = JSON.parse(
      await readFile(join(output, 'firefox-installation-result.json'), 'utf8')
    );
    expect(receipt.observations.live[0]).toMatchObject({
      phase: 'seek',
      workflow: {
        seek: { status: 'unverified', reason: 'ad-showing', content: { adShowing: true } },
      },
    });
    expect(
      session.evaluateJson.mock.calls.some(([expression]) =>
        expression.includes('video.currentTime =')
      )
    ).toBe(false);
  });

  it.each([
    [{ missingContentIdentity: true }, 'content-identity-unavailable', 0],
    [{ durationConflict: true }, 'content-duration-mismatch', 1],
  ])('keeps uncertain public content unverified before seeking', async (options, reason, page) => {
    const { output, root } = await createBundle();
    const { session } = createSession(options);
    await expect(
      runFirefoxInstallation(
        {
          executablePath: '/test/firefox.exe',
          liveUrls: [
            'https://www.youtube.com/watch?v=public-live',
            ...(page === 1 ? ['https://www.youtube.com/watch?v=public-replay'] : []),
          ],
          output,
          root,
        },
        { launch: async () => session }
      )
    ).rejects.toThrow('public YouTube page did not prove installed rendering');
    const receipt = JSON.parse(
      await readFile(join(output, 'firefox-installation-result.json'), 'utf8')
    );
    expect(receipt.observations.live[page]).toMatchObject({
      phase: 'render',
      player: { content: { status: 'unverified', reason } },
      workflow: { seek: { status: 'not-run' } },
    });
    expect(
      session.evaluateJson.mock.calls.filter(([expression]) =>
        expression.includes('video.currentTime =')
      )
    ).toHaveLength(page);
  });

  it.each([
    [{ secondChatMode: 'unknown' as const }, 'startup', 'chat-mode-unknown'],
    [{ settingsPersisted: false }, 'settings', 'state-not-observed'],
    [{ seekRangeUnavailable: true }, 'seek', 'seek-range-unavailable'],
  ])('does not pass incomplete public workflow evidence (%s)', async (options, stage, reason) => {
    const { output, root } = await createBundle();
    const { calls, session } = createSession(options);
    await expect(
      runFirefoxInstallation(
        {
          executablePath: '/test/firefox.exe',
          liveUrls: [
            'https://www.youtube.com/watch?v=public-live',
            'https://www.youtube.com/watch?v=public-replay',
          ],
          output,
          root,
        },
        { launch: async () => session }
      )
    ).rejects.toThrow('public YouTube page did not prove installed rendering');
    const receipt = JSON.parse(
      await readFile(join(output, 'firefox-installation-result.json'), 'utf8')
    );
    expect(receipt.status).toBe('failed');
    expect(receipt.checks.liveWorkflowCoverage).toBe(false);
    expect(
      receipt.observations.live.some(
        (item: { failureCategory?: string }) => item.failureCategory === `${stage}-${reason}`
      )
    ).toBe(true);
    expect(calls.slice(-2)).toEqual(['uninstall', 'close']);
  });

  it('rejects two rendered public pages when neither proves replay mode', async () => {
    const { output, root } = await createBundle();
    const { calls, session } = createSession({ secondChatMode: 'live' });
    await expect(
      runFirefoxInstallation(
        {
          executablePath: '/test/firefox.exe',
          liveUrls: [
            'https://www.youtube.com/watch?v=public-live',
            'https://www.youtube.com/watch?v=public-replay',
          ],
          output,
          root,
        },
        { launch: async () => session }
      )
    ).rejects.toThrow('live/replay workflow coverage is incomplete');
    const receipt = JSON.parse(
      await readFile(join(output, 'firefox-installation-result.json'), 'utf8')
    );
    expect(receipt.checks.liveRenderingPassed).toBe(true);
    expect(receipt.checks.liveWorkflowCoverage).toBe(false);
    expect(calls.slice(-2)).toEqual(['uninstall', 'close']);
  });

  it('does not count a repeat of the same public URL as cross-watch navigation', async () => {
    const { output, root } = await createBundle();
    const { session } = createSession();
    await expect(
      runFirefoxInstallation(
        {
          executablePath: '/test/firefox.exe',
          liveUrls: [
            'https://www.youtube.com/watch?v=public',
            'https://www.youtube.com/watch?v=public',
          ],
          output,
          root,
        },
        { launch: async () => session }
      )
    ).rejects.toThrow('public YouTube page did not prove installed rendering');
    const receipt = JSON.parse(
      await readFile(join(output, 'firefox-installation-result.json'), 'utf8')
    );
    expect(receipt.observations.live[1].workflow.navigation).toMatchObject({
      status: 'unverified',
      reason: 'same-public-url',
      kind: 'full-document-reload',
      documentNavigation: 'browsingContext.navigate',
      freshDocumentCanvasIsolation: 'passed',
      spaRetirement: { status: 'unverified', reason: 'full-document-navigation' },
    });
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

    expect(await readdir(output)).toEqual([
      'firefox-extension-failure.png',
      'firefox-installation-result.json',
    ]);
    expect(await readFile(join(output, 'firefox-extension-failure.png'), 'utf8')).toBe(
      'screenshot'
    );
    expect(calls.slice(-3)).toEqual(['stop-mock', 'uninstall', 'close']);
  });

  it.each([false, true])(
    'fails missing render readiness or paused playback (paused=%s)',
    async (paused) => {
      const { output, root } = await createBundle();
      const { calls, session } = createSession({
        liveState: {
          canvasCount: paused ? 1 : 0,
          overlayCount: paused ? 1 : 0,
          pageScriptCount: paused ? 1 : 0,
          renderedMessageCount: paused ? 1 : 0,
          settingsButtonCount: paused ? 1 : 0,
          workerBridgeReady: paused,
          workerReady: paused,
          renderer: 'worker',
          videoPaused: paused,
          videoReadyState: 4,
        },
      });

      await expect(
        runFirefoxInstallation(
          {
            executablePath: '/test/firefox.exe',
            liveUrls: ['https://www.youtube.com/watch?v=public'],
            output,
            root,
          },
          { launch: async () => session }
        )
      ).rejects.toThrow('public YouTube page did not prove installed rendering');

      const result = JSON.parse(
        await readFile(join(output, 'firefox-installation-result.json'), 'utf8')
      );
      expect(result.status).toBe('failed');
      expect(result.observations.live).toEqual([
        expect.objectContaining({
          loaded: true,
          renderedMessageCount: paused ? 1 : 0,
          status: 'unverified',
        }),
      ]);
      expect(calls.slice(-2)).toEqual(['uninstall', 'close']);
    }
  );

  it('attempts process and owned-profile cleanup even when socket close fails', async () => {
    const calls: string[] = [];
    await expect(
      cleanupFirefoxResources(
        {
          child: {},
          detachSocket: () => calls.push('detach'),
          profileDir: '/task/.firefox-install-profile-test',
          root: '/task',
          socket: {
            close: () => {
              calls.push('socket-close');
              throw new Error('socket failed');
            },
          },
        },
        {
          removeProfile: async () => {
            calls.push('remove-profile');
          },
          terminateProcessTree: async () => {
            calls.push('terminate-tree');
          },
        }
      )
    ).rejects.toThrow(AggregateError);
    expect(calls).toEqual(['detach', 'socket-close', 'terminate-tree', 'remove-profile']);

    const removeProfile = vi.fn(async () => {});
    await expect(
      cleanupFirefoxResources(
        {
          child: {},
          profileDir: '/task/.firefox-install-profile-test',
          root: '/task',
          socket: null,
        },
        {
          removeProfile,
          terminateProcessTree: async () => {
            throw new Error('tree remains');
          },
        }
      )
    ).rejects.toThrow('Firefox resource cleanup failed');
    expect(removeProfile).not.toHaveBeenCalled();
  });

  it('retains both the Windows ownership snapshot error and cleanup error in the receipt', async () => {
    const snapshotError = new Error('Windows Firefox ownership snapshot failed');
    const cleanupError = new AggregateError(
      [new Error('Firefox process ownership snapshot failed before session shutdown')],
      'Firefox resource cleanup failed'
    );
    const failure = combineFirefoxCloseFailures(snapshotError, cleanupError);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error('Expected aggregate cleanup failure');
    expect(failure.errors).toEqual([snapshotError, cleanupError]);
    expect(combineFirefoxCloseFailures(snapshotError, undefined)).toBe(snapshotError);
    expect(combineFirefoxCloseFailures(undefined, cleanupError)).toBe(cleanupError);

    const { output, root } = await createBundle();
    const { session } = createSession();
    session.close.mockRejectedValueOnce(failure);
    await expect(
      runFirefoxInstallation(
        { executablePath: '/test/firefox.exe', output, root },
        { launch: async () => session }
      )
    ).rejects.toThrow('Firefox installation cleanup failed');
    const receipt = JSON.parse(
      await readFile(join(output, 'firefox-installation-result.json'), 'utf8')
    );
    expect(receipt.errors[0].cause.errors).toEqual([
      { name: 'Error', message: 'Windows Firefox ownership snapshot failed' },
      {
        name: 'AggregateError',
        message: 'Firefox resource cleanup failed',
        errors: [
          {
            name: 'Error',
            message: 'Firefox process ownership snapshot failed before session shutdown',
          },
        ],
      },
    ]);
  });

  it('passes a bounded Windows lock retry policy only for a task-owned profile', async () => {
    const rmProfile = vi.fn(async () => {});
    await removeOwnedProfile('/task', '/task/.firefox-install-profile-test', rmProfile);
    expect(rmProfile).toHaveBeenCalledWith('/task/.firefox-install-profile-test', {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 200,
    });

    await expect(
      removeOwnedProfile('/task', '/other/.firefox-install-profile-test', rmProfile)
    ).rejects.toThrow(/outside the task root/u);
    expect(rmProfile).toHaveBeenCalledOnce();

    const locked = Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    const failingRemoval = vi.fn(async () => {
      throw locked;
    });
    await expect(
      removeOwnedProfile('/task', '/task/.firefox-install-profile-locked', failingRemoval)
    ).rejects.toBe(locked);
  });
});
