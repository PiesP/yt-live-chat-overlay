// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, Frame, Locator, Page } from '@playwright/test';

import { restoreFixtureSettings } from './fixture-settings.ts';
import { readPublicPageBrowserState } from './live-rendering.ts';

export const VIEWING_TASK_URL = 'https://www.youtube.com/watch?v=4xDzrJKXOOY';
const SELECTOR = 'validation/windows/inputs/installed-viewing-tasks.json';
const TASK_DEADLINE_MS = 180_000;
const CASE_LIMIT_MS = 60_000;
const CHAT = '.yt-live-chat-overlay-live-region > p';
const MODAL = '#yt-chat-overlay-settings-backdrop';
const PAUSE = '#yt-chat-overlay-pause-button';
type Verdict = 'passed' | 'blocked' | 'failed' | 'not-run';
type RecordEntry = { stage: string; elapsedMs: number; observation: unknown };
type Case = { status: Verdict; reason: string; timeline: RecordEntry[]; screenshots: string[] };
type SavedSettings = ReturnType<NonNullable<Window['__ytChatOverlay']>['getSettings']>;
class ViewingTaskStateError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}
export type CanvasSample =
  | {
      status: 'sampled';
      alphaPixels: number;
      activeCount: number | null;
      fingerprint: number;
      width: number;
      height: number;
    }
  | { status: 'unavailable'; reason: string };

export function summarizeReviewCandidate(
  messageId: string,
  original: string,
  layer: 'native-chat-frame' | 'product-accessible-mirror',
  elapsedMs: number
) {
  return {
    messageIdSha256: createHash('sha256').update(messageId).digest('hex'),
    textSha256: createHash('sha256').update(original).digest('hex'),
    codepointLength: Array.from(original).length,
    layer,
    elapsedMs,
  };
}

export function assessCanvasMotion(
  before: readonly CanvasSample[],
  paused: readonly CanvasSample[],
  resumed: readonly CanvasSample[]
): { status: 'passed' | 'blocked' | 'failed'; reason: string } {
  const all = [...before, ...paused, ...resumed];
  if (
    before.length < 3 ||
    paused.length < 3 ||
    resumed.length < 3 ||
    all.some((sample) => sample.status !== 'sampled')
  ) {
    return { status: 'blocked', reason: 'canvas-pixel-read-unavailable' };
  }
  const visible = (samples: readonly CanvasSample[]) =>
    samples.filter((sample) => sample.status === 'sampled' && sample.alphaPixels >= 8);
  if (visible(before).length < 2 || visible(paused).length < 2 || visible(resumed).length < 2)
    return { status: 'blocked', reason: 'visible-chat-ink-insufficient' };
  const changed = (samples: readonly CanvasSample[]) =>
    new Set(samples.map((sample) => (sample.status === 'sampled' ? sample.fingerprint : null)))
      .size > 1;
  if (!changed(before)) return { status: 'blocked', reason: 'pre-pause-chat-motion-unobserved' };
  if (changed(paused)) return { status: 'failed', reason: 'paused-canvas-not-stable' };
  if (!changed(resumed)) return { status: 'blocked', reason: 'resumed-chat-motion-unobserved' };
  return { status: 'passed', reason: 'real-canvas-ink-motion-freeze-resume-observed' };
}

async function captureCanvasSample(page: Page): Promise<CanvasSample> {
  try {
    return await page.evaluate(async () => {
      const canvas = document.querySelector<HTMLCanvasElement>('#yt-live-chat-overlay canvas');
      if (!canvas || canvas.width < 1 || canvas.height < 1)
        return { status: 'unavailable' as const, reason: 'product-canvas-unavailable' };
      const bitmap = await createImageBitmap(canvas);
      try {
        // Read an image of the actual presented Canvas. The product Canvas is
        // neither given a context nor modified, including on the Worker route.
        const scratch = new OffscreenCanvas(256, 144);
        const context = scratch.getContext('2d', { willReadFrequently: true });
        if (!context)
          return { status: 'unavailable' as const, reason: 'scratch-context-unavailable' };
        context.clearRect(0, 0, 256, 144);
        context.drawImage(bitmap, 0, 0, 256, 144);
        const pixels = context.getImageData(0, 0, 256, 144).data;
        let alphaPixels = 0;
        let fingerprint = 2166136261;
        const activeText = [...document.querySelectorAll('#yt-chat-overlay-debug > div')]
          .map((line) => /^Active:\s*(\d+)\b/u.exec(line.textContent ?? '')?.[1])
          .find((value) => value !== undefined);
        const activeCount = activeText === undefined ? null : Number(activeText);
        for (let index = 0; index < pixels.length; index += 4) {
          if ((pixels[index + 3] ?? 0) > 8) alphaPixels++;
          for (let channel = 0; channel < 4; channel++) {
            fingerprint ^= pixels[index + channel] ?? 0;
            fingerprint = Math.imul(fingerprint, 16777619);
          }
        }
        return {
          status: 'sampled' as const,
          alphaPixels,
          activeCount,
          fingerprint: fingerprint >>> 0,
          width: canvas.width,
          height: canvas.height,
        };
      } finally {
        bitmap.close();
      }
    });
  } catch (error) {
    return { status: 'unavailable', reason: errorReason(error) };
  }
}

async function sampleCanvasSeries(page: Page, count: number): Promise<CanvasSample[]> {
  const samples: CanvasSample[] = [];
  for (let index = 0; index < count; index++) {
    samples.push(await captureCanvasSample(page));
    if (index < count - 1) await page.waitForTimeout(250);
  }
  return samples;
}

export type InstalledViewingTasks = {
  source: 'installed-extension-authentic-youtube';
  url: typeof VIEWING_TASK_URL;
  limits: { totalMs: number; caseMs: number };
  a: Case;
  b: Case & {
    api: unknown;
    availability: unknown;
    pair: { source: 'en'; target: string } | null;
    creation: string;
    effectiveMessage: string;
    reviewEvidence: {
      candidates: Array<{
        messageIdSha256: string;
        textSha256: string;
        codepointLength: number;
        layer: 'native-chat-frame' | 'product-accessible-mirror';
        elapsedMs: number;
      }>;
      captures: Array<{
        screenshot: string;
        originalScreenshot: string;
        elapsedMs: number;
        messageIdsSha256: string[];
      }>;
    } | null;
  };
  c: { status: 'blocked'; reason: 'participant-unavailable'; evidenceLayer: 'human-observation' };
  cleanup: { settingsRestored: boolean; pageClosed: boolean; error: string | null };
};

