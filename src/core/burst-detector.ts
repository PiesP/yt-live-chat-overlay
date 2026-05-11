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
import { createLogger } from '@core/logging';
import type { ObservabilityReporter } from '@core/observability';

const log = createLogger('BurstDetector');

/** How many samples to keep for rate calculation */
const RATE_SAMPLE_WINDOW = 10;
/** Sample interval in ms */
const SAMPLE_INTERVAL_MS = 1_000;
/** How long after burst ends to return to normal (ms) */
const BURST_COOLDOWN_MS = 5_000;

/** Messages per second thresholds */
const ELEVATED_THRESHOLD = 5; // >5 msg/s
const HIGH_THRESHOLD = 15; // >15 msg/s
const EXTREME_THRESHOLD = 30; // >30 msg/s

export class BurstDetector {
  private samples: number[] = [];
  private currentLevel: BurstLevel = 'normal';
  private lastBurstTime: number = 0;
  private sampleInterval: ReturnType<typeof setInterval> | null = null;
  private samplesSinceLastCheck = 0;
  private observability: ObservabilityReporter | undefined;
  private onLevelChange: ((level: BurstLevel) => void) | undefined;

  constructor(observability?: ObservabilityReporter, onLevelChange?: (level: BurstLevel) => void) {
    this.observability = observability;
    this.onLevelChange = onLevelChange;
  }

  /** Called whenever a message is received */
  onMessageReceived(): void {
    this.samplesSinceLastCheck++;
  }

  /** Start periodic sampling */
  start(): void {
    if (this.sampleInterval) return;
    this.sampleInterval = setInterval(() => {
      this.samples.push(this.samplesSinceLastCheck);
      if (this.samples.length > RATE_SAMPLE_WINDOW) {
        this.samples.shift();
      }
      this.samplesSinceLastCheck = 0;
      this.evaluate();
    }, SAMPLE_INTERVAL_MS);
  }

  /** Stop periodic sampling */
  stop(): void {
    if (this.sampleInterval !== null) {
      clearInterval(this.sampleInterval);
      this.sampleInterval = null;
    }
    this.samplesSinceLastCheck = 0;
  }

  /** Get current burst level */
  getLevel(): BurstLevel {
    return this.currentLevel;
  }

  /** Evaluate current burst level based on recent samples */
  private evaluate(): void {
    if (this.samples.length === 0) return;

    const avgRate = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;

    const newLevel: BurstLevel =
      avgRate > EXTREME_THRESHOLD
        ? 'extreme'
        : avgRate > HIGH_THRESHOLD
          ? 'high'
          : avgRate > ELEVATED_THRESHOLD
            ? 'elevated'
            : 'normal';

    if (newLevel === this.currentLevel) {
      if (newLevel !== 'normal') {
        this.lastBurstTime = performance.now();
      }
      return;
    }

    // Cooldown: stay at current level if rate just dropped to normal
    if (newLevel === 'normal' && this.currentLevel !== 'normal') {
      if (performance.now() - this.lastBurstTime < BURST_COOLDOWN_MS) {
        return;
      }
    }

    if (newLevel !== 'normal') {
      this.lastBurstTime = performance.now();
    }

    this.currentLevel = newLevel;
    log.debug(`Burst level: ${newLevel} (rate=${avgRate.toFixed(1)} msg/s)`);
    this.observability?.updateBurstLevel(newLevel);
    this.onLevelChange?.(newLevel);
  }

  /** Clean up */
  destroy(): void {
    this.stop();
    this.samples = [];
    this.observability = undefined;
  }
}
