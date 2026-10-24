// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrowserType } from '@playwright/test';
import { afterEach, expect, it } from 'vite-plus/test';

import { runChromeInstallation } from '../../../validation/windows/chrome-install.ts';
import {
  readInstalledViewingTaskSelector,
  requireInstalledViewingTaskSuccess,
  type InstalledViewingTasks,
  VIEWING_TASK_URL,
} from '../../../validation/windows/installed-viewing-tasks.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('requires one exact opt-in selector', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yt-installed-viewing-'));
  roots.push(root);
  expect(await readInstalledViewingTaskSelector(root)).toBe(false);
  const folder = join(root, 'validation/windows/inputs');
  await mkdir(folder, { recursive: true });
  const selector = join(folder, 'installed-viewing-tasks.json');
  await writeFile(selector, JSON.stringify({ scenario: 'installed-viewing-tasks' }));
  expect(await readInstalledViewingTaskSelector(root)).toBe(true);
  await writeFile(
    selector,
    JSON.stringify({ scenario: 'installed-viewing-tasks', assumeReady: true })
  );
  await expect(readInstalledViewingTaskSelector(root)).rejects.toThrow();
});

it('rejects a duration observation before launching a browser when the short task is selected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yt-installed-viewing-'));
  roots.push(root);
  const folder = join(root, 'validation/windows/inputs');
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, 'installed-viewing-tasks.json'),
    JSON.stringify({ scenario: 'installed-viewing-tasks' })
  );
  await expect(
    runChromeInstallation({
      chromium: {} as BrowserType,
      root,
      output: join(root, 'output'),
      installation: 'extension',
      liveUrls: [VIEWING_TASK_URL],
      liveObservation: { mode: 'duration', duration_seconds: 1200 },
    })
  ).rejects.toThrow(/cannot use the duration profile/u);
});

it('keeps API availability and service readiness separate from an effective message', () => {
  const result: InstalledViewingTasks = {
    source: 'installed-extension-authentic-youtube',
    url: VIEWING_TASK_URL,
    limits: { totalMs: 150_000, caseMs: 60_000 },
    a: { status: 'passed', reason: 'observed', timeline: [], screenshots: [] },
    b: {
      status: 'blocked',
      reason: 'effective-translated-message-unverified',
      timeline: [],
      screenshots: [],
      api: { present: true },
      availability: [{ target: 'ko', state: 'available' }],
      pair: { source: 'en', target: 'ko' },
      creation: 'ready',
      effectiveMessage: 'unobserved',
    },
    c: { status: 'blocked', reason: 'participant-unavailable', evidenceLayer: 'human-observation' },
    cleanup: { settingsRestored: true, pageClosed: true, error: null },
  };
  expect(() => requireInstalledViewingTaskSuccess(result)).toThrow(/Real Translator task B/u);
  result.b.status = 'passed';
  expect(() => requireInstalledViewingTaskSuccess(result)).toThrow(/Effective translated message/u);
  result.b.effectiveMessage = 'observed';
  expect(() => requireInstalledViewingTaskSuccess(result)).not.toThrow();
  result.cleanup.settingsRestored = false;
  expect(() => requireInstalledViewingTaskSuccess(result)).toThrow(/settings were not restored/u);
});
