// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';

const STARTUP_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 5_000;
const GRACEFUL_EXIT_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 75;
const PROFILE_PREFIX = '.firefox-install-profile-';
const PROFILE_REMOVE_MAX_RETRIES = 5;
const PROFILE_REMOVE_RETRY_DELAY_MS = 200;
const ENDPOINT_FILE = 'WebDriverBiDiServer.json';
const ENDPOINT_FILE_MAX_BYTES = 1024;
const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);

function errorMessage(reason) {
  return reason instanceof Error ? reason.message : String(reason);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    child.once('exit', onExit);
  });
}

function assertOwnedProfile(root, profileDir) {
  const resolvedRoot = resolve(root);
  const resolvedProfile = resolve(profileDir);
  if (
    dirname(resolvedProfile) !== resolvedRoot ||
    !basename(resolvedProfile).startsWith(PROFILE_PREFIX)
  ) {
    throw new Error('Refusing to remove a Firefox profile outside the task root');
  }
}

export async function removeOwnedProfile(root, profileDir, rmProfile = rm) {
  assertOwnedProfile(root, profileDir);
  await rmProfile(profileDir, {
    force: true,
    maxRetries: PROFILE_REMOVE_MAX_RETRIES,
    recursive: true,
    retryDelay: PROFILE_REMOVE_RETRY_DELAY_MS,
  });
}

function windowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  if (!win32.isAbsolute(systemRoot)) {
    throw new Error('Windows did not expose an absolute SystemRoot directory');
  }
  return win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function inspectWindowsFirefox(port = 0) {
  const script = `$ErrorActionPreference = 'Stop'
$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'firefox.exe'" | ForEach-Object {
  $handle = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $handle) { return }
  try {
    $cimTicks = $_.CreationDate.ToUniversalTime().Ticks
    $handleTicks = $handle.StartTime.ToUniversalTime().Ticks
    if ([Math]::Abs($cimTicks - $handleTicks) -gt [TimeSpan]::TicksPerMillisecond) { return }
    [pscustomobject]@{
      pid = [int]$_.ProcessId
      parentPid = [int]$_.ParentProcessId
      commandLine = [string]$_.CommandLine
      executablePath = [string]$_.ExecutablePath
      createdUtc = $_.CreationDate.ToUniversalTime().ToString('o')
      startTicks = [string]$handleTicks
    }
  } catch {
    return
  }
})
$listeners = @()
if (${port} -gt 0) {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object {
    $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1'
  } | ForEach-Object { [int]$_.OwningProcess })
}
ConvertTo-Json -Compress -Depth 3 -InputObject ([pscustomobject]@{ processes = $processes; listenerPids = $listeners })`;
  const { stdout } = await execFileAsync(
    windowsPowerShellPath(),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS, maxBuffer: 65_536, windowsHide: true }
  );
  const result = JSON.parse(stdout);
  if (!Array.isArray(result?.processes) || !Array.isArray(result?.listenerPids)) {
    throw new Error('Firefox process inspection returned invalid data');
  }
  return result;
}

function ownsProfileCommand(commandLine, profileDir) {
  if (typeof commandLine !== 'string') return false;
  const argument = /(?:^|\s)-{1,2}profile\s+(?:"([^"]+)"|(\S+))/iu.exec(commandLine);
  const actual = argument?.[1] ?? argument?.[2];
  return (
    typeof actual === 'string' &&
    win32.normalize(actual).toLowerCase() === win32.normalize(profileDir).toLowerCase()
  );
}

