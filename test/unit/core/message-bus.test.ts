import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BatchMessageBus } from '@util/message-bus';

describe('BatchMessageBus', () => {
  let bus: BatchMessageBus<string>;

  beforeEach(() => {
    bus = new BatchMessageBus<string>();
  });

  // ── publish / subscribe ────────────────────────────────────────────────

  describe('publish / subscribe', () => {
    it('delivers messages to subscribers', () => {
      const handler = vi.fn();
      bus.subscribe(handler);

      bus.publish(['msg1', 'msg2']);
      expect(handler).toHaveBeenCalledWith(['msg1', 'msg2']);
    });

    it('does not deliver to unsubscribed handlers', () => {
      const handler = vi.fn();
      const unsubscribe = bus.subscribe(handler);
      unsubscribe();

      bus.publish(['msg']);
      expect(handler).not.toHaveBeenCalled();
    });

    it('supports multiple subscribers', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.subscribe(h1);
      bus.subscribe(h2);

      bus.publish(['data']);
      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
    });
  });

  // ── Empty publish ───────────────────────────────────────────────────────

  describe('empty publish', () => {
    it('does not call subscribers with empty array', () => {
      const handler = vi.fn();
      bus.subscribe(handler);

      bus.publish([]);
      expect(handler).not.toHaveBeenCalled();
    });

    it('does nothing when no subscribers', () => {
      expect(() => bus.publish(['data'])).not.toThrow();
    });
  });

  // ── subscriberCount ─────────────────────────────────────────────────────

  describe('subscriberCount', () => {
    it('starts at 0', () => {
      expect(bus.subscriberCount).toBe(0);
    });

    it('increments with each subscription', () => {
      bus.subscribe(() => {});
      expect(bus.subscriberCount).toBe(1);

      bus.subscribe(() => {});
      expect(bus.subscriberCount).toBe(2);
    });

    it('decrements on unsubscribe', () => {
      const unsub = bus.subscribe(() => {});
      expect(bus.subscriberCount).toBe(1);

      unsub();
      expect(bus.subscriberCount).toBe(0);
    });
  });

  // ── publishedCount ──────────────────────────────────────────────────────

  describe('publishedCount', () => {
    it('starts at 0', () => {
      expect(bus.publishedCount).toBe(0);
    });

    it('counts total published messages with subscriber active', () => {
      bus.subscribe(() => {});
      bus.publish(['a', 'b']);
      expect(bus.publishedCount).toBe(2);

      bus.publish(['c']);
      expect(bus.publishedCount).toBe(3);
    });

    it('does not increment when no subscribers', () => {
      bus.publish(['a', 'b']);
      expect(bus.publishedCount).toBe(0);
    });
  });

  // ── lastPublishTime ─────────────────────────────────────────────────────

  describe('lastPublishTime', () => {
    it('starts at 0', () => {
      expect(bus.lastPublishTime).toBe(0);
    });

    it('updates after publish with subscriber', () => {
      bus.subscribe(() => {});
      vi.spyOn(performance, 'now').mockReturnValue(5000);
      bus.publish(['msg']);
      expect(bus.lastPublishTime).toBe(5000);
      vi.restoreAllMocks();
    });
  });

  // ── destroy ─────────────────────────────────────────────────────────────

  describe('destroy', () => {
    it('clears all subscribers and resets counters', () => {
      bus.subscribe(() => {});
      bus.publish(['a', 'b']);

      bus.destroy();
      expect(bus.subscriberCount).toBe(0);
      expect(bus.publishedCount).toBe(0);
      expect(bus.lastPublishTime).toBe(0);
    });

    it('stops delivering messages after destroy', () => {
      const handler = vi.fn();
      bus.subscribe(handler);
      bus.destroy();

      bus.publish(['msg']);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ── Ordering ────────────────────────────────────────────────────────────

  describe('ordering', () => {
    it('calls subscribers in registration order', () => {
      const order: number[] = [];
      bus.subscribe(() => order.push(1));
      bus.subscribe(() => order.push(2));

      bus.publish(['msg']);
      expect(order).toEqual([1, 2]);
    });
  });
});
