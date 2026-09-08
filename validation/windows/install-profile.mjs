// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runChromeInstallation } from './chrome-install.mjs';
import { runFirefoxInstallation } from './firefox-install.mjs';

export async function run(options) {
  if (options.browserName === 'firefox') {
    assert.equal(options.installation, 'extension', 'Firefox userscript-manager installation is not configured');
    return runFirefoxInstallation({
      ...options,
      executablePath: join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Mozilla Firefox/firefox.exe'),
    });
  }
  return runChromeInstallation(options);
}
