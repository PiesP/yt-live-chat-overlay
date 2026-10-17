import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const gateWorkflow = readFileSync(
  resolve(process.cwd(), '.github/workflows/dependabot-auto-merge.yaml'),
  'utf8'
);
const applyWorkflow = readFileSync(
  resolve(process.cwd(), '.github/workflows/dependabot-auto-merge-apply.yaml'),
  'utf8'
);

describe('Dependabot auto-merge security', () => {
  it.each([
    { dependencies: 'vite-plus', alert: '', eligible: false },
    { dependencies: 'vite', alert: '', eligible: false },
    { dependencies: 'vitest', alert: '', eligible: false },
    { dependencies: '@vitest/coverage-v8', alert: '', eligible: false },
    { dependencies: '@voidzero-dev/vite-plus-core', alert: '', eligible: false },
    { dependencies: 'typescript,vite-plus', alert: '', eligible: false },
    { dependencies: 'typescript', alert: '', eligible: true },
    { dependencies: 'vitest', alert: 'open', eligible: true },
  ])(
    'evaluates $dependencies with alert $alert as $eligible',
    ({ dependencies, alert, eligible }) => {
      const decision = gateWorkflow
        .split('        id: decide\n')[1]
        ?.split('\n      - name:')[0]
        ?.split('        run: |\n')[1]
        ?.replace(/^ {10}/gm, '');
      expect(decision).toBeDefined();
      if (!decision) throw new Error('Missing update decision step');
      const fixture = mkdtempSync(join(tmpdir(), 'dependabot-managed-toolchain-'));
      try {
        const output = join(fixture, 'output');
        execFileSync('bash', ['-euo', 'pipefail', '-c', decision], {
          env: {
            ...process.env,
            ECOSYSTEM: 'npm',
            UPDATE_TYPE: 'version-update:semver-minor',
            DEPENDENCIES: dependencies,
            ALERT_STATE: alert,
            MAINTAINER_CHANGES: 'false',
            GITHUB_OUTPUT: output,
          },
          stdio: 'pipe',
        });
        expect(readFileSync(output, 'utf8')).toContain(`should_merge=${eligible}\n`);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    }
  );

  it('evaluates only Dependabot events with read-only permissions', () => {
    expect(gateWorkflow).toContain("github.event.sender.login == 'dependabot[bot]'");
    expect(gateWorkflow).toContain("github.event.pull_request.user.login == 'dependabot[bot]'");
    expect(gateWorkflow).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository'
    );
    expect(gateWorkflow).toContain(
      'github.event.pull_request.base.ref == github.event.repository.default_branch'
    );
    expect(gateWorkflow).toContain('github.event.pull_request.draft == false');
    expect(gateWorkflow).toContain('contents: read');
    expect(gateWorkflow).toContain('pull-requests: read');
    expect(gateWorkflow).toContain('maintainer-changes');
    expect(gateWorkflow).toContain('dependabot-auto-merge-gate');
    expect(gateWorkflow).not.toContain('AUTO_MERGE_TOKEN');
    expect(gateWorkflow).not.toContain('actions/checkout');
  });

  it('grants write permissions only to the exact completed gate run', () => {
    expect(applyWorkflow).toContain('workflow_run:');
    expect(applyWorkflow).toContain('workflows: ["🤖 Dependabot Auto-Merge Gate"]');
    expect(applyWorkflow).toContain('types: [completed]');
    expect(applyWorkflow).toContain("workflow_run.conclusion == 'success'");
    expect(applyWorkflow).toContain("workflow_run.actor.login == 'dependabot[bot]'");
    expect(applyWorkflow).toContain("workflow_run.event == 'pull_request_target'");
    expect(applyWorkflow).toContain('run-id: ${{ github.event.workflow_run.id }}');
    expect(applyWorkflow).toContain('digest-mismatch: error');
    expect(applyWorkflow).toMatch(
      /permissions:\n {2}actions: read\n {2}contents: read\n {2}pull-requests: read/
    );
    expect(applyWorkflow).toMatch(
      /approve:\n[\s\S]*?needs: validate\n[\s\S]*?if: needs\.validate\.outputs\.eligible == 'true'[\s\S]*?permissions:\n {6}contents: write\n {6}pull-requests: write/
    );
  });

  it('revalidates every commit and approves only the unchanged head', () => {
    const modes = [
      ...applyWorkflow.matchAll(
        /run: node --experimental-strip-types scripts\/ci\/dependabot-apply\.ts (\w+)/g
      ),
    ].map((match) => match[1]);
    expect(modes).toEqual(['gate', 'validate', 'manual', 'recheck', 'approve', 'merge']);
    expect(
      applyWorkflow.match(/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/g)
    ).toHaveLength(2);
    expect(applyWorkflow.match(/install-dependencies: 'false'/g)).toHaveLength(2);
    expect(applyWorkflow).toContain('HEAD_SHA: ${{ needs.validate.outputs.head_sha }}');
    expect(applyWorkflow).toContain('BASE_REF: ${{ needs.validate.outputs.base_ref }}');
    expect(applyWorkflow).toContain('reason_base64');
    expect(applyWorkflow).not.toContain('gh pr review --approve');
    expect(applyWorkflow).not.toContain('AUTO_MERGE_TOKEN');
  });

  it('preserves eligible update auto-merge behind branch protection', () => {
    expect(gateWorkflow).toContain('version-update:semver-patch');
    expect(gateWorkflow).toContain('version-update:semver-minor');
    expect(applyWorkflow).toContain('scripts/ci/dependabot-apply.ts merge');
    expect(applyWorkflow).toContain('REASON_BASE64: ${{ needs.validate.outputs.reason_base64 }}');
    expect(applyWorkflow).not.toContain('--admin');
  });
});
