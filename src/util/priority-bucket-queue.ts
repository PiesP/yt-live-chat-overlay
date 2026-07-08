// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage } from '@app-types';

/**
 * Priority-bucketed message queue for O(1) enqueue.
 *
 * Priority values are small discrete integers (6 known levels:
 * 200/150/100/50/0/-50). Messages are stored in priority-level
 * buckets. Enqueue is O(1) push to bucket. Dequeue scans buckets
 * from highest to lowest priority (O(k) where k ≤ number of
 * distinct priority levels, typically 6).
 *
 * Replaces the previous binary-search + splice() approach which
 * was O(n) per insert due to splice's array element shifting.
 *
 * Each bucket uses an internal offset for O(1) shift-free dequeue.
 * Buckets are compacted when the offset exceeds half the array
 * length, preventing unbounded memory growth.
 */
export class PriorityBucketQueue<T = ChatMessage> {
  /** Priority → { messages array, read offset } */
  private readonly buckets = new Map<number, { msgs: T[]; offset: number }>();
  /** Known priority levels sorted descending for efficient dequeue scan. */
  private priorityLevels: number[] = [];
  private _size = 0;

  /** Total number of messages across all buckets. */
  get size(): number {
    return this._size;
  }

  /** Whether the queue has any messages. */
  get isEmpty(): boolean {
    return this._size === 0;
  }

  /**
   * Add a message to its priority bucket. O(1).
   * Dynamically registers new priority levels on first encounter.
   */
  enqueue(message: T, priority: number): void {
    let entry = this.buckets.get(priority);
    if (!entry) {
      entry = { msgs: [], offset: 0 };
      this.buckets.set(priority, entry);
      // Rebuild sorted priority list (infrequent — only on new levels)
      this.priorityLevels = Array.from(this.buckets.keys()).sort((a, b) => b - a);
    }
    entry.msgs.push(message);
    this._size++;
  }

  /**
   * Remove and return the highest-priority message.
   * O(k) where k = number of priority levels (~6).
   * Returns undefined if the queue is empty.
   */
  dequeue(): T | undefined {
    for (const prio of this.priorityLevels) {
      const entry = this.buckets.get(prio);
      if (!entry) continue;
      const { msgs } = entry;
      if (entry.offset < msgs.length) {
        const msg = msgs[entry.offset];
        if (!msg) continue;
        entry.offset++;
        this._size--;
        // Compact when more than half the array is consumed
        if (entry.offset > 0 && entry.offset >= msgs.length / 2) {
          entry.msgs = msgs.slice(entry.offset);
          entry.offset = 0;
        }
        return msg;
      }
    }
    return undefined;
  }

  /**
   * Peek at the highest-priority message without removing it.
   * Returns undefined if the queue is empty.
   */
  peek(): T | undefined {
    for (const prio of this.priorityLevels) {
      const entry = this.buckets.get(prio);
      if (!entry) continue;
      if (entry.offset < entry.msgs.length) return entry.msgs[entry.offset];
    }
    return undefined;
  }

  /**
   * Peek at the lowest-priority message without removing it.
   * Used to determine whether an incoming message has higher priority
   * than anything currently in the queue (for queue-full displacement).
   * Returns undefined if the queue is empty.
   */
  peekLowest(): T | undefined {
    for (let i = this.priorityLevels.length - 1; i >= 0; i--) {
      const prio = this.priorityLevels[i];
      if (prio === undefined) continue;
      const entry = this.buckets.get(prio);
      if (!entry) continue;
      if (entry.offset < entry.msgs.length) {
        return entry.msgs[entry.msgs.length - 1]; // newest at this priority
      }
    }
    return undefined;
  }

  /**
   * Drop the lowest-priority message from the queue.
   * Used when queue is at capacity and a higher-priority message
   * needs to displace the least important entry.
   */
  dropLowest(): void {
    for (let i = this.priorityLevels.length - 1; i >= 0; i--) {
      const prio = this.priorityLevels[i];
      if (prio === undefined) continue;
      const entry = this.buckets.get(prio);
      if (!entry) continue;
      if (entry.offset < entry.msgs.length) {
        // Remove the oldest unconsumed message at this priority level (FIFO)
        entry.msgs.shift();
        this._size--;
        return;
      }
    }
  }

  /**
   * Remove specific messages from the queue.
   * O(n) where n = total unconsumed messages across all buckets.
   * Returns the number of messages actually removed.
   *
   * Used by drainQueue to atomically remove successfully placed messages
   * after a peek-based drain pass, eliminating the dequeue→retry→refill
   * cycle that could lose messages when the skip limit was exceeded.
   */
  removeAll(messages: T[]): number {
    if (messages.length === 0) return 0;
    const toRemove = new Set(messages);
    let removed = 0;

    for (const prio of this.priorityLevels) {
      const entry = this.buckets.get(prio);
      if (!entry) continue;
      const { msgs } = entry;
      if (entry.offset >= msgs.length) continue;

      let writeIdx = entry.offset;
      for (let i = entry.offset; i < msgs.length; i++) {
        const msg = msgs[i];
        if (msg !== undefined && !toRemove.has(msg)) {
          msgs[writeIdx++] = msg;
        } else {
          removed++;
        }
      }
      msgs.length = writeIdx;
    }

    this._size -= removed;
    return removed;
  }

  /** Clear all buckets and reset state. */
  clear(): void {
    this.buckets.clear();
    this.priorityLevels = [];
    this._size = 0;
  }

  /**
   * Return all queued items as an array, ordered from highest to lowest
   * priority.  Items at the same priority level are FIFO-ordered.
   * Does NOT modify the queue (no side effects).
   */
  toArray(): T[] {
    const result: T[] = [];
    for (const prio of this.priorityLevels) {
      const entry = this.buckets.get(prio);
      if (!entry) continue;
      for (let i = entry.offset; i < entry.msgs.length; i++) {
        result.push(entry.msgs[i] as T);
      }
    }
    return result;
  }

  /**
   * Trim the queue to at most `maxSize` messages, keeping the
   * highest-priority entries. Removes from lowest-priority
   * buckets first. Used for background queue trimming.
   */
  trim(maxSize: number): void {
    if (this._size <= maxSize) return;
    let toRemove = this._size - maxSize;
    for (let i = this.priorityLevels.length - 1; i >= 0 && toRemove > 0; i--) {
      const prio = this.priorityLevels[i];
      if (prio === undefined) continue;
      const entry = this.buckets.get(prio);
      if (!entry) continue;
      if (entry.offset < entry.msgs.length) {
        const activeCount = entry.msgs.length - entry.offset;
        const removeCount = Math.min(toRemove, activeCount);
        entry.msgs.length -= removeCount;
        this._size -= removeCount;
        toRemove -= removeCount;
      }
    }
  }
}
