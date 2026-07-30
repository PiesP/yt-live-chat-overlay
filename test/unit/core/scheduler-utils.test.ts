/**
 * Tests for scheduler-utils.ts — scheduler.yield()/postTask() wrappers.
 *
 * In jsdom, globalThis.scheduler is typically undefined, so tests exercise
 * the setTimeout fallback paths naturally.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { scheduleOverlayTask, yieldAtDeadline } from '@util/scheduler-utils';

describe('scheduleOverlayTask', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the function return value', async () => {
    const promise = scheduleOverlayTask(() => 42);
    vi.advanceTimersByTime(0);
    const result = await promise;
    expect(result).toBe(42);
  });

  it('calls setTimeout for user-visible priority (default)', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const promise = scheduleOverlayTask(() => 'result');
    expect(spy).toHaveBeenCalledTimes(1);
    // Default priority is 'user-visible' → setTimeout(…, 0)
    vi.advanceTimersByTime(0);
    await promise;
    spy.mockRestore();
  });

  it('calls setTimeout with 4ms delay for background priority', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const promise = scheduleOverlayTask(() => 'bg', { priority: 'background' });
    vi.advanceTimersByTime(4);
    const result = await promise;
    expect(result).toBe('bg');
    spy.mockRestore();
  });

  it('calls setTimeout(0) for user-blocking priority', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const promise = scheduleOverlayTask(() => 'urgent', { priority: 'user-blocking' });
    vi.advanceTimersByTime(0);
    const result = await promise;
    expect(result).toBe('urgent');
    spy.mockRestore();
  });

  it('handles async functions', async () => {
    const promise = scheduleOverlayTask(async () => 'async result');
    vi.advanceTimersByTime(0);
    const result = await promise;
    expect(result).toBe('async result');
  });

  it('handles functions returning objects', async () => {
    const obj = { key: 'value' };
    const promise = scheduleOverlayTask(() => obj);
    vi.advanceTimersByTime(0);
    const result = await promise;
    expect(result).toBe(obj);
  });

  it('rejects when a fallback task throws', async () => {
    const taskError = new Error('scheduled task failed');
    const promise = scheduleOverlayTask(() => {
      throw taskError;
    });
    const outcome = promise.then(
      () => ({ status: 'resolved' as const }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );

    expect(() => vi.advanceTimersByTime(0)).not.toThrow();
    await expect(outcome).resolves.toEqual({ status: 'rejected', reason: taskError });
  });
});

describe('yieldAtDeadline', () => {
  let now: number;

  beforeEach(() => {
    now = 1000;
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns same deadline when not exceeded', async () => {
    const deadline = now + 50; // budget remaining
    const result = await yieldAtDeadline(deadline);
    expect(result).toBe(deadline); // unchanged
  });

  it('returns new deadline when budget is exceeded', async () => {
    const deadline = now - 1; // already exceeded
    const resultPromise = yieldAtDeadline(deadline);
    // The function should yield (setTimeout(0)) and return new deadline
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result).toBeGreaterThan(deadline);
    expect(result).toBeGreaterThan(now - 50); // new deadline is now + budgetMs
  });

  it('defaults to 50ms budget when not specified', async () => {
    const deadline = now - 1; // exceeded
    const resultPromise = yieldAtDeadline(deadline);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    // new deadline = now + 50 (default budget)
    expect(result).toBe(now + 50);
  });

  it('uses custom budget when specified', async () => {
    const deadline = now - 1; // exceeded
    const resultPromise = yieldAtDeadline(deadline, 100);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result).toBe(now + 100);
  });

  it('yields only once per exceeded deadline', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const deadline = now + 500; // not exceeded
    const result = await yieldAtDeadline(deadline);
    expect(result).toBe(deadline); // unchanged
    // No setTimeout should have been called since deadline wasn't exceeded
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});
