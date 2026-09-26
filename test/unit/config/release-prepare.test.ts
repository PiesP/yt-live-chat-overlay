// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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

function runPrepare(fixtureRoot: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(fixtureRoot, 'scripts', 'release', 'prepare.ts')],
    {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: { ...process.env, RELEASE_VERSION: '1.2.3' },
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

    const result = runPrepare(fixtureRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Prepared release-bundle/ for v1.2.3');
    expect(existsSync(join(fixtureRoot, 'release-bundle', 'release', 'metadata.json'))).toBe(true);
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
