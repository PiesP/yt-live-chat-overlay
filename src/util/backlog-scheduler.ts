// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * BacklogScheduler
 *
 * Throttled injection scheduling for backlog messages. Handles:
 * 1. Adaptive rate computation (real-time activity, lane utilization)
 * 2. Density ramp — linear rate increase over time
 * 3. Poisson-distributed tick scheduling
 *
 * Extracted from backlog-controller.ts for single-responsibility separation.
 */

import { DENSITY_LARGE_THRESHOLD, DENSITY_SMALL_THRESHOLD } from '@util/backlog-constants';
import { sampleExponential } from '@util/backlog-helpers';

export interface SchedulerConfig {
  backlogInjectionRateMin: number;
  backlogInjectionMax: number;
  backlogMaxRate: number;
  backlogDensityRampMs: number;
  backlogDensityRampMaxMs: number;
}

const REAL_TIME_FACTOR_MIN = 0.25;
const REAL_TIME_FACTOR_STEP = 0.2;
const UTILIZATION_FACTOR_MIN = 0.1;
const UTILIZATION_FACTOR_SLOPE = 0.9;
const REAL_TIME_DECAY_MS = 2000;

export function computeDensityRampFactor(elapsedMs: number, densityRampMs: number): number {
  if (elapsedMs >= densityRampMs) return 1;
  return 0.25 + 0.75 * (elapsedMs / densityRampMs);
}

export function decayActivityCount(count: number, elapsedMs: number): number {
  if (elapsedMs > REAL_TIME_DECAY_MS) return 0;
  if (count <= 0) return count;
  const decayProgress = elapsedMs / REAL_TIME_DECAY_MS;
  return Math.max(Math.ceil(count * (1 - decayProgress)), 0);
}

export function computeAdaptiveMeanInterval(
  maxRate: number,
  minRate: number,
  activityCount: number,
  utilizationFactor: number,
  rampFactor: number
): number {
  const realTimeFactor = Math.max(REAL_TIME_FACTOR_MIN, 1 - activityCount * REAL_TIME_FACTOR_STEP);
  const congestionFactor = Math.min(realTimeFactor, utilizationFactor);
  const rawRate = Math.round(maxRate * congestionFactor * rampFactor);
  const adaptiveRate = Math.min(maxRate, Math.max(minRate, rawRate));
  return Math.round(1000 / adaptiveRate);
}

export class BacklogScheduler {
  // ── Rate constants ──────────────────────────────────────────
  static readonly REAL_TIME_ACTIVITY_CAP = 5;
  static readonly REAL_TIME_FACTOR_MIN = REAL_TIME_FACTOR_MIN;
  static readonly REAL_TIME_FACTOR_STEP = REAL_TIME_FACTOR_STEP;
  static readonly UTILIZATION_FACTOR_MIN = UTILIZATION_FACTOR_MIN;
  static readonly UTILIZATION_FACTOR_SLOPE = UTILIZATION_FACTOR_SLOPE;
  static readonly REAL_TIME_DECAY_MS = REAL_TIME_DECAY_MS;

  private config: SchedulerConfig;
  private lanes: number;
  private densityRampMs: number;

  constructor(config: SchedulerConfig, lanes: number) {
    this.config = config;
    this.lanes = lanes;
    this.densityRampMs = config.backlogDensityRampMs;
  }

  /**
   * Compute adaptive density ramp duration based on backlog size.
   * Small backlogs (<200) use the base ramp; large backlogs (>=500)
   * extend up to DENSITY_RAMP_MAX_MS to prevent visual flooding.
   */
  computeDensityRampMs(backlogSize: number): number {
    const { backlogDensityRampMs, backlogDensityRampMaxMs } = this.config;
    if (backlogSize >= DENSITY_LARGE_THRESHOLD) {
      return backlogDensityRampMaxMs;
    }
    if (backlogSize >= DENSITY_SMALL_THRESHOLD) {
      const t =
        (backlogSize - DENSITY_SMALL_THRESHOLD) /
        (DENSITY_LARGE_THRESHOLD - DENSITY_SMALL_THRESHOLD);
      return Math.round(
        backlogDensityRampMs + t * (backlogDensityRampMaxMs - backlogDensityRampMs)
      );
    }
    return backlogDensityRampMs;
  }

