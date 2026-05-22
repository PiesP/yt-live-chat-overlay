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

import type { BurstLevel, Pauseable } from '@app-types';
import { createLogger } from '@core/logging';
import type { ObservabilityReporter } from '@core/observability';

const log = createLogger('BurstDetector');

/** How many samples to keep for rate calculation */
const RATE_SAMPLE_WINDOW = 10;
/** Sample interval in ms */
const SAMPLE_INTERVAL_MS = 1_000;
/** How long after burst ends to return to normal (ms) */
const BURST_COOLDOWN_MS = 5_000;
/** EMA smoothing factor — higher = more reactive to recent changes */
const EMA_ALPHA = 0.3;

/** Messages per second thresholds */
const ELEVATED_THRESHOLD = 5; // >5 msg/s
const HIGH_THRESHOLD = 15; // >15 msg/s
const EXTREME_THRESHOLD = 30; // >30 msg/s

export class BurstDetector implements Pauseable {
  private samples: number[] = [];
  private currentLevel: BurstLevel = 'normal';
  private lastBurstTime: number = 0;
  private sampleInterval: ReturnType<typeof setInterval> | null = null;
  private samplesSinceLastCheck = 0;
  private observability: ObservabilityReporter | undefined;
  private emaRate: number = 0;
  /** Timestamp of the most recently received message (for inter-message-interval EMA). */
  private lastMessageTime: number = 0;

  constructor(observability?: ObservabilityReporter) {
    this.observability = observability;
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
      this.samples.push(this.samplesSinceLastCheck);
      if (this.samples.length > RATE_SAMPLE_WINDOW) {
        this.samples.shift();
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
    if (this.sampleInterval !== null) {
      clearInterval(this.sampleInterval);
      this.sampleInterval = null;
    }
    this.samplesSinceLastCheck = 0;
  }

  /**
   * Pause burst detection and reset all internal state.
   * Call when the tab becomes hidden so accumulated messages during
   * the hidden period don't pollute the rate on return.
   */
  pause(): void {
    this.stop();
    this.emaRate = 0;
    this.lastMessageTime = 0;
    this.samples = [];
    this.currentLevel = 'normal';
    this.lastBurstTime = 0;
  }

  /**
   * Resume burst detection from a clean state.
   * Call when the tab becomes visible again.
   */
  resume(): void {
    this.samples = [];
    this.currentLevel = 'normal';
    this.lastBurstTime = 0;
    this.start();
  }

  /**
   * Pauseable interface: delegates to pause()/resume().
   * Enables uniform handling via the Pauseable type.
   */
  setPaused(paused: boolean): void {
    if (paused) {
      this.pause();
    } else {
      this.resume();
    }
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
  }

  /** Clean up */
  destroy(): void {
    this.stop();
    this.samples = [];
    this.emaRate = 0;
    this.lastMessageTime = 0;
    this.observability = undefined;
  }
}
