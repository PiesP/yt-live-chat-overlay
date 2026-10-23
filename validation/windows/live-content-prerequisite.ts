// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createHash } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { BrowserContext, ElementHandle, Page } from '@playwright/test';

import { requiredDurationVideoId, validateDurationLiveUrl } from './live-duration.ts';

const OBSERVATION_LIMIT_MS = 60_000;
const SAMPLE_INTERVAL_MS = 750;
const MAX_SAMPLES = 79;
const MIN_SAMPLE_GAP_MS = 250;
const MIN_PROGRESS_SECONDS = 0.15;
const MIN_SEEKABLE_SECONDS = 2;
const SEEKABLE_EDGE_TOLERANCE_SECONDS = 0.5;
const PAGE_CREATION_LIMIT_MS = 5_000;
const HANDLE_DISPOSAL_LIMIT_MS = 1_500;
const PAGE_CLOSE_LIMIT_MS = 4_000;

class BoundaryTimeoutError extends Error {
  constructor(stage: string) {
    super(`${stage} exceeded its bounded operation time`);
    this.name = 'BoundaryTimeoutError';
  }
}

function within<T>(
  operation: Promise<T>,
  limitMs: number,
  stage: string,
  onTimeout?: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        onTimeout?.();
        reject(new BoundaryTimeoutError(stage));
      },
      Math.max(1, limitMs)
    );
    void operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

export type LiveContentSample = {
  elapsedMs: number;
  routeMatched: boolean;
  pageBarrier: 'consent' | 'login' | 'other-origin' | null;
  responseVideoId: string | null;
  playerVideoId: string | null;
  playabilityStatus: string | null;
  adShowing: boolean | null;
  playerErrorVisible: boolean;
  videoOwned: boolean;
  sameVideoAsPrevious: boolean | null;
  sourceSha256: string | null;
  sourceChangedFromPrevious: boolean | null;
  readyState: number | null;
  networkState: number | null;
  errorCode: number | null;
  paused: boolean | null;
  muted: boolean | null;
  currentTime: number | null;
  totalVideoFrames: number | null;
  videoWidth: number | null;
  videoHeight: number | null;
  seekable: { start: number; end: number } | null;
};

type Assessment = {
  status: 'passed' | 'unverified';
  reason: string;
  qualifyingPair: [number, number] | null;
  adTransition: 'observed' | 'not-observed';
  adSampleIndex: number | null;
};

export function assessLiveContentPrerequisite(
  samples: readonly LiveContentSample[],
  expectedVideoId: string
): Assessment {
  const healthy = (sample: LiveContentSample): boolean =>
    sample.routeMatched &&
    sample.responseVideoId === expectedVideoId &&
    sample.playerVideoId === expectedVideoId &&
    sample.playabilityStatus === 'OK' &&
    sample.adShowing === false &&
    !sample.playerErrorVisible &&
    sample.videoOwned &&
    sample.sourceSha256 !== null &&
    sample.readyState !== null &&
    sample.readyState >= 2 &&
    sample.errorCode === null &&
    sample.paused === false &&
    sample.muted === true &&
    sample.currentTime !== null &&
    Number.isFinite(sample.currentTime) &&
    sample.videoWidth !== null &&
    sample.videoWidth > 0 &&
    sample.videoHeight !== null &&
    sample.videoHeight > 0 &&
    sample.seekable !== null &&
    Number.isFinite(sample.seekable.start) &&
    Number.isFinite(sample.seekable.end) &&
    sample.seekable.end - sample.seekable.start >= MIN_SEEKABLE_SECONDS &&
    sample.currentTime >= sample.seekable.start - SEEKABLE_EDGE_TOLERANCE_SECONDS &&
    sample.currentTime <= sample.seekable.end + SEEKABLE_EDGE_TOLERANCE_SECONDS;

  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (!previous || !current || !healthy(previous) || !healthy(current)) continue;
    if (current.elapsedMs - previous.elapsedMs < MIN_SAMPLE_GAP_MS) continue;
    if (current.sameVideoAsPrevious !== true || current.sourceChangedFromPrevious !== false) {
      continue;
    }
    if (previous.sourceSha256 !== current.sourceSha256) continue;
    if (
      previous.currentTime === null ||
      current.currentTime === null ||
      current.currentTime - previous.currentTime < MIN_PROGRESS_SECONDS ||
      previous.totalVideoFrames === null ||
      current.totalVideoFrames === null ||
      current.totalVideoFrames <= previous.totalVideoFrames
    ) {
      continue;
    }
    const adSampleIndex = samples.findIndex(
      (sample, adIndex) => adIndex < index && sample.routeMatched && sample.adShowing === true
    );
    return {
      status: 'passed',
      reason: 'public-player-associated-identity-playback-and-seekable-range-observed',
      qualifyingPair: [index - 1, index],
      adTransition: adSampleIndex >= 0 ? 'observed' : 'not-observed',
      adSampleIndex: adSampleIndex >= 0 ? adSampleIndex : null,
    };
  }
  const latest = samples.at(-1);
  const reason = !latest
    ? 'public-player-not-observed'
    : latest.pageBarrier === 'consent'
      ? 'public-consent-barrier'
      : latest.pageBarrier === 'login'
        ? 'public-login-barrier'
        : !latest.routeMatched
          ? 'public-route-changed-or-unavailable'
          : latest.responseVideoId !== expectedVideoId || latest.playerVideoId !== expectedVideoId
            ? 'public-content-identity-unverified'
            : latest.playabilityStatus !== 'OK'
              ? 'public-playability-status-unverified'
              : latest.adShowing !== false
                ? 'public-ad-state-unverified'
                : latest.playerErrorVisible || latest.errorCode !== null
                  ? 'public-player-error-observed'
                  : 'same-owned-video-source-time-frames-and-seekable-range-unverified';
  const adSampleIndex = samples.findIndex(
    (sample) => sample.routeMatched && sample.adShowing === true
  );
  return {
    status: 'unverified',
    reason,
    qualifyingPair: null,
    adTransition: 'not-observed',
    adSampleIndex: adSampleIndex >= 0 ? adSampleIndex : null,
  };
}

