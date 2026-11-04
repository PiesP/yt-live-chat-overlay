// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { isIP } from 'node:net';
import { join, win32 } from 'node:path';

import type { Browser, BrowserContext, BrowserType, CDPSession } from '@playwright/test';

import {
  cleanupChromeInstallation,
  readOwnedBrowserProcessId,
  removeOwnedChromeProfile,
} from './chrome-install.ts';
import type { ChromeProcessIdentity } from './chrome-process.ts';
import {
  captureOwnedChromeProcess,
  isOwnedChromeProcess,
  terminateOwnedChromeProcess,
} from './chrome-process.ts';

const VIEWPORT = { width: 1280, height: 720 };
const DEVTOOLS_WAIT_MS = 30_000;
const CHILD_EXIT_MS = 8_000;
const STDERR_LIMIT_BYTES = 64 * 1024;
const PROTOCOL_TIMEOUT_MS = 15_000;
const IDENTITY_WAIT_MS = 8_000;
const FIXED_DEBUG_PORT = 27_683;
const VERSION_MAX_BYTES = 4096;
const VERSION_TIMEOUT_MS = 3_000;
const PORT_INSPECT_TIMEOUT_MS = 3_000;
const FAILURE_PORT_OBSERVATIONS = 16;
const FAILURE_CONNECTION_ROWS = 8;
const FAILURE_RECEIPT_MAX_BYTES = 192 * 1024;
type ChildState = { spawnError: Error | null };
type ChildStatus = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid?: number | undefined;
};
type OwnedChild = ChildStatus & {
  kill: () => boolean;
  once: (event: 'exit', listener: () => void) => unknown;
};
type Protocol = {
  send: (method: string, parameters?: Record<string, unknown>) => Promise<unknown>;
};
type Checkpoint = (name: string, phase: 'before' | 'after') => Promise<void>;
type CleanupContext = {
  close: () => Promise<unknown>;
  browser: () => { close: () => Promise<unknown> };
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function boundedProtocolOperation<T>(operation: () => Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<T>((_, reject) => {
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

export function naturalChromeArguments(profile: string, requireAutoplayGesture = false) {
  return [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=27683',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-extension-debugging',
    '--mute-audio',
    ...(requireAutoplayGesture ? ['--autoplay-policy=user-gesture-required'] : []),
    '--lang=en-US',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    'about:blank',
  ];
}

async function waitForChildExit(child: OwnedChild, timeoutMs = CHILD_EXIT_MS): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => resolveExit(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveExit(true);
    });
  });
}

type WindowsProcessRecord = {
  ProcessId: unknown;
  CreationDate: unknown;
  ExecutablePath: unknown;
  CommandLine: unknown;
};
type PortConnection = {
  localAddress: unknown;
  localPort: unknown;
  state: unknown;
  rawState: unknown;
  owningProcess: unknown;
};
type PortInspection = {
  connections: unknown[];
  process: WindowsProcessRecord | null;
};
type InspectPort = (processId?: number) => Promise<PortInspection>;

/** Unknown states or malformed rows cannot prove that the fixed port is unused. */
function classifyPortConnections(snapshot: PortInspection) {
  const states: Record<string, number> = {
    Closed: 1,
    Listen: 2,
    SynSent: 3,
    SynReceived: 4,
    Established: 5,
    FinWait1: 6,
    FinWait2: 7,
    CloseWait: 8,
    Closing: 9,
    LastAck: 10,
    TimeWait: 11,
    DeleteTCB: 12,
    Bound: 100,
  };
  const listeners: PortConnection[] = [];
  const connections = Array.isArray(snapshot?.connections) ? snapshot.connections : null;
  let complete = connections !== null;
  for (const row of connections ?? []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      complete = false;
      continue;
    }
    const connection = row as PortConnection;
    if (
      typeof connection.localAddress !== 'string' ||
      isIP(connection.localAddress) === 0 ||
      connection.localPort !== FIXED_DEBUG_PORT ||
      typeof connection.owningProcess !== 'number' ||
      !Number.isSafeInteger(connection.owningProcess) ||
      connection.owningProcess < 0 ||
      typeof connection.state !== 'string' ||
      !Object.hasOwn(states, connection.state) ||
      connection.rawState !== states[connection.state]
    ) {
      complete = false;
      continue;
    }
    if (connection.state === 'Listen') listeners.push(connection);
  }
  return { complete, connections, listeners };
}

