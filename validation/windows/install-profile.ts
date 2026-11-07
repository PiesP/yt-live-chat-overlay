// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserType } from '@playwright/test';

import { runChromeInstallation, runNaturalChromeQualification } from './chrome-install.ts';
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
  const qualification = await readNaturalChromeQualification(options.root);
  if (qualification !== null) {
    assert.equal(options.browserName, 'chrome', 'Natural qualification requires Chrome');
    assert.equal(options.headless, false, 'Natural qualification requires headed Chrome');
    assert.equal(
      options.installation,
      'extension',
      'Natural qualification requires extension mode'
    );
    assert.equal(liveObservation, null, 'Natural qualification cannot run duration observation');
    assert.deepEqual(options.liveUrls ?? [], [], 'Natural qualification cannot visit public URLs');
    assert(options.chromium, 'Chromium browser type is required');
    return runNaturalChromeQualification({
      chromium: options.chromium,
      root: options.root,
      output: options.output,
      mode: qualification,
    });
  }
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

/** Source-owned, exclusive selector; the controller's installation route stays unchanged. */
export async function readNaturalChromeQualification(root: string) {
  const directory = join(root, 'validation/windows/inputs');
  let text: string;
  try {
    text = await readFile(join(directory, 'natural-chrome-qualification.json'), 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
  assert(Buffer.byteLength(text, 'utf8') <= 1024, 'Natural qualification selector exceeds cap');
  const value: unknown = JSON.parse(text);
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value), ['naturalChromeQualification']);
  assert('naturalChromeQualification' in value);
  const mode = value.naturalChromeQualification;
  assert(mode === 'launcher' || mode === 'native-tab', 'Unknown natural Chrome qualification');
  const inputs = (await readdir(directory)).filter((name) => name !== '.gitignore');
  assert.deepEqual(
    inputs,
    ['natural-chrome-qualification.json'],
    'Qualification inputs must be exclusive'
  );
  return mode;
}
