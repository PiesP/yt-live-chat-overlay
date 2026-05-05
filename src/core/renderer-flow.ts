import type { ChatMessage } from '@app-types';

export interface QueuedMessage {
  message: ChatMessage;
  nextAttemptAt: number;
}

export class RenderRateLimiter {
  private lastProcessTime = 0;
  private processedInCurrentWindow = 0;

  constructor(
    private readonly getLimit: () => number,
    private readonly windowMs = 1000
  ) {}

  canAccept(now = Date.now()): boolean {
    this.rollWindow(now);
    return this.processedInCurrentWindow < this.getLimit();
  }

  markProcessed(now = Date.now()): void {
    this.rollWindow(now);
    this.processedInCurrentWindow += 1;
  }

  shiftWindow(deltaMs: number): void {
    // Cap shift to match lane timeline bound (60s).
    if (deltaMs > 0 && this.lastProcessTime > 0) {
      this.lastProcessTime += Math.min(deltaMs, 60_000);
    }
  }

  reset(): void {
    this.lastProcessTime = 0;
    this.processedInCurrentWindow = 0;
  }

  private rollWindow(now: number): void {
    if (now - this.lastProcessTime > this.windowMs) {
      this.processedInCurrentWindow = 0;
      this.lastProcessTime = now;
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