function boundedEvidenceText(value: unknown, limit: number): string | null {
  return typeof value === 'string' ? value.slice(0, limit) : null;
}

function boundedEvidenceScalar(value: unknown, limit = 128): string | number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return boundedEvidenceText(value, limit);
}

/** Retain the existing fixed-port inspections without adding a new OS query. */
export function createNaturalPortRecorder(
  inspectPort: InspectPort = inspectFixedPort,
  now: () => number = Date.now
) {
  let stage = 'fixed-port-preflight';
  const observations: Array<Record<string, unknown>> = [];
  const retain = (observation: Record<string, unknown>) => {
    observations.push(observation);
    if (observations.length > FAILURE_PORT_OBSERVATIONS) observations.shift();
  };
  return {
    setStage(value: string) {
      stage = value;
    },
    async inspect(processId?: number): Promise<PortInspection> {
      let snapshot: PortInspection;
      try {
        snapshot = await inspectPort(processId);
      } catch (error) {
        retain({
          stage: boundedEvidenceText(stage, 64),
          atEpochMs: now(),
          requestedProcessId: processId ?? null,
          inspectionStatus: 'unavailable',
          listenerCount: null,
          connectionCount: null,
          connections: null,
          process: null,
          inspectionError: {
            name: boundedEvidenceText(error instanceof Error ? error.name : typeof error, 128),
            message: boundedEvidenceText(error instanceof Error ? error.message : error, 1024),
          },
        });
        throw error;
      }
      const { complete, connections, listeners } = classifyPortConnections(snapshot);
      const process = snapshot.process;
      retain({
        stage: boundedEvidenceText(stage, 64),
        atEpochMs: now(),
        requestedProcessId: processId ?? null,
        inspectionStatus: complete ? 'complete' : 'unavailable',
        listenerCount: connections === null ? null : listeners.length,
        connectionCount: connections?.length ?? null,
        connectionsTruncated: connections !== null && connections.length > FAILURE_CONNECTION_ROWS,
        connections:
          connections?.slice(0, FAILURE_CONNECTION_ROWS).map((row: unknown) => {
            const connection = row && typeof row === 'object' ? (row as PortConnection) : null;
            return {
              localAddress: boundedEvidenceText(connection?.localAddress, 128),
              localPort: boundedEvidenceScalar(connection?.localPort),
              state: boundedEvidenceScalar(connection?.state, 32),
              rawState: boundedEvidenceScalar(connection?.rawState, 32),
              owningProcess: boundedEvidenceScalar(connection?.owningProcess),
            };
          }) ?? null,
        process: process
          ? {
              ProcessId: boundedEvidenceScalar(process.ProcessId),
              CreationDate: boundedEvidenceText(process.CreationDate, 128),
              ExecutablePath: boundedEvidenceText(process.ExecutablePath, 512),
              CommandLine: boundedEvidenceText(process.CommandLine, 2048),
              commandLineTruncated:
                typeof process.CommandLine === 'string' && process.CommandLine.length > 2048,
              commandLineSha256:
                typeof process.CommandLine === 'string'
                  ? createHash('sha256').update(process.CommandLine).digest('hex')
                  : null,
            }
          : null,
      });
      return snapshot;
    },
    observations: () => observations.slice(),
    stage: () => stage,
  };
}

function powershellExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  assert(win32.isAbsolute(systemRoot), 'Windows SystemRoot must be absolute');
  return win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Inspect one declared port without making a network connection. */
