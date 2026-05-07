import type { ChatMessage } from '@app-types';

export interface QueuedMessage {
  message: ChatMessage;
  nextAttemptAt: number;
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
