import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');
const centralAction =
  'PiesP/browser-core/automation/actions/setup-project@af19a6597c351f03a65e49532bdec6276e4b5ae9';
const centralWorkflowJobs = {
  'ci.yaml': ['changes', 'quality', 'unit', 'e2e', 'build'],
  'security.yaml': ['changes', 'pin-metadata', 'pinned-tools', 'osv-scan-pr', 'osv-scan-dispatch'],
} as const;
const releaseJobs = ['quality', 'unit', 'e2e', 'build'];
const releaseLocalExecutionJobs = releaseJobs;
const releaseAction = './.github/actions/setup-release';
const releasePrepare = readFileSync(resolve(root, 'scripts/release/prepare.ts'), 'utf8');

function topLevelBlock(workflow: string, key: string): string {
  const marker = `${key}:\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`Workflow key not found: ${key}`);

  const afterMarker = start + marker.length;
  const nextKey = workflow.slice(afterMarker).search(/\n[A-Za-z][A-Za-z0-9_-]*:\n/);
  return workflow.slice(start, nextKey === -1 ? undefined : afterMarker + nextKey).trimEnd();
}

describe('project setup actions', () => {
  it('keeps CI and security jobs on the immutable central action', () => {
    for (const [filename, jobs] of Object.entries(centralWorkflowJobs)) {
      const workflow = readFileSync(resolve(root, '.github/workflows', filename), 'utf8');

      for (const job of jobs) {
        const jobSection = workflow.match(
          new RegExp(`  ${job}:\\n[\\s\\S]*?(?=\\n  [a-z][\\w-]*:|$)`)
        )?.[0];

        expect(jobSection).toContain(`uses: ${centralAction}`);
        expect(jobSection).not.toContain('node-version:');
      }
      expect(workflow.split(centralAction)).toHaveLength(jobs.length + 1);
      expect(workflow).not.toContain('uses: ./.github/actions/setup-toolchain');
      if (filename === 'ci.yaml') {
        const unit = workflow.split('\n  unit:\n')[1]?.split('\n  e2e:\n')[0] ?? '';
        expect(workflow.split(releaseAction)).toHaveLength(2);
        expect(unit).toContain(`uses: ${releaseAction}`);
        expect(unit.indexOf(centralAction)).toBeLessThan(unit.indexOf(releaseAction));
        expect(unit.indexOf('Record release setup inputs')).toBeLessThan(
          unit.indexOf(releaseAction)
        );
        expect(unit.indexOf(releaseAction)).toBeLessThan(unit.indexOf('Verify release setup'));
        expect(unit).toContain('sha256sum --check "$RUNNER_TEMP/release-setup-inputs.sha256"');
        expect(unit).toContain('test "$(node --version)" = "v$expected_node"');
        expect(unit).toContain('test "$(pnpm --version)" = "$expected_pnpm"');
      } else {
        expect(workflow).not.toContain(releaseAction);
      }
      expect(workflow).not.toContain('uses: pnpm/action-setup@');
      expect(workflow).not.toContain('uses: actions/setup-node@');
      expect(workflow).not.toContain('run: pnpm install --frozen-lockfile');
      if (filename === 'ci.yaml' || filename === 'security.yaml') {
        const changes = workflow.match(/ {2}changes:\n[\s\S]*?(?=\n {2}[a-z][\w-]*:|$)/)?.[0];
        expect(changes).toContain("install-dependencies: 'false'");
      }
    }
  });

  it('uses the release-only action for every release dependency-backed job', () => {
    const releaseWorkflow = readFileSync(resolve(root, '.github/workflows/release.yaml'), 'utf8');

    for (const job of releaseJobs) {
      const jobSection = releaseWorkflow.match(
        new RegExp(`  ${job}:\\n[\\s\\S]*?(?=\\n  [a-z][\\w-]*:|$)`)
      )?.[0];

      expect(jobSection).toContain(`uses: ${releaseAction}`);
      expect(jobSection).not.toContain(centralAction);
      expect(jobSection).toContain('node-version: ${{ needs.provenance.outputs.node-version }}');
    }
    expect(releaseWorkflow.split(releaseAction)).toHaveLength(releaseJobs.length + 1);
    const provenance =
      releaseWorkflow.match(/ {2}provenance:\n[\s\S]*?(?=\n {2}[a-z][\w-]*:|$)/)?.[0] ?? '';
    expect(provenance).toContain(`uses: ${centralAction}`);
    expect(provenance).toContain("install-dependencies: 'false'");
    const publishSection = releaseWorkflow.match(
      / {2}publish:\n[\s\S]*?(?=\n {2}[a-z][\w-]*:|$)/
    )?.[0];
    expect(publishSection).toBeDefined();
    if (!publishSection) throw new Error('Release publish job not found');
    expect(publishSection).toContain(`uses: ${centralAction}`);
    expect(publishSection).toContain("install-dependencies: 'false'");
    expect(releaseWorkflow.replace(provenance, '').replace(publishSection, '')).not.toContain(
      centralAction
    );
    expect(topLevelBlock(releaseWorkflow, 'on')).toContain('workflow_dispatch:');
    expect(topLevelBlock(releaseWorkflow, 'on')).toContain('tag:');
    expect(releaseWorkflow).toContain("github.ref == 'refs/heads/master'");
    expect(provenance).toContain(
      'run: node --experimental-strip-types scripts/release/verify-source.ts'
    );
    expect(releaseWorkflow).toContain('make_latest: legacy');
    expect(releaseWorkflow).not.toContain('make_latest: true');
    expect(publishSection).toContain('group: release-publish');
    expect(publishSection).toContain('cancel-in-progress: false');
    expect(publishSection).toContain('persist-credentials: false');
    expect(publishSection).toContain('ref: ${{ github.sha }}');
    expect(publishSection).toContain(
      'run: node --experimental-strip-types scripts/release/verify-publication.ts'
    );
    expect(publishSection).toContain("if: ${{ steps.guard.outputs.publish == 'true' }}");
    expect(publishSection).toContain('overwrite_files: false');
    expect(publishSection).toContain('fail_on_unmatched_files: true');
    expect(publishSection.indexOf('Verify publication boundary')).toBeLessThan(
      publishSection.indexOf('uses: softprops/action-gh-release@')
    );
    expect(releaseWorkflow).toContain('ref: ${{ github.sha }}');
    expect(releaseWorkflow).toContain(
      'git -c advice.detachedHead=false checkout --detach "$RELEASE_SHA"'
    );
    expect(releaseWorkflow).not.toContain('publish_branch: release');
    expect(releaseWorkflow).not.toContain('purge.jsdelivr.net');
    expect(releaseWorkflow).toContain('RELEASE_SHA: ${{ needs.provenance.outputs.release-sha }}');
    expect(releasePrepare).toContain("execFileSync('git', ['rev-parse', 'HEAD']");
    expect(releasePrepare).toContain('expectedCommit !== checkedOutCommit');
    expect(releasePrepare).toContain('const commit = releaseCommit;');
    expect(releasePrepare).not.toContain('process.env.GITHUB_SHA');
  });

  it('restores the verified release submodule before local execution', () => {
    const releaseWorkflow = readFileSync(resolve(root, '.github/workflows/release.yaml'), 'utf8');

    for (const job of releaseLocalExecutionJobs) {
      const jobSection = releaseWorkflow.match(
        new RegExp(`  ${job}:\\n[\\s\\S]*?(?=\\n  [a-z][\\w-]*:|$)`)
      )?.[0];
      const firstLocalExecution = `uses: ${releaseAction}`;

      expect(jobSection).toBeDefined();
      if (!jobSection) throw new Error(`Release job not found: ${job}`);
      expect(jobSection).toContain(
        [
          'git -c advice.detachedHead=false checkout --detach "$RELEASE_SHA"',
          '          git submodule sync --recursive',
          '          git submodule update --init --recursive',
        ].join('\n')
      );
      expect(jobSection.indexOf('git submodule update --init --recursive')).toBeLessThan(
        jobSection.indexOf(firstLocalExecution)
      );
    }
  });

  it('keeps the release install recipe local and immutable', () => {
    const actionPath = resolve(root, '.github/actions/setup-release/action.yaml');

    expect(existsSync(actionPath)).toBe(true);
    const action = readFileSync(actionPath, 'utf8');
    const nodeAction = 'uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0';
    const pnpmAction = 'uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0';
    const nodeStep = action.split(nodeAction)[1]?.split('    - name:')[0] ?? '';
    const pnpmStep = action.split(pnpmAction)[1]?.split('    - name:')[0] ?? '';
    expect(nodeStep).toContain('node-version: ${{ steps.runtime.outputs.version }}');
    expect(nodeStep).toContain('package-manager-cache: false');
    expect(pnpmStep).toContain('package_json_file: package.json');
    expect(pnpmStep).toMatch(/\n        cache: false\n/);
    expect(pnpmStep).toContain('run_install: false');
    expect(pnpmStep).toContain('standalone: false');
    expect(pnpmStep).not.toMatch(/\n        version:/);
    expect(action).toContain('pnpm install --frozen-lockfile --no-runtime');
    expect(action).not.toContain('uses: pnpm/setup@');
    expect(action.indexOf('id: runtime')).toBeLessThan(action.indexOf(nodeAction));
    expect(action.indexOf(nodeAction)).toBeLessThan(action.indexOf(pnpmAction));
    expect(action.indexOf(pnpmAction)).toBeLessThan(
      action.indexOf('pnpm install --frozen-lockfile --no-runtime')
    );
    expect(existsSync(resolve(root, '.github/actions/setup-toolchain/action.yaml'))).toBe(false);
  });
});
