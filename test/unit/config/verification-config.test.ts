import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vite-plus/test';

import viteConfig from '../../../vite.config';

const root = resolve(import.meta.dirname, '../../..');
const scripts = (
  JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;
const configuration = viteConfig({ command: 'serve', mode: 'test' });
const tasks = configuration.run?.tasks;

function commands(name: string): string[] {
  const task = tasks?.[name];
  if (!Array.isArray(task)) throw new Error(`Missing ordered Vite+ task: ${name}`);
  return task.map((entry: unknown) => {
    if (typeof entry !== 'string') throw new Error(`Invalid task command: ${name}`);
    return entry;
  });
}

describe('Vite+ verification ownership', () => {
  it('runs every quality check once and disables task caching for guarded paths', () => {
    expect(configuration.run?.cache).toBe(false);
    expect(scripts.quality).toBe('vp run quality-gate');
    expect(commands('quality-gate')).toEqual([
      "vp check src scripts extension test tooling validation/windows .github/actions '*.ts' '*.json'",
      'vp run test:ci',
      'vp run check:i18n',
    ]);
    expect(scripts['quality:fix']).toBe('vp run quality-fix-gate');
    expect(commands('quality-fix-gate')).toEqual([
      "vp check --fix src scripts extension test tooling validation/windows .github/actions '*.ts' '*.json'",
      'vp run quality',
    ]);
  });

  it('keeps prebuild checks and production targets in one ordered Vite+ pass', () => {
    expect(scripts['check:prebuild']).toBe('vp run prebuild-gate');
    expect(commands('prebuild-gate')).toEqual(['vp run check:versions', 'vp run quality']);
    for (const lifecycle of [
      'prebuild',
      'prebuild:extension',
      'prebuild:extension:firefox',
      'prebuild:all',
    ]) {
      expect(scripts[lifecycle]).toBe('vp run check:prebuild');
    }
    expect(scripts['build:targets:ci']).toBe(
      'node --experimental-strip-types scripts/build/targets.ts'
    );
    expect(commands('production-build')).toEqual([
      'vp run build:ci',
      'vp run build:extension:ci',
      'vp run build:extension:firefox:ci',
      'vp run check:artifacts',
    ]);
    expect(scripts['build:extension:ci']).toBe('vp run chrome-build');
    expect(scripts['build:extension:firefox:ci']).toBe('vp run firefox-build');
    expect(commands('chrome-build')).toHaveLength(3);
    expect(commands('firefox-build')).toHaveLength(3);
    expect(scripts['build:all']).toBe('vp run build:targets:ci');
    expect(scripts['build:all:ci']).toBe('vp run build-all-ci-gate');
    expect(commands('build-all-ci-gate')).toEqual([
      'vp run check:versions',
      'vp run check:i18n',
      'vp run build:targets:ci',
    ]);
  });

  it('keeps verification, nested core and browser preparation ordered', () => {
    expect(scripts.verify).toBe('vp run verify-gate');
    expect(commands('verify-gate')).toEqual([
      'vp run quality',
      'vp run check:versions',
      'vp run build:targets:ci',
    ]);
    expect(scripts['verify:full']).toBe('vp run verify-full-gate');
    expect(commands('verify-full-gate')).toEqual([
      'vp run verify',
      'vp run test:core',
      'vp run test:cov',
      'vp run test:e2e:prepared',
    ]);
    expect(scripts['test:core']).toBe('vp run core-verify');
    expect(tasks?.['core-verify']).toEqual({
      cwd: 'packages/core',
      command: ['vp install --frozen-lockfile -- --no-runtime', 'pnpm run verify'],
    });
    expect(scripts['pretest:e2e']).toBe('vp run e2e-prepare');
    expect(commands('e2e-prepare')).toEqual([
      'vp run build:dev',
      'vp run build:extension:ci',
      'vp run build:extension:firefox:ci',
      'vp run check:artifacts --e2e',
    ]);
    expect(scripts['test:e2e:prepared']).toBe('vp run e2e-prepared');
    expect(commands('e2e-prepared')).toEqual([
      'vp run build:dev',
      'vp run check:artifacts --e2e',
      'playwright test --config test/e2e/playwright.config.ts',
    ]);
  });

  it('prepares the unit job and Chromium before either core or consumer browser tests', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
    const unit = workflow.split('\n  unit:\n')[1]?.split('\n  e2e:\n')[0] ?? '';
    const coreOrUnit =
      "${{ needs.changes.result != 'success' || needs.changes.outputs.core == 'true' || needs.changes.outputs.unit == 'true' }}";
    const step = (name: string) => {
      const start = unit.indexOf(`      - name: ${name}\n`);
      expect(start).toBeGreaterThan(-1);
      const end = unit.indexOf('\n      - name: ', start + 1);
      return unit.slice(start, end < 0 ? undefined : end);
    };

    for (const name of [
      '📥 Checkout code',
      '📦 Set up project',
      'Install Chromium for Browser Mode unit tests',
    ]) {
      expect(step(name)).toContain(`if: ${coreOrUnit}`);
    }
    expect(step('Install Chromium for Browser Mode unit tests')).toContain(
      'run: vp exec playwright install --with-deps chromium'
    );
    expect(step('Verify the pinned browser-core contracts')).toContain(
      "if: ${{ needs.changes.result != 'success' || needs.changes.outputs.core == 'true' }}"
    );
    const positions = [
      '📥 Checkout code',
      '📦 Set up project',
      'Install Chromium for Browser Mode unit tests',
      'Verify the pinned browser-core contracts',
      '🧪 Run unit tests and coverage thresholds',
    ].map((name) => unit.indexOf(`      - name: ${name}\n`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('retains browser traces from the first failed attempt without changing retry verdicts', () => {
    const url = pathToFileURL(resolve(root, 'test/e2e/playwright.config.ts')).href;
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
      const observations = [];
      for (const ci of [false, true]) {
        if (ci) process.env.CI = 'true'; else delete process.env.CI;
        const { default: config } = await import(${JSON.stringify(url)} + '?ci=' + ci);
        observations.push({ retries: config.retries, failOnFlakyTests: config.failOnFlakyTests, trace: config.use.trace, video: config.use.video, screenshot: config.use.screenshot });
      }
      process.stdout.write(JSON.stringify(observations));
    `,
      ],
      { cwd: root, encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      {
        retries: 0,
        failOnFlakyTests: true,
        trace: 'retain-on-failure',
        video: 'off',
        screenshot: 'only-on-failure',
      },
      {
        retries: 1,
        failOnFlakyTests: true,
        trace: 'retain-on-failure',
        video: 'on-first-retry',
        screenshot: 'only-on-failure',
      },
    ]);
    const workflow = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
    expect(workflow).toContain('test-results/');
    expect(workflow).toContain('playwright-report/');
  });

  it('provisions both browsers without a browser cache', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
    const e2e = workflow.split('\n  e2e:\n')[1]?.split('\n  build:\n')[0] ?? '';
    expect(e2e).not.toContain('~/.cache/ms-playwright');
    expect(e2e).not.toContain('cache_trial');
    expect(e2e).toContain('playwright install --with-deps chromium firefox');
    expect(e2e).toContain('xvfb-run --auto-servernum --server-args="-screen 0 1280x720x24"');
  });
});
