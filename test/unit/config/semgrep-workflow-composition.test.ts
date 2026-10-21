import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');
const workflow = readFileSync(join(root, '.github/workflows/security.yaml'), 'utf8');
const section = workflow.match(/^ {2}semgrep:\n[\s\S]*?(?=^ {2}security-summary:)/m)?.[0];
if (!section) throw new Error('Missing Semgrep workflow job');
const action = join(root, '.github/actions/validate-semgrep-sarif/index.mjs');
const runtime = process.env.SEMGREP_ACTION_NODE ?? process.execPath;
const actionReference =
  'PiesP/yt-live-chat-overlay/.github/actions/validate-semgrep-sarif@0c7fea5ab60757cad50520cf5ace89eb6396fabd';

function step(name: string): string {
  const body = section?.split(`      - name: ${name}\n`)[1]?.split('\n      - name: ')[0];
  if (!body) throw new Error(`Missing Semgrep step: ${name}`);
  return body;
}

const scanStep = step('🔍 Run Semgrep scan');
const reportStep = step('✅ Validate Semgrep SARIF');
const uploadStep = step('📊 Upload SARIF to GitHub Security');
const fixtureScanStep = step('🧪 Scan bounded Semgrep finding fixture');
const fixtureReportStep = step('✅ Validate bounded Semgrep finding');
const fixtureGuardStep = step('🧪 Exercise findings upload guard');
const fixtureRequireStep = step('✅ Require bounded finding regression');

function shellScript(body: string): string {
  if (!/^\s+shell: sh$/m.test(body)) throw new Error('Expected the declared container shell');
  const script = body
    .split('        run: |\n')[1]
    ?.split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
  if (!script) throw new Error('Missing Semgrep shell script');
  return script;
}

const scanScript = shellScript(scanStep);
const fixtureScanScript = shellScript(fixtureScanStep);

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

function outputs(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

function invokeAction(directory: string, reportPath: string, category: string, status: string) {
  const output = join(directory, 'action-output');
  writeFileSync(output, '');
  const result = spawnSync(runtime, [action], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      PATH: directory,
      INPUT_SARIF_PATH: reportPath,
      INPUT_CATEGORY: category,
      INPUT_SCANNER_STATUS: status,
      GITHUB_OUTPUT: output,
    },
  });
  return { result, output: readFileSync(output, 'utf8') };
}

