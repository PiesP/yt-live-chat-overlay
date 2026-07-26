import { describe, it, expect } from 'vitest';
import { MapCompatibleLruMap } from '../../../src/util/lru-map';

describe('MapCompatibleLruMap', () => {
  it('preserves the native Map contract required by renderer helpers', () => {
    expect(new MapCompatibleLruMap(1)).toBeInstanceOf(Map);
  });

  it('evicts least-recently-used when exceeding maxSize', () => {
    const map = new MapCompatibleLruMap<string, number>(3);
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);
    map.set('d', 4); // evicts 'a'
    expect(map.has('a')).toBe(false);
    expect(map.has('b')).toBe(true);
    expect(map.has('c')).toBe(true);
    expect(map.has('d')).toBe(true);
  });

  it('get promotes to most-recently-used', () => {
    const map = new MapCompatibleLruMap<string, number>(3);
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);
    map.get('a'); // promotes 'a'
    map.set('d', 4); // evicts 'b' (least recent)
    expect(map.has('a')).toBe(true);
    expect(map.has('b')).toBe(false);
    expect(map.has('c')).toBe(true);
    expect(map.has('d')).toBe(true);
  });

  it('set on existing key updates value and promotes', () => {
    const map = new MapCompatibleLruMap<string, number>(3);
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);
    map.set('a', 10); // update 'a'
    map.set('d', 4); // should evict 'b', not 'a'
    expect(map.get('a')).toBe(10);
    expect(map.has('b')).toBe(false);
  });

  it('never exceeds maxSize', () => {
    const map = new MapCompatibleLruMap<string, number>(2);
    for (let i = 0; i < 100; i++) {
      map.set(`key-${i}`, i);
    }
    expect(map.size).toBeLessThanOrEqual(2);
  });
});
