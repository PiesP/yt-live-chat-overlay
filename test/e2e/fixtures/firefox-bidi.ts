// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { firefox } from '@playwright/test';
import puppeteer, {
  type Browser,
  type ConsoleMessage,
  type HTTPRequest,
  type Page,
} from 'puppeteer-core';

const STARTUP_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 50;
const PROFILE_REMOVE_RETRIES = 10;
const PROFILE_REMOVE_RETRY_DELAY_MS = 100;

export interface FirefoxBidiSession {
  readonly pageErrors: readonly string[];
  readonly pageLogs: readonly { args?: unknown; level: string; text: string }[];
  captureScreenshot(): Promise<Buffer>;
  clearPageLogs(): void;
  close(): Promise<void>;
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

async function closedWithin(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function boundedOperation<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, rejectTimeout) => {
        timer = setTimeout(() => rejectTimeout(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type OwnedFirefoxChild = Pick<ChildProcess, 'exitCode' | 'signalCode' | 'kill'>;

interface FirefoxCleanupOptions {
  closeTimeoutMs?: number;
  maxRemoveRetries?: number;
  removeProfile?: (path: string) => void;
  retryDelayMs?: number;
}

export async function cleanupFirefoxProfile(
  child: OwnedFirefoxChild,
  closed: Promise<void>,
  profileDir: string,
  options: FirefoxCleanupOptions = {}
): Promise<void> {
  const closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  if (!(await closedWithin(closed, closeTimeoutMs))) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (!(await closedWithin(closed, closeTimeoutMs))) {
      throw new Error('Firefox process did not close; profile retained');
    }
  }

  const maxRemoveRetries = options.maxRemoveRetries ?? PROFILE_REMOVE_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? PROFILE_REMOVE_RETRY_DELAY_MS;
  const removeProfile =
    options.removeProfile ??
    ((path: string) => {
      rmSync(path, { force: true, recursive: true });
    });
  for (let attempt = 0; ; attempt++) {
    try {
      removeProfile(profileDir);
      return;
    } catch (error: unknown) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'EPERM' ||
        attempt >= maxRemoveRetries
      ) {
        throw error;
      }
      await delay(retryDelayMs);
    }
  }
}

type FirefoxBrowserCleanup = Pick<Browser, 'close' | 'uninstallExtension'>;

export async function closeFirefoxResources(
  browser: FirefoxBrowserCleanup,
  child: OwnedFirefoxChild,
  childClosed: Promise<void>,
  profileDir: string,
  extensionId: string | null,
  options: { closeTimeoutMs?: number; profile?: FirefoxCleanupOptions } = {}
): Promise<void> {
  const errors: unknown[] = [];
  const closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
  if (extensionId) {
    try {
      await boundedOperation(
        browser.uninstallExtension(extensionId),
        closeTimeoutMs,
        'Firefox extension uninstall timed out'
      );
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  try {
    await boundedOperation(browser.close(), closeTimeoutMs, 'Firefox BiDi session close timed out');
  } catch (error: unknown) {
    errors.push(error);
  }
  try {
    await cleanupFirefoxProfile(child, childClosed, profileDir, options.profile);
  } catch (error: unknown) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Firefox session cleanup failed');
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

class FirefoxBidiSessionImpl implements FirefoxBidiSession {
  readonly pageErrors: string[] = [];
  readonly pageLogs: Array<{ args?: unknown; level: string; text: string }> = [];
  private closed = false;
  private extensionId: string | null = null;
  private readonly eventErrors: string[] = [];
  private readonly pendingLogs = new Set<Promise<void>>();
  private requestListener: ((request: HTTPRequest) => void) | null = null;

  constructor(
    private readonly child: ChildProcess,
    private readonly childClosed: Promise<void>,
    private readonly browser: Browser,
    private readonly page: Page,
    private readonly profileDir: string
  ) {
    page.on('console', this.handleConsole);
    page.on('pageerror', this.handlePageError);
  }

  private readonly handleConsole = (message: ConsoleMessage): void => {
    const entry: { args?: unknown; level: string; text: string } = {
      level: message.type(),
      text: message.text(),
    };
    if (this.pageLogs.length >= 200) this.pageLogs.shift();
    this.pageLogs.push(entry);
    if (entry.level === 'error') this.pageErrors.push(entry.text);
    const pending = Promise.all(message.args().map((argument) => argument.jsonValue()))
      .then((args) => {
        entry.args = args;
      })
      .catch((error: unknown) => {
        entry.args = [`Firefox page log arguments unavailable: ${errorMessage(error)}`];
      });
    this.pendingLogs.add(pending);
    void pending.finally(() => this.pendingLogs.delete(pending));
  };

  private readonly handlePageError = (error: unknown): void => {
    this.pageErrors.push(errorMessage(error));
  };

  private assertHealthy(): void {
    const [eventError] = this.eventErrors;
    if (eventError) throw new Error(`Firefox BiDi event handler failed: ${eventError}`);
    if (this.closed || this.child.exitCode !== null || this.child.signalCode !== null) {
      throw new Error('Firefox BiDi session is closed');
    }
  }

  private async flushPageLogs(): Promise<void> {
    await Promise.all(this.pendingLogs);
    this.assertHealthy();
  }

  clearPageLogs(): void {
    this.pageLogs.length = 0;
  }

  async evaluateJson<T>(expression: string): Promise<T> {
    this.assertHealthy();
    // Expressions are fixed test source. Serialize inside the page to retain the
    // previous fixture's JSON value contract across the BiDi result boundary.
    const json = await this.page.evaluate(
      `Promise.resolve(${expression}).then((value) => JSON.stringify(value))`
    );
    if (typeof json !== 'string') {
      throw new Error(`Firefox page evaluation returned ${typeof json}, expected a JSON string`);
    }
    await this.flushPageLogs();
    return JSON.parse(json) as T;
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
        // Page-script exceptions can be transient while navigation initializes.
        // Transport failures and command timeouts must remain the primary error.
        if (
          this.closed ||
          this.child.exitCode !== null ||
          this.child.signalCode !== null ||
          /Target closed|Session closed|Connection closed|timed out|TimeoutError/i.test(
            errorMessage(error)
          )
        ) {
          throw error;
        }
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
    this.assertHealthy();
    if (this.requestListener) throw new Error('Firefox request interception is already active');
    await this.page.setRequestInterception(true);
    this.requestListener = (request): void => {
      void this.respondToRequest(request, options).catch((error: unknown) => {
        this.eventErrors.push(`Firefox request interception: ${errorMessage(error)}`);
      });
    };
    this.page.on('request', this.requestListener);
  }

  private async respondToRequest(
    request: HTTPRequest,
    options: { chatResponseJson?: string; nonWatchHtml: string; watchHtml: string }
  ): Promise<void> {
    const url = new URL(request.url());
    if (url.hostname !== 'www.youtube.com') {
      await request.continue();
      return;
    }
    if (request.isNavigationRequest()) {
      const isWatchPage = url.pathname === '/watch' || url.pathname.startsWith('/live/');
      await request.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: isWatchPage ? options.watchHtml : options.nonWatchHtml,
      });
      return;
    }
    if (
      options.chatResponseJson !== undefined &&
      url.pathname.startsWith('/youtubei/v1/live_chat/')
    ) {
      await request.respond({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: options.chatResponseJson,
      });
      return;
    }
    await request.respond({ status: 204 });
  }

  async installExtension(
    extensionPath = resolve(process.cwd(), 'dist-extension-firefox')
  ): Promise<string> {
    this.assertHealthy();
    const extensionId = await this.browser.installExtension(extensionPath);
    this.extensionId = extensionId;
    return extensionId;
  }

  async navigate(url: string): Promise<void> {
    this.assertHealthy();
    await this.page.goto(url, { waitUntil: 'load', timeout: COMMAND_TIMEOUT_MS });
  }

  async reload(): Promise<void> {
    this.assertHealthy();
    await this.page.reload({ waitUntil: 'load', timeout: COMMAND_TIMEOUT_MS });
  }

  async captureScreenshot(): Promise<Buffer> {
    this.assertHealthy();
    const screenshot = await boundedOperation(
      this.page.screenshot({ type: 'png' }),
      5_000,
      'Firefox screenshot timed out'
    );
    return Buffer.from(screenshot);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.page.off('console', this.handleConsole);
    this.page.off('pageerror', this.handlePageError);
    if (this.requestListener) this.page.off('request', this.requestListener);
    await closeFirefoxResources(
      this.browser,
      this.child,
      this.childClosed,
      this.profileDir,
      this.extensionId
    );
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
  const childClosed = new Promise<void>((resolveClose) => {
    child.once('close', () => resolveClose());
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_384);
  });

  let browser: Browser | null = null;
  let session: FirefoxBidiSessionImpl | null = null;
  try {
    const endpoint = await waitForEndpoint(child, () => stderr);
    browser = await puppeteer.connect({
      browserWSEndpoint: endpoint,
      protocol: 'webDriverBiDi',
      protocolTimeout: COMMAND_TIMEOUT_MS,
      defaultViewport: { width: 1280, height: 800 },
    });
    const pages = await browser.pages();
    const page = pages.find((candidate) => candidate.url() === 'about:blank');
    if (!page) throw new Error('Firefox did not expose the initial about:blank page');
    page.setDefaultTimeout(COMMAND_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(COMMAND_TIMEOUT_MS);
    session = new FirefoxBidiSessionImpl(child, childClosed, browser, page, profileDir);
    await page.setViewport({ height: 800, width: 1280 });
    return session;
  } catch (error: unknown) {
    const errors: unknown[] = [error];
    if (session) {
      try {
        await session.close();
      } catch (cleanupError: unknown) {
        errors.push(cleanupError);
      }
    } else {
      if (browser) {
        try {
          await closeFirefoxResources(browser, child, childClosed, profileDir, null);
        } catch (cleanupError: unknown) {
          errors.push(cleanupError);
        }
      } else {
        try {
          await cleanupFirefoxProfile(child, childClosed, profileDir);
        } catch (cleanupError: unknown) {
          errors.push(cleanupError);
        }
      }
    }
    if (errors.length > 1) throw new AggregateError(errors, 'Firefox launch and cleanup failed');
    throw error;
  }
}