export function inspectFixedPort(
  processId?: number,
  { runPowerShell = execFile }: { runPowerShell?: typeof execFile } = {}
): Promise<PortInspection> {
  if (processId !== undefined)
    assert(Number.isSafeInteger(processId) && processId > 0, 'Invalid owned Chrome process id');
  const script = [
    "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'",
    '$connections=@(Get-NetTCPConnection -ErrorAction Stop | ' +
      `Where-Object { [int]$_.LocalPort -eq ${FIXED_DEBUG_PORT} } | ` +
      'ForEach-Object { @{localAddress=[string]$_.LocalAddress;localPort=$_.LocalPort;' +
      "state=[string]$_.State;rawState=$_.CimInstanceProperties['State'].Value;" +
      'owningProcess=$_.OwningProcess} })',
    processId === undefined
      ? '$record=$null'
      : `$record=Get-CimInstance Win32_Process -Filter 'ProcessId = ${processId}' ` +
        '-ErrorAction Stop | Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine',
    '@{connections=$connections;process=$record}|ConvertTo-Json -Compress -Depth 4',
  ].join(';');
  return new Promise((resolveInspection, rejectInspection) => {
    runPowerShell(
      powershellExecutable(),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { encoding: 'utf8', maxBuffer: 65_536, timeout: PORT_INSPECT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          rejectInspection(error);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout.trim().replace(/^\uFEFF/u, ''));
          assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
          assert('connections' in parsed && Array.isArray(parsed.connections));
          assert(
            'process' in parsed &&
              (parsed.process === null ||
                (typeof parsed.process === 'object' && !Array.isArray(parsed.process)))
          );
          resolveInspection(parsed as PortInspection);
        } catch (parseError) {
          rejectInspection(parseError);
        }
      }
    );
  });
}

function assertChildLive(child: ChildStatus, childState: ChildState): void {
  if (childState.spawnError) throw childState.spawnError;
  if (child.exitCode !== null || child.signalCode !== null)
    throw new Error('Owned Chrome exited before its DevTools endpoint was ready');
}

export async function assertFixedPortUnused({
  inspectPort = inspectFixedPort,
}: { inspectPort?: InspectPort } = {}): Promise<void> {
  const snapshot = await inspectPort();
  const { complete, listeners } = classifyPortConnections(snapshot);
  assert(complete, 'Fixed DevTools port inspection unavailable or unsupported');
  assert.equal(listeners.length, 0, 'Fixed DevTools port is already in use');
}

export async function verifyOwnedFixedPort(
  child: ChildStatus,
  childState: ChildState,
  identity: ChromeProcessIdentity,
  { inspectPort = inspectFixedPort }: { inspectPort?: InspectPort } = {}
): Promise<boolean> {
  assertChildLive(child, childState);
  assert.equal(
    child.pid,
    identity.processId,
    'Spawned Chrome PID changed before port verification'
  );
  const snapshot = await inspectPort(identity.processId);
  assertChildLive(child, childState);
  const { complete, listeners } = classifyPortConnections(snapshot);
  assert(complete, 'Fixed DevTools port inspection unavailable or unsupported');
  assert(
    isOwnedChromeProcess(snapshot.process, identity),
    'Owned Chrome CIM identity changed before DevTools access'
  );
  if (listeners.length === 0) return false;
  assert.equal(listeners.length, 1, 'Fixed DevTools port has ambiguous listeners');
  const [listener] = listeners;
  assert(
    listener &&
      listener.localAddress === '127.0.0.1' &&
      listener.localPort === FIXED_DEBUG_PORT &&
      listener.state === 'Listen' &&
      listener.owningProcess === identity.processId,
    'Fixed DevTools listener is not exact owned IPv4 loopback'
  );
  return true;
}

