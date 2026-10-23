// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, CDPSession, Page, Request } from '@playwright/test';

type TabEvent = {
  type: string;
  visibility: DocumentVisibilityState;
  trusted: boolean;
  atMs: number;
};

type TabProbe = {
  app: NonNullable<Window['__ytChatOverlay']>;
  canvas: HTMLCanvasElement;
  video: HTMLVideoElement;
  events: TabEvent[];
  eventOverflow: number;
  onVisibility: (event: Event) => void;
  onPageShow: (event: Event) => void;
  onResume: (event: Event) => void;
  onPauseClick: (event: Event) => void;
  onPlayClick: (event: Event) => void;
};

declare global {
  interface Window {
    __ytNativeTabProbe?: TabProbe;
  }
}

type TabSnapshot = {
  label: string;
  visibility: DocumentVisibilityState;
  timeOrigin: number;
  videoTime: number;
  videoPaused: boolean;
  videoReadyState: number;
  videoError: number | null;
  sameVideo: boolean;
  canvasCount: number;
  sameCanvas: boolean;
  sameApp: boolean;
  controllerStarts: number;
  liveIds: string[];
  debug: string | null;
  events: TabEvent[];
  eventOverflow: number;
  mediaActionErrors: string[];
};

const HEALTHY_ID = 'windows-tab-healthy';
const RETURN_ID = 'windows-tab-return-playing';
const PAUSED_ID = 'windows-tab-return-paused';
const EVENT_LIMIT = 24;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function snapshot(page: Page, label: string): Promise<TabSnapshot> {
  return page.evaluate((value) => {
    const probe = window.__ytNativeTabProbe;
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    const canvases = document.querySelectorAll<HTMLCanvasElement>('#yt-live-chat-overlay canvas');
    if (!probe || !video) throw new Error('Native tab probe or video disappeared');
    return {
      label: value,
      visibility: document.visibilityState,
      timeOrigin: performance.timeOrigin,
      videoTime: video.currentTime,
      videoPaused: video.paused,
      videoReadyState: video.readyState,
      videoError: video.error?.code ?? null,
      sameVideo: video === probe.video,
      canvasCount: canvases.length,
      sameCanvas: canvases.item(0) === probe.canvas,
      sameApp: window.__ytChatOverlay === probe.app,
      controllerStarts: window.__ytVideoPiPProbe.starts,
      liveIds: Array.from(
        document.querySelectorAll('#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p'),
        (element) => element.getAttribute('data-message-id') ?? ''
      ).slice(-32),
      debug: document.querySelector('#yt-chat-overlay-debug > div')?.textContent ?? null,
      events: [...probe.events],
      eventOverflow: probe.eventOverflow,
      mediaActionErrors: [...window.__ytVideoPiPFixture.actionErrors],
    };
  }, label);
}

async function appendChatMessage(page: Page, id: string): Promise<void> {
  await page.evaluate((messageId) => {
    const items = document.querySelector('yt-live-chat-item-list-renderer #items');
    if (!items) throw new Error('Native tab fixture chat container disappeared');
    const renderer = document.createElement('yt-live-chat-text-message-renderer');
    renderer.id = messageId;
    const author = document.createElement('span');
    author.id = 'author-name';
    author.textContent = 'Fixture author';
    const message = document.createElement('span');
    message.id = 'message';
    message.textContent = `Native tab lifetime ${messageId}`;
    renderer.append(author, message);
    items.append(renderer);
  }, id);
}

async function waitForOneLiveMessage(page: Page, id: string): Promise<void> {
  await page.waitForFunction(
    (messageId) =>
      Array.from(
        document.querySelectorAll('#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p')
      ).filter((element) => element.getAttribute('data-message-id') === messageId).length === 1,
    id,
    { timeout: 8_000 }
  );
}

function assertHealthy(state: TabSnapshot, initial: TabSnapshot): void {
  assert.equal(state.visibility, 'visible');
  assert.equal(state.timeOrigin, initial.timeOrigin, 'Fixture document was replaced');
  assert.equal(state.videoError, null, 'Native media reported an error');
  assert.equal(state.sameVideo, true, 'Fixture video was replaced');
  assert.equal(state.canvasCount, 1, 'Overlay canvas count changed');
  assert.equal(state.sameCanvas, true, 'Overlay canvas identity changed');
  assert.equal(state.sameApp, true, 'Installed application instance changed');
  assert.equal(state.controllerStarts, initial.controllerStarts, 'Video controller rebound');
  assert.equal(state.eventOverflow, 0, 'Native tab event record overflowed');
  assert.deepEqual(state.mediaActionErrors, [], 'Native media action failed');
}