export async function readInstalledViewingTaskSelector(root: string): Promise<boolean> {
  let input: string;
  try {
    input = await readFile(join(root, SELECTOR), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  assert.deepEqual(JSON.parse(input), { scenario: 'installed-viewing-tasks' });
  return true;
}

export function requireInstalledViewingTaskSuccess(result: InstalledViewingTasks): void {
  assert.equal(result.a.status, 'passed', `Installed viewing task A: ${result.a.reason}`);
  const motion = result.a.timeline.find(
    (entry) => entry.stage === 'real-canvas-motion'
  )?.observation;
  assert(
    motion &&
      typeof motion === 'object' &&
      'assessment' in motion &&
      (motion.assessment as { status?: unknown }).status === 'passed',
    'Real Canvas ink and pause/resume motion were not proven'
  );
  assert(
    result.a.timeline.some((entry) => entry.stage === 'native-layout-restored'),
    'Native theater layout was not observed and restored'
  );
  assert.equal(result.b.status, 'passed', `Real Translator task B: ${result.b.reason}`);
  assert.equal(result.b.creation, 'ready', 'Real Translator creation was not observed');
  assert.equal(
    result.b.effectiveMessage,
    'observed',
    'Effective translated message was not observed'
  );
  assert(
    result.b.reviewEvidence &&
      result.b.reviewEvidence.candidates.length > 0 &&
      result.b.reviewEvidence.captures.length > 0,
    'Actual translated-message review evidence is missing'
  );
  assert.equal(result.cleanup.settingsRestored, true, 'Task settings were not restored');
  assert.equal(result.cleanup.pageClosed, true, 'Task page was not closed');
}

function errorReason(error: unknown): string {
  if (error instanceof ViewingTaskStateError) return error.reason;
  return error instanceof Error ? error.name : typeof error;
}

async function snapshot(page: Page) {
  return page
    .evaluate(() => {
      const player = document.querySelector<HTMLElement>('#movie_player');
      const video = player?.querySelector<HTMLVideoElement>('video') ?? null;
      const settings = window.__ytChatOverlay?.getSettings();
      const bridge = (
        window as Window & {
          __ytExtensionBridge?: {
            workerUrl?: string;
            workerSupported?: boolean;
            storageType?: string;
          };
        }
      ).__ytExtensionBridge;
      const videoData = (
        player as HTMLElement & { getVideoData?: () => { video_id?: string } }
      )?.getVideoData?.();
      return {
        urlVideoId: new URL(location.href).searchParams.get('v'),
        playerVideoId: videoData?.video_id ?? null,
        adShowing: player?.classList.contains('ad-showing') ?? null,
        video: video
          ? {
              source: video.currentSrc || null,
              currentTime: video.currentTime,
              paused: video.paused,
              readyState: video.readyState,
              errorCode: video.error?.code ?? null,
              width: video.videoWidth,
              height: video.videoHeight,
              seekable:
                video.seekable.length > 0
                  ? {
                      start: video.seekable.start(video.seekable.length - 1),
                      end: video.seekable.end(video.seekable.length - 1),
                    }
                  : null,
            }
          : null,
        settings: settings
          ? {
              enabled: settings.enabled,
              fontSize: settings.fontSize,
              opacity: settings.opacity,
              translationEnabled: settings.translationEnabled,
              translationService: settings.translationService,
              translationSource: settings.translationSource,
              translationTarget: settings.translationTarget,
            }
          : null,
        canvasCount: document.querySelectorAll('#yt-live-chat-overlay canvas').length,
        accessibleChatCount: document.querySelectorAll('.yt-live-chat-overlay-live-region > p')
          .length,
        renderer: document.querySelector('#yt-chat-overlay-debug')?.textContent
          ? document.querySelector('#yt-chat-overlay-debug')?.textContent?.includes('Render: n/a')
            ? 'worker'
            : 'main'
          : null,
        bridge: {
          workerSupported: bridge?.workerSupported === true,
          storageType: bridge?.storageType ?? null,
          workerUrlUsesDocumentOrigin:
            typeof bridge?.workerUrl === 'string' &&
            bridge.workerUrl.startsWith(`blob:${location.origin}/`),
        },
        overlayPaused: [...(document.querySelector('#yt-live-chat-overlay')?.children ?? [])].some(
          (child) =>
            child instanceof HTMLDivElement &&
            child.style.position === 'absolute' &&
            child.style.top === '8px' &&
            child.style.right === '8px' &&
            child.style.zIndex === '100' &&
            child.style.display === 'block'
        ),
        focusId: document.activeElement?.id ?? null,
        focusWithinModal:
          document
            .querySelector('#yt-chat-overlay-settings-backdrop')
            ?.contains(document.activeElement) ?? false,
        settingsButtonCount: document.querySelectorAll('#yt-chat-overlay-settings-button').length,
        pauseButtonCount: document.querySelectorAll('#yt-chat-overlay-pause-button').length,
        pauseDisabled:
          document.querySelector<HTMLButtonElement>('#yt-chat-overlay-pause-button')?.disabled ??
          null,
        settingsFormEnabled:
          document.querySelector<HTMLInputElement>(
            '#yt-chat-overlay-settings-backdrop input[name="enabled"]'
          )?.checked ?? null,
        reloadFeedback: [
          ...document.querySelectorAll<HTMLElement>('.yt-chat-overlay-reload-feedback'),
        ].map((node) => ({ phase: node.dataset.phase ?? null, hidden: node.hidden })),
      };
    })
    .then(({ video, ...state }) => ({
      ...state,
      video: video
        ? {
            ...video,
            sourceSha256: video.source
              ? createHash('sha256').update(video.source).digest('hex')
              : null,
            source: undefined,
          }
        : null,
    }));
}

async function record(page: Page, start: number, timeline: RecordEntry[], stage: string) {
  const observation = await snapshot(page);
  timeline.push({ stage, elapsedMs: Math.round(performance.now() - start), observation });
  return observation;
}

async function openSettings(page: Page): Promise<Locator> {
  const modal = page.locator(MODAL);
  if (await modal.isVisible()) return modal;
  const button = page.locator('#yt-chat-overlay-settings-button');
  await button.waitFor({ state: 'visible' });
  await button.focus();
  await page.keyboard.press('Enter');
  await modal.waitFor({ state: 'visible' });
  return modal;
}

async function waitForCommentsControl(
  page: Page,
  start: number,
  timeline: RecordEntry[],
  enabled: boolean,
  stage: string
): Promise<void> {
  try {
    await page.waitForFunction(
      (expected) =>
        window.__ytChatOverlay?.getSettings().enabled === expected &&
        document.querySelector<HTMLButtonElement>('#yt-chat-overlay-pause-button')?.disabled ===
          !expected,
      enabled,
      { timeout: 5_000 }
    );
  } catch {
    await record(page, start, timeline, `${stage}-unsettled`);
    throw new ViewingTaskStateError(`${stage}-not-settled`);
  }
  await record(page, start, timeline, stage);
}

async function closeSettings(page: Page, modal: Locator): Promise<void> {
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
}

async function videoAdvances(page: Page): Promise<boolean> {
  const first = await page
    .locator('#movie_player video')
    .evaluate((video) => (video as HTMLVideoElement).currentTime);
  await page.waitForTimeout(900);
  const second = await page
    .locator('#movie_player video')
    .evaluate((video) => (video as HTMLVideoElement).currentTime);
  return second - first >= 0.15;
}

async function readWatchLayout(page: Page) {
  return page.evaluate(() => {
    const watch = document.querySelector('ytd-watch-flexy');
    const player = document.querySelector('#movie_player');
    const canvas = document.querySelector('#yt-live-chat-overlay canvas');
    const bounds = (element: Element | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    return {
      theater: watch?.hasAttribute('theater') ?? null,
      player: bounds(player),
      canvas: bounds(canvas),
      canvasCount: document.querySelectorAll('#yt-live-chat-overlay canvas').length,
    };
  });
}

async function observeNativeTheater(page: Page, start: number, output: string, result: Case) {
  const button = page.locator('#movie_player .ytp-size-button');
  if ((await button.count()) !== 1)
    return { status: 'blocked' as const, reason: 'native-theater-control-unavailable' };
  const normal = await readWatchLayout(page);
  if (normal.theater === null)
    return { status: 'blocked' as const, reason: 'native-watch-mode-unavailable' };
  try {
    await page.locator('#movie_player').hover();
    await button.click();
    await page.waitForFunction(
      (before) => document.querySelector('ytd-watch-flexy')?.hasAttribute('theater') !== before,
      normal.theater,
      { timeout: 8_000 }
    );
    const alternate = await readWatchLayout(page);
    result.timeline.push({
      stage: 'native-normal-theater-layout',
      elapsedMs: Math.round(performance.now() - start),
      observation: { normal, alternate },
    });
    if (
      !normal.player ||
      !normal.canvas ||
      !alternate.player ||
      !alternate.canvas ||
      normal.theater === null ||
      alternate.theater === null ||
      normal.theater === alternate.theater ||
      normal.canvasCount !== 1 ||
      alternate.canvasCount !== 1 ||
      normal.canvas.width <= 0 ||
      alternate.canvas.width <= 0 ||
      Math.abs(normal.player.width - alternate.player.width) < 20
    ) {
      return { status: 'blocked' as const, reason: 'native-theater-geometry-unverified' };
    }
    const theaterInk = await captureCanvasSample(page);
    result.timeline.push({
      stage: 'native-theater-canvas-ink',
      elapsedMs: Math.round(performance.now() - start),
      observation: theaterInk,
    });
    if (theaterInk.status !== 'sampled' || theaterInk.alphaPixels < 8)
      return { status: 'blocked' as const, reason: 'native-theater-visible-chat-unverified' };
    const screenshot = 'installed-viewing-a-theater-canvas.png';
    await page
      .locator('#yt-live-chat-overlay canvas')
      .screenshot({ path: join(output, screenshot) });
    result.screenshots.push(screenshot);
    return { status: 'passed' as const, reason: 'normal-and-native-theater-observed' };
  } finally {
    const current = await readWatchLayout(page);
    if (current.theater !== normal.theater) {
      await page.locator('#movie_player').hover();
      await button.click();
      await page.waitForFunction(
        (before) => document.querySelector('ytd-watch-flexy')?.hasAttribute('theater') === before,
        normal.theater,
        { timeout: 8_000 }
      );
    }
    result.timeline.push({
      stage: 'native-layout-restored',
      elapsedMs: Math.round(performance.now() - start),
      observation: await readWatchLayout(page),
    });
  }
}

async function runAStages(page: Page, start: number, output: string, result: Case): Promise<void> {
  const nativePlay = page.locator('#movie_player .ytp-play-button');
  await page.locator('#movie_player').hover();
  const wasPaused = await page
    .locator('#movie_player video')
    .evaluate((video) => (video as HTMLVideoElement).paused);
  if (wasPaused) await nativePlay.click();
  const initial = await record(page, start, result.timeline, 'qualified-start');
  assert.equal(initial.settings?.enabled, true);
  assert.equal(initial.canvasCount, 1);
  assert(initial.accessibleChatCount > 0);
  assert.equal(initial.video?.paused, false);
  assert(await videoAdvances(page), 'Native video did not advance');
  await nativePlay.click();
  assert.equal(
    await page
      .locator('#movie_player video')
      .evaluate((video) => (video as HTMLVideoElement).paused),
    true
  );
  await nativePlay.click();
  assert(await videoAdvances(page), 'Native play control did not resume video');
  await record(page, start, result.timeline, 'native-play-pause-resume');
  const seek = initial.video.seekable;
  if (seek && seek.end - seek.start >= 12) {
    const beforeSeek = await page
      .locator('#movie_player video')
      .evaluate((video) => (video as HTMLVideoElement).currentTime);
    const direction = beforeSeek - seek.start >= 7 ? 'ArrowLeft' : 'ArrowRight';
    await page.locator('#movie_player .ytp-progress-bar').focus();
    await page.keyboard.press(direction);
    await page.waitForTimeout(500);
    const afterSeek = await page
      .locator('#movie_player video')
      .evaluate((video) => (video as HTMLVideoElement).currentTime);
    result.timeline.push({
      stage: 'native-player-seek',
      elapsedMs: Math.round(performance.now() - start),
      observation: { direction, beforeSeek, afterSeek, seekable: seek },
    });
    assert(Math.abs(afterSeek - beforeSeek) >= 1, 'Native seek control did not change media time');
  } else {
    result.timeline.push({
      stage: 'native-player-seek',
      elapsedMs: Math.round(performance.now() - start),
      observation: { status: 'not-applicable', reason: 'qualified-seek-range-too-short' },
    });
  }

  let modal = await openSettings(page);
  await modal.locator('input[name="fontSize"]').fill('26');
  await modal.locator('input[name="opacity"]').fill('70');
  await modal.screenshot({ path: join(output, 'installed-viewing-a-settings.png') });
  result.screenshots.push('installed-viewing-a-settings.png');
  await closeSettings(page, modal);
  await page.waitForFunction(() => {
    const settings = window.__ytChatOverlay?.getSettings();
    return settings?.fontSize === 26 && settings.opacity === 0.7;
  });
  await record(page, start, result.timeline, 'size-opacity-saved');

  const beforeMotion = await sampleCanvasSeries(page, 4);

  modal = await openSettings(page);
  const pause = modal.locator(PAUSE);
  await pause.click();
  assert.equal(await pause.getAttribute('aria-pressed'), 'true');
  await page.waitForTimeout(350);
  const pausedMotion = await sampleCanvasSeries(page, 3);
  assert(await videoAdvances(page), 'Pausing comments stopped native playback');
  const paused = await record(page, start, result.timeline, 'pointer-pause');
  assert.equal(paused.overlayPaused, true);
  assert.equal(paused.settings?.fontSize, 26);
  await pause.focus();
  await page.keyboard.press('Enter');
  assert.equal(await pause.getAttribute('aria-pressed'), 'false');
  await page.waitForTimeout(350);
  const resumedMotion = await sampleCanvasSeries(page, 4);
  const keyboardResume = await record(page, start, result.timeline, 'keyboard-resume');
  assert.equal(keyboardResume.focusWithinModal, true);
  const motion = assessCanvasMotion(beforeMotion, pausedMotion, resumedMotion);
  result.timeline.push({
    stage: 'real-canvas-motion',
    elapsedMs: Math.round(performance.now() - start),
    observation: {
      renderer: keyboardResume.renderer,
      before: beforeMotion,
      paused: pausedMotion,
      resumed: resumedMotion,
      assessment: motion,
    },
  });

  await modal.locator('input[name="enabled"]').uncheck();
  await waitForCommentsControl(page, start, result.timeline, false, 'comments-disabled');
  await modal.locator('input[name="enabled"]').check();
  await waitForCommentsControl(page, start, result.timeline, true, 'comments-reenabled');
  await closeSettings(page, modal);
  await record(page, start, result.timeline, 'comments-restored');

  const theater = await observeNativeTheater(page, start, output, result);

  const ordinaryReload = page.locator('#yt-chat-overlay-reload-button');
  await page.locator('#yt-live-chat-overlay canvas').evaluate((node) => {
    node.dataset.installedViewingRuntimeOld = 'true';
  });
  await ordinaryReload.focus();
  await page.keyboard.press('Enter');
  await record(page, start, result.timeline, 'ordinary-overlay-reload-requested');
  await page.waitForFunction(
    () =>
      document.querySelector('#yt-chat-overlay-reload-button')?.getAttribute('aria-busy') !==
      'true',
    undefined,
    { timeout: 20_000 }
  );
  await page.waitForFunction(
    () => !document.querySelector('canvas[data-installed-viewing-runtime-old="true"]'),
    undefined,
    { timeout: 20_000 }
  );
  await page.locator(CHAT).first().waitFor({ state: 'attached', timeout: 25_000 });
  const reloadedRuntime = await record(
    page,
    start,
    result.timeline,
    'ordinary-overlay-reload-settled'
  );
  assert.equal(reloadedRuntime.canvasCount, 1);
  assert.equal(reloadedRuntime.settingsButtonCount, 1);
  assert.notEqual(reloadedRuntime.reloadFeedback[0]?.phase, 'failed');

  modal = await openSettings(page);
  await modal.locator(PAUSE).click();
  assert.equal(await modal.locator(PAUSE).getAttribute('aria-pressed'), 'true');
  await closeSettings(page, modal);
  await record(page, start, result.timeline, 'session-pause-before-reload');

  const priorCanvas = await page.locator('#yt-live-chat-overlay canvas').evaluate((node) => {
    node.dataset.installedViewingOld = 'true';
    return node.isConnected;
  });
  assert(priorCanvas);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 35_000 });
  await page
    .locator('#yt-live-chat-overlay canvas')
    .waitFor({ state: 'attached', timeout: 20_000 });
  await page.locator(CHAT).first().waitFor({ state: 'attached', timeout: 25_000 });
  const after = await record(page, start, result.timeline, 'ordinary-reload');
  assert.equal(after.canvasCount, 1);
  assert.equal(after.settingsButtonCount, 1);
  assert.equal(after.pauseButtonCount, 1);
  assert.equal(after.settings?.fontSize, 26);
  assert.equal(after.settings?.opacity, 0.7);
  assert.equal(after.settings?.enabled, true);
  assert.equal(after.overlayPaused, false);
  assert.equal(after.reloadFeedback.length, 1);
  assert.notEqual(after.reloadFeedback[0]?.phase, 'pending');
  assert.equal(await page.locator('canvas[data-installed-viewing-old="true"]').count(), 0);
  if (after.video?.paused) {
    await page.locator('#movie_player').hover();
    await page.locator('#movie_player .ytp-play-button').click();
  }
  assert(await videoAdvances(page), 'Main video did not advance after page reload');
  await record(page, start, result.timeline, 'post-reload-native-playback');
  modal = await openSettings(page);
  assert.equal(await modal.locator(PAUSE).getAttribute('aria-pressed'), 'false');
  await closeSettings(page, modal);
  result.status =
    motion.status === 'failed'
      ? 'failed'
      : motion.status === 'passed' && theater.status === 'passed'
        ? 'passed'
        : 'blocked';
  result.reason = motion.status !== 'passed' ? motion.reason : theater.reason;
}

async function runA(page: Page, start: number, output: string, result: Case): Promise<void> {
  try {
    await runAStages(page, start, output, result);
  } finally {
    if (!page.isClosed()) {
      const modal = page.locator(MODAL);
      if (await modal.isVisible().catch(() => false)) {
        try {
          const enabled = modal.locator('input[name="enabled"]');
          if (!(await enabled.isChecked())) await enabled.check();
          await waitForCommentsControl(page, start, result.timeline, true, 'a-control-restored');
          await closeSettings(page, modal);
        } catch (error) {
          result.timeline.push({
            stage: 'a-control-restore-failed',
            elapsedMs: Math.round(performance.now() - start),
            observation: {
              reason: errorReason(error),
              state: await snapshot(page).catch(() => null),
            },
          });
          await page.keyboard.press('Escape').catch(() => {});
        }
      }
    }
  }
}

async function readTranslationUi(modal: Locator) {
  const capability = modal.locator('.yt-chat-overlay-settings-capability');
  const runtime = modal.locator('.yt-chat-overlay-settings-runtime-status');
  return {
    supported: await capability.getAttribute('data-supported'),
    phase: await runtime.getAttribute('data-phase'),
    text: (await runtime.innerText()).slice(0, 180),
  };
}

async function selectServiceWithKeyboard(
  modal: Locator,
  key: 'Home' | 'End',
  expected: 'auto' | 'off'
) {
  const select = modal.locator('select[name="translationService"]');
  const options = await select.evaluate((node) =>
    [...(node as HTMLSelectElement).options].map((option) => option.value)
  );
  assert.deepEqual(options, ['auto', 'off']);
  await select.evaluate((node, pressedKey) => {
    (node as HTMLSelectElement).addEventListener(
      'keydown',
      (event) => {
        if (event.key !== pressedKey) return;
        const activation = navigator.userActivation;
        (node as HTMLElement).dataset.installedViewingKey = JSON.stringify({
          key: event.key,
          isTrusted: event.isTrusted,
          isActive: activation?.isActive ?? null,
          hasBeenActive: activation?.hasBeenActive ?? null,
        });
      },
      { once: true }
    );
  }, key);
  await select.press(key);
  await select.press('Tab');
  const observation = await select.evaluate((node) => {
    const element = node as HTMLSelectElement;
    const keydown = element.dataset.installedViewingKey;
    delete element.dataset.installedViewingKey;
    return { value: element.value, selectedIndex: element.selectedIndex, keydown };
  });
  assert.equal(observation.value, expected);
  const keydown = observation.keydown
    ? (JSON.parse(observation.keydown) as {
        key: string;
        isTrusted: boolean;
        isActive: boolean | null;
        hasBeenActive: boolean | null;
      })
    : null;
  assert(keydown, 'Translation setting did not receive a keyboard event');
  assert.equal(keydown?.key, key);
  assert.equal(keydown.isTrusted, true, 'Translation setting was not changed by trusted key input');
  return { value: observation.value, selectedIndex: observation.selectedIndex, keydown };
}

async function readPermittedOriginals(
  page: Page,
  elapsedMs: number,
  previousIds: ReadonlySet<string>,
  output: string,
  index: number
) {
  const mirror = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLParagraphElement>(
        '.yt-live-chat-overlay-live-region > p[data-message-id]'
      ),
    ]
      .slice(-8)
      .map((node) => ({
        messageId: node.dataset.messageId ?? '',
        original: (node.textContent ?? '').trim().slice(0, 120),
      }))
      .filter((item) => item.messageId && item.original)
  );
  const native = new Map<string, { original: string; row: number; frame: Frame }>();
  for (const frame of page
    .frames()
    .filter((item) => {
      try {
        return new URL(item.url()).pathname.includes('/live_chat');
      } catch {
        return false;
      }
    })
    .slice(0, 2)) {
    const entries = await frame
      .evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('yt-live-chat-text-message-renderer[id]')]
          .map((item, row) => ({
            messageId: item.id,
            original: (item.querySelector('#message')?.textContent ?? '').trim().slice(0, 120),
            row,
          }))
          .slice(-40)
          .filter((item) => item.messageId && item.original)
      )
      .catch(() => []);
    for (const item of entries)
      native.set(item.messageId, { original: item.original, row: item.row, frame });
  }
  const item = mirror.findLast((entry) => !previousIds.has(entry.messageId));
  if (!item) return null;
  const nativeEntry = native.get(item.messageId);
  const original = nativeEntry?.original ?? item.original;
  let capturedOriginal = original;
  const messageIdSha256 = createHash('sha256').update(item.messageId).digest('hex');
  const originalScreenshot = `installed-viewing-b-original-${index}.png`;
  let layer: 'native-chat-frame' | 'product-accessible-mirror' = nativeEntry
    ? 'native-chat-frame'
    : 'product-accessible-mirror';
  if (nativeEntry) {
    const row = nativeEntry.frame
      .locator('yt-live-chat-text-message-renderer[id]')
      .nth(nativeEntry.row);
    try {
      assert.equal(await row.getAttribute('id'), item.messageId);
      const before = ((await row.locator('#message').textContent()) ?? '').trim().slice(0, 120);
      assert(before);
      await row.screenshot({ path: join(output, originalScreenshot), timeout: 3_000 });
      assert.equal(
        ((await row.locator('#message').textContent()) ?? '').trim().slice(0, 120),
        before
      );
      capturedOriginal = before;
    } catch {
      layer = 'product-accessible-mirror';
    }
  }
  if (layer === 'product-accessible-mirror') {
    // The real accessible mirror is visually hidden. Show its matching DOM
    // text briefly for a private capture without switching away from playback.
    capturedOriginal = await page.evaluate(
      ({ messageId, messageIdSha256 }) => {
        const source = [
          ...document.querySelectorAll<HTMLElement>(
            '.yt-live-chat-overlay-live-region > p[data-message-id]'
          ),
        ].find((node) => node.dataset.messageId === messageId);
        if (!source) throw new Error('matching accessible mirror message disappeared');
        const panel = document.createElement('div');
        panel.id = 'yt-installed-viewing-original-capture';
        panel.style.cssText =
          'position:fixed;left:0;top:0;z-index:2147483647;background:white;color:black;font:16px sans-serif;max-width:680px;padding:16px;pointer-events:none';
        const id = document.createElement('p');
        id.textContent = `ID SHA-256: ${messageIdSha256}`;
        const text = document.createElement('p');
        const capturedText = (source.textContent ?? '').trim().slice(0, 120);
        text.textContent = capturedText;
        panel.append(id, text);
        document.body.append(panel);
        return capturedText;
      },
      { messageId: item.messageId, messageIdSha256 }
    );
    try {
      await page.locator('#yt-installed-viewing-original-capture').screenshot({
        path: join(output, originalScreenshot),
        timeout: 3_000,
      });
    } finally {
      await page.evaluate(() =>
        document.querySelector('#yt-installed-viewing-original-capture')?.remove()
      );
    }
  }
  return {
    candidate: summarizeReviewCandidate(item.messageId, capturedOriginal, layer, elapsedMs),
    originalScreenshot,
  };
}

