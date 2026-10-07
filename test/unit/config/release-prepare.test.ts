// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { execFileSync, spawnSync } from 'node:child_process';
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
import { afterEach, describe, expect, it } from 'vitest';

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
  writeFileSync(join(fixtureRoot, 'package.json'), '{"version":"1.2.3"}\n');
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
  execFileSync('git', ['init', '--quiet'], { cwd: fixtureRoot });
  execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: fixtureRoot });
  execFileSync('git', ['config', 'user.email', 'release-test@example.invalid'], {
    cwd: fixtureRoot,
  });
  execFileSync('git', ['add', '.'], { cwd: fixtureRoot });
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
    expect(metadata).toMatchObject({ commit: sourceCommit, version: '1.2.3' });
    expect(readFileSync(join(releaseDirectory, 'checksums.txt'), 'utf8').trim().split('\n')).toHaveLength(4);
    const notes = readFileSync(join(releaseDirectory, 'RELEASE_NOTES.md'), 'utf8');
    expect(notes).toContain(sourceCommit);
    expect(notes).toContain('/releases/download/v1.2.3/yt-live-chat-overlay.user.js');
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

  it.each([undefined, '0.0.0'])('records the executing Node.js runtime when NODE_VERSION is %s', (advertised) => {
    const fixtureRoot = createReleaseFixture();
    const result = runPrepare(fixtureRoot, { NODE_VERSION: advertised });
    expect(result.status).toBe(0);
    const releaseDirectory = join(fixtureRoot, 'release-bundle', 'release');
    const metadata = JSON.parse(readFileSync(join(releaseDirectory, 'metadata.json'), 'utf8')) as {
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
  });

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
