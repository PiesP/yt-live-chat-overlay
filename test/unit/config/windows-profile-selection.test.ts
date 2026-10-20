// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { expect, it } from 'vite-plus/test';

const profile = JSON.parse(
  readFileSync(join(process.cwd(), 'validation/windows/profile.json'), 'utf8')
) as {
  entry?: string;
  installation?: { entry?: string; assets?: string[] };
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
  expectBundledImportClosure(profile.entry, []);
  expectBundledImportClosure(profile.installation.entry, profile.installation.assets);
});
