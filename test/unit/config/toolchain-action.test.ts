import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const centralAction =
  'PiesP/browser-core/automation/actions/setup-project@f630a8f0119dd6b4f1aa011f8510489936c7a7b9';
const workflowJobs = {
  'ci.yaml': ['quality', 'unit', 'e2e', 'build'],
  'deep-checks.yaml': ['mutation-fast', 'mutation-renderer'],
  'release.yaml': ['quality', 'unit', 'e2e', 'mutation', 'build'],
} as const;

describe('central setup-project action', () => {
  it('uses the immutable central action in every dependency-backed job', () => {
    for (const [filename, jobs] of Object.entries(workflowJobs)) {
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
      expect(workflow).not.toContain('uses: pnpm/action-setup@');
      expect(workflow).not.toContain('uses: actions/setup-node@');
      expect(workflow).not.toContain('run: pnpm install --frozen-lockfile');
    }
  });

  it('does not retain the superseded local setup action', () => {
    expect(existsSync(resolve(root, '.github/actions/setup-toolchain/action.yaml'))).toBe(false);
  });
});
