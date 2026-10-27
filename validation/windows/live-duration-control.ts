// SPDX-License-Identifier: MIT

import type { ElementHandle } from '@playwright/test';

import { observePublicVideo } from './live-duration-page.ts';
import type { PublicVideoAction, VideoState } from './live-duration-page.ts';

async function waitForVideoState(
  binding: PublicPlayerBinding,
  predicate: (state: VideoState) => boolean,
  timeoutMs: number,
  delay: (ms: number) => Promise<void>
) {
  const deadline = performance.now() + timeoutMs;
  let state: VideoState;
  do {
    state = (await evaluatePublicVideo(binding, 'read')).after;
    if (predicate(state)) return state;
    await delay(Math.min(100, Math.max(1, deadline - performance.now())));
  } while (performance.now() < deadline);
  throw new Error('Public player did not reach the requested bounded playback state');
}

export type PublicPlayerBinding = {
  player: ElementHandle<Element>;
  video: ElementHandle<HTMLVideoElement>;
};

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
    delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
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
