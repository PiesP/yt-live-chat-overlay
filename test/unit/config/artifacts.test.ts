// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import { MAX_PACKAGED_WORKER_BYTES } from '../../../extension/worker-source-limit';
import { assertPackagedWorkerSource } from '../../../scripts/check/artifacts';

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
});
