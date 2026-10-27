// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');
const temporaryRoots: string[] = [];

function createReleaseFixture(): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'yt-overlay-release-'));
  temporaryRoots.push(fixtureRoot);
  mkdirSync(join(fixtureRoot, 'scripts', 'release'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'dist'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'dist-extension'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'dist-extension-firefox'), { recursive: true });
  copyFileSync(
    join(root, 'scripts', 'release', 'prepare.ts'),
    join(fixtureRoot, 'scripts', 'release', 'prepare.ts')
  );
  copyFileSync(
    join(root, 'scripts', 'release', 'footprint.ts'),
    join(fixtureRoot, 'scripts', 'release', 'footprint.ts')
  );
  writeFileSync(
    join(fixtureRoot, 'package.json'),
    '{"version":"1.2.3","packageManager":"pnpm@12.15.0"}\n'
  );
  writeFileSync(join(fixtureRoot, '.node-version'), '26.12.1\n');
  writeFileSync(join(fixtureRoot, '.gitignore'), 'test-results/\nrelease-bundle/\n');
  writeFileSync(join(fixtureRoot, 'pnpm-lock.yaml'), 'lockfileVersion: test\n');
  writeFileSync(join(fixtureRoot, 'pnpm-workspace.yaml'), 'runtimeOnFail: ignore\n');
  mkdirSync(join(fixtureRoot, 'tooling', 'vite'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'tooling', 'vite', 'config.ts'), 'export {};\n');
  for (const name of [
    'vite.config.ts',
    'vite.config.extension.ts',
    'vite.config.extension.cs.ts',
    'vite.config.extension.page.ts',
    'vite.config.extension.firefox.ts',
    'vite.config.extension.cs.firefox.ts',
    'vite.config.extension.page.firefox.ts',
  ])
    writeFileSync(join(fixtureRoot, name), 'export {};\n');
  mkdirSync(join(fixtureRoot, 'node_modules', 'vite'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'node_modules', 'vite', 'package.json'), '{"version":"1.2.3"}\n');
  mkdirSync(join(fixtureRoot, 'node_modules', 'vite-plus'), { recursive: true });
  writeFileSync(
    join(fixtureRoot, 'node_modules', 'vite-plus', 'package.json'),
    '{"version":"1.2.3"}\n'
  );
  writeFileSync(
    join(fixtureRoot, 'CHANGELOG.md'),
    '# Changelog\n\n## [1.2.3] - 2026-09-26\n\n- Test release.\n'
  );
  writeFileSync(
    join(fixtureRoot, 'dist', 'yt-live-chat-overlay.user.js'),
    '// ==UserScript==\n// @version 1.2.3\n// ==/UserScript==\n'
  );
  writeFileSync(
    join(fixtureRoot, 'dist', 'yt-live-chat-overlay.meta.js'),
    '// ==UserScript==\n// @version 1.2.3\n// ==/UserScript==\n'
  );
  writeFileSync(join(fixtureRoot, 'dist-extension', 'manifest.json'), '{"version":"1.2.3"}\n');
  writeFileSync(
    join(fixtureRoot, 'dist-extension-firefox', 'manifest.json'),
    '{"version":"1.2.3"}\n'
  );
  for (const target of ['dist-extension', 'dist-extension-firefox']) {
    mkdirSync(join(fixtureRoot, target, 'workers'), { recursive: true });
    writeFileSync(join(fixtureRoot, target, 'workers', 'renderer.js'), 'worker();\n');
  }
  execFileSync('git', ['init', '--quiet'], { cwd: fixtureRoot });
  execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: fixtureRoot });
  execFileSync('git', ['config', 'user.email', 'release-test@example.invalid'], {
    cwd: fixtureRoot,
  });
  execFileSync('git', ['add', '.'], { cwd: fixtureRoot });
  execFileSync(
    'git',
    [
      'update-index',
      '--add',
      '--cacheinfo',
      '160000,3a8868b348fce1ccb32c1a6e9ac4c00001372469,packages/core',
    ],
    { cwd: fixtureRoot }
  );
  execFileSync('git', ['commit', '--quiet', '-m', 'test fixture'], { cwd: fixtureRoot });
  return fixtureRoot;
}

