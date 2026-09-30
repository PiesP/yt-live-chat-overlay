import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const classifier = resolve(root, 'scripts/ci/classify-workflow-changes.sh');

function jobSection(workflow: string, job: string): string {
  const section = workflow.match(
    new RegExp(`  ${job}:\\n[\\s\\S]*?(?=\\n  [a-z][\\w-]*:|$)`)
  )?.[0];
  if (!section) throw new Error(`Workflow job not found: ${job}`);
  return section;
}

function runSecuritySummary(event: string, results: Record<string, string> = {}) {
  const workflow = readFileSync(resolve(root, '.github/workflows/security.yaml'), 'utf8');
  const script = jobSection(workflow, 'security-summary').split('        run: |\n')[1];
  if (!script) throw new Error('Security summary script not found');

  return spawnSync('bash', ['-c', script.replace(/^ {10}/gm, '')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_STEP_SUMMARY: '/dev/null',
      EVENT_NAME: event,
      PINNED_TOOLS_RESULT: ['push', 'schedule', 'workflow_dispatch'].includes(event)
        ? 'success'
        : 'skipped',
      OSV_PR_RESULT: event === 'pull_request' ? 'success' : 'skipped',
      OSV_FULL_RESULT: event === 'pull_request' ? 'skipped' : 'success',
      CODEQL_RESULT: 'success',
      SEMGREP_RESULT: 'success',
      ...results,
    },
  });
}

type Scope =
  | 'all'
  | 'quality'
  | 'unit'
  | 'core'
  | 'e2e'
  | 'build'
  | 'duplication'
  | 'osv'
  | 'semgrep'
  | 'codeql_actions'
  | 'codeql_javascript'
  | 'pinned_tools'
  | 'deep_fast';

function classify(paths: string[]): Record<Scope, boolean> {
  const result = spawnSync('bash', [classifier, '--paths', ...paths], {
    cwd: root,
    encoding: 'utf8',
  });

  expect(result.status, result.stderr).toBe(0);
  return Object.fromEntries(
    result.stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [scope, enabled] = line.split('=');
        return [scope, enabled === 'true'];
      })
  ) as Record<Scope, boolean>;
}

function classifyEvent(event: Record<string, string>): Record<Scope, boolean> {
  const result = spawnSync('bash', [classifier], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...event },
  });

  expect(result.status, result.stderr).toBe(0);
  return Object.fromEntries(
    result.stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [scope, enabled] = line.split('=');
        return [scope, enabled === 'true'];
      })
  ) as Record<Scope, boolean>;
}

describe('workflow change classification', () => {
  it('does not schedule heavy verification for documentation-only changes', () => {
    const scopes = classify(['README.md', 'CHANGELOG.md', 'extension/README.md']);

    expect(scopes).toMatchObject({
      quality: false,
      unit: false,
      core: false,
      e2e: false,
      build: false,
      duplication: false,
      osv: false,
      semgrep: true,
      codeql_actions: false,
      codeql_javascript: false,
      deep_fast: false,
    });
  });

  it('runs product gates for application source without dependency or Actions scans', () => {
    const scopes = classify(['src/app/page-watcher.ts']);

    expect(scopes).toMatchObject({
      quality: true,
      unit: true,
      core: false,
      e2e: true,
      build: true,
      duplication: true,
      osv: false,
      semgrep: true,
      codeql_actions: false,
      codeql_javascript: true,
      deep_fast: true,
    });
  });

  it('aligns the fast mutation scope with its excluded renderer sources', () => {
    const scopes = classify(['src/renderer/canvas-renderer.ts']);

    expect(scopes.unit).toBe(true);
    expect(scopes.e2e).toBe(true);
    expect(scopes.deep_fast).toBe(false);
  });

  it('treats the shared-core gitlink as relevant to every consumer gate', () => {
    const scopes = classify(['packages/core']);

    expect(scopes).toMatchObject({
      quality: true,
      unit: true,
      core: true,
      e2e: true,
      build: true,
      duplication: false,
      osv: true,
      semgrep: true,
      codeql_javascript: true,
      deep_fast: true,
    });
  });

  it('runs workflow contracts and Actions analysis for workflow changes', () => {
    const scopes = classify(['.github/workflows/ci.yaml']);

    expect(scopes).toMatchObject({
      quality: true,
      unit: true,
      e2e: true,
      build: true,
      duplication: true,
      osv: false,
      semgrep: true,
      codeql_actions: true,
      pinned_tools: true,
      deep_fast: false,
    });
  });

  it('runs OSV when result validation changes', () => {
    expect(classify(['scripts/security/validate-osv-results.py'])).toMatchObject({
      unit: true,
      osv: true,
    });
  });

  it('keeps the product threat model in documentation scope', () => {
    expect(classify(['.github/threat-model.md'])).toMatchObject({
      quality: false,
      unit: false,
      osv: false,
      semgrep: true,
      pinned_tools: false,
    });
  });

  it('runs portable quality and unit checks for Windows validation helpers', () => {
    expect(classify(['validation/windows/live-duration.mjs'])).toMatchObject({
      quality: true,
      unit: true,
      e2e: false,
      build: false,
      semgrep: true,
      codeql_javascript: true,
    });
  });

  it('fails closed for unknown paths, manual runs, and unavailable revisions', () => {
    expect(Object.values(classify(['new-config.unknown']))).not.toContain(false);
    expect(
      Object.values(classifyEvent({ EVENT_NAME: 'workflow_dispatch' }))
    ).not.toContain(false);
    expect(
      Object.values(
        classifyEvent({
          EVENT_NAME: 'push',
          BASE_SHA: '1111111111111111111111111111111111111111',
          HEAD_SHA: '2222222222222222222222222222222222222222',
        })
      )
    ).not.toContain(false);
  });
});

