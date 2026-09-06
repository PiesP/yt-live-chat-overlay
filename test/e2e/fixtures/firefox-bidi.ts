// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { firefox } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STARTUP_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 50;

type BidiParams = Record<string, unknown>;
type BidiEventListener = (params: BidiParams) => void | Promise<void>;

interface PendingCommand {
  reject: (reason: Error) => void;
  resolve: (result: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface BidiMessage {
  error?: unknown;
  id?: unknown;
  message?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  stacktrace?: unknown;
  type?: unknown;
}

interface ContextTreeResult {
  contexts: Array<{ context: string; url: string }>;
}

interface ScriptEvaluateResult {
  exceptionDetails?: { text?: string };
  result?: { type: string; value?: unknown };
  type: 'exception' | 'success';
}

interface ExtensionInstallResult {
  extension: string;
}

export interface FirefoxBidiSession {
  readonly context: string;
  readonly pageErrors: readonly string[];
  readonly pageLogs: readonly { args?: unknown; level: string; text: string }[];
  captureScreenshot(): Promise<Buffer>;
  clearPageLogs(): void;
  close(): Promise<void>;
  command<T>(method: string, params?: BidiParams, timeoutMs?: number): Promise<T>;
  evaluateJson<T>(expression: string): Promise<T>;
  installExtension(extensionPath?: string): Promise<string>;
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  serveMockYouTube(options: {
    chatResponseJson?: string;
    nonWatchHtml: string;
    watchHtml: string;
  }): Promise<void>;
  waitFor(expression: string, description: string, timeoutMs?: number): Promise<void>;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    child.once('exit', onExit);
  });
}

function waitForEndpoint(child: ChildProcess, readStderr: () => string): Promise<string> {
  return new Promise((resolveEndpoint, rejectEndpoint) => {
    const stderr = child.stderr;
    if (!stderr) {
      rejectEndpoint(new Error('Firefox stderr is unavailable'));
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      rejectEndpoint(
        new Error(`Timed out waiting for Firefox BiDi endpoint. stderr:\n${readStderr()}`)
      );
    }, STARTUP_TIMEOUT_MS);

    const cleanup = (): void => {
      clearTimeout(timeout);
      stderr.removeListener('data', onData);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    };
    const onData = (): void => {
      const match = /WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)/.exec(readStderr());
      if (!match?.[1]) return;
      cleanup();
      resolveEndpoint(`${match[1]}/session`);
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectEndpoint(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      rejectEndpoint(
        new Error(
          `Firefox exited before publishing its BiDi endpoint (code=${String(code)}, signal=${String(signal)}). stderr:\n${readStderr()}`
        )
      );
    };

    stderr.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
    onData();
  });
}

function connectWebSocket(endpoint: string): Promise<WebSocket> {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(endpoint);
    const timeout = setTimeout(() => {
      cleanup();
      socket.close();
      rejectSocket(new Error(`Timed out connecting to Firefox BiDi endpoint ${endpoint}`));
    }, STARTUP_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };
    const onOpen = (): void => {
      cleanup();
      resolveSocket(socket);
    };
    const onError = (): void => {
      cleanup();
      rejectSocket(new Error(`Failed to connect to Firefox BiDi endpoint ${endpoint}`));
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
  });
}

class FirefoxBidiSessionImpl implements FirefoxBidiSession {
  readonly pageErrors: string[] = [];
  readonly pageLogs: Array<{ args?: unknown; level: string; text: string }> = [];
  private closed = false;
  private commandId = 0;
  private readonly eventErrors: string[] = [];
  private readonly eventListeners = new Map<string, Set<BidiEventListener>>();
  private readonly pendingCommands = new Map<number, PendingCommand>();