async function runB(
  page: Page,
  start: number,
  output: string,
  result: InstalledViewingTasks['b']
): Promise<void> {
  let modal = await openSettings(page);
  const enabledControl = modal.locator('input[name="enabled"]');
  const repairedEnabled = !(await enabledControl.isChecked());
  if (repairedEnabled) await enabledControl.check();
  try {
    await page.waitForFunction(
      () =>
        window.__ytChatOverlay?.getSettings().enabled === true &&
        document.querySelector<HTMLButtonElement>('#yt-chat-overlay-pause-button')?.disabled ===
          false &&
        document.querySelector('#yt-live-chat-overlay canvas') !== null &&
        document.querySelectorAll('.yt-live-chat-overlay-live-region > p').length > 0,
      null,
      { timeout: 8_000 }
    );
  } catch {
    const state = await record(page, start, result.timeline, 'translation-session-prerequisite');
    result.timeline.push({
      stage: 'translation-session-prerequisite-result',
      elapsedMs: Math.round(performance.now() - start),
      observation: { repairedEnabled, ready: false, state },
    });
    result.reason = 'overlay-session-prerequisite-unavailable';
    result.creation = 'blocked';
    result.effectiveMessage = 'not-run';
    await closeSettings(page, modal);
    return;
  }
  const sessionState = await record(
    page,
    start,
    result.timeline,
    'translation-session-prerequisite'
  );
  const playbackReady = await videoAdvances(page);
  result.timeline.push({
    stage: 'translation-session-prerequisite-result',
    elapsedMs: Math.round(performance.now() - start),
    observation: { repairedEnabled, ready: playbackReady, state: sessionState },
  });
  if (!playbackReady) {
    result.reason = 'overlay-session-playback-unavailable';
    result.creation = 'blocked';
    result.effectiveMessage = 'not-run';
    await closeSettings(page, modal);
    return;
  }
  await modal.locator('#tab-translation').click();
  result.timeline.push({
    stage: 'translation-baseline',
    elapsedMs: Math.round(performance.now() - start),
    observation: await readTranslationUi(modal),
  });
  result.api = await page.evaluate(() => {
    const translator = (
      globalThis as typeof globalThis & {
        Translator?: { availability?: unknown; create?: unknown };
      }
    ).Translator;
    return {
      present: translator !== undefined,
      availabilityMethod: typeof translator?.availability === 'function',
      createMethod: typeof translator?.create === 'function',
    };
  });
  const availablePairs = await page.evaluate(async () => {
    const translator = (
      globalThis as typeof globalThis & {
        Translator?: {
          availability?: (pair: {
            sourceLanguage: string;
            targetLanguage: string;
          }) => Promise<string>;
        };
      }
    ).Translator;
    if (typeof translator?.availability !== 'function') return [];
    const observed: Array<{ target: string; state: string }> = [];
    for (const target of ['ko', 'ja', 'es']) {
      try {
        const state = await translator.availability({
          sourceLanguage: 'en',
          targetLanguage: target,
        });
        observed.push({ target, state });
        if (['available', 'downloadable', 'downloading'].includes(state)) break;
      } catch (error) {
        observed.push({ target, state: error instanceof Error ? error.name : typeof error });
      }
    }
    return observed;
  });
  result.availability = availablePairs;
  const chosen = availablePairs.find((pair) =>
    ['available', 'downloadable', 'downloading'].includes(pair.state)
  );
  result.pair = chosen ? { source: 'en', target: chosen.target } : null;
  result.timeline.push({
    stage: 'real-api-availability',
    elapsedMs: Math.round(performance.now() - start),
    observation: { api: result.api, availability: availablePairs, pair: result.pair },
  });
  await modal.locator('input[name="translationEnabled"]').check();
  await modal.locator('select[name="translationService"]').selectOption('off');
  const serviceOff = await readTranslationUi(modal);
  assert.equal(serviceOff.phase, 'off');
  result.timeline.push({
    stage: 'enabled-service-off',
    elapsedMs: Math.round(performance.now() - start),
    observation: serviceOff,
  });
  if (!chosen) {
    await modal.locator('select[name="translationSource"]').selectOption('en');
    await modal.locator('select[name="translationTarget"]').selectOption('ko');
    await modal.locator('select[name="translationService"]').selectOption('auto');
    await closeSettings(page, modal);
    modal = await openSettings(page);
    await modal.locator('#tab-translation').click();
    const unavailable = await readTranslationUi(modal);
    result.timeline.push({
      stage: 'unavailable-feedback',
      elapsedMs: Math.round(performance.now() - start),
      observation: unavailable,
    });
    await modal.screenshot({ path: join(output, 'installed-viewing-b-unavailable.png') });
    result.screenshots.push('installed-viewing-b-unavailable.png');
    result.creation = 'blocked';
    result.effectiveMessage = 'not-run';
    result.reason = `pair-or-api-unavailable:${unavailable.phase}`;
    await closeSettings(page, modal);
    return;
  }
  await modal.locator('select[name="translationSource"]').selectOption('en');
  await modal.locator('select[name="translationTarget"]').selectOption(chosen.target);
  const initialActivation = await selectServiceWithKeyboard(modal, 'Home', 'auto');
  result.timeline.push({
    stage: 'normal-ui-initial-activation',
    elapsedMs: Math.round(performance.now() - start),
    observation: initialActivation,
  });
  await closeSettings(page, modal);
  modal = await openSettings(page);
  await modal.locator('#tab-translation').click();
  let ui = await readTranslationUi(modal);
  let phase = ui.phase;
  let lastUi = '';
  const until = Math.min(start + TASK_DEADLINE_MS, performance.now() + CASE_LIMIT_MS);
  while (
    performance.now() < until &&
    phase &&
    !['active', 'unavailable', 'needs-action', 'failed'].includes(phase)
  ) {
    if (`${ui.phase}:${ui.text}` !== lastUi) {
      result.timeline.push({
        stage: 'model-state',
        elapsedMs: Math.round(performance.now() - start),
        observation: ui,
      });
      lastUi = `${ui.phase}:${ui.text}`;
    }
    await page.waitForTimeout(750);
    ui = await readTranslationUi(modal);
    phase = ui.phase;
  }
  result.timeline.push({
    stage: 'normal-ui-model-lifecycle',
    elapsedMs: Math.round(performance.now() - start),
    observation: { ui },
  });
  if (phase === 'needs-action') {
    // One normal settings action provides the user activation required by some
    // browser models. It does not bypass model policy or install anything.
    const offActivation = await selectServiceWithKeyboard(modal, 'End', 'off');
    await page.waitForFunction(
      () =>
        document
          .querySelector('.yt-chat-overlay-settings-runtime-status')
          ?.getAttribute('data-phase') === 'off',
      null,
      { timeout: 5_000 }
    );
    const retired = await readTranslationUi(modal);
    const retryActivation = await selectServiceWithKeyboard(modal, 'Home', 'auto');
    assert.equal(await modal.locator('select[name="translationSource"]').inputValue(), 'en');
    assert.equal(
      await modal.locator('select[name="translationTarget"]').inputValue(),
      chosen.target
    );
    ui = await readTranslationUi(modal);
    phase = ui.phase;
    result.timeline.push({
      stage: 'normal-ui-user-activation-retry',
      elapsedMs: Math.round(performance.now() - start),
      observation: { before: 'needs-action', offActivation, retired, retryActivation, after: ui },
    });
    const retryUntil = Math.min(until, performance.now() + 15_000);
    while (
      performance.now() < retryUntil &&
      phase &&
      !['active', 'unavailable', 'failed'].includes(phase)
    ) {
      await page.waitForTimeout(750);
      ui = await readTranslationUi(modal);
      phase = ui.phase;
    }
    result.timeline.push({
      stage: 'normal-ui-user-activation-result',
      elapsedMs: Math.round(performance.now() - start),
      observation: ui,
    });
  }
  await modal.screenshot({ path: join(output, 'installed-viewing-b-status.png') });
  result.screenshots.push('installed-viewing-b-status.png');
  result.creation = phase === 'active' ? 'ready' : (phase ?? 'unobserved');
  result.effectiveMessage = 'unobserved';
  let newMessageObserved = false;
  if (phase === 'preparing' || phase === 'downloading') {
    await modal.locator('select[name="translationService"]').selectOption('off');
    await closeSettings(page, modal);
    await page.waitForTimeout(1_500);
    modal = await openSettings(page);
    await modal.locator('#tab-translation').click();
    const retired = await readTranslationUi(modal);
    result.timeline.push({
      stage: 'retired-preparation-after-normal-ui-disable',
      elapsedMs: Math.round(performance.now() - start),
      observation: retired,
    });
    assert.equal(retired.phase, 'off', 'Retired Translator published readiness');
    result.creation = 'preparation-retired';
    result.reason = 'real-preparation-cancelled-before-readiness';
  } else if (phase === 'active') {
    const nativeVideo = page.locator('#movie_player video');
    if (await nativeVideo.evaluate((video) => (video as HTMLVideoElement).paused)) {
      await closeSettings(page, modal);
      await page.locator('#movie_player').hover();
      await page.locator('#movie_player .ytp-play-button').click();
      modal = await openSettings(page);
      await modal.locator('#tab-translation').click();
    }
    assert(await videoAdvances(page), 'Native video did not advance during translation');
    await closeSettings(page, modal);
    const previousIds = new Set(
      await page
        .locator('.yt-live-chat-overlay-live-region > p[data-message-id]')
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.messageId ?? ''))
    );
    const activeElapsedMs = Math.round(performance.now() - start);
    try {
      await page.waitForFunction(
        (ids) =>
          [
            ...document.querySelectorAll<HTMLElement>(
              '.yt-live-chat-overlay-live-region > p[data-message-id]'
            ),
          ].some((node) => !!node.dataset.messageId && !ids.includes(node.dataset.messageId)),
        [...previousIds],
        { timeout: Math.min(20_000, Math.max(1_000, start + TASK_DEADLINE_MS - performance.now())) }
      );
      newMessageObserved = true;
    } catch {
      // A quiet public chat is a blocked observation, not translated-message proof.
    }
    result.timeline.push({
      stage: 'post-active-new-message',
      elapsedMs: Math.round(performance.now() - start),
      observation: { activeElapsedMs, observed: newMessageObserved },
    });
    const candidates = new Map<
      string,
      NonNullable<Awaited<ReturnType<typeof readPermittedOriginals>>>['candidate']
    >();
    const captures: NonNullable<InstalledViewingTasks['b']['reviewEvidence']>['captures'] = [];
    for (let index = 0; newMessageObserved && index < 3; index++) {
      const elapsedMs = Math.round(performance.now() - start);
      const observed = await readPermittedOriginals(page, elapsedMs, previousIds, output, index);
      if (!observed) break;
      candidates.set(observed.candidate.messageIdSha256, observed.candidate);
      const screenshot = `installed-viewing-b-active-canvas-${index}.png`;
      await page
        .locator('#yt-live-chat-overlay canvas')
        .screenshot({ path: join(output, screenshot) });
      result.screenshots.push(screenshot);
      result.screenshots.push(observed.originalScreenshot);
      captures.push({
        screenshot,
        originalScreenshot: observed.originalScreenshot,
        elapsedMs,
        messageIdsSha256: [observed.candidate.messageIdSha256],
      });
      if (index < 2) await page.waitForTimeout(400);
    }
    result.reviewEvidence = { candidates: [...candidates.values()].slice(-8), captures };
    result.timeline.push({
      stage: 'actual-message-manual-review-pending',
      elapsedMs: Math.round(performance.now() - start),
      observation: result.reviewEvidence,
    });
    result.effectiveMessage =
      result.reviewEvidence.candidates.length > 0 ? 'manual-review-pending' : 'unobserved';
    modal = await openSettings(page);
    await modal.locator('#tab-translation').click();
  }
  if (phase === 'active') {
    const beforeCount = await page.locator(CHAT).count();
    await page.waitForTimeout(3_000);
    const afterCount = await page.locator(CHAT).count();
    result.timeline.push({
      stage: 'public-chat-continuity',
      elapsedMs: Math.round(performance.now() - start),
      observation: { beforeCount, afterCount },
    });
    // The accessible mirror carries original text. Do not claim Canvas translation
    // solely from API readiness or an unchanged accessible-chat count.
    result.reason = !newMessageObserved
      ? 'no-new-message-after-translator-active'
      : result.effectiveMessage === 'manual-review-pending'
        ? 'actual-translated-message-manual-review-pending'
        : 'real-message-identity-unavailable';
  } else if (result.creation !== 'preparation-retired') {
    result.reason = `model-not-ready:${phase ?? 'unobserved'}`;
  }
  await closeSettings(page, modal);
}

