/**
 * SpreadEmitter — low-latency message distribution with adaptive spread.
 *
 * Design:
 * - First message in each batch is emitted immediately (zero delay).
 * - Subsequent messages are spread using a Poisson-like distribution
 *   controlled by spreadFactor: lower = tighter/faster, wider = smoother.
 * - Priority messages (SuperChat, Membership) always bypass the buffer.
 * - When spreadFactor <= 0.2, all messages emit immediately (no spread).
 */

import type { ChatMessage } from '@app-types';
import { createLogger } from '@core/logging';

const log = createLogger('SpreadEmitter');

const MAX_SPREAD_BUFFER = 100;

function isPriorityMessage(message: ChatMessage): boolean {
  return message.kind === 'superchat' || message.kind === 'membership';
}

export class SpreadEmitter {
  private readonly buffer: ChatMessage[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private baseSpreadInterval = 50;
  private paused = false;
  private destroyed = false;
  private burstCount = 0;

  constructor(
    private readonly emitMessage: (msg: ChatMessage) => void,
    private readonly getSpreadFactor: () => number
  ) {}

  /**
   * Enqueue messages for spread emission.
   * Priority messages are always emitted immediately.
   * The first normal message is emitted immediately; subsequent ones are spread.
   */
  enqueue(messages: ChatMessage[]): void {
    if (this.destroyed || messages.length === 0) return;

    const normalMessages: ChatMessage[] = [];

    for (const msg of messages) {
      if (isPriorityMessage(msg)) {
        this.emitMessage(msg);
        continue;
      }
      normalMessages.push(msg);
    }

    if (normalMessages.length === 0) return;

    if (this.buffer.length + normalMessages.length > MAX_SPREAD_BUFFER) {
      this.buffer.push(...normalMessages);
      this.flushAll();
      return;
    }

    this.buffer.push(...normalMessages);

    // Emit the first message immediately if this is a new burst
    if (this.timer === null && !this.paused) {
      const msg = this.buffer.shift();
      if (msg) {
        this.emitMessage(msg);
        this.burstCount = 1;
      }
    }

    this.ensureTimer();
  }

  /**
   * Set the target spread interval (ms) between emitted messages.
   */
  setSpreadInterval(intervalMs: number): void {
    this.baseSpreadInterval = Math.max(16, intervalMs);
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.clearTimer();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.buffer.length > 0) {
      this.ensureTimer();
    }
  }

  /**
   * Flush all buffered messages immediately.
   */
  flushAll(): void {
    this.clearTimer();
    if (this.buffer.length === 0) return;
    log.debug(`Flushing ${this.buffer.length} buffered messages`);
    while (this.buffer.length > 0) {
      const msg = this.buffer.shift();
      if (msg) this.emitMessage(msg);
    }
    this.burstCount = 0;
  }

  getBufferSize(): number {
    return this.buffer.length;
  }

  destroy(): void {
    this.destroyed = true;
    this.clearTimer();
    this.buffer.length = 0;
  }

  private ensureTimer(): void {
    if (this.timer !== null || this.paused || this.destroyed) return;
    if (this.buffer.length === 0) return;
    this.scheduleNext();
  }

  private scheduleNext(): void {
    const factor = this.getSpreadFactor();

    // Zero or ultra-low spread: emit immediately (no timer needed)
    if (factor <= 0.2) {
      this.tick();
      return;
    }

    // Adaptive delay: decreases as burst count increases (ramp-up)
    const rampMultiplier = Math.max(0.3, 1 - this.burstCount * 0.1);
    const effectiveInterval = this.baseSpreadInterval * factor * rampMultiplier;
    const delay = Math.max(16, Math.round(effectiveInterval * (0.5 + Math.random())));

    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
  }

  private tick(): void {
    if (this.paused || this.destroyed) return;
    if (this.buffer.length === 0) return;

    const msg = this.buffer.shift();
    if (msg) {
      this.emitMessage(msg);
      this.burstCount++;
    }

    if (this.buffer.length > 0) {
      this.scheduleNext();
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