  constructor(
    private readonly child: ChildProcess,
    private readonly socket: WebSocket,
    private readonly profileDir: string,
    public context: string
  ) {
    socket.addEventListener('message', this.handleMessage);
    socket.addEventListener('close', this.handleClose);
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    if (typeof event.data !== 'string') return;
    let message: BidiMessage;
    try {
      message = JSON.parse(event.data) as BidiMessage;
    } catch (error: unknown) {
      this.eventErrors.push(`Invalid BiDi JSON: ${errorMessage(error)}`);
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.pendingCommands.get(message.id);
      if (!pending) return;
      this.pendingCommands.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.type === 'error') {
        pending.reject(
          new Error(
            `${String(message.error ?? 'BiDi error')}: ${String(message.message ?? '')}` +
              (message.stacktrace ? `\n${String(message.stacktrace)}` : '')
          )
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== 'string') return;
    const listeners = this.eventListeners.get(message.method);
    if (!listeners) return;
    const params =
      typeof message.params === 'object' && message.params !== null
        ? (message.params as BidiParams)
        : {};
    for (const listener of listeners) {
      void Promise.resolve()
        .then(() => listener(params))
        .catch((error: unknown) => {
          this.eventErrors.push(`${message.method}: ${errorMessage(error)}`);
        });
    }
  };

  private readonly handleClose = (): void => {
    const error = new Error('Firefox BiDi socket closed');
    if (!this.closed) this.eventErrors.push(error.message);
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingCommands.clear();
  };

  private on(method: string, listener: BidiEventListener): void {
    const listeners = this.eventListeners.get(method) ?? new Set<BidiEventListener>();
    listeners.add(listener);
    this.eventListeners.set(method, listeners);
  }

  private assertHealthy(): void {
    const [eventError] = this.eventErrors;
    if (eventError) throw new Error(`Firefox BiDi event handler failed: ${eventError}`);
  }

  clearPageLogs(): void {
    this.pageLogs.length = 0;
  }

  command<T>(method: string, params: BidiParams = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    try {
      this.assertHealthy();
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)));
    }
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`Cannot send ${method}: Firefox BiDi session is closed`));
    }

    const id = ++this.commandId;
    return new Promise<T>((resolveCommand, rejectCommand) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(id);
        rejectCommand(new Error(`Firefox BiDi command timed out: ${method}`));
      }, timeoutMs);
      this.pendingCommands.set(id, {
        reject: rejectCommand,
        resolve: (result) => resolveCommand(result as T),
        timeout,
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error: unknown) {
        clearTimeout(timeout);
        this.pendingCommands.delete(id);
        rejectCommand(new Error(`Failed to send ${method}: ${errorMessage(error)}`));
      }
    });
  }

  async evaluateJson<T>(expression: string): Promise<T> {
    const response = await this.command<ScriptEvaluateResult>('script.evaluate', {
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
    return JSON.parse(remote.value) as T;
  }

  async waitFor(
    expression: string,
    description: string,
    timeoutMs = COMMAND_TIMEOUT_MS
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: string | null = null;
    while (Date.now() < deadline) {
      this.assertHealthy();
      try {
        if (await this.evaluateJson<boolean>(expression)) return;
        lastError = null;
      } catch (error: unknown) {
        lastError = errorMessage(error);
      }
      await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    }
    throw new Error(
      `Timed out waiting for ${description}${lastError ? `. Last evaluation error: ${lastError}` : ''}`
    );
  }

  async serveMockYouTube(options: {
    chatResponseJson?: string;
    nonWatchHtml: string;
    watchHtml: string;
  }): Promise<void> {
    this.on('network.beforeRequestSent', async (params) => {
      if (params.isBlocked !== true) return;
      const request = params.request;
      if (typeof request !== 'object' || request === null) {
        throw new Error('network.beforeRequestSent omitted request data');
      }
      const requestRecord = request as Record<string, unknown>;
      if (typeof requestRecord.request !== 'string' || typeof requestRecord.url !== 'string') {
        throw new Error('network.beforeRequestSent contained malformed request data');
      }
      const url = new URL(requestRecord.url);
      if (url.hostname !== 'www.youtube.com') {
        throw new Error(`Unexpected intercepted hostname: ${url.hostname}`);
      }
      if (typeof params.navigation !== 'string') {
        if (
          options.chatResponseJson !== undefined &&
          url.pathname.startsWith('/youtubei/v1/live_chat/')
        ) {
          await this.command('network.provideResponse', {
            body: { type: 'string', value: options.chatResponseJson },
            headers: [
              {
                name: 'content-type',
                value: { type: 'string', value: 'application/json; charset=utf-8' },
              },
            ],
            request: requestRecord.request,
            statusCode: 200,
          });
          return;
        }
        await this.command('network.provideResponse', {
          request: requestRecord.request,
          statusCode: 204,
        });
        return;
      }
      const isWatchPage = url.pathname === '/watch' || url.pathname.startsWith('/live/');
      await this.command('network.provideResponse', {
        body: { type: 'string', value: isWatchPage ? options.watchHtml : options.nonWatchHtml },
        headers: [
          { name: 'content-type', value: { type: 'string', value: 'text/html; charset=utf-8' } },
        ],
        request: requestRecord.request,
        statusCode: 200,
      });
    });
    this.on('log.entryAdded', (params) => {
      const level = String(params.level ?? 'unknown');
      const text = String(params.text ?? 'Unknown Firefox page log');
      if (this.pageLogs.length >= 200) this.pageLogs.shift();
      this.pageLogs.push({
        ...(params.args === undefined ? {} : { args: params.args }),
        level,
        text,
      });
      if (level === 'error') this.pageErrors.push(text);
    });

    await this.command('session.subscribe', {
      events: ['network.beforeRequestSent', 'log.entryAdded'],
    });
    await this.command('network.addIntercept', {
      phases: ['beforeRequestSent'],
      urlPatterns: [{ type: 'pattern', protocol: 'https', hostname: 'www.youtube.com' }],
    });
  }

  async installExtension(
    extensionPath = resolve(process.cwd(), 'dist-extension-firefox')
  ): Promise<string> {
    const result = await this.command<ExtensionInstallResult>('webExtension.install', {
      extensionData: { type: 'path', path: extensionPath },
    });
    return result.extension;
  }

  async navigate(url: string): Promise<void> {
    await this.command('browsingContext.navigate', {
      context: this.context,
      url,
      wait: 'complete',
    });
  }

  async reload(): Promise<void> {
    await this.command('browsingContext.reload', {
      context: this.context,
      wait: 'complete',
    });
  }

  async captureScreenshot(): Promise<Buffer> {
    const result = await this.command<{ data: string }>(
      'browsingContext.captureScreenshot',
      {
        context: this.context,
        origin: 'viewport',
      },
      5_000
    );
    return Buffer.from(result.data, 'base64');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      if (this.socket.readyState === WebSocket.OPEN) {
        await Promise.race([
          this.command('session.end', {}, CLOSE_TIMEOUT_MS).catch(() => undefined),
          delay(CLOSE_TIMEOUT_MS),
        ]);
      }
    } finally {
      this.closed = true;
      this.handleClose();
      this.socket.removeEventListener('message', this.handleMessage);
      this.socket.removeEventListener('close', this.handleClose);
      this.socket.close();

      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill('SIGTERM');
        if (!(await waitForProcessExit(this.child, CLOSE_TIMEOUT_MS))) {
          this.child.kill('SIGKILL');
          await waitForProcessExit(this.child, CLOSE_TIMEOUT_MS);
        }
      }
      rmSync(this.profileDir, { force: true, recursive: true });
    }
  }
}

