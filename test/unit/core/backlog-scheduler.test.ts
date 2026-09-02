import { describe, expect, it } from 'vitest';
import {
  BacklogScheduler,
  computeAdaptiveMeanInterval,
  computeDensityRampFactor,
  decayActivityCount,
} from '@util/backlog-scheduler';

const config = {
  backlogInjectionRateMin: 4,
  backlogInjectionMax: 20,
  backlogMaxRate: 10,
  backlogDensityRampMs: 2_000,
  backlogDensityRampMaxMs: 4_000,
};

describe('backlog scheduler pure calculations', () => {
  it.each([
    { elapsedMs: 0, expected: 0.25 },
    { elapsedMs: 1_000, expected: 0.625 },
    { elapsedMs: 2_000, expected: 1 },
    { elapsedMs: 3_000, expected: 1 },
  ])('computes density ramp at $elapsedMs ms', ({ elapsedMs, expected }) => {
    expect(computeDensityRampFactor(elapsedMs, 2_000)).toBe(expected);
  });

  it.each([
    { count: 5, elapsedMs: 0, expected: 5 },
    { count: 5, elapsedMs: 1_000, expected: 3 },
    { count: 5, elapsedMs: 2_000, expected: 0 },
    { count: 5, elapsedMs: 2_001, expected: 0 },
  ])('decays $count activities after $elapsedMs ms', ({ count, elapsedMs, expected }) => {
    expect(decayActivityCount(count, elapsedMs)).toBe(expected);
  });

  it('combines congestion and ramp factors into a bounded mean interval', () => {
    expect(computeAdaptiveMeanInterval(10, 5, 0, 1, 1)).toBe(100);
    expect(computeAdaptiveMeanInterval(10, 5, 5, 0.1, 0.25)).toBe(200);
  });

  it('uses one injected timestamp for decay and ramp calculations', () => {
    const scheduler = new BacklogScheduler(config, 4);

    expect(scheduler.computeMeanIntervalWithUtilization(5, 1_000, 0, null, 2_000)).toEqual({
      meanInterval: 250,
      updatedActivityCount: 3,
    });
  });

  describe.each([18, 19, 24])('with %i lanes above the configured rate cap', (lanes) => {
    it('uses the full bounded rate when the backlog is quiet', () => {
      const scheduler = new BacklogScheduler(config, lanes);

      expect(scheduler.computeMeanIntervalWithUtilization(0, 0, 0, null, 2_000)).toEqual({
        meanInterval: 100,
        updatedActivityCount: 0,
      });
    });

    it('throttles for real-time activity', () => {
      const scheduler = new BacklogScheduler(config, lanes);

      expect(scheduler.computeMeanIntervalWithUtilization(5, 2_000, 0, null, 2_000)).toEqual({
        meanInterval: 250,
        updatedActivityCount: 5,
      });
    });

    it('throttles for full lane utilization', () => {
      const scheduler = new BacklogScheduler(config, lanes);

      expect(scheduler.computeMeanIntervalWithUtilization(0, 0, 0, () => 1, 2_000)).toEqual({
        meanInterval: 250,
        updatedActivityCount: 0,
      });
    });

    it('throttles during the density ramp', () => {
      const scheduler = new BacklogScheduler(config, lanes);

      expect(scheduler.computeMeanIntervalWithUtilization(0, 0, 2_000, null, 2_000)).toEqual({
        meanInterval: 250,
        updatedActivityCount: 0,
      });
    });
  });
});
