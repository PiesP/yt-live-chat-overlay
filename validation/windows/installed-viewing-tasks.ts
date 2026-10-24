// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, Locator, Page } from '@playwright/test';

import { restoreFixtureSettings } from './fixture-settings.ts';
import { readPublicPageBrowserState } from './live-rendering.ts';

export const VIEWING_TASK_URL = 'https://www.youtube.com/watch?v=4xDzrJKXOOY';
const SELECTOR = 'validation/windows/inputs/installed-viewing-tasks.json';
const TASK_DEADLINE_MS = 150_000;
const CASE_LIMIT_MS = 60_000;
const CHAT = '.yt-live-chat-overlay-live-region > p';
const MODAL = '#yt-chat-overlay-settings-backdrop';
const PAUSE = '#yt-chat-overlay-pause-button';
type Verdict = 'passed' | 'blocked' | 'failed' | 'not-run';
type RecordEntry = { stage: string; elapsedMs: number; observation: unknown };
type Case = { status: Verdict; reason: string; timeline: RecordEntry[]; screenshots: string[] };
type SavedSettings = ReturnType<NonNullable<Window['__ytChatOverlay']>['getSettings']>;

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
  assert.equal(result.b.status, 'passed', `Real Translator task B: ${result.b.reason}`);
  assert.equal(result.b.creation, 'ready', 'Real Translator creation was not observed');
  assert.equal(
    result.b.effectiveMessage,
    'observed',
    'Effective translated message was not observed'
  );
  assert.equal(result.cleanup.settingsRestored, true, 'Task settings were not restored');
  assert.equal(result.cleanup.pageClosed, true, 'Task page was not closed');
}

function errorReason(error: unknown): string {
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
  const button = page.locator('#yt-chat-overlay-settings-button');
  await button.waitFor({ state: 'visible' });
  await button.focus();
  await page.keyboard.press('Enter');
  const modal = page.locator(MODAL);
  await modal.waitFor({ state: 'visible' });
  return modal;
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

async function runA(page: Page, start: number, output: string, result: Case): Promise<void> {
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

  modal = await openSettings(page);
  const pause = modal.locator(PAUSE);
  await pause.click();
  assert.equal(await pause.getAttribute('aria-pressed'), 'true');
  assert(await videoAdvances(page), 'Pausing comments stopped native playback');
  const paused = await record(page, start, result.timeline, 'pointer-pause');
  assert.equal(paused.overlayPaused, true);
  assert.equal(paused.settings?.fontSize, 26);
  await pause.focus();
  await page.keyboard.press('Enter');
  assert.equal(await pause.getAttribute('aria-pressed'), 'false');
  const keyboardResume = await record(page, start, result.timeline, 'keyboard-resume');
  assert.equal(keyboardResume.focusWithinModal, true);

  await modal.locator('input[name="enabled"]').uncheck();
  assert.equal(await pause.isDisabled(), true);
  const disabled = await record(page, start, result.timeline, 'comments-disabled');
  assert.equal(disabled.settings?.enabled, false);
  await modal.locator('input[name="enabled"]').check();
  assert.equal(await pause.isEnabled(), true);
  await closeSettings(page, modal);
  await record(page, start, result.timeline, 'comments-restored');

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
  result.status = 'passed';
  result.reason = 'installed-viewing-task-observed';
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

async function runB(
  page: Page,
  start: number,
  output: string,
  result: InstalledViewingTasks['b']
): Promise<void> {
  let modal = await openSettings(page);
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
  await modal.locator('select[name="translationService"]').selectOption('auto');
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
  await modal.screenshot({ path: join(output, 'installed-viewing-b-status.png') });
  result.screenshots.push('installed-viewing-b-status.png');
  result.creation = phase === 'active' ? 'ready' : (phase ?? 'unobserved');
  result.effectiveMessage = 'unobserved';
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
    await page
      .locator('#yt-live-chat-overlay canvas')
      .screenshot({ path: join(output, 'installed-viewing-b-active-canvas.png') });
    result.screenshots.push('installed-viewing-b-active-canvas.png');
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
    result.reason = 'effective-translated-message-unverified';
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
