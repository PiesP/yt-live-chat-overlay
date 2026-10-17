// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { join } from 'node:path';

import type { BrowserType } from '@playwright/test';

import { runChromeInstallation } from './chrome-install.ts';
import { runFirefoxInstallation } from './firefox-install.ts';

type LiveObservation = { mode: 'duration'; duration_seconds: 1200 };
type InstallationOptions = {
  browserName: 'chrome' | 'msedge' | 'firefox';
  chromium?: BrowserType;
  root: string;
  output: string;
  installation: 'extension' | 'userscript';
  headless?: boolean;
  liveUrls?: string[];
  liveObservation?: LiveObservation | null;
};

export function validateLiveObservation(value: unknown = null): LiveObservation | null {
  assert(value === null || (value && typeof value === 'object'), 'Invalid live observation option');
  if (value === null) return null;
  assert.deepEqual(
    Object.keys(value).sort(),
    ['duration_seconds', 'mode'],
    'Invalid live observation fields'
  );
  const observation = value as Record<string, unknown>;
  assert.equal(observation.mode, 'duration', 'Invalid live observation mode');
  assert.equal(observation.duration_seconds, 1200, 'Invalid live observation duration');
  return { mode: 'duration', duration_seconds: 1200 };
}

export async function run(options: InstallationOptions) {
  const liveObservation = validateLiveObservation(options.liveObservation);
  if (options.browserName === 'firefox') {
    assert.equal(liveObservation, null, 'Firefox duration live observation is not configured');
    assert.equal(
      options.installation,
      'extension',
      'Firefox userscript-manager installation is not configured'
    );
    return runFirefoxInstallation({
      ...options,
      executablePath: join(
        process.env.ProgramFiles ?? 'C:\\Program Files',
        'Mozilla Firefox/firefox.exe'
      ),
    });
  }
  assert(options.chromium, 'Chromium browser type is required');
  return runChromeInstallation({
    ...options,
    chromium: options.chromium,
    browserName: options.browserName,
    liveObservation,
  });
}
