// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
  beginFirefoxConsoleObservation,
  classifyFirefoxConsoleRows,
} from '../../../validation/windows/firefox-console.ts';

const candidateId = 'yt-live-chat-overlay@piesp.github.io';
const candidateUuid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const diagnosticUuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const candidateSource = `moz-extension://${candidateUuid}/background.js`;
const pageSource = `moz-extension://${candidateUuid}/page-script.js`;
const policyText =
  'Content-Security-Policy: The page’s settings blocked assigning to an injection sink because it violates the following directive: “require-trusted-types-for ’script’“';

type Row = { source: string; text: string; className: string; observerId?: number };

function fakeSession(candidateRows: Row[] = [], overflow = false) {
  let diagnosticId = '';
  let diagnosticBackground = '';
  let diagnosticInstalled = false;
  let activeCandidateUuid = candidateUuid;
  let currentRows = candidateRows;
  const activated: string[] = [];
  const uninstalled: string[] = [];
  const command = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'browsingContext.getTree') {
      expect(params).toEqual({ 'moz:scope': 'chrome' });
      return {
        contexts: [
          { context: 'console-context', url: 'chrome://devtools/content/webconsole/index.html' },
        ],
      };
    }
    if (method === 'browsingContext.activate') {
      activated.push(String(params?.context));
      return {};
    }
    if (method === 'webExtension.moz:listExtensions') {
      return {
        extensions: [
          {
            id: candidateId,
            isActive: true,
            policy: {
              extensionURL: `moz-extension://${activeCandidateUuid}/`,
              backgroundScripts: ['background.js'],
            },
          },
          ...(diagnosticInstalled
            ? [
                {
                  id: diagnosticId,
                  isActive: true,
                  policy: {
                    extensionURL: `moz-extension://${diagnosticUuid}/`,
                    backgroundScripts: ['background.js'],
                  },
                },
              ]
            : []),
        ],
      };
    }
    if (method === 'script.evaluate') {
      expect(params?.target).toEqual({ context: 'console-context' });
      const expression = String(params?.expression);
      if (expression.includes('const sources =')) {
        const diagnosticSource = `moz-extension://${diagnosticUuid}/background.js`;
        const marker = /yt-console-control-[0-9a-f-]+/u.exec(diagnosticBackground)?.[0] ?? '';
        const exception = /yt-console-exception-[0-9a-f-]+/u.exec(diagnosticBackground)?.[0] ?? '';
        const isDiagnostic = expression.includes(diagnosticSource);
        const rows = isDiagnostic
          ? [
              { source: diagnosticSource, text: marker, className: 'message error' },
              {
                source: diagnosticSource,
                text: `Uncaught Error: ${exception}`,
                className: 'message error',
              },
            ]
          : currentRows;
        return {
          type: 'success',
          result: {
            type: 'string',
            value: JSON.stringify({
              rows,
              overflow: isDiagnostic ? false : overflow,
              observing: true,
              mode: 'everything',
            }),
          },
        };
      }
      return {
        type: 'success',
        result: {
          type: 'string',
          value: JSON.stringify({
            mode: 'everything',
            started: true,
          }),
        },
      };
    }
    throw new Error(`Unexpected command ${method}`);
  };
  return {
    session: {
      context: 'content-context',
      command,
      installExtension: async (path: string) => {
        const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')) as {
          browser_specific_settings: { gecko: { id: string } };
        };
        diagnosticId = manifest.browser_specific_settings.gecko.id;
        diagnosticBackground = await readFile(join(path, 'background.js'), 'utf8');
        diagnosticInstalled = true;
        return diagnosticId;
      },
      uninstallExtension: async (id: string) => {
        uninstalled.push(id);
        diagnosticInstalled = false;
      },
    },
    setCandidateUuid: (uuid: string) => {
      activeCandidateUuid = uuid;
    },
    setCandidateRows: (rows: Row[]) => {
      currentRows = rows;
    },
    activated,
    uninstalled,
  };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function outputRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'yt-firefox-console-test-'));
  roots.push(root);
  const packaged = join(root, 'dist-extension-firefox');
  await mkdir(packaged);
  await writeFile(
    join(packaged, 'manifest.json'),
    JSON.stringify({
      version: '0.47.0',
      browser_specific_settings: { gecko: { id: candidateId } },
      background: { scripts: ['background.js'] },
    })
  );
  await writeFile(join(packaged, 'background.js'), 'console.log("candidate");\n');
  await writeFile(
    join(packaged, 'page-script.js'),
    '// bundled candidate\nnew Worker("worker.js");\n'
  );
  return root;
}

