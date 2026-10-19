// SPDX-License-Identifier: MIT

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vite-plus/test';

it('enforces owned fixed-port DevTools discovery and connection boundaries', async () => {
  // A subprocess keeps native Node HTTP and VM behavior isolated from the Vitest loader.
  const fixture = resolve(import.meta.dirname, 'fixtures/devtools-endpoint.ts');
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--experimental-strip-types', '--test', fixture],
    {
      timeout: 8000,
    }
  );
  expect(stdout).toContain('fail 0');
});
