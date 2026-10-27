import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');
const vp = resolve(root, 'node_modules/.bin/vp');

function lintSource() {
  return spawnSync(vp, ['lint', '--deny-warnings', 'src'], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('Vite+ source cycle policy', () => {
  it('rejects static, alias, re-export, and type-only cycles across independent source roots', () => {
    const id = randomUUID().replaceAll('-', '');
    const rootA = join(root, `src/cycle-lint-${id}-a.ts`);
    const rootB = join(root, `src/cycle-lint-${id}-b.ts`);
    const alias = mkdtempSync(join(root, 'src/app/cycle-lint-'));
    const deep = mkdtempSync(join(root, 'src/settings/ui/cycle-lint-'));
    const worker = mkdtempSync(join(root, 'src/renderer/worker/cycle-lint-'));
    const fixtures = [rootA, join(alias, 'a.ts'), join(deep, 'a.ts'), join(worker, 'a.ts')];
    try {
      writeFileSync(
        rootA,
        `import { b } from './${basename(rootB, '.ts')}'; export const a = b;\n`
      );
      writeFileSync(
        rootB,
        `import { a } from './${basename(rootA, '.ts')}'; export const b = a;\n`
      );
      writeFileSync(
        join(alias, 'a.ts'),
        `import { b } from '@app/${basename(alias)}/b'; export const a = b;\n`
      );
      writeFileSync(join(alias, 'b.ts'), "import { a } from './a'; export const b = a;\n");
      writeFileSync(join(deep, 'a.ts'), "export { b } from './b';\n");
      writeFileSync(join(deep, 'b.ts'), "export { a } from './a';\n");
      writeFileSync(
        join(worker, 'a.ts'),
        "import type { B } from './b'; export type A = { b: B };\n"
      );
      writeFileSync(
        join(worker, 'b.ts'),
        "import type { A } from './a'; export type B = { a: A };\n"
      );

      const rejected = lintSource();
      const diagnostics = rejected.stdout + rejected.stderr;
      expect(rejected.status, diagnostics).toBe(1);
      for (const file of fixtures) {
        const diagnostic = diagnostics
          .split('\n')
          .find((line) => line.includes(relative(root, file)));
        expect(diagnostic, file).toContain('import(no-cycle)');
      }

      writeFileSync(rootB, 'export const b = 1;\n');
      writeFileSync(join(alias, 'b.ts'), 'export const b = 1;\n');
      writeFileSync(join(deep, 'b.ts'), 'export const b = 1;\n');
      writeFileSync(join(worker, 'b.ts'), 'export type B = { value: number };\n');
      const accepted = lintSource();
      expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
    } finally {
      rmSync(rootA, { force: true });
      rmSync(rootB, { force: true });
      rmSync(alias, { recursive: true, force: true });
      rmSync(deep, { recursive: true, force: true });
      rmSync(worker, { recursive: true, force: true });
    }
  });
});
