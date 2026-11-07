import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runNaturalChromeQualification } from './chrome-install.ts';
import { readNaturalChromeQualification, run } from './install-profile.ts';
import type { launchOwnedNaturalChrome } from './natural-chrome.ts';

test('qualification selector is optional, exact and exclusive with other inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-qualification-'));
  const inputs = join(root, 'validation/windows/inputs');
  try {
    assert.equal(await readNaturalChromeQualification(root), null);
    await mkdir(inputs, { recursive: true });
    const selector = join(inputs, 'natural-chrome-qualification.json');
    await writeFile(join(inputs, '.gitignore'), '');
    for (const mode of ['launcher', 'native-tab']) {
      await writeFile(selector, JSON.stringify({ naturalChromeQualification: mode }));
      assert.equal(await readNaturalChromeQualification(root), mode);
    }
    for (const value of [
      { naturalChromeQualification: 'other' },
      { naturalChromeQualification: 'launcher', extra: true },
      null,
    ]) {
      await writeFile(selector, JSON.stringify(value));
      await assert.rejects(readNaturalChromeQualification(root));
    }
    await writeFile(selector, JSON.stringify({ naturalChromeQualification: 'launcher' }));
    const options = {
      browserName: 'chrome' as const,
      root,
      output: root,
      installation: 'extension' as const,
      headless: false,
    };
    await assert.rejects(run({ ...options, browserName: 'msedge' }), /requires Chrome/);
    await assert.rejects(run({ ...options, headless: true }), /requires headed/);
    await assert.rejects(run({ ...options, installation: 'userscript' }), /requires extension/);
    await assert.rejects(
      run({ ...options, liveUrls: ['https://www.youtube.com/watch?v=x'] }),
      /cannot visit public/
    );
    await assert.rejects(
      run({ ...options, liveObservation: { mode: 'duration', duration_seconds: 1200 } }),
      /cannot run duration/
    );
    await writeFile(join(inputs, 'another.json'), '{}');
    await assert.rejects(readNaturalChromeQualification(root), /must be exclusive/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('launcher-only qualification uses gesture-required launch and immediate normal cleanup', async () => {
  const calls: string[] = [];
  const result = await runNaturalChromeQualification(
    {
      chromium: {} as Parameters<typeof launchOwnedNaturalChrome>[0]['chromium'],
      root: 'owned',
      output: 'out',
      mode: 'launcher',
    },
    {
      launchNaturalChrome: async (options) => {
        calls.push('launch');
        assert.equal(options.requireAutoplayGesture, true);
        return {
          browser: { version: () => 'test-version' },
          launchEvidence: { portObservations: [] },
          profile: 'owned/profile',
        } as unknown as Awaited<ReturnType<typeof launchOwnedNaturalChrome>>;
      },
      cleanupInstallation: async (options) => {
        calls.push('cleanup');
        assert.equal(options.extensionId, null);
        assert.equal(options.profile, 'owned/profile');
        assert('qualification' in options.result);
        assert.deepEqual(options.result.qualification, { mode: 'launcher', status: 'started' });
      },
      persistResult: async (_path, contents) => {
        calls.push('receipt');
        assert.deepEqual(JSON.parse(contents).qualification, {
          mode: 'launcher',
          status: 'completed',
        });
      },
    }
  );
  assert.deepEqual(calls, ['launch', 'cleanup', 'receipt']);
  assert.deepEqual(result.qualification, { mode: 'launcher', status: 'completed' });
  assert.equal(result.fixture, null);
  assert.deepEqual(result.live, []);
});

test('qualification never reports completion when cleanup fails and preserves both failures', async () => {
  const cleanupError = new Error('cleanup failed');
  const primaryError = new Error('version read failed');
  for (const failVersion of [false, true]) {
    await assert.rejects(
      runNaturalChromeQualification(
        {
          chromium: {} as Parameters<typeof launchOwnedNaturalChrome>[0]['chromium'],
          root: 'owned',
          output: 'out',
          mode: 'launcher',
        },
        {
          launchNaturalChrome: async () =>
            ({
              browser: {
                version: () => {
                  if (failVersion) throw primaryError;
                  return 'test-version';
                },
              },
            }) as unknown as Awaited<ReturnType<typeof launchOwnedNaturalChrome>>,
          cleanupInstallation: async (options) => {
            assert('qualification' in options.result);
            assert.deepEqual(options.result.qualification, { mode: 'launcher', status: 'started' });
            throw cleanupError;
          },
          persistResult: async () =>
            assert.fail('Cleanup failure must not write a completed receipt'),
        }
      ),
      (error: unknown) =>
        failVersion
          ? error instanceof AggregateError &&
            error.errors[0] === primaryError &&
            error.errors[1] === cleanupError
          : error === cleanupError
    );
  }
});
