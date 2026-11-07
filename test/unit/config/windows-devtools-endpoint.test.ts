// SPDX-License-Identifier: MIT

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vite-plus/test';

it.each(['devtools-endpoint', 'natural-qualification'])(
  'enforces Windows %s regressions in an isolated Node process',
  async (name) => {
    // A subprocess keeps native Node HTTP and VM behavior isolated from the Vitest loader.
    const fixture = resolve(import.meta.dirname, `../../../validation/windows/${name}.test.ts`);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--experimental-strip-types', '--test', fixture],
      {
        timeout: 8000,
      }
    );
    expect(stdout).toContain('fail 0');
  }
);
