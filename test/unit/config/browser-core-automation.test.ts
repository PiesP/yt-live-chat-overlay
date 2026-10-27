import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../../.github/workflows/update-browser-core.yaml'),
  'utf8'
);
const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../package.json'), 'utf8')
) as { scripts: Record<string, string> };
const testConfig = readFileSync(resolve(import.meta.dirname, '../../../vitest.config.ts'), 'utf8');

describe('browser-core workflow composition', () => {
  it('runs local policy from the trusted default branch after runtime setup', () => {
    const checkout = workflow.indexOf('ref: master');
    const runtime = workflow.indexOf(
      'automation/actions/setup-project@af19a6597c351f03a65e49532bdec6276e4b5ae9'
    );
    const prepare = workflow.indexOf(
      'run: node --experimental-strip-types scripts/ci/update-browser-core.ts prepare'
    );
    expect(checkout).toBeGreaterThan(-1);
    expect(runtime).toBeGreaterThan(checkout);
    expect(prepare).toBeGreaterThan(runtime);
    expect(workflow).toContain("install-dependencies: 'false'");
    expect(workflow).toContain('submodules: false');
  });

  it('classifies before publication and passes the exact prepared revisions', () => {
    const impact = workflow.indexOf(
      'automation/actions/consumer-impact@bfb692953b18d99203591cb0671978d5ff6115b8'
    );
    expect(impact).toBeGreaterThan(workflow.indexOf('scripts/ci/update-browser-core.ts prepare'));
    expect(workflow.indexOf('scripts/ci/update-browser-core.ts publish')).toBeGreaterThan(impact);
    expect(workflow).toContain('base-sha: ${{ steps.prepare.outputs.base }}');
    expect(workflow).toContain('head-sha: ${{ steps.prepare.outputs.head }}');
    expect(workflow).toContain('CONSUMER_IMPACT: ${{ steps.impact.outputs.impact }}');
    expect(workflow.match(/if: steps\.prepare\.outputs\.ready == 'true'/g)).toHaveLength(3);
    expect(workflow).toContain('paths-ignore:\n      - packages/core');
    expect(workflow).toContain('consumer_base: ${{ steps.prepare.outputs.consumer_base }}');
    expect(workflow).toContain(
      'CLASSIFIED_CONSUMER_BASE_SHA: ${{ needs.classify.outputs.consumer_base }}'
    );
    expect(workflow).toContain(
      'CLASSIFIED_CORE_MASTER_SHA: ${{ needs.classify.outputs.core_master }}'
    );
  });

  it('keeps dry-run and diagnostics explicit and registers actual CLI tests', () => {
    const classify = workflow.split('\n  classify:')[1]?.split('\n  publish:')[0] ?? '';
    const publish = workflow.split('\n  publish:')[1] ?? '';
    expect(workflow).toContain('permissions:\n  contents: read\n  pull-requests: read');
    expect(classify).toContain("DRY_RUN: 'true'");
    expect(classify).not.toContain('actions: write');
    expect(publish).toContain('inputs.dry_run != true');
    expect(publish).toContain("needs.classify.outputs.open_pr == 'true'");
    expect(publish).toContain('actions: write');
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
    expect(workflow.match(/install-dependencies: 'false'/g)).toHaveLength(2);
    expect(workflow).toContain('PREFLIGHT: ${{ inputs.preflight }}');
    expect(workflow).not.toContain('AUTO_MERGE_TOKEN');
    expect(workflow).not.toContain('gh pr merge');
    expect(manifest.scripts['test:ci']).toBe('vp test run --project=node-policy');
    expect(testConfig).toContain("name: 'node-policy'");
    expect(testConfig).toContain('scripts/ci/repository-authority.test.ts');
  });
});
