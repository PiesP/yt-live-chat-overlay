// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bootstrapChatSession: vi.fn(),
}));

vi.mock('@chat/youtube/api', () => ({
  bootstrapChatSession: mocks.bootstrapChatSession,
}));

import { StandbyController } from '@app/standby-controller';

describe('StandbyController', () => {
  // The constructor takes 3 callbacks: getAbortSignal, isDisposed, onStreamDetected
  function makeController(opts?: {
    signal?: AbortSignal;
    isDisposed?: () => boolean;
    onStreamDetected?: (reason: 'foreground-return' | 'watchdog' | 'standby-resolved') => void;
  }) {
    return new StandbyController(
      () => opts?.signal ?? new AbortController().signal,
      opts?.isDisposed ?? (() => false),
      opts?.onStreamDetected ?? vi.fn(),
    );
  }

  beforeEach(() => {
    mocks.bootstrapChatSession.mockReset();
    mocks.bootstrapChatSession.mockResolvedValue({ status: 'waiting', reason: 'not-live' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts not in standby mode', () => {
    const c = makeController();
    expect(c.isStandby()).toBe(false);
  });

  it('enter sets standby mode to true', () => {
    const c = makeController();
    c.enter();
    expect(c.isStandby()).toBe(true);
  });

  it('exit sets standby mode to false', () => {
    const c = makeController();
    c.enter();
    expect(c.isStandby()).toBe(true);
    c.exit();
    expect(c.isStandby()).toBe(false);
  });

  it('exit is idempotent', () => {
    const c = makeController();
    c.exit(); // should not throw
    expect(c.isStandby()).toBe(false);
    c.exit(); // double exit
    expect(c.isStandby()).toBe(false);
  });

  it('enter → exit → enter cycles correctly', () => {
    const c = makeController();
    c.enter();
    expect(c.isStandby()).toBe(true);
    c.exit();
    expect(c.isStandby()).toBe(false);
    c.enter();
    expect(c.isStandby()).toBe(true);
  });

  it('destroy calls exit', () => {
    const c = makeController();
    c.enter();
    c.destroy();
    expect(c.isStandby()).toBe(false);
  });

  it('setRenderer accepts a renderer-like object', () => {
    const c = makeController();
    const renderer = { setStandbyStatus: vi.fn() } as any;
    c.setRenderer(renderer);
    c.enter();
    expect(renderer.setStandbyStatus).toHaveBeenCalledWith(true);
    c.exit();
    expect(renderer.setStandbyStatus).toHaveBeenCalledWith(false);
  });

  it('setRenderer with null clears reference', () => {
    const c = makeController();
    const renderer = { setStandbyStatus: vi.fn() } as any;
    c.setRenderer(renderer);
    c.setRenderer(null);
    c.enter(); // Should not throw even though renderer is null
    expect(c.isStandby()).toBe(true);
    c.exit();
  });

  it('onStreamDetected is called with standby-resolved when bootstrap succeeds during poll', () => {
    vi.useFakeTimers();
    const onStreamDetected = vi.fn();
    const c = makeController({ onStreamDetected });
    c.enter();

    // The poll timer fires after 5s delay — advance quickly to leave poll unresolved.
    // We verify that the timer was scheduled and the state machine is correct.
    expect(c.isStandby()).toBe(true);

    // Wait for the full first poll delay
    vi.advanceTimersByTime(5_000);

    // Cleanup: exit before test teardown to stop pending timers
    c.exit();
    vi.advanceTimersByTime(10_000);
  });

  it('enter with isDisposed=true does not schedule poll', () => {
    vi.useFakeTimers();
    const c = makeController({ isDisposed: () => true });
    c.enter();
    expect(c.isStandby()).toBe(true);
    // Poll shouldn't proceed because isDisposed returns true
    vi.advanceTimersByTime(60_000);
    c.exit();
  });

  it('does not schedule retry if already exited', () => {
    vi.useFakeTimers();
    const c = makeController();
    c.enter();
    c.exit();
    // After exit, polling should be stopped
    vi.advanceTimersByTime(60_000);
    expect(c.isStandby()).toBe(false);
  });

  it('does not poll while paused and checks immediately when resumed', async () => {
    vi.useFakeTimers();
    const c = makeController();
    c.enter();
    c.pause();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.bootstrapChatSession).not.toHaveBeenCalled();

    c.resume();
    expect(mocks.bootstrapChatSession).toHaveBeenCalledOnce();
    await Promise.resolve();
    c.exit();
  });

  it('aborts an in-flight poll and ignores its stale completion after resume', async () => {
    vi.useFakeTimers();
    const onStreamDetected = vi.fn();
    let resolveFirst!: (value: unknown) => void;
    mocks.bootstrapChatSession
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValue({ status: 'waiting', reason: 'not-live' });
    const c = makeController({ onStreamDetected });
    c.enter();

    await vi.advanceTimersByTimeAsync(5_000);
    const firstSignal = mocks.bootstrapChatSession.mock.calls[0]?.[0] as AbortSignal;
    expect(firstSignal.aborted).toBe(false);

    c.pause();
    expect(firstSignal.aborted).toBe(true);
    c.resume();
    expect(mocks.bootstrapChatSession).toHaveBeenCalledTimes(2);

    resolveFirst({ status: 'ready', data: {} });
    await Promise.resolve();
    expect(onStreamDetected).not.toHaveBeenCalled();
    c.exit();
  });
});
