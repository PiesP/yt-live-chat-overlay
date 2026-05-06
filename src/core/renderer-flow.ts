import type { ChatMessage } from '@app-types';

export interface QueuedMessage {
  message: ChatMessage;
  nextAttemptAt: number;
}

// ── Smooth Pacer ─────────────────────────────────────────────────────────
//
// Replaces the token-bucket rate limiter and cluster-state machine with a
// single arrival-rate-driven pacer.  Measures how fast messages arrive over a
// sliding time window and spaces displayed messages at the same rate, so
// comments flow steadily instead of bursting in batches.
//
//   Batch arrives        → pacer records N arrivals
//   Renderer asks "can I display?" → yes if enough time has passed
//   Time between displays ≈ 1000ms / (arrivals per second)
//
// On pause/resume the timeline is shifted so the pacer doesn't try to catch
// up by dumping all queued messages at once.
//
// ─────────────────────────────────────────────────────────────────────────

export interface SmoothPacerOptions {
  /** Returns the user-configured max messages per second (hard cap). */
  readonly getMaxRate: () => number;
  /** Sliding window for arrival rate measurement (ms). */
  readonly smoothingWindowMs?: number;
  /** Minimum gap between consecutive displays (ms). */
  readonly minSpacingMs?: number;
  /** Maximum gap when no messages are arriving (ms). */
  readonly maxSpacingMs?: number;
}

const SMOOTHING_WINDOW_MS = 3000;
const MIN_SPACING_MS = 50;
const MAX_SPACING_MS = 2000;

export class SmoothPacer {
  private readonly getMaxRate: () => number;
  private readonly smoothingWindowMs: number;
  private readonly minSpacingMs: number;
  private readonly maxSpacingMs: number;
  /** Timestamps of message arrivals within the smoothing window. */
  private readonly arrivalTimestamps: number[] = [];
  /** Wall-clock time of the most recent display. 0 = never displayed. */
  private lastDisplayTime = 0;

  constructor(options: SmoothPacerOptions) {
    this.getMaxRate = options.getMaxRate;
    this.smoothingWindowMs = options.smoothingWindowMs ?? SMOOTHING_WINDOW_MS;
    this.minSpacingMs = options.minSpacingMs ?? MIN_SPACING_MS;
    this.maxSpacingMs = options.maxSpacingMs ?? MAX_SPACING_MS;
  }

  /**
   * Record that a new message has arrived in the render queue.
   * Call this from `addMessage()` so the pacer knows the current arrival rate.
   */
  recordArrival(): void {
    this.arrivalTimestamps.push(Date.now());
    this.pruneWindow();
  }

  /**
   * Check whether a message may be displayed now.
   * Returns `true` when enough time has passed since the last display,
   * based on the current arrival velocity.
   */
  canDisplay(now: number): boolean {
    if (this.lastDisplayTime === 0) {
      this.lastDisplayTime = now;
      return true;
    }

    const spacing = this.calculateSpacing();
    const elapsed = now - this.lastDisplayTime;

    if (elapsed >= spacing) {
      // Maintain even spacing: advance by exactly `spacing` so that
      // back-to-back calls produce consistent intervals, not instant
      // catch-up when the system was blocked (e.g. lane-full).
      this.lastDisplayTime = Math.max(this.lastDisplayTime + spacing, now);
      return true;
    }

    return false;
  }

  /**
   * How long (ms) until the next display is permitted.
   * Returns 0 if display is permitted now.
   */
  getDisplayDelay(now: number): number {
    if (this.lastDisplayTime === 0) return 0;

    const spacing = this.calculateSpacing();
    const elapsed = now - this.lastDisplayTime;
    return Math.max(0, spacing - elapsed);
  }

  /**
   * Shift the internal timeline forward by `deltaMs` after a pause,
   * so the pacer doesn't try to catch up on messages that accumulated
   * while paused.  Capped at 60s to match lane timeline bounds.
   */
  shiftTimeline(deltaMs: number): void {
    if (deltaMs > 0 && this.lastDisplayTime > 0) {
      this.lastDisplayTime += Math.min(deltaMs, 60_000);
    }
  }

  /** Reset all state — used when the renderer is re-created. */
  reset(): void {
    this.arrivalTimestamps.length = 0;
    this.lastDisplayTime = 0;
  }

  // ── Private ──────────────────────────────────────────────────────────

  private calculateSpacing(): number {
    this.pruneWindow();

    // Arrival velocity: messages per second within the smoothing window.
    const velocity = this.arrivalTimestamps.length / (this.smoothingWindowMs / 1000);

    // Target spacing from velocity — the core of smooth pacing.
    let spacing = velocity > 0.1 ? 1000 / velocity : this.maxSpacingMs;

    // Hard cap from user setting: never exceed maxMessagesPerSecond.
    const maxRate = this.getMaxRate();
    if (maxRate > 0) {
      spacing = Math.max(spacing, 1000 / maxRate);
    }

    return Math.max(this.minSpacingMs, Math.min(spacing, this.maxSpacingMs));
  }

  private pruneWindow(): void {
    const cutoff = Date.now() - this.smoothingWindowMs;
    while (this.arrivalTimestamps.length > 0 && (this.arrivalTimestamps[0] as number) < cutoff) {
      this.arrivalTimestamps.shift();
    }
  }
}

export class RenderQueue {
  private items: QueuedMessage[] = [];

  constructor(private readonly maxSize: number) {}

  get length(): number {
    return this.items.length;
  }

  at(index: number): QueuedMessage | undefined {
    return this.items[index];
  }

  enqueue(message: ChatMessage): void {
    if (this.items.length >= this.maxSize) {
      const excess = this.items.length - this.maxSize + 1;
      this.items.splice(0, excess);
    }

    this.items.push({
      message,
      nextAttemptAt: 0,
    });
  }

  removeAt(index: number): void {
    this.items.splice(index, 1);
  }

  clear(onDiscard?: (message: ChatMessage) => void): void {
    if (onDiscard) {
      for (const item of this.items) {
        onDiscard(item.message);
      }
    }

    this.items = [];
  }

  sortByTimestamp(): void {
    this.items.sort((left, right) => left.message.timestamp - right.message.timestamp);
  }
}
