// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Script } from 'node:vm';

import type { BrowserContext, Worker } from '@playwright/test';

const PAGE_SCRIPT_PATH = 'dist-extension/page-script.js';
const ENTRY_MARKER = '\n\tmain();\n';
const PROBE_KEY = '__ytWindowsNativePageScriptProbe';
const GENERATION_KEY = `${PROBE_KEY}Generation`;
const MAX_PAGE_SCRIPT_BYTES = 2_097_152;

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

/** Only an insertion immediately before the packaged main() call is accepted. */
export function assertInstrumentedPageScript(base: string, instrumented: string): void {
  const parts = base.split(ENTRY_MARKER);
  assert.equal(parts.length, 2, 'Packaged page-script entry shape changed');
  const [before, after] = parts;
  assert(before !== undefined && after !== undefined);
  assert(instrumented.startsWith(before) && instrumented.endsWith(ENTRY_MARKER + after));
  const insertion = instrumented.slice(
    before.length,
    instrumented.length - ENTRY_MARKER.length - after.length
  );
  assert(
    insertion.length > 0 && insertion.length < 262_144,
    'Page-script probe insertion is not bounded'
  );
  assert.equal(instrumented, before + insertion + ENTRY_MARKER + after);
  assert(Buffer.byteLength(base, 'utf8') <= MAX_PAGE_SCRIPT_BYTES);
  assert(Buffer.byteLength(instrumented, 'utf8') <= MAX_PAGE_SCRIPT_BYTES + 262_144);
}

function workerExpression({
  token,
  generation,
  extensionId,
  fixtureUrl,
  baseSha256,
  instrumentedSha256,
  functionSha256,
  functionSource,
}: {
  token: string;
  generation: string;
  extensionId: string;
  fixtureUrl: string;
  baseSha256: string;
  instrumentedSha256: string;
  functionSha256: string;
  functionSource: string;
}): string {
  // Worker.evaluate parses this trusted, local, source-bound expression. The
  // browser receives a literal function, never eval/new Function/page input.
  const expression = `(async () => {
    const key = ${JSON.stringify(PROBE_KEY)};
    const token = ${JSON.stringify(token)};
    const fixtureUrl = ${JSON.stringify(fixtureUrl)};
    if (globalThis[${JSON.stringify(GENERATION_KEY)}] !== ${JSON.stringify(generation)})
      throw new Error('Native page-script worker generation changed');
    if (globalThis[key]) throw new Error('Native page-script probe is already installed');
    if (chrome.runtime.id !== ${JSON.stringify(extensionId)}) throw new Error('Extension identity changed');
    const response = await fetch(chrome.runtime.getURL('page-script.js'));
    if (!response.ok) throw new Error('Packaged page script is unavailable');
    const packaged = await response.text();
    if (new TextEncoder().encode(packaged).byteLength > ${MAX_PAGE_SCRIPT_BYTES})
      throw new Error('Packaged page script exceeded its bound');
    const digest = async (source) => Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('');
    if (await digest(packaged) !== ${JSON.stringify(baseSha256)})
      throw new Error('Packaged page script differs from the fixture source');
    const probeFunction = ${functionSource};
    const functionText = probeFunction.toString();
    if (await digest(functionText) !== ${JSON.stringify(functionSha256)})
      throw new Error('Instrumented page function differs from the fixture source');
    const prefix = ${JSON.stringify('function() {\n')};
    const suffix = ${JSON.stringify('\n}')};
    if (!functionText.startsWith(prefix) || !functionText.endsWith(suffix) ||
        await digest(functionText.slice(prefix.length, -suffix.length)) !== ${JSON.stringify(instrumentedSha256)})
      throw new Error('Instrumented page script differs from the fixture source');
    const scripting = chrome.scripting;
    const original = scripting.executeScript;
    const state = { token, original, wrapper: null, hits: 0, completed: 0, documentId: null };
    const wrapper = async function(injection) {
      const fixedFile = Array.isArray(injection?.files) &&
        injection.files.length === 1 && injection.files[0] === 'page-script.js';
      if (!fixedFile) return Reflect.apply(original, scripting, [injection]);
      const target = injection.target;
      if (Object.keys(injection).sort().join(',') !== 'files,target,world' ||
          injection.world !== 'MAIN' ||
          !target || !Number.isSafeInteger(target.tabId) ||
          Object.keys(target).sort().join(',') !== 'documentIds,tabId' ||
          !Array.isArray(target.documentIds) || target.documentIds.length !== 1 ||
          typeof target.documentIds[0] !== 'string' ||
          !/^[0-9a-f]{32}$/i.test(target.documentIds[0]) ||
          'frameIds' in target || 'allFrames' in target ||
          injection.args !== undefined || injection.func !== undefined)
        throw new Error('Native page-script injection contract changed');
      const tab = await chrome.tabs.get(target.tabId);
      if (typeof tab?.url !== 'string') throw new Error('Native page-script tab URL is unavailable');
      if (tab.url !== fixtureUrl) return Reflect.apply(original, scripting, [injection]);
      if (state.hits !== 0) throw new Error('Native page-script probe was reused');
      state.hits = 1;
      state.documentId = target.documentIds[0];
      const result = await Reflect.apply(original, scripting, [{
        target, world: injection.world, func: probeFunction,
      }]);
      if (!Array.isArray(result) || result.length !== 1 ||
          result[0]?.documentId !== state.documentId || result[0]?.frameId !== 0)
        throw new Error('Native page-script probe reached a different document');
      state.completed = 1;
      return result;
    };
    state.wrapper = wrapper;
    scripting.executeScript = wrapper;
    if (scripting.executeScript !== wrapper)
      throw new Error('Native page-script API cannot be wrapped');
    globalThis[key] = state;
    return { token, baseSha256: ${JSON.stringify(baseSha256)}, instrumentedSha256: ${JSON.stringify(instrumentedSha256)}, functionSha256: ${JSON.stringify(functionSha256)} };
  })()`;
  new Script(expression, { filename: 'native-page-script-probe-install.js' });
  return expression;
}

