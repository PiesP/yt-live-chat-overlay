// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cleanupChromeInstallation,
  readOwnedBrowserProcessId,
  removeOwnedChromeProfile,
} from './chrome-install.mjs';
import { captureOwnedChromeProcess } from './chrome-process.mjs';

const VIEWPORT = { width: 1280, height: 720 };
const DEVTOOLS_WAIT_MS = 30_000;
const CHILD_EXIT_MS = 8_000;
const STDERR_LIMIT_BYTES = 64 * 1024;
const PROTOCOL_TIMEOUT_MS = 15_000;

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function boundedProtocolOperation(operation, label) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(`${label} exceeded its protocol deadline`);
          error.name = 'TimeoutError';
          reject(error);
        }, PROTOCOL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function naturalChromeArguments(profile) {
  return [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-extension-debugging',
    '--mute-audio',
    '--lang=en-US',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    'about:blank',
  ];
}

async function waitForChildExit(child, timeoutMs = CHILD_EXIT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => resolveExit(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveExit(true);
    });
  });
}

export async function readDevToolsEndpoint(
  profile,
  child,
  childState,
  { sleep = delay } = {}
) {
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + DEVTOOLS_WAIT_MS;
  while (Date.now() < deadline) {
    if (childState.spawnError) throw childState.spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Owned Chrome exited before its DevTools endpoint was ready');
    }
    try {
      const portStat = await stat(portFile);
      assert(
        portStat.isFile() && portStat.size >= 3 && portStat.size <= 4096,
        'DevToolsActivePort has an invalid file shape'
      );
      const [portText, webSocketPath, ...extra] = (await readFile(portFile, 'utf8'))
        .trim()
        .split(/\r?\n/u);
      assert.equal(extra.length, 0, 'DevToolsActivePort has extra records');
      assert.match(portText ?? '', /^[0-9]{1,5}$/u);
      const port = Number(portText);
      assert(
        Number.isInteger(port) && port >= 1 && port <= 65_535,
        'DevToolsActivePort has an invalid port'
      );
      assert.match(
        webSocketPath ?? '',
        /^\/devtools\/browser\/[A-Za-z0-9._-]{1,256}$/u
      );
      return `ws://127.0.0.1:${port}${webSocketPath}`;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await sleep(100);
  }
  throw new Error('Timed out waiting for the owned Chrome DevTools endpoint');
}

async function discoverInstalledChrome(chromium, root, output, checkpoint) {
  const profile = await mkdtemp(join(root, 'chrome-install-'));
  const result = { cleanup: {} };
  let context;
  let cdp;
  let browserProcessId;
  let browserProcessIdentity;
  let primaryError;
  try {
    await checkpoint('natural-launch:discovery-browser', 'before');
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chrome',
      headless: false,
      locale: 'en-US',
      viewport: VIEWPORT,
      timeout: 30_000,
      args: ['--mute-audio'],
    });
    await checkpoint('natural-launch:discovery-browser', 'after');
    cdp = await context.browser().newBrowserCDPSession();
    browserProcessId = readOwnedBrowserProcessId(
      await cdp.send('SystemInfo.getProcessInfo')
    );
    browserProcessIdentity = await captureOwnedChromeProcess(browserProcessId, profile);
    return {
      browserVersion: context.browser().version(),
      executablePath: browserProcessIdentity.executablePath,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await cleanupChromeInstallation({
        browserProcessId,
        browserProcessIdentity,
        context,
        cdp,
        extensionId: null,
        profile,
        output,
        result,
        root,
      });
    } catch (cleanupError) {
      if (primaryError) {
        throw new AggregateError(
          [primaryError, cleanupError],
          'Installed Chrome discovery and cleanup failed'
        );
      }
      throw cleanupError;
    }
  }
}

