// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrowserType } from '@playwright/test';
import { afterEach, expect, it } from 'vite-plus/test';

import { runChromeInstallation } from '../../../validation/windows/chrome-install.ts';
import {
  assessCanvasMotion,
  readInstalledViewingTaskSelector,
  requireInstalledViewingTaskSuccess,
  type CanvasSample,
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

it('requires actual nonempty Canvas motion, a stable pause and resumed motion', () => {
  const sample = (fingerprint: number, alphaPixels = 32): CanvasSample => ({
    status: 'sampled',
    fingerprint,
    alphaPixels,
    activeCount: 1,
    width: 1280,
    height: 720,
  });
  const before = [sample(1), sample(2), sample(3)];
  const paused = [sample(4), sample(4), sample(4)];
  const resumed = [sample(5), sample(6), sample(7)];
  expect(assessCanvasMotion(before, paused, resumed).status).toBe('passed');
  expect(assessCanvasMotion(before, [sample(4), sample(5), sample(4)], resumed).status).toBe(
    'failed'
  );
  expect(assessCanvasMotion(before, paused, [sample(5), sample(5), sample(5)]).status).toBe(
    'blocked'
  );
  expect(
    assessCanvasMotion(before, paused, [sample(5, 0), sample(6, 0), sample(7, 0)]).status
  ).toBe('blocked');
  expect(
    assessCanvasMotion(
      before.map((item) => ({ ...item, activeCount: 0 })),
      paused,
      resumed
    ).status
  ).toBe('blocked');
  expect(
    assessCanvasMotion(before, paused, [{ status: 'unavailable', reason: 'read-failed' }]).status
  ).toBe('blocked');
});

it('keeps API availability and service readiness separate from an effective message', () => {
  const result: InstalledViewingTasks = {
    source: 'installed-extension-authentic-youtube',
    url: VIEWING_TASK_URL,
    limits: { totalMs: 180_000, caseMs: 60_000 },
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
      reviewEvidence: null,
    },
    c: { status: 'blocked', reason: 'participant-unavailable', evidenceLayer: 'human-observation' },
    cleanup: { settingsRestored: true, pageClosed: true, error: null },
  };
  expect(() => requireInstalledViewingTaskSuccess(result)).toThrow(/Real Canvas ink/u);
  result.a.timeline.push(
    {
      stage: 'real-canvas-motion',
      elapsedMs: 1000,
      observation: { assessment: { status: 'passed' } },
    },
    { stage: 'native-layout-restored', elapsedMs: 2000, observation: {} }
  );
  expect(() => requireInstalledViewingTaskSuccess(result)).toThrow(/Real Translator task B/u);
  result.b.status = 'passed';
  expect(() => requireInstalledViewingTaskSuccess(result)).toThrow(/Effective translated message/u);
  result.b.effectiveMessage = 'observed';
  expect(() => requireInstalledViewingTaskSuccess(result)).toThrow(/review evidence is missing/u);
  result.b.reviewEvidence = { candidates: [], captures: [] };
  expect(() => requireInstalledViewingTaskSuccess(result)).toThrow(/review evidence is missing/u);
  result.b.reviewEvidence = {
    candidates: [
      { messageId: 'public-id', original: 'Hello', layer: 'native-chat-frame', elapsedMs: 3000 },
    ],
    captures: [{ screenshot: 'canvas.png', elapsedMs: 3000, messageIds: ['public-id'] }],
  };
  expect(() => requireInstalledViewingTaskSuccess(result)).not.toThrow();
  result.cleanup.settingsRestored = false;
  expect(() => requireInstalledViewingTaskSuccess(result)).toThrow(/settings were not restored/u);
});