describe('workflow scope integration', () => {
  it.each(['pull_request', 'merge_group', 'push', 'schedule', 'workflow_dispatch'])(
    'validates the actual scanner results for %s without manual status publishing',
    (event) => {
      const result = runSecuritySummary(event);
      expect(result.status, result.stderr).toBe(0);
      const required = [
        'CODEQL_RESULT',
        'SEMGREP_RESULT',
        event === 'pull_request' ? 'OSV_PR_RESULT' : 'OSV_FULL_RESULT',
      ];
      if (['push', 'schedule', 'workflow_dispatch'].includes(event)) {
        required.push('PINNED_TOOLS_RESULT');
      }
      for (const check of required) {
        for (const outcome of ['failure', 'cancelled', 'skipped']) {
          expect(runSecuritySummary(event, { [check]: outcome }).status, check).toBe(1);
        }
      }
    }
  );

  it('rejects unsupported security events', () => {
    expect(runSecuritySummary('unknown').status).toBe(1);
  });

  it('keeps every required check name and explicit no-op path in CI and Security', () => {
    const ci = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
    const security = readFileSync(resolve(root, '.github/workflows/security.yaml'), 'utf8');
    const settings = readFileSync(resolve(root, '.github/settings.yml'), 'utf8');
    const requiredChecks = [
      'pr-gate/quality',
      'pr-gate/build',
      'pr-gate/unit',
      'pr-gate/e2e',
      'pr-gate/duplication',
      'pr-gate/osv / osv-scan',
      'pr-gate/semgrep',
    ];

    for (const check of requiredChecks) {
      expect(settings).toContain(`- context: "${check}"\n            app_id: 15368`);
      expect(`${ci}\n${security}`).toContain(`name: ${check}`);
    }
    expect(ci.match(/name: No relevant changes/g)).toHaveLength(4);
    expect(ci).toContain('Duplication is informational for PR CI');
    expect(security.match(/name: No relevant changes/g)).toHaveLength(5);
  });

  it('does not add workflow-level path filters to required workflows', () => {
    for (const filename of ['ci.yaml', 'security.yaml']) {
      const workflow = readFileSync(resolve(root, '.github/workflows', filename), 'utf8');
      const triggerBlock = workflow.slice(0, workflow.indexOf('\npermissions:'));

      expect(workflow).not.toContain('report-pr-gate-statuses:');
      expect(workflow).not.toContain('statuses: write');
      expect(triggerBlock).not.toMatch(/\n\s+paths(?:-ignore)?:/);
      expect(triggerBlock).toContain('pull_request:');
      expect(triggerBlock).toContain('merge_group:');
    }
  });

  it('runs required heavy checks when change classification cannot complete', () => {
    const ci = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
    const security = readFileSync(resolve(root, '.github/workflows/security.yaml'), 'utf8');

    for (const job of ['quality', 'unit', 'e2e', 'build']) {
      const section = jobSection(ci, job);
      expect(section).toMatch(/needs: (?:changes|\[changes, quality\])/);
      expect(section).toContain('if: ${{ !cancelled() }}');
      expect(section).toContain("needs.changes.result != 'success'");
    }
    const duplication = jobSection(ci, 'duplication');
    expect(duplication).toContain('needs: changes');
    expect(duplication).toContain('if: ${{ !cancelled() }}');
    expect(duplication).toContain('Duplication is informational for PR CI');
    for (const job of ['osv-scan-pr', 'osv-scan-dispatch', 'semgrep']) {
      const section = jobSection(security, job);
      expect(section).toContain('needs: changes');
      expect(section).toContain('!cancelled()');
      expect(section).toContain("needs.changes.result != 'success'");
    }

    for (const workflow of [ci, security]) {
      const changes = jobSection(workflow, 'changes');
      expect(changes).toContain('continue-on-error: true');
      expect(changes).toContain('CHECKOUT_OUTCOME: ${{ steps.checkout.outcome }}');
      expect(changes).toContain('>> "$GITHUB_OUTPUT"');
    }
  });

  it('executes the change classifier from the trusted base revision for PR-like events', () => {
    const ci = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
    const security = readFileSync(resolve(root, '.github/workflows/security.yaml'), 'utf8');

    for (const workflow of [ci, security]) {
      const changes = jobSection(workflow, 'changes');
      expect(changes).toContain('pull_request | merge_group');
      expect(changes).toContain(
        'git show "$BASE_SHA:scripts/ci/classify-workflow-changes.sh"'
      );
      expect(changes).toContain('bash "$classifier"');
    }
  });

  it('limits non-required PR and push workflows to conservative relevant paths', () => {
    const deep = readFileSync(resolve(root, '.github/workflows/deep-checks.yaml'), 'utf8');

    expect(deep).toContain('  schedule:');
    expect(deep).toContain('  workflow_dispatch:');
    expect(deep).not.toContain('\n  push:\n');
  });
});
