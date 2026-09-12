// SPDX-License-Identifier: MIT

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('enforces the DevTools file boundary with native Node filesystem operations', async () => {
  // A subprocess keeps native ESM filesystem mocks isolated from the Vitest loader.
  const fixture = resolve(import.meta.dirname, 'fixtures/devtools-endpoint.mjs');
  const { stdout } = await promisify(execFile)(process.execPath, ['--test', fixture], {
    timeout: 8000,
  });
  expect(stdout).toContain('fail 0');
});
