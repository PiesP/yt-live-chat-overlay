import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

describe('Verification configuration', () => {
  it('keeps fast mutation semantic, enforceable, and diagnosable', () => {
    const config = JSON.parse(
      readFileSync(resolve(root, 'stryker.conf.fast.json'), 'utf8')
    ) as {
      mutate?: string[];
      reporters?: string[];
      jsonReporter?: { fileName?: string };
      thresholds?: { break?: number | null };
      mutator?: { excludedMutations?: string[] };
    };
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const workflow = readFileSync(resolve(root, '.github/workflows/deep-checks.yaml'), 'utf8');

    expect(config.thresholds?.break).toBeGreaterThan(0);
    expect(config.reporters).toEqual(
      expect.arrayContaining(['clear-text', 'json', 'html'])
    );
    expect(config.jsonReporter?.fileName).toBe('reports/mutation/fast.json');
    expect(config.mutate).toEqual(
      expect.arrayContaining([
        '!src/settings/ui/form.ts',
        '!src/settings/ui/panes.ts',
        '!src/translation/service.ts',
        '!src/util/backlog-indicator.ts',
        '!src/util/observability.ts',
      ])
    );
    expect(config.thresholds?.break).toBe(64);
    expect(config.mutator?.excludedMutations).not.toContain('ConditionalExpression');
    expect(config.mutator?.excludedMutations).not.toContain('EqualityOperator');
    expect(config.mutator?.excludedMutations).not.toContain('BooleanLiteral');
    expect(packageJson.scripts?.['mut:fast']).toBe('stryker run stryker.conf.fast.json');
    expect(workflow).toContain('timeout-minutes: 35');
    expect(workflow).toContain('path: reports/mutation/');
    expect(workflow).toContain('if-no-files-found: error');
  });

  it('retains browser failure evidence in CI', () => {
    const config = readFileSync(resolve(root, 'test/e2e/playwright.config.ts'), 'utf8');
    const workflow = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');

    expect(config).toContain("trace: 'retain-on-failure'");
    expect(config).toContain("video: process.env.CI ? 'retain-on-failure' : 'off'");
    expect(workflow).toContain('test-results/');
    expect(workflow).toContain('playwright-report/');
  });

  it('runs Biome over every published extension TypeScript entrypoint', () => {
    const config = JSON.parse(readFileSync(resolve(root, 'biome.json'), 'utf8')) as {
      files?: { includes?: string[] };
    };
    const includes = config.files?.includes ?? [];

    expect(includes).toContain('extension/**/*.ts');
    expect(includes.some((pattern) => pattern.includes('!!**/extension/'))).toBe(false);
  });
});
