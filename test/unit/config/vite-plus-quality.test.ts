import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');
const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts as Record<
  string,
  string
>;

// Vite+ owns both tool configurations; exercise its effective linter config rather than a copied fixture.
describe('Vite+ quality coverage', () => {
  it('keeps warning failures, mapped Biome rules, and explicit compiler projects', () => {
    const result = spawnSync(resolve(root, 'node_modules/.bin/vp'), ['lint', '--print-config'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const config = JSON.parse(result.stdout) as {
      rules: Record<string, unknown>;
      ignorePatterns: string[];
    };
    for (const rule of [
      'no-unused-vars',
      'typescript/no-non-null-assertion',
      'prefer-const',
      'no-param-reassign',
      'typescript/consistent-type-imports',
      'typescript/no-explicit-any',
      'no-unneeded-ternary',
      'unicorn/no-useless-switch-case',
      'typescript/no-useless-empty-export',
      'no-lone-blocks',
      'oxc/no-accumulating-spread',
    ]) {
      expect(config.rules[rule], rule).not.toBe('off');
    }
    expect(scripts.lint).toContain('vp lint --deny-warnings');
    const directory = mkdtempSync(join(tmpdir(), 'yt-vp-warning-'));
    try {
      const file = join(directory, 'warning.ts');
      const source = 'export function bump(value: number) {\n  value += 1;\n  return value;\n}\n';
      writeFileSync(file, source);
      const warning = spawnSync(
        resolve(root, 'node_modules/.bin/vp'),
        ['lint', '--deny-warnings', file],
        { cwd: root, encoding: 'utf8' }
      );
      expect(warning.status, warning.stdout + warning.stderr).toBe(1);
      expect(warning.stdout + warning.stderr).toContain('no-param-reassign');
      expect(readFileSync(file, 'utf8')).toBe(source);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(scripts.quality).toMatch(/^vp check /);
    for (const name of ['check', 'check:extension', 'check:test', 'check:e2e', 'check:scripts']) {
      expect(scripts.quality).toContain(`pnpm -s ${name}`);
    }
  });

  it('runs only the two residual Biome rules over first-party sources', () => {
    const directory = mkdtempSync(join(tmpdir(), 'yt-residual-rules-'));
    try {
      copyFileSync(join(root, 'biome-residual.json'), join(directory, 'biome-residual.json'));
      mkdirSync(join(directory, 'scripts'));
      mkdirSync(join(directory, 'packages/core/src'), { recursive: true });
      const template = join(directory, 'scripts/template.ts');
      const evolvingAny = join(directory, 'scripts/evolving-any.ts');
      const ordinary = join(directory, 'scripts/parameter.ts');
      writeFileSync(template, 'export const value = `unchanged`;\n');
      writeFileSync(evolvingAny, 'let value;\nvalue = 1;\nvoid value;\n');
      writeFileSync(
        ordinary,
        'export function bump(value: number) { value += 1; return value; }\n'
      );
      writeFileSync(join(directory, 'packages/core/src/excluded.ts'), '{{ malformed fixture');
      const run = () =>
        spawnSync(
          resolve(root, 'node_modules/.bin/biome'),
          ['lint', '--config-path=biome-residual.json', '--error-on-warnings', '.'],
          { cwd: directory, encoding: 'utf8' }
        );
      const rejected = run();
      expect(rejected.status, rejected.stdout + rejected.stderr).toBe(1);
      expect(rejected.stdout + rejected.stderr).toContain('noUnusedTemplateLiteral');
      expect(rejected.stdout + rejected.stderr).toContain('noImplicitAnyLet');
      expect(rejected.stdout + rejected.stderr).not.toContain('noParameterAssign');
      writeFileSync(template, "export const value = 'unchanged';\n");
      const stillRejected = run();
      expect(stillRejected.status, stillRejected.stdout + stillRejected.stderr).toBe(1);
      expect(stillRejected.stdout + stillRejected.stderr).toContain('noImplicitAnyLet');
      expect(stillRejected.stdout + stillRejected.stderr).not.toContain('noUnusedTemplateLiteral');
      writeFileSync(evolvingAny, 'let value: number;\nvalue = 1;\nvoid value;\n');
      const accepted = run();
      expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
      expect(readFileSync(ordinary, 'utf8')).toContain('value += 1');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(scripts['lint:residual']).toBe(
      'biome lint --config-path=biome-residual.json --error-on-warnings .'
    );
    expect(scripts.quality).toContain('pnpm -s lint:residual');
  });

  it('applies both residual rules to Windows and Action TypeScript while retaining legacy and excluded paths', () => {
    const directory = mkdtempSync(join(tmpdir(), 'yt-residual-paths-'));
    try {
      copyFileSync(join(root, 'biome-residual.json'), join(directory, 'biome-residual.json'));
      for (const excluded of [
        'packages/core/src/excluded.ts',
        'validation/windows/dist-generated/excluded.ts',
        'validation/windows/vendor/excluded.ts',
      ]) {
        const file = join(directory, excluded);
        mkdirSync(resolve(file, '..'), { recursive: true });
        writeFileSync(file, 'export const value = `excluded`;\n');
      }
      const run = () =>
        spawnSync(
          resolve(root, 'node_modules/.bin/biome'),
          ['lint', '--config-path=biome-residual.json', '--error-on-warnings', '.'],
          { cwd: directory, encoding: 'utf8' }
        );
      for (const path of [
        'validation/windows/residual-fixture.ts',
        'validation/windows/release-upgrade/residual-fixture.ts',
        '.github/actions/validate-semgrep-sarif/residual-fixture.ts',
        'validation/windows/legacy-fixture.mjs',
        '.github/actions/prepare-semgrep/legacy-fixture.mjs',
      ]) {
        const file = join(directory, path);
        mkdirSync(resolve(file, '..'), { recursive: true });
        const cases = [
          [
            'noUnusedTemplateLiteral',
            'export const value = `unchanged`;\n',
            "export const value = 'unchanged';\n",
          ],
          [
            'noImplicitAnyLet',
            'let value;\nvalue = 1;\nvoid value;\n',
            'let value = 1;\nvoid value;\n',
          ],
        ] as const;
        for (const [rule, negative, corrected] of path.endsWith('.ts')
          ? cases
          : cases.slice(0, 1)) {
          writeFileSync(file, negative);
          const rejected = run();
          const diagnostic = rejected.stdout + rejected.stderr;
          expect(rejected.status, `${path} ${rule}: ${diagnostic}`).toBe(1);
          expect(diagnostic, path).toContain(path);
          expect(diagnostic, path).toContain(rule);
          writeFileSync(file, corrected);
          const accepted = run();
          expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps first-party format boundaries and generated/dependency exclusions', () => {
    const scope = [
      'src',
      'scripts',
      'extension',
      'test',
      'tooling',
      'validation/windows',
      '.github/actions',
      "'*.ts'",
      "'*.json'",
    ];
    for (const command of ['fmt', 'lint', 'quality']) {
      for (const path of scope) expect(scripts[command]).toContain(path);
    }
    const viteConfig = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');
    expect(viteConfig).toContain('maxWarnings: 0');
    expect(viteConfig).toContain('typeCheck: false');
    for (const excluded of [
      'packages/core/**',
      '**/dist*/**',
      '**/coverage/**',
      '**/reports/**',
      '**/browser-profiles/**',
      'test/**/*.html',
    ]) {
      expect(viteConfig).toContain(excluded);
    }
  });
});
