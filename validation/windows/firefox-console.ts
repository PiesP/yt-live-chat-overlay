// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { redactDiagnosticText } from './live-rendering.ts';

type ConsoleSession = {
  context: string;
  command: (
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number
  ) => Promise<unknown>;
  installExtension: (path: string) => Promise<string>;
  uninstallExtension: (id: string) => Promise<void>;
};

type ConsoleRow = { text: string; source: string; className: string };
type Capture = { label: string; capturedUtc: string; rows: ConsoleRow[]; overflow: boolean };
type ExtensionIdentity = { id: string; activeUuid: string; backgroundSources: string[] };
type CandidateIdentity = ExtensionIdentity & {
  boundUtc: string;
  manifestSha256: string;
  version: string;
  backgroundSha256: Record<string, string>;
};

export type FirefoxConsoleObservationRecord = {
  [key: string]: unknown;
  startedUtc: string;
  endedUtc: string | null;
  browserConsoleContext: string | null;
  multiprocessMode: 'everything' | null;
  diagnosticControl: {
    id: string;
    activeUuid: string;
    source: string;
    marker: string;
    exceptionMarker: string;
    manifestSha256: string;
    backgroundSha256: string;
    observed: boolean;
    uninstalled: boolean;
  } | null;
  diagnosticFixtureRetained: boolean;
  diagnosticFixtureDirectory: string | null;
  candidate: CandidateIdentity | null;
  captures: Capture[];
  failures: string[];
};

export type FirefoxConsoleObserver = {
  bindCandidate: (id: string) => Promise<void>;
  capture: (label: string) => Promise<void>;
  finish: () => Promise<Record<string, unknown>>;
};

const MAX_ROWS = 500;
const BROWSER_CONSOLE_URL = 'chrome://devtools/content/webconsole/index.html';
const OUTPUT_FILE = 'firefox-console-observation.json';

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requireString(value: unknown, label: string): string {
  const result = string(value);
  if (!result) throw new Error(`Firefox Browser Console: missing ${label}`);
  return result;
}

function decodeEvaluation(response: unknown): unknown {
  const envelope = object(response);
  if (envelope?.type !== 'success') {
    const detail = object(envelope?.exceptionDetails);
    throw new Error(
      `Firefox Browser Console script failed: ${string(detail?.text) ?? 'unknown error'}`
    );
  }
  const result = object(envelope.result);
  if (result?.type !== 'string' || typeof result.value !== 'string') {
    throw new Error('Firefox Browser Console script returned no JSON string');
  }
  return JSON.parse(result.value) as unknown;
}

async function evaluate(
  session: ConsoleSession,
  context: string,
  expression: string
): Promise<unknown> {
  return decodeEvaluation(
    await session.command('script.evaluate', {
      expression: `JSON.stringify(${expression})`,
      target: { context },
      awaitPromise: false,
    })
  );
}

async function browserConsoleContext(session: ConsoleSession): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const tree = object(
      await session.command('browsingContext.getTree', { 'moz:scope': 'chrome' })
    );
    const contexts = Array.isArray(tree?.contexts) ? tree.contexts : [];
    for (const entry of contexts) {
      const node = object(entry);
      if (node?.url === BROWSER_CONSOLE_URL) return requireString(node.context, 'console context');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Firefox Browser Console chrome context was not observable');
}

