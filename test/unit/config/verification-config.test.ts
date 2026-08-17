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
      vitest?: { related?: boolean };
    };
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const rendererConfig = JSON.parse(
      readFileSync(resolve(root, 'stryker.conf.renderer.json'), 'utf8')
    ) as { thresholds?: { break?: number | null }; vitest?: { related?: boolean } };
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
    expect(config.thresholds?.break).toBe(62);
    expect(rendererConfig.thresholds?.break).toBe(90);
    expect(config.vitest?.related).toBe(true);
    expect(rendererConfig.vitest?.related).toBe(true);
    expect(config.mutator?.excludedMutations).not.toContain('ConditionalExpression');
    expect(config.mutator?.excludedMutations).not.toContain('EqualityOperator');
    expect(config.mutator?.excludedMutations).not.toContain('BooleanLiteral');
    expect(packageJson.scripts?.['mut:fast']).toBe('stryker run stryker.conf.fast.json');
    expect(workflow).toContain('timeout-minutes: 35');
    expect(workflow).toContain('path: reports/mutation/');
    expect(workflow).toContain('if-no-files-found: error');
  });

  it('captures browser failure evidence on the first CI retry', () => {
    const config = readFileSync(resolve(root, 'test/e2e/playwright.config.ts'), 'utf8');
    const workflow = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');

    expect(config).toContain('retries: process.env.CI ? 1 : 0');
    expect(config).toContain("trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure'");
    expect(config).toContain("video: process.env.CI ? 'on-first-retry' : 'off'");
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

  it('reuses one artifact build pipeline without duplicating the quality gate', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8')
    ) as { scripts?: Record<string, string> };
    const scripts = packageJson.scripts ?? {};

    expect(scripts['quality:fix']).toBe(
      'pnpm -s fmt:fix && pnpm -s lint:fix && pnpm -s quality'
    );
    expect(scripts['build:targets:ci']).toBe(
      'pnpm -s build:ci && pnpm -s build:extension:ci && pnpm -s build:extension:firefox:ci && pnpm -s check:artifacts'
    );
    expect(scripts['build:all']).toBe('pnpm -s build:targets:ci');
    expect(scripts['build:all:ci']).toBe(
      'pnpm -s check:versions && pnpm -s check:i18n && pnpm -s build:targets:ci'
    );
    expect(scripts.verify).toBe(
      'pnpm -s quality && pnpm -s check:versions && pnpm -s build:targets:ci'
    );
  });
});
