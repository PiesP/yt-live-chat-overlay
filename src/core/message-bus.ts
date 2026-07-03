// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Lightweight typed publish/subscribe event bus.
 *
 * Provides a decoupling layer between message producers (ChatSource)
 * and consumers (RuntimeManager → Renderer).  Multiple subscribers
 * can observe the same message stream independently — useful for
 * debugging, logging, and future cross-cutting concerns.
 *
 * Thread-safe for serial access only (single-threaded browser event loop).
 */
export class MessageBus<T> {
  private readonly subscribers = new Set<(messages: T[]) => void>();
  private _publishedCount = 0;
  private _lastPublishTime = 0;

  /**
   * Publish a batch of messages to all subscribers.
   * Each subscriber is called synchronously in registration order.
   */
  publish(messages: T[]): void {
    if (messages.length === 0 || this.subscribers.size === 0) return;
    this._publishedCount += messages.length;
    this._lastPublishTime = performance.now();
    for (const handler of this.subscribers) {
      handler(messages);
    }
  }

  /**
   * Register a subscriber. Returns an unsubscribe function.
   * Handlers are called in registration order.
   */
  subscribe(handler: (messages: T[]) => void): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /** Number of currently registered subscribers. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Total number of messages published since creation. */
  get publishedCount(): number {
    return this._publishedCount;
  }

  /** Timestamp (ms) of the most recent publish call, or 0 if never published. */
  get lastPublishTime(): number {
    return this._lastPublishTime;
  }

  /** Remove all subscribers and reset counters. */
  destroy(): void {
    this.subscribers.clear();
    this._publishedCount = 0;
    this._lastPublishTime = 0;
  }
}
