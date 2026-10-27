import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  it('keeps native lint failures and explicit compiler projects', () => {
    const result = spawnSync(resolve(root, 'node_modules/.bin/vp'), ['lint', '--print-config'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const config = JSON.parse(result.stdout) as {
      plugins: string[];
      rules: Record<string, unknown>;
      ignorePatterns: string[];
    };
    for (const plugin of ['unicorn', 'typescript', 'oxc', 'import']) {
      expect(config.plugins).toContain(plugin);
    }
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
      'import/no-cycle',
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
