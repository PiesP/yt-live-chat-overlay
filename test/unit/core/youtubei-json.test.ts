import { describe, it, expect } from 'vitest';
import {
  isRecord,
  asRecord,
  getString,
  getNumber,
  getNestedRecord,
  findFirstNestedRecordByKey,
  findFirstNestedStringByKey,
} from '@chat/youtube/request';

// ── isRecord ──────────────────────────────────────────────────────────

describe('isRecord', () => {
  it('returns true for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('returns true for objects with nested values', () => {
    expect(isRecord({ a: { b: { c: 1 } } })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isRecord(undefined)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isRecord(42)).toBe(false);
    expect(isRecord('string')).toBe(false);
    expect(isRecord(true)).toBe(false);
  });

  it('returns false for arrays (arrays are excluded)', () => {
    // isRecord explicitly excludes arrays — only plain objects are records
    expect(isRecord([1, 2, 3])).toBe(false);
  });
});

// ── asRecord ──────────────────────────────────────────────────────────

describe('asRecord', () => {
  it('returns the object for valid records', () => {
    const obj = { a: 1 };
    expect(asRecord(obj)).toBe(obj);
  });

  it('returns null for null', () => {
    expect(asRecord(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(asRecord(undefined)).toBeNull();
  });

  it('returns null for arrays (arrays are not records)', () => {
    const arr = [1, 2];
    expect(asRecord(arr)).toBeNull();
  });

  it('returns null for primitives', () => {
    expect(asRecord('hello')).toBeNull();
    expect(asRecord(42)).toBeNull();
  });
});

// ── getString ─────────────────────────────────────────────────────────

describe('getString', () => {
  it('returns the string for non-empty strings', () => {
    expect(getString('hello')).toBe('hello');
    expect(getString('a')).toBe('a');
  });

  it('returns undefined for empty string', () => {
    expect(getString('')).toBeUndefined();
  });

  it('returns undefined for non-string values', () => {
    expect(getString(42)).toBeUndefined();
    expect(getString(null)).toBeUndefined();
    expect(getString(undefined)).toBeUndefined();
    expect(getString(true)).toBeUndefined();
    expect(getString({})).toBeUndefined();
  });
});

// ── getNumber ─────────────────────────────────────────────────────────

describe('getNumber', () => {
  it('returns the number for finite numbers', () => {
    expect(getNumber(42)).toBe(42);
    expect(getNumber(0)).toBe(0);
    expect(getNumber(-1)).toBe(-1);
    expect(getNumber(3.14)).toBe(3.14);
  });

  it('returns the number for numeric strings', () => {
    expect(getNumber('42')).toBe(42);
    expect(getNumber('0')).toBe(0);
    expect(getNumber('-1')).toBe(-1);
    expect(getNumber('3.14')).toBeCloseTo(3.14);
  });

  it('returns undefined for non-finite numbers', () => {
    expect(getNumber(Infinity)).toBeUndefined();
    expect(getNumber(-Infinity)).toBeUndefined();
    expect(getNumber(NaN)).toBeUndefined();
  });

  it('returns undefined for non-numeric values', () => {
    expect(getNumber('hello')).toBeUndefined();
    expect(getNumber(null)).toBeUndefined();
    expect(getNumber(undefined)).toBeUndefined();
    expect(getNumber(true)).toBeUndefined();
    expect(getNumber({})).toBeUndefined();
  });

  it('returns 0 for empty string (Number("") === 0)', () => {
    expect(getNumber('')).toBe(0);
  });
});

// ── getNestedRecord ───────────────────────────────────────────────────

describe('getNestedRecord', () => {
  const data = {
    a: {
      b: {
        c: { value: 42 },
      },
    },
  };

  it('traverses a valid path and returns the nested record', () => {
    expect(getNestedRecord(data, ['a', 'b', 'c'])).toEqual({ value: 42 });
  });

  it('returns null when a key in the path is missing', () => {
    expect(getNestedRecord(data, ['a', 'x', 'c'])).toBeNull();
  });

  it('returns null when a non-object is encountered mid-path', () => {
    expect(getNestedRecord({ a: { b: 'string' } }, ['a', 'b', 'c'])).toBeNull();
  });

  it('returns null for empty path on non-object root', () => {
    expect(getNestedRecord('not-object', ['a'])).toBeNull();
  });

  it('returns the root for empty path', () => {
    expect(getNestedRecord(data, [])).toEqual(data);
  });

  it('returns null when root is null', () => {
    expect(getNestedRecord(null, ['a'])).toBeNull();
  });

  it('returns null when root is undefined', () => {
    expect(getNestedRecord(undefined, ['a'])).toBeNull();
  });

  it('returns null when leaf is an array (arrays are not records)', () => {
    expect(getNestedRecord({ a: [1, 2, 3] }, ['a'])).toBeNull();
  });
});

// ── findFirstNestedRecordByKey ────────────────────────────────────────

describe('findFirstNestedRecordByKey', () => {
  it('finds a record by key at the top level', () => {
    const data = { target: { value: 1 }, other: { value: 2 } };
    const result = findFirstNestedRecordByKey(data, 'target');
    expect(result).toEqual({ value: 1 });
  });

  it('finds a record by key in a nested structure', () => {
    const data = { a: { b: { target: { found: true } } } };
    const result = findFirstNestedRecordByKey(data, 'target');
    expect(result).toEqual({ found: true });
  });

  it('returns null when key is not found', () => {
    const data = { a: { b: { c: 1 } } };
    expect(findFirstNestedRecordByKey(data, 'missing')).toBeNull();
  });

  it('returns null when key exists but value is not a record', () => {
    const data = { target: 'string-value' };
    expect(findFirstNestedRecordByKey(data, 'target')).toBeNull();
  });

  it('respects the predicate filter', () => {
    const data = { a: { target: { type: 'wrong' } }, b: { target: { type: 'right' } } };
    const result = findFirstNestedRecordByKey(data, 'target', (v) => v.type === 'right');
    expect(result).toEqual({ type: 'right' });
  });

  it('returns null when no record matches the predicate', () => {
    const data = { target: { type: 'wrong' } };
    expect(findFirstNestedRecordByKey(data, 'target', (v) => v.type === 'right')).toBeNull();
  });

  it('handles arrays in the structure', () => {
    const data = { items: [{ nested: { target: { found: true } } }] };
    const result = findFirstNestedRecordByKey(data, 'target');
    expect(result).toEqual({ found: true });
  });

  it('respects MAX_PROCESSED limit (3000 nodes)', () => {
    // Build a wide tree that exceeds 3000 nodes
    const data: Record<string, unknown> = {};
    let current: Record<string, unknown> = data;
    for (let i = 0; i < 3100; i++) {
      current.child = { [`key_${i}`]: i };
      current = current.child as Record<string, unknown>;
    }
    // target is at the very end — should not be found due to limit
    current.target = { found: true };
    expect(findFirstNestedRecordByKey(data, 'target')).toBeNull();
  });
});

// ── findFirstNestedStringByKey ────────────────────────────────────────

describe('findFirstNestedStringByKey', () => {
  it('finds a string value by key', () => {
    const data = { a: { target: 'found-it' } };
    expect(findFirstNestedStringByKey(data, 'target')).toBe('found-it');
  });

  it('returns undefined when key is not found', () => {
    const data = { a: { b: 'value' } };
    expect(findFirstNestedStringByKey(data, 'missing')).toBeUndefined();
  });

  it('returns undefined when value is an empty string', () => {
    const data = { target: '' };
    expect(findFirstNestedStringByKey(data, 'target')).toBeUndefined();
  });

  it('returns undefined when value is not a string', () => {
    const data = { target: 42 };
    expect(findFirstNestedStringByKey(data, 'target')).toBeUndefined();
  });
});
