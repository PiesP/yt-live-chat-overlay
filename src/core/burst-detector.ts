// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * BurstDetector
 *
 * Detects chat burst levels based on incoming message rate over a sliding
 * window of samples.  Provides the current burst level for downstream
 * consumers (retry delay, duration scaling, sampling, etc.).
 *
 * Zero runtime dependencies — all processing uses plain counters and
 * standard browser timers.
 */

import type { BurstLevel } from '@app-types';
import { clearSafeInterval } from '@core/dom';
import { createLogger } from '@core/logging';

const log = createLogger('BurstDetector');

/**
 * Minimal observer interface for burst level updates.
 *
 * Consumers that only need to react to burst level changes (e.g.,
 * ObservabilityReporter) can satisfy this interface without depending
 * on the full ObservabilityReporter type.
 */
export interface BurstLevelObserver {
  updateBurstLevel(level: BurstLevel): void;
}

// rateSampleWindow set via updateThresholds() from settings
/** Sample interval in ms */
const SAMPLE_INTERVAL_MS = 1_000;
/** How long after burst ends to return to normal (ms) — base value,
 * scaled proportionally to burst duration. Short bursts cool down faster. */
const BURST_COOLDOWN_BASE_MS = 2_000;
const BURST_COOLDOWN_MAX_MS = 8_000;
/** Cooldown ratio: N ms of cooldown per ms of burst duration. */
const BURST_COOLDOWN_RATIO = 0.3;
/** EMA smoothing factor — higher = more reactive to recent changes */
const EMA_ALPHA = 0.3;

/** Messages per second thresholds */
// elevatedThreshold set via updateThresholds() from settings
// highThreshold set via updateThresholds() from settings
// extremeThreshold set via updateThresholds() from settings

export class BurstDetector {
  private samples: number[] = [];
  private runningSum = 0;
  private currentLevel: BurstLevel = 'normal';
  private lastBurstTime: number = 0;
  private burstStartTime: number = 0;
  private sampleInterval: ReturnType<typeof setInterval> | null = null;
  private samplesSinceLastCheck = 0;
  private emaRate: number = 0;
  /** Timestamp of the most recently received message (for inter-message-interval EMA). */
  private lastMessageTime: number = 0;
  private observability: BurstLevelObserver | undefined;
  private rateSampleWindow = 10;
  private elevatedThreshold = 5;
  private highThreshold = 15;
  private extremeThreshold = 30;

  constructor(observability?: BurstLevelObserver) {
    this.observability = observability;
  }

  /** Update burst detection thresholds from user settings. */
  updateThresholds(settings: {
    burstSampleWindow: number;
    burstElevatedThreshold: number;
    burstHighThreshold: number;
    burstExtremeThreshold: number;
  }): void {
    this.rateSampleWindow = settings.burstSampleWindow;
    this.elevatedThreshold = settings.burstElevatedThreshold;
    this.highThreshold = settings.burstHighThreshold;
    this.extremeThreshold = settings.burstExtremeThreshold;
  }

  /** Called whenever a message is received */
  onMessageReceived(): void {
    this.samplesSinceLastCheck++;

    // Update EMA on every message using the inter-message interval for
    // near-instantaneous speed adaptation — much faster than the 1s
    // sampling interval used by burst level evaluation.
    const now = performance.now();
    if (this.lastMessageTime > 0) {
      const intervalMs = now - this.lastMessageTime;
      const instantRate = 1000 / Math.max(1, intervalMs); // msg/s, avoid div-by-zero
      this.emaRate = EMA_ALPHA * instantRate + (1 - EMA_ALPHA) * this.emaRate;
    }
    this.lastMessageTime = now;
  }

  /** Start periodic sampling */
  start(): void {
    if (this.sampleInterval) return;
    this.sampleInterval = setInterval(() => {
      const count = this.samplesSinceLastCheck;
      this.samples.push(count);
      this.runningSum += count;
      if (this.samples.length > this.rateSampleWindow) {
        const removed = this.samples.shift() ?? 0;
        this.runningSum -= removed;
      }
      this.samplesSinceLastCheck = 0;
      this.evaluate();
    }, SAMPLE_INTERVAL_MS);
  }

  /** Get current EMA-smoothed message rate for speed adaptation */
  getEmaRate(): number {
    return this.emaRate;
  }

  /** Stop periodic sampling */
  stop(): void {
    this.sampleInterval = clearSafeInterval(this.sampleInterval);
    this.samplesSinceLastCheck = 0;
  }

  /**
   * Pause burst detection. Preserves EMA rate so speed adaptation
   * restarts from a reasonable value instead of zero — resetting to 0
   * creates a 3-5 message blind spot before the EMA converges to the
   * actual rate. lastMessageTime is reset to 0 so the first
   * post-resume onMessageReceived() call skips interval computation
   * (avoiding a stale time delta from the pre-pause message).
   */
  pause(): void {
    this.stop();
    this.lastMessageTime = 0;
    this.samples = [];
    this.runningSum = 0;
    this.currentLevel = 'normal';
    this.lastBurstTime = 0;
    this.burstStartTime = 0;
  }

  /**
   * Resume burst detection from a clean state.
   * Call when the tab becomes visible again.
   */
  resume(): void {
    this.samples = [];
    this.runningSum = 0;
    this.lastBurstTime = 0;
    this.burstStartTime = 0;
    this.start();
  }

  /** Get current burst level */
  getLevel(): BurstLevel {
    return this.currentLevel;
  }

  /** Evaluate current burst level based on recent samples */
  private evaluate(): void {
    if (this.samples.length === 0) return;

    const now = performance.now();
    const avgRate = this.samples.length > 0 ? this.runningSum / this.samples.length : 0;

    const newLevel: BurstLevel =
      avgRate > this.extremeThreshold
        ? 'extreme'
        : avgRate > this.highThreshold
          ? 'high'
          : avgRate > this.elevatedThreshold
            ? 'elevated'
            : 'normal';

    if (newLevel === this.currentLevel) {
      if (newLevel !== 'normal') {
        this.lastBurstTime = now;
        if (this.burstStartTime === 0) this.burstStartTime = now;
      }
      return;
    }

    // Adaptive cooldown: proportional to burst duration.
    // A 1-second burst cools down in ~2.3s. A 10-second burst cools down
    // in ~5s (capped at 8s). Prevents over-strict rate limiting after
    // short surges while maintaining protection after sustained spikes.
    if (newLevel === 'normal' && this.currentLevel !== 'normal') {
      const burstDuration = now - this.burstStartTime;
      const cooldown = Math.min(
        BURST_COOLDOWN_MAX_MS,
        BURST_COOLDOWN_BASE_MS + burstDuration * BURST_COOLDOWN_RATIO
      );
      if (now - this.lastBurstTime < cooldown) {
        return;
      }
    }

    if (newLevel !== 'normal') {
      this.lastBurstTime = now;
      if (this.burstStartTime === 0) this.burstStartTime = now;
    } else {
      this.burstStartTime = 0;
    }

    this.currentLevel = newLevel;
    log.debug(`Burst level: ${newLevel} (rate=${avgRate.toFixed(1)} msg/s)`);
    this.observability?.updateBurstLevel(newLevel);
  }

  /** Clean up */
  destroy(): void {
    this.stop();
    this.samples = [];
    this.emaRate = 0;
    this.lastMessageTime = 0;
    this.lastBurstTime = 0;
    this.burstStartTime = 0;
    this.observability = undefined;
  }
}
