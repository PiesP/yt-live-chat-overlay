import { describe, it, expect, beforeEach } from 'vitest';
import { ResizableByteLimitedCache } from '@util/byte-limited-cache';

// ── Helpers ───────────────────────────────────────────────────────────────

function estimateSize(v: string): number {
  return v.length;
}

// ── ResizableByteLimitedCache ─────────────────────────────────────────────

describe('ResizableByteLimitedCache', () => {
  let cache: ResizableByteLimitedCache<string>;

  beforeEach(() => {
    cache = new ResizableByteLimitedCache<string>(100, estimateSize);
  });

  // ── set / get ──────────────────────────────────────────────────────────

  describe('set / get', () => {
    it('stores and retrieves values', () => {
      cache.set('key1', 'hello');
      expect(cache.get('key1')).toBe('hello');
    });

    it('returns undefined for missing keys', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('overwrites existing keys', () => {
      cache.set('key1', 'hello');
      cache.set('key1', 'world');
      expect(cache.get('key1')).toBe('world');
    });

    it('evicts the previous value when replacing an entry', () => {
      const evicted: string[] = [];
      const c = new ResizableByteLimitedCache<string>(100, estimateSize, (value) =>
        evicted.push(value)
      );
      c.set('key1', 'hello');
      c.set('key1', 'world');
      expect(evicted).toEqual(['hello']);
    });
  });

  // ── has ─────────────────────────────────────────────────────────────────

  describe('has', () => {
    it('returns true for existing keys', () => {
      cache.set('key1', 'hello');
      expect(cache.has('key1')).toBe(true);
    });

    it('returns false for missing keys', () => {
      expect(cache.has('nonexistent')).toBe(false);
    });
  });

  // ── size ────────────────────────────────────────────────────────────────

  describe('size', () => {
    it('starts at 0', () => {
      expect(cache.size).toBe(0);
    });

    it('tracks number of entries', () => {
      cache.set('a', '1');
      cache.set('b', '22');
      expect(cache.size).toBe(2);
    });
  });

  // ── maxBytes ────────────────────────────────────────────────────────────

  describe('maxBytes', () => {
    it('returns the configured limit', () => {
      expect(cache.maxBytes).toBe(100);
    });
  });

  // ── Byte limit enforcement ──────────────────────────────────────────────

  describe('byte limit enforcement', () => {
    it('evicts oldest entries when total exceeds maxBytes', () => {
      cache.set('a', 'x'.repeat(40)); // 40 bytes
      cache.set('b', 'y'.repeat(40)); // 40 bytes, total 80
      cache.set('c', 'z'.repeat(40)); // 40 bytes, total 120 > 100 → evict 'a'
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(true);
      expect(cache.has('c')).toBe(true);
    });

    it('does not cache single items that exceed maxBytes', () => {
      const evicted: string[] = [];
      const c = new ResizableByteLimitedCache<string>(100, estimateSize, (value) =>
        evicted.push(value)
      );
      expect(c.set('large', 'x'.repeat(200))).toBe(false); // 200 bytes > 100
      expect(c.has('large')).toBe(false);
      expect(evicted).toEqual(['x'.repeat(200)]);
    });

    it('bounds tiny entries independently of their byte size', () => {
      const c = new ResizableByteLimitedCache<string>(100, estimateSize, undefined, 2);
      c.set('a', '1');
      c.set('b', '2');
      c.set('c', '3');

      expect(c.size).toBe(2);
      expect(c.has('a')).toBe(false);
    });
  });

  // ── LRU behavior ───────────────────────────────────────────────────────

  describe('LRU behavior (get moves key to end)', () => {
    it('accessing a key makes it the most recently used', () => {
      cache.set('a', 'x'.repeat(40));
      cache.set('b', 'y'.repeat(40));
      cache.set('c', 'z'.repeat(40)); // evicts 'a'
      cache.set('d', 'w'.repeat(40)); // would evict 'b' (oldest after 'c' was added)

      // After this sequence: 'c' and 'd' should survive
      expect(cache.has('a')).toBe(false); // evicted first
    });

    it('get() moves accessed key to MRU position', () => {
      cache.set('a', 'x'.repeat(40));
      cache.set('b', 'y'.repeat(40));

      // Access 'a' to make it MRU
      cache.get('a');

      // Now 'b' is the oldest and should be evicted first
      cache.set('c', 'z'.repeat(40)); // total: a(40)+b(40)+c(40)=120 > 100
      expect(cache.has('b')).toBe(false); // 'b' was evicted
      expect(cache.has('a')).toBe(true); // 'a' was accessed recently
    });
  });

  // ── delete ──────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('removes a key and returns true', () => {
      cache.set('key1', 'hello');
      expect(cache.delete('key1')).toBe(true);
      expect(cache.has('key1')).toBe(false);
    });

    it('returns false for missing key', () => {
      expect(cache.delete('nonexistent')).toBe(false);
    });

    it('reduces total byte count', () => {
      cache.set('a', 'x'.repeat(40));
      cache.set('b', 'y'.repeat(40));
      cache.delete('a');
      // Now only 'b' is stored, space for more
      cache.set('c', 'z'.repeat(70)); // 70 < 100, should fit
      expect(cache.has('c')).toBe(true);
    });
  });

  describe('take', () => {
    it('transfers ownership without invoking eviction cleanup', () => {
      const evicted: string[] = [];
      const c = new ResizableByteLimitedCache<string>(100, estimateSize, (value) =>
        evicted.push(value)
      );
      c.set('key', 'value');

      expect(c.take('key')).toBe('value');
      expect(c.has('key')).toBe(false);
      expect(evicted).toEqual([]);
    });
  });

  // ── clear ───────────────────────────────────────────────────────────────

  describe('clear', () => {
    it('removes all entries and resets size to 0', () => {
      cache.set('a', '1');
      cache.set('b', '2');
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(false);
    });
  });

  // ── resize ──────────────────────────────────────────────────────────────

  describe('resize', () => {
    it('changes the max byte limit', () => {
      cache.set('a', 'x'.repeat(40));
      cache.set('b', 'y'.repeat(40));
      expect(cache.size).toBe(2);

      cache.resize(50); // only 50 bytes → at most one 40-byte entry fits
      expect(cache.size).toBe(1);
    });

    it('does not evict when new limit is larger', () => {
      cache.set('a', 'x'.repeat(40));
      cache.set('b', 'y'.repeat(40));
      cache.resize(200);
      expect(cache.size).toBe(2);
    });
  });

  // ── touch ───────────────────────────────────────────────────────────────

  describe('touch', () => {
    it('does not throw for existing key', () => {
      cache.set('key1', 'hello');
      expect(() => cache.touch('key1')).not.toThrow();
    });

    it('does not throw for missing key', () => {
      expect(() => cache.touch('nonexistent')).not.toThrow();
    });
  });

  // ── eviction callback ───────────────────────────────────────────────────

  describe('eviction callback', () => {
    it('accounts bytes before an eviction callback mutates the value', () => {
      const first = { bytes: 60 };
      const second = { bytes: 60 };
      const third = { bytes: 40 };
      const c = new ResizableByteLimitedCache<{ bytes: number }>(
        100,
        (value) => value.bytes,
        (value) => {
          value.bytes = 0;
        }
      );

      c.set('first', first);
      c.set('second', second);
      c.set('third', third);

      expect(c.has('second')).toBe(true);
      expect(c.has('third')).toBe(true);
    });

    it('calls onEvict when entries are evicted', () => {
      const evicted: string[] = [];
      const cb = (v: string) => evicted.push(v);
      const c = new ResizableByteLimitedCache<string>(30, estimateSize, cb);

      c.set('a', 'x'.repeat(12)); // 12 bytes
      c.set('b', 'y'.repeat(12)); // 12 bytes, total 24
      c.set('c', 'z'.repeat(12)); // 12 bytes, total 36 > 30 → evict 'a'
      expect(evicted).toContain('x'.repeat(12));
    });

    it('calls onEvict on manual delete', () => {
      const evicted: string[] = [];
      const cb = (v: string) => evicted.push(v);
      const c = new ResizableByteLimitedCache<string>(100, estimateSize, cb);

      c.set('a', 'AAA');
      c.delete('a');

      expect(evicted).toContain('AAA');
    });

    it('calls onEvict on clear', () => {
      const evicted: string[] = [];
      const cb = (v: string) => evicted.push(v);
      const c = new ResizableByteLimitedCache<string>(100, estimateSize, cb);

      c.set('a', 'AAA');
      c.set('b', 'BBB');
      c.clear();

      expect(evicted).toContain('AAA');
      expect(evicted).toContain('BBB');
    });
  });
});