export function selectOwnedFirefoxProcesses(
  processes,
  { childPid, executablePath, expectedProcesses, profileDir, spawnedAt }
) {
  if (!Array.isArray(processes) || !Number.isSafeInteger(childPid) || childPid <= 0) return [];
  const expectedByPid = new Map((expectedProcesses ?? []).map((entry) => [entry.pid, entry]));
  const candidates = processes.filter(
    (entry) =>
      Number.isSafeInteger(entry?.pid) &&
      entry.pid > 0 &&
      Number.isSafeInteger(entry?.parentPid) &&
      typeof entry?.executablePath === 'string' &&
      win32.normalize(entry.executablePath).toLowerCase() ===
        win32.normalize(executablePath).toLowerCase() &&
      Number.isFinite(Date.parse(entry.createdUtc)) &&
      Date.parse(entry.createdUtc) >= spawnedAt - 1000 &&
      typeof entry.startTicks === 'string' &&
      /^\d+$/u.test(entry.startTicks) &&
      (!expectedByPid.has(entry.pid) ||
        (expectedByPid.get(entry.pid).createdUtc === entry.createdUtc &&
          expectedByPid.get(entry.pid).startTicks === entry.startTicks))
  );
  const byPid = new Map(candidates.map((entry) => [entry.pid, entry]));
  const selected = new Map();
  for (const entry of candidates) {
    if (expectedByPid.has(entry.pid)) {
      selected.set(entry.pid, entry);
      continue;
    }
    if (!ownsProfileCommand(entry.commandLine, profileDir)) continue;
    const lineage = [entry];
    const seen = new Set([entry.pid]);
    let parentPid = entry.parentPid;
    while (parentPid !== childPid && !seen.has(parentPid)) {
      seen.add(parentPid);
      const parent = byPid.get(parentPid);
      if (!parent) break;
      lineage.push(parent);
      parentPid = parent.parentPid;
    }
    if (parentPid !== childPid) continue;
    for (const ancestor of lineage) selected.set(ancestor.pid, ancestor);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of candidates) {
      if (selected.has(entry.pid) || !selected.has(entry.parentPid)) continue;
      selected.set(entry.pid, entry);
      changed = true;
    }
  }
  return [...selected.values()];
}

export function parseFirefoxProfileEndpoint(data) {
  if (typeof data !== 'string' || Buffer.byteLength(data) > ENDPOINT_FILE_MAX_BYTES) {
    throw new Error('Firefox BiDi endpoint metadata is oversized or invalid');
  }
  const parsed = JSON.parse(data);
  if (parsed?.ws_host !== '127.0.0.1' && parsed?.ws_host !== '::1') {
    throw new Error('Firefox BiDi endpoint is not loopback');
  }
  if (!Number.isSafeInteger(parsed.ws_port) || parsed.ws_port < 1 || parsed.ws_port > 65_535) {
    throw new Error('Firefox BiDi endpoint port is invalid');
  }
  return { host: parsed.ws_host, port: parsed.ws_port };
}

