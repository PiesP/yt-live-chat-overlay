import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const action = resolve(import.meta.dirname, '../../../.github/actions/validate-semgrep-sarif');
const entry = join(action, 'index.mjs');
const runtime = process.env.SEMGREP_ACTION_NODE ?? process.execPath;

type Run = Record<string, unknown>;

function run(results: unknown[] = []): Run {
  return {
    tool: { driver: { name: 'Semgrep OSS', rules: [{ id: 'audit-rule' }] } },
    results,
    invocations: [{ executionSuccessful: true }],
  };
}

function sarif(runs: unknown[] = [run()]): string {
  return JSON.stringify({ version: '2.1.0', runs });
}

function invoke(
  options: {
    report?: string | Uint8Array;
    category?: string;
    status?: string;
    output?: 'file' | 'directory' | 'missing';
    reportWritable?: boolean;
    pathInput?: string;
  } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'semgrep-sarif-action-'));
  const reportPath = join(directory, 'semgrep.sarif');
  const outputPath = join(directory, 'github-output');
  try {
    // A candidate checkout must never supply the Action's implementation or runtime.
    writeFileSync(join(directory, 'validate.ts'), 'throw new Error("candidate code loaded");\n');
    writeFileSync(join(directory, 'node'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    if (options.report !== undefined) {
      writeFileSync(reportPath, options.report);
      if (options.reportWritable === false) chmodSync(reportPath, 0o444);
    }
    if (options.output === 'directory') {
      // Appending to a directory must fail after the report has been validated.
      mkdirSync(outputPath);
    } else if (options.output !== 'missing') {
      writeFileSync(outputPath, '');
    }
    const result = spawnSync(runtime, [entry], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        PATH: directory,
        INPUT_SARIF_PATH: options.pathInput ?? reportPath,
        INPUT_CATEGORY: options.category ?? 'semgrep/secrets',
        INPUT_SCANNER_STATUS: options.status ?? '0',
        GITHUB_OUTPUT: options.output === 'missing' ? '' : outputPath,
      },
    });
    return {
      result,
      outputs:
        existsSync(outputPath) && options.output !== 'directory'
          ? readFileSync(outputPath, 'utf8')
          : '',
      report: existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : undefined,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('repository-owned Semgrep SARIF Action', () => {
  it('declares the runner Node 24 entrypoint and explicit inputs', () => {
    const metadata = readFileSync(join(action, 'action.yaml'), 'utf8');
    expect(metadata).toContain('using: node24');
    expect(metadata).toContain('main: index.mjs');
    expect(metadata).toContain('sarif_path:');
    expect(metadata).toContain('scanner_status:');
  });

  it.each(['semgrep/secrets', 'semgrep/full'])('normalizes clean %s reports', (category) => {
    const source = run();
    source.automationDetails = { id: 'old', description: { text: 'retained' } };
    const check = invoke({ report: sarif([source]), category });
    expect(check.result.status, check.result.stderr).toBe(0);
    expect(check.result.stdout).toMatch(/Semgrep SARIF validator runtime: v\d+\.\d+\.\d+ \(/);
    expect(check.result.stdout).toContain(`(${runtime})`);
    expect(check.outputs).toBe(`sarif-upload=true\ncategory=${category}\n`);
    const normalized = JSON.parse(check.report ?? '') as { runs: { automationDetails: unknown }[] };
    expect(normalized.runs[0]?.automationDetails).toEqual({
      id: `${category}/`,
      description: { text: 'retained' },
    });
  });

  it('accepts findings across runs, empty message text, and null automation details', () => {
    const first = run();
    first.automationDetails = null;
    const second = run([{ ruleId: 'audit-rule', message: { text: '' } }]);
    const check = invoke({ report: sarif([first, second]), status: '1' });
    expect(check.result.status, check.result.stderr).toBe(1);
    expect(check.outputs).toBe('sarif-upload=true\ncategory=semgrep/secrets\n');
    const normalized = JSON.parse(check.report ?? '') as { runs: { automationDetails: unknown }[] };
    expect(normalized.runs.map((item) => item.automationDetails)).toEqual([
      { id: 'semgrep/secrets/' },
      { id: 'semgrep/secrets/' },
    ]);
  });

  it('preserves large positive and negative integer metadata while replacing only the category ID', () => {
    const source = sarif([
      { ...run(), automationDetails: { id: 'old', marker: 'LARGE_INTEGERS' } },
    ]).replace(
      '"marker":"LARGE_INTEGERS"',
      '"positive":9007199254740993,"negative":-9007199254740993'
    );
    const check = invoke({ report: source });
    expect(check.result.status, check.result.stderr).toBe(0);
    expect(check.report).toContain('"positive":9007199254740993');
    expect(check.report).toContain('"negative":-9007199254740993');
    expect(check.report).toContain('"id":"semgrep/secrets/"');
  });

  it.each([
    ['malformed JSON', '{'],
    ['UTF-8 BOM', `\uFEFF${sarif()}`],
    ['non-object root', '[]'],
    ['wrong version', JSON.stringify({ version: '2.0.0', runs: [run()] })],
    ['missing runs', JSON.stringify({ version: '2.1.0' })],
    ['empty runs', sarif([])],
    ['invalid run', sarif([null])],
    [
      'wrong tool',
      sarif([{ ...run(), tool: { driver: { name: 'Other', rules: [{ id: 'audit-rule' }] } } }]),
    ],
    ['empty rules', sarif([{ ...run(), tool: { driver: { name: 'Semgrep OSS', rules: [] } } }])],
    [
      'duplicate rules',
      sarif([
        {
          ...run(),
          tool: {
            driver: { name: 'Semgrep OSS', rules: [{ id: 'audit-rule' }, { id: 'audit-rule' }] },
          },
        },
      ]),
    ],
    ['unknown result rule', sarif([run([{ ruleId: 'other', message: { text: 'x' } }])])],
    ['invalid result message', sarif([run([{ ruleId: 'audit-rule', message: { text: null } }])])],
    ['missing invocation', sarif([{ ...run(), invocations: [] }])],
    ['failed invocation', sarif([{ ...run(), invocations: [{ executionSuccessful: false }] }])],
    [
      'null notifications',
      sarif([
        {
          ...run(),
          invocations: [{ executionSuccessful: true, toolExecutionNotifications: null }],
        },
      ]),
    ],
    [
      'error notification',
      sarif([
        {
          ...run(),
          invocations: [
            { executionSuccessful: true, toolExecutionNotifications: [{ level: 'error' }] },
          ],
        },
      ]),
    ],
    ['invalid automation details', sarif([{ ...run(), automationDetails: [] }])],
    [
      'large integer automation details',
      sarif([{ ...run(), automationDetails: 'PLACEHOLDER' }]).replace(
        '"PLACEHOLDER"',
        '9007199254740993'
      ),
    ],
    [
      'large integer notification',
      sarif([
        {
          ...run(),
          invocations: [{ executionSuccessful: true, toolExecutionNotifications: ['PLACEHOLDER'] }],
        },
      ]).replace('"PLACEHOLDER"', '-9007199254740993'),
    ],
    ['invalid second run', sarif([run(), { ...run(), results: null }])],
  ] as const)('rejects %s before publishing outputs', (_label, report) => {
    const check = invoke({ report });
    expect(check.result.status).toBe(2);
    expect(check.outputs).toBe('');
    expect(check.report).toBe(report);
    expect(check.result.stderr.length).toBeLessThan(200);
  });

  it('rejects invalid UTF-8 without replacement characters', () => {
    const check = invoke({ report: Uint8Array.from([0xff, 0xfe]) });
    expect(check.result.status).toBe(2);
    expect(check.outputs).toBe('');
  });

  it.each([
    ['missing report', {}],
    ['missing SARIF path input', { report: sarif(), pathInput: '' }],
    ['findings without results', { report: sarif(), status: '1' }],
    [
      'clean status with results',
      { report: sarif([run([{ ruleId: 'audit-rule', message: { text: 'x' } }])]) },
    ],
    ['invalid status', { report: sarif(), status: '2' }],
    ['missing status', { report: sarif(), status: '' }],
    ['invalid category', { report: sarif(), category: 'other' }],
    ['missing category', { report: sarif(), category: '' }],
    ['missing output path', { report: sarif(), output: 'missing' as const }],
    ['unwritable report', { report: sarif(), reportWritable: false }],
    ['unwritable output', { report: sarif(), output: 'directory' as const }],
  ] as const)('fails closed for %s', (_label, options) => {
    const check = invoke(options);
    expect(check.result.status).toBe(2);
    expect(check.outputs).toBe('');
  });
});
