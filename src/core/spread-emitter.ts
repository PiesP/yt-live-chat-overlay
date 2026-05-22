/**
 * SpreadEmitter — evenly distributes poll messages across the poll interval.
 *
 * Instead of emitting an entire poll batch at once (burst → silence → burst),
 * messages are released one at a time on a Poisson-distributed schedule,
 * producing a steady visual flow.
 *
 * Priority messages (SuperChat, Membership) bypass the spread buffer and are
 * emitted immediately so paid content is never delayed.
 */

import type { ChatMessage } from '@app-types';
import { createLogger } from '@core/logging';

const log = createLogger('SpreadEmitter');

const MIN_SPREAD_INTERVAL_MS = 50;
const MAX_SPREAD_BUFFER = 100;

function isPriorityMessage(message: ChatMessage): boolean {
  return message.kind === 'superchat' || message.kind === 'membership';
}

export class SpreadEmitter {
  private readonly buffer: ChatMessage[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private baseSpreadInterval = MIN_SPREAD_INTERVAL_MS;
  private paused = false;
  private destroyed = false;

  constructor(
    private readonly emitMessage: (msg: ChatMessage) => void,
    private readonly getSpreadFactor: () => number
  ) {}

  /**
   * Enqueue messages for spread emission.
   * Priority messages (superchat, membership) are emitted immediately.
   * Normal messages are buffered and released gradually.
   */
  enqueue(messages: ChatMessage[]): void {
    if (this.destroyed || messages.length === 0) return;

    for (const msg of messages) {
      if (isPriorityMessage(msg)) {
        this.emitMessage(msg);
        continue;
      }
      this.buffer.push(msg);
    }

    if (this.buffer.length > MAX_SPREAD_BUFFER) {
      this.flushAll();
      return;
    }

    this.ensureTimer();
  }

  /**
   * Set the target spread interval (ms) between emitted messages.
   * Called by LiveChatSource after each poll to adapt to the current
   * poll interval.
   */
  setSpreadInterval(intervalMs: number): void {
    this.baseSpreadInterval = Math.max(MIN_SPREAD_INTERVAL_MS, intervalMs);
  }

  /**
   * Pause spread emission (e.g. when video is paused).
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.clearTimer();
  }

  /**
   * Resume spread emission.
   */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.buffer.length > 0) {
      this.ensureTimer();
    }
  }

  /**
   * Flush all buffered messages immediately.
   * Called on destroy, settings change, or buffer overflow.
   */
  flushAll(): void {
    this.clearTimer();
    if (this.buffer.length === 0) return;
    log.debug(`Flushing ${this.buffer.length} buffered messages`);
    while (this.buffer.length > 0) {
      const msg = this.buffer.shift();
      if (msg) this.emitMessage(msg);
    }
  }

  /**
   * Current buffer size (for observability).
   */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Clean up all resources.
   */
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
    const effectiveInterval = this.baseSpreadInterval * factor;
    const delay = Math.max(MIN_SPREAD_INTERVAL_MS, Math.random() * (effectiveInterval * 2));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
  }

  private tick(): void {
    if (this.paused || this.destroyed) return;
    if (this.buffer.length === 0) return;

    const msg = this.buffer.shift();
    if (msg) this.emitMessage(msg);

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