function runPrepare(
  fixtureRoot: string,
  overrides: NodeJS.ProcessEnv = {}
): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = { ...process.env, RELEASE_VERSION: '1.2.3', ...overrides };
  if (!('RELEASE_SHA' in overrides)) delete env.RELEASE_SHA;
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(fixtureRoot, 'scripts', 'release', 'prepare.ts')],
    {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env,
    }
  );
}

function runFootprintRecorder(
  fixtureRoot: string,
  changeConfig = false
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(join(fixtureRoot, 'scripts', 'release', 'footprint.ts'))}).then(({captureBuildIdentity,recordFootprint}) => {const identity=captureBuildIdentity();${changeConfig ? "import('node:fs').then(({appendFileSync})=>{appendFileSync('vite.config.ts','changed\\n');recordFootprint(identity,524288)})" : 'recordFootprint(identity,524288)'}})`,
    ],
    { cwd: fixtureRoot, encoding: 'utf8' }
  );
}

function recordFixtureFootprint(fixtureRoot: string): void {
  const result = runFootprintRecorder(fixtureRoot);
  expect(result.status, String(result.stderr)).toBe(0);
}

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

describe('release preparation artifact versions', () => {
  it('packages artifacts whose embedded versions match the release', () => {
    const fixtureRoot = createReleaseFixture();
    execFileSync('git', ['-c', 'tag.gpgSign=false', 'tag', 'v1.2.2'], { cwd: fixtureRoot });

    const result = runPrepare(fixtureRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Prepared release-bundle/ for v1.2.3');
    const releaseDirectory = join(fixtureRoot, 'release-bundle', 'release');
    const metadata = JSON.parse(readFileSync(join(releaseDirectory, 'metadata.json'), 'utf8')) as {
      commit: string;
      version: string;
    };
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    }).trim();
    expect(metadata).toMatchObject({
      commit: sourceCommit,
      version: '1.2.3',
      footprint: { status: 'unavailable' },
    });
    expect(
      readFileSync(join(releaseDirectory, 'checksums.txt'), 'utf8').trim().split('\n')
    ).toHaveLength(4);
    const notes = readFileSync(join(releaseDirectory, 'RELEASE_NOTES.md'), 'utf8');
    expect(notes).toContain(sourceCommit);
    expect(notes).toContain('/releases/download/v1.2.3/yt-live-chat-overlay.user.js');
    expect(notes).toContain('versioned `@downloadURL`');
    expect(notes).toContain('Check for updates');
    expect(notes).toContain('/compare/v1.2.2...v1.2.3');
    expect(notes).toContain('does not update automatically');
    expect(notes).toContain('removed when Firefox restarts');
  });

  it('rejects a source SHA mismatch before writing a release bundle', () => {
    const fixtureRoot = createReleaseFixture();
    const result = runPrepare(fixtureRoot, { RELEASE_SHA: '0'.repeat(40) });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match checked out commit');
    expect(existsSync(join(fixtureRoot, 'release-bundle'))).toBe(false);
  });

  it('requires a producing-build footprint when an exact release SHA is supplied', () => {
    const fixtureRoot = createReleaseFixture();
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    }).trim();
    const result = runPrepare(fixtureRoot, { RELEASE_SHA: sourceCommit });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Missing producing-build distribution footprint receipt');
    expect(existsSync(join(fixtureRoot, 'release-bundle'))).toBe(false);
  });

  it('retains file, unpacked and archive measurements from the producing receipt', () => {
    const fixtureRoot = createReleaseFixture();
    recordFixtureFootprint(fixtureRoot);
    const result = runPrepare(fixtureRoot);
    expect(result.status, String(result.stderr)).toBe(0);
    const releaseDirectory = join(fixtureRoot, 'release-bundle', 'release');
    const metadata = JSON.parse(readFileSync(join(releaseDirectory, 'metadata.json'), 'utf8')) as {
      footprint: {
        files: Array<{ path: string; bytes: number; sha256: string }>;
        targets: Array<{ name: string; unpackedBytes: number }>;
        archives: Array<{ name: string; bytes: number; sha256: string }>;
      };
    };
    expect(metadata.footprint.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'dist/yt-live-chat-overlay.user.js',
          bytes: readFileSync(join(fixtureRoot, 'dist/yt-live-chat-overlay.user.js')).length,
        }),
        expect.objectContaining({
          path: 'dist/yt-live-chat-overlay.meta.js',
          bytes: readFileSync(join(fixtureRoot, 'dist/yt-live-chat-overlay.meta.js')).length,
        }),
      ])
    );
    for (const target of metadata.footprint.targets) {
      expect(target.unpackedBytes).toBe(
        metadata.footprint.files
          .filter((file) => file.path.startsWith(`${target.name}/`))
          .reduce((total, file) => total + file.bytes, 0)
      );
    }
    for (const archive of metadata.footprint.archives) {
      const bytes = readFileSync(join(releaseDirectory, archive.name));
      expect(archive.bytes).toBe(bytes.length);
      expect(archive.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('rejects a changed output after its producing receipt was recorded', () => {
    const fixtureRoot = createReleaseFixture();
    recordFixtureFootprint(fixtureRoot);
    writeFileSync(
      join(fixtureRoot, 'dist-extension', 'manifest.json'),
      '{"version":"1.2.3", "changed":true}\n'
    );
    const result = runPrepare(fixtureRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match current source, inputs or files');
    expect(existsSync(join(fixtureRoot, 'release-bundle'))).toBe(false);
  });

  it('does not record a receipt when build configuration changes during production', () => {
    const fixtureRoot = createReleaseFixture();
    const result = runFootprintRecorder(fixtureRoot, true);
    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toContain(
      'Build inputs changed while producing distribution artifacts'
    );
    expect(existsSync(join(fixtureRoot, 'test-results', 'distribution-footprint.json'))).toBe(
      false
    );
  });

  it.each([undefined, '0.0.0'])(
    'records the executing Node.js runtime when NODE_VERSION is %s',
    (advertised) => {
      const fixtureRoot = createReleaseFixture();
      const result = runPrepare(fixtureRoot, { NODE_VERSION: advertised });
      expect(result.status).toBe(0);
      const releaseDirectory = join(fixtureRoot, 'release-bundle', 'release');
      const metadata = JSON.parse(
        readFileSync(join(releaseDirectory, 'metadata.json'), 'utf8')
      ) as {
        node_version: string;
        commit: string;
        version: string;
        runner_os: string;
      };
      expect(metadata.node_version).toBe(process.versions.node);
      expect(metadata.version).toBe('1.2.3');
      expect(metadata.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(metadata.runner_os).toBeTruthy();
      expect(readFileSync(join(releaseDirectory, 'RELEASE_NOTES.md'), 'utf8')).toContain(
        `- **Node.js**: \`${process.versions.node}\``
      );
    }
  );

  it.each([
    ['dist/yt-live-chat-overlay.user.js', 'userscript'],
    ['dist/yt-live-chat-overlay.meta.js', 'userscript metadata'],
    ['dist-extension/manifest.json', 'Chrome extension'],
    ['dist-extension-firefox/manifest.json', 'Firefox extension'],
  ])('rejects a stale %s artifact', (relativePath, artifactName) => {
    const fixtureRoot = createReleaseFixture();
    const artifactPath = join(fixtureRoot, relativePath);
    const staleArtifact = relativePath.endsWith('manifest.json')
      ? '{"version":"1.2.2"}\n'
      : '// ==UserScript==\n// @version 1.2.2\n// ==/UserScript==\n';
    writeFileSync(artifactPath, staleArtifact);

    const result = runPrepare(fixtureRoot);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `${artifactName} version 1.2.2 does not match release version 1.2.3.`
    );
  });
});
