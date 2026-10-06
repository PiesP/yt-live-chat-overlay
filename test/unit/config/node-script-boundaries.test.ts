import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const nodeBinary = process.env.NODE_SCRIPT_TEST_BINARY ?? process.execPath;
const fixtureRoots: string[] = [];
const nodeScripts = [
  'scripts/build/clean.ts',
  'scripts/check/artifacts.ts',
  'scripts/check/i18n.ts',
  'scripts/release/prepare.ts',
  'scripts/release/version.ts',
] as const;

function fixtureRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'yt-node-boundaries with spaces '));
  fixtureRoots.push(directory);
  return directory;
}

function runCli(
  script: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): ReturnType<typeof spawnSync> {
  return spawnSync(nodeBinary, ['--experimental-strip-types', script, ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const directory of fixtureRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Node script boundaries', () => {
  it('type-checks all direct Node scripts separately from the browser program', () => {
    const scriptsConfig = JSON.parse(readFileSync(join(root, 'tsconfig.scripts.json'), 'utf8')) as {
      compilerOptions: { module: string; erasableSyntaxOnly: boolean; lib: string[] };
      include: string[];
    };
    const browserConfig = readFileSync(join(root, 'tsconfig.json'), 'utf8');

    expect(scriptsConfig.compilerOptions.module).toBe('NodeNext');
    expect(scriptsConfig.compilerOptions.erasableSyntaxOnly).toBe(true);
    expect(scriptsConfig.compilerOptions.lib).toEqual(['ES2022']);
    expect(scriptsConfig.include).toContain('scripts/**/*.ts');
    expect(scriptsConfig.include).toContain('test/unit/config/fixtures/devtools-endpoint.ts');
    expect(browserConfig.match(/"include":\s*\[([^\]]*)\]/)?.[1]).not.toContain('"scripts/**/*.ts"');
    expect(browserConfig.match(/"exclude":\s*\[([^\]]*)\]/)?.[1]).toContain('"scripts/**/*.ts"');
  });

  it.each(nodeScripts)('imports %s without CLI work, output, or writes', (relativePath) => {
    const directory = fixtureRoot();
    const sentinel = join(directory, 'dist', 'sentinel');
    const commandMarker = join(directory, 'command-ran');
    const fakeBin = join(directory, 'fake-bin');
    mkdirSync(join(directory, 'dist'));
    mkdirSync(fakeBin);
    writeFileSync(sentinel, 'keep');
    for (const command of ['git', 'zip']) {
      writeFileSync(
        join(fakeBin, command),
        `#!/bin/sh\nprintf invoked > ${JSON.stringify(commandMarker)}\n`,
        { mode: 0o755 }
      );
    }
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version: string;
    };
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      RELEASE_VERSION: packageJson.version,
      BUILD_VERSION: 'invalid',
    };
    delete env.RELEASE_SHA;
    const moduleUrl = pathToFileURL(join(root, relativePath)).href;
    const releaseBundleExists = existsSync(join(root, 'release-bundle'));
    const result = spawnSync(
      nodeBinary,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(moduleUrl)});`,
        join(directory, 'invalid-argv-path'),
      ],
      {
        cwd: directory,
        env,
        encoding: 'utf8',
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(readFileSync(sentinel, 'utf8')).toBe('keep');
    expect(existsSync(commandMarker)).toBe(false);
    expect(existsSync(join(root, 'release-bundle'))).toBe(releaseBundleExists);
  });

  it('runs clean from the caller directory and leaves neighboring files alone', () => {
    const directory = fixtureRoot();
    for (const name of ['dist', 'dist-extension', 'dist-extension-firefox']) {
      mkdirSync(join(directory, name));
      writeFileSync(join(directory, name, 'sentinel'), 'delete');
    }
    writeFileSync(join(directory, 'keep'), 'keep');

    const result = runCli(join(root, 'scripts/build/clean.ts'), [], directory);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    for (const name of ['dist', 'dist-extension', 'dist-extension-firefox']) {
      expect(existsSync(join(directory, name))).toBe(false);
    }
    expect(readFileSync(join(directory, 'keep'), 'utf8')).toBe('keep');
  });

  it('retains version CLI defaults, diagnostics, and sync behavior in a fixture', () => {
    const directory = fixtureRoot();
    mkdirSync(join(directory, 'scripts/release'), { recursive: true });
    mkdirSync(join(directory, 'extension'));
    copyFileSync(join(root, 'scripts/release/version.ts'), join(directory, 'scripts/release/version.ts'));
    writeFileSync(join(directory, 'package.json'), '{"version":"1.2.3"}\n');
    writeFileSync(join(directory, 'extension/manifest.json'), '{"version":"1.2.2"}\n');
    writeFileSync(join(directory, 'extension/manifest.firefox.json'), '{"version":"1.2.3"}\n');
    const script = join(directory, 'scripts/release/version.ts');
    const env = { ...process.env, BUILD_VERSION: '1.2.3' };

    const defaultCheck = runCli(script, [], directory, env);
    expect(defaultCheck.status).not.toBe(0);
    expect(defaultCheck.stderr).toContain('Version mismatch detected. Run: pnpm sync:versions');
    const sync = runCli(script, ['sync'], directory, env);
    expect(sync.status).toBe(0);
    expect(JSON.parse(readFileSync(join(directory, 'extension/manifest.json'), 'utf8'))).toMatchObject({
      version: '1.2.3',
    });
    const check = runCli(script, ['check'], directory, env);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('All versions match: 1.2.3');
    const overridden = runCli(script, ['check'], directory, { ...env, BUILD_VERSION: '1.2.4' });
    expect(overridden.status).not.toBe(0);
    expect(overridden.stderr).toContain('expected 1.2.4, found 1.2.3');
    const invalid = runCli(script, ['unknown'], directory, env);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain('Unknown version command: unknown');
  });

  it('retains direct i18n and missing-artifact diagnostics without making an artifact', () => {
    const i18n = runCli(join(root, 'scripts/check/i18n.ts'), [], root);
    expect(i18n.status).toBe(0);
    expect(i18n.stdout).toContain('All 6 locales match');

    const directory = fixtureRoot();
    mkdirSync(join(directory, 'scripts/check'), { recursive: true });
    copyFileSync(join(root, 'scripts/check/artifacts.ts'), join(directory, 'scripts/check/artifacts.ts'));
    const artifacts = runCli(join(directory, 'scripts/check/artifacts.ts'), ['--e2e'], directory);
    expect(artifacts.status).not.toBe(0);
    expect(artifacts.stderr).toContain('Missing artifact:');
    expect(existsSync(join(directory, 'dist'))).toBe(false);
  });

  it('rejects an invalid direct release request before creating a bundle', () => {
    const directory = fixtureRoot();
    mkdirSync(join(directory, 'scripts/release'), { recursive: true });
    copyFileSync(join(root, 'scripts/release/prepare.ts'), join(directory, 'scripts/release/prepare.ts'));
    const result = runCli(join(directory, 'scripts/release/prepare.ts'), [], directory, {
      ...process.env,
      RELEASE_VERSION: 'invalid',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('RELEASE_VERSION must be a semantic version in X.Y.Z form');
    expect(existsSync(join(directory, 'release-bundle'))).toBe(false);
  });
});
