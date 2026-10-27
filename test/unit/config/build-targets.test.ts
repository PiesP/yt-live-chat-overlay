// SPDX-License-Identifier: MIT

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { MAX_PACKAGED_WORKER_BYTES } from '../../../extension/worker-source-limit';
import { buildTargets } from '../../../scripts/build/targets';
import { retireFootprint, type BuildIdentity } from '../../../scripts/release/footprint';

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
  it('retires the prior receipt and records only after Vite+ completes', () => {
    const calls: string[] = [];
    buildTargets(
      () => {
        calls.push('capture');
        return identity;
      },
      () => calls.push('production-build'),
      (captured, limit) => {
        expect(captured).toBe(identity);
        expect(limit).toBe(MAX_PACKAGED_WORKER_BYTES);
        calls.push('record');
      },
      () => calls.push('retire')
    );
    expect(calls).toEqual(['retire', 'capture', 'production-build', 'record']);
  });

  it('does not record when the Vite+ build fails', () => {
    const calls: string[] = [];
    expect(() =>
      buildTargets(
        () => identity,
        () => {
          calls.push('production-build');
          throw new Error('failed target');
        },
        () => calls.push('record'),
        () => calls.push('retire')
      )
    ).toThrow('failed target');
    expect(calls).toEqual(['retire', 'production-build']);
  });

  it('preserves an old receipt outside the active path before an interrupted rebuild', () => {
    const root = mkdtempSync(join(tmpdir(), 'yt-footprint-retire-'));
    try {
      const path = join(root, 'distribution-footprint.json');
      writeFileSync(path, 'prior receipt\n');
      expect(() =>
        buildTargets(
          () => identity,
          () => {
            throw new Error('interrupted build');
          },
          () => {
            throw new Error('must not record');
          },
          () => retireFootprint(path)
        )
      ).toThrow('interrupted build');
      expect(existsSync(path)).toBe(false);
      const archived = readdirSync(root);
      expect(archived).toHaveLength(1);
      expect(archived[0]).toMatch(/^distribution-footprint\.json\.superseded-/);
      expect(readFileSync(join(root, archived[0] ?? ''), 'utf8')).toBe('prior receipt\n');
      buildTargets(
        () => identity,
        () => {},
        () => writeFileSync(path, 'fresh receipt\n'),
        () => retireFootprint(path)
      );
      expect(readFileSync(path, 'utf8')).toBe('fresh receipt\n');
      expect(readdirSync(root)).toHaveLength(2);
      expect(readFileSync(join(root, archived[0] ?? ''), 'utf8')).toBe('prior receipt\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