export async function launchFirefoxBidi(): Promise<FirefoxBidiSession> {
  const profileDir = mkdtempSync(join(tmpdir(), 'yt-overlay-firefox-bidi-'));
  const child = spawn(
    firefox.executablePath(),
    [
      '--headless',
      '--no-remote',
      '--profile',
      profileDir,
      '--remote-debugging-port',
      '0',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_384);
  });

  let session: FirefoxBidiSessionImpl | null = null;
  try {
    const endpoint = await waitForEndpoint(child, () => stderr);
    const socket = await connectWebSocket(endpoint);
    const bootstrapSession = new FirefoxBidiSessionImpl(child, socket, profileDir, 'pending');
    session = bootstrapSession;
    await bootstrapSession.command('session.new', { capabilities: {} });
    const tree = await bootstrapSession.command<ContextTreeResult>('browsingContext.getTree', {
      maxDepth: 0,
    });
    const initialContext = tree.contexts.find((entry) => entry.url === 'about:blank');
    if (!initialContext) throw new Error('Firefox did not expose the initial about:blank context');

    bootstrapSession.context = initialContext.context;
    await session.command('browsingContext.setViewport', {
      context: initialContext.context,
      viewport: { height: 800, width: 1280 },
    });
    return session;
  } catch (error: unknown) {
    if (session) {
      await session.close();
    } else {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (!(await waitForProcessExit(child, CLOSE_TIMEOUT_MS))) {
        child.kill('SIGKILL');
        await waitForProcessExit(child, CLOSE_TIMEOUT_MS);
      }
      rmSync(profileDir, { force: true, recursive: true });
    }
    throw error;
  }
}
