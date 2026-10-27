// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import type { ElementHandle, Page } from '@playwright/test';

import { inspectBoundNativeMuteButton } from './native-mute-page.ts';
import type { NativeMuteState } from './native-mute-page.ts';
export { inspectBoundNativeMuteButton, playOwnedMutedVideo } from './native-mute-page.ts';

export type NativePlayerBinding = {
  player: ElementHandle<Element>;
  video: ElementHandle<HTMLVideoElement>;
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
