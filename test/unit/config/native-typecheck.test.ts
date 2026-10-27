import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');
const checker = resolve(root, 'node_modules/vite-plus/bin/vp');

function check(file: string) {
  const result = spawnSync(process.execPath, [checker, 'check', '--no-fmt', '--no-lint', file], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, output: result.stdout + result.stderr };
}

function probe(
  directory: string,
  validSource: string,
  invalidSource: string,
  expectedDiagnostic: RegExp,
  filePrefix = 'type-probe-'
) {
  const file = join(root, directory, filePrefix + randomUUID() + '.ts');
  try {
    writeFileSync(file, validSource);
    const positive = check(file);
    expect(positive.status, positive.output).toBe(0);
    expect(positive.output).toContain('Found no type errors');

    writeFileSync(file, invalidSource);
    const negative = check(file);
    expect(negative.status, negative.output).toBe(1);
    expect(negative.output).toMatch(expectedDiagnostic);
  } finally {
    rmSync(file, { force: true });
  }
}

describe('Vite+ native type-check discovery', () => {
  it.each(['src', 'validation/windows'])(
    'keeps floating-promise ownership checks in %s',
    (directory) => {
      const file = join(root, directory, 'type-probe-' + randomUUID() + '.ts');
      try {
        writeFileSync(file, 'void Promise.resolve(1);\n');
        const positive = spawnSync(process.execPath, [checker, 'lint', file], {
          cwd: root,
          encoding: 'utf8',
          timeout: 30_000,
        });
        expect(positive.status, positive.stdout + positive.stderr).toBe(0);

        writeFileSync(file, 'Promise.resolve(1);\n');
        const negative = spawnSync(process.execPath, [checker, 'lint', file], {
          cwd: root,
          encoding: 'utf8',
          timeout: 30_000,
        });
        expect(negative.status, negative.stdout + negative.stderr).toBe(1);
        expect(negative.stdout + negative.stderr).toContain('typescript(no-floating-promises)');
      } finally {
        rmSync(file, { force: true });
      }
    }
  );

  it('resolves linked core contracts in deep source', () => {
    const prefix = "import { isAbortError } from '@piesp/browser-core/error';\n";
    probe(
      'src/renderer/canvas',
      prefix + 'const result: boolean = isAbortError(new Error());\nvoid result;\n',
      prefix + 'const result: number = isAbortError(new Error());\nvoid result;\n',
      /typescript\(TS2322\):[^\n]*boolean[^\n]*number/
    );
  });

  it('checks the independent renderer Worker path', () => {
    const prefix = "import { WorkerRenderer } from './renderer';\n";
    probe(
      'src/renderer/worker',
      prefix + 'const renderer: WorkerRenderer = new WorkerRenderer();\nvoid renderer;\n',
      prefix + 'const renderer: number = new WorkerRenderer();\nvoid renderer;\n',
      /typescript\(TS2322\)/
    );
  });

  it('checks Vite configuration files', () => {
    const prefix = "import { defineConfig } from 'vite-plus';\n";
    probe(
      '.',
      prefix + 'const config = defineConfig({});\nvoid config;\n',
      prefix + 'const config: number = defineConfig({});\nvoid config;\n',
      /typescript\(TS2322\)/,
      'vite.config.type-probe-'
    );
  });

  it('checks extension globals in their browser project', () => {
    probe(
      'extension',
      'const supported: boolean | undefined = window.__ytExtensionBridge?.workerSupported;\nvoid supported;\n',
      'const supported: number = window.__ytExtensionBridge?.workerSupported;\nvoid supported;\n',
      /typescript\(TS2322\)/
    );
  });

  it('checks Node unit helpers', () => {
    const prefix =
      "import { Buffer } from 'node:buffer';\nimport { expect } from 'vite-plus/test';\n";
    probe(
      'test/unit/config',
      prefix + "expect(Buffer.from('ok').length).toBe(2);\n",
      prefix + "const count: number = 'wrong';\nvoid count;\n",
      /typescript\(TS2322\)/
    );
  });

  it('checks Browser Mode helpers with DOM globals', () => {
    probe(
      'test/browser/core',
      "const canvas: HTMLCanvasElement = document.createElement('canvas');\nvoid canvas;\n",
      "const canvas: number = document.createElement('canvas');\nvoid canvas;\n",
      /typescript\(TS2322\)/
    );
  });

  it('checks Playwright E2E files', () => {
    const prefix = "import { test } from '@playwright/test';\nvoid test;\n";
    probe(
      'test/e2e/specs',
      prefix + 'const count: number = 1;\nvoid count;\n',
      prefix + "const count: number = 'wrong';\nvoid count;\n",
      /typescript\(TS2322\)/
    );
  });

  it.each(['scripts', '.github/actions'])(
    'admits Node globals and rejects browser globals in %s',
    (directory) => {
      const valid = [
        "import { readFileSync } from 'node:fs';",
        'const bytes: Buffer = Buffer.from(readFileSync(process.execPath));',
        'const controller = new AbortController();',
        'void bytes;',
        'void controller;',
      ].join('\n');
      probe(
        directory,
        valid,
        valid + "\ndocument.title;\nwindow.alert('unexpected');\n",
        /typescript\([^)]*\):[^\n]*document/
      );
    }
  );

  it('checks Windows Node helpers with DOM types and Node imports', () => {
    const prefix = "import { Buffer } from 'node:buffer';\n";
    probe(
      'validation/windows',
      prefix + 'const title: string = document.title;\nvoid Buffer;\nvoid title;\n',
      prefix + 'const title: number = document.title;\nvoid Buffer;\nvoid title;\n',
      /typescript\(TS2322\)/
    );
  });

  it('preserves NodeNext, erasable syntax, exact optional, and indexed access', () => {
    const name = randomUUID();
    const file = join(root, 'scripts', 'type-probe-' + name + '.ts');
    const helper = join(root, 'scripts', 'type-probe-helper-' + name + '.ts');
    try {
      writeFileSync(helper, 'export const count = 1;\n');
      writeFileSync(
        file,
        "import { count } from './type-probe-helper-" + name + ".ts';\nvoid count;\n"
      );
      const positive = check(file);
      expect(positive.status, positive.output).toBe(0);
      writeFileSync(
        file,
        [
          "import { count } from './type-probe-helper-" + name + "';",
          'enum ToolMode { Ready }',
          'const optional: { enabled?: boolean } = { enabled: undefined };',
          'const first: number = [1][0];',
          'void ToolMode;',
          'void optional;',
          'void first;',
        ].join('\n')
      );
      const negative = check(file);
      expect(negative.status, negative.output).toBe(1);
      expect(negative.output).toContain('TS2835');
      expect(negative.output).toContain('erasableSyntaxOnly');
      expect(negative.output).toContain('exactOptionalPropertyTypes');
      expect(negative.output).toContain(
        "Type 'number | undefined' is not assignable to type 'number'"
      );
    } finally {
      rmSync(file, { force: true });
      rmSync(helper, { force: true });
    }
  });
});
