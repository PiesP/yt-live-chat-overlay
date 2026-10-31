// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage } from '@app-types';
import { computeAgeFadeRate, computeInvFadeDuration, enqueueWithOverflow } from '@renderer/shared';
import { HighFirstPriorityBucketQueue } from '@util/priority-bucket-queue';
import { describe, expect, it, vi } from 'vite-plus/test';

// ═══════════════════════════════════════════════════════════════════════════
// computeAgeFadeRate
// ═══════════════════════════════════════════════════════════════════════════

describe('computeAgeFadeRate', () => {
  it('returns inverse of maxMessageAgeMs', () => {
    expect(computeAgeFadeRate(10000)).toBe(1 / 10000);
    expect(computeAgeFadeRate(5000)).toBe(1 / 5000);
  });

  it('returns 1 for maxMessageAgeMs=1', () => {
    expect(computeAgeFadeRate(1)).toBe(1);
  });

  it('clamps to maximum 1 for maxMessageAgeMs=0 (prevents division by zero)', () => {
    expect(computeAgeFadeRate(0)).toBe(1);
  });

  it('handles negative values (clamped to max 1 denominator)', () => {
    expect(computeAgeFadeRate(-100)).toBe(1);
  });

  it('handles very large values (produces very small rate)', () => {
    const result = computeAgeFadeRate(1_000_000);
    expect(result).toBe(1 / 1_000_000);
    expect(result).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// computeInvFadeDuration
// ═══════════════════════════════════════════════════════════════════════════

describe('computeInvFadeDuration', () => {
  it('returns inverse of fadeDurationMs', () => {
    expect(computeInvFadeDuration(300)).toBe(1 / 300);
    expect(computeInvFadeDuration(500)).toBe(1 / 500);
  });

  it('returns 0 when fadeDurationMs is 0 (fade disabled)', () => {
    expect(computeInvFadeDuration(0)).toBe(0);
  });

  it('returns 0 for negative values (treated as disabled)', () => {
    expect(computeInvFadeDuration(-1)).toBe(0);
  });

  it('returns 1 for fadeDurationMs=1', () => {
    expect(computeInvFadeDuration(1)).toBe(1);
  });

  it('handles sub-1 values (clamped to 1 denominator)', () => {
    // For 0 < x < 1: fadeDurationMs > 0 is true, Math.max(1, x) = 1 → result = 1/x
    // 0.5: 1/1 = 1
    expect(computeInvFadeDuration(0.5)).toBe(1);
    expect(computeInvFadeDuration(0.0001)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// enqueueWithOverflow
// ═══════════════════════════════════════════════════════════════════════════

function makeMessage(
  kind: ChatMessage['kind'] = 'text',
  overrides: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    content: [{ type: 'text', content: 'test msg' }],
    timestamp: 1234567890,
    text: 'test msg',
    kind,
    authorType: 'normal',
    ...overrides,
  };
}

describe('enqueueWithOverflow', () => {
  describe('when queue is not full', () => {
    it('enqueues the message and returns "enqueued"', () => {
      const queue = new HighFirstPriorityBucketQueue<ChatMessage>();
      const msg = makeMessage();
      const onDrop = vi.fn();

      const result = enqueueWithOverflow(queue, msg, 100, onDrop, 10);
      expect(result).toBe('enqueued');
      expect(queue.size).toBe(1);
      expect(onDrop).not.toHaveBeenCalled();
    });
  });

  describe('when queue is at capacity', () => {
    it('replaces when new message has higher priority', () => {
      const queue = new HighFirstPriorityBucketQueue<ChatMessage>();
      const onDrop = vi.fn();

      // Fill queue with low-priority text messages
      for (let i = 0; i < 10; i++) {
        queue.enqueue(makeMessage('text'), 10);
      }

      // Superchat has higher priority than text
      const msg = makeMessage('superchat');
      const result = enqueueWithOverflow(queue, msg, 100, onDrop, 10);

      expect(result).toBe('replaced');
      expect(onDrop).toHaveBeenCalledWith('queue_replaced', expect.any(Object));
    });

    it('drops when new message has equal or lower priority', () => {
      const queue = new HighFirstPriorityBucketQueue<ChatMessage>();
      const onDrop = vi.fn();

      // Fill queue with high-priority superchat messages
      for (let i = 0; i < 10; i++) {
        queue.enqueue(makeMessage('superchat'), 100);
      }

      // Text has lower priority than superchat
      const msg = makeMessage('text');
      const result = enqueueWithOverflow(queue, msg, 10, onDrop, 10);

      expect(result).toBe('dropped');
      expect(onDrop).toHaveBeenCalledWith('queue_priority', msg);
    });
  });

  describe('with different max sizes', () => {
    it('fills up to small max before overflow', () => {
      const queue = new HighFirstPriorityBucketQueue<ChatMessage>();
      const onDrop = vi.fn();

      // maxSize=3: first 3 enqueue, 4th should overflow
      for (let i = 0; i < 3; i++) {
        const result = enqueueWithOverflow(queue, makeMessage('text'), 100 - i, onDrop, 3);
        expect(result).toBe('enqueued');
      }
      expect(queue.size).toBe(3);

      // 4th message — queue already full → replace (higher priority due to 98 > 2)
      const result = enqueueWithOverflow(queue, makeMessage('text'), 98, onDrop, 3);
      expect(result).toBe('replaced');
    });
  });

  describe('edge cases', () => {
    it('protects the sole admitted ordinary message at maxSize=1', () => {
      const queue = new HighFirstPriorityBucketQueue<ChatMessage>();
      const onDrop = vi.fn();

      const ordinary = makeMessage('text');
      const r1 = enqueueWithOverflow(queue, ordinary, 0, onDrop, 1);
      expect(r1).toBe('enqueued');
      expect(queue.size).toBe(1);

      const paid = makeMessage('superchat');
      const r2 = enqueueWithOverflow(queue, paid, 200, onDrop, 1);
      expect(r2).toBe('dropped');
      expect(queue.toArray()).toEqual([ordinary]);
      expect(onDrop).toHaveBeenCalledWith('queue_priority', paid);
    });

    it('does not enqueue into a zero-capacity queue', () => {
      const queue = new HighFirstPriorityBucketQueue<ChatMessage>();
      const onDrop = vi.fn();

      const message = makeMessage('text');
      const result = enqueueWithOverflow(queue, message, 0, onDrop, 0);
      expect(result).toBe('dropped');
      expect(queue.size).toBe(0);
      expect(onDrop).toHaveBeenCalledWith('queue_priority', message);
    });
  });
});
