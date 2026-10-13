import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../../.github/workflows/security.yaml'),
  'utf8'
);
const section = workflow.match(/^ {2}semgrep:\n[\s\S]*?(?=^ {2}security-summary:)/m)?.[0];
if (!section) throw new Error('Missing Semgrep workflow job');

function step(name: string): string {
  const body = section?.split(`      - name: ${name}\n`)[1]?.split('\n      - name: ')[0];
  if (!body) throw new Error(`Missing Semgrep step: ${name}`);
  return body;
}

const scanStep = step('🔍 Run Semgrep scan');
const uploadStep = step('📊 Upload SARIF to GitHub Security');
const script =
  scanStep
    .split('        run: |\n')[1]
    ?.split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n') ?? '';
if (!script) throw new Error('Missing Semgrep scan script');

function sarif(results: unknown[] = [], automationId?: string): string {
  return JSON.stringify({
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Semgrep OSS',
            semanticVersion: '1.178.0',
            rules: [{ id: 'audit-rule' }],
          },
        },
        results,
        invocations: [{ executionSuccessful: true, toolExecutionNotifications: [] }],
        ...(automationId
          ? { automationDetails: { id: automationId, description: { text: 'old' } } }
          : {}),
      },
    ],
  });
}

function runScan(event: string, scanStatus = 0, report?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'semgrep-workflow-'));
  try {
    const scanner = join(directory, 'semgrep');
    const output = join(directory, 'github-output');
    const argumentsFile = join(directory, 'arguments');
    const fixture = join(directory, 'fixture.sarif');
    writeFileSync(
      scanner,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$STUB_ARGS"\nif [[ "$STUB_REPORT" == "yes" ]]; then cp "$STUB_FIXTURE" semgrep.sarif; fi\nexit "$STUB_STATUS"\n',
      { mode: 0o755 }
    );
    writeFileSync(output, '');
    if (report !== undefined) writeFileSync(fixture, report);
    const result = spawnSync('bash', ['-c', script], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        GITHUB_EVENT_NAME: event,
        GITHUB_OUTPUT: output,
        STUB_ARGS: argumentsFile,
        STUB_FIXTURE: fixture,
        STUB_REPORT: report === undefined ? 'no' : 'yes',
        STUB_STATUS: String(scanStatus),
        GITHUB_SHA: '1111111111111111111111111111111111111111',
      },
    });
    const args = existsSync(argumentsFile)
      ? readFileSync(argumentsFile, 'utf8').trim().split('\n')
      : [];
    const outputs = readFileSync(output, 'utf8');
    const reportPath = join(directory, 'semgrep.sarif');
    const normalized = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : undefined;
    return { result, args, outputs, normalized };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Run with SEMGREP_REGRESSION_SCANNER=/absolute/path/to/semgrep; no SARIF is uploaded.
