// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  diagnoseUnsafeOriginConsole,
  ownedExtensionResourcePath,
  requireLiveSuccess,
} from '../../../validation/windows/chrome-install.ts';
import { beginChromiumNetworkDiagnostics } from '../../../validation/windows/chromium-network-diagnostics.ts';

const id = 'a'.repeat(32);
const watch = 'https://www.youtube.com/watch?v=private&token=secret';
const watchSha = createHash('sha256').update(watch).digest('hex');
const owned = `chrome-extension://${id}/page-script.js`;

class FakeSession extends EventEmitter {
  calls: string[] = [];
  detachCount = 0;
  send(method: string): Promise<unknown> {
    this.calls.push(method);
    return Promise.resolve({});
  }
  detach(): Promise<void> {
    this.detachCount++;
    return Promise.resolve();
  }
}

function options(session: FakeSession) {
  return {
    createSession: async () => session,
    extensionId: id,
    classifyUrl: (url: string) => ({
      ownedResourcePath: ownedExtensionResourcePath(url, id),
      watchDocumentSha256: url === watch ? watchSha : null,
    }),
    classifyWarning: (text: string) => diagnoseUnsafeOriginConsole(text, '', id),
  };
}

function request(
  session: FakeSession,
  requestId: string,
  url: string,
  frameId: string,
  loaderId: string
) {
  session.emit('Network.requestWillBeSent', {
    requestId,
    frameId,
    loaderId,
    request: { url },
    type: url === watch ? 'Document' : 'Script',
  });
}

function response(
  session: FakeSession,
  requestId: string,
  loaderId: string,
  status: number,
  hasExtraInfo = true
) {
  session.emit('Network.responseReceived', {
    requestId,
    loaderId,
    hasExtraInfo,
    response: { status },
  });
}

function warning(session: FakeSession, requestId?: string) {
  session.emit('Log.entryAdded', {
    entry: {
      source: 'security',
      level: 'warning',
      text: `Unsafe attempt to load URL ${owned} from frame with URL ${watch}. Domains, protocols and ports must match.`,
      ...(requestId === undefined ? {} : { networkRequestId: requestId }),
    },
  });
}

afterEach(() => vi.useRealTimers());