/** Stop a spawned browser before its full CIM identity has been captured. */
export async function stopUnidentifiedChild(
  child,
  childState,
  browserCdp,
  { waitForChildExit: wait = waitForChildExit } = {}
) {
  const errors = [];
  if (childState.spawnError && !Number.isInteger(child.pid)) {
    return { exited: true, errors };
  }
  if (browserCdp) {
    try {
      await boundedProtocolOperation(() => browserCdp.send('Browser.close'), 'Browser.close');
    } catch (error) {
      errors.push(error);
    }
  }
  let exited = await wait(child, CHILD_EXIT_MS / 2);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    try {
      if (!child.kill()) errors.push(new Error('Owned Chrome refused direct termination'));
    } catch (error) {
      errors.push(error);
    }
    exited = await wait(child, CHILD_EXIT_MS / 2);
  }
  if (!exited) errors.push(new Error('Unidentified owned Chrome child did not exit'));
  return { exited, errors };
}

/**
 * Spawn a task-owned Chrome process and attach without Playwright launch defaults.
 * This is required for the browser's native visible-hidden-visible tab lifecycle.
 */
export async function launchOwnedNaturalChrome({
  chromium,
  root,
  output,
  checkpoint = async () => {},
}) {
  const discovered = await discoverInstalledChrome(chromium, root, output, checkpoint);
  const profile = await mkdtemp(join(root, 'chrome-install-'));
  let child;
  try {
    child = spawn(discovered.executablePath, naturalChromeArguments(profile), {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: false,
    });
  } catch (error) {
    await removeOwnedChromeProfile(root, profile).catch((cleanupError) => {
      throw new AggregateError([error, cleanupError], 'Owned Chrome spawn and cleanup failed');
    });
    throw error;
  }

  const childState = { spawnError: null };
  child.once('error', (error) => {
    childState.spawnError = error;
  });
  let stderrBytes = 0;
  let stderrTail = Buffer.alloc(0);
  child.stderr.on('data', (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderrBytes += bytes.length;
    stderrTail = Buffer.concat([stderrTail, bytes]).subarray(-STDERR_LIMIT_BYTES);
  });

  let browser;
  let browserCdp;
  let browserProcessId;
  let browserProcessIdentity;
  let cdpMatchedSpawn = false;
  try {
    await checkpoint('natural-launch:devtools-endpoint', 'before');
    const endpoint = await readDevToolsEndpoint(profile, child, childState);
    await checkpoint('natural-launch:connect', 'before');
    browser = await chromium.connectOverCDP(endpoint, {
      noDefaults: true,
      isLocal: true,
      timeout: 10_000,
    });
    await checkpoint('natural-launch:connect', 'after');
    const contexts = browser.contexts();
    assert.equal(contexts.length, 1, 'Owned Chrome did not expose one default context');
    const [context] = contexts;
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(45_000);
    browserCdp = await browser.newBrowserCDPSession();
    browserProcessId = readOwnedBrowserProcessId(
      await browserCdp.send('SystemInfo.getProcessInfo')
    );
    assert.equal(
      browserProcessId,
      child.pid,
      'Owned Chrome CDP browser process did not match the spawned process'
    );
    cdpMatchedSpawn = true;
    browserProcessIdentity = await captureOwnedChromeProcess(browserProcessId, profile);
    const cleanupCdp = {
      send: (method, parameters) => boundedProtocolOperation(
        () => browserCdp.send(method, parameters),
        method
      ),
    };
    return {
      browser,
      browserCdp,
      cleanupCdp,
      browserProcessId,
      browserProcessIdentity,
      context,
      profile,
      cleanupContext: {
        close: () => boundedProtocolOperation(
          () => browserCdp.send('Browser.close'),
          'Browser.close'
        ),
        browser: () => ({
          close: () => boundedProtocolOperation(() => browser.close(), 'browser.close'),
        }),
      },
      launchEvidence: {
        browserVersion: browser.version(),
        discoveryBrowserVersion: discovered.browserVersion,
        loopbackDevTools: true,
        noDefaults: true,
        spawnedProcessMatchedCdp: true,
        stderrBytes,
        stderrTruncated: stderrBytes > stderrTail.length,
      },
    };
  } catch (error) {
    const stopped = await stopUnidentifiedChild(
      child,
      childState,
      cdpMatchedSpawn ? browserCdp : null
    );
    const cleanupErrors = [...stopped.errors];
    if (stopped.exited) {
      try {
        await removeOwnedChromeProfile(root, profile);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Owned Chrome launch and cleanup failed'
      );
    }
    throw error;
  }
}