/** The only HTTP request is the fixed IPv4 loopback JSON version endpoint. */
export function fetchFixedVersion({
  requestVersion = request,
}: { requestVersion?: typeof request } = {}): Promise<Buffer> {
  return new Promise((resolveVersion, rejectVersion) => {
    let settled = false;
    const timer: { handle?: ReturnType<typeof setTimeout> } = {};
    const finish = (error: Error | null, bytes?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer.handle);
      if (error) rejectVersion(error);
      else if (bytes) resolveVersion(bytes);
      else rejectVersion(new Error('Fixed DevTools JSON response unavailable'));
    };
    const client = requestVersion(
      {
        protocol: 'http:',
        hostname: '127.0.0.1',
        family: 4,
        port: FIXED_DEBUG_PORT,
        path: '/json/version',
        method: 'GET',
        agent: false,
      },
      (response) => {
        if (response.statusCode !== 200) {
          client.destroy(new Error('Fixed DevTools JSON response was not HTTP 200'));
          return;
        }
        const length = Number(response.headers['content-length']);
        if (Number.isFinite(length) && length > VERSION_MAX_BYTES) {
          client.destroy(new Error('Fixed DevTools JSON response exceeded byte cap'));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > VERSION_MAX_BYTES) {
            client.destroy(new Error('Fixed DevTools JSON response exceeded byte cap'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('end', () => finish(null, Buffer.concat(chunks, total)));
        response.once('error', (error) => finish(error));
        response.once('close', () => {
          if (!response.complete) finish(new Error('Fixed DevTools JSON response ended early'));
        });
      }
    );
    client.once('error', (error) => finish(error));
    timer.handle = setTimeout(
      () => client.destroy(new Error('Fixed DevTools JSON deadline exceeded')),
      VERSION_TIMEOUT_MS
    );
    client.end();
  });
}

export function parseFixedVersion(bytes: Buffer): string {
  assert(
    Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= VERSION_MAX_BYTES,
    'Fixed DevTools JSON response has invalid size'
  );
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  assert(
    parsed && typeof parsed === 'object' && !Array.isArray(parsed),
    'Fixed DevTools JSON response has invalid shape'
  );
  const raw = 'webSocketDebuggerUrl' in parsed ? parsed.webSocketDebuggerUrl : null;
  assert(
    typeof raw === 'string' &&
      /^ws:\/\/127\.0\.0\.1:27683\/devtools\/browser\/[A-Za-z0-9._-]{1,256}$/u.test(raw),
    'Fixed DevTools Browser endpoint is not literal owned loopback'
  );
  const endpoint = new URL(raw);
  assert(
    endpoint.href === raw &&
      endpoint.protocol === 'ws:' &&
      endpoint.hostname === '127.0.0.1' &&
      endpoint.port === String(FIXED_DEBUG_PORT) &&
      endpoint.username === '' &&
      endpoint.password === '' &&
      endpoint.search === '' &&
      endpoint.hash === '',
    'Fixed DevTools Browser endpoint was normalized'
  );
  return raw;
}

export async function readOwnedFixedPortEndpoint(
  child: ChildStatus,
  childState: ChildState,
  identity: ChromeProcessIdentity,
  {
    inspectPort = inspectFixedPort,
    fetchVersion = fetchFixedVersion,
    sleep = delay,
    timeoutMs = DEVTOOLS_WAIT_MS,
  }: {
    inspectPort?: InspectPort;
    fetchVersion?: () => Promise<Buffer>;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {}
): Promise<string> {
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= DEVTOOLS_WAIT_MS);
  const deadline = Date.now() + timeoutMs;
  do {
    const ready = await verifyOwnedFixedPort(child, childState, identity, { inspectPort });
    if (ready) return parseFixedVersion(await fetchVersion());
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(Math.min(100, remaining));
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for the exact owned IPv4 DevTools listener');
}

export async function connectOwnedFixedPort(
  chromium: BrowserType,
  endpoint: string,
  child: ChildStatus,
  childState: ChildState,
  identity: ChromeProcessIdentity,
  { inspectPort = inspectFixedPort }: { inspectPort?: InspectPort } = {}
): Promise<Browser> {
  // Validate the raw string again before any WebSocket connection.
  assert.equal(
    parseFixedVersion(Buffer.from(JSON.stringify({ webSocketDebuggerUrl: endpoint }))),
    endpoint
  );
  assert(
    await verifyOwnedFixedPort(child, childState, identity, { inspectPort }),
    'Owned IPv4 DevTools listener disappeared before connect'
  );
  return chromium.connectOverCDP(endpoint, {
    noDefaults: true,
    isLocal: true,
    timeout: 10_000,
  });
}

async function discoverInstalledChrome(
  chromium: BrowserType,
  root: string,
  output: string,
  checkpoint: Checkpoint
) {
  const profile = await mkdtemp(join(root, 'chrome-install-'));
  const result = { cleanup: {} };
  let context: BrowserContext | undefined;
  let cdp: CDPSession | undefined;
  let browserProcessId: number | undefined;
  let browserProcessIdentity: ChromeProcessIdentity | undefined;
  let primaryError: unknown;
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
    const browser = context.browser();
    assert(browser);
    cdp = await browser.newBrowserCDPSession();
    browserProcessId = readOwnedBrowserProcessId(await cdp.send('SystemInfo.getProcessInfo'));
    browserProcessIdentity = await captureOwnedChromeProcess(browserProcessId, profile);
    return {
      browserVersion: browser.version(),
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
  child: OwnedChild,
  childState: ChildState,
  browserCdp: Protocol | null,
  {
    waitForChildExit: wait = waitForChildExit,
  }: { waitForChildExit?: (child: OwnedChild, timeoutMs?: number) => Promise<boolean> } = {}
) {
  const errors: unknown[] = [];
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

export async function captureSpawnedChromeIdentity(
  child: ChildStatus,
  childState: ChildState,
  profile: string,
  executablePath: string,
  {
    captureProcess = captureOwnedChromeProcess,
    sleep = delay,
    timeoutMs = IDENTITY_WAIT_MS,
  }: {
    captureProcess?: typeof captureOwnedChromeProcess;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    if (childState.spawnError) throw childState.spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Owned Chrome exited before its process identity was captured');
    }
    const pid = child.pid;
    if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) {
      try {
        const identity = await captureProcess(pid, profile);
        assert.equal(
          identity.executablePath.toLowerCase(),
          executablePath.toLowerCase(),
          'Spawned Chrome executable did not match the discovered installation'
        );
        return identity;
      } catch (error) {
        lastError = error;
      }
    }
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error('Timed out capturing the spawned Chrome process identity', {
    cause: lastError,
  });
}

export async function cleanupFailedNaturalChrome(
  {
    child,
    childState,
    browserProcessIdentity,
    profile,
    root,
  }: {
    child: OwnedChild;
    childState: ChildState;
    browserProcessIdentity: ChromeProcessIdentity | null | undefined;
    profile: string;
    root: string;
  },
  {
    removeProfile = removeOwnedChromeProfile,
    stopChild = stopUnidentifiedChild,
    terminateProcessTree = terminateOwnedChromeProcess,
  }: {
    removeProfile?: typeof removeOwnedChromeProfile;
    stopChild?: typeof stopUnidentifiedChild;
    terminateProcessTree?: (identity: ChromeProcessIdentity) => Promise<unknown>;
  } = {}
) {
  const errors: unknown[] = [];
  const cleanup = {
    directChildExited: false,
    processIdentityCaptured: Boolean(browserProcessIdentity),
    processTreeExited: false,
    profilePreserved: false,
    profileRemovalFailed: false,
    profileRemoved: false,
  };
  if (browserProcessIdentity) {
    try {
      await terminateProcessTree(browserProcessIdentity);
      cleanup.processTreeExited = true;
    } catch (error) {
      errors.push(error);
    }
  } else {
    const stopped = await stopChild(child, childState, null);
    cleanup.directChildExited = stopped.exited;
    errors.push(...stopped.errors);
    const spawnFailedWithoutPid =
      Boolean(childState.spawnError) && !Number.isSafeInteger(child.pid);
    if (spawnFailedWithoutPid && stopped.exited && stopped.errors.length === 0) {
      cleanup.processTreeExited = true;
    } else {
      cleanup.profilePreserved = true;
      errors.push(
        new Error(
          'Chrome process-tree exit could not be proven without a captured identity; profile preserved'
        )
      );
    }
  }
  if (cleanup.processTreeExited) {
    try {
      await removeProfile(root, profile);
      cleanup.profileRemoved = true;
    } catch (error) {
      errors.push(error);
      cleanup.profileRemovalFailed = true;
    }
  } else {
    cleanup.profilePreserved = true;
  }
  return { cleanup, errors };
}

/**
 * Spawn a task-owned Chrome process and attach without Playwright launch defaults.
 * This is required for the browser's native visible-hidden-visible tab lifecycle.
 */
export async function launchOwnedNaturalChrome({
  chromium,
  root,
  output,
  checkpoint = async (_name: string, _phase: 'before' | 'after') => {},
  requireAutoplayGesture = false,
}: {
  chromium: BrowserType;
  root: string;
  output: string;
  checkpoint?: Checkpoint;
  requireAutoplayGesture?: boolean;
}) {
  const discovered = await discoverInstalledChrome(chromium, root, output, checkpoint);
  const portEvidence = createNaturalPortRecorder();
  const failWithReceipt = async (
    error: unknown,
    diagnostic: {
      attachedBrowserVersion: string | null;
      childAtFailure: Record<string, unknown> | null;
      chromeStderr: Record<string, unknown> | null;
    },
    cleanup: Record<string, unknown>,
    cleanupErrors: unknown[]
  ): Promise<never> => {
    try {
      const evidence = {
        schemaVersion: 1,
        kind: 'natural-chrome-launch',
        status: 'failed',
        errorType: boundedEvidenceText(error instanceof Error ? error.name : typeof error, 128),
        diagnostic: {
          stage: portEvidence.stage(),
          discoveryBrowserVersion: boundedEvidenceText(discovered.browserVersion, 128),
          ...diagnostic,
          portObservations: portEvidence.observations(),
        },
        cleanup: {
          ...cleanup,
          errorCount: cleanupErrors.length,
        },
      };
      const serialized = JSON.stringify(evidence, null, 2);
      assert(
        Buffer.byteLength(serialized, 'utf8') <= FAILURE_RECEIPT_MAX_BYTES,
        'Natural Chrome failure evidence exceeded its byte cap'
      );
      await writeFile(join(output, 'natural-chrome-launch-result.json'), serialized);
    } catch (evidenceError) {
      cleanupErrors.push(evidenceError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'Owned Chrome launch and cleanup failed');
    }
    throw error;
  };
  try {
    await assertFixedPortUnused({ inspectPort: portEvidence.inspect });
  } catch (error) {
    return failWithReceipt(
      error,
      { attachedBrowserVersion: null, childAtFailure: null, chromeStderr: null },
      {},
      []
    );
  }
  const profile = await mkdtemp(join(root, 'chrome-install-'));
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      discovered.executablePath,
      naturalChromeArguments(profile, requireAutoplayGesture),
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: false,
      }
    );
  } catch (error) {
    await removeOwnedChromeProfile(root, profile).catch((cleanupError) => {
      throw new AggregateError([error, cleanupError], 'Owned Chrome spawn and cleanup failed');
    });
    throw error;
  }

  const childState: ChildState = { spawnError: null };
  child.once('error', (error) => {
    childState.spawnError = error;
  });
  let stderrBytes = 0;
  let stderrTail = Buffer.alloc(0);
  assert(child.stderr);
  child.stderr.on('data', (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderrBytes += bytes.length;
    stderrTail = Buffer.concat([stderrTail, bytes]).subarray(-STDERR_LIMIT_BYTES);
  });

  let browser: Browser | undefined;
  let attachedBrowserVersion: string | null = null;
  let browserCdp: CDPSession | undefined;
  let browserProcessId: number | undefined;
  let browserProcessIdentity: ChromeProcessIdentity | undefined;
  try {
    await checkpoint('natural-launch:process-identity', 'before');
    browserProcessIdentity = await captureSpawnedChromeIdentity(
      child,
      childState,
      profile,
      discovered.executablePath
    );
    browserProcessId = browserProcessIdentity.processId;
    await checkpoint('natural-launch:process-identity', 'after');
    await checkpoint('natural-launch:devtools-endpoint', 'before');
    portEvidence.setStage('devtools-endpoint');
    const endpoint = await readOwnedFixedPortEndpoint(child, childState, browserProcessIdentity, {
      inspectPort: portEvidence.inspect,
    });
    await checkpoint('natural-launch:connect', 'before');
    portEvidence.setStage('preconnect');
    browser = await connectOwnedFixedPort(
      chromium,
      endpoint,
      child,
      childState,
      browserProcessIdentity,
      { inspectPort: portEvidence.inspect }
    );
    attachedBrowserVersion = browser.version();
    await checkpoint('natural-launch:connect', 'after');
    const contexts = browser.contexts();
    assert.equal(contexts.length, 1, 'Owned Chrome did not expose one default context');
    const [context] = contexts;
    assert(context);
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(45_000);
    browserCdp = await browser.newBrowserCDPSession();
    const activeCdp = browserCdp;
    const activeBrowser = browser;
    const cdpBrowserProcessId = readOwnedBrowserProcessId(
      await browserCdp.send('SystemInfo.getProcessInfo')
    );
    assert.equal(
      cdpBrowserProcessId,
      child.pid,
      'Owned Chrome CDP browser process did not match the spawned process'
    );
    const currentIdentity = await captureOwnedChromeProcess(cdpBrowserProcessId, profile);
    assert.deepEqual(
      currentIdentity,
      browserProcessIdentity,
      'Owned Chrome process identity changed between spawn and CDP verification'
    );
    portEvidence.setStage('postconnect');
    assert(
      await verifyOwnedFixedPort(child, childState, browserProcessIdentity, {
        inspectPort: portEvidence.inspect,
      }),
      'Owned IPv4 DevTools listener changed after CDP verification'
    );
    const autoplayArgumentObserved = currentIdentity.commandLine.includes(
      '--autoplay-policy=user-gesture-required'
    );
    assert.equal(autoplayArgumentObserved, requireAutoplayGesture);
    const cleanupCdp: Protocol = {
      send: (method, parameters) =>
        boundedProtocolOperation(
          () => Reflect.apply(activeCdp.send, activeCdp, [method, parameters]) as Promise<unknown>,
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
        close: () =>
          boundedProtocolOperation(() => activeCdp.send('Browser.close'), 'Browser.close'),
        browser: () => ({
          close: () => boundedProtocolOperation(() => activeBrowser.close(), 'browser.close'),
        }),
      } satisfies CleanupContext,
      launchEvidence: {
        browserVersion: attachedBrowserVersion,
        discoveryBrowserVersion: discovered.browserVersion,
        loopbackDevTools: true,
        remoteDebuggingPort: FIXED_DEBUG_PORT,
        endpointDiscovery: 'owned-loopback-json-version',
        noDefaults: true,
        autoplayPolicy: requireAutoplayGesture ? 'user-gesture-required' : 'default',
        autoplayArgumentObserved,
        spawnedProcessMatchedCdp: true,
        stderrBytes,
        stderrTruncated: stderrBytes > stderrTail.length,
      },
    };
  } catch (error) {
    const childAtFailure = {
      pid: child.pid ?? null,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      spawnErrorName: boundedEvidenceText(childState.spawnError?.name, 128),
      spawnErrorMessage: boundedEvidenceText(childState.spawnError?.message, 1024),
    };
    const { cleanup, errors: cleanupErrors } = await cleanupFailedNaturalChrome({
      child,
      childState,
      browserProcessIdentity,
      profile,
      root,
    });
    return failWithReceipt(
      error,
      {
        attachedBrowserVersion: boundedEvidenceText(attachedBrowserVersion, 128),
        childAtFailure,
        chromeStderr: {
          totalBytes: stderrBytes,
          retainedTailBytes: stderrTail.length,
          retainedTailSha256: createHash('sha256').update(stderrTail).digest('hex'),
          retainedTailBase64: stderrTail.toString('base64'),
        },
      },
      cleanup,
      cleanupErrors
    );
  }
}