describe('native Chromium warning and policy diagnostics', () => {
  it('joins only an exact CDP request ID and preserves frame/loader ownership', async () => {
    const session = new FakeSession();
    const capture = await beginChromiumNetworkDiagnostics(options(session));
    expect(session.calls).toEqual(['Log.enable', 'Network.enable', 'Page.enable']);
    request(session, 'doc-main', watch, 'main', 'loader-main');
    response(session, 'doc-main', 'loader-main', 200);
    session.emit('Page.frameNavigated', {
      frame: {
        id: 'main',
        loaderId: 'loader-main',
        url: watch,
      },
    });
    request(session, 'same-url-other-frame', owned, 'child', 'loader-child');
    response(session, 'same-url-other-frame', 'loader-child', 200);
    session.emit('Network.loadingFinished', { requestId: 'same-url-other-frame' });
    warning(session, 'same-url-other-frame');
    request(session, 'main-owned', owned, 'main', 'loader-main');
    response(session, 'main-owned', 'loader-main', 200);
    session.emit('Network.loadingFinished', { requestId: 'main-owned' });
    warning(session, 'main-owned');
    warning(session);
    const result = await capture.finish();
    expect(result).toMatchObject({ status: 'ready', cleanup: 'detached' });
    expect(result.warnings).toMatchObject([
      { join: 'linked-success', committedMainFrame: false },
      { join: 'linked-success', committedMainFrame: true },
      { join: 'unknown', networkRequestIdPresent: false, committedMainFrame: null },
    ]);
    expect(session.detachCount).toBe(1);
    for (const event of [
      'Log.entryAdded',
      'Network.requestWillBeSent',
      'Network.responseReceived',
      'Network.responseReceivedExtraInfo',
      'Network.loadingFailed',
      'Network.loadingFinished',
      'Page.frameNavigated',
    ])
      expect(session.listenerCount(event)).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/private|secret|chrome-extension:\/\/a{32}/u);
  });

  it('distinguishes a denied linked request from unrelated successful requests', async () => {
    const session = new FakeSession();
    const capture = await beginChromiumNetworkDiagnostics(options(session));
    request(session, 'denied', owned, 'main', 'loader');
    session.emit('Network.loadingFailed', {
      requestId: 'denied',
      blockedReason: 'csp',
      errorText: 'private failure text',
    });
    request(session, 'success', owned, 'main', 'loader');
    response(session, 'success', 'loader', 200);
    session.emit('Network.loadingFinished', { requestId: 'success' });
    warning(session, 'denied');
    warning(session, 'missing');
    const result = await capture.finish();
    expect(result.warnings).toMatchObject([{ join: 'linked-failure' }, { join: 'unknown' }]);
    expect(result.requests).toMatchObject([
      { outcome: 'failed', blockedReason: 'csp' },
      { outcome: 'finished', responseStatus: 200 },
    ]);
    expect(JSON.stringify(result)).not.toContain('private failure text');
  });

  it('uses only actual extra-info headers for the committed document', async () => {
    const session = new FakeSession();
    const capture = await beginChromiumNetworkDiagnostics(options(session));
    request(session, 'doc', watch, 'main', 'loader');
    session.emit('Network.responseReceivedExtraInfo', {
      requestId: 'doc',
      statusCode: 200,
      headers: {
        'Connection-Allowlist': `chrome-extension://${id}`,
        'Reporting-Endpoints': 'bad="https://private.example/?token=secret"',
        'Set-Cookie': 'secret-cookie',
      },
    });
    response(session, 'doc', 'loader', 200, true);
    session.emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'loader', url: watch } });
    const result = await capture.finish();
    const committed = (result.committedDocuments as Array<Record<string, unknown>>)[0];
    expect(committed?.headerCompleteness).toBe('complete-actual');
    const policy = committed?.policy as Record<string, Record<string, unknown>>;
    expect(policy['connection-allowlist']).toMatchObject({
      presence: 'present',
      source: 'Network.responseReceivedExtraInfo',
      ownedOriginMention: true,
    });
    expect(policy['connection-allowlist-report-only']).toMatchObject({ presence: 'absent' });
    expect(policy['reporting-endpoints']).toMatchObject({
      presence: 'present',
      ownedOriginMention: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|private.example|Set-Cookie/u);
  });

  it('keeps missing extra-info, redirects, and mismatched status unknown', async () => {
    const session = new FakeSession();
    const capture = await beginChromiumNetworkDiagnostics(options(session));
    request(session, 'missing', watch, 'main', 'one');
    response(session, 'missing', 'one', 200, true);
    session.emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'one', url: watch } });
    request(session, 'redirected', watch, 'main', 'two');
    session.emit('Network.responseReceivedExtraInfo', {
      requestId: 'redirected',
      statusCode: 301,
      headers: { 'Connection-Allowlist': `chrome-extension://${id}` },
    });
    request(session, 'redirected', watch, 'main', 'two');
    response(session, 'redirected', 'two', 200);
    session.emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'two', url: watch } });
    request(session, 'mismatch', watch, 'main', 'three');
    session.emit('Network.responseReceivedExtraInfo', {
      requestId: 'mismatch',
      statusCode: 304,
      headers: {},
    });
    response(session, 'mismatch', 'three', 200);
    session.emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'three', url: watch } });
    const result = await capture.finish();
    expect(
      (result.committedDocuments as Array<Record<string, unknown>>).map(
        (item) => item.headerCompleteness
      )
    ).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('does not call a redirected warning successful from the final hop', async () => {
    const session = new FakeSession();
    const capture = await beginChromiumNetworkDiagnostics(options(session));
    request(session, 'reused', owned, 'main', 'loader');
    warning(session, 'reused');
    request(session, 'reused', owned, 'main', 'loader');
    response(session, 'reused', 'loader', 200);
    session.emit('Network.loadingFinished', { requestId: 'reused' });
    const result = await capture.finish();
    expect(result.warnings).toMatchObject([{ join: 'unknown', committedMainFrame: null }]);
    expect(result.requests).toMatchObject([{ redirectCount: 1, responseStatus: 200 }]);
  });

  it('bounds setup and detach, and cannot mutate a finished snapshot', async () => {
    vi.useFakeTimers();
    const pending = beginChromiumNetworkDiagnostics({
      ...options(new FakeSession()),
      createSession: () => new Promise(() => {}),
    });
    await vi.advanceTimersByTimeAsync(3_000);
    const unavailable = await pending;
    expect(await unavailable.finish()).toMatchObject({
      status: 'unavailable',
      cleanup: 'no-session',
    });
    const session = new FakeSession();
    session.detach = () => new Promise(() => {});
    const capture = await beginChromiumNetworkDiagnostics(options(session));
    warning(session);
    const finishing = capture.finish();
    warning(session);
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await finishing;
    warning(session);
    expect(result).toMatchObject({ cleanup: 'unverified' });
    expect(result.warnings).toHaveLength(1);
    expect(session.listenerCount('Log.entryAdded')).toBe(0);
  });

  it('does not change the live console-error verdict', () => {
    expect(() =>
      requireLiveSuccess([
        {
          status: 'passed',
          canvasAttached: true,
          renderedMessages: 1,
          pageErrorTypes: [],
          unexpectedConsoleErrors: 1,
          nativeNetworkDiagnostics: { status: 'ready', warnings: [{ join: 'linked-success' }] },
        },
      ])
    ).toThrow('did not prove installed application rendering');
  });
});
