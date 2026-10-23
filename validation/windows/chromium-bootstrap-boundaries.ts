// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, Page, Route, Worker } from '@playwright/test';

import { buildVisibleWatchHtml } from './visible-watch.ts';

const WATCH_URLS = [
  'https://www.youtube.com/watch?v=windowsBootstrapA',
  'https://www.youtube.com/watch?v=windowsBootstrapB',
  'https://www.youtube.com/watch?v=windowsBootstrapC',
  'https://www.youtube.com/watch?v=windowsBootstrapD',
] as const;
const FRAME_URL = 'https://www.youtube.com/watch?v=windowsBootstrapFrame';
const STATE_KEY = '__ytWindowsBootstrapBoundary';
const MAX_RECORDS = 24;
const SETTINGS_KEY = 'yt-live-chat-overlay-settings';

type CallRecord = {
  kind: 'claim' | 'bundle';
  watch: string;
  tabId: number;
  documentId: string;
  outcome: 'held' | 'claimed' | 'already' | 'injected' | 'rejected' | 'fault';
  resultDocumentId: string | null;
  resultFrameId: number | null;
  error: string | null;
};
type WorkerState = {
  token: string;
  extensionId: string;
  generation: string;
  held: boolean;
  released: boolean;
  faulted: boolean;
  records: CallRecord[];
  overflow: number;
};
type PageState = {
  url: string;
  timeOrigin: number;
  bridgeNonce: string | null;
  claimed: boolean;
  app: boolean;
  overlayCount: number;
  canvasCount: number;
  sourceStatus: string | null;
};

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function sourceState(page: Page): Promise<PageState> {
  return page.evaluate(() => {
    const bridge = window.__ytExtensionBridge as { nonce?: string } | undefined;
    const claimed = (window as Window & { __ytExtensionBootstrapClaim?: boolean })
      .__ytExtensionBootstrapClaim;
    return {
      url: location.href,
      timeOrigin: performance.timeOrigin,
      bridgeNonce: bridge?.nonce ?? null,
      claimed: claimed === true,
      app: Boolean(window.__ytChatOverlay),
      overlayCount: document.querySelectorAll('#yt-live-chat-overlay').length,
      canvasCount: document.querySelectorAll('#yt-live-chat-overlay canvas').length,
      sourceStatus:
        document.querySelector('#yt-chat-overlay-debug')?.textContent?.slice(0, 500) ?? null,
    };
  });
}

