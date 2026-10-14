import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isFunctionDeclaration } from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

describe('Verification configuration', () => {
  it('targets complete fitting, outline, and shape functions and detects an omitted target', () => {
    const config = JSON.parse(
      readFileSync(resolve(root, 'stryker.conf.renderer.json'), 'utf8')
    ) as { mutate: string[] };
    const api = new API({ cwd: root });
    try {
      const path = resolve(root, 'src/renderer/canvas/shared.ts');
      const snapshot = api.updateSnapshot({ openFiles: [path] });
      const source = snapshot.getDefaultProjectForFile(path)?.program.getSourceFile(path);
      if (!source) throw new Error('Mutation source is unavailable');
      const names = ['fitWrappedLineToWidth', 'strokeTextOutline', 'hasRoundRect', 'drawRoundRect'];
      const functions = source.statements
        .filter(isFunctionDeclaration)
        .filter((node) => names.includes(node.name?.text ?? ''));
      expect(functions).toHaveLength(names.length);
      function assertTargets(targets: string[]) {
        const ranges = targets.flatMap((target) => {
          const match = /^src\/renderer\/canvas\/shared\.ts(?::(\d+)-(\d+))?$/.exec(target);
          return match ? [[Number(match[1] ?? 1), Number(match[2] ?? Infinity)]] : [];
        });
        for (const fn of functions) {
          if (!fn.body) throw new Error('Mutation target has no body');
          const start = source!.getLineAndCharacterOfPosition(fn.body.getStart(source)).line + 1;
          const end = source!.getLineAndCharacterOfPosition(fn.body.getEnd() - 1).line + 1;
          if (
            !ranges.some(
              ([first, last]) =>
                first !== undefined && last !== undefined && first <= start && last >= end
            )
          ) {
            throw new Error(`Mutation target omitted: ${fn.name?.text}`);
          }
        }
      }
      assertTargets(config.mutate);
      expect(() =>
        assertTargets(
          config.mutate.filter((entry) => !entry.startsWith('src/renderer/canvas/shared.ts'))
        )
      ).toThrow('Mutation target omitted');
      expect(() => assertTargets(['src/renderer/canvas/shared.ts:1-1'])).toThrow(
        'Mutation target omitted'
      );
    } finally {
      api.close();
    }
  });

  it('keeps fast mutation semantic, enforceable, and diagnosable', () => {
    const config = JSON.parse(readFileSync(resolve(root, 'stryker.conf.fast.json'), 'utf8')) as {
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
    expect(config.reporters).toEqual(expect.arrayContaining(['clear-text', 'json', 'html']));
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
    expect(packageJson.scripts?.['mut:fast']?.trim().split(/\s+/)).toEqual([
      'stryker',
      'run',
      'stryker.conf.fast.json',
    ]);
    expect(workflow).toContain('timeout-minutes: 35');
    expect(workflow).toContain('path: reports/mutation/');
    expect(workflow).toContain('if-no-files-found: error');
  });

  it('captures browser failure evidence on the first CI retry', () => {
    const url = pathToFileURL(resolve(root, 'test/e2e/playwright.config.ts')).href;
    // Direct Node loading avoids asking Vitest to transform Playwright's runner.
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
        trace: 'on-first-retry',
        video: 'on-first-retry',
        screenshot: 'only-on-failure',
      },
    ]);
    const workflow = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
    expect(workflow).toContain('test-results/');
    expect(workflow).toContain('playwright-report/');
  });

  it('runs one complete Biome pass, preserves quality order, and propagates failures', () => {
    const scripts = (
      JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    const directory = mkdtempSync(join(tmpdir(), 'yt-quality-contract-'));
    try {
      const bin = join(directory, 'bin');
      mkdirSync(bin);
      const log = join(directory, 'calls.jsonl');
      const record = join(directory, 'record.mjs');
      writeFileSync(
        record,
        `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
process.exit(args.join(' ') === process.env.FAIL_COMMAND ? 17 : 0);
`
      );
      for (const tool of ['biome', 'pnpm']) {
        const shim = join(bin, tool);
        writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' '${record}' ${tool} "$@"\n`);
        chmodSync(shim, 0o755);
      }
      function run(name: string, failure = '') {
        writeFileSync(log, '');
        const command = scripts[name];
        if (!command) throw new Error(`Missing command: ${name}`);
        const result = spawnSync(command, {
          shell: true,
          cwd: directory,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH}`,
            CALL_LOG: log,
            FAIL_COMMAND: failure,
          },
        });
        expect(result.error).toBeUndefined();
        const calls = readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]);
        return { status: result.status, calls };
      }
      const quality = run('quality');
      expect(quality.status).toBe(0);
      expect(quality.calls[0]).toEqual(['biome', 'check', '--error-on-warnings', '.']);
      expect(quality.calls.filter(([tool]) => tool === 'biome')).toHaveLength(1);
      expect(quality.calls.slice(1).map((call) => call.at(-1))).toEqual([
        'check',
        'check:extension',
        'check:test',
        'check:e2e',
        'check:scripts',
        'test:ci',
        'check:i18n',
        'circular',
        'knip',
      ]);
      const rejected = run('quality', 'biome check --error-on-warnings .');
      expect(rejected.status).toBe(17);
      expect(rejected.calls).toHaveLength(1);
      const typeFailure = run('quality', 'pnpm -s check:extension');
      expect(typeFailure.status).toBe(17);
      expect(typeFailure.calls.map((call) => call.at(-1))).toEqual([
        '.',
        'check',
        'check:extension',
      ]);
      expect(run('quality:fix').calls).toEqual([
        ['biome', 'check', '--write', '--error-on-warnings', '.'],
        ['pnpm', '-s', 'quality'],
      ]);
      const targets = [
        'build:ci',
        'build:extension:ci',
        'build:extension:firefox:ci',
        'check:artifacts',
      ];
      expect(run('build:targets:ci').calls.map((call) => call.at(-1))).toEqual(targets);
      expect(run('verify').calls.map((call) => call.at(-1))).toEqual([
        'quality',
        'check:versions',
        'build:targets:ci',
      ]);
      expect(run('build:all:ci').calls.map((call) => call.at(-1))).toEqual([
        'check:versions',
        'check:i18n',
        'build:targets:ci',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