describe('Firefox Browser Console observer', () => {
  it('proves the separate diagnostic error and exception, then captures only actual candidate source', async () => {
    const root = await outputRoot();
    const fake = fakeSession([
      { source: candidateSource, text: 'candidate startup', className: 'message log' },
      {
        source: `moz-extension://${diagnosticUuid}/background.js`,
        text: 'foreign error',
        className: 'message error',
      },
    ]);
    const observer = await beginFirefoxConsoleObservation(fake.session, root, root);
    await observer.bindCandidate(candidateId);
    await observer.capture('startup');
    const record = await observer.finish();
    expect(record.diagnosticControl).toMatchObject({ observed: true, uninstalled: true });
    expect(record.candidate).toMatchObject({
      id: candidateId,
      activeUuid: candidateUuid,
      backgroundSources: [candidateSource],
    });
    expect(record.captures).toMatchObject([
      {
        label: 'startup',
        overflow: false,
        allowedPolicyRows: [],
        rows: [{ source: candidateSource, text: 'candidate startup', className: 'message log' }],
      },
    ]);
    expect(fake.activated).toEqual(['content-context']);
    expect(fake.uninstalled).toHaveLength(1);
    expect(await readdir(root)).toEqual([
      'dist-extension-firefox',
      'firefox-console-observation.json',
    ]);
  });

  it('rejects candidate background errors and retains the failed evidence', async () => {
    const root = await outputRoot();
    const fake = fakeSession([
      { source: candidateSource, text: 'TypeError: failed', className: 'message error' },
    ]);
    const observer = await beginFirefoxConsoleObservation(fake.session, root, root);
    await observer.bindCandidate(candidateId);
    await expect(observer.capture('live')).rejects.toThrow('candidate extension error');
    const retained = JSON.parse(
      await readFile(join(root, 'firefox-console-observation.json'), 'utf8')
    ) as {
      captures: { label: string; rows: Row[] }[];
      failures: string[];
    };
    expect(retained.captures[0]?.rows[0]?.source).toBe(candidateSource);
    expect(retained.failures).toContain(
      'Firefox Browser Console candidate extension error observed'
    );
    await expect(observer.finish()).rejects.toThrow('candidate extension error');
  });

  it('rejects overflow and errors from every candidate script while excluding other UUIDs', async () => {
    const identity = {
      id: candidateId,
      activeUuid: candidateUuid,
      backgroundSources: [candidateSource],
    };
    expect(
      classifyFirefoxConsoleRows(
        [
          {
            source: `moz-extension://${diagnosticUuid}/background.js`,
            text: 'error',
            className: 'message error',
          },
          {
            source: `moz-extension://${candidateUuid}/other.js`,
            text: 'error',
            className: 'message error',
          },
          { source: `${candidateSource}:2:3`, text: 'own event', className: 'message log' },
        ],
        identity
      )
    ).toEqual({
      rows: [
        {
          source: `moz-extension://${candidateUuid}/other.js`,
          text: 'error',
          className: 'message error',
        },
        { source: `${candidateSource}:2:3`, text: 'own event', className: 'message log' },
      ],
      errors: [
        {
          source: `moz-extension://${candidateUuid}/other.js`,
          text: 'error',
          className: 'message error',
        },
      ],
      overflow: false,
    });
    const root = await outputRoot();
    const observer = await beginFirefoxConsoleObservation(
      fakeSession([], true).session,
      root,
      root
    );
    await observer.bindCandidate(candidateId);
    await expect(observer.capture('replay')).rejects.toThrow('observation overflow');
  });

  it('fails closed if the active candidate UUID changes after binding', async () => {
    const root = await outputRoot();
    const fake = fakeSession();
    const observer = await beginFirefoxConsoleObservation(fake.session, root, root);
    await observer.bindCandidate(candidateId);
    fake.setCandidateUuid('cccccccc-cccc-cccc-cccc-cccccccccccc');
    await expect(observer.capture('live')).rejects.toThrow(
      'candidate UUID or background source changed'
    );
    const retained = JSON.parse(
      await readFile(join(root, 'firefox-console-observation.json'), 'utf8')
    ) as {
      failures: string[];
    };
    expect(retained.failures).toContain(
      'Firefox Browser Console candidate UUID or background source changed'
    );
  });

  it('matches the native page policy event to the packaged worker creation site and carries that row forward', async () => {
    const root = await outputRoot();
    const policyRow: Row = {
      source: pageSource,
      text: `${policyText} page-script.js:2:1`,
      className: 'message javascript log error',
      observerId: 7,
    };
    const fake = fakeSession([policyRow]);
    const observer = await beginFirefoxConsoleObservation(fake.session, root, root);
    await observer.bindCandidate(candidateId);
    await observer.capture('public-capture', {
      workerPolicyFallback: true,
      pageLogs: [
        {
          level: 'error',
          type: 'javascript',
          text: policyText,
          timestamp: 100,
          source: { realm: 'page-realm', context: 'content-context' },
        },
      ],
    });
    await observer.capture('before-uninstall');
    const record = await observer.finish();
    expect(record.candidate).toMatchObject({ workerCreationLocations: ['2:1'] });
    expect(record.captures).toMatchObject([
      {
        allowedPolicyRows: [
          {
            row: policyRow,
            pageEvent: { timestamp: 100, realm: 'page-realm', context: 'content-context' },
            reused: false,
          },
        ],
      },
      { allowedPolicyRows: [{ row: policyRow, reused: true }] },
    ]);
  });

  it('rejects an extra identical console row beyond the native page event count', async () => {
    const root = await outputRoot();
    const row: Row = {
      source: pageSource,
      text: `${policyText} page-script.js:2:1`,
      className: 'message javascript log error',
      observerId: 7,
    };
    const fake = fakeSession([row, { ...row, observerId: 8 }]);
    const observer = await beginFirefoxConsoleObservation(fake.session, root, root);
    await observer.bindCandidate(candidateId);
    await expect(
      observer.capture('public-capture', {
        workerPolicyFallback: true,
        pageLogs: [
          {
            level: 'error',
            type: 'javascript',
            text: policyText,
            timestamp: 100,
            source: { realm: 'page-realm', context: 'content-context' },
          },
        ],
      })
    ).rejects.toThrow('candidate extension error');
    const retained = JSON.parse(
      await readFile(join(root, 'firefox-console-observation.json'), 'utf8')
    ) as {
      captures: { rows: Row[]; allowedPolicyRows: Row[] }[];
    };
    expect(retained.captures[0]?.rows).toHaveLength(2);
    expect(retained.captures[0]?.allowedPolicyRows).toHaveLength(1);
  });

  it('does not grant a new policy allowance during final cleanup capture', async () => {
    const root = await outputRoot();
    const row: Row = {
      source: pageSource,
      text: `${policyText} page-script.js:2:1`,
      className: 'message javascript log error',
      observerId: 7,
    };
    const fake = fakeSession([row]);
    const observer = await beginFirefoxConsoleObservation(fake.session, root, root);
    await observer.bindCandidate(candidateId);
    await observer.capture('public-capture', {
      workerPolicyFallback: true,
      pageLogs: [
        {
          level: 'error',
          type: 'javascript',
          text: policyText,
          timestamp: 100,
          source: { realm: 'page-realm', context: 'content-context' },
        },
      ],
    });
    fake.setCandidateRows([row, { ...row, observerId: 8 }]);
    await expect(observer.capture('before-uninstall')).rejects.toThrow('candidate extension error');
    const retained = JSON.parse(
      await readFile(join(root, 'firefox-console-observation.json'), 'utf8')
    ) as {
      captures: { allowedPolicyRows: { reused: boolean }[] }[];
    };
    expect(retained.captures[1]?.allowedPolicyRows).toEqual([
      expect.objectContaining({ reused: true }),
    ]);
  });

  it('rejects missing or mismatched policy evidence and candidate error sources', async () => {
    const pageLog = {
      level: 'error',
      type: 'javascript',
      text: policyText,
      timestamp: 100,
      source: { realm: 'page-realm', context: 'content-context' },
    };
    const row: Row = {
      source: pageSource,
      text: `${policyText} page-script.js:2:1`,
      className: 'message javascript log error',
      observerId: 7,
    };
    const cases = [
      { row, evidence: undefined },
      { row, evidence: { workerPolicyFallback: false, pageLogs: [pageLog] } },
      { row, evidence: { workerPolicyFallback: true, pageLogs: [] } },
      {
        row,
        evidence: { workerPolicyFallback: true, pageLogs: [{ ...pageLog, type: 'console' }] },
      },
      {
        row,
        evidence: {
          workerPolicyFallback: true,
          pageLogs: [{ ...pageLog, source: { realm: 'page-realm', context: 'different-context' } }],
        },
      },
      {
        row: { ...row, className: 'message console-api javascript log error' },
        evidence: { workerPolicyFallback: true, pageLogs: [pageLog] },
      },
      {
        row: { ...row, source: candidateSource },
        evidence: { workerPolicyFallback: true, pageLogs: [pageLog] },
      },
      {
        row: { ...row, text: `${policyText} page-script.js:3:1` },
        evidence: { workerPolicyFallback: true, pageLogs: [pageLog] },
      },
      {
        row: { ...row, text: policyText },
        evidence: { workerPolicyFallback: true, pageLogs: [pageLog] },
      },
      {
        row: { ...row, text: `${policyText} extra page-script.js:2:1` },
        evidence: { workerPolicyFallback: true, pageLogs: [pageLog] },
      },
    ];
    for (const item of cases) {
      const root = await outputRoot();
      const observer = await beginFirefoxConsoleObservation(
        fakeSession([item.row]).session,
        root,
        root
      );
      await observer.bindCandidate(candidateId);
      await expect(observer.capture('public-capture', item.evidence)).rejects.toThrow(
        'candidate extension error'
      );
    }
  });
});
