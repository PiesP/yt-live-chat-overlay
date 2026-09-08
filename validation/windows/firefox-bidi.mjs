// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path';

const STARTUP_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 5_000;
const GRACEFUL_EXIT_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 75;
const PROFILE_PREFIX = '.firefox-install-profile-';

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

async function removeOwnedProfile(root, profileDir) {
  assertOwnedProfile(root, profileDir);
  await rm(profileDir, { force: true, recursive: true });
}

function runTaskkillTree(pid) {
  return new Promise((resolveTaskkill, rejectTaskkill) => {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    if (!win32.isAbsolute(systemRoot)) {
      rejectTaskkill(new Error('Windows did not expose an absolute SystemRoot directory'));
      return;
    }
    const taskkill = spawn(win32.join(systemRoot, 'System32', 'taskkill.exe'), [
      '/PID', String(pid), '/T', '/F',
    ], { stdio: 'ignore', windowsHide: true });
    taskkill.once('error', rejectTaskkill);
    taskkill.once('exit', (code) => {
      if (code === 0) resolveTaskkill();
      else rejectTaskkill(new Error(`taskkill failed for the task-owned Firefox tree (${code})`));
    });
  });
}

async function terminateOwnedProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (await waitForProcessExit(child, GRACEFUL_EXIT_TIMEOUT_MS)) return;
  if (process.platform === 'win32') {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw new Error('Task-owned Firefox process id is unavailable');
    }
    let taskkillError;
    try {
      await runTaskkillTree(child.pid);
    } catch (error) {
      taskkillError = error;
    }
    if (await waitForProcessExit(child, CLOSE_TIMEOUT_MS)) return;
    throw taskkillError ?? new Error('Task-owned Firefox process tree did not terminate');
  }
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
  { child, detachSocket = () => {}, profileDir, root, socket },
  {
    removeProfile = removeOwnedProfile,
    terminateProcessTree = terminateOwnedProcessTree,
  } = {}
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
    await terminateProcessTree(child);
    processTerminated = true;
  } catch (error) {
    errors.push(new Error(`Failed to terminate the task-owned Firefox tree: ${errorMessage(error)}`));
  }
  if (processTerminated) {
    try {
      await removeProfile(root, profileDir);
    } catch (error) {
      errors.push(new Error(`Failed to remove the task-owned Firefox profile: ${errorMessage(error)}`));
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Firefox resource cleanup failed');
}

export function buildFirefoxLaunchArguments({ profileDir, headless = false }) {
  if (typeof profileDir !== 'string' || profileDir.length === 0) {
    throw new TypeError('profileDir must be a non-empty string');
  }
  return [
    ...(headless ? ['--headless'] : []),
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
  #root;
  #socket;

  constructor({ child, socket, root, profileDir }) {
    this.#child = child;
    this.#socket = socket;
    this.#root = root;
    this.#profileDir = profileDir;
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
    const endpoint = await waitForEndpoint(child, () => output);
    const socket = await connectWebSocket(endpoint);
    session = new FirefoxBidiSession({ child, socket, root: taskRoot, profileDir });
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
      await cleanupFirefoxResources({ child, profileDir, root: taskRoot, socket: null });
    }
    throw error;
  }
}