function statusExpression(token: string, generation: string): string {
  return `(() => {
    if (globalThis[${JSON.stringify(GENERATION_KEY)}] !== ${JSON.stringify(generation)})
      throw new Error('Native page-script probe worker generation was lost');
    const state = globalThis[${JSON.stringify(PROBE_KEY)}];
    if (!state || state.token !== ${JSON.stringify(token)} ||
        chrome.scripting.executeScript !== state.wrapper)
      throw new Error('Native page-script probe was lost or replaced');
    return { hits: state.hits, completed: state.completed, documentId: state.documentId };
  })()`;
}

function restoreExpression(token: string, generation: string): string {
  return `(() => {
    const key = ${JSON.stringify(PROBE_KEY)};
    const receiptKey = ${JSON.stringify(`${PROBE_KEY}Receipt`)};
    const state = globalThis[key];
    if (state && state.token !== ${JSON.stringify(token)}) return { status: 'foreign' };
    if (globalThis[${JSON.stringify(GENERATION_KEY)}] !== ${JSON.stringify(generation)})
      return { status: 'generation-lost' };
    if (!state) {
      const receipt = globalThis[receiptKey];
      if (receipt?.token === ${JSON.stringify(token)} &&
          chrome.scripting.executeScript === receipt.original)
        return { status: 'already-restored' };
      return { status: receipt ? 'foreign' : 'absent' };
    }
    if (chrome.scripting.executeScript === state.wrapper)
      chrome.scripting.executeScript = state.original;
    else if (chrome.scripting.executeScript !== state.original)
      return { status: 'foreign' };
    if (chrome.scripting.executeScript !== state.original)
      throw new Error('Native page-script API restoration failed');
    delete globalThis[key];
    if (globalThis[key] !== undefined)
      throw new Error('Native page-script probe token remained after cleanup');
    globalThis[receiptKey] = { token: state.token, original: state.original };
    return { status: 'restored', hits: state.hits, completed: state.completed };
  })()`;
}

