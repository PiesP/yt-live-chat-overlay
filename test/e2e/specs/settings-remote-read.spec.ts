// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { SETTINGS_VERSION } from '@settings/schema';

import { createMockWatchHtml } from '../../../validation/windows/profile';
import { runRemoteReadStatusCase } from '../../../validation/windows/settings-persistence';
import { USERSCRIPT_PATH } from '../fixtures/test-utils';

for (const outcome of ['resolved', 'rejected', 'current-failure', 'failed-write'] as const) {
  test(`settings remote read feedback: ${outcome}`, async ({ browser }, testInfo) => {
    await mkdir(testInfo.outputDir, { recursive: true });
    const result = await runRemoteReadStatusCase({
      browser,
      output: testInfo.outputDir,
      userscript: await readFile(USERSCRIPT_PATH, 'utf8'),
      watchHtml: createMockWatchHtml(await readFile(resolve('test/visual/preview.html'), 'utf8')),
      outcome,
    });
    expect(result.seedVersion).toBe(SETTINGS_VERSION);
  });
}