/** Observe native tab switches against the existing installed Edge PiP page. */
export async function verifyNativeTabLifetime({
  context,
  page,
  output,
}: {
  context: BrowserContext;
  page: Page;
  output: string;
}): Promise<Record<string, unknown>> {
  const previousSettings = await page.evaluate(() => {
    const app = window.__ytChatOverlay;
    if (!app) throw new Error('Installed application is unavailable');
    return structuredClone(app.getSettings());
  });
  let cover: Page | undefined;
  let focusSession: CDPSession | undefined;
  let stage = 'setup';
  let primaryError: unknown;
  const states: TabSnapshot[] = [];
  const hiddenDurationsMs: number[] = [];
  const requestFailures: { url: string; error: string | null }[] = [];
  let requestFailureOverflow = 0;
  const cleanup: Record<string, unknown> = {};
  const onRequestFailed = (request: Request) => {
    const url = new URL(request.url());
    const record = {
      url: `${url.origin}${url.pathname}`.slice(0, 200),
      error: request.failure()?.errorText.slice(0, 200) ?? null,
    };
    if (requestFailures.length < 12) requestFailures.push(record);
    else requestFailureOverflow++;
  };

  try {
    page.on('requestfailed', onRequestFailed);
    await page.bringToFront();
    await page.waitForFunction(() => document.visibilityState === 'visible', undefined, {
      timeout: 5_000,
    });
    // Pinned Playwright enables focus emulation on attached pages, which keeps
    // background tabs visible. Restore native visibility for this owned page.
    focusSession = await context.newCDPSession(page);
    await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await page.evaluate(() => {
      const app = window.__ytChatOverlay;
      const video = document.querySelector<HTMLVideoElement>('#movie_player video');
      const chat = document.querySelector('yt-live-chat-item-list-renderer #items');
      if (!app || !video || !chat || !window.__ytVideoPiPProbe)
        throw new Error('Installed tab fixture is not ready');
      if (video.paused || document.pictureInPictureElement)
        throw new Error('Tab fixture requires restored foreground playback');
      app.applySettings({
        showDebugOverlay: true,
        allowShortTextMessages: true,
        danmakuMode: 'top',
        depthLayersEnabled: false,
        topBottomDurationMs: 8_000,
      });
    });
    await page.waitForFunction(
      () =>
        document.querySelectorAll('#yt-live-chat-overlay canvas').length === 1 &&
        !!document.querySelector('#yt-chat-overlay-debug > div'),
      undefined,
      { timeout: 5_000 }
    );
    await page.evaluate((limit) => {
      const app = window.__ytChatOverlay;
      const video = document.querySelector<HTMLVideoElement>('#movie_player video');
      const canvas = document.querySelector<HTMLCanvasElement>('#yt-live-chat-overlay canvas');
      if (!app || !video || !canvas) throw new Error('Tab fixture disappeared during setup');
      const probe: TabProbe = {
        app,
        canvas,
        video,
        events: [],
        eventOverflow: 0,
        onVisibility: () => {},
        onPageShow: () => {},
        onResume: () => {},
        onPauseClick: () => {},
        onPlayClick: () => {},
      };
      const record = (event: Event, type = event.type) => {
        const entry = {
          type,
          visibility: document.visibilityState,
          trusted: event.isTrusted,
          atMs: performance.now(),
        };
        if (probe.events.length < limit) probe.events.push(entry);
        else probe.eventOverflow++;
      };
      probe.onVisibility = (event) => record(event);
      probe.onPageShow = (event) => record(event);
      probe.onResume = (event) => record(event);
      probe.onPauseClick = (event) => record(event, 'control:pause');
      probe.onPlayClick = (event) => record(event, 'control:play');
      document.addEventListener('visibilitychange', probe.onVisibility);
      window.addEventListener('pageshow', probe.onPageShow);
      document.addEventListener('resume', probe.onResume);
      document.getElementById('pip-pause')?.addEventListener('click', probe.onPauseClick);
      document.getElementById('pip-play')?.addEventListener('click', probe.onPlayClick);
      window.__ytNativeTabProbe = probe;
    }, EVENT_LIMIT);

    stage = 'healthy';
    await appendChatMessage(page, HEALTHY_ID);
    await waitForOneLiveMessage(page, HEALTHY_ID);
    const initial = await snapshot(page, 'healthy-playing');
    states.push(initial);
    assertHealthy(initial, initial);
    assert.equal(initial.videoPaused, false);
    assert(initial.videoTime > 0.2, 'Native video never advanced');

    cover = await context.newPage();
    await cover.goto('data:text/html,<title>native-tab-cover</title>', {
      waitUntil: 'domcontentloaded',
      timeout: 5_000,
    });
    const switchAwayAndReturn = async (label: string): Promise<TabSnapshot> => {
      await cover?.bringToFront();
      await page.waitForFunction(() => document.visibilityState === 'hidden', undefined, {
        timeout: 5_000,
        polling: 100,
      });
      const hidden = await snapshot(page, `${label}-hidden`);
      states.push(hidden);
      assert.equal(hidden.visibility, 'hidden');
      // A bounded real tab absence; media captureStream may stop drawing while hidden.
      await page.waitForTimeout(2_100);
      await page.bringToFront();
      await page.waitForFunction(() => document.visibilityState === 'visible', undefined, {
        timeout: 5_000,
        polling: 100,
      });
      const returned = await snapshot(page, `${label}-returned`);
      states.push(returned);
      assertHealthy(returned, initial);
      const hiddenEvent = hidden.events.filter((event) => event.type === 'visibilitychange').at(-1);
      const visibleEvent = returned.events
        .filter((event) => event.type === 'visibilitychange')
        .at(-1);
      assert(hiddenEvent?.visibility === 'hidden' && hiddenEvent.trusted);
      assert(visibleEvent?.visibility === 'visible' && visibleEvent.trusted);
      const hiddenDurationMs = visibleEvent.atMs - hiddenEvent.atMs;
      assert(
        hiddenDurationMs >= 2_000 && hiddenDurationMs < 20_000,
        `Native hidden interval escaped short-return tier: ${hiddenDurationMs} ms`
      );
      hiddenDurationsMs.push(hiddenDurationMs);
      return returned;
    };

    stage = 'playing-tab-return';
    const firstReturn = await switchAwayAndReturn('playing');
    assert.equal(firstReturn.videoPaused, false);
    await page.waitForFunction(
      (before) => {
        const video = document.querySelector<HTMLVideoElement>('#movie_player video');
        return video && !video.paused && video.currentTime > before + 0.1;
      },
      firstReturn.videoTime,
      { timeout: 5_000 }
    );
    await appendChatMessage(page, RETURN_ID);
    await waitForOneLiveMessage(page, RETURN_ID);
    const playingRecovered = await snapshot(page, 'playing-recovered');
    states.push(playingRecovered);
    assertHealthy(playingRecovered, initial);
    assert(playingRecovered.videoTime > firstReturn.videoTime + 0.1);

    stage = 'paused-tab-return';
    await page.locator('#pip-pause').click();
    await page.waitForFunction(
      () => document.querySelector<HTMLVideoElement>('#movie_player video')?.paused === true,
      undefined,
      { timeout: 5_000 }
    );
    const paused = await snapshot(page, 'trusted-user-pause');
    states.push(paused);
    assertHealthy(paused, initial);
    assert.equal(paused.videoPaused, true);
    const pausedReturn = await switchAwayAndReturn('paused');
    assert.equal(pausedReturn.videoPaused, true, 'Native tab return cleared user media pause');
    await appendChatMessage(page, PAUSED_ID);
    // Cover the accessibility batch window while the native video remains paused.
    await page.waitForTimeout(700);
    const stillPaused = await snapshot(page, 'paused-message-held');
    states.push(stillPaused);
    assertHealthy(stillPaused, initial);
    assert.equal(stillPaused.videoPaused, true);
    assert.equal(
      stillPaused.liveIds.filter((id) => id === PAUSED_ID).length,
      0,
      'Paused message rendered before trusted playback resume'
    );
    await page.locator('#pip-play').click();
    await page.waitForFunction(
      (before) => {
        const video = document.querySelector<HTMLVideoElement>('#movie_player video');
        return video && !video.paused && video.currentTime > before + 0.1;
      },
      stillPaused.videoTime,
      { timeout: 5_000 }
    );
    await waitForOneLiveMessage(page, PAUSED_ID);
    const resumed = await snapshot(page, 'trusted-user-play-recovered');
    states.push(resumed);
    assertHealthy(resumed, initial);
    assert.equal(resumed.videoPaused, false);
    assert.equal(resumed.liveIds.filter((id) => id === PAUSED_ID).length, 1);
    assert.equal(resumed.liveIds.filter((id) => id === RETURN_ID).length, 1);
    assert.equal(resumed.liveIds.filter((id) => id === HEALTHY_ID).length, 1);
    assert(
      resumed.events.some((event) => event.type === 'control:pause' && event.trusted),
      'Trusted user pause control was not observed'
    );
    assert(
      resumed.events.some((event) => event.type === 'control:play' && event.trusted),
      'Trusted user play control was not observed'
    );
    const transitions = resumed.events.filter((event) => event.type === 'visibilitychange');
    const expected = ['hidden', 'visible', 'hidden', 'visible'];
    let nextExpected = 0;
    for (const event of transitions) {
      if (event.visibility === expected[nextExpected] && event.trusted) nextExpected++;
    }
    assert.equal(nextExpected, expected.length, 'Native trusted tab transitions were absent');
    assert.equal(requestFailureOverflow, 0, 'Native tab request failure record overflowed');
    assert.deepEqual(requestFailures, [], 'Unexpected request failure during native tab lifetime');
  } catch (error) {
    primaryError = error;
    let observations: unknown = null;
    try {
      observations = await snapshot(page, `failure:${stage}`);
    } catch {
      try {
        observations = await page.evaluate(() => {
          const video = document.querySelector<HTMLVideoElement>('#movie_player video');
          return {
            visibility: document.visibilityState,
            liveIds: Array.from(
              document.querySelectorAll(
                '#yt-live-chat-overlay .yt-live-chat-overlay-live-region > p'
              ),
              (element) => element.getAttribute('data-message-id') ?? ''
            ).slice(-32),
            debug: document.querySelector('#yt-chat-overlay-debug')?.textContent?.slice(0, 1_000),
            video: video
              ? { paused: video.paused, time: video.currentTime, error: video.error?.code ?? null }
              : null,
          };
        });
      } catch {
        // The page may have failed before the fixture document existed.
      }
    }
    try {
      await writeFile(
        join(output, 'native-tab-lifetime-failure.json'),
        JSON.stringify(
          {
            stage,
            error: errorText(error),
            observations,
            states,
            hiddenDurationsMs,
            requestFailures,
            requestFailureOverflow,
          },
          null,
          2
        )
      );
    } catch (diagnosticError) {
      primaryError = new AggregateError([error, diagnosticError], 'Native tab diagnostic failed');
    }
  }

  const cleanupErrors: unknown[] = [];
  try {
    page.off('requestfailed', onRequestFailed);
    cleanup.requestListenerRemoved = true;
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await page.bringToFront();
    cleanup.foregroundRestored = await page.evaluate(() => document.visibilityState === 'visible');
    assert.equal(cleanup.foregroundRestored, true);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cover) {
    try {
      await cover.close();
      cleanup.coverClosed = cover.isClosed();
      assert.equal(cleanup.coverClosed, true);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (focusSession) {
    try {
      await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      cleanup.playwrightFocusDefaultRestored = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await focusSession.detach();
      cleanup.focusSessionDetached = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    cleanup.settingsRestored = await page.evaluate((settings) => {
      const app = window.__ytChatOverlay;
      if (!app) throw new Error('Installed application disappeared during settings restoration');
      app.applySettings(settings);
      return JSON.stringify(app.getSettings()) === JSON.stringify(settings);
    }, previousSettings);
    assert.equal(cleanup.settingsRestored, true);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    cleanup.probeRemoved = await page.evaluate(() => {
      const probe = window.__ytNativeTabProbe;
      if (probe) {
        document.removeEventListener('visibilitychange', probe.onVisibility);
        window.removeEventListener('pageshow', probe.onPageShow);
        document.removeEventListener('resume', probe.onResume);
        document.getElementById('pip-pause')?.removeEventListener('click', probe.onPauseClick);
        document.getElementById('pip-play')?.removeEventListener('click', probe.onPlayClick);
        delete window.__ytNativeTabProbe;
      }
      return window.__ytNativeTabProbe === undefined;
    });
    assert.equal(cleanup.probeRemoved, true);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    try {
      await writeFile(
        join(output, 'native-tab-lifetime-cleanup-failure.json'),
        JSON.stringify(
          {
            stage,
            scenarioError: primaryError ? errorText(primaryError) : null,
            cleanupErrors: cleanupErrors.map(errorText),
            cleanup,
          },
          null,
          2
        )
      );
    } catch (diagnosticError) {
      cleanupErrors.push(diagnosticError);
    }
  }
  if (primaryError || cleanupErrors.length > 0)
    throw new AggregateError(
      [...(primaryError ? [primaryError] : []), ...cleanupErrors],
      `Native tab lifetime failed at ${stage}`
    );
  return {
    status: 'passed',
    scope: 'installed Edge extension, native trusted tab visibility and media controls',
    nativeFreezeClaim: false,
    syntheticLifecycleEvents: false,
    hiddenDurationsMs,
    states,
    requestFailures,
    requestFailureOverflow,
    cleanup,
  };
}
