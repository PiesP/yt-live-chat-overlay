// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  countUnexpectedLiveErrors,
  isTrustedTypesWorkerBlock,
  isYouTubeHostError,
  redactDiagnosticText,
  validateLiveRenderer,
} from './live-rendering.mjs';

const ACTIVE_MS = 300_000;
const HIDDEN_MS = 600_000;
const RESUMED_MS = 300_000;
const TOTAL_MS = ACTIVE_MS + HIDDEN_MS + RESUMED_MS;
const SAMPLE_MS = 30_000;
const PREFLIGHT_LIMIT_MS = 300_000;
const RESULT_FILE = 'live-duration-result.json';
const MAX_CONSOLE_ERRORS = 64;
const MAX_PAGE_ERRORS = 32;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function phaseMatches(sample, phase) {
  return phase === 'resumed' ? sample.phase.startsWith('resumed') : sample.phase === phase;
}

function healthySample(sample) {
  const expectedVisibility = sample.phase === 'hidden' ? 'hidden' : 'visible';
  return Boolean(
    sample.visibility === expectedVisibility &&
      sample.canvasAttached &&
      sample.installedBridgeReady &&
      sample.playerErrorUi?.visible === false &&
      sample.video &&
      sample.video.errorCode === null &&
      sample.video.muted &&
      !sample.video.paused &&
      sample.video.readyState >= 2
  );
}

export function summarizePhaseHealth(samples, phase) {
  const selected = samples.filter((sample) => phaseMatches(sample, phase));
  const healthy = selected.filter(healthySample);
  const times = selected
    .map((sample) => sample.video?.currentTime)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  const nonProgressingIntervalCount = times.slice(1).filter(
    (value, index) => value - times[index] < 1
  ).length;
  const reasons = [];
  if (selected.length < 2) reasons.push('insufficient-phase-samples');
  if (healthy.length !== selected.length) reasons.push('sample-health-incomplete');
  if (times.length !== selected.length || times.length < 2 || nonProgressingIntervalCount > 0) {
    reasons.push('media-time-not-progressing');
  }
  return {
    status: reasons.length === 0 ? 'observed' : 'unverified',
    reasons,
    sampleCount: selected.length,
    healthySampleCount: healthy.length,
    nonProgressingIntervalCount,
    // Position range includes seeks and resets; it is not elapsed playback time.
    mediaTimeRangeSeconds:
      times.length < 2 ? null : Math.max(...times) - Math.min(...times),
  };
}

export function classifyResumeFingerprint(before, after, observerLatencyMs) {
  if (before.count === 0 && after.count === 0) {
    return {
      status: 'not-run',
      reason: 'no-accessible-chat-observed',
      beforeCount: 0,
      afterCount: 0,
      observerLatencyMs: null,
    };
  }
  if (after.count === 0) {
    return {
      status: 'unverified',
      reason: 'accessible-render-missing-after-resume',
      beforeCount: before.count,
      afterCount: 0,
      fingerprintChanged: before.fingerprint !== after.fingerprint,
      observerLatencyMs: null,
    };
  }
  const changed = before.count !== after.count || before.fingerprint !== after.fingerprint;
  return {
    status: changed ? 'observed' : 'unverified',
    ...(changed ? {} : { reason: 'accessible-render-did-not-change' }),
    beforeCount: before.count,
    afterCount: after.count,
    fingerprintChanged: before.fingerprint !== after.fingerprint,
    observerLatencyMs: changed ? observerLatencyMs : null,
  };
}

