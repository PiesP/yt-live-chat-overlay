import type { ChatMessage } from '@app-types';

export interface QueuedMessage {
  message: ChatMessage;
  nextAttemptAt: number;
}

export class RenderRateLimiter {
  private tokens: number;
  private lastRefillTime: number;

  constructor(
    private readonly getLimit: () => number,
    private readonly refillIntervalMs = 100
  ) {
    this.tokens = this.getLimit();
    this.lastRefillTime = Date.now();
  }

  canAccept(now = Date.now()): boolean {
    this.refill(now);
    return this.tokens >= 1;
  }

  markProcessed(_now?: number): void {
    this.tokens = Math.max(0, this.tokens - 1);
  }

  shiftWindow(deltaMs: number): void {
    // Cap shift to match lane timeline bound (60s).
    if (deltaMs > 0 && this.lastRefillTime > 0) {
      this.lastRefillTime += Math.min(deltaMs, 60_000);
    }
  }

  reset(): void {
    this.tokens = this.getLimit();
    this.lastRefillTime = Date.now();
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefillTime;

    const intervalsElapsed = Math.floor(elapsed / this.refillIntervalMs);

    if (intervalsElapsed > 0) {
      const limit = this.getLimit();
      const tokensPerInterval = limit * (this.refillIntervalMs / 1000);
      const refillAmount = intervalsElapsed * tokensPerInterval;

      this.tokens = Math.min(limit, this.tokens + refillAmount);
      this.lastRefillTime += intervalsElapsed * this.refillIntervalMs;
    }
  }
}

export class RenderQueue {
  private items: QueuedMessage[] = [];

  constructor(private readonly maxSize: number) {}

  get length(): number {
    return this.items.length;
  }

  size(): number {
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