/** Read one owned public player sample. The page never returns its signed media URL. */
async function readSample(
  page: Page,
  currentVideo: ElementHandle<HTMLVideoElement> | null,
  previousVideo: ElementHandle<HTMLVideoElement> | null,
  expectedVideoId: string,
  elapsedMs: number,
  previousSourceSha256: string | null
): Promise<LiveContentSample> {
  const state = await page.evaluate(
    async ({ currentVideo, previousVideo, expectedVideoId }) => {
      const players = document.querySelectorAll('#movie_player');
      const player = players.length === 1 ? players[0] : null;
      const videos = player?.querySelectorAll('video');
      const video = videos?.length === 1 ? videos[0] : null;
      const owned = video instanceof HTMLVideoElement && video === currentVideo;
      const currentUrl = new URL(location.href);
      const routeVideoId =
        currentUrl.pathname === '/watch'
          ? currentUrl.searchParams.getAll('v').length === 1
            ? currentUrl.searchParams.get('v')
            : null
          : /^\/live\/[A-Za-z0-9_-]{1,64}$/u.test(currentUrl.pathname)
            ? currentUrl.pathname.slice('/live/'.length)
            : null;
      const pageBarrier: 'consent' | 'login' | 'other-origin' | null =
        currentUrl.hostname === 'consent.youtube.com' ||
        currentUrl.hostname === 'consent.google.com'
          ? 'consent'
          : currentUrl.hostname === 'accounts.google.com'
            ? 'login'
            : currentUrl.origin !== 'https://www.youtube.com'
              ? 'other-origin'
              : null;
      const response = (
        window as Window & {
          ytInitialPlayerResponse?: {
            videoDetails?: { videoId?: unknown };
            playabilityStatus?: { status?: unknown };
          };
        }
      ).ytInitialPlayerResponse;
      let playerVideoId: unknown = null;
      try {
        const playerWithData = player as (Element & { getVideoData?: () => unknown }) | null;
        const data = playerWithData?.getVideoData?.();
        if (data && typeof data === 'object' && 'video_id' in data) {
          playerVideoId = data.video_id;
        }
      } catch {
        // A missing player identity remains unverified.
      }
      const errorSelectors = [
        '.ytp-error',
        '.ytp-error-content-wrap',
        '#player yt-playability-error-supported-renderers#error-screen',
      ];
      const playerErrorVisible = errorSelectors.some((selector) =>
        [...document.querySelectorAll(selector)].some((element) => {
          const style = getComputedStyle(element);
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            element.getClientRects().length > 0
          );
        })
      );
      let sourceSha256: string | null = null;
      if (owned && video.currentSrc) {
        const encoded = new TextEncoder().encode(video.currentSrc);
        const digest = await crypto.subtle.digest('SHA-256', encoded);
        sourceSha256 = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
      }
      let seekable: { start: number; end: number } | null = null;
      if (owned && video.seekable.length > 0) {
        try {
          const last = video.seekable.length - 1;
          seekable = { start: video.seekable.start(last), end: video.seekable.end(last) };
        } catch {
          // A changing TimeRanges object cannot establish a usable range.
        }
      }
      let quality: VideoPlaybackQuality | null = null;
      if (owned) {
        try {
          quality = video.getVideoPlaybackQuality?.() ?? null;
        } catch {
          // Frame evidence remains unavailable if the page rejects the probe.
        }
      }
      const frameCount = quality?.totalVideoFrames ?? null;
      return {
        routeMatched:
          currentUrl.origin === 'https://www.youtube.com' && routeVideoId === expectedVideoId,
        pageBarrier,
        responseVideoId:
          typeof response?.videoDetails?.videoId === 'string'
            ? response.videoDetails.videoId
            : null,
        playerVideoId: typeof playerVideoId === 'string' ? playerVideoId : null,
        playabilityStatus:
          typeof response?.playabilityStatus?.status === 'string'
            ? response.playabilityStatus.status.slice(0, 48)
            : null,
        adShowing: player ? player.classList.contains('ad-showing') : null,
        playerErrorVisible,
        videoOwned: owned,
        sameVideoAsPrevious: owned && previousVideo ? video === previousVideo : null,
        sourceSha256,
        readyState: owned ? video.readyState : null,
        networkState: owned ? video.networkState : null,
        errorCode: owned ? (video.error?.code ?? null) : null,
        paused: owned ? video.paused : null,
        muted: owned ? video.muted : null,
        currentTime: owned && Number.isFinite(video.currentTime) ? video.currentTime : null,
        totalVideoFrames:
          typeof frameCount === 'number' && Number.isFinite(frameCount) ? frameCount : null,
        videoWidth: owned ? video.videoWidth : null,
        videoHeight: owned ? video.videoHeight : null,
        seekable,
      };
    },
    { currentVideo, previousVideo, expectedVideoId }
  );
  return {
    elapsedMs,
    ...state,
    sourceChangedFromPrevious:
      previousSourceSha256 && state.sourceSha256
        ? previousSourceSha256 !== state.sourceSha256
        : null,
  };
}

