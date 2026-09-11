// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runChromeInstallation } from './chrome-install.mjs';
import { runFirefoxInstallation } from './firefox-install.mjs';

export function validateLiveObservation(value) {
  assert(value === null || (value && typeof value === 'object'),
    'Invalid live observation option');
  if (value === null) return null;
  assert.deepEqual(Object.keys(value).sort(), ['duration_seconds', 'mode'],
    'Invalid live observation fields');
  assert.equal(value.mode, 'duration', 'Invalid live observation mode');
  assert.equal(value.duration_seconds, 1200, 'Invalid live observation duration');
  return { mode: 'duration', duration_seconds: 1200 };
}

export async function run(options) {
  const liveObservation = validateLiveObservation(options.liveObservation);
  if (options.browserName === 'firefox') {
    assert.equal(liveObservation, null,
      'Firefox duration live observation is not configured');
    assert.equal(options.installation, 'extension', 'Firefox userscript-manager installation is not configured');
    return runFirefoxInstallation({
      ...options,
      executablePath: join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Mozilla Firefox/firefox.exe'),
    });
  }
  return runChromeInstallation({ ...options, liveObservation });
}
