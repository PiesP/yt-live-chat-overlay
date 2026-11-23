// SPDX-License-Identifier: MIT

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import { MAX_PACKAGED_WORKER_BYTES } from '../../../extension/worker-source-limit';
import {
  assertDistributionNotice,
  assertPackagedWorkerSource,
  checkArtifacts,
} from '../../../scripts/check/artifacts';
import { DISTRIBUTION_NOTICE_BANNER } from '../../../tooling/vite/distribution-notices';

const temporaryRoots: string[] = [];

function workerFile(contents?: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'yt-artifact-worker-'));
  temporaryRoots.push(directory);
  const file = join(directory, 'renderer.js');
  if (contents !== undefined) writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

describe('packaged worker artifact contract', () => {
  it('keeps standalone artifact checking from claiming build provenance', () => {
    expect(() => checkArtifacts(['node', 'artifacts.ts', '--record-footprint'])).toThrow(
      'use the all-target build to record a footprint'
    );
  });

  it('accepts an exact-limit UTF-8 source', () => {
    const file = workerFile('a'.repeat(MAX_PACKAGED_WORKER_BYTES));
    expect(assertPackagedWorkerSource(file)).toBe(MAX_PACKAGED_WORKER_BYTES);
  });

  it('rejects missing and empty renderer files', () => {
    expect(() => assertPackagedWorkerSource(workerFile())).toThrow(
      'Missing packaged worker source'
    );
    expect(() => assertPackagedWorkerSource(workerFile(''))).toThrow(
      'Packaged worker source is empty'
    );
  });

  it('rejects over-limit bytes even when the character count is below the limit', () => {
    const file = workerFile('가'.repeat(Math.floor(MAX_PACKAGED_WORKER_BYTES / 2)));
    expect(() => assertPackagedWorkerSource(file)).toThrow(
      `exceeds ${MAX_PACKAGED_WORKER_BYTES} UTF-8 bytes`
    );
  });

  it('rejects invalid UTF-8 rather than claiming a runtime-compatible byte count', () => {
    const file = workerFile('ready');
    writeFileSync(file, Buffer.from([0xff]));
    expect(() => assertPackagedWorkerSource(file)).toThrow();
  });

  it('rejects a directory or linked source', () => {
    const file = workerFile('ready');
    expect(() => assertPackagedWorkerSource(dirname(file))).toThrow('not a regular file');
    const linked = join(dirname(file), 'linked-renderer.js');
    symlinkSync(file, linked);
    expect(() => assertPackagedWorkerSource(linked)).toThrow();
  });
});

describe('distributed license notices', () => {
  it('carries the full browser-core and bidi-js license texts from the installed sources', () => {
    const root = resolve(import.meta.dirname, '../../..');
    const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.txt'), 'utf8').replace(
      /\s+/g,
      ' '
    );
    for (const upstream of ['packages/core/LICENSE', 'node_modules/bidi-js/LICENSE.txt']) {
      const text = readFileSync(join(root, upstream), 'utf8').trim().replace(/\s+/g, ' ');
      expect(notices, upstream).toContain(text);
    }
  });

  it('ships the complete Unicode 13-era notice from CLDR 37', () => {
    const text = readFileSync(
      resolve(import.meta.dirname, '../../../THIRD_PARTY_NOTICES.txt'),
      'utf8'
    );
    const heading = 'UNICODE, INC. LICENSE AGREEMENT - DATA FILES AND SOFTWARE';
    const start = text.indexOf(heading);
    expect(start).toBeGreaterThanOrEqual(0);
    // unicode-org/cldr 5ab4c862, unicode-license.txt, without its BOM and terminal whitespace.
    expect(createHash('sha256').update(text.slice(start).trimEnd()).digest('hex')).toBe(
      'dbf65923f23a20db59d40bb6fc7e06d8666725ec447f6e07f948cbcd80c7faca'
    );
  });

  it.each(['2026 PiesP', 'Jason Johnston', 'Unicode, Inc.'])(
    'rejects a bundle missing the full notice for %s',
    (holder) => {
      const source = `${DISTRIBUTION_NOTICE_BANNER}\nrender();`;
      expect(source).toContain(holder);
      expect(() => assertDistributionNotice(source, 'sample.user.js')).not.toThrow();
      const incomplete = source.replaceAll(holder, '');
      expect(() => assertDistributionNotice(incomplete, 'sample.user.js')).toThrow(
        'sample.user.js'
      );
    }
  );
});
