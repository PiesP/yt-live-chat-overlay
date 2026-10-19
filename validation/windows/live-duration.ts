// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { BrowserContext, ElementHandle, Page } from '@playwright/test';

import {
  countUnexpectedLiveErrors,
  isTrustedTypesWorkerBlock,
  isYouTubeHostError,
  redactDiagnosticText,
  validateLiveRenderer,
} from './live-rendering.ts';
import type { LiveDiagnosticEntry } from './live-rendering.ts';
import {
  createNativeMuteBoundary,
  establishOwnedMute,
  playOwnedMutedVideo,
} from './native-player-mute.ts';
import type { NativeMuteBoundary } from './native-player-mute.ts';
import type { BoundedNativeAction } from './native-player-mute.ts';

type HealthSample = {
  phase: string;
  visibility?: string;
  canvasAttached?: boolean;
  installedBridgeReady?: boolean;
  playerErrorUi?: { visible: boolean; marker?: string | null };
  video?: {
    currentTime: number | null;
    errorCode: number | null;
    muted: boolean;
    paused: boolean;
    readyState: number;
  } | null;
};

type Fingerprint = { count: number; fingerprint: string };
type ObservationStatus = { status: string; reason?: string };
type DurationSample = HealthSample & {
  index: number;
  scheduledElapsedMs: number;
  elapsedMs: number;
  hud: string | null;
};
type DurationDiagnostics = {
  pageErrorTypes: string[];
  pageErrorOverflow: number;
  unexpectedConsoleErrors: number;
  hostConsoleErrors: number;
  consoleErrors: { type: string; text: string; url: string }[];
};
type DurationResult = {
  schemaVersion: number;
  kind: string;
  status: string;
  evidenceStatus: string;
  scenario: Record<string, string | number | boolean>;
  preflight: {
    consentBarrier?: { visible: boolean; actionTaken: boolean };
    mediaReadiness?: Awaited<ReturnType<typeof waitForInitialMedia>>;
    startupControl?: Awaited<ReturnType<typeof establishOwnedMute>>;
    nativeMuteClickIntent?: {
      status: 'recorded-before-click';
      before: Awaited<ReturnType<typeof establishOwnedMute>>['before'];
    };
    nativeMuteBoundary?: NativeMuteBoundary;
    initialOwnedPlay?: ReturnType<typeof playOwnedMutedVideo>;
    initialState?: Awaited<ReturnType<typeof publicState>>;
    visibilityProof?: string[];
    elapsedMs?: number;
  };
  samples: DurationSample[];
  transitions: {
    from: string;
    to: string;
    scheduledElapsedMs: number;
    observedElapsedMs: number;
    observerTransitionMs: number;
    visibility: string;
  }[];
  playerControl: ObservationStatus;
  resumeAccessibleRender: ObservationStatus & {
    beforeCount?: number;
    beforeFingerprint?: string;
    observerLatencyMs?: number | null;
  };
  rendererValidation: ObservationStatus & { renderer?: string; workerPolicyFallback?: boolean };
  diagnostics: Partial<DurationDiagnostics>;
  failures: { stage: string; errorType: string; reason?: string }[];
  limitations: string[];
  progress?: { stage: string; state: string; elapsedMs: number; sampleCount: number };
  phaseHealth?: Record<string, ReturnType<typeof summarizePhaseHealth>>;
  trustedTypesMainFallback?: { observed: boolean; diagnosticCount: number };
  observation?: { plannedMs: number; elapsedMs: number; sampleCount: number };
  evidenceStatusReasons?: string[];
  failureState?: Awaited<ReturnType<typeof publicState>> | null;
  failurePlayerDom?: Awaited<ReturnType<typeof captureFailurePlayerDom>> | null;
};

declare global {
  var __ytExtensionBridge:
    | { workerSupported?: boolean; storageType?: string; workerUrl?: string }
    | undefined;
}

const ACTIVE_MS = 300_000;
const HIDDEN_MS = 600_000;
const RESUMED_MS = 300_000;
const TOTAL_MS = ACTIVE_MS + HIDDEN_MS + RESUMED_MS;
const SAMPLE_MS = 30_000;
const PREFLIGHT_LIMIT_MS = 300_000;
const RESULT_FILE = 'live-duration-result.json';
const MAX_CONSOLE_ERRORS = 64;
const MAX_PAGE_ERRORS = 32;

