// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';

import type { BrowserContext, CDPSession, Page } from '@playwright/test';

const COMMAND_TIMEOUT_MS = 5_000;
const MAX_REQUEST_RECORDS = 16;
const FINAL_URLS = [
  'https://yt4.ggpht.com/windows-bitmap-issue306-redirect-allowed-final.png',
  'https://example.test/windows-bitmap-issue306-redirect-offhost-final.png',
] as const;

type TargetInfo = {
  targetId: string;
  type: string;
  url: string;
  browserContextId?: string;
};

export type WorkerRedirectBinding = {
  pageTargetId: string;
  workerTargetId: string;
  workerUrl: string;
  browserContextId: string | null;
  finalUrls: readonly string[];
  terminalRequests: string[];
  interceptionScope: string;
};

export type WorkerRedirectTransport = {
  binding: WorkerRedirectBinding;
  assertHealthy(): void;
  close(): Promise<void>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function targetInfo(value: unknown): TargetInfo | null {
  const target = record(value);
  if (
    !target ||
    typeof target.targetId !== 'string' ||
    typeof target.type !== 'string' ||
    typeof target.url !== 'string'
  )
    return null;
  if (target.browserContextId !== undefined && typeof target.browserContextId !== 'string')
    return null;
  return {
    targetId: target.targetId,
    type: target.type,
    url: target.url,
    ...(typeof target.browserContextId === 'string'
      ? { browserContextId: target.browserContextId }
      : {}),
  };
}

function commandDeadline<T>(promise: Promise<T>, method: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${method} timed out`)), COMMAND_TIMEOUT_MS);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function cleanupFailure(primary: unknown, cleanupErrors: unknown[]): unknown {
  return cleanupErrors.length > 0
    ? new AggregateError([primary, ...cleanupErrors], 'Worker redirect setup and cleanup failed')
    : primary;
}

/** Intercept exact redirect finals in the fixture page after verifying its packaged Worker. */
export async function installWorkerRedirectTransport({
  context,
  page,
  workerUrl,
  finalUrls,
  bodyBase64,
  onRequest,
}: {
  context: BrowserContext;
  page: Page;
  workerUrl: string;
  finalUrls: readonly string[];
  bodyBase64: string;
  onRequest: (url: string) => void | Promise<void>;
}): Promise<WorkerRedirectTransport> {
  assert(workerUrl.startsWith('blob:https://www.youtube.com/'), 'Unexpected bitmap Worker URL');
  assert.deepEqual(new Set(finalUrls), new Set(FINAL_URLS), 'Unexpected redirect final URLs');
  assert.equal(finalUrls.length, FINAL_URLS.length, 'Duplicate redirect final URL');
  assert(/^[A-Za-z0-9+/]+={0,2}$/.test(bodyBase64), 'Invalid PNG fixture body');
  const image = Buffer.from(bodyBase64, 'base64');
  assert(image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
  assert.equal(image.toString('base64'), bodyBase64, 'Noncanonical PNG fixture body');

  const browser = context.browser();
  assert(browser, 'Bitmap context has no browser');
  let pageCdp: CDPSession | undefined;
  let browserCdp: CDPSession | undefined;
  let fetchEnableAttempted = false;
  let closed = false;
  let healthError: Error | undefined;
  const inFlight = new Set<Promise<void>>();
  let binding: WorkerRedirectBinding | undefined;
  const allowedUrls = new Set<string>(FINAL_URLS);

  function markUnhealthy(error: unknown): void {
    if (!healthError)
      healthError = error instanceof Error ? error : new Error('Worker redirect transport failed');
  }

  function onRequestPaused(payload: unknown): void {
    const request = handleRequest(payload);
    inFlight.add(request);
    void request.then(
      () => inFlight.delete(request),
      (error) => {
        markUnhealthy(error);
        inFlight.delete(request);
      }
    );
  }

  async function pageCommand(
    method: Parameters<CDPSession['send']>[0],
    params?: Record<string, unknown>
  ): Promise<unknown> {
    assert(pageCdp, 'Fixture page CDP session is unavailable');
    return commandDeadline(pageCdp.send(method, params), method);
  }

  async function handleRequest(value: unknown): Promise<void> {
    const params = record(value);
    const request = record(params?.request);
    const requestId = params?.requestId;
    if (typeof requestId !== 'string') {
      markUnhealthy(new Error('Worker Fetch pause omitted request ID'));
      return;
    }
    const url = request?.url;
    if (
      typeof url !== 'string' ||
      !allowedUrls.has(url) ||
      request?.method !== 'GET' ||
      params?.requestStage === 'Response'
    ) {
      markUnhealthy(new Error('Unexpected bitmap Worker Fetch pause'));
      try {
        await pageCommand('Fetch.failRequest', { requestId, errorReason: 'Aborted' });
      } catch (error) {
        markUnhealthy(error);
      }
      return;
    }
    try {
      await pageCommand('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'image/png' },
          { name: 'Access-Control-Allow-Origin', value: '*' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: bodyBase64,
      });
      assert(binding, 'Bitmap Worker binding is unavailable');
      if (binding.terminalRequests.length >= MAX_REQUEST_RECORDS)
        throw new Error('Bitmap Worker terminal request record overflow');
      binding.terminalRequests.push(url);
      await commandDeadline(Promise.resolve(onRequest(url)), 'Bitmap Worker request callback');
    } catch (error) {
      markUnhealthy(error);
    }
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    // A paused fulfillment must settle before disabling its Fetch domain.
    try {
      await commandDeadline(Promise.allSettled(inFlight), 'Worker redirect in-flight requests');
    } catch (error) {
      errors.push(error);
    }
    if (fetchEnableAttempted) {
      try {
        await pageCommand('Fetch.disable');
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await commandDeadline(Promise.allSettled(inFlight), 'Final redirect in-flight requests');
    } catch (error) {
      errors.push(error);
    }
    pageCdp?.off('Fetch.requestPaused', onRequestPaused);
    if (pageCdp) {
      try {
        await commandDeadline(pageCdp.detach(), 'Page CDP detach');
      } catch (error) {
        errors.push(error);
      }
    }
    if (browserCdp) {
      try {
        await commandDeadline(browserCdp.detach(), 'Browser CDP detach');
      } catch (error) {
        errors.push(error);
      }
    }
    if (healthError) errors.unshift(healthError);
    if (errors.length > 0)
      throw new AggregateError(errors, 'Worker redirect transport cleanup failed');
  }

  try {
    pageCdp = await commandDeadline(context.newCDPSession(page), 'Page CDP attach');
    const pageResult = record(
      await commandDeadline(pageCdp.send('Target.getTargetInfo'), 'Page target lookup')
    );
    const pageTarget = targetInfo(pageResult?.targetInfo);
    assert(pageTarget?.type === 'page', 'Bitmap fixture page target was not found');
    browserCdp = await commandDeadline(browser.newBrowserCDPSession(), 'Browser CDP attach');
    const targetsResult = record(
      await commandDeadline(browserCdp.send('Target.getTargets'), 'Target.getTargets')
    );
    const targets = Array.isArray(targetsResult?.targetInfos) ? targetsResult.targetInfos : [];
    const matches = targets
      .map(targetInfo)
      .filter(
        (target): target is TargetInfo =>
          target?.type === 'worker' &&
          target.url === workerUrl &&
          (!pageTarget.browserContextId ||
            !target.browserContextId ||
            target.browserContextId === pageTarget.browserContextId)
      );
    assert.equal(matches.length, 1, 'Expected exactly one matching bitmap Worker target');
    const workerTarget = matches[0];
    assert(workerTarget, 'Matching bitmap Worker target is unavailable');
    binding = {
      pageTargetId: pageTarget.targetId,
      workerTargetId: workerTarget.targetId,
      workerUrl,
      browserContextId: workerTarget.browserContextId ?? pageTarget.browserContextId ?? null,
      finalUrls: [...FINAL_URLS],
      terminalRequests: [],
      interceptionScope:
        'exact final URLs in the owned fixture page Fetch domain; Worker identity verified separately',
    };
    // Dedicated Worker targets expose Network but not Fetch in installed Edge.
    // The parent page's Fetch domain owns interception for its Worker requests.
    pageCdp.on('Fetch.requestPaused', onRequestPaused);
    fetchEnableAttempted = true;
    await pageCommand('Fetch.enable', {
      patterns: FINAL_URLS.map((urlPattern) => ({ urlPattern, requestStage: 'Request' })),
    });
    return {
      binding,
      assertHealthy() {
        if (healthError) throw healthError;
      },
      close,
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    throw cleanupFailure(error, cleanupErrors);
  }
}
