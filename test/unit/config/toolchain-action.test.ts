import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');
const centralAction =
  'PiesP/browser-core/automation/actions/setup-project@38cd1cb18c9c37e57e8b53a98e811450bb1a18fc';
const centralWorkflowJobs = {
  'ci.yaml': ['changes', 'quality', 'unit', 'e2e', 'build'],
  'security.yaml': ['changes', 'pin-metadata', 'pinned-tools', 'osv-scan-pr', 'osv-scan-dispatch'],
} as const;
const releaseJobs = ['quality', 'unit', 'e2e', 'build'];
const releaseAction = './.github/actions/setup-release';
const releasePrepare = readFileSync(resolve(root, 'scripts/release/prepare.ts'), 'utf8');
const reviewedScannerSource = 'e61b85b0c31bc0dc1d526f43eb5ee158a512c3be';

function topLevelBlock(workflow: string, key: string): string {
  const marker = `${key}:\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`Workflow key not found: ${key}`);

  const afterMarker = start + marker.length;
  const nextKey = workflow.slice(afterMarker).search(/\n[A-Za-z][A-Za-z0-9_-]*:\n/);
  return workflow.slice(start, nextKey === -1 ? undefined : afterMarker + nextKey).trimEnd();
}

describe('project setup actions', () => {
  it('uses the reviewed scanner source runtime pin through shared setup', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/security.yaml'), 'utf8');
    for (const job of ['pin-metadata', 'pinned-tools']) {
      const jobSection = workflow.match(
        new RegExp(`  ${job}:\\n[\\s\\S]*?(?=\\n  [a-z][\\w-]*:|$)`)
      )?.[0];
      expect(jobSection).toContain(`ref: ${reviewedScannerSource}`);
      expect(jobSection).toContain(`uses: ${centralAction}`);
      expect(jobSection).not.toContain('node-version:');
      expect(jobSection).toContain("install-dependencies: 'false'");
    }
  });

  it('keeps CI and security jobs on the immutable central action', () => {
    for (const [filename, jobs] of Object.entries(centralWorkflowJobs)) {
      const workflow = readFileSync(resolve(root, '.github/workflows', filename), 'utf8');

      for (const job of jobs) {
        const jobSection = workflow.match(
          new RegExp(`  ${job}:\\n[\\s\\S]*?(?=\\n  [a-z][\\w-]*:|$)`)
        )?.[0];

        expect(jobSection).toContain(`uses: ${centralAction}`);
        if (filename === 'ci.yaml' && job === 'unit') {
          expect(jobSection).toContain('node-version: ${{ steps.release_pin.outputs.version }}');
        } else if (
          filename !== 'security.yaml' ||
          !['pin-metadata', 'pinned-tools'].includes(job)
        ) {
          expect(jobSection).not.toContain('node-version:');
        }
      }
      expect(workflow.split(centralAction)).toHaveLength(
        jobs.length + (filename === 'ci.yaml' ? 2 : 1)
      );
      expect(workflow).not.toContain('uses: ./.github/actions/setup-toolchain');
      if (filename === 'ci.yaml') {
        const unit = workflow.split('\n  unit:\n')[1]?.split('\n  e2e:\n')[0] ?? '';
        expect(workflow).not.toContain(releaseAction);
        const override = unit.indexOf('Exercise release setup with a numeric override');
        expect(unit.indexOf(centralAction)).toBeLessThan(override);
        expect(unit.indexOf('Record release setup inputs')).toBeLessThan(override);
        expect(override).toBeLessThan(unit.indexOf('Verify release setup'));
        expect(unit).toContain('node-version: ${{ steps.release_pin.outputs.version }}');
        expect(unit).toContain('sha256sum --check "$RUNNER_TEMP/release-setup-inputs.sha256"');
        expect(unit).toContain('expected_node=$(cat .node-version)');
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

  it('uses the shared Vite+ setup with verified runtime overrides for tagged releases', () => {
    const releaseWorkflow = readFileSync(resolve(root, '.github/workflows/release.yaml'), 'utf8');

    for (const job of releaseJobs) {
      const jobSection = releaseWorkflow.match(
        new RegExp(`  ${job}:\\n[\\s\\S]*?(?=\\n  [a-z][\\w-]*:|$)`)
      )?.[0];

      expect(jobSection).toContain(`uses: ${centralAction}`);
      expect(jobSection).toContain('node-version: ${{ needs.provenance.outputs.node-version }}');
    }
    expect(releaseWorkflow).not.toContain(releaseAction);
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
    expect(releaseWorkflow.split(centralAction)).toHaveLength(releaseJobs.length + 3);
    expect(topLevelBlock(releaseWorkflow, 'on')).toContain('workflow_dispatch:');
    expect(topLevelBlock(releaseWorkflow, 'on')).toContain('tag:');
    expect(releaseWorkflow).toContain("github.ref == 'refs/heads/master'");
    expect(provenance).toContain(
      'run: node --experimental-strip-types scripts/release/verify-source.ts'
    );
    expect(provenance.indexOf('Checkout protected workflow source')).toBeLessThan(
      provenance.indexOf('Setup trusted provenance runtime')
    );
    expect(provenance.indexOf('Setup trusted provenance runtime')).toBeLessThan(
      provenance.indexOf('scripts/release/verify-source.ts')
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

  it('restores the verified release submodule before shared setup', () => {
    const releaseWorkflow = readFileSync(resolve(root, '.github/workflows/release.yaml'), 'utf8');

    for (const job of releaseJobs) {
      const jobSection = releaseWorkflow.match(
        new RegExp(`  ${job}:\\n[\\s\\S]*?(?=\\n  [a-z][\\w-]*:|$)`)
      )?.[0];
      const firstLocalExecution = `uses: ${centralAction}`;

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

  it('retires the local release setup in favor of the shared provider', () => {
    const actionPath = resolve(root, '.github/actions/setup-release/action.yaml');

    expect(existsSync(actionPath)).toBe(false);
    expect(existsSync(resolve(root, '.github/actions/setup-release/resolve-runtime.mjs'))).toBe(
      false
    );
    expect(existsSync(resolve(root, '.github/actions/setup-toolchain/action.yaml'))).toBe(false);
  });

  it('does not schedule updates for the retired standalone pnpm setup action', () => {
    const dependabot = readFileSync(resolve(root, '.github/dependabot.yaml'), 'utf8');
    expect(dependabot).not.toContain('pnpm/action-setup');
    expect(dependabot).toContain('github/codeql-action*');
  });
});