function runScan(event: string, scanStatus = 0, report?: string, realScanner?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'semgrep-workflow-'));
  try {
    const scanner = join(directory, 'semgrep');
    const scanOutput = join(directory, 'scan-output');
    const argumentsFile = join(directory, 'arguments');
    const fixture = join(directory, 'fixture.sarif');
    const reportPath = join(directory, 'semgrep.sarif');
    if (realScanner) {
      symlinkSync(resolve(realScanner), scanner);
      writeFileSync(
        join(directory, 'source-audit.py'),
        '# Non-executed scanner fixture.\neval(input())\n'
      );
    } else {
      writeFileSync(
        scanner,
        '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$STUB_ARGS"\nif [[ "$STUB_REPORT" == "yes" ]]; then cp "$STUB_FIXTURE" semgrep.sarif; fi\nexit "$STUB_STATUS"\n',
        { mode: 0o755 }
      );
    }
    writeFileSync(scanOutput, '');
    if (report !== undefined) writeFileSync(fixture, report);
    const scan = spawnSync('sh', ['-c', scanScript], {
      cwd: directory,
      encoding: 'utf8',
      timeout: realScanner ? 120_000 : 15_000,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        GITHUB_EVENT_NAME: event,
        GITHUB_OUTPUT: scanOutput,
        STUB_ARGS: argumentsFile,
        STUB_FIXTURE: fixture,
        STUB_REPORT: report === undefined ? 'no' : 'yes',
        STUB_STATUS: String(scanStatus),
        SEMGREP_SEND_METRICS: 'off',
      },
    });
    const fields = outputs(scanOutput);
    const validation =
      scan.status === 0 && fields.category && fields['scanner-status']
        ? invokeAction(directory, reportPath, fields.category, fields['scanner-status'])
        : undefined;
    return {
      scan,
      validation,
      args: existsSync(argumentsFile) ? readFileSync(argumentsFile, 'utf8').trim().split('\n') : [],
      scanOutputs: readFileSync(scanOutput, 'utf8'),
      normalized: existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : undefined,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runFindingFixture(scannerStatus = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'semgrep-finding-regression-'));
  try {
    const scanner = join(directory, 'semgrep');
    const argumentsFile = join(directory, 'arguments');
    const sarifFixture = join(directory, 'fixture.sarif');
    const scanOutput = join(directory, 'scan-output');
    writeFileSync(
      scanner,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$STUB_ARGS"\nfor arg in "$@"; do case "$arg" in --output=*) target=${arg#--output=};; esac; done\ncp "$STUB_FIXTURE" "$target"\nexit "$STUB_STATUS"\n',
      { mode: 0o755 }
    );
    writeFileSync(sarifFixture, sarif([{ ruleId: 'audit-rule', message: { text: 'match' } }]));
    writeFileSync(scanOutput, '');
    const scan = spawnSync('sh', ['-c', fixtureScanScript], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: scanOutput,
        STUB_ARGS: argumentsFile,
        STUB_FIXTURE: sarifFixture,
        STUB_STATUS: String(scannerStatus),
      },
    });
    const fields = outputs(scanOutput);
    const report = fields['report-path'];
    const validation =
      scan.status === 0 && report
        ? invokeAction(directory, report, 'semgrep/full', '1')
        : undefined;
    return {
      scan,
      validation,
      args: existsSync(argumentsFile) ? readFileSync(argumentsFile, 'utf8').trim().split('\n') : [],
      source: report ? readFileSync(join(dirname(report), 'source-audit.py'), 'utf8') : undefined,
      scanOutputs: readFileSync(scanOutput, 'utf8'),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function condition(
  body: string,
  options: {
    event?: string;
    classification?: string;
    semgrep?: string;
    scanOutcome?: string;
    upload?: string;
    fixtureReportUpload?: string;
    cancelled?: boolean;
    trustOutcome?: string;
  } = {}
): boolean {
  const expression = body.match(/if: \$\{\{ (.+) \}\}/)?.[1];
  if (!expression) throw new Error('Missing workflow condition');
  return runInNewContext(
    expression
      .replaceAll('steps.semgrep-fixture-report', 'steps.fixtureReport')
      .replaceAll('steps.semgrep-scan', 'steps.scan')
      .replaceAll('steps.semgrep-report', 'steps.report')
      .replaceAll('outputs.sarif-upload', 'outputs.sarifUpload'),
    {
      cancelled: () => options.cancelled ?? false,
      github: { event_name: options.event ?? 'push' },
      needs: {
        changes: {
          result: options.classification ?? 'success',
          outputs: { semgrep: options.semgrep ?? 'true' },
        },
      },
      steps: {
        node_trust: { outcome: options.trustOutcome ?? 'success' },
        scan: { outcome: options.scanOutcome ?? 'success' },
        report: { outputs: { sarifUpload: options.upload ?? '' } },
        fixtureReport: { outputs: { sarifUpload: options.fixtureReportUpload ?? '' } },
      },
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
    const pipeline = runScan(event, 0, sarif([], '.github/workflows/security.yaml:semgrep/'));
    expect(pipeline.scan.status, pipeline.scan.stderr).toBe(0);
    expect(pipeline.args).toEqual([
      'scan',
      ...configs,
      '--error',
      '--sarif',
      '--output=semgrep.sarif',
      '.',
    ]);
    expect(pipeline.scanOutputs).toBe(`category=${category}\nscanner-status=0\n`);
    expect(pipeline.validation?.result.status, pipeline.validation?.result.stderr).toBe(0);
    expect(pipeline.validation?.output).toBe(`sarif-upload=true\ncategory=${category}\n`);
    const normalized = JSON.parse(pipeline.normalized ?? '') as {
      runs: { automationDetails: { id: string; description: { text: string } } }[];
    };
    expect(normalized.runs[0]?.automationDetails).toEqual({
      id: `${category}/`,
      description: { text: 'old' },
    });
  });

  it('keeps a findings exit failing while allowing the validated report to upload', () => {
    const pipeline = runScan(
      'schedule',
      1,
      sarif([{ ruleId: 'audit-rule', message: { text: 'match' } }])
    );
    expect(pipeline.scan.status).toBe(0);
    expect(pipeline.scanOutputs).toBe('category=semgrep/full\nscanner-status=1\n');
    expect(pipeline.validation?.result.status).toBe(1);
    expect(pipeline.validation?.output).toBe('sarif-upload=true\ncategory=semgrep/full\n');
    expect(JSON.parse(pipeline.normalized ?? '').runs[0].automationDetails.id).toBe(
      'semgrep/full/'
    );
    expect(condition(uploadStep, { upload: 'true' })).toBe(true);
  });

  it.each([
    ['missing report', 0, undefined],
    ['malformed JSON', 0, '{'],
    ['missing SARIF runs', 0, JSON.stringify({ version: '2.1.0' })],
    ['unknown result rule', 0, sarif([{ ruleId: 'other', message: { text: 'match' } }])],
    ['findings exit without results', 1, sarif()],
    ['clean exit with findings', 0, sarif([{ ruleId: 'audit-rule', message: { text: 'match' } }])],
  ] as const)('rejects %s without upload permission', (_label, status, report) => {
    const pipeline = runScan('push', status, report);
    expect(pipeline.scan.status).toBe(0);
    expect(pipeline.validation?.result.status).toBe(2);
    expect(pipeline.validation?.output).toBe('');
  });

  it('stops operational exits before the validator and preserves missing reports as invalid', () => {
    const operational = runScan('push', 2, sarif());
    expect(operational.scan.status).toBe(2);
    expect(operational.scanOutputs).toBe('');
    expect(operational.validation).toBeUndefined();
    expect(condition(reportStep, { scanOutcome: 'failure' })).toBe(false);
    const missing = runScan('push', 0);
    expect(missing.scan.status).toBe(0);
    expect(missing.validation?.result.status).toBe(2);
    expect(missing.validation?.output).toBe('');
  });

  it('keeps classification failure conservative and skips unrelated or cancelled uploads', () => {
    const inactive = step('No relevant changes');
    expect(condition(scanStep)).toBe(true);
    expect(condition(scanStep, { classification: 'failure', semgrep: '' })).toBe(true);
    expect(condition(scanStep, { semgrep: 'false' })).toBe(false);
    expect(condition(reportStep, { scanOutcome: 'success' })).toBe(true);
    expect(condition(reportStep, { scanOutcome: 'failure' })).toBe(false);
    expect(condition(reportStep, { scanOutcome: 'skipped' })).toBe(false);
    expect(condition(inactive, { semgrep: 'false' })).toBe(true);
    expect(condition(uploadStep, { upload: 'true', cancelled: true })).toBe(false);
    expect(condition(uploadStep, { upload: 'true', semgrep: 'false' })).toBe(false);
    expect(condition(uploadStep, { upload: '' })).toBe(false);
    for (const trustOutcome of ['failure', 'skipped', 'cancelled']) {
      expect(condition(reportStep, { trustOutcome })).toBe(false);
      expect(condition(uploadStep, { trustOutcome, upload: 'true' })).toBe(false);
    }
    expect(condition(uploadStep, { upload: 'true', classification: 'failure', semgrep: '' })).toBe(
      true
    );
    expect(section).toContain('name: pr-gate/semgrep');
    expect(section).toContain(
      "image: ${{ needs['pin-metadata'].outputs.SEMGREP_IMAGE || 'invalid@@' }}"
    );
    expect(section).not.toContain('python3 - "$category" "$scan_status"');
    expect(reportStep).toContain(`uses: ${actionReference}`);
    expect(reportStep).toContain('sarif_path: semgrep.sarif');
    expect(reportStep).toContain(
      'scanner_status: ${{ steps.semgrep-scan.outputs.scanner-status }}'
    );
    expect(uploadStep).toContain('category: ${{ steps.semgrep-report.outputs.category }}');
  });

  it('checks a real finding in the existing container on manual dispatch without uploading it', () => {
    expect(fixtureScanScript).toContain('eval(input())');
    expect(fixtureScanScript).toContain('mktemp -d "$RUNNER_TEMP/semgrep-finding.XXXXXXXX"');
    expect(fixtureScanScript).toContain('--config=p/security-audit');
    expect(fixtureReportStep).toContain(`uses: ${actionReference}`);
    expect(fixtureReportStep).toContain('continue-on-error: true');
    expect(fixtureReportStep).toContain("scanner_status: '1'");
    expect(
      condition(fixtureGuardStep, { event: 'workflow_dispatch', fixtureReportUpload: 'true' })
    ).toBe(true);
    expect(condition(fixtureGuardStep, { event: 'push', fixtureReportUpload: 'true' })).toBe(false);
    expect(condition(fixtureGuardStep, { event: 'workflow_dispatch' })).toBe(false);
    expect(fixtureRequireStep).toContain('test "$GUARD_OUTCOME" = success');
    expect(uploadStep).toContain('sarif_file: semgrep.sarif');
    expect(uploadStep).not.toContain('semgrep-fixture');

    const fixture = runFindingFixture();
    expect(fixture.scan.status, fixture.scan.stderr).toBe(0);
    expect(fixture.source).toContain('eval(input())');
    expect(fixture.args).toContain('--config=p/security-audit');
    expect(fixture.args.some((arg) => arg.startsWith('--output='))).toBe(true);
    expect(fixture.scanOutputs).toMatch(/^report-path=.*\/finding\.sarif\n$/);
    expect(fixture.validation?.result.status).toBe(1);
    expect(fixture.validation?.output).toBe('sarif-upload=true\ncategory=semgrep/full\n');
    expect(
      condition(fixtureGuardStep, {
        event: 'workflow_dispatch',
        fixtureReportUpload: 'true',
      })
    ).toBe(true);
    const noFinding = runFindingFixture(0);
    expect(noFinding.scan.status).toBe(2);
    expect(noFinding.validation).toBeUndefined();
    expect(noFinding.scanOutputs).toBe('');
  });

  it('rejects unsupported events before running the scanner', () => {
    const pipeline = runScan('unsupported', 0, sarif());
    expect(pipeline.scan.status).toBe(2);
    expect(pipeline.args).toEqual([]);
    expect(pipeline.scanOutputs).toBe('');
    expect(pipeline.validation).toBeUndefined();
  });

  it.skipIf(!process.env.SEMGREP_REGRESSION_SCANNER)(
    'confirms real pinned Semgrep source-audit coverage and separate upload identities',
    () => {
      const scanner = process.env.SEMGREP_REGRESSION_SCANNER;
      if (!scanner) throw new Error('SEMGREP_REGRESSION_SCANNER is required');
      expect(existsSync(scanner)).toBe(true);
      const pins = JSON.parse(readFileSync(join(root, 'scripts/ci/pinned-tools.json'), 'utf8')) as {
        semgrep: { version: string };
      };
      const full = runScan('workflow_dispatch', 0, undefined, scanner);
      const secrets = runScan('push', 0, undefined, scanner);
      expect(full.scan.error, full.scan.stderr).toBeUndefined();
      expect(secrets.scan.error, secrets.scan.stderr).toBeUndefined();
      expect(full.scan.status, full.scan.stderr).toBe(0);
      expect(secrets.scan.status, secrets.scan.stderr).toBe(0);
      expect(full.validation?.result.status, full.validation?.result.stderr).toBe(1);
      expect(secrets.validation?.result.status, secrets.validation?.result.stderr).toBe(0);
      expect(full.validation?.output).toBe('sarif-upload=true\ncategory=semgrep/full\n');
      expect(secrets.validation?.output).toBe('sarif-upload=true\ncategory=semgrep/secrets\n');
      const fullRun = (
        JSON.parse(full.normalized ?? '') as {
          runs: {
            tool: { driver: { semanticVersion: string; rules: unknown[] } };
            results: { ruleId: string }[];
            automationDetails: { id: string };
          }[];
        }
      ).runs[0];
      const secretsRun = (
        JSON.parse(secrets.normalized ?? '') as {
          runs: {
            tool: { driver: { semanticVersion: string; rules: unknown[] } };
            results: { ruleId: string }[];
            automationDetails: { id: string };
          }[];
        }
      ).runs[0];
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
