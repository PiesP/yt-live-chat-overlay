import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const centralAction =
  'PiesP/browser-core/automation/actions/setup-project@f630a8f0119dd6b4f1aa011f8510489936c7a7b9';
const centralWorkflowJobs = {
  'ci.yaml': ['quality', 'unit', 'e2e', 'build'],
  'deep-checks.yaml': ['mutation-fast', 'mutation-renderer'],
} as const;
const releaseJobs = ['quality', 'unit', 'e2e', 'mutation', 'build'];
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
        expect(jobSection).toContain('node-version: ${{ env.NODE_VERSION }}');
      }
      expect(workflow.split(centralAction)).toHaveLength(jobs.length + 1);
      expect(workflow).not.toContain('uses: ./.github/actions/setup-toolchain');
      expect(workflow).not.toContain(releaseAction);
      expect(workflow).not.toContain('uses: pnpm/action-setup@');
      expect(workflow).not.toContain('uses: actions/setup-node@');
      expect(workflow).not.toContain('run: pnpm install --frozen-lockfile');
    }
  });

  it('uses the release-only action for every release dependency-backed job', () => {
    const releaseWorkflow = readFileSync(resolve(root, '.github/workflows/release.yaml'), 'utf8');

    for (const job of releaseJobs) {
      const jobSection = releaseWorkflow.match(
        new RegExp(`  ${job}:\\n[\\s\\S]*?(?=\\n  [a-z][\\w-]*:|$)`)
      )?.[0];

      expect(jobSection).toContain(`uses: ${releaseAction}`);
      expect(jobSection).toContain('node-version: ${{ env.NODE_VERSION }}');
    }
    expect(releaseWorkflow.split(releaseAction)).toHaveLength(releaseJobs.length + 1);
    expect(releaseWorkflow).not.toContain(centralAction);
    expect(topLevelBlock(releaseWorkflow, 'on')).toContain('workflow_dispatch:');
    expect(topLevelBlock(releaseWorkflow, 'on')).toContain('tag:');
    expect(releaseWorkflow).toContain("github.ref == 'refs/heads/master'");
    expect(releaseWorkflow).toContain('git merge-base --is-ancestor "$release_sha" "$GITHUB_SHA"');
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

  it('keeps the release install recipe local and immutable', () => {
    const actionPath = resolve(root, '.github/actions/setup-release/action.yaml');

    expect(existsSync(actionPath)).toBe(true);
    const action = readFileSync(actionPath, 'utf8');
    expect(action).toContain('uses: pnpm/setup@84cb39b217b10273981911c288cd62326dc7c6d2 # v2.0.2');
    expect(action).toContain('package-json-file: package.json');
    expect(action).toContain('runtime: "node@${{ inputs.node-version }}"');
    expect(action).toContain('cache: false');
    expect(action).toContain('install: false');
    expect(action).toContain('pnpm install --frozen-lockfile --no-runtime');
    expect(existsSync(resolve(root, '.github/actions/setup-toolchain/action.yaml'))).toBe(false);
  });
});