export function durationEvidenceReasons({
  visibilityProof,
  samples,
  rendererValidation,
  playerControl,
  resumeAccessibleRender,
  pageErrorTypes,
  unexpectedConsoleErrors,
}) {
  const reasons = [];
  if (
    !Array.isArray(visibilityProof) ||
    !visibilityProof.some((value, index) =>
      value === 'hidden' &&
      visibilityProof.slice(0, index).includes('visible') &&
      visibilityProof.slice(index + 1).includes('visible')
    )
  ) {
    reasons.push('native-hidden-transition-unverified');
  }
  for (const phase of ['active', 'hidden', 'resumed']) {
    if (summarizePhaseHealth(samples, phase).status !== 'observed') {
      reasons.push(`${phase}-health-unverified`);
    }
  }
  if (rendererValidation?.status !== 'observed') reasons.push('renderer-unverified');
  if (playerControl?.status !== 'observed') reasons.push('player-controls-unverified');
  if (resumeAccessibleRender?.status !== 'observed') {
    reasons.push(
      resumeAccessibleRender?.status === 'not-run'
        ? 'accessible-chat-not-observed'
        : 'resume-accessible-render-unverified'
    );
  }
  if ((pageErrorTypes?.length ?? 0) > 0) reasons.push('page-errors-observed');
  if (unexpectedConsoleErrors > 0) reasons.push('unexpected-console-errors-observed');
  return reasons;
}

export function validateDurationLiveUrl(value) {
  assert.equal(typeof value, 'string', 'The duration live URL must be a string');
  assert(!/\s/u.test(value) && !value.includes('\\'), 'The duration live URL is unsafe');
  const url = new URL(value);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.host, 'www.youtube.com');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.hash, '');
  assert.match(url.pathname, /^(?:\/watch|\/live\/[A-Za-z0-9_-]{1,64})$/u);
  return url.href;
}

async function waitUntil(target) {
  while (performance.now() < target) {
    await sleep(Math.min(1_000, Math.max(1, target - performance.now())));
  }
}

async function waitForVideoState(locator, predicate, timeoutMs, delay) {
  const deadline = performance.now() + timeoutMs;
  let state;
  do {
    state = await locator.evaluate((video) => ({
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
      errorCode: video.error?.code ?? null,
      muted: video.muted,
      paused: video.paused,
      readyState: video.readyState,
    }));
    if (predicate(state)) return state;
    await delay(Math.min(100, Math.max(1, deadline - performance.now())));
  } while (performance.now() < deadline);
  throw new Error('Public player did not reach the requested bounded playback state');
}

export async function exercisePlayerPausePlay(
  page,
  { timeoutMs = 5_000, delay = sleep } = {}
) {
  const video = page.locator('video').first();
  const before = await video.evaluate((element) => ({
    currentTime: Number.isFinite(element.currentTime) ? element.currentTime : null,
    errorCode: element.error?.code ?? null,
    readyState: element.readyState,
  }));
  if (before.readyState < 2 || before.errorCode !== null) {
    throw new Error('Public player media is not ready for pause/play verification');
  }
  await video.evaluate((element) => element.pause());
  const paused = await waitForVideoState(video, (state) => state.paused, timeoutMs, delay);
  await video.evaluate((element) => {
    element.muted = true;
    // Some public-player promises remain pending. Playback state is checked separately.
    void element.play().catch(() => {});
  });
  const resumed = await waitForVideoState(
    video,
    (state) => !state.paused && state.readyState >= 2 && state.errorCode === null,
    timeoutMs,
    delay
  );
  return {
    status: 'observed',
    muted: resumed.muted,
    beforeTime: before.currentTime,
    pausedTime: paused.currentTime,
    resumedTime: resumed.currentTime,
  };
}

