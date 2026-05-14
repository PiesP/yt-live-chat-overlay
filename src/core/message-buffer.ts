import type { ChatMessage } from '@app-types';

const RECENT_MESSAGE_BUFFER_SIZE = 100;

export class MessageBuffer {
  private readonly messages: ChatMessage[] = [];

  push(message: ChatMessage): void {
    this.messages.push(message);
    const overflow = this.messages.length - RECENT_MESSAGE_BUFFER_SIZE;
    if (overflow > 0) {
      this.messages.splice(0, overflow);
    }
  }

  getLatest(limit: number): ChatMessage[] {
    if (limit <= 0) return [];
    return this.messages.slice(-limit);
  }

  clear(): void {
    this.messages.length = 0;
  }
}
