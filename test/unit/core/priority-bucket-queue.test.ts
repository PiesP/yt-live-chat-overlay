import { describe, it, expect, beforeEach } from 'vitest';
import { HighFirstPriorityBucketQueue } from '@util/priority-bucket-queue';

// ── HighFirstPriorityBucketQueue ─────────────────────────────────

describe('HighFirstPriorityBucketQueue', () => {
  let queue: HighFirstPriorityBucketQueue<string>;

  beforeEach(() => {
    queue = new HighFirstPriorityBucketQueue<string>();
  });

  describe('basic operations', () => {
    it('starts empty', () => {
      expect(queue.size).toBe(0);
      expect(queue.isEmpty).toBe(true);
      expect(queue.dequeue()).toBeUndefined();
      expect(queue.peek()).toBeUndefined();
      expect(queue.peekLowest()).toBeUndefined();
    });

    it('enqueue and dequeue a single item', () => {
      queue.enqueue('hello', 100);
      expect(queue.size).toBe(1);
      expect(queue.isEmpty).toBe(false);
      expect(queue.dequeue()).toBe('hello');
      expect(queue.size).toBe(0);
      expect(queue.isEmpty).toBe(true);
    });

    it('dequeues higher-priority items first', () => {
      queue.enqueue('low', 0);
      queue.enqueue('high', 200);
      queue.enqueue('mid', 100);

      expect(queue.dequeue()).toBe('high');
      expect(queue.dequeue()).toBe('mid');
      expect(queue.dequeue()).toBe('low');
      expect(queue.dequeue()).toBeUndefined();
    });

    it('maintains FIFO order within the same priority', () => {
      queue.enqueue('first', 100);
      queue.enqueue('second', 100);
      queue.enqueue('third', 100);

      expect(queue.dequeue()).toBe('first');
      expect(queue.dequeue()).toBe('second');
      expect(queue.dequeue()).toBe('third');
    });

    it('supports negative priority values', () => {
      queue.enqueue('negative', -50);
      queue.enqueue('normal', 0);
      expect(queue.dequeue()).toBe('normal');
      expect(queue.dequeue()).toBe('negative');
    });
  });

  describe('peek', () => {
    it('peek returns highest-priority item without removing', () => {
      queue.enqueue('a', 50);
      queue.enqueue('b', 200);
      expect(queue.peek()).toBe('b');
      expect(queue.size).toBe(2);
    });

    it('peek returns undefined when queue is empty', () => {
      expect(queue.peek()).toBeUndefined();
    });
  });

  describe('peekLowest', () => {
    it('peekLowest returns lowest-priority item', () => {
      queue.enqueue('high', 200);
      queue.enqueue('mid', 100);
      queue.enqueue('low', 0);
      expect(queue.peekLowest()).toBe('low');
    });

    it('peekLowest returns newest item at lowest priority', () => {
      queue.enqueue('first', 0);
      queue.enqueue('second', 0);
      expect(queue.peekLowest()).toBe('second');
    });

    it('peekLowest returns undefined when queue is empty', () => {
      expect(queue.peekLowest()).toBeUndefined();
    });
  });

  describe('dropLowest', () => {
    it('removes the lowest-priority item (FIFO)', () => {
      queue.enqueue('keep-high', 200);
      queue.enqueue('low-first', 0);
      queue.enqueue('keep-mid', 100);
      queue.enqueue('low-second', 0);

      expect(queue.dropLowest()).toBe('low-first');
      // Should have removed 'low-first' (oldest at lowest priority)
      expect(queue.size).toBe(3);
      const items: string[] = [];
      while (!queue.isEmpty) items.push(queue.dequeue()!);
      expect(items).toEqual(['keep-high', 'keep-mid', 'low-second']);
    });

    it('does nothing when queue is empty', () => {
      expect(queue.dropLowest()).toBeUndefined();
      expect(queue.size).toBe(0);
    });
  });

  describe('removeAll', () => {
    it('removes specified messages', () => {
      queue.enqueue('a', 100);
      queue.enqueue('b', 200);
      queue.enqueue('c', 100);
      queue.enqueue('d', 0);

      const removed = queue.removeAll(['a', 'c']);
      expect(removed).toBe(2);
      expect(queue.size).toBe(2);
      expect(queue.dequeue()).toBe('b');
      expect(queue.dequeue()).toBe('d');
    });

    it('returns 0 when no messages match', () => {
      queue.enqueue('a', 100);
      expect(queue.removeAll(['x', 'y'])).toBe(0);
      expect(queue.size).toBe(1);
    });

    it('handles empty input', () => {
      queue.enqueue('a', 100);
      expect(queue.removeAll([])).toBe(0);
      expect(queue.size).toBe(1);
    });
  });

  describe('clear', () => {
    it('empties the queue and resets state', () => {
      queue.enqueue('a', 100);
      queue.enqueue('b', 200);
      queue.clear();
      expect(queue.size).toBe(0);
      expect(queue.isEmpty).toBe(true);
      expect(queue.dequeue()).toBeUndefined();
    });
  });

  describe('toArray', () => {
    it('returns all items in priority order without modifying queue', () => {
      queue.enqueue('low', 0);
      queue.enqueue('mid', 100);
      queue.enqueue('high', 200);

      const arr = queue.toArray();
      expect(arr).toEqual(['high', 'mid', 'low']);
      // Queue is unchanged
      expect(queue.size).toBe(3);
    });

    it('returns empty array for empty queue', () => {
      expect(queue.toArray()).toEqual([]);
    });
  });

  describe('trim', () => {
    it('removes lowest-priority items when over maxSize', () => {
      queue.enqueue('high', 200);
      queue.enqueue('mid', 100);
      queue.enqueue('low1', 0);
      queue.enqueue('low2', 0);

      queue.trim(3);
      expect(queue.size).toBe(3);
      const items: string[] = [];
      while (!queue.isEmpty) items.push(queue.dequeue()!);
      expect(items).toEqual(['high', 'mid', 'low1']);
    });

    it('does nothing when within maxSize', () => {
      queue.enqueue('a', 100);
      queue.enqueue('b', 0);
      queue.trim(10);
      expect(queue.size).toBe(2);
    });

    it('handles trimming all low-priority buckets', () => {
      for (let i = 0; i < 10; i++) {
        queue.enqueue(`item-${i}`, 0);
      }
      queue.enqueue('high', 200);

      queue.trim(1);
      expect(queue.size).toBe(1);
      expect(queue.dequeue()).toBe('high');
    });
  });
});