export async function readOwnedFirefoxEndpoint(profileDir, spawnedAt) {
  const path = join(profileDir, ENDPOINT_FILE);
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    );
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new Error('Firefox BiDi endpoint metadata is not a fresh ordinary file');
    }
    if (error?.code === 'ENOENT') {
      try {
        await lstat(path);
      } catch (pathError) {
        if (pathError?.code === 'ENOENT') return null;
        throw pathError;
      }
      throw new Error('Firefox BiDi endpoint metadata path is not readable');
    }
    throw error;
  }
  try {
    const opened = await file.stat();
    const pathStat = await lstat(path);
    if (
      !opened.isFile() ||
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      opened.dev !== pathStat.dev ||
      opened.ino !== pathStat.ino ||
      opened.size !== pathStat.size ||
      opened.mtimeMs !== pathStat.mtimeMs ||
      opened.size > ENDPOINT_FILE_MAX_BYTES ||
      opened.mtimeMs < spawnedAt - 1000
    ) {
      throw new Error('Firefox BiDi endpoint metadata is not a fresh ordinary file');
    }
    if (opened.size === 0) return null;
    const buffer = Buffer.alloc(ENDPOINT_FILE_MAX_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat();
    if (
      bytesRead !== opened.size ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    )
      throw new Error('Firefox BiDi endpoint metadata changed during read');
    return parseFirefoxProfileEndpoint(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await file.close();
  }
}

export function selectOwnedFirefoxListener(inspected, ownership, port) {
  const owned = selectOwnedFirefoxProcesses(inspected.processes, ownership);
  const listeners = [
    ...new Set(inspected.listenerPids.filter((pid) => Number.isSafeInteger(pid) && pid > 0)),
  ];
  const owner = owned.find((entry) => listeners.includes(entry.pid));
  if (!owner || listeners.length !== 1 || listeners[0] !== owner.pid) {
    throw new Error(`Firefox BiDi port ${port} has no verified task-owned listener`);
  }
  return owner;
}

async function rememberOwnedWindowsFirefox(child, ownership) {
  const processes = (await inspectWindowsFirefox()).processes;
  const owned = selectOwnedFirefoxProcesses(processes, { ...ownership, childPid: child.pid });
  if (
    processes.some(
      (entry) =>
        ownsProfileCommand(entry.commandLine, ownership.profileDir) &&
        !owned.some((candidate) => candidate.pid === entry.pid)
    )
  ) {
    throw new Error('Unverified Firefox process uses the task profile');
  }
  ownership.expectedProcesses = [
    ...(ownership.expectedProcesses ?? []),
    ...owned.filter(
      (entry) => !ownership.expectedProcesses?.some((expected) => expected.pid === entry.pid)
    ),
  ];
}

async function stopVerifiedWindowsFirefox(entry, ownership) {
  const script = `$ErrorActionPreference = 'Stop'
$item = Get-CimInstance Win32_Process -Filter 'ProcessId = ${entry.pid}'
if ($null -eq $item) { return }
$process = Get-Process -Id ${entry.pid} -ErrorAction SilentlyContinue
if ($null -eq $process) { return }
if ($item.ExecutablePath -ine '${ownership.executablePath.replaceAll("'", "''")}' -or
    $item.CreationDate.ToUniversalTime().ToString('o') -ne '${entry.createdUtc}' -or
    [int]$item.ParentProcessId -ne ${entry.parentPid} -or
    [string]($process.StartTime.ToUniversalTime().Ticks) -ne '${entry.startTicks}') {
  throw 'Firefox process identity changed before cleanup'
}
$process.Kill()
if (-not $process.WaitForExit(${CLOSE_TIMEOUT_MS})) { throw 'Firefox process did not exit' }`;
  await execFileAsync(
    windowsPowerShellPath(),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      timeout: CLOSE_TIMEOUT_MS + WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
      maxBuffer: 4096,
      windowsHide: true,
    }
  );
}

