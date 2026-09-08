// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * ReplayBuffer — time-indexed sorted buffer for replay chat messages.
 *
 * Stores messages sorted by videoOffsetMs and deduplicated by message ID.
 * Single inserts use binary search followed by an O(n) array insertion;
 * pages are sorted and merged in bulk. Flush emits due messages in bounded
 * batches to prevent visual clumping.
 */

import type { ChatMessage } from '@app-types';
import type { ChatEvent } from '@chat/message-parser';

interface BufferedReplayMessage {
  message: ChatMessage;
  offsetMs: number;
  estimatedBytes: number;
}

const MAX_BUFFERED_REPLAY_MESSAGES = 3000;
const MAX_BUFFERED_REPLAY_BYTES = 8 * 1024 * 1024;
// H2: Widened from 300ms to 2000ms. The original 300ms tolerance dropped
// messages after any frame hitch during replay playback, causing visible
// chat gaps. At 2s, messages slightly behind position are still forwarded
// to the renderer (which clips them to the current position anyway).
const REPLAY_EMIT_TOLERANCE_MS = 2000;

export class ReplayBuffer {
  private buffer: BufferedReplayMessage[] = [];
  private bufferOffset = 0;
  private seenIds = new Set<string>();
  private activeEstimatedBytes = 0;

  /** True when the buffer has no unconsumed messages. */
  get isEmpty(): boolean {
    return this.messageCount <= 0;
  }

  /** Number of unconsumed messages retained by the replay buffer. */
  get messageCount(): number {
    return this.buffer.length - this.bufferOffset;
  }

  /** Conservative estimate used to bound retained replay data. */
  get estimatedByteSize(): number {
    return this.activeEstimatedBytes;
  }

  /** Amount of replay timeline currently buffered ahead of playback. */
  aheadHorizonMs(currentOffsetMs: number): number {
    const latest = this.buffer.at(-1);
    return latest ? Math.max(0, latest.offsetMs - currentOffsetMs) : 0;
  }

  /**
   * Insert a message in sorted order by offsetMs.
   *
   * Uses binary search to maintain sort order and deduplicates by
   * message ID so the same message is never buffered twice.
   */
  insert(message: ChatMessage, offsetMs: number): void {
    // Deduplicate by message ID (same message from overlapping continuation chains)
    if (message.id && this.seenIds.has(message.id)) return;

    let lo = this.bufferOffset;
    let hi = this.buffer.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const item = this.buffer[mid];
      if (!item) break;
      if (item.offsetMs <= offsetMs) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    const estimatedBytes = estimateMessageBytes(message);
    this.buffer.splice(lo, 0, { message, offsetMs, estimatedBytes });
    this.activeEstimatedBytes += estimatedBytes;
    if (message.id) this.seenIds.add(message.id);
    this.trimToCapacity();
  }

  /**
   * Bulk-insert pre-parsed chat events.
   *
   * Events whose offsetMs falls below `minimumOffsetMs` are skipped.
   * Returns the highest offsetMs seen across all inserted events.
   */
  appendEvents(events: ChatEvent[], minimumOffsetMs = 0): number {
    let highestOffsetMs = -1;
    const incoming: BufferedReplayMessage[] = [];
    const incomingIds = new Set<string>();

    for (const event of events) {
      const offsetMs = event.message.videoOffsetMs ?? event.offsetMs;
      if (offsetMs === undefined) continue;

      highestOffsetMs = Math.max(highestOffsetMs, offsetMs);

      if (offsetMs < minimumOffsetMs) continue;
      const id = event.message.id;
      if (id && (this.seenIds.has(id) || incomingIds.has(id))) continue;
      if (id) incomingIds.add(id);
      incoming.push({
        message: event.message,
        offsetMs,
        estimatedBytes: estimateMessageBytes(event.message),
      });
    }

    if (incoming.length === 0) return highestOffsetMs;

    // Continuation pages are usually monotonic, while overlapping pages may
    // contain a short earlier prefix. Sort once and merge the page with the
    // active suffix instead of splicing every event into the middle.
    incoming.sort((left, right) => left.offsetMs - right.offsetMs);
    const active = this.buffer.slice(this.bufferOffset);
    const merged: BufferedReplayMessage[] = [];
    let activeIndex = 0;
    let incomingIndex = 0;
    while (activeIndex < active.length && incomingIndex < incoming.length) {
      const activeItem = active[activeIndex];
      const incomingItem = incoming[incomingIndex];
      if (!activeItem || !incomingItem) break;
      if (activeItem.offsetMs <= incomingItem.offsetMs) {
        merged.push(activeItem);
        activeIndex += 1;
      } else {
        merged.push(incomingItem);
        incomingIndex += 1;
      }
    }
    merged.push(...active.slice(activeIndex), ...incoming.slice(incomingIndex));

    this.buffer = merged;
    this.bufferOffset = 0;
    for (const item of incoming) {
      this.activeEstimatedBytes += item.estimatedBytes;
      if (item.message.id) this.seenIds.add(item.message.id);
    }
    this.trimToCapacity();

    return highestOffsetMs;
  }

