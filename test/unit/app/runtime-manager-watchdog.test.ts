// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import {
  classifyRuntimeHealthFailure,
  getWatchdogRestartDelay,
  type RuntimeHealthPolicyInput,
} from '@app/runtime-watchdog-policy';
import { describe, expect, it } from 'vitest';

const healthy: RuntimeHealthPolicyInput = {
  idleDurationMs: 0,
  renderable: true,
  chat: {
    observerAlive: true,
    recentlyActive: true,
    isInBackoff: false,
    consecutiveErrors: 0,
  },
  runtimeActive: true,
  videoPaused: false,
  chatInBackoff: false,
  dimensionsNullSince: null,
  now: 100_000,
};

describe('runtime health policy', () => {
  it('returns null when the runtime is healthy', () => {
    expect(classifyRuntimeHealthFailure(healthy)).toBeNull();
  });

  it('classifies a disconnected or zero-sized overlay', () => {
    expect(classifyRuntimeHealthFailure({ ...healthy, renderable: false })).toBe(
      'overlay-not-renderable'
    );
  });

  it('classifies a stopped chat observer', () => {
    expect(
      classifyRuntimeHealthFailure({
        ...healthy,
        chat: { ...healthy.chat!, observerAlive: false },
      })
    ).toBe('chat-source-stopped');
  });

  it('classifies an inactive chat observer as stale', () => {
    expect(
      classifyRuntimeHealthFailure({
        ...healthy,
        chat: { ...healthy.chat!, recentlyActive: false },
      })
    ).toBe('chat-source-stale');
  });

  it('classifies a hidden runtime after the long-idle threshold', () => {
    expect(classifyRuntimeHealthFailure({ ...healthy, idleDurationMs: 61_000 })).toBe(
      'chat-source-stale'
    );
  });

  it('prioritizes the absolute maximum idle threshold', () => {
    expect(
      classifyRuntimeHealthFailure({
        ...healthy,
        idleDurationMs: 30 * 60 * 1000,
        videoPaused: true,
      })
    ).toBe('very-long-idle');
  });

  it('suppresses expected inactivity while video is paused or chat is backing off', () => {
    const stoppedChat = { ...healthy.chat!, observerAlive: false };
    expect(
      classifyRuntimeHealthFailure({ ...healthy, chat: stoppedChat, videoPaused: true })
    ).toBeNull();
    expect(
      classifyRuntimeHealthFailure({ ...healthy, renderable: false, chatInBackoff: true })
    ).toBeNull();
  });

  it('ignores observer inactivity before the runtime becomes active', () => {
    expect(
      classifyRuntimeHealthFailure({
        ...healthy,
        runtimeActive: false,
        chat: { ...healthy.chat!, observerAlive: false },
      })
    ).toBeNull();
  });

  it('applies an exact five-second grace period to missing dimensions', () => {
    expect(
      classifyRuntimeHealthFailure({
        ...healthy,
        renderable: false,
        dimensionsNullSince: 96_000,
      })
    ).toBeNull();
    expect(
      classifyRuntimeHealthFailure({
        ...healthy,
        renderable: false,
        dimensionsNullSince: 95_000,
      })
    ).toBe('overlay-not-renderable');
  });
});

describe('watchdog restart delay', () => {
  it.each([
    [1, 5_000],
    [2, 15_000],
    [3, 30_000],
    [4, 60_000],
  ])('maps attempt %i to %i ms', (attempt, delay) => {
    expect(getWatchdogRestartDelay(attempt)).toBe(delay);
  });

  it.each([0, 1.5, 5, 10])('blocks invalid or excessive attempt %s', (attempt) => {
    expect(getWatchdogRestartDelay(attempt)).toBeNull();
  });
});