function assertHealthy(state: PageState, url: string): void {
  assert.equal(state.url, url);
  assert.match(state.bridgeNonce ?? '', /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
  assert.equal(state.claimed, true);
  assert.equal(state.app, true, 'Packaged page entry did not start');
  assert.equal(state.overlayCount, 1, 'Installed app did not own exactly one overlay');
  assert.equal(state.canvasCount, 1, 'Installed app did not own exactly one canvas');
}

function workerExpression(token: string, extensionId: string): string {
  return `(() => {
    const key = ${JSON.stringify(STATE_KEY)};
    if (globalThis[key]) throw new Error('Bootstrap boundary wrapper already exists');
    if (chrome.runtime.id !== ${JSON.stringify(extensionId)})
      throw new Error('Installed extension identity changed');
    const scripting = chrome.scripting;
    const original = scripting.executeScript;
    if (typeof original !== 'function') throw new Error('Native executeScript unavailable');
    const urls = ${JSON.stringify(WATCH_URLS)};
    const state = {
      token: ${JSON.stringify(token)}, extensionId: ${JSON.stringify(extensionId)},
      original, wrapper: null, generation: crypto.randomUUID(),
      held: false, released: false, faulted: false, releaseA: null,
      records: [], overflow: 0,
    };
    const record = (entry) => {
      if (state.records.length < ${MAX_RECORDS}) state.records.push(entry);
      else state.overflow++;
    };
    const wrapper = async function(injection) {
      const target = injection?.target;
      const documentId = target?.documentIds?.[0];
      const claim = injection?.world === 'MAIN' &&
        typeof injection.func === 'function' &&
        Array.isArray(injection.args) && injection.args.length === 2 &&
        typeof injection.args[0] === 'string' &&
        /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(injection.args[0]);
      const bundle = injection?.world === 'MAIN' &&
        Array.isArray(injection.files) && injection.files.length === 1 &&
        injection.files[0] === 'page-script.js';
      if (!claim && !bundle) return Reflect.apply(original, scripting, [injection]);
      if (!Number.isSafeInteger(target?.tabId) ||
          Object.keys(target).sort().join(',') !== 'documentIds,tabId' ||
          !Array.isArray(target.documentIds) || target.documentIds.length !== 1 ||
          typeof documentId !== 'string' || !/^[0-9a-f]{32}$/i.test(documentId))
        throw new Error('Native bootstrap target shape changed');
      const tab = await chrome.tabs.get(target.tabId);
      const watch = tab?.url;
      if (!urls.includes(watch)) return Reflect.apply(original, scripting, [injection]);
      const entry = {
        kind: claim ? 'claim' : 'bundle', watch, tabId: target.tabId,
        documentId, outcome: 'rejected', resultDocumentId: null,
        resultFrameId: null, error: null,
      };
      record(entry);
      if (claim && watch === urls[0] && !state.held) {
        state.held = true;
        entry.outcome = 'held';
        await new Promise((resolve) => { state.releaseA = resolve; });
        state.released = true;
      }
      if (claim && watch === urls[2] && !state.faulted) {
        state.faulted = true;
        entry.outcome = 'fault';
        entry.error = 'issue306-scoped-executeScript-failure';
        throw new Error(entry.error);
      }
      try {
        // Always forward the ORIGINAL target unchanged, including A's retired documentId.
        const result = await Reflect.apply(original, scripting, [injection]);
        if (!Array.isArray(result) || result.length !== 1)
          throw new Error('Native bootstrap result cardinality changed');
        entry.resultDocumentId = result[0]?.documentId ?? null;
        entry.resultFrameId = result[0]?.frameId ?? null;
        if (entry.resultDocumentId !== documentId || entry.resultFrameId !== 0)
          throw new Error('Native bootstrap reached a different document');
        entry.outcome = bundle ? 'injected' :
          result[0]?.result === 'claimed' ? 'claimed' :
          result[0]?.result === 'already' ? 'already' : 'rejected';
        return result;
      } catch (error) {
        entry.outcome = 'rejected';
        entry.error = String(error?.message ?? error).slice(0, 300);
        throw error;
      }
    };
    state.wrapper = wrapper;
    scripting.executeScript = wrapper;
    if (scripting.executeScript !== wrapper)
      throw new Error('Native executeScript wrapper could not be installed');
    globalThis[key] = state;
    return { token: state.token, generation: state.generation };
  })()`;
}

function stateExpression(token: string): string {
  return `(() => {
    const state = globalThis[${JSON.stringify(STATE_KEY)}];
    if (!state || state.token !== ${JSON.stringify(token)} ||
        chrome.scripting.executeScript !== state.wrapper)
      throw new Error('Bootstrap boundary worker generation or wrapper was lost');
    return {
      token: state.token, extensionId: state.extensionId,
      generation: state.generation, held: state.held,
      released: state.released, faulted: state.faulted,
      records: state.records.map((record) => ({...record})), overflow: state.overflow,
    };
  })()`;
}

function releaseExpression(token: string): string {
  return `(() => {
    const state = globalThis[${JSON.stringify(STATE_KEY)}];
    if (!state || state.token !== ${JSON.stringify(token)} || !state.held ||
        state.released || typeof state.releaseA !== 'function')
      throw new Error('Held A claim is unavailable');
    state.releaseA();
    return { released: true };
  })()`;
}

function restoreExpression(token: string): string {
  return `(() => {
    const key = ${JSON.stringify(STATE_KEY)};
    const state = globalThis[key];
    if (!state || state.token !== ${JSON.stringify(token)})
      return { status: 'missing-or-foreign' };
    if (state.held && !state.released && typeof state.releaseA === 'function')
      state.releaseA();
    if (chrome.scripting.executeScript !== state.wrapper)
      return { status: 'wrapper-replaced' };
    chrome.scripting.executeScript = state.original;
    if (chrome.scripting.executeScript !== state.original)
      return { status: 'restore-failed' };
    delete globalThis[key];
    return { status: 'restored', generation: state.generation };
  })()`;
}

async function waitForWorkerState(
  worker: Worker,
  token: string,
  predicate: (state: WorkerState) => boolean,
  label: string
): Promise<WorkerState> {
  let state: WorkerState | undefined;
  for (let attempt = 0; attempt < 60; attempt++) {
    state = await worker.evaluate<WorkerState>(stateExpression(token));
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(state)}`);
}

function productionRecords(state: WorkerState, url: string): CallRecord[] {
  return state.records.filter((record) => record.watch === url);
}

/** Execute a message in the browser's real extension ISOLATED world. */
async function sendFromDocument(
  worker: Worker,
  target: { tabId: number; documentIds: string[] },
  nonce: string
): Promise<{ documentId: string; frameId: number; response: unknown }> {
  const result = await worker.evaluate<
    Array<{ documentId: string; frameId: number; result: unknown }>
  >(`chrome.scripting.executeScript({
    target: ${JSON.stringify(target)}, world: 'ISOLATED',
    func: async (value) => chrome.runtime.sendMessage({ type: 'native-page-bootstrap', nonce: value }),
    args: [${JSON.stringify(nonce)}],
  })`);
  assert.equal(result.length, 1);
  const first = result[0];
  assert(first);
  return { documentId: first.documentId, frameId: first.frameId, response: first.result };
}

/** Exercise the installed extension's native sender, document and injection boundaries. */
export async function runChromiumBootstrapBoundaries({
  context,
  root,
  output,
  extensionId,
}: {
  context: BrowserContext;
  root: string;
  output: string;
  extensionId: string;
}): Promise<Record<string, unknown>> {
  assert.match(extensionId, /^[a-p]{32}$/);
  const preview = await readFile(join(root, 'test/visual/preview.html'), 'utf8');
  const html = buildVisibleWatchHtml(preview, 'Bootstrap boundary fixture video').replace(
    '<div id="chat">',
    '<div id="chat" class="ytd-live-chat-frame" style="min-height:1px">'
  );
  const page = await context.newPage();
  const workerUrl = `chrome-extension://${extensionId}/background.js`;
  const workers = context.serviceWorkers().filter((entry) => entry.url() === workerUrl);
  assert.equal(workers.length, 1, 'Exact installed background worker is unavailable');
  const worker = workers[0];
  assert(worker);
  const token = randomUUID();
  let wrapperInstalled = false;
  let routeInstalled = false;
  let initialSettings: string | null | undefined;
  let phase = 'setup';
  let primaryError: unknown;
  let result: Record<string, unknown> | undefined;
  const pageErrors: Array<{ phase: string; text: string }> = [];
  const consoleErrors: Array<{ phase: string; text: string }> = [];
  const requestFailures: Array<{ phase: string; url: string; failure: string | null }> = [];
  let overflow = 0;
  const documentRequests: Record<string, number> = {};
  let chatRequests = 0;
  const addBounded = <T>(list: T[], item: T): void => {
    if (list.length < MAX_RECORDS) list.push(item);
    else overflow++;
  };
  page.on('pageerror', (error) => addBounded(pageErrors, { phase, text: errorText(error) }));
  page.on('console', (message) => {
    if (message.type() === 'error')
      addBounded(consoleErrors, { phase, text: message.text().slice(0, 300) });
  });
  page.on('requestfailed', (request) => {
    addBounded(requestFailures, {
      phase,
      url: request.url().slice(0, 200),
      failure: request.failure()?.errorText.slice(0, 200) ?? null,
    });
  });
  const routeFixture = (route: Route): Promise<void> => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:' && url.hostname === extensionId)
      return route.continue();
    if (
      new Set<string>([...WATCH_URLS, FRAME_URL]).has(url.href) &&
      route.request().resourceType() === 'document'
    ) {
      documentRequests[url.href] = (documentRequests[url.href] ?? 0) + 1;
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: url.href === FRAME_URL ? '<!doctype html><title>Owned child frame</title>' : html,
      });
    }
    if (url.hostname === 'www.youtube.com' && url.pathname === '/favicon.ico')
      return route.fulfill({ status: 204 });
    if (
      url.hostname === 'www.youtube.com' &&
      url.pathname.startsWith('/youtubei/v1/live_chat/get_live_chat')
    ) {
      chatRequests++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          continuationContents: {
            liveChatContinuation: {
              actions: [],
              continuations: [
                {
                  timedContinuationData: {
                    continuation: 'windows-bootstrap-next',
                    timeoutMs: 30_000,
                  },
                },
              ],
            },
          },
        },
      });
    }
    return route.fulfill({
      status: 403,
      contentType: 'text/plain',
      body: 'Blocked by bootstrap fixture',
    });
  };
  const run = async (): Promise<Record<string, unknown>> => {
    await page.route('**/*', routeFixture);
    routeInstalled = true;
    await page.addInitScript(() => {
      const videoId = new URL(location.href).searchParams.get('v');
      window.ytcfg = {
        data_: {
          INNERTUBE_API_KEY: 'windows-acceptance-key',
          INNERTUBE_CONTEXT_CLIENT_NAME: '1',
          INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
          INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
        },
      };
      window.ytInitialData = {
        currentVideoEndpoint: { watchEndpoint: { videoId } },
        contents: {
          twoColumnWatchNextResults: {
            conversationBar: {
              liveChatRenderer: {
                isReplay: false,
                continuations: [
                  {
                    timedContinuationData: {
                      continuation: 'windows-bootstrap-live',
                      timeoutMs: 30_000,
                    },
                  },
                ],
              },
            },
          },
        },
      };
    });
    initialSettings = await worker.evaluate<string | null>(
      `(async () => (await chrome.storage.local.get(${JSON.stringify(SETTINGS_KEY)}))[${JSON.stringify(SETTINGS_KEY)}] ?? null)()`
    );
    const installed = await worker.evaluate<{ token: string; generation: string }>(
      workerExpression(token, extensionId)
    );
    assert.equal(installed.token, token);
    wrapperInstalled = true;
    phase = 'A-held';
    await page.goto(WATCH_URLS[0], { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const held = await waitForWorkerState(worker, token, (state) => state.held, 'A claim hold');
    const aRecord = productionRecords(held, WATCH_URLS[0])[0];
    assert(aRecord);
    assert.equal(aRecord.outcome, 'held');
    assert.equal((await sourceState(page)).app, false, 'A app started before held claim resumed');

    phase = 'B-healthy';
    await page.goto(WATCH_URLS[1], { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page
      .locator('#yt-live-chat-overlay canvas')
      .waitFor({ state: 'attached', timeout: 15_000 });
    const b = await sourceState(page);
    assertHealthy(b, WATCH_URLS[1]);
    const bState = await waitForWorkerState(
      worker,
      token,
      (state) =>
        productionRecords(state, WATCH_URLS[1]).some((entry) => entry.outcome === 'injected'),
      'B native bundle injection'
    );
    const bClaims = productionRecords(bState, WATCH_URLS[1]);
    assert.deepEqual(
      bClaims.map((entry) => [entry.kind, entry.outcome]),
      [
        ['claim', 'claimed'],
        ['bundle', 'injected'],
      ]
    );
    const bDocumentId = bClaims[0]?.documentId;
    assert.match(bDocumentId ?? '', /^[0-9a-f]{32}$/i);
    assert.equal(bClaims[1]?.documentId, bDocumentId);
    assert.notEqual(aRecord.documentId, bDocumentId, 'A and B shared a native documentId');
    assert.equal(aRecord.tabId, bClaims[0]?.tabId, 'A and B were not the same native tab');
    await worker.evaluate<{ released: true }>(releaseExpression(token));
    const retired = await waitForWorkerState(
      worker,
      token,
      (state) =>
        state.released && productionRecords(state, WATCH_URLS[0])[0]?.outcome === 'rejected',
      'retired A claim rejection'
    );
    const aAfter = productionRecords(retired, WATCH_URLS[0])[0];
    assert.equal(aAfter?.resultDocumentId, null);
    assert(aAfter?.error, 'Browser did not reject retired A document');
    assertHealthy(await sourceState(page), WATCH_URLS[1]);

    phase = 'B-duplicate';
    const duplicate = await sendFromDocument(
      worker,
      { tabId: aRecord.tabId, documentIds: [bDocumentId as string] },
      b.bridgeNonce as string
    );
    assert.equal(duplicate.documentId, bDocumentId);
    assert.equal(duplicate.frameId, 0);
    assert.deepEqual(duplicate.response, { ok: false, reason: 'already-claimed' });
    const afterDuplicate = await waitForWorkerState(
      worker,
      token,
      (state) => productionRecords(state, WATCH_URLS[1]).length === 3,
      'B duplicate claim'
    );
    assert.deepEqual(
      productionRecords(afterDuplicate, WATCH_URLS[1]).map((entry) => entry.outcome),
      ['claimed', 'injected', 'already']
    );
    assertHealthy(await sourceState(page), WATCH_URLS[1]);

    phase = 'invalid-senders';
    const workerSender = await worker.evaluate<unknown>(
      `chrome.runtime.sendMessage({ type: 'native-page-bootstrap', nonce: crypto.randomUUID() })`
    );
    assert.deepEqual(workerSender, { ok: false, reason: 'unauthorized-document' });
    await page.evaluate((url) => {
      const child = document.createElement('iframe');
      child.id = 'bootstrap-boundary-child';
      child.src = url;
      document.body.appendChild(child);
    }, FRAME_URL);
    await page.frameLocator('#bootstrap-boundary-child').locator('body').waitFor();
    const frameSenders = await worker.evaluate<
      Array<{ frameId: number; documentId: string; result: unknown }>
    >(`chrome.scripting.executeScript({
      target: { tabId: ${aRecord.tabId}, allFrames: true }, world: 'ISOLATED',
      func: async () => window === window.top ? null :
        chrome.runtime.sendMessage({ type: 'native-page-bootstrap', nonce: crypto.randomUUID() }),
    })`);
    assert.equal(frameSenders.length, 2, 'Real top and owned child frame were not reached');
    assert.deepEqual(
      frameSenders.filter((entry) => entry.frameId === 0).map((entry) => entry.result),
      [null]
    );
    const childSenders = frameSenders.filter((entry) => entry.frameId !== 0);
    assert.equal(childSenders.length, 1);
    assert.deepEqual(childSenders[0]?.result, { ok: false, reason: 'unauthorized-document' });
    assert.notEqual(childSenders[0]?.documentId, bDocumentId);
    assertHealthy(await sourceState(page), WATCH_URLS[1]);

    phase = 'C-fault';
    await page.goto(WATCH_URLS[2], { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const failed = await waitForWorkerState(
      worker,
      token,
      (state) => state.faulted,
      'C scoped API failure'
    );
    const cCalls = productionRecords(failed, WATCH_URLS[2]);
    assert.deepEqual(
      cCalls.map((entry) => [entry.kind, entry.outcome, entry.error]),
      [['claim', 'fault', 'issue306-scoped-executeScript-failure']]
    );
    const c = await sourceState(page);
    assert.equal(c.url, WATCH_URLS[2]);
    assert.equal(c.app, false, 'C failed bootstrap was mislabeled as an empty chat');
    assert.equal(c.overlayCount, 0);
    assert.equal(c.canvasCount, 0);

    phase = 'D-restored';
    await page.goto(WATCH_URLS[3], { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page
      .locator('#yt-live-chat-overlay canvas')
      .waitFor({ state: 'attached', timeout: 15_000 });
    const d = await sourceState(page);
    assertHealthy(d, WATCH_URLS[3]);
    const finalState = await waitForWorkerState(
      worker,
      token,
      (state) =>
        productionRecords(state, WATCH_URLS[3]).some((entry) => entry.outcome === 'injected'),
      'D healthy native injection'
    );
    assert.deepEqual(
      productionRecords(finalState, WATCH_URLS[3]).map((entry) => entry.outcome),
      ['claimed', 'injected']
    );
    assert.equal(finalState.overflow, 0);
    assert.equal(overflow, 0);
    for (const url of WATCH_URLS)
      assert.equal(documentRequests[url], 1, `Exact routed document missing: ${url}`);
    assert.equal(documentRequests[FRAME_URL], 1);
    assert.deepEqual(pageErrors, [], 'Unexpected page exception');
    assert.deepEqual(requestFailures, [], 'Unexpected network failure');
    assert.deepEqual(
      consoleErrors.filter(
        (entry) =>
          entry.phase !== 'C-fault' ||
          !entry.text.includes('[ExtensionContent] Native page bootstrap failed')
      ),
      [],
      'Unexpected console error outside the one scoped bootstrap fault'
    );
    return {
      status: 'passed',
      scope: 'installed Chromium extension, real service worker and native scripting target',
      documentA: { url: WATCH_URLS[0], documentId: aRecord.documentId, tabId: aRecord.tabId },
      documentB: { ...b, documentId: bDocumentId },
      staleA: aAfter,
      duplicate,
      workerSender,
      frameSenders,
      failedC: { page: c, calls: cCalls },
      restoredD: d,
      worker: finalState,
      documentRequests,
      chatRequests,
      pageErrors,
      consoleErrors,
      requestFailures,
      overflow,
      limits: [
        'The scoped executeScript rejection is a fixture fault, not native API absence or a missing permission.',
        'This fixture does not exercise automatic reinjection into the same failed document or live YouTube.',
      ],
    };
  };
  try {
    result = await run();
  } catch (error) {
    primaryError = error;
    try {
      await writeFile(
        join(output, 'chromium-bootstrap-boundaries-failure.json'),
        JSON.stringify(
          {
            status: 'failed',
            phase,
            error: errorText(error),
            worker: wrapperInstalled
              ? await worker
                  .evaluate<WorkerState>(stateExpression(token))
                  .catch((failure) => ({ unavailable: errorText(failure) }))
              : null,
            page: page.isClosed()
              ? { closed: true }
              : await sourceState(page).catch((failure) => ({ unavailable: errorText(failure) })),
            documentRequests,
            chatRequests,
            pageErrors,
            consoleErrors,
            requestFailures,
            overflow,
          },
          null,
          2
        )
      );
    } catch (diagnosticError) {
      primaryError = new AggregateError(
        [error, diagnosticError],
        'Bootstrap boundary and failure snapshot failed'
      );
    }
  }
  const cleanupErrors: unknown[] = [];
  const cleanup = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  if (wrapperInstalled) {
    await cleanup(async () => {
      const receipt = await worker.evaluate<{ status: string }>(restoreExpression(token));
      assert.equal(receipt.status, 'restored', 'Native executeScript wrapper was not restored');
    });
  }
  if (initialSettings !== undefined) {
    await cleanup(async () => {
      await worker.evaluate(`(async () => {
        const key = ${JSON.stringify(SETTINGS_KEY)};
        const previous = ${JSON.stringify(initialSettings)};
        const current = (await chrome.storage.local.get(key))[key] ?? null;
        if (current === previous) return { unchanged: true };
        if (previous === null) await chrome.storage.local.remove(key);
        else await chrome.storage.local.set({ [key]: previous });
        return { restored: true };
      })()`);
    });
  }
  if (routeInstalled) await cleanup(() => page.unroute('**/*', routeFixture));
  await cleanup(() => page.close());
  if (cleanupErrors.length > 0) {
    try {
      await writeFile(
        join(output, 'chromium-bootstrap-boundaries-cleanup-failure.json'),
        JSON.stringify(
          {
            status: 'failed',
            scenarioError: primaryError ? errorText(primaryError) : null,
            scenarioResult: result ?? null,
            cleanupErrors: cleanupErrors.map(errorText),
          },
          null,
          2
        )
      );
    } catch (diagnosticError) {
      cleanupErrors.push(diagnosticError);
    }
    throw new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      'Bootstrap boundary cleanup failed'
    );
  }
  if (primaryError) throw primaryError;
  assert(result, 'Bootstrap boundary fixture completed without observations');
  return result;
}