async function publicState(page) {
  return page.evaluate(() => {
    const video = document.querySelector('video');
    if (video instanceof HTMLVideoElement) video.muted = true;
    const playerError = [...document.querySelectorAll(
      '.ytp-error, .ytp-error-content-wrap, .ytp-error-content'
    )].some((element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        element.getClientRects().length > 0;
    });
    return {
      visibility: document.visibilityState,
      hud: document.querySelector('#yt-chat-overlay-debug')?.textContent
        ?.replace(/\s+/gu, ' ').trim() ?? null,
      canvasAttached:
        document.querySelectorAll('#yt-live-chat-overlay canvas').length === 1,
      accessibilityRenderedNodeCount: document.querySelectorAll(
        '.yt-live-chat-overlay-live-region > p'
      ).length,
      installedBridgeReady: Boolean(
        globalThis.__ytExtensionBridge?.workerSupported === true &&
          globalThis.__ytExtensionBridge?.storageType === 'chrome.storage.local' &&
          globalThis.__ytExtensionBridge?.workerUrl?.startsWith(`blob:${location.origin}/`)
      ),
      playerErrorUi: {
        visible: playerError,
        marker: playerError ? 'youtube-player-error-ui-visible' : null,
      },
      video: video instanceof HTMLVideoElement
        ? {
            currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
            errorCode: video.error?.code ?? null,
            muted: video.muted,
            paused: video.paused,
            readyState: video.readyState,
          }
        : null,
    };
  });
}

export function isInitialObservationReady(state) {
  return Boolean(
    state?.visibility === 'visible' &&
      state.canvasAttached &&
      state.installedBridgeReady &&
      state.playerErrorUi?.visible === false &&
      state.video?.errorCode === null &&
      state.video?.muted &&
      !state.video?.paused &&
      state.video?.readyState >= 2
  );
}

async function waitForInitialMedia(page, timeoutMs) {
  const started = performance.now();
  const deadline = started + timeoutMs;
  let first = null;
  let latest = null;
  do {
    latest = await publicState(page);
    first ??= latest;
    if (isInitialObservationReady(latest)) {
      return {
        status: 'observed',
        elapsedMs: performance.now() - started,
        first,
        latest,
      };
    }
    await sleep(Math.min(500, Math.max(1, deadline - performance.now())));
  } while (performance.now() < deadline);
  return {
    status: 'unverified',
    reason: 'healthy-public-media-and-overlay-readiness-timeout',
    elapsedMs: performance.now() - started,
    first,
    latest,
  };
}

async function accessibleFingerprint(page) {
  return page.evaluate(async () => {
    const nodes = [...document.querySelectorAll('.yt-live-chat-overlay-live-region > p')];
    const encoded = new TextEncoder().encode(
      nodes.map((node) => node.textContent ?? '').join('\u001f')
    );
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    return {
      count: nodes.length,
      fingerprint: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    };
  });
}

async function observeAccessibleChange(page, baseline, startedAt, deadline, signal) {
  let latest = baseline;
  while (!signal.aborted && performance.now() < deadline) {
    await sleep(Math.min(1_000, Math.max(1, deadline - performance.now())));
    if (signal.aborted) break;
    latest = await accessibleFingerprint(page);
    if (
      latest.count > 0 &&
      (latest.count !== baseline.count || latest.fingerprint !== baseline.fingerprint)
    ) {
      return classifyResumeFingerprint(
        baseline,
        latest,
        performance.now() - startedAt
      );
    }
  }
  return classifyResumeFingerprint(baseline, latest, null);
}

function rendererFromHud(hud) {
  if (typeof hud !== 'string' || !/Render:\s*(?:n\/a|[0-9.]+ms)/u.test(hud)) {
    return null;
  }
  return /Render:\s*n\/a/u.test(hud) ? 'worker' : 'main';
}

function failure(stage, error) {
  return { stage, errorType: error instanceof Error ? error.name : typeof error };
}

