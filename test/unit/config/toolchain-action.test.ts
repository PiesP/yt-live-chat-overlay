import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const centralAction =
  'PiesP/browser-core/automation/actions/setup-project@279124fa998847bd0184d2de12bdaadcd6d2f969';
const centralWorkflowJobs = {
  'ci.yaml': ['changes', 'quality', 'unit', 'e2e', 'build'],
  'security.yaml': ['changes', 'pin-metadata', 'pinned-tools', 'osv-scan-pr', 'osv-scan-dispatch'],
  'deep-checks.yaml': ['duplication', 'mutation-fast', 'mutation-renderer'],
} as const;
const releaseJobs = ['quality', 'unit', 'e2e', 'mutation', 'build'];
const releaseLocalExecutionJobs = [...releaseJobs, 'duplication'];
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
  it('keeps CI and deep jobs on the immutable central action', () => {
    for (const [filename, jobs] of Object.entries(centralWorkflowJobs)) {
      const workflow = readFileSync(
        resolve(root, '.github/workflows', filename),
        'utf8'
      );

      for (const job of jobs) {
        const jobSection = workflow.match(
          new RegExp(`  ${job}:\\n[\\s\\S]*?(?=\\n  [a-z][\\w-]*:|$)`)
        )?.[0];

        expect(jobSection).toContain(`uses: ${centralAction}`);
        expect(jobSection).not.toContain('node-version:');
      }
      expect(workflow.split(centralAction)).toHaveLength(
        filename === 'deep-checks.yaml' ? 6 : jobs.length + 1
      );
      expect(workflow).not.toContain('uses: ./.github/actions/setup-toolchain');
      expect(workflow).not.toContain(releaseAction);
      expect(workflow).not.toContain('uses: pnpm/action-setup@');
      expect(workflow).not.toContain('uses: actions/setup-node@');
      expect(workflow).not.toContain('run: pnpm install --frozen-lockfile');
      if (filename === 'ci.yaml' || filename === 'security.yaml') {
        const changes = workflow.match(/  changes:\n[\s\S]*?(?=\n  [a-z][\w-]*:|$)/)?.[0];
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
    const duplication = releaseWorkflow.match(/  duplication:\n[\s\S]*?(?=\n  [a-z][\w-]*:|$)/u)?.[0] ?? '';
    expect(duplication).toContain(`uses: ${centralAction}`);
    expect(duplication).toContain("install-dependencies: 'false'");
    const provenance = releaseWorkflow.match(/  provenance:\n[\s\S]*?(?=\n  [a-z][\w-]*:|$)/)?.[0] ?? '';
    expect(provenance).toContain(`uses: ${centralAction}`);
    expect(provenance).toContain("install-dependencies: 'false'");
    const publishSection = releaseWorkflow.match(
      /  publish:\n[\s\S]*?(?=\n  [a-z][\w-]*:|$)/
    )?.[0];
    expect(publishSection).toBeDefined();
    if (!publishSection) throw new Error('Release publish job not found');
    expect(publishSection).toContain(`uses: ${centralAction}`);
    expect(publishSection).toContain("install-dependencies: 'false'");
    expect(
      releaseWorkflow.replace(duplication, '').replace(provenance, '').replace(publishSection, '')
    ).not.toContain(centralAction);
    expect(topLevelBlock(releaseWorkflow, 'on')).toContain('workflow_dispatch:');
    expect(topLevelBlock(releaseWorkflow, 'on')).toContain('tag:');
    expect(releaseWorkflow).toContain("github.ref == 'refs/heads/master'");
    expect(provenance).toContain('run: node --experimental-strip-types scripts/release/verify-source.ts');
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
    expect(releaseWorkflow).toContain(
      'RELEASE_SHA: ${{ needs.provenance.outputs.release-sha }}'
    );
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
      const firstLocalExecution =
        job === 'duplication'
          ? 'node --experimental-strip-types "$pinned_dir/install-nose.ts"'
          : `uses: ${releaseAction}`;

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
    expect(action).toContain('uses: pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b # v2.1.0');
    expect(action).toContain('package-json-file: package.json');
    expect(action).toContain('runtime: "node@${{ steps.runtime.outputs.version }}"');
    expect(action).toContain('cache: false');
    expect(action).toContain('install: false');
    expect(action).toContain('pnpm install --frozen-lockfile --no-runtime');
    expect(existsSync(resolve(root, '.github/actions/setup-toolchain/action.yaml'))).toBe(false);
  });
});