/** A short, opt-in authentic task, separate from the installed fixture and live smoke. */
export async function runInstalledViewingTasks({
  context,
  extensionId,
  output,
  url,
  liveQualified,
}: {
  context: BrowserContext;
  extensionId: string;
  output: string;
  url: string;
  liveQualified: boolean;
}): Promise<InstalledViewingTasks> {
  const result: InstalledViewingTasks = {
    source: 'installed-extension-authentic-youtube',
    url: VIEWING_TASK_URL,
    limits: { totalMs: TASK_DEADLINE_MS, caseMs: CASE_LIMIT_MS },
    a: { status: 'blocked', reason: 'public-input-not-qualified', timeline: [], screenshots: [] },
    b: {
      status: 'blocked',
      reason: 'public-input-not-qualified',
      timeline: [],
      screenshots: [],
      api: null,
      availability: null,
      pair: null,
      creation: 'not-run',
      effectiveMessage: 'not-run',
      reviewEvidence: null,
    },
    c: { status: 'blocked', reason: 'participant-unavailable', evidenceLayer: 'human-observation' },
    cleanup: { settingsRestored: false, pageClosed: false, error: null },
  };
  if (!liveQualified) return result;
  assert.equal(url, VIEWING_TASK_URL);
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  const start = performance.now();
  let previous: SavedSettings | null = null;
  const watchdog = setTimeout(() => void page.close().catch(() => {}), TASK_DEADLINE_MS);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35_000 });
    await page.locator('#movie_player').waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator(CHAT).first().waitFor({ state: 'attached', timeout: 25_000 });
    const provider = await page.evaluate(readPublicPageBrowserState);
    const baseline = await snapshot(page);
    assert.equal(provider.chatRendererFound, true);
    assert.equal(provider.playabilityStatus, 'OK');
    assert.equal(baseline.urlVideoId, '4xDzrJKXOOY');
    assert.equal(baseline.playerVideoId, '4xDzrJKXOOY');
    assert.equal(baseline.adShowing, false);
    assert(baseline.video && baseline.video.width > 0 && baseline.video.height > 0);
    assert(baseline.video.sourceSha256);
    assert.equal(baseline.canvasCount, 1);
    assert(['worker', 'main'].includes(baseline.renderer ?? ''), 'Renderer route unavailable');
    assert.equal(baseline.bridge.storageType, 'chrome.storage.local');
    previous = await page.evaluate(() => window.__ytChatOverlay?.getSettings() ?? null);
    assert(previous, 'Installed application settings unavailable');
    result.a.reason = 'not-run';
    try {
      await runA(page, start, output, result.a);
    } catch (error) {
      result.a.status = 'failed';
      result.a.reason = errorReason(error);
    }
    result.b.reason = 'not-run';
    try {
      await runB(page, start, output, result.b);
    } catch (error) {
      result.b.status = 'failed';
      result.b.reason = errorReason(error);
    }
  } catch (error) {
    result.a.reason = `qualification:${errorReason(error)}`;
    result.b.reason = `qualification:${errorReason(error)}`;
  } finally {
    clearTimeout(watchdog);
    if (previous && !page.isClosed()) {
      try {
        await restoreFixtureSettings(context, page, extensionId, previous);
        result.cleanup.settingsRestored = true;
      } catch (error) {
        result.cleanup.error = `restore:${errorReason(error)}`;
      }
    }
    try {
      await page.close();
      result.cleanup.pageClosed = true;
    } catch (error) {
      result.cleanup.error ??= `close:${errorReason(error)}`;
    }
  }
  return result;
}
