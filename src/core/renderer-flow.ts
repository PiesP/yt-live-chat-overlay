import type { ChatMessage } from '@app-types';

export interface QueuedMessage {
  message: ChatMessage;
  nextAttemptAt: number;
}

export class MessageIdRegistry {
  private readonly ids = new Set<string>();

  constructor(private readonly maxSize: number) {}

  has(id: string): boolean {
    return this.ids.has(id);
  }

  mark(id: string): void {
    this.ids.add(id);
    if (this.ids.size <= this.maxSize) {
      return;
    }

    const iterator = this.ids.values();
    const excess = this.ids.size - this.maxSize;
    for (let index = 0; index < excess; index++) {
      const next = iterator.next();
      if (next.done || next.value === undefined) {
        break;
      }

      this.ids.delete(next.value);
    }
  }

  release(id: string): void {
    this.ids.delete(id);
  }

  clear(): void {
    this.ids.clear();
  }
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
    if (deltaMs > 0 && this.lastProcessTime > 0) {
      this.lastProcessTime += deltaMs;
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
}
