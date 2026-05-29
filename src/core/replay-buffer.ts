// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * ReplayBuffer — time-indexed sorted buffer for replay chat messages.
 *
 * Stores messages sorted by videoOffsetMs with O(log n) binary search
 * insertion and deduplication by message ID. Flush emits messages whose
 * offsetMs has passed, in batches capped per frame to prevent visual clumping.
 */

import type { ChatMessage } from '@app-types';
import type { ChatEvent } from '@core/chat-message-parser';

interface BufferedReplayMessage {
  message: ChatMessage;
  offsetMs: number;
}

const MAX_BUFFERED_REPLAY_MESSAGES = 3000;
const REPLAY_EMIT_TOLERANCE_MS = 300;

export class ReplayBuffer {
  private buffer: BufferedReplayMessage[] = [];
  private bufferOffset = 0;
  private seenIds = new Set<string>();

  /** True when the buffer has no unconsumed messages. */
  get isEmpty(): boolean {
    return this.buffer.length - this.bufferOffset <= 0;
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

    this.buffer.splice(lo, 0, { message, offsetMs });
    if (message.id) this.seenIds.add(message.id);
    this.trim(MAX_BUFFERED_REPLAY_MESSAGES);
  }

  /**
   * Bulk-insert pre-parsed chat events.
   *
   * Events whose offsetMs falls below `minimumOffsetMs` are skipped.
   * Returns the highest offsetMs seen across all inserted events.
   */
  appendEvents(events: ChatEvent[], minimumOffsetMs = 0): number {
    let highestOffsetMs = -1;

    for (const event of events) {
      const offsetMs = event.message.videoOffsetMs ?? event.offsetMs;
      if (offsetMs === undefined) continue;

      highestOffsetMs = Math.max(highestOffsetMs, offsetMs);

      if (offsetMs < minimumOffsetMs) continue;
      this.insert(event.message, offsetMs);
    }

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
    if (this.buffer.length - this.bufferOffset <= 0) return [];

    const batch: ChatMessage[] = [];

    while (this.buffer.length - this.bufferOffset > 0 && batch.length < maxBatch) {
      const next = this.buffer[this.bufferOffset];
      if (!next) break;

      // Future messages — stop, they're not ready yet
      if (next.offsetMs > currentOffsetMs + REPLAY_EMIT_TOLERANCE_MS) break;

      // Advance offset instead of shift()
      this.bufferOffset++;

      // Too far in the past — drop silently
      if (next.offsetMs < currentOffsetMs - REPLAY_EMIT_TOLERANCE_MS) {
        continue;
      }

      batch.push(next.message);
    }

    // Compact when offset grows large
    if (this.bufferOffset > 64) {
      this.buffer.splice(0, this.bufferOffset);
      this.bufferOffset = 0;
    }

    return batch;
  }

  /** Clear all buffered messages (e.g. on seek). */
  clear(): void {
    this.buffer = [];
    this.bufferOffset = 0;
    this.seenIds.clear();
  }

  /**
   * Trim the buffer to `maxSize` by removing oldest entries.
   * Oldest messages are from the past — they won't be needed again.
   */
  private trim(maxSize: number): void {
    const effectiveLength = this.buffer.length - this.bufferOffset;
    if (effectiveLength <= maxSize) return;

    const overflow = effectiveLength - maxSize;
    this.bufferOffset += overflow;
  }
}
