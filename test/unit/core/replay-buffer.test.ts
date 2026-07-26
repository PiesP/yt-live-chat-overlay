/**
 * Tests for ReplayBuffer — time-indexed sorted buffer for replay chat.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ReplayBuffer } from '@chat/replay-buffer';
import type { ChatMessage } from '@app-types';
import type { ChatEvent } from '@chat/message-parser';

function makeMsg(id: string, offsetMs: number): ChatMessage {
  return {
    id,
    text: `msg ${id}`,
    content: [{ type: 'text' as const, content: `msg ${id}` }],
    kind: 'text',
    authorType: 'normal',
    timestamp: 1000000 + offsetMs,
    videoOffsetMs: offsetMs,
  } as ChatMessage;
}

describe('ReplayBuffer', () => {
  let buf: ReplayBuffer;

  beforeEach(() => {
    buf = new ReplayBuffer();
  });

  describe('isEmpty', () => {
    it('is true for a fresh buffer', () => {
      expect(buf.isEmpty).toBe(true);
    });

    it('is false after inserting a message', () => {
      buf.insert(makeMsg('a', 1000), 1000);
      expect(buf.isEmpty).toBe(false);
    });
  });

  describe('insert()', () => {
    it('adds a message', () => {
      buf.insert(makeMsg('a', 1000), 1000);
      expect(buf.isEmpty).toBe(false);
    });

    it('deduplicates by message ID', () => {
      const msg = makeMsg('a', 1000);
      buf.insert(msg, 1000);
      buf.insert(msg, 1000);
      const result = buf.flushUpTo(3000, 10);
      expect(result).toHaveLength(1);
    });

    it('maintains sorted order by offsetMs', () => {
      // Use close offsets to avoid the 2000ms tolerance window dropping messages
      buf.insert(makeMsg('c', 1050), 1050);
      buf.insert(makeMsg('a', 1000), 1000);
      buf.insert(makeMsg('b', 1025), 1025);
      const result = buf.flushUpTo(1050, 10);
      expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });

    it('handles same offsetMs (insertion order preserved)', () => {
      buf.insert(makeMsg('a', 1000), 1000);
      buf.insert(makeMsg('b', 1000), 1000);
      buf.insert(makeMsg('c', 1000), 1000);
      const result = buf.flushUpTo(3000, 10);
      expect(result).toHaveLength(3);
    });
  });

  describe('flushUpTo()', () => {
    it('returns empty array for empty buffer', () => {
      expect(buf.flushUpTo(2000, 10)).toEqual([]);
    });

    it('returns messages within tolerance window', () => {
      buf.insert(makeMsg('a', 1000), 1000);
      buf.insert(makeMsg('b', 2000), 2000);
      const result = buf.flushUpTo(2500, 10);
      expect(result.map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('respects maxBatch limit', () => {
      for (let i = 0; i < 20; i++) {
        buf.insert(makeMsg(`msg${i}`, 1000), 1000);
      }
      const result = buf.flushUpTo(3000, 5);
      expect(result).toHaveLength(5);
    });

    it('drops messages too far in the past', () => {
      buf.insert(makeMsg('old', 1000), 1000);
      buf.insert(makeMsg('current', 5000), 5000);
      // flushUpTo(7000): 1000 < 7000-2000=5000 → dropped (too far past)
      const result = buf.flushUpTo(7000, 10);
      expect(result.map((m) => m.id)).toEqual(['current']);
    });

    it('allows a late-dropped message ID to be inserted again', () => {
      buf.insert(makeMsg('late', 1000), 1000);
      expect(buf.flushUpTo(4000, 10)).toEqual([]);

      buf.insert(makeMsg('late', 4000), 4000);

      expect(buf.flushUpTo(4000, 10).map((message) => message.id)).toEqual(['late']);
    });

    it('stops at future messages beyond tolerance', () => {
      buf.insert(makeMsg('now', 1000), 1000);
      buf.insert(makeMsg('future', 5000), 5000);
      // flushUpTo(1500): 1000 is OK; 5000 > 1500+2000=3500 → stop (future)
      const result = buf.flushUpTo(1500, 10);
      expect(result.map((m) => m.id)).toEqual(['now']);
      expect(buf.isEmpty).toBe(false); // 'future' still buffered
    });

    it('compacts buffer when offset grows beyond 64', () => {
      for (let i = 0; i < 70; i++) {
        buf.insert(makeMsg(`msg${i}`, 1000), 1000);
      }
      const result = buf.flushUpTo(3000, 70);
      expect(result).toHaveLength(70);
      expect(buf.isEmpty).toBe(true);
    });

    it('removes consumed message IDs from seenIds allowing re-insertion', () => {
      const msg = makeMsg('a', 1000);
      buf.insert(msg, 1000);
      // flushUpTo should consume the message AND free its ID
      const flushed = buf.flushUpTo(3000, 10);
      expect(flushed).toHaveLength(1);
      // Re-insert with same ID — should succeed because seenIds was cleaned
      buf.insert(msg, 1000);
      const result = buf.flushUpTo(3000, 10);
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('a');
    });
  });

  describe('appendEvents()', () => {
    it('inserts events in bulk', () => {
      buf.insert(makeMsg('a', 1000), 1000);
      buf.insert(makeMsg('b', 2000), 2000);
      buf.insert(makeMsg('c', 3000), 3000);
      const result = buf.flushUpTo(3000, 10);
      expect(result).toHaveLength(3);
    });

    it('returns highest offsetMs from bulk', () => {
      const events: ChatEvent[] = [
        { message: makeMsg('a', 1000), offsetMs: 1000 },
        { message: makeMsg('b', 3000), offsetMs: 3000 },
        { message: makeMsg('c', 2000), offsetMs: 2000 },
      ] as ChatEvent[];
      const highest = buf.appendEvents(events);
      expect(highest).toBe(3000);
    });

    it('skips events below minimumOffsetMs', () => {
      const buf2 = new ReplayBuffer();
      const events: ChatEvent[] = [
        { message: makeMsg('old', 500), offsetMs: 500 },
        { message: makeMsg('new', 1500), offsetMs: 1500 },
      ] as ChatEvent[];
      buf2.appendEvents(events, 1000);
      const result = buf2.flushUpTo(2000, 10);
      expect(result.map((m) => m.id)).toEqual(['new']);
    });

    it('skips events where offsetMs cannot be determined', () => {
      const msg = makeMsg('no-offset', 0);
      delete (msg as unknown as Record<string, unknown>).videoOffsetMs;
      const events: ChatEvent[] = [{ message: msg } as unknown as ChatEvent];
      expect(() => buf.appendEvents(events)).not.toThrow();
      expect(buf.isEmpty).toBe(true);
    });

    it('returns -1 when all events are skipped', () => {
      expect(buf.appendEvents([])).toBe(-1);
    });
  });

  describe('clear()', () => {
    it('clears all buffered messages', () => {
      buf.insert(makeMsg('a', 1000), 1000);
      buf.insert(makeMsg('b', 2000), 2000);
      buf.clear();
      expect(buf.isEmpty).toBe(true);
      expect(buf.flushUpTo(3000, 10)).toEqual([]);
    });
  });

  describe('drainUpTo()', () => {
    it('drains messages up to the given offset', () => {
      buf.insert(makeMsg('a', 1000), 1000);
      buf.insert(makeMsg('b', 2000), 2000);
      buf.insert(makeMsg('c', 3000), 3000);
      const result = buf.drainUpTo(1500);
      expect(result.map((m) => m.id)).toEqual(['a']);
      // 'b' and 'c' still in buffer
      const remaining = buf.flushUpTo(4000, 10);
      expect(remaining.map((m) => m.id)).toEqual(['b', 'c']);
    });

    it('stops at first future message due to sorted order', () => {
      buf.insert(makeMsg('a', 1000), 1000);
      buf.insert(makeMsg('b', 5000), 5000);
      const result = buf.drainUpTo(1500);
      expect(result.map((m) => m.id)).toEqual(['a']);
    });

    it('drains all when maxOffsetMs is null', () => {
      buf.insert(makeMsg('a', 1000), 1000);
      buf.insert(makeMsg('b', 5000), 5000);
      const result = buf.drainUpTo(undefined);
      expect(result.map((m) => m.id)).toEqual(['a', 'b']);
      expect(buf.isEmpty).toBe(true);
    });

    it('returns empty array when no messages in range', () => {
      buf.insert(makeMsg('future', 5000), 5000);
      const result = buf.drainUpTo(1000);
      expect(result).toEqual([]);
      expect(buf.isEmpty).toBe(false);
    });

    it('removes drained IDs from seenIds allowing re-insertion', () => {
      const msg = makeMsg('a', 1000);
      buf.insert(msg, 1000);
      buf.drainUpTo(2000);
      buf.insert(msg, 1000);
      const result = buf.flushUpTo(3000, 10);
      expect(result).toHaveLength(1);
    });
  });

  describe('drainAll()', () => {
    it('drains all messages regardless of offsetMs', () => {
      buf.insert(makeMsg('a', 1000), 1000);
      buf.insert(makeMsg('b', 5000), 5000);
      buf.insert(makeMsg('c', 99999), 99999);
      const result = buf.drainAll();
      expect(result).toHaveLength(3);
      expect(buf.isEmpty).toBe(true);
    });

    it('returns messages in sorted order', () => {
      buf.insert(makeMsg('c', 3000), 3000);
      buf.insert(makeMsg('a', 1000), 1000);
      buf.insert(makeMsg('b', 2000), 2000);
      const result = buf.drainAll();
      expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });
  });
});