async function extensionIdentity(session: ConsoleSession, id: string): Promise<ExtensionIdentity> {
  const response = object(await session.command('webExtension.moz:listExtensions'));
  const extensions = Array.isArray(response?.extensions) ? response.extensions : [];
  const extension = extensions.map(object).find((item) => item?.id === id);
  if (!extension || extension.isActive !== true) {
    throw new Error(`Firefox Browser Console extension is not active: ${id}`);
  }
  const policy = object(extension.policy);
  const extensionUrl = requireString(policy?.extensionURL, 'extensionURL');
  const match = /^moz-extension:\/\/([0-9a-f-]{36})\/$/iu.exec(extensionUrl);
  if (!match?.[1]) throw new Error('Firefox Browser Console extensionURL has no active UUID');
  const scripts = Array.isArray(policy?.backgroundScripts) ? policy.backgroundScripts : [];
  const backgroundSources = scripts
    .filter((script): script is string => typeof script === 'string')
    .map((script) =>
      script.startsWith('moz-extension://')
        ? script
        : `${extensionUrl}${script.replace(/^\//u, '')}`
    );
  if (
    backgroundSources.length === 0 ||
    backgroundSources.some((source) => !source.startsWith(extensionUrl))
  ) {
    throw new Error(
      'Firefox Browser Console background source is unavailable or outside the active UUID'
    );
  }
  return { id, activeUuid: match[1], backgroundSources };
}

const START_OBSERVER = `(() => {
  const selected = document.querySelector('input[type="radio"][value="everything"]');
  if (!(selected instanceof HTMLInputElement)) return { mode: null, started: false };
  selected.click();
  if (!selected.checked) return { mode: null, started: false };
  if (window.__ytFirefoxConsoleEvidence) window.__ytFirefoxConsoleEvidence.observer.disconnect();
  const state = { rows: [], seen: new WeakMap(), overflow: false, observer: null };
  const scan = () => {
    for (const element of document.querySelectorAll('.message')) {
      const anchor = element.querySelector('a[href^="moz-extension://"]');
      if (!anchor) continue;
      const source = anchor.getAttribute('href') || '';
      if (!source) continue;
      const prior = state.seen.get(element);
      const row = { source, text: (element.textContent || '').slice(0, 1200), className: String(element.className) };
      if (prior !== undefined) { state.rows[prior] = row; continue; }
      if (state.rows.length >= ${MAX_ROWS}) { state.overflow = true; continue; }
      state.seen.set(element, state.rows.length);
      state.rows.push(row);
    }
  };
  state.observer = new MutationObserver(scan);
  state.observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
  scan();
  state.scan = scan;
  window.__ytFirefoxConsoleEvidence = state;
  return { mode: selected.checked ? 'everything' : null, started: true };
})()`;

function snapshotExpression(sources: string[]): string {
  return `(() => {
  const state = window.__ytFirefoxConsoleEvidence;
  if (!state) return { rows: [], overflow: false, observing: false, mode: null };
  state.scan();
  const selected = document.querySelector('input[type="radio"][value="everything"]');
  const sources = ${JSON.stringify(sources)};
  const rows = state.rows.filter((row) => sources.some((source) =>
    row.source === source || (row.source.startsWith(source) &&
      (source.endsWith('/') || /^[:?#]/.test(row.source.slice(source.length))))));
  return { rows, overflow: state.overflow, observing: true,
    mode: selected instanceof HTMLInputElement && selected.checked ? 'everything' : null };
})()`;
}

function parseSnapshot(value: unknown): { rows: ConsoleRow[]; overflow: boolean } {
  const result = object(value);
  if (result?.observing !== true || result.mode !== 'everything') {
    throw new Error('Firefox Browser Console observer or Multiprocess mode was lost');
  }
  const rawRows = Array.isArray(result.rows) ? result.rows : [];
  const rows = rawRows
    .map(object)
    .filter((row): row is Record<string, unknown> => row !== null)
    .map((row) => ({
      source: string(row.source) ?? '',
      text: redactDiagnosticText(string(row.text) ?? ''),
      className: string(row.className) ?? '',
    }));
  return { rows, overflow: result.overflow === true || rows.length > MAX_ROWS };
}

