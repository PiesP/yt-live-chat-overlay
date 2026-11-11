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

type Row = { source: string; text: string; className: string };

function fakeSession(candidateRows: Row[] = [], overflow = false) {
  let diagnosticId = '';
  let diagnosticBackground = '';
  let diagnosticInstalled = false;
  let activeCandidateUuid = candidateUuid;
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
          : candidateRows;
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
    await expect(observer.capture('live')).rejects.toThrow('candidate background error');
    const retained = JSON.parse(
      await readFile(join(root, 'firefox-console-observation.json'), 'utf8')
    ) as {
      captures: { label: string; rows: Row[] }[];
      failures: string[];
    };
    expect(retained.captures[0]?.rows[0]?.source).toBe(candidateSource);
    expect(retained.failures).toContain(
      'Firefox Browser Console candidate background error observed'
    );
    await expect(observer.finish()).rejects.toThrow('candidate background error');
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
});