function runActualScan(event: string, scanner: string) {
  const directory = mkdtempSync(join(tmpdir(), 'semgrep-profile-'));
  try {
    const source = join(directory, 'source');
    const bin = join(directory, 'bin');
    mkdirSync(source);
    mkdirSync(bin);
    symlinkSync(resolve(scanner), join(bin, 'semgrep'));
    writeFileSync(
      join(source, 'source-audit.py'),
      '# Non-executed scanner fixture.\neval(input())\n'
    );
    const output = join(directory, 'github-output');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', script], {
      cwd: source,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GITHUB_EVENT_NAME: event,
        GITHUB_OUTPUT: output,
        SEMGREP_SEND_METRICS: 'off',
      },
    });
    const reportPath = join(source, 'semgrep.sarif');
    return {
      result,
      outputs: readFileSync(output, 'utf8'),
      report: existsSync(reportPath)
        ? (JSON.parse(readFileSync(reportPath, 'utf8')) as {
            runs: {
              tool: { driver: { semanticVersion: string; rules: unknown[] } };
              results: { ruleId: string }[];
              automationDetails: { id: string };
            }[];
          })
        : undefined,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function condition(
  body: string,
  result: string,
  semgrep: string,
  upload: string,
  cancelled = false
) {
  const expression = body.match(/if: \$\{\{ (.+) \}\}/)?.[1];
  if (!expression) throw new Error('Missing workflow condition');
  return runInNewContext(
    expression
      .replaceAll('steps.semgrep-report', 'steps.report')
      .replaceAll('outputs.sarif-upload', 'outputs.sarifUpload'),
    {
      cancelled: () => cancelled,
      needs: { changes: { result, outputs: { semgrep } } },
      steps: { report: { outputs: { sarifUpload: upload } } },
    }
  ) as boolean;
}

describe('Semgrep workflow composition', () => {
  it.each([
    ['push', 'semgrep/secrets', ['--config=p/secrets']],
    ['pull_request', 'semgrep/secrets', ['--config=p/secrets']],
    ['merge_group', 'semgrep/secrets', ['--config=p/secrets']],
    [
      'schedule',
      'semgrep/full',
      [
        '--config=p/typescript',
        '--config=p/javascript',
        '--config=p/security-audit',
        '--config=p/secrets',
      ],
    ],
    [
      'workflow_dispatch',
      'semgrep/full',
      [
        '--config=p/typescript',
        '--config=p/javascript',
        '--config=p/security-audit',
        '--config=p/secrets',
      ],
    ],
  ] as const)('maps %s to stable %s identity and rules', (event, category, configs) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const scan = runScan(event, 0, sarif([], '.github/workflows/security.yaml:semgrep/'));
      expect(scan.result.status, scan.result.stderr).toBe(0);
      expect(scan.args).toEqual([
        'scan',
        ...configs,
        '--error',
        '--sarif',
        '--output=semgrep.sarif',
        '.',
      ]);
      expect(scan.outputs).toBe(`sarif-upload=true\ncategory=${category}\n`);
      const normalized = JSON.parse(scan.normalized ?? '') as {
        runs: { automationDetails: { id: string; description: { text: string } } }[];
      };
      expect(normalized.runs[0]?.automationDetails).toEqual({
        id: `${category}/`,
        description: { text: 'old' },
      });
    }
  });

  it('keeps a findings exit failing while allowing its real SARIF to upload', () => {
    const scan = runScan(
      'schedule',
      1,
      sarif([{ ruleId: 'audit-rule', message: { text: 'match' } }])
    );
    expect(scan.result.status).toBe(1);
    expect(scan.outputs).toContain('sarif-upload=true');
    expect(JSON.parse(scan.normalized ?? '').runs[0].automationDetails.id).toBe('semgrep/full/');
    expect(condition(uploadStep, 'success', 'true', 'true')).toBe(true);
  });

  it.each([
    ['missing', 0, undefined],
    ['malformed JSON', 0, '{'],
    ['missing SARIF runs', 0, JSON.stringify({ version: '2.1.0' })],
    ['invalid run', 0, JSON.stringify({ version: '2.1.0', runs: [{}] })],
    ['unknown result rule', 0, sarif([{ ruleId: 'other', message: { text: 'match' } }])],
    [
      'unsuccessful invocation',
      0,
      sarif().replace('"executionSuccessful":true', '"executionSuccessful":false'),
    ],
    [
      'execution error notification',
      0,
      sarif().replace(
        '"toolExecutionNotifications":[]',
        '"toolExecutionNotifications":[{"level":"error"}]'
      ),
    ],
    ['findings exit without results', 1, sarif()],
    ['clean exit with findings', 0, sarif([{ ruleId: 'audit-rule', message: { text: 'match' } }])],
    ['operational exit with report', 2, sarif()],
  ] as const)('refuses %s without publishing a clean analysis', (_label, status, report) => {
    const scan = runScan('push', status, report);
    expect(scan.result.status).not.toBe(0);
    expect(scan.outputs).toBe('');
  });

  it('keeps classification failure conservative and skips unrelated or cancelled uploads', () => {
    const active = step('🔍 Run Semgrep scan');
    const inactive = step('No relevant changes');
    expect(condition(active, 'success', 'true', '')).toBe(true);
    expect(condition(active, 'failure', '', '')).toBe(true);
    expect(condition(active, 'success', 'false', '')).toBe(false);
    expect(condition(inactive, 'success', 'false', '')).toBe(true);
    expect(condition(inactive, 'failure', '', '')).toBe(false);
    expect(condition(uploadStep, 'success', 'true', 'true', true)).toBe(false);
    expect(condition(uploadStep, 'success', 'false', 'true')).toBe(false);
    expect(condition(uploadStep, 'success', 'true', '')).toBe(false);
    expect(condition(uploadStep, 'failure', '', 'true')).toBe(true);
    expect(section).toContain('name: pr-gate/semgrep');
    expect(section).toContain(
      "image: ${{ needs['pin-metadata'].outputs.SEMGREP_IMAGE || 'invalid@@' }}"
    );
    expect(uploadStep).toContain('category: ${{ steps.semgrep-report.outputs.category }}');
  });

  it('rejects unsupported events before running the scanner', () => {
    const scan = runScan('unsupported', 0, sarif());
    expect(scan.result.status).toBe(2);
    expect(scan.args).toEqual([]);
    expect(scan.outputs).toBe('');
  });

  it.skipIf(!process.env.SEMGREP_REGRESSION_SCANNER)(
    'confirms real pinned Semgrep source-audit coverage and separate upload identities',
    () => {
      const scanner = process.env.SEMGREP_REGRESSION_SCANNER;
      if (!scanner) throw new Error('SEMGREP_REGRESSION_SCANNER is required');
      expect(existsSync(scanner)).toBe(true);
      const pins = JSON.parse(
        readFileSync(resolve(import.meta.dirname, '../../../scripts/ci/pinned-tools.json'), 'utf8')
      ) as { semgrep: { version: string } };
      const full = runActualScan('workflow_dispatch', scanner);
      const secrets = runActualScan('push', scanner);
      expect(full.result.error, full.result.stderr).toBeUndefined();
      expect(secrets.result.error, secrets.result.stderr).toBeUndefined();
      expect(full.result.status, full.result.stderr).toBe(1);
      expect(secrets.result.status, secrets.result.stderr).toBe(0);
      expect(full.outputs).toBe('sarif-upload=true\ncategory=semgrep/full\n');
      expect(secrets.outputs).toBe('sarif-upload=true\ncategory=semgrep/secrets\n');
      const fullRun = full.report?.runs[0];
      const secretsRun = secrets.report?.runs[0];
      expect(fullRun?.tool.driver.semanticVersion).toBe(pins.semgrep.version);
      expect(secretsRun?.tool.driver.semanticVersion).toBe(pins.semgrep.version);
      expect(fullRun?.tool.driver.rules.length).toBeGreaterThan(
        secretsRun?.tool.driver.rules.length ?? 0
      );
      expect(fullRun?.results.some((result) => result.ruleId.includes('eval-detected'))).toBe(true);
      expect(secretsRun?.results).toEqual([]);
      expect(fullRun?.automationDetails.id).toBe('semgrep/full/');
      expect(secretsRun?.automationDetails.id).toBe('semgrep/secrets/');
    },
    300_000
  );
});