  /** Store computed density ramp duration. */
  setDensityRampMs(ms: number): void {
    this.densityRampMs = ms;
  }

  /**
   * Compute the density ramp factor (0.25–1.0).
   * Linearly interpolates from 0.25 to 1.0 over the adaptive density ramp window.
   * After the ramp window, returns 1.0 (full rate).
   */
  getDensityRampFactor(injectionStartTime: number, now: number = Date.now()): number {
    return computeDensityRampFactor(now - injectionStartTime, this.densityRampMs);
  }

  /**
   * Compute a utilization-based throttle factor (0.1–1.0).
   * When the screen is heavily occupied, injection slows down to prevent
   * visual crowding. Uses the lane utilization ratio from the allocator.
   */
  getUtilizationFactor(onUtilizationQuery: (() => number) | null): number {
    if (!onUtilizationQuery) return 1;
    const utilization = onUtilizationQuery();
    return Math.max(
      BacklogScheduler.UTILIZATION_FACTOR_MIN,
      1 - utilization * BacklogScheduler.UTILIZATION_FACTOR_SLOPE
    );
  }

  /**
   * Decay real-time activity count based on elapsed time since last
   * real-time message. Fully resets after REAL_TIME_DECAY_MS of inactivity;
   * gentle linear decay during the decay window.
   */
  /**
   * Full rate computation including utilization query, congestion factors,
   * and density ramp. Used by the orchestrator's processTick.
   *
   * Returns the mean interval (ms) between ticks and the updated
   * real-time activity count after time-based decay.
   */
  computeMeanIntervalWithUtilization(
    realTimeActivityCount: number,
    lastRealTimeActivityAt: number,
    injectionStartTime: number,
    onUtilizationQuery: (() => number) | null,
    now: number = Date.now()
  ): { meanInterval: number; updatedActivityCount: number } {
    const maxRate = Math.max(
      this.config.backlogInjectionRateMin,
      Math.min(this.config.backlogInjectionMax, this.config.backlogMaxRate, this.lanes * 2)
    );

    const updatedCount = decayActivityCount(realTimeActivityCount, now - lastRealTimeActivityAt);
    const utilizationFactor = this.getUtilizationFactor(onUtilizationQuery);
    const rampFactor = this.getDensityRampFactor(injectionStartTime, now);

    const minRate = Math.max(this.lanes + 1, 2);

    return {
      meanInterval: computeAdaptiveMeanInterval(
        maxRate,
        minRate,
        updatedCount,
        utilizationFactor,
        rampFactor
      ),
      updatedActivityCount: updatedCount,
    };
  }

  /**
   * Schedule the next injection tick using Poisson-distributed spacing.
   *
   * Returns the timer handle.
   */
  scheduleNextTick(
    processTick: () => void,
    meanInterval: number,
    random: () => number = Math.random
  ): ReturnType<typeof setTimeout> {
    const floorMs = Math.max(32, Math.round(meanInterval * 0.6));
    const poissonDelay = Math.max(
      floorMs,
      Math.min(meanInterval * 2, sampleExponential(meanInterval, random))
    );
    return setTimeout(() => processTick(), poissonDelay);
  }

  /** Update config at runtime. */
  updateConfig(config: Partial<SchedulerConfig & { backlogDensityRampMs: number }>): void {
    this.config = { ...this.config, ...config };
    if ('backlogDensityRampMs' in config) {
      this.densityRampMs = this.config.backlogDensityRampMs;
    }
  }
}