type RestoreReceipt = {
  status: 'restored' | 'already-restored' | 'foreign' | 'absent' | 'generation-lost';
  hits?: number;
  completed?: number;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface NativePageScriptProbe {
  readonly provenance: {
    packagedSha256: string;
    instrumentedSha256: string;
    functionSha256: string;
  };
  /** Check immediately before navigation; a restarted MV3 worker loses the wrapper. */
  assertReady(): Promise<void>;
  /** Require the exact fixture injection, even if the page appeared healthy. */
  assertInjected(): Promise<void>;
  /** Restore only the wrapper installed under this token. */
  restore(): Promise<void>;
}

export async function installNativePageScriptProbe({
  context,
  root,
  extensionId,
  fixtureUrl,
  instrumentedSource,
}: {
  context: BrowserContext;
  root: string;
  extensionId: string;
  fixtureUrl: string;
  instrumentedSource: string;
}): Promise<NativePageScriptProbe> {
  assert.match(extensionId, /^[a-p]{32}$/);
  const fixture = new URL(fixtureUrl);
  assert.equal(fixture.protocol, 'https:');
  assert.equal(fixture.hostname, 'www.youtube.com');
  assert.equal(fixture.href, fixtureUrl);
  const base = await readFile(join(root, PAGE_SCRIPT_PATH), 'utf8');
  assertInstrumentedPageScript(base, instrumentedSource);
  const functionSource = `function() {\n${instrumentedSource}\n}`;
  new Script(`(${functionSource})`, { filename: 'native-page-script-probe-function.js' });
  const expectedUrl = `chrome-extension://${extensionId}/background.js`;
  const workers = context.serviceWorkers().filter((candidate) => candidate.url() === expectedUrl);
  assert.equal(workers.length, 1, 'Exact extension background worker is unavailable');
  const worker: Worker | undefined = workers[0];
  assert(worker);
  const token = randomUUID();
  const generation = randomUUID();
  const preflight = await worker.evaluate<string>(`(() => {
    if (globalThis[${JSON.stringify(PROBE_KEY)}])
      throw new Error('Native page-script probe is already installed');
    globalThis[${JSON.stringify(GENERATION_KEY)}] = ${JSON.stringify(generation)};
    return globalThis[${JSON.stringify(GENERATION_KEY)}];
  })()`);
  assert.equal(preflight, generation);
  const baseSha256 = sha256(base);
  const instrumentedSha256 = sha256(instrumentedSource);
  const functionSha256 = sha256(functionSource);
  try {
    const receipt = await worker.evaluate<{
      token: string;
      baseSha256: string;
      instrumentedSha256: string;
      functionSha256: string;
    }>(
      workerExpression({
        token,
        generation,
        extensionId,
        fixtureUrl,
        baseSha256,
        instrumentedSha256,
        functionSha256,
        functionSource,
      })
    );
    assert.deepEqual(receipt, { token, baseSha256, instrumentedSha256, functionSha256 });
  } catch (error) {
    let cleanup: RestoreReceipt;
    try {
      cleanup = await worker.evaluate<RestoreReceipt>(restoreExpression(token, generation));
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Native page-script probe install failed: ${errorText(error)}; cleanup evaluation failed: ${errorText(cleanupError)}`
      );
    }
    throw new Error(
      `Native page-script probe install failed: ${errorText(error)}; cleanup=${cleanup.status}`,
      { cause: error }
    );
  }

  const status = async () =>
    worker.evaluate<{ hits: number; completed: number; documentId: string | null }>(
      statusExpression(token, generation)
    );
  return {
    provenance: { packagedSha256: baseSha256, instrumentedSha256, functionSha256 },
    async assertReady() {
      assert.deepEqual(await status(), { hits: 0, completed: 0, documentId: null });
    },
    async assertInjected() {
      const current = await status();
      assert.equal(
        current.hits,
        1,
        'Native page-script probe did not replace exactly one injection'
      );
      assert.equal(current.completed, 1, 'Native page-script probe injection did not complete');
      assert.match(current.documentId ?? '', /^[0-9a-f]{32}$/i);
    },
    async restore() {
      const receipt = await worker.evaluate<RestoreReceipt>(restoreExpression(token, generation));
      assert(
        receipt.status === 'restored' || receipt.status === 'already-restored',
        `Native page-script probe cleanup not verified: ${receipt.status}`
      );
    },
  };
}
