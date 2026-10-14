import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const biome = resolve(root, 'node_modules/.bin/biome');

describe('Effective Biome coverage', () => {
  it('rejects warning-only input through the configured lint and quality gates', () => {
    const directory = mkdtempSync(join(tmpdir(), 'yt-biome-warning-'));
    try {
      const git = spawnSync('git', ['init', '--quiet', '--initial-branch=master'], {
        cwd: directory,
        encoding: 'utf8',
      });
      expect(git.status, git.stderr).toBe(0);
      copyFileSync(join(root, 'biome.json'), join(directory, 'biome.json'));
      copyFileSync(join(root, '.gitignore'), join(directory, '.gitignore'));
      mkdirSync(join(directory, 'scripts'));
      const file = join(directory, 'scripts/control.ts');
      const source =
        'export function control(value: number) {\n  value += 1;\n  return value;\n}\n';
      writeFileSync(file, source);
      const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
        .scripts as Record<string, string>;
      const run = (args: string[]) => spawnSync(biome, args, { cwd: directory, encoding: 'utf8' });
      const advisory = run(['lint', '.']);
      expect(advisory.status, advisory.stdout + advisory.stderr).toBe(0);
      expect(advisory.stdout + advisory.stderr).toContain('noParameterAssign');
      for (const name of ['lint', 'quality']) {
        const command = scripts[name]?.split(' && ')[0];
        if (!command) throw new Error(`Missing ${name} command`);
        const result = run(command.split(' ').slice(1));
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stdout + result.stderr).toContain('noParameterAssign');
        expect(readFileSync(file, 'utf8')).toBe(source);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('checks each first-party boundary and excludes external/generated material in both invocation modes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'yt-biome-coverage-'));
    try {
      const git = spawnSync('git', ['init', '--quiet', '--initial-branch=master'], {
        cwd: directory,
        encoding: 'utf8',
      });
      expect(git.status, git.stderr).toBe(0);
      copyFileSync(join(root, 'biome.json'), join(directory, 'biome.json'));
      copyFileSync(join(root, '.gitignore'), join(directory, '.gitignore'));
      const included = [
        'src/fixture.ts',
        'extension/fixture.ts',
        'extension/manifest.json',
        'extension/manifest.firefox.json',
        'test/unit/fixture.ts',
        'test/e2e/fixture.ts',
        'test/visual/gm-mocks.js',
        'tooling/fixture.ts',
        'scripts/fixture.ts',
        'validation/windows/fixture.mjs',
        '.github/actions/fixture/fixture.mjs',
        'vitest.config.ts',
        'vite.config.fixture.ts',
        'tsconfig.fixture.json',
        'stryker.conf.fixture.json',
        'validation/windows/fixture.json',
      ];
      const excluded = [
        'packages/core/src/fixture.ts',
        'node_modules/vendor/fixture.ts',
        'dist/fixture.ts',
        'dist-extension/page-script.js',
        'dist-extension-firefox/page-script.js',
        'reports/fixture.json',
        'coverage/fixture.json',
        'test-results/fixture.json',
        'playwright-report/fixture.json',
        'test/browser-profiles/default/fixture.json',
        'vendor/fixture.ts',
        'validation/windows/fixture.py',
        'test/visual/fixture.html',
      ];
      function write(path: string, text: string) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), text);
      }
      for (const path of included) {
        write(path, path.endsWith('.json') ? '{"fixture":true}' : 'export const fixture = "bad"');
      }
      // Deliberately malformed excluded input must never reach the parser.
      for (const path of excluded) write(path, '{{ malformed fixture');
      function check(paths: string[]) {
        const result = spawnSync(
          biome,
          ['check', '--reporter=json', '--max-diagnostics=1000', ...paths],
          {
            cwd: directory,
            encoding: 'utf8',
          }
        );
        expect(result.error).toBeUndefined();
        const report = JSON.parse(result.stdout) as {
          diagnostics: { category: string; location?: { path?: string } }[];
        };
        return { result, report };
      }
      for (const paths of [['.'], [...included, ...excluded]]) {
        const { result, report } = check(paths);
        expect(result.status).toBe(1);
        const formatting = report.diagnostics
          .filter((diagnostic) => diagnostic.category === 'format')
          .map((diagnostic) => diagnostic.location?.path?.replaceAll('\\', '/'));
        expect(new Set(formatting)).toEqual(new Set(included));
        expect(report.diagnostics.every((diagnostic) => diagnostic.category !== 'parse')).toBe(
          true
        );
      }
      for (const path of included) {
        write(
          path,
          path.endsWith('.json') ? '{\n  "fixture": true\n}\n' : "export const fixture = 'good';\n"
        );
      }
      expect(check(['.']).result.status).toBe(0);
      const directExcluded = check(['--no-errors-on-unmatched', ...excluded]);
      expect(directExcluded.result.status).toBe(0);
      expect(directExcluded.report.diagnostics).toEqual([]);
      // Checking fixtures must not change the copied configuration or fixture bytes.
      expect(readFileSync(join(directory, 'biome.json'), 'utf8')).toBe(
        readFileSync(join(root, 'biome.json'), 'utf8')
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
