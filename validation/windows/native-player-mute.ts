// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import type { ElementHandle, Page } from '@playwright/test';

export type NativePlayerBinding = {
  player: ElementHandle<Element>;
  video: ElementHandle<HTMLVideoElement>;
};

type NativeMuteState = {
  decision: 'click-mute' | 'already-muted';
  muted: boolean;
  paused: boolean;
  readyState: number;
  currentTime: number | null;
};

export type NativeMuteBoundary = {
  timedOut: boolean;
  pendingUncertain: number;
  lateSettlements: number;
};

export type BoundedNativeAction = <T>(
  work: () => Promise<T> | T,
  label: string,
  limitMs?: number
) => Promise<T>;

/** A timed-out UI operation stays uncertain; no later action may run. */
export function createNativeMuteBoundary({
  deadlineMs,
  controller,
  nowMs = () => performance.now(),
}: {
  deadlineMs: number;
  controller: NativeMuteBoundary;
  nowMs?: () => number;
}): BoundedNativeAction {
  return async <T>(work: () => Promise<T> | T, label: string, limitMs = 3_000) => {
    if (controller.timedOut || controller.pendingUncertain || controller.lateSettlements) {
      throw new Error('Native mute operation uncertain');
    }
    const available = () => deadlineMs - nowMs();
    const budget = Math.min(limitMs, available());
    if (!(budget > 0)) throw new Error(`${label}: deadline exceeded`);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const operation = Promise.resolve().then(() => {
      if (!(available() > 0)) throw new Error(`${label}: deadline exceeded before work`);
      return work();
    });
    void operation.then(
      () => {
        if (timedOut) {
          controller.pendingUncertain--;
          controller.lateSettlements++;
        }
      },
      () => {
        if (timedOut) {
          controller.pendingUncertain--;
          controller.lateSettlements++;
        }
      }
    );
    try {
      const value = await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            controller.timedOut = true;
            controller.pendingUncertain++;
            reject(new Error(`${label}: timed out`));
          }, budget);
        }),
      ]);
      if (!(available() > 0)) throw new Error(`${label}: completed after deadline`);
      return value;
    } finally {
      clearTimeout(timeout);
    }
  };
}

/** Passed to the retained button handle; no page-global player identity is trusted. */
export function inspectBoundNativeMuteButton(
  button: HTMLButtonElement,
  { player, video, expectedVideoId }: { player: unknown; video: unknown; expectedVideoId: string }
): NativeMuteState {
  const players = document.querySelectorAll('#movie_player');
  const videos = player instanceof Element ? player.querySelectorAll('video') : null;
  const controls = document.querySelectorAll(
    '#movie_player .ytp-mute-button > button.ytp-volume-icon.ytp-button'
  );
  const parent = button?.parentElement;
  if (
    !(player instanceof Element) ||
    !(video instanceof HTMLVideoElement) ||
    !(button instanceof HTMLButtonElement) ||
    players.length !== 1 ||
    players[0] !== player ||
    videos?.length !== 1 ||
    videos[0] !== video ||
    controls.length !== 1 ||
    controls[0] !== button ||
    !player.contains(button) ||
    player.ownerDocument !== document ||
    video.ownerDocument !== document ||
    button.ownerDocument !== document ||
    !player.isConnected ||
    !video.isConnected ||
    !button.isConnected ||
    parent?.tagName !== 'DIV' ||
    !parent.classList.contains('ytp-mute-button') ||
    !button.classList.contains('ytp-volume-icon') ||
    !button.classList.contains('ytp-button')
  ) {
    throw new Error('Owned native mute control is absent, ambiguous, or replaced');
  }
  const playerWithData = player as Element & { getVideoData?: () => unknown };
  const playerData: unknown =
    typeof playerWithData.getVideoData === 'function' ? playerWithData.getVideoData() : null;
  const playerVideoId =
    playerData && typeof playerData === 'object' && 'video_id' in playerData
      ? playerData.video_id
      : null;
  const currentUrl = new URL(location.href);
  const currentVideoId =
    currentUrl.pathname === '/watch'
      ? currentUrl.searchParams.get('v')
      : /^\/live\/[A-Za-z0-9_-]{1,64}$/u.test(currentUrl.pathname)
        ? currentUrl.pathname.slice('/live/'.length)
        : null;
  if (
    currentUrl.origin !== 'https://www.youtube.com' ||
    currentVideoId !== expectedVideoId ||
    playerVideoId !== expectedVideoId ||
    player.classList.contains('ad-showing') ||
    video.error?.code != null ||
    !Number.isInteger(video.readyState) ||
    video.readyState < 1 ||
    video.readyState > 4 ||
    document.visibilityState !== 'visible'
  ) {
    throw new Error('Native mute precondition is unverified');
  }
  const errorSelectors = [
    '.ytp-error, .ytp-error-content-wrap, .ytp-error-content',
    '#player yt-playability-error-supported-renderers#error-screen',
  ];
  if (
    errorSelectors.some((selector) =>
      [...document.querySelectorAll(selector)].some((element) => {
        const style = getComputedStyle(element);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          element.getClientRects().length > 0
        );
      })
    )
  )
    throw new Error('Player error is visible before native mute action');
  const rect = button.getBoundingClientRect();
  const style = getComputedStyle(button);
  const parentStyle = getComputedStyle(parent);
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (
    !(rect.width > 0 && rect.height > 0) ||
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    parentStyle.display === 'none' ||
    parentStyle.visibility === 'hidden' ||
    parentStyle.visibility === 'collapse' ||
    button.disabled ||
    button.getAttribute('aria-disabled') === 'true' ||
    button.getAttribute('aria-hidden') === 'true' ||
    parent.getAttribute('aria-hidden') === 'true' ||
    button.getAttribute('aria-keyshortcuts') !== 'm' ||
    !(hit === button || button.contains(hit))
  ) {
    throw new Error('Native mute control is not uniquely actionable');
  }
  const normalize = (value: string | null) =>
    typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : null;
  const kind = (value: string | null) =>
    value === 'Mute' || value === 'Mute (m)'
      ? 'mute'
      : value === 'Unmute' || value === 'Unmute (m)' || value === 'Unmute keyboard shortcut m'
        ? 'unmute'
        : null;
  const labelKind = kind(normalize(button.getAttribute('aria-label')));
  const title = normalize(button.getAttribute('title'));
  if (
    labelKind === null ||
    (title !== null && title !== '' && kind(title) !== labelKind) ||
    (labelKind === 'mute' && video.muted !== false) ||
    (labelKind === 'unmute' && video.muted !== true)
  ) {
    throw new Error('Native mute label and retained video state conflict');
  }
  return {
    decision: labelKind === 'mute' ? 'click-mute' : 'already-muted',
    muted: video.muted,
    paused: video.paused,
    readyState: video.readyState,
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
  };
}