export function classifyFirefoxConsoleRows(
  rows: ConsoleRow[],
  identity: ExtensionIdentity,
  overflow = false
): { rows: ConsoleRow[]; errors: ConsoleRow[]; overflow: boolean } {
  const origin = `moz-extension://${identity.activeUuid}/`;
  const ownRows = rows.filter((row) => row.source.startsWith(origin));
  return {
    rows: ownRows,
    errors: ownRows.filter(
      (row) =>
        /(?:^|\s)(?:error|exception)(?:\s|$)/iu.test(row.className) ||
        /(?:uncaught|unhandled)\s+(?:exception|error)/iu.test(row.text)
    ),
    overflow: overflow || ownRows.length > MAX_ROWS,
  };
}

export async function beginFirefoxConsoleObservation(
  session: ConsoleSession,
  root: string,
  output: string
): Promise<FirefoxConsoleObserver> {
  const record: FirefoxConsoleObservationRecord = {
    startedUtc: new Date().toISOString(),
    endedUtc: null,
    browserConsoleContext: null,
    multiprocessMode: null,
    diagnosticControl: null,
    diagnosticFixtureRetained: false,
    diagnosticFixtureDirectory: null,
    candidate: null,
    captures: [],
    failures: [],
  };
  const save = async () =>
    writeFile(join(output, OUTPUT_FILE), `${JSON.stringify(record, null, 2)}\n`);
  let context: string;
  try {
    context = await browserConsoleContext(session);
    record.browserConsoleContext = context;
    const mode = object(await evaluate(session, context, START_OBSERVER));
    if (mode?.mode !== 'everything' || mode.started !== true) {
      throw new Error('Firefox Browser Console Multiprocess everything mode was not selectable');
    }
    record.multiprocessMode = 'everything';
    await session.command('browsingContext.activate', { context: session.context });

    const marker = `yt-console-control-${randomUUID()}`;
    const exceptionMarker = `yt-console-exception-${randomUUID()}`;
    const id = `yt-console-control-${randomUUID()}@example.invalid`;
    const manifest = `${JSON.stringify(
      {
        manifest_version: 3,
        name: 'Firefox console diagnostic control',
        version: '1.0',
        browser_specific_settings: {
          gecko: { id, data_collection_permissions: { required: ['none'] } },
        },
        background: { scripts: ['background.js'], type: 'module' },
      },
      null,
      2
    )}\n`;
    const background = `console.error(${JSON.stringify(marker)});\nsetTimeout(() => { throw new Error(${JSON.stringify(exceptionMarker)}); }, 0);\n`;
    const fixture = await mkdtemp(join(root, '.firefox-console-control-'));
    let installedId: string | null = null;
    let uninstalled = true;
    try {
      await writeFile(join(fixture, 'manifest.json'), manifest);
      await writeFile(join(fixture, 'background.js'), background);
      installedId = await session.installExtension(fixture);
      uninstalled = false;
      if (installedId !== id) throw new Error('Firefox diagnostic add-on returned a different ID');
      const identity = await extensionIdentity(session, id);
      record.diagnosticControl = {
        id,
        activeUuid: identity.activeUuid,
        source: identity.backgroundSources[0] ?? '',
        marker,
        exceptionMarker,
        manifestSha256: createHash('sha256').update(manifest).digest('hex'),
        backgroundSha256: createHash('sha256').update(background).digest('hex'),
        observed: false,
        uninstalled: false,
      };
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const snapshot = parseSnapshot(
          await evaluate(session, context, snapshotExpression(identity.backgroundSources))
        );
        if (snapshot.overflow)
          throw new Error('Firefox Browser Console diagnostic observation overflow');
        const own = classifyFirefoxConsoleRows(snapshot.rows, identity);
        if (
          own.rows.some((row) => row.text.includes(marker)) &&
          own.rows.some((row) => row.text.includes(exceptionMarker))
        ) {
          record.diagnosticControl.observed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!record.diagnosticControl.observed) {
        throw new Error(
          'Firefox Browser Console diagnostic error and exception were not source-attributed'
        );
      }
    } finally {
      try {
        if (installedId) {
          await session.uninstallExtension(installedId);
          if (record.diagnosticControl) record.diagnosticControl.uninstalled = true;
          uninstalled = true;
        }
      } finally {
        record.diagnosticFixtureRetained = true;
        record.diagnosticFixtureDirectory = basename(fixture);
        if (uninstalled) {
          await rm(fixture, { recursive: true, force: true });
          record.diagnosticFixtureRetained = false;
          record.diagnosticFixtureDirectory = null;
        }
      }
      await save();
    }
  } catch (error) {
    record.failures.push(error instanceof Error ? error.message : String(error));
    await save();
    throw error;
  }

  return {
    async bindCandidate(id: string): Promise<void> {
      try {
        const identity = await extensionIdentity(session, id);
        const packaged = join(root, 'dist-extension-firefox');
        const manifestText = await readFile(join(packaged, 'manifest.json'), 'utf8');
        const manifest = object(JSON.parse(manifestText));
        const gecko = object(object(manifest?.browser_specific_settings)?.gecko);
        if (gecko?.id !== id) {
          throw new Error('Firefox Browser Console packaged and installed candidate IDs differ');
        }
        const background = object(manifest?.background);
        const scripts = Array.isArray(background?.scripts) ? background.scripts : [];
        const backgroundSha256: Record<string, string> = {};
        const base = `moz-extension://${identity.activeUuid}/`;
        for (const script of scripts) {
          if (typeof script !== 'string' || script.startsWith('/') || script.includes('..')) {
            throw new Error('Firefox Browser Console packaged background path is invalid');
          }
          const source = `${base}${script}`;
          if (!identity.backgroundSources.includes(source)) {
            throw new Error(
              'Firefox Browser Console packaged and active background sources differ'
            );
          }
          backgroundSha256[script] = createHash('sha256')
            .update(await readFile(join(packaged, script)))
            .digest('hex');
        }
        if (scripts.length === 0 || scripts.length !== identity.backgroundSources.length) {
          throw new Error('Firefox Browser Console packaged background source count differs');
        }
        record.candidate = {
          ...identity,
          boundUtc: new Date().toISOString(),
          manifestSha256: createHash('sha256').update(manifestText).digest('hex'),
          version: requireString(manifest?.version, 'packaged candidate version'),
          backgroundSha256,
        };
        await save();
      } catch (error) {
        record.failures.push(error instanceof Error ? error.message : String(error));
        await save();
        throw error;
      }
    },
    async capture(label: string): Promise<void> {
      try {
        if (!record.candidate)
          throw new Error('Firefox Browser Console candidate identity was not bound');
        const current = await extensionIdentity(session, record.candidate.id);
        if (
          current.activeUuid !== record.candidate.activeUuid ||
          JSON.stringify(current.backgroundSources) !==
            JSON.stringify(record.candidate.backgroundSources)
        ) {
          throw new Error('Firefox Browser Console candidate UUID or background source changed');
        }
        const snapshot = parseSnapshot(
          await evaluate(
            session,
            context,
            snapshotExpression([`moz-extension://${record.candidate.activeUuid}/`])
          )
        );
        const own = classifyFirefoxConsoleRows(snapshot.rows, record.candidate, snapshot.overflow);
        record.captures.push({
          label,
          capturedUtc: new Date().toISOString(),
          rows: own.rows,
          overflow: own.overflow,
        });
        if (own.overflow) throw new Error('Firefox Browser Console candidate observation overflow');
        if (own.errors.length > 0)
          throw new Error('Firefox Browser Console candidate background error observed');
      } catch (error) {
        record.failures.push(error instanceof Error ? error.message : String(error));
        await save();
        throw error;
      }
      await save();
    },
    async finish(): Promise<FirefoxConsoleObservationRecord> {
      if (!record.candidate)
        record.failures.push('Firefox Browser Console candidate identity was not bound');
      if (record.captures.length === 0)
        record.failures.push('Firefox Browser Console candidate was not captured');
      record.endedUtc = new Date().toISOString();
      await save();
      if (record.failures.length > 0) throw new Error(record.failures.join('; '));
      return record;
    },
  };
}
