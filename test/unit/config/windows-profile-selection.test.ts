// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { expect, it } from 'vite-plus/test';

const profile = JSON.parse(
  readFileSync(join(process.cwd(), 'validation/windows/profile.json'), 'utf8')
) as {
  entry?: string;
  assets?: string[];
  installation?: { entry?: string; assets?: string[]; build_commands?: string[][] };
};

function expectBundledImportClosure(entry: string, assets: string[]): void {
  const root = process.cwd();
  const pending = [entry];
  const inspected = new Set<string>();
  while (pending.length > 0) {
    const source = pending.pop();
    if (!source || inspected.has(source)) continue;
    inspected.add(source);
    const code = readFileSync(join(root, source), 'utf8');
    for (const match of code.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+\.ts)['"]/gu)) {
      const specifier = match[1];
      assert(specifier);
      const dependency = relative(root, resolve(root, dirname(source), specifier)).replaceAll(
        '\\',
        '/'
      );
      expect(
        dependency === entry ||
          assets.some((asset) => dependency === asset || dependency.startsWith(`${asset}/`)),
        `${source} imports ${dependency} outside its bundle`
      ).toBe(true);
      pending.push(dependency);
    }
  }
}

it('selects both native TypeScript entrypoints and their installation helper graph', () => {
  expect(profile.entry).toBe('validation/windows/profile.ts');
  expect(profile.installation?.entry).toBe('validation/windows/install-profile.ts');
  expect(profile.installation?.build_commands).toEqual([
    ['vp', 'run', 'build:ci'],
    ['vp', 'run', 'build:extension:ci'],
    ['vp', 'run', 'build:extension:firefox:ci'],
  ]);
  for (const helper of [
    'validation/windows/chrome-install.ts',
    'validation/windows/natural-chrome.ts',
    'validation/windows/profile.ts',
    'validation/windows/firefox-install.ts',
    'validation/windows/native-ad-skip.ts',
    'validation/windows/live-duration.ts',
  ]) {
    expect(profile.installation?.assets).toContain(helper);
  }
  assert(profile.entry && profile.installation?.entry && profile.installation.assets);
  assert(profile.assets);
  expectBundledImportClosure(profile.entry, profile.assets);
  // The packager includes base-profile assets in installation bundles too.
  expectBundledImportClosure(profile.installation.entry, [
    ...profile.assets,
    ...profile.installation.assets,
  ]);
});

it('loads the declared canonical settings asset from an isolated installation bundle', () => {
  const asset = 'src/settings/limits.ts';
  expect(profile.installation?.assets).toContain(asset);
  const bundle = mkdtempSync(join(tmpdir(), 'yt-matrix-install-'));
  try {
    mkdirSync(join(bundle, dirname(asset)), { recursive: true });
    copyFileSync(join(process.cwd(), asset), join(bundle, asset));
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `import { resolveLimits } from './${asset}'; process.stdout.write(String(resolveLimits('superChatMaxBodyLines').min));`,
      ],
      { cwd: bundle, encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(Number(result.stdout)).toBe(2);
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
});