export function playOwnedMutedVideo(
  video: HTMLVideoElement,
  { player, expectedVideoId }: { player: unknown; expectedVideoId: string }
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
  const playerWithData = player as Element & { getVideoData?: () => unknown };
  const playerData: unknown =
    typeof playerWithData.getVideoData === 'function' ? playerWithData.getVideoData() : null;
  const playerVideoId =
    playerData && typeof playerData === 'object' && 'video_id' in playerData
      ? playerData.video_id
      : null;
  const currentUrl = new URL(location.href);
  const currentVideoId =
    currentUrl.pathname === '/watch'
      ? currentUrl.searchParams.get('v')
      : /^\/live\/[A-Za-z0-9_-]{1,64}$/u.test(currentUrl.pathname)
        ? currentUrl.pathname.slice('/live/'.length)
        : null;
  if (
    currentUrl.origin !== 'https://www.youtube.com' ||
    currentVideoId !== expectedVideoId ||
    playerVideoId !== expectedVideoId ||
    player.classList.contains('ad-showing') ||
    video.error?.code != null ||
    video.muted !== true ||
    document.visibilityState !== 'visible'
  ) {
    throw new Error('Owned public player video lost verified mute before play');
  }
  const state = () => ({
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
    errorCode: video.error?.code ?? null,
    muted: video.muted,
    paused: video.paused,
    readyState: video.readyState,
  });
  const before = state();
  void video.play().catch(() => {});
  return { action: 'play', before, after: state() };
}

export async function establishOwnedMute({
  page,
  binding,
  expectedVideoId,
  bounded,
  beforeClick,
}: {
  page: Page;
  binding: NativePlayerBinding;
  expectedVideoId: string;
  bounded: BoundedNativeAction;
  beforeClick: (before: NativeMuteState) => Promise<void>;
}) {
  await bounded(
    () => binding.player.hover({ timeout: 2_000 }),
    'reveal-native-mute-control',
    2_000
  );
  const locator = page.locator(
    '#movie_player .ytp-mute-button > button.ytp-volume-icon.ytp-button'
  );
  await bounded(
    () => locator.waitFor({ state: 'visible', timeout: 2_000 }),
    'native-mute-button-visible',
    2_000
  );
  const count = await bounded(() => locator.count(), 'native-mute-button-count', 2_000);
  assert.equal(count, 1, 'Native mute control count is not one');
  const button = await bounded(
    () => locator.elementHandle({ timeout: 2_000 }),
    'native-mute-button-handle',
    2_000
  );
  assert(button, 'Native mute control handle unavailable');
  const argumentsForPage = { player: binding.player, video: binding.video, expectedVideoId };
  try {
    const before = await bounded(
      () => button.evaluate(inspectBoundNativeMuteButton, argumentsForPage),
      'native-mute-before',
      2_000
    );
    if (before.decision === 'already-muted') {
      return {
        status: 'verified' as const,
        method: 'already-muted' as const,
        before,
        after: before,
        clickIssued: false,
        clickCompleted: false,
      };
    }
    assert.equal(before.decision, 'click-mute', 'Native mute decision unavailable');
    await bounded(() => beforeClick(before), 'native-mute-before-click-persist', 3_000);
    const preClick = await bounded(
      () => button.evaluate(inspectBoundNativeMuteButton, argumentsForPage),
      'native-mute-immediate-pre-click',
      2_000
    );
    assert(
      preClick.decision === 'click-mute' && preClick.muted === false,
      'Native mute state changed before the one click'
    );
    await bounded(() => button.click({ timeout: 3_000 }), 'native-mute-click', 3_000);
    await bounded(
      () =>
        page
          .locator('#movie_player')
          .getByRole('button', { name: /^(?:Unmute(?:\s+\(m\))?|Unmute keyboard shortcut m)$/u })
          .waitFor({ state: 'visible', timeout: 3_000 }),
      'native-unmute-label',
      3_000
    );
    const after = await bounded(
      () => button.evaluate(inspectBoundNativeMuteButton, argumentsForPage),
      'native-mute-after',
      2_000
    );
    assert(
      after.decision === 'already-muted' && after.muted === true,
      'Same native mute control and video proof unavailable'
    );
    return {
      status: 'verified' as const,
      method: 'click-mute' as const,
      before,
      preClick,
      after,
      clickIssued: true,
      clickCompleted: true,
    };
  } finally {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        button.dispose(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Native mute handle disposal timed out')),
            2_000
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
}