export async function terminateOwnedProcessTree(
  child,
  ownership,
  {
    platform = process.platform,
    inspect = inspectWindowsFirefox,
    stop = stopVerifiedWindowsFirefox,
  } = {}
) {
  if (platform === 'win32') {
    if (!ownership || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw new Error('Task-owned Firefox process identity is unavailable');
    }
    if (ownership.snapshotFailed) {
      throw new Error('Firefox process ownership snapshot failed before session shutdown');
    }
    const bound = { ...ownership, childPid: child.pid };
    const first = (await inspect()).processes;
    const processes = selectOwnedFirefoxProcesses(first, bound);
    if (
      first.some(
        (entry) =>
          ownsProfileCommand(entry.commandLine, ownership.profileDir) &&
          !processes.some((owned) => owned.pid === entry.pid)
      )
    ) {
      throw new Error('Unverified Firefox process uses the task profile');
    }
    bound.expectedProcesses = [
      ...(ownership.expectedProcesses ?? []),
      ...processes.filter(
        (entry) => !ownership.expectedProcesses?.some((expected) => expected.pid === entry.pid)
      ),
    ];
    const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
    const depth = (entry) => {
      let count = 0;
      let parentPid = entry.parentPid;
      const seen = new Set([entry.pid]);
      while (byPid.has(parentPid) && !seen.has(parentPid)) {
        seen.add(parentPid);
        parentPid = byPid.get(parentPid).parentPid;
        count++;
      }
      return count;
    };
    for (const entry of processes.sort((a, b) => depth(b) - depth(a))) await stop(entry, bound);
    const last = (await inspect()).processes;
    const remaining = selectOwnedFirefoxProcesses(last, bound);
    if (
      last.some(
        (entry) =>
          ownsProfileCommand(entry.commandLine, ownership.profileDir) &&
          !remaining.some((owned) => owned.pid === entry.pid)
      )
    ) {
      throw new Error('Unverified Firefox process uses the task profile');
    }
    const remembered = new Map(bound.expectedProcesses.map((entry) => [entry.pid, entry]));
    const liveByPid = new Map(last.map((entry) => [entry.pid, entry]));
    const remainingPids = new Set(remaining.map((entry) => entry.pid));
    const unverifiedDescendant = last.some((entry) => {
      if (
        remainingPids.has(entry.pid) ||
        typeof entry.executablePath !== 'string' ||
        win32.normalize(entry.executablePath).toLowerCase() !==
          win32.normalize(ownership.executablePath).toLowerCase() ||
        (Number.isFinite(Date.parse(entry.createdUtc)) &&
          Date.parse(entry.createdUtc) < ownership.spawnedAt - 1000)
      ) {
        return false;
      }
      let parentPid = entry.parentPid;
      const seen = new Set([entry.pid]);
      while (Number.isSafeInteger(parentPid) && !seen.has(parentPid)) {
        if (remembered.has(parentPid)) return true;
        seen.add(parentPid);
        parentPid = liveByPid.get(parentPid)?.parentPid;
      }
      return false;
    });
    if (unverifiedDescendant) {
      throw new Error('Unverified Firefox descendant remains after task-owned cleanup');
    }
    if (remaining.length > 0) throw new Error('Task-owned Firefox browser remains alive');
    if (
      child.exitCode === null &&
      child.signalCode === null &&
      !(await waitForProcessExit(child, GRACEFUL_EXIT_TIMEOUT_MS))
    ) {
      child.kill('SIGTERM');
      if (!(await waitForProcessExit(child, CLOSE_TIMEOUT_MS))) {
        throw new Error('Task-owned Firefox launcher did not terminate');
      }
    }
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (await waitForProcessExit(child, GRACEFUL_EXIT_TIMEOUT_MS)) return;
  child.kill('SIGTERM');
  if (!(await waitForProcessExit(child, CLOSE_TIMEOUT_MS))) {
    child.kill('SIGKILL');
    if (!(await waitForProcessExit(child, CLOSE_TIMEOUT_MS))) {
      throw new Error('Task-owned Firefox process did not terminate');
    }
  }
}

/** Run every cleanup phase and remove the profile only after process termination. */
export async function cleanupFirefoxResources(
  { child, detachSocket = () => {}, ownership, profileDir, root, socket },
  { removeProfile = removeOwnedProfile, terminateProcessTree = terminateOwnedProcessTree } = {}
) {
  const errors = [];
  try {
    detachSocket();
  } catch (error) {
    errors.push(new Error(`Failed to detach Firefox BiDi listeners: ${errorMessage(error)}`));
  }
  if (socket) {
    try {
      socket.close();
    } catch (error) {
      errors.push(new Error(`Failed to close the Firefox BiDi socket: ${errorMessage(error)}`));
    }
  }
  let processTerminated = false;
  try {
    await terminateProcessTree(child, ownership);
    processTerminated = true;
  } catch (error) {
    errors.push(
      new Error(`Failed to terminate the task-owned Firefox tree: ${errorMessage(error)}`)
    );
  }
  if (processTerminated) {
    try {
      await removeProfile(root, profileDir);
    } catch (error) {
      errors.push(
        new Error(`Failed to remove the task-owned Firefox profile: ${errorMessage(error)}`)
      );
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Firefox resource cleanup failed');
}

export function buildFirefoxLaunchArguments({
  profileDir,
  headless = false,
  platform = process.platform,
}) {
  if (typeof profileDir !== 'string' || profileDir.length === 0) {
    throw new TypeError('profileDir must be a non-empty string');
  }
  return [
    ...(headless ? ['--headless'] : []),
    ...(platform === 'win32' ? ['--wait-for-browser'] : []),
    '--new-instance',
    '--no-remote',
    '--profile',
    profileDir,
    '--remote-debugging-port',
    '0',
    '--remote-allow-system-access',
    'about:blank',
  ];
}

export function extensionInstallParameters(extensionPath) {
  return {
    extensionData: { type: 'path', path: extensionPath },
    'moz:permanent': false,
  };
}

export function extensionUninstallParameters(extensionId) {
  return { extension: extensionId };
}

function waitForEndpoint(child, readOutput) {
  return new Promise((resolveEndpoint, rejectEndpoint) => {
    const streams = [child.stdout, child.stderr].filter(Boolean);
    if (streams.length === 0) {
      rejectEndpoint(new Error('Firefox output streams are unavailable'));
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      rejectEndpoint(new Error('Timed out waiting for the Firefox BiDi endpoint'));
    }, STARTUP_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      for (const stream of streams) stream.removeListener('data', onData);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    };
    const onData = () => {
      const match = /WebDriver BiDi listening on (ws:\/\/(?:127\.0\.0\.1|\[::1\]):\d+)/u.exec(
        readOutput()
      );
      if (!match?.[1]) return;
      cleanup();
      resolveEndpoint(`${match[1]}/session`);
    };
    const onError = (error) => {
      cleanup();
      rejectEndpoint(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectEndpoint(
        new Error(
          `Firefox exited before publishing its BiDi endpoint (code=${String(code)}, signal=${String(signal)})`
        )
      );
    };

    for (const stream of streams) stream.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
    onData();
  });
}

export async function waitForWindowsEndpoint(
  child,
  ownership,
  { inspect = inspectWindowsFirefox, readEndpoint = readOwnedFirefoxEndpoint } = {}
) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let spawnError = null;
  let lastMetadataError = null;
  const onError = (error) => {
    spawnError = error;
  };
  child.on('error', onError);
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      let metadata;
      try {
        metadata = await readEndpoint(ownership.profileDir, ownership.spawnedAt);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        lastMetadataError = error;
      }
      if (metadata) {
        const inspected = await inspect(metadata.port);
        let owner;
        try {
          owner = selectOwnedFirefoxListener(
            inspected,
            { ...ownership, childPid: child.pid },
            metadata.port
          );
        } catch (error) {
          if (inspected.listenerPids.length > 0) throw error;
          await delay(POLL_INTERVAL_MS);
          continue;
        }
        ownership.expectedProcesses = selectOwnedFirefoxProcesses(inspected.processes, {
          ...ownership,
          childPid: child.pid,
        });
        ownership.browserPid = owner.pid;
        return `ws://${metadata.host === '::1' ? '[::1]' : metadata.host}:${metadata.port}/session`;
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error(
      lastMetadataError
        ? 'Timed out waiting for complete Firefox BiDi endpoint metadata'
        : 'Timed out waiting for a verified task-owned Firefox BiDi endpoint'
    );
  } finally {
    child.removeListener('error', onError);
  }
}

function connectWebSocket(endpoint) {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(endpoint);
    const timeout = setTimeout(() => {
      cleanup();
      socket.close();
      rejectSocket(new Error('Timed out connecting to the Firefox BiDi endpoint'));
    }, STARTUP_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };
    const onOpen = () => {
      cleanup();
      resolveSocket(socket);
    };
    const onError = () => {
      cleanup();
      rejectSocket(new Error('Failed to connect to the Firefox BiDi endpoint'));
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
  });
}

class FirefoxBidiSession {
  pageErrors = [];
  pageLogs = [];
  browserName = 'Firefox';
  browserVersion = 'unknown';
  platformName = 'unknown';
  context = 'pending';
  #child;
  #closed = false;
  #commandId = 0;
  #eventErrors = [];
  #eventListeners = new Map();
  #logSubscribed = false;
  #pendingCommands = new Map();
  #profileDir;
  #ownership;
  #root;
  #socket;

  constructor({ child, socket, root, profileDir, ownership }) {
    this.#child = child;
    this.#socket = socket;
    this.#root = root;
    this.#profileDir = profileDir;
    this.#ownership = ownership;
    socket.addEventListener('message', this.#handleMessage);
    socket.addEventListener('close', this.#handleClose);
  }

  #handleMessage = (event) => {
    if (typeof event.data !== 'string') return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      this.#eventErrors.push(`Invalid BiDi JSON: ${errorMessage(error)}`);
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.#pendingCommands.get(message.id);
      if (!pending) return;
      this.#pendingCommands.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.type === 'error') {
        pending.reject(
          new Error(`${String(message.error ?? 'BiDi error')}: ${String(message.message ?? '')}`)
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== 'string') return;
    const listeners = this.#eventListeners.get(message.method);
    if (!listeners) return;
    const params =
      typeof message.params === 'object' && message.params !== null ? message.params : {};
    for (const listener of listeners) {
      void Promise.resolve()
        .then(() => listener(params))
        .catch((error) => {
          this.#eventErrors.push(`${message.method}: ${errorMessage(error)}`);
        });
    }
  };

  #handleClose = () => {
    const error = new Error('Firefox BiDi socket closed');
    if (!this.#closed) this.#eventErrors.push(error.message);
    for (const pending of this.#pendingCommands.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pendingCommands.clear();
  };

  #on(method, listener) {
    const listeners = this.#eventListeners.get(method) ?? new Set();
    listeners.add(listener);
    this.#eventListeners.set(method, listeners);
  }

  #off(method, listener) {
    const listeners = this.#eventListeners.get(method);
    listeners?.delete(listener);
    if (listeners?.size === 0) this.#eventListeners.delete(method);
  }

  #assertHealthy() {
    const [eventError] = this.#eventErrors;
    if (eventError) throw new Error(`Firefox BiDi event handler failed: ${eventError}`);
  }

  clearPageLogs() {
    this.pageLogs.length = 0;
  }

  command(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    try {
      this.#assertHealthy();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)));
    }
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`Cannot send ${method}: Firefox BiDi session is closed`));
    }

    const id = ++this.#commandId;
    return new Promise((resolveCommand, rejectCommand) => {
      const timeout = setTimeout(() => {
        this.#pendingCommands.delete(id);
        rejectCommand(new Error(`Firefox BiDi command timed out: ${method}`));
      }, timeoutMs);
      this.#pendingCommands.set(id, {
        reject: rejectCommand,
        resolve: resolveCommand,
        timeout,
      });
      try {
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        this.#pendingCommands.delete(id);
        rejectCommand(new Error(`Failed to send ${method}: ${errorMessage(error)}`));
      }
    });
  }

  async evaluateJson(expression) {
    const response = await this.command('script.evaluate', {
      awaitPromise: true,
      expression: `Promise.resolve(${expression}).then((value) => JSON.stringify(value))`,
      target: { context: this.context },
    });
    if (response.type === 'exception') {
      throw new Error(
        `Firefox page evaluation failed: ${response.exceptionDetails?.text ?? 'unknown exception'}`
      );
    }
    const remote = response.result;
    if (!remote) throw new Error('Firefox page evaluation omitted its result');
    if (remote.type !== 'string' || typeof remote.value !== 'string') {
      throw new Error(`Firefox page evaluation returned ${remote.type}, expected a JSON string`);
    }
    return JSON.parse(remote.value);
  }

  async waitFor(expression, description, timeoutMs = COMMAND_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      this.#assertHealthy();
      try {
        if (await this.evaluateJson(expression)) return;
        lastError = null;
      } catch (error) {
        lastError = errorMessage(error);
      }
      await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    }
    throw new Error(
      `Timed out waiting for ${description}${lastError ? `. Last evaluation error: ${lastError}` : ''}`
    );
  }

  async subscribeLogs() {
    if (this.#logSubscribed) return;
    this.#on('log.entryAdded', (params) => {
      if (this.pageLogs.length >= 500) this.pageLogs.shift();
      const entry = {
        level: String(params.level ?? 'unknown'),
        text: String(params.text ?? ''),
        type: String(params.type ?? 'unknown'),
      };
      this.pageLogs.push(entry);
      if (entry.level === 'error') this.pageErrors.push(entry);
    });
    await this.command('session.subscribe', { events: ['log.entryAdded'] });
    this.#logSubscribed = true;
  }

  async startMockYouTube({ chatResponseJson, nonWatchHtml, watchHtml }) {
    const beforeRequest = async (params) => {
      if (params.isBlocked !== true) return;
      const request = params.request;
      if (typeof request !== 'object' || request === null) {
        throw new Error('network.beforeRequestSent omitted request data');
      }
      const requestId = request.request;
      const requestUrl = request.url;
      if (typeof requestId !== 'string' || typeof requestUrl !== 'string') {
        throw new Error('network.beforeRequestSent contained malformed request data');
      }
      const url = new URL(requestUrl);
      if (url.hostname !== 'www.youtube.com') {
        throw new Error('The deterministic fixture intercepted an unexpected host');
      }
      if (typeof params.navigation !== 'string') {
        if (url.pathname.startsWith('/youtubei/v1/live_chat/')) {
          await this.command('network.provideResponse', {
            body: { type: 'string', value: chatResponseJson },
            headers: [
              {
                name: 'content-type',
                value: { type: 'string', value: 'application/json; charset=utf-8' },
              },
            ],
            request: requestId,
            statusCode: 200,
          });
          return;
        }
        await this.command('network.provideResponse', {
          request: requestId,
          statusCode: 204,
        });
        return;
      }
      const isWatchPage = url.pathname === '/watch' || url.pathname.startsWith('/live/');
      await this.command('network.provideResponse', {
        body: { type: 'string', value: isWatchPage ? watchHtml : nonWatchHtml },
        headers: [
          {
            name: 'content-type',
            value: { type: 'string', value: 'text/html; charset=utf-8' },
          },
        ],
        request: requestId,
        statusCode: 200,
      });
    };

    await this.subscribeLogs();
    this.#on('network.beforeRequestSent', beforeRequest);
    await this.command('session.subscribe', { events: ['network.beforeRequestSent'] });
    const result = await this.command('network.addIntercept', {
      phases: ['beforeRequestSent'],
      urlPatterns: [{ type: 'pattern', protocol: 'https', hostname: 'www.youtube.com' }],
    });
    if (typeof result?.intercept !== 'string') {
      this.#off('network.beforeRequestSent', beforeRequest);
      throw new Error('Firefox did not return the deterministic network intercept id');
    }
    let stopped = false;
    return async () => {
      if (stopped) return;
      stopped = true;
      this.#off('network.beforeRequestSent', beforeRequest);
      await this.command('network.removeIntercept', { intercept: result.intercept });
    };
  }

  async installExtension(extensionPath) {
    const result = await this.command(
      'webExtension.install',
      extensionInstallParameters(extensionPath)
    );
    if (typeof result?.extension !== 'string') {
      throw new Error('Firefox did not return the installed extension id');
    }
    return result.extension;
  }

  async uninstallExtension(extensionId) {
    await this.command('webExtension.uninstall', extensionUninstallParameters(extensionId));
  }

  async navigate(url, { wait = 'complete', timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
    await this.command(
      'browsingContext.navigate',
      {
        context: this.context,
        url,
        wait,
      },
      timeoutMs
    );
  }

  async reload() {
    await this.command('browsingContext.reload', {
      context: this.context,
      wait: 'complete',
    });
  }

  async captureScreenshot() {
    const result = await this.command(
      'browsingContext.captureScreenshot',
      { context: this.context, origin: 'viewport' },
      10_000
    );
    return Buffer.from(result.data, 'base64');
  }

  async close() {
    if (this.#closed) return;
    try {
      if (process.platform === 'win32') {
        try {
          await rememberOwnedWindowsFirefox(this.#child, this.#ownership);
        } catch (error) {
          this.#ownership.snapshotFailed = true;
          throw error;
        }
      }
      if (this.#socket.readyState === WebSocket.OPEN) {
        await Promise.race([
          this.command('session.end', {}, CLOSE_TIMEOUT_MS).catch(() => undefined),
          delay(CLOSE_TIMEOUT_MS),
        ]);
      }
    } finally {
      this.#closed = true;
      this.#handleClose();
      await cleanupFirefoxResources({
        child: this.#child,
        detachSocket: () => {
          this.#socket.removeEventListener('message', this.#handleMessage);
          this.#socket.removeEventListener('close', this.#handleClose);
        },
        profileDir: this.#profileDir,
        ownership: this.#ownership,
        root: this.#root,
        socket: this.#socket,
      });
    }
  }
}

export async function launchFirefoxBidi({ root, executablePath, headless = false }) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('root must be a non-empty string');
  }
  if (typeof executablePath !== 'string' || !isAbsolute(executablePath)) {
    throw new TypeError('executablePath must be an absolute path');
  }
  const executable = await stat(executablePath);
  if (!executable.isFile()) throw new Error('executablePath must identify the Firefox executable');

  const taskRoot = resolve(root);
  await mkdir(taskRoot, { recursive: true });
  const profileDir = await mkdtemp(join(taskRoot, PROFILE_PREFIX));
  assertOwnedProfile(taskRoot, profileDir);
  const ownership = { executablePath, profileDir, spawnedAt: Date.now() };
  const child = spawn(executablePath, buildFirefoxLaunchArguments({ profileDir, headless }), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: headless,
  });
  let output = '';
  const captureOutput = (chunk) => {
    output = `${output}${chunk.toString('utf8')}`.slice(-32_768);
  };
  child.stdout?.on('data', captureOutput);
  child.stderr?.on('data', captureOutput);

  let session = null;
  try {
    const endpoint =
      process.platform === 'win32'
        ? await waitForWindowsEndpoint(child, ownership)
        : await waitForEndpoint(child, () => output);
    const socket = await connectWebSocket(endpoint);
    session = new FirefoxBidiSession({ child, socket, root: taskRoot, profileDir, ownership });
    const created = await session.command('session.new', { capabilities: {} });
    const capabilities = created?.capabilities ?? {};
    session.browserName = String(capabilities.browserName ?? 'Firefox');
    session.browserVersion = String(capabilities.browserVersion ?? 'unknown');
    session.platformName = String(capabilities.platformName ?? 'unknown');

    const tree = await session.command('browsingContext.getTree', { maxDepth: 0 });
    const contexts = Array.isArray(tree?.contexts) ? tree.contexts : [];
    const initialContext =
      contexts.find((entry) => entry?.url === 'about:blank') ?? contexts.find(Boolean);
    if (typeof initialContext?.context !== 'string') {
      throw new Error('Firefox did not expose an initial browsing context');
    }
    session.context = initialContext.context;
    await session.command('browsingContext.setViewport', {
      context: session.context,
      viewport: { height: 800, width: 1280 },
    });
    return session;
  } catch (error) {
    if (session) {
      await session.close();
    } else {
      await cleanupFirefoxResources({ child, ownership, profileDir, root: taskRoot, socket: null });
    }
    throw error;
  }
}
