// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vite-plus/test';

import { MAX_PACKAGED_WORKER_BYTES } from '../../../extension/worker-source-limit';
import { buildTargets } from '../../../scripts/build/targets';
import type { BuildIdentity } from '../../../scripts/release/footprint';

const identity: BuildIdentity = {
  sourceSha: 'a'.repeat(40),
  coreSha: 'b'.repeat(40),
  lockfileSha256: 'c'.repeat(64),
  configSha256: 'd'.repeat(64),
  sourceDiffSha256: 'e'.repeat(64),
  worktreeStatus: '',
  packageManager: 'pnpm@12.15.0',
  pnpmVersion: '12.15.0',
  nodeVersion: '26.12.1',
  viteVersion: '1.4.0',
  vitePlusVersion: '1.4.0',
  buildVersion: '0.45.8',
};

describe('all-target build owner', () => {
  it('records only after all production targets and artifact checks finish', () => {
    const calls: string[] = [];
    buildTargets(
      () => identity,
      (script) => calls.push(script),
      (captured, limit) => {
        expect(captured).toBe(identity);
        expect(limit).toBe(MAX_PACKAGED_WORKER_BYTES);
        calls.push('record');
      }
    );
    expect(calls).toEqual([
      'build:ci',
      'build:extension:ci',
      'build:extension:firefox:ci',
      'check:artifacts',
      'record',
    ]);
  });

  it('does not record when a target build fails', () => {
    const calls: string[] = [];
    expect(() =>
      buildTargets(
        () => identity,
        (script) => {
          calls.push(script);
          if (script === 'build:extension:ci') throw new Error('failed target');
        },
        () => calls.push('record')
      )
    ).toThrow('failed target');
    expect(calls).toEqual(['build:ci', 'build:extension:ci']);
  });
});
