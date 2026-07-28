// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { ReplayChatSource } from '@chat/source-replay';
import type { InnertubeContinuationData } from '@chat/youtube/continuation';
import { DEFAULT_SETTINGS } from '@settings/schema';

/**
 * Tests for ReplayChatSource seek+prefetch behavior.
 *
 * Regression guards for the Phase 3 fix: startPrefetch should only be
 * called when the seek fetch succeeds. The cooperative loop (lines 185-254)
 * already guards prefetch seeding behind mainPollSucceeded (line 202-204).
 * These tests verify the basic lifecycle and health snapshot contract.
 */

describe('ReplayChatSource', () => {
  let source: ReplayChatSource;

  beforeEach(() => {
    source = new ReplayChatSource(() => DEFAULT_SETTINGS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('constructs without error', () => {
    expect(source).toBeInstanceOf(ReplayChatSource);
  });

  it('accepts custom settings getter', () => {
    const custom = { ...DEFAULT_SETTINGS, replayPrefetchPages: 10 };
    const s = new ReplayChatSource(() => custom);
    expect(s).toBeInstanceOf(ReplayChatSource);
  });

  it('getHealthSnapshot returns expected shape', () => {
    const health = source.getHealthSnapshot();
    expect(health).toBeDefined();
    expect(typeof health.observerAlive).toBe('boolean');
    expect(typeof health.recentlyActive).toBe('boolean');
    expect(health).toHaveProperty('observerAlive');
    expect(health).toHaveProperty('recentlyActive');
  });

  it('getHealthSnapshot with activeTimeoutMs option', () => {
    const health = source.getHealthSnapshot({ activeTimeoutMs: 1000 });
    expect(health).toBeDefined();
    expect(typeof health.recentlyActive).toBe('boolean');
  });

  it('isActive returns boolean', () => {
    expect(typeof source.isActive()).toBe('boolean');
  });

  it('isActive with custom timeout', () => {
    expect(typeof source.isActive(5000)).toBe('boolean');
  });

  it('drainPendingMessages returns empty array when not started', () => {
    const pending = source.drainPendingMessages();
    expect(Array.isArray(pending)).toBe(true);
    expect(pending).toEqual([]);
  });

  it('stop() is idempotent', () => {
    expect(() => source.stop()).not.toThrow();
    expect(() => source.stop()).not.toThrow();
  });

  it('releases seek listener and signal references when the loop stops', () => {
    const cleanup = vi.fn();
    const signal = new AbortController().signal;
    const internals = source as unknown as {
      seekListenerCleanup: (() => void) | null;
      seekSignal: AbortSignal | null;
      stopCooperativeLoop: () => void;
    };
    internals.seekListenerCleanup = cleanup;
    internals.seekSignal = signal;

    internals.stopCooperativeLoop();
    internals.stopCooperativeLoop();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(internals.seekListenerCleanup).toBeNull();
    expect(internals.seekSignal).toBeNull();
  });

  it('clears a prior seek listener when no replacement video exists', () => {
    const cleanup = vi.fn();
    const signal = new AbortController().signal;
    const internals = source as unknown as {
      seekListenerCleanup: (() => void) | null;
      seekSignal: AbortSignal | null;
      installSeekListeners: (signal?: AbortSignal) => void;
    };
    internals.seekListenerCleanup = cleanup;
    internals.seekSignal = signal;

    internals.installSeekListeners(signal);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(internals.seekListenerCleanup).toBeNull();
    expect(internals.seekSignal).toBeNull();
  });

  it('aborts a hung replay request after the fetch timeout', async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal);

    const internals = source as unknown as {
      requestReplayPayload: (
        continuation: InnertubeContinuationData,
        signal?: AbortSignal
      ) => Promise<unknown>;
      requestPayload: (...args: unknown[]) => Promise<unknown>;
    };
    const requestPayload = vi
      .spyOn(internals, 'requestPayload')
      .mockImplementation((_fetchFn, _continuation, ...fetchArgs) => {
        const signal = fetchArgs.at(-1) as AbortSignal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        });
      });
    const request = internals.requestReplayPayload({ continuation: 'test' });

    expect(timeoutSpy).toHaveBeenCalledWith(20_000);
    expect(requestPayload).toHaveBeenCalledTimes(1);
    timeoutController.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
});
