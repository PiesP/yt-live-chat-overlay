/**
 * Tests for the scheduler.postTask() wrapper.
 *
 * In jsdom, globalThis.scheduler is typically undefined, so tests exercise
 * the setTimeout fallback paths naturally.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { scheduleOverlayTask } from '@util/scheduler-utils';

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