  /**
   * Flush messages whose video offset has been reached.
   *
   * Collects up to `maxBatch` messages where `offsetMs <= currentOffsetMs`.
   * Past messages (too far behind) are silently dropped.
   * Messages still in the future stay in the buffer.
   */
  flushUpTo(currentOffsetMs: number, maxBatch: number): ChatMessage[] {
    if (this.messageCount <= 0) return [];

    const batch: ChatMessage[] = [];

    while (this.messageCount > 0 && batch.length < maxBatch) {
      const next = this.buffer[this.bufferOffset];
      if (!next) break;

      // Future messages — stop, they're not ready yet
      if (next.offsetMs > currentOffsetMs + REPLAY_EMIT_TOLERANCE_MS) break;

      // Advance offset instead of shift()
      this.bufferOffset++;
      this.activeEstimatedBytes -= next.estimatedBytes;

      // The message has left the active buffer whether it is emitted or
      // dropped as too late. Allow overlapping continuation chains to
      // insert the same ID again if it reappears at a relevant offset.
      if (next.message.id) {
        this.seenIds.delete(next.message.id);
      }

      // Too far in the past — drop silently
      if (next.offsetMs < currentOffsetMs - REPLAY_EMIT_TOLERANCE_MS) {
        continue;
      }

      batch.push(next.message);
    }

    this.compactConsumedPrefix(64);

    return batch;
  }

  /** Clear all buffered messages (e.g. on seek). */
  clear(): void {
    this.buffer = [];
    this.bufferOffset = 0;
    this.seenIds.clear();
    this.activeEstimatedBytes = 0;
  }

  /**
   * Drain buffered messages up to (and including) the given offset.
   * Messages with offsetMs > maxOffsetMs remain in the buffer for later
   * emission via the normal flushUpTo() path. When maxOffsetMs is omitted,
   * all messages are drained (equivalent to the old drainAll()).
   *
   * Used when returning from a hidden tab state with a replay source.
   * Draining only messages at or near the current playback position
   * prevents future messages (e.g., from prefetch) from appearing
   * before past messages, preserving time ordering.
   */
  drainUpTo(maxOffsetMs?: number): ChatMessage[] {
    if (maxOffsetMs == null) {
      return this.drainAll();
    }

    const messages: ChatMessage[] = [];
    let drainEnd = this.bufferOffset;

    for (let i = this.bufferOffset; i < this.buffer.length; i++) {
      const item = this.buffer[i];
      if (!item) continue;
      if (item.offsetMs > maxOffsetMs) {
        break; // Buffer is offsetMs-sorted — stop at first future message
      }
      messages.push(item.message);
      drainEnd = i + 1;
      this.activeEstimatedBytes -= item.estimatedBytes;
    }

    if (messages.length === 0) return [];

    // Advance offset past drained region, keeping future messages in buffer.
    this.bufferOffset = drainEnd;

    // Remove drained message IDs from seenIds so they can be re-inserted
    // if re-fetched (e.g., after a seek during the hidden period).
    for (const msg of messages) {
      if (msg.id) this.seenIds.delete(msg.id);
    }

    this.compactConsumedPrefix(64);

    return messages;
  }

  /**
   * Drain all buffered messages regardless of their offsetMs.
   *
   * Returns every unconsumed message currently in the buffer (sorted by
   * offsetMs) and clears the buffer. Used when returning from a hidden
   * tab state — accumulated replay messages need to be routed through
   * the backlog controller for gradual emission instead of bursting.
   */
  drainAll(): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (let i = this.bufferOffset; i < this.buffer.length; i++) {
      const item = this.buffer[i];
      if (item) {
        messages.push(item.message);
      }
    }
    this.buffer = [];
    this.bufferOffset = 0;
    this.seenIds.clear();
    this.activeEstimatedBytes = 0;
    return messages;
  }

  /**
   * Enforce hard count and byte bounds by dropping the farthest-future data.
   * The fetch scheduler stops at lower soft limits, leaving room for one
   * ordinary continuation page. A page can overflow those soft limits, but
   * never these hard bounds. Keeping the earliest entries protects messages
   * closest to the current playback position.
   */
  private trimToCapacity(): void {
    while (
      this.messageCount > MAX_BUFFERED_REPLAY_MESSAGES ||
      this.activeEstimatedBytes > MAX_BUFFERED_REPLAY_BYTES
    ) {
      const removed = this.buffer.pop();
      if (!removed) break;
      this.activeEstimatedBytes -= removed.estimatedBytes;
      if (removed.message.id) this.seenIds.delete(removed.message.id);
    }
  }

  /** Release consumed entries while preserving the active sorted suffix. */
  private compactConsumedPrefix(threshold: number): void {
    if (this.bufferOffset <= threshold) return;
    this.buffer = this.buffer.slice(this.bufferOffset);
    this.bufferOffset = 0;
  }
}

function estimateMessageBytes(message: ChatMessage): number {
  return 128 + estimateValueBytes(message, new WeakSet<object>(), 0);
}

function estimateValueBytes(value: unknown, seen: WeakSet<object>, depth: number): number {
  if (value == null) return 4;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number' || typeof value === 'bigint') return 8;
  if (typeof value === 'boolean') return 4;
  if (typeof value !== 'object' || depth >= 8) return 16;
  if (seen.has(value)) return 0;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + estimateValueBytes(item, seen, depth + 1), 16);
  }

  let bytes = 32;
  for (const [key, item] of Object.entries(value)) {
    bytes += key.length * 2 + estimateValueBytes(item, seen, depth + 1);
  }
  return bytes;
}