/** Inspect player-associated public evidence without binding decoded frames to content. */
export async function runLiveContentPrerequisite({
  context,
  url,
  output,
  index,
}: {
  context: BrowserContext;
  url: string;
  output: string;
  index: number;
}) {
  if (!Number.isSafeInteger(index) || index < 0 || index > 999) {
    throw new Error('Live prerequisite index must be an integer from 0 to 999');
  }
  const liveUrl = validateDurationLiveUrl(url);
  const expectedVideoId = requiredDurationVideoId(liveUrl);
  const started = performance.now();
  const deadline = started + OBSERVATION_LIMIT_MS;
  const filename = `live-content-prerequisite-${index}.json`;
  const result = {
    schemaVersion: 1,
    kind: 'public-youtube-player-associated-content-prerequisite',
    status: 'unverified' as 'passed' | 'unverified',
    statusReason: 'public-player-not-observed',
    classification: 'environment-prerequisite',
    inputUrlSha256: createHash('sha256').update(liveUrl).digest('hex'),
    expectedVideoId,
    observationLimitMs: OBSERVATION_LIMIT_MS,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    samples: [] as LiveContentSample[],
    assessment: assessLiveContentPrerequisite([], expectedVideoId),
    consent: { visible: false, rejectAllClicked: false, actionErrorType: null as string | null },
    playbackControl: {
      mutedSet: false,
      playInvoked: false,
      actionErrorType: null as string | null,
    },
    sampleOverflow: false,
    failureStage: null as string | null,
    failureType: null as string | null,
    writeErrorType: null as string | null,
    cleanup: {
      pageClosed: false,
      pageCloseTimedOut: false,
      pageCreationTimedOut: false,
      latePageCloseGuardAttached: false,
      callerContextCleanupRequired: false,
      pendingOperationUncertain: false,
      handleDisposeErrors: 0,
      handleDisposeTimedOut: false,
      errorType: null as string | null,
    },
    elapsedMs: 0,
    limitations: [
      'One public YouTube URL and one caller-owned browser context are observed.',
      'Absence of an observed ad does not prove ad completion or ad behavior.',
      'An ad transition means observed ad-showing then site ad state false with player-associated playback; it does not prove frame or ad/content parity.',
      'Matching player IDs and a currentSrc hash do not cryptographically bind decoded frames to content.',
      'No chat, image rendering, account state, or player defect is inferred.',
    ],
  };
  const save = async (): Promise<void> => {
    const pending = join(output, `.${filename}.next`);
    await writeFile(pending, JSON.stringify(result, null, 2), { flush: true });
    await rename(pending, join(output, filename));
  };
  let page: Page | null = null;
  let deadlineWatchdog: ReturnType<typeof setTimeout> | null = null;
  let deadlineExpired = false;
  let previousVideo: ElementHandle<HTMLVideoElement> | null = null;
  let previousSourceSha256: string | null = null;
  let stage = 'create-page';
  const releaseHandle = async (
    handle: ElementHandle<HTMLVideoElement> | null
  ): Promise<boolean> => {
    if (!handle) return true;
    try {
      await within(handle.dispose(), HANDLE_DISPOSAL_LIMIT_MS, 'dispose-video-handle', () => {
        result.cleanup.handleDisposeTimedOut = true;
        result.cleanup.callerContextCleanupRequired = true;
      });
      return true;
    } catch {
      result.cleanup.handleDisposeErrors++;
      result.cleanup.callerContextCleanupRequired = true;
      return false;
    }
  };
  try {
    await save();
    deadlineWatchdog = setTimeout(
      () => {
        deadlineExpired = true;
        void page?.close({ runBeforeUnload: false }).catch(() => {});
      },
      Math.max(1, deadline - performance.now())
    );
    const creation = context.newPage();
    void creation.then(
      (latePage) => {
        if (!result.cleanup.pageCreationTimedOut) return;
        // A late page belongs to this call, but its closure remains unverified.
        void within(
          Promise.resolve().then(() => latePage.close({ runBeforeUnload: false })),
          PAGE_CLOSE_LIMIT_MS,
          'late-page-close'
        ).catch(() => {});
      },
      () => {}
    );
    page = await within(
      creation,
      Math.min(PAGE_CREATION_LIMIT_MS, deadline - performance.now()),
      'create-page',
      () => {
        result.cleanup.pageCreationTimedOut = true;
        result.cleanup.latePageCloseGuardAttached = true;
        result.cleanup.callerContextCleanupRequired = true;
      }
    );
    stage = 'navigate';
    await page.goto(liveUrl, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(1, Math.min(35_000, deadline - performance.now())),
    });
    stage = 'consent';
    const consent = page.getByRole('button', { name: 'Reject all', exact: true });
    result.consent.visible = await consent.isVisible().catch(() => false);
    if (result.consent.visible) {
      try {
        await consent.click({
          timeout: Math.max(1, Math.min(3_000, deadline - performance.now())),
        });
        result.consent.rejectAllClicked = true;
      } catch (error) {
        result.consent.actionErrorType = error instanceof Error ? error.name : typeof error;
      }
    }
    stage = 'observe-public-player';
    while (performance.now() < deadline && result.samples.length < MAX_SAMPLES) {
      const elapsedMs = performance.now() - started;
      let currentVideo: ElementHandle<HTMLVideoElement> | null = null;
      let handleReleaseFailed = false;
      try {
        currentVideo = (await page
          .locator('#movie_player video')
          .first()
          .elementHandle({
            timeout: Math.max(1, Math.min(500, deadline - performance.now())),
          })) as ElementHandle<HTMLVideoElement> | null;
      } catch {
        // An absent or changing player is recorded by the sample below.
      }
      try {
        if (currentVideo && !result.playbackControl.playInvoked) {
          try {
            await within(
              currentVideo.evaluate((video, id) => {
                const currentUrl = new URL(location.href);
                const routeId =
                  currentUrl.pathname === '/watch'
                    ? currentUrl.searchParams.get('v')
                    : currentUrl.pathname === `/live/${id}`
                      ? id
                      : null;
                if (
                  currentUrl.origin !== 'https://www.youtube.com' ||
                  routeId !== id ||
                  !video.isConnected ||
                  document.querySelectorAll('#movie_player video').length !== 1 ||
                  document.querySelector('#movie_player video') !== video
                ) {
                  throw new Error('Owned public video disappeared before play');
                }
                video.muted = true;
                void video.play().catch(() => {});
              }, expectedVideoId),
              Math.min(3_000, deadline - performance.now()),
              'native-play-control',
              () => {
                result.cleanup.pendingOperationUncertain = true;
                result.cleanup.callerContextCleanupRequired = true;
              }
            );
            result.playbackControl.mutedSet = true;
            result.playbackControl.playInvoked = true;
          } catch (error) {
            result.playbackControl.actionErrorType =
              error instanceof Error ? error.name : typeof error;
            if (error instanceof BoundaryTimeoutError) throw error;
          }
        }
        const sample: LiveContentSample = await within(
          readSample(
            page,
            currentVideo,
            previousVideo,
            expectedVideoId,
            elapsedMs,
            previousSourceSha256
          ),
          Math.min(3_000, deadline - performance.now()),
          'read-public-sample',
          () => {
            result.cleanup.pendingOperationUncertain = true;
            result.cleanup.callerContextCleanupRequired = true;
          }
        );
        result.samples.push(sample);
        result.assessment = assessLiveContentPrerequisite(result.samples, expectedVideoId);
        previousSourceSha256 = sample.sourceSha256;
        if (result.samples.length % 10 === 0) await save();
        if (result.assessment.status === 'passed') break;
      } finally {
        handleReleaseFailed = !(await releaseHandle(previousVideo));
        previousVideo = currentVideo;
      }
      if (handleReleaseFailed) throw new Error('Owned video handle disposal unverified');
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.max(1, Math.min(SAMPLE_INTERVAL_MS, deadline - performance.now())))
      );
    }
    result.sampleOverflow =
      result.assessment.status !== 'passed' &&
      result.samples.length >= MAX_SAMPLES &&
      performance.now() < deadline;
    if (result.sampleOverflow) {
      result.assessment = {
        status: 'unverified',
        reason: 'public-player-timeline-overflow',
        qualifyingPair: null,
        adTransition: 'not-observed',
        adSampleIndex: null,
      };
    }
    result.status = result.assessment.status;
    result.statusReason = result.assessment.reason;
    if (result.status === 'passed' && result.consent.actionErrorType) {
      result.status = 'unverified';
      result.statusReason = 'consent-action-unverified';
    } else if (
      result.status === 'passed' &&
      (!result.playbackControl.mutedSet || !result.playbackControl.playInvoked)
    ) {
      result.status = 'unverified';
      result.statusReason = 'native-play-control-unverified';
    }
  } catch (error) {
    result.failureStage = stage;
    result.failureType = error instanceof Error ? error.name : typeof error;
    result.statusReason = `observation-${stage}-unverified`;
  } finally {
    await releaseHandle(previousVideo);
    if (page) {
      try {
        await within(
          page.close({ runBeforeUnload: false }),
          PAGE_CLOSE_LIMIT_MS,
          'close-owned-page',
          () => {
            result.cleanup.pageCloseTimedOut = true;
            result.cleanup.callerContextCleanupRequired = true;
          }
        );
        result.cleanup.pageClosed = true;
      } catch (error) {
        result.cleanup.errorType = error instanceof Error ? error.name : typeof error;
        result.cleanup.callerContextCleanupRequired = true;
      }
    }
    if (deadlineWatchdog) clearTimeout(deadlineWatchdog);
    if (
      (page !== null && !result.cleanup.pageClosed) ||
      result.cleanup.errorType ||
      result.cleanup.handleDisposeErrors > 0 ||
      result.cleanup.pageCreationTimedOut ||
      result.cleanup.pendingOperationUncertain
    ) {
      result.status = 'unverified';
      if (!result.failureStage) result.statusReason = 'owned-page-cleanup-unverified';
    }
    if (deadlineExpired) {
      result.status = 'unverified';
      if (!result.failureStage) result.statusReason = 'observation-deadline-exceeded';
    }
    result.elapsedMs = performance.now() - started;
    try {
      await save();
    } catch (error) {
      result.writeErrorType = error instanceof Error ? error.name : typeof error;
      result.status = 'unverified';
      result.statusReason = 'result-write-unverified';
    }
  }
  return result;
}