export function initialMediaDeadline(setupStartedMs: number, preflightStartedMs: number) {
  return Math.min(setupStartedMs + 90_000, preflightStartedMs + PREFLIGHT_LIMIT_MS);
}

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

function phaseMatches(sample: HealthSample, phase: string) {
  return phase === 'resumed' ? sample.phase.startsWith('resumed') : sample.phase === phase;
}

function healthySample(sample: HealthSample) {
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

export function summarizePhaseHealth(samples: HealthSample[], phase: string) {
  const selected = samples.filter((sample) => phaseMatches(sample, phase));
  const healthy = selected.filter(healthySample);
  const times = selected
    .map((sample) => sample.video?.currentTime)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const nonProgressingIntervalCount = times
    .slice(1)
    .filter((value, index) => value - (times[index] ?? value) < 1).length;
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
    mediaTimeRangeSeconds: times.length < 2 ? null : Math.max(...times) - Math.min(...times),
  };
}

export function classifyResumeFingerprint(
  before: Fingerprint,
  after: Fingerprint,
  observerLatencyMs: number | null
) {
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
}: {
  visibilityProof?: string[];
  samples: HealthSample[];
  rendererValidation?: ObservationStatus;
  playerControl?: ObservationStatus;
  resumeAccessibleRender?: ObservationStatus;
  pageErrorTypes?: string[];
  unexpectedConsoleErrors: number;
}) {
  const reasons = [];
  if (
    !Array.isArray(visibilityProof) ||
    !visibilityProof.some(
      (value, index) =>
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

export function validateDurationLiveUrl(value: unknown) {
  assert(typeof value === 'string', 'The duration live URL must be a string');
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

export function requiredDurationVideoId(liveUrl: string): string {
  const url = new URL(validateDurationLiveUrl(liveUrl));
  const ids =
    url.pathname === '/watch'
      ? url.searchParams.getAll('v')
      : [url.pathname.slice('/live/'.length)];
  assert.equal(ids.length, 1, 'Duration URL must identify exactly one public video');
  const [id] = ids;
  assert(id);
  assert.match(id ?? '', /^[A-Za-z0-9_-]{1,64}$/u, 'Duration URL must identify one public video');
  return id;
}

async function waitUntil(target: number) {
  while (performance.now() < target) {
    await sleep(Math.min(1_000, Math.max(1, target - performance.now())));
  }
}

async function waitForVideoState(
  binding: PublicPlayerBinding,
  predicate: (state: VideoState) => boolean,
  timeoutMs: number,
  delay: (ms: number) => Promise<void>
) {
  const deadline = performance.now() + timeoutMs;
  let state;
  do {
    state = (await evaluatePublicVideo(binding, 'read')).after;
    if (predicate(state)) return state;
    await delay(Math.min(100, Math.max(1, deadline - performance.now())));
  } while (performance.now() < deadline);
  throw new Error('Public player did not reach the requested bounded playback state');
}

type VideoState = {
  currentTime: number | null;
  errorCode: number | null;
  muted: boolean;
  paused: boolean;
  readyState: number;
};
type PublicVideoAction = 'read' | 'pause' | 'play';
type PublicPlayerBinding = {
  player: ElementHandle<Element>;
  video: ElementHandle<HTMLVideoElement>;
};

export function observePublicVideo(
  video: HTMLVideoElement,
  { player, action }: { player: unknown; action: PublicVideoAction }
) {
  const players = document.querySelectorAll('#movie_player');
  const videos = player instanceof Element ? player.querySelectorAll('video') : null;
  if (
    !(video instanceof HTMLVideoElement) ||
    !(player instanceof Element) ||
    player.ownerDocument !== document ||
    !player.isConnected ||
    players.length !== 1 ||
    players[0] !== player ||
    video.ownerDocument !== document ||
    !video.isConnected ||
    videos?.length !== 1 ||
    videos[0] !== video
  ) {
    throw new Error('Owned public player video is absent, ambiguous, or replaced');
  }
  const state = (): VideoState => ({
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
    errorCode: video.error?.code ?? null,
    muted: video.muted,
    paused: video.paused,
    readyState: video.readyState,
  });
  const before = state();
  if (action === 'pause') {
    video.pause();
  } else if (action === 'play') {
    // Some public-player promises remain pending. Playback state is checked separately.
    void video.play().catch(() => {});
  }
  return { action, before, after: state() };
}

function evaluatePublicVideo(binding: PublicPlayerBinding, action: PublicVideoAction) {
  return binding.video.evaluate<
    ReturnType<typeof observePublicVideo>,
    { player: unknown; action: PublicVideoAction }
  >(observePublicVideo, { player: binding.player, action });
}

async function actOnPublicVideo(binding: PublicPlayerBinding, action: 'pause' | 'play') {
  return evaluatePublicVideo(binding, action);
}

export async function exercisePlayerPausePlay(
  binding: PublicPlayerBinding,
  {
    timeoutMs = 5_000,
    delay = sleep,
  }: {
    timeoutMs?: number;
    delay?: (ms: number) => Promise<void>;
  } = {}
) {
  const before = (await evaluatePublicVideo(binding, 'read')).after;
  if (before.readyState < 2 || before.errorCode !== null || !before.muted || before.paused) {
    throw new Error('Public player media is not ready for pause/play verification');
  }
  const pauseAction = await actOnPublicVideo(binding, 'pause');
  const paused = await waitForVideoState(binding, (state) => state.paused, timeoutMs, delay);
  const playAction = await actOnPublicVideo(binding, 'play');
  const resumed = await waitForVideoState(
    binding,
    (state) => !state.paused && state.muted && state.readyState >= 2 && state.errorCode === null,
    timeoutMs,
    delay
  );
  return {
    status: 'observed',
    muted: resumed.muted,
    before,
    pauseAction,
    playAction,
    paused,
    resumed,
    beforeTime: before.currentTime,
    pausedTime: paused.currentTime,
    resumedTime: resumed.currentTime,
  };
}

export function readPublicDurationPageState(owned?: { player: unknown; video: unknown }) {
  const players = document.querySelectorAll('#movie_player');
  const player = players.length === 1 ? players[0] : null;
  const videos = player?.querySelectorAll('video');
  const video = owned?.video ?? (videos?.length === 1 ? videos[0] : null);
  if (
    owned &&
    (!(owned.player instanceof Element) ||
      owned.player.ownerDocument !== document ||
      !owned.player.isConnected ||
      players.length !== 1 ||
      player !== owned.player ||
      !(owned.video instanceof HTMLVideoElement) ||
      owned.video.ownerDocument !== document ||
      !owned.video.isConnected ||
      !player?.isConnected ||
      videos?.length !== 1 ||
      videos[0] !== owned.video)
  ) {
    throw new Error('Owned public player video is absent, ambiguous, or replaced');
  }
  if (players.length > 1 || (videos?.length ?? 0) > 1) {
    throw new Error('Public player video is ambiguous');
  }
  const visibleError = [
    {
      marker: 'youtube-player-error-ui-visible',
      selector: '.ytp-error, .ytp-error-content-wrap, .ytp-error-content',
    },
    {
      marker: 'youtube-playability-error-ui-visible',
      selector: '#player yt-playability-error-supported-renderers#error-screen',
    },
  ].find(({ selector }) =>
    [...document.querySelectorAll(selector)].some((element) => {
      const style = getComputedStyle(element);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        element.getClientRects().length > 0
      );
    })
  );
  const playerWithData = player as
    | (Element & { getVideoData?: () => { video_id?: unknown } })
    | null;
  const playerData =
    typeof playerWithData?.getVideoData === 'function' ? playerWithData.getVideoData() : null;
  return {
    visibility: document.visibilityState,
    playerVideoId: typeof playerData?.video_id === 'string' ? playerData.video_id : null,
    adShowing: player ? player.classList.contains('ad-showing') : null,
    hud:
      document.querySelector('#yt-chat-overlay-debug')?.textContent?.replace(/\s+/gu, ' ').trim() ??
      null,
    canvasAttached: document.querySelectorAll('#yt-live-chat-overlay canvas').length === 1,
    accessibilityRenderedNodeCount: document.querySelectorAll(
      '.yt-live-chat-overlay-live-region > p'
    ).length,
    installedBridgeReady: Boolean(
      globalThis.__ytExtensionBridge?.workerSupported === true &&
      globalThis.__ytExtensionBridge?.storageType === 'chrome.storage.local' &&
      globalThis.__ytExtensionBridge?.workerUrl?.startsWith(`blob:${location.origin}/`)
    ),
    playerErrorUi: {
      visible: Boolean(visibleError),
      marker: visibleError?.marker ?? null,
    },
    video:
      video instanceof HTMLVideoElement
        ? {
            currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
            errorCode: video.error?.code ?? null,
            muted: video.muted,
            paused: video.paused,
            readyState: video.readyState,
          }
        : null,
  };
}

async function publicState(page: Page, binding: PublicPlayerBinding) {
  return page.evaluate(readPublicDurationPageState, binding);
}

/** Capture bounded player-error structure without page, account, or chat content. */
export async function captureFailurePlayerDom(page: Page, owned?: PublicPlayerBinding) {
  const snapshot = await page.evaluate(
    (binding: { player: unknown; video: unknown } | undefined) => {
      const players = document.querySelectorAll('#movie_player');
      const player = players.length === 1 ? players[0] : null;
      const providerRoots = [
        ...document.querySelectorAll(
          'yt-playability-error-supported-renderers, ytd-player-error-message-renderer'
        ),
      ];
      const elements = [
        ...(player ? [player, ...player.querySelectorAll('*')] : []),
        ...providerRoots.flatMap((root) => [root, ...root.querySelectorAll('*')]),
      ];
      const markerPattern = /error|unavailable|playability|message|alert|status/iu;
      const textPattern =
        /video unavailable|live stream recording is not available|an error occurred/iu;
      const boundedAttribute = (value: string | null) =>
        value?.replace(/[^a-z0-9_-]/giu, '_').slice(0, 64) ?? null;
      const describe = (element: Element) => {
        const style = getComputedStyle(element);
        const rectangle = element.getBoundingClientRect();
        const rectCount = element.getClientRects().length;
        return {
          tag: element.tagName.toLowerCase(),
          id: boundedAttribute(element.id),
          classes: [...element.classList].slice(0, 8).map((value) => boundedAttribute(value)),
          role: boundedAttribute(element.getAttribute('role')),
          ariaHidden: element.getAttribute('aria-hidden')?.slice(0, 8) ?? null,
          hidden: element.hasAttribute('hidden'),
          display: style.display.slice(0, 32),
          visibility: style.visibility.slice(0, 32),
          rectCount: Math.min(rectCount, 999),
          width: Math.round(rectangle.width),
          height: Math.round(rectangle.height),
          visible: style.display !== 'none' && style.visibility !== 'hidden' && rectCount > 0,
        };
      };
      const candidates = elements
        .filter((element) => {
          const structural = [
            element.tagName,
            element.id,
            ...element.classList,
            element.getAttribute('role') ?? '',
          ].some((value) => markerPattern.test(value));
          const leafText = element.children.length === 0 ? (element.textContent ?? '') : '';
          return structural || textPattern.test(leafText);
        })
        .map((element) => {
          const path = [];
          for (let current: Element | null = element; current && path.length < 6;) {
            path.push(describe(current));
            current = current.parentElement;
          }
          const leafText = element.children.length === 0 ? (element.textContent ?? '') : '';
          return {
            path,
            errorText: textPattern.test(leafText)
              ? leafText.replace(/\s+/gu, ' ').trim().slice(0, 160)
              : null,
          };
        })
        .sort((first, second) => Number(second.path[0]?.visible) - Number(first.path[0]?.visible))
        .slice(0, 24);
      const response = (
        globalThis as typeof globalThis & {
          ytInitialPlayerResponse?: {
            playabilityStatus?: { status?: unknown; reason?: unknown };
          };
        }
      ).ytInitialPlayerResponse;
      const status = response?.playabilityStatus?.status;
      const reason = response?.playabilityStatus?.reason;
      const playerVideos = player?.querySelectorAll('video');
      const media =
        binding &&
        binding.player === player &&
        binding.video instanceof HTMLVideoElement &&
        binding.video.ownerDocument === document &&
        binding.video.isConnected &&
        player?.isConnected &&
        playerVideos?.length === 1 &&
        playerVideos[0] === binding.video
          ? binding.video
          : null;
      return {
        playerFound: Boolean(player),
        playerAmbiguous: players.length > 1,
        providerStatusSource: 'ytInitialPlayerResponse-initial',
        mediaIdentity: media ? 'owned' : 'unavailable',
        providerStatus: typeof status === 'string' ? boundedAttribute(status) : null,
        providerReason: typeof reason === 'string' ? reason.slice(0, 160) : null,
        mediaNetworkState: media instanceof HTMLVideoElement ? media.networkState : null,
        mediaErrorCode: media instanceof HTMLVideoElement ? (media.error?.code ?? null) : null,
        candidates,
      };
    },
    owned
  );
  return {
    ...snapshot,
    providerReason: snapshot.providerReason ? redactDiagnosticText(snapshot.providerReason) : null,
    candidates: snapshot.candidates.map((candidate) => ({
      ...candidate,
      errorText: candidate.errorText ? redactDiagnosticText(candidate.errorText) : null,
    })),
  };
}

export function isInitialObservationReady(state: Partial<HealthSample> | null) {
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

async function waitForInitialMedia(
  page: Page,
  binding: PublicPlayerBinding,
  expectedVideoId: string,
  deadlineMs: number,
  bounded: BoundedNativeAction
) {
  const started = performance.now();
  let first = null;
  let latest = null;
  while (performance.now() < deadlineMs) {
    latest = await bounded(() => publicState(page, binding), 'read-initial-media', 3_000);
    first ??= latest;
    assert(
      latest.playerVideoId === expectedVideoId &&
        latest.adShowing === false &&
        latest.playerErrorUi.visible === false &&
        latest.video?.errorCode === null &&
        latest.video?.muted === true,
      'Owned player lost native mute, main identity, or error-free state during readiness'
    );
    if (isInitialObservationReady(latest)) {
      return {
        status: 'observed',
        elapsedMs: performance.now() - started,
        first,
        latest,
      };
    }
    await sleep(Math.min(500, Math.max(1, deadlineMs - performance.now())));
  }
  return {
    status: 'unverified',
    reason: 'healthy-public-media-and-overlay-readiness-timeout',
    elapsedMs: performance.now() - started,
    first,
    latest,
  };
}

async function accessibleFingerprint(page: Page): Promise<Fingerprint> {
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

async function observeAccessibleChange(
  page: Page,
  baseline: Fingerprint,
  startedAt: number,
  deadline: number,
  signal: AbortSignal
) {
  let latest = baseline;
  while (!signal.aborted && performance.now() < deadline) {
    await sleep(Math.min(1_000, Math.max(1, deadline - performance.now())));
    if (signal.aborted) break;
    latest = await accessibleFingerprint(page);
    if (
      latest.count > 0 &&
      (latest.count !== baseline.count || latest.fingerprint !== baseline.fingerprint)
    ) {
      return classifyResumeFingerprint(baseline, latest, performance.now() - startedAt);
    }
  }
  return classifyResumeFingerprint(baseline, latest, null);
}

function rendererFromHud(hud: string | null | undefined) {
  if (typeof hud !== 'string' || !/Render:\s*(?:n\/a|[0-9.]+ms)/u.test(hud)) {
    return null;
  }
  return /Render:\s*n\/a/u.test(hud) ? 'worker' : 'main';
}

function failure(stage: string, error: unknown) {
  return {
    stage,
    errorType: error instanceof Error ? error.name : typeof error,
    ...(error instanceof Error &&
    error.message === 'Owned public player video is absent, ambiguous, or replaced'
      ? { reason: 'owned-public-video-lost' }
      : {}),
  };
}

/** Observe one real public stream through a caller-owned, naturally focused context. */
export async function runLiveDuration({
  context,
  url,
  output,
  installation = 'extension',
}: {
  context: BrowserContext;
  url: string;
  output: string;
  installation?: 'extension';
}) {
  assert(context && typeof context.newPage === 'function', 'A caller-owned context is required');
  assert.equal(installation, 'extension');
  const liveUrl = validateDurationLiveUrl(url);
  const expectedVideoId = requiredDurationVideoId(liveUrl);
  const progressStarted = performance.now();
  const result: DurationResult = {
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
  const persist = async (stage: string, state: string) => {
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
  const remainingPreflight = (requestedMs: number) => {
    const remaining = PREFLIGHT_LIMIT_MS - (performance.now() - progressStarted);
    if (remaining <= 0) throw new Error('Duration observation preflight exceeded five minutes');
    return Math.max(1, Math.min(requestedMs, Math.floor(remaining)));
  };

  const consoleErrors: LiveDiagnosticEntry[] = [];
  const pageErrors: string[] = [];
  let consoleOverflow = 0;
  let pageErrorOverflow = 0;
  const captureDiagnostics = (workerFallback: boolean): DurationDiagnostics => ({
    pageErrorTypes: [...new Set(pageErrors)],
    pageErrorOverflow,
    unexpectedConsoleErrors:
      consoleOverflow + countUnexpectedLiveErrors(consoleErrors, workerFallback),
    hostConsoleErrors: consoleErrors.filter(isYouTubeHostError).length,
    consoleErrors: consoleErrors.map(({ type, text, url: errorUrl }) => ({
      type: type ?? 'error',
      text: redactDiagnosticText(text),
      url: redactDiagnosticText(errorUrl ?? ''),
    })),
  });
  let page: Page | undefined;
  let background: Page | undefined;
  let ownedPlayer: ElementHandle<Element> | undefined;
  let ownedVideo: ElementHandle<HTMLVideoElement> | undefined;
  let ownedBinding: PublicPlayerBinding | undefined;
  let resumeObserver: Promise<ObservationStatus> | undefined;
  let resumeObserverController: AbortController | undefined;
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
    stage = 'preflight:bind-public-player';
    ownedPlayer = (await page.locator('#movie_player').elementHandle({
      timeout: remainingPreflight(30_000),
    })) as ElementHandle<Element>;
    ownedVideo = (await page.locator('#movie_player video').elementHandle({
      timeout: remainingPreflight(30_000),
    })) as ElementHandle<HTMLVideoElement>;
    ownedBinding = { player: ownedPlayer, video: ownedVideo };
    const mediaReadinessDeadline = initialMediaDeadline(performance.now(), progressStarted);
    const setupPage = page;
    const setupBinding = ownedBinding;
    const nativeBoundary: NativeMuteBoundary = {
      timedOut: false,
      pendingUncertain: 0,
      lateSettlements: 0,
    };
    result.preflight.nativeMuteBoundary = nativeBoundary;
    const bounded = createNativeMuteBoundary({
      deadlineMs: mediaReadinessDeadline,
      controller: nativeBoundary,
    });
    stage = 'preflight:wait-native-mute-precondition';
    while (true) {
      const state = await bounded(
        () => publicState(setupPage, setupBinding),
        'read-native-mute-precondition',
        3_000
      );
      assert(
        state.adShowing === false &&
          state.playerErrorUi.visible === false &&
          state.video?.errorCode === null,
        'Public player ad or error blocks native mute setup'
      );
      if (state.playerVideoId !== null && state.playerVideoId !== expectedVideoId) {
        throw new Error('Public player video identity differs from the admitted URL');
      }
      if (state.playerVideoId === expectedVideoId && state.video && state.video.readyState > 0)
        break;
      await sleep(Math.min(300, Math.max(1, mediaReadinessDeadline - performance.now())));
    }
    stage = 'preflight:start-public-media';
    result.preflight.startupControl = await establishOwnedMute({
      page: setupPage,
      binding: setupBinding,
      expectedVideoId,
      bounded,
      beforeClick: async (before) => {
        assert.equal(
          result.preflight.nativeMuteClickIntent,
          undefined,
          'Native mute click already intended'
        );
        result.preflight.nativeMuteClickIntent = { status: 'recorded-before-click', before };
        await persist('preflight:native-mute-before-click', 'before');
      },
    });
    await bounded(
      () => persist('preflight:native-mute-verified', 'after'),
      'persist-native-mute-proof',
      3_000
    );
    if (result.preflight.startupControl.after.paused) {
      result.preflight.initialOwnedPlay = await bounded(
        () =>
          setupBinding.video.evaluate(playOwnedMutedVideo, {
            player: setupBinding.player,
            expectedVideoId,
          }),
        'initial-owned-play',
        3_000
      );
      assert(
        result.preflight.initialOwnedPlay.before.muted === true &&
          result.preflight.initialOwnedPlay.after.muted === true,
        'Owned play lost verified native mute state'
      );
      await bounded(() => persist('preflight:owned-play', 'after'), 'persist-owned-play', 3_000);
    }
    stage = 'preflight:wait-media-ready';
    result.preflight.mediaReadiness = await waitForInitialMedia(
      setupPage,
      setupBinding,
      expectedVideoId,
      mediaReadinessDeadline,
      bounded
    );
    assert.equal(
      result.preflight.mediaReadiness.status,
      'observed',
      'Public player and installed overlay did not reach bounded readiness'
    );
    result.preflight.initialState = await publicState(page, ownedBinding);

    await background.goto('data:text/html,<title>duration-observation-background</title>', {
      waitUntil: 'domcontentloaded',
      timeout: remainingPreflight(10_000),
    });
    result.preflight.visibilityProof = [];
    const tabOrder: [Page, string][] = [
      [page, 'visible'],
      [background, 'hidden'],
      [page, 'visible'],
    ];
    for (const [target, expected] of tabOrder) {
      await target.bringToFront();
      await page.waitForFunction(
        (visibility) => document.visibilityState === visibility,
        expected,
        { timeout: remainingPreflight(5_000), polling: 100 }
      );
      result.preflight.visibilityProof.push((await publicState(page, ownedBinding)).visibility);
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
    const activePage = page;
    const activeBinding = ownedBinding;
    const sample = async (phase: string, scheduledElapsedMs: number) => {
      stage = `observe:sample:${phase}:${result.samples.length}`;
      const state = await publicState(activePage, activeBinding);
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
    for (let offset = ACTIVE_MS + SAMPLE_MS; offset <= ACTIVE_MS + HIDDEN_MS; offset += SAMPLE_MS) {
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
      result.playerControl = await exercisePlayerPausePlay(ownedBinding);
    } catch (error) {
      result.playerControl = { status: 'unverified', reason: 'player-controls-unavailable' };
      result.failures.push(failure('observe:player-pause-play', error));
    }
    await persist('observe:player-pause-play', 'after');
    for (let offset = ACTIVE_MS + HIDDEN_MS + SAMPLE_MS; offset <= TOTAL_MS; offset += SAMPLE_MS) {
      await waitUntil(started + offset);
      await sample(offset === TOTAL_MS ? 'resumed-final' : 'resumed', offset);
    }
    result.resumeAccessibleRender = await resumeObserver;
    resumeObserver = undefined;
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
    const diagnostics = captureDiagnostics(result.rendererValidation.workerPolicyFallback === true);
    result.diagnostics = diagnostics;
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
        ...diagnostics.pageErrorTypes,
        ...Array.from({ length: pageErrorOverflow }, () => 'overflow'),
      ],
      unexpectedConsoleErrors: diagnostics.unexpectedConsoleErrors,
    });
    result.status = 'completed';
    result.evidenceStatus = result.evidenceStatusReasons.length === 0 ? 'observed' : 'unverified';
    await page
      .screenshot({
        path: join(output, 'live-duration-final.png'),
        animations: 'disabled',
      })
      .catch(() => {});
    await persist('observe:complete', 'after');
    return result;
  } catch (error) {
    result.failures.push(failure(stage, error));
    result.status = 'failed';
    result.evidenceStatus = 'unverified';
    result.diagnostics = captureDiagnostics(false);
    if (page && !page.isClosed()) {
      result.failureState = ownedBinding
        ? await publicState(page, ownedBinding).catch(() => null)
        : null;
      if (stage.startsWith('preflight:') || ownedBinding) {
        result.failurePlayerDom = await captureFailurePlayerDom(page, ownedBinding).catch(
          () => null
        );
      }
      await page
        .screenshot({
          path: join(output, 'live-duration-failure.png'),
          animations: 'disabled',
          timeout: 3_000,
        })
        .catch(() => {});
    }
    await persist(`failure:${stage}`, 'after').catch(() => {});
    throw new Error(`Duration observation failed during ${stage}`, { cause: error });
  } finally {
    resumeObserverController?.abort();
    await resumeObserver?.catch(() => {});
    await ownedVideo?.dispose().catch(() => {});
    await ownedPlayer?.dispose().catch(() => {});
    await background?.close().catch(() => {});
    await page?.close().catch(() => {});
  }
}