/** Observe one real public stream through a caller-owned, naturally focused context. */
export async function runLiveDuration({ context, url, output, installation = 'extension' }) {
  assert(context && typeof context.newPage === 'function', 'A caller-owned context is required');
  assert.equal(installation, 'extension');
  const liveUrl = validateDurationLiveUrl(url);
  const progressStarted = performance.now();
  const result = {
    schemaVersion: 1,
    kind: 'public-youtube-installed-extension-duration-observation',
    status: 'failed',
    evidenceStatus: 'unverified',
    scenario: {
      liveUrl,
      activeMs: ACTIVE_MS,
      hiddenMs: HIDDEN_MS,
      resumedMs: RESUMED_MS,
      totalMs: TOTAL_MS,
      sampleIntervalMs: SAMPLE_MS,
      preflightLimitMs: PREFLIGHT_LIMIT_MS,
      hiddenMechanism: 'second-real-tab-foreground',
      playwrightDefaultsSkipped: 'connectOverCDP-noDefaults',
      syntheticMessagesOrRoutes: false,
      videoAudio: 'muted',
    },
    preflight: {},
    samples: [],
    transitions: [],
    playerControl: { status: 'not-run' },
    resumeAccessibleRender: { status: 'not-run' },
    rendererValidation: { status: 'unverified', reason: 'renderer-hud-unavailable' },
    diagnostics: {},
    failures: [],
    limitations: [
      'One public stream, installed Chrome version, and VM desktop session are observed.',
      'Public chat volume is uncontrolled; an interval without chat is recorded as unverified.',
      'A YouTube player error marker records host UI state without attributing a product cause.',
      'No synthetic chat, route interception, account interaction, or TLS change is used.',
    ],
  };
  const persist = async (stage, state) => {
    result.progress = {
      stage,
      state,
      elapsedMs: performance.now() - progressStarted,
      sampleCount: result.samples.length,
    };
    const pending = join(output, `.${RESULT_FILE}.next`);
    await writeFile(pending, JSON.stringify(result, null, 2), { flush: true });
    await rename(pending, join(output, RESULT_FILE));
  };
  const remainingPreflight = (requestedMs) => {
    const remaining = PREFLIGHT_LIMIT_MS - (performance.now() - progressStarted);
    if (remaining <= 0) throw new Error('Duration observation preflight exceeded five minutes');
    return Math.max(1, Math.min(requestedMs, Math.floor(remaining)));
  };

  const consoleErrors = [];
  const pageErrors = [];
  let consoleOverflow = 0;
  let pageErrorOverflow = 0;
  const captureDiagnostics = (workerFallback) => ({
    pageErrorTypes: [...new Set(pageErrors)],
    pageErrorOverflow,
    unexpectedConsoleErrors:
      consoleOverflow + countUnexpectedLiveErrors(consoleErrors, workerFallback),
    hostConsoleErrors: consoleErrors.filter(isYouTubeHostError).length,
    consoleErrors: consoleErrors.map(({ type, text, url: errorUrl }) => ({
      type,
      text: redactDiagnosticText(text),
      url: redactDiagnosticText(errorUrl),
    })),
  });
  let page;
  let background;
  let resumeObserver;
  let resumeObserverController;
  let stage = 'preflight:create-page';
  try {
    await persist(stage, 'before');
    page = await context.newPage();
    background = await context.newPage();
    page.on('pageerror', (error) => {
      if (pageErrors.length < MAX_PAGE_ERRORS) pageErrors.push(error.name || 'Error');
      else pageErrorOverflow++;
    });
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (consoleErrors.length < MAX_CONSOLE_ERRORS) {
        consoleErrors.push({
          type: 'error',
          text: message.text().slice(0, 2_000),
          url: message.location().url,
        });
      } else consoleOverflow++;
    });
    stage = 'preflight:navigate-public-stream';
    await persist(stage, 'before');
    await page.bringToFront();
    await page.goto(liveUrl, {
      waitUntil: 'domcontentloaded',
      timeout: remainingPreflight(45_000),
    });
    const consent = page.getByRole('button', { name: 'Reject all', exact: true });
    result.preflight.consentBarrier = {
      visible: await consent.isVisible().catch(() => false),
      actionTaken: false,
    };
    assert.equal(
      result.preflight.consentBarrier.visible,
      false,
      'Public observation is blocked by a consent prompt'
    );
    await page.locator('#movie_player').waitFor({
      state: 'visible',
      timeout: remainingPreflight(30_000),
    });
    await page.locator('video').first().evaluate((video) => {
      video.muted = true;
      void video.play().catch(() => {});
    });
    result.preflight.mediaReadiness = await waitForInitialMedia(
      page,
      remainingPreflight(90_000)
    );
    assert.equal(
      result.preflight.mediaReadiness.status,
      'observed',
      'Public player and installed overlay did not reach bounded readiness'
    );
    result.preflight.initialState = await publicState(page);

    await background.goto('data:text/html,<title>duration-observation-background</title>', {
      waitUntil: 'domcontentloaded',
      timeout: remainingPreflight(10_000),
    });
    result.preflight.visibilityProof = [];
    for (const [target, expected] of [
      [page, 'visible'],
      [background, 'hidden'],
      [page, 'visible'],
    ]) {
      await target.bringToFront();
      await page.waitForFunction(
        (visibility) => document.visibilityState === visibility,
        expected,
        { timeout: remainingPreflight(5_000), polling: 100 }
      );
      result.preflight.visibilityProof.push((await publicState(page)).visibility);
    }
    assert.deepEqual(
      result.preflight.visibilityProof,
      ['visible', 'hidden', 'visible'],
      'Native tab visibility preflight did not complete'
    );
    result.preflight.elapsedMs = performance.now() - progressStarted;
    await persist('preflight:complete', 'after');

    stage = 'observe:active';
    const started = performance.now();
    const sample = async (phase, scheduledElapsedMs) => {
      stage = `observe:sample:${phase}:${result.samples.length}`;
      const state = await publicState(page);
      result.samples.push({
        index: result.samples.length,
        phase,
        scheduledElapsedMs,
        elapsedMs: performance.now() - started,
        ...state,
      });
      await persist(stage, 'after');
    };
    for (let offset = 0; offset <= ACTIVE_MS; offset += SAMPLE_MS) {
      await waitUntil(started + offset);
      await sample('active', offset);
    }

    const hiddenStarted = performance.now();
    await background.bringToFront();
    await page.waitForFunction(() => document.visibilityState === 'hidden', undefined, {
      timeout: 5_000,
      polling: 100,
    });
    result.transitions.push({
      from: 'active',
      to: 'hidden',
      scheduledElapsedMs: ACTIVE_MS,
      observedElapsedMs: performance.now() - started,
      observerTransitionMs: performance.now() - hiddenStarted,
      visibility: 'hidden',
    });
    await persist('observe:transition-hidden', 'after');
    for (
      let offset = ACTIVE_MS + SAMPLE_MS;
      offset <= ACTIVE_MS + HIDDEN_MS;
      offset += SAMPLE_MS
    ) {
      await waitUntil(started + offset);
      await sample('hidden', offset);
    }

    const beforeResume = await accessibleFingerprint(page);
    const resumeStarted = performance.now();
    await page.bringToFront();
    await page.waitForFunction(() => document.visibilityState === 'visible', undefined, {
      timeout: 5_000,
      polling: 100,
    });
    const resumedAt = performance.now();
    result.transitions.push({
      from: 'hidden',
      to: 'resumed',
      scheduledElapsedMs: ACTIVE_MS + HIDDEN_MS,
      observedElapsedMs: resumedAt - started,
      observerTransitionMs: resumedAt - resumeStarted,
      visibility: 'visible',
    });
    result.resumeAccessibleRender = {
      status: 'observing',
      beforeCount: beforeResume.count,
      beforeFingerprint: beforeResume.fingerprint,
      observerLatencyMs: null,
    };
    resumeObserverController = new AbortController();
    resumeObserver = observeAccessibleChange(
      page,
      beforeResume,
      resumedAt,
      started + TOTAL_MS,
      resumeObserverController.signal
    ).catch((error) => ({
      status: 'unverified',
      reason: 'accessible-render-observer-failed',
      errorType: error instanceof Error ? error.name : typeof error,
      observerLatencyMs: null,
    }));
    await persist('observe:transition-resumed', 'after');
    try {
      result.playerControl = await exercisePlayerPausePlay(page);
    } catch (error) {
      result.playerControl = { status: 'unverified', reason: 'player-controls-unavailable' };
      result.failures.push(failure('observe:player-pause-play', error));
    }
    await persist('observe:player-pause-play', 'after');
    for (
      let offset = ACTIVE_MS + HIDDEN_MS + SAMPLE_MS;
      offset <= TOTAL_MS;
      offset += SAMPLE_MS
    ) {
      await waitUntil(started + offset);
      await sample(offset === TOTAL_MS ? 'resumed-final' : 'resumed', offset);
    }
    result.resumeAccessibleRender = await resumeObserver;
    resumeObserver = null;
    result.phaseHealth = Object.fromEntries(
      ['active', 'hidden', 'resumed'].map((phase) => [
        phase,
        summarizePhaseHealth(result.samples, phase),
      ])
    );
    const final = result.samples.at(-1);
    const renderer = rendererFromHud(final?.hud);
    const workerDiagnostics = consoleErrors.filter((entry) =>
      /worker|TrustedScriptURL/iu.test(entry.text)
    );
    if (renderer) {
      try {
        result.rendererValidation = {
          status: 'observed',
          ...validateLiveRenderer(
            renderer,
            installation,
            workerDiagnostics,
            final?.installedBridgeReady === true
          ),
        };
      } catch (error) {
        result.failures.push(failure('observe:renderer-validation', error));
      }
    }
    result.trustedTypesMainFallback = {
      observed: result.rendererValidation.workerPolicyFallback === true,
      diagnosticCount: workerDiagnostics.filter(isTrustedTypesWorkerBlock).length,
    };
    result.diagnostics = captureDiagnostics(
      result.rendererValidation.workerPolicyFallback === true
    );
    result.observation = {
      plannedMs: TOTAL_MS,
      elapsedMs: performance.now() - started,
      sampleCount: result.samples.length,
    };
    result.evidenceStatusReasons = durationEvidenceReasons({
      visibilityProof: result.preflight.visibilityProof,
      samples: result.samples,
      rendererValidation: result.rendererValidation,
      playerControl: result.playerControl,
      resumeAccessibleRender: result.resumeAccessibleRender,
      pageErrorTypes: [
        ...result.diagnostics.pageErrorTypes,
        ...Array.from({ length: pageErrorOverflow }, () => 'overflow'),
      ],
      unexpectedConsoleErrors: result.diagnostics.unexpectedConsoleErrors,
    });
    result.status = 'completed';
    result.evidenceStatus =
      result.evidenceStatusReasons.length === 0 ? 'observed' : 'unverified';
    await page.screenshot({
      path: join(output, 'live-duration-final.png'),
      animations: 'disabled',
    }).catch(() => {});
    await persist('observe:complete', 'after');
    return result;
  } catch (error) {
    result.failures.push(failure(stage, error));
    result.status = 'failed';
    result.evidenceStatus = 'unverified';
    result.diagnostics = captureDiagnostics(false);
    if (page && !page.isClosed()) {
      result.failureState = await publicState(page).catch(() => null);
      await page.screenshot({
        path: join(output, 'live-duration-failure.png'),
        animations: 'disabled',
        timeout: 3_000,
      }).catch(() => {});
    }
    await persist(`failure:${stage}`, 'after').catch(() => {});
    throw new Error(`Duration observation failed during ${stage}`, { cause: error });
  } finally {
    resumeObserverController?.abort();
    await resumeObserver?.catch(() => {});
    await background?.close().catch(() => {});
    await page?.close().catch(() => {});
  }
}
