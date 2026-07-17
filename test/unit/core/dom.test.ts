// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  forEachSlot,
  isAbortError,
  findElementMatch,
  isVisibleElement,
} from '@util/dom';

// ── forEachSlot ────────────────────────────────────────────────────

describe('forEachSlot', () => {
  it('iterates slotCount times calling fn with (slotIndex, slotOffset)', () => {
    const calls: Array<[number, number]> = [];
    forEachSlot(3, 4, (slotIndex, slotOffset) => {
      calls.push([slotIndex, slotOffset]);
    });
    expect(calls).toEqual([
      [3, 0],
      [4, 1],
      [5, 2],
      [6, 3],
    ]);
  });

  it('handles slotCount = 0 (no iterations)', () => {
    const fn = vi.fn();
    forEachSlot(0, 0, fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('handles slotCount = 1', () => {
    const calls: Array<[number, number]> = [];
    forEachSlot(5, 1, (slotIndex, slotOffset) => {
      calls.push([slotIndex, slotOffset]);
    });
    expect(calls).toEqual([[5, 0]]);
  });

  it('handles negative laneIndex', () => {
    const calls: Array<[number, number]> = [];
    forEachSlot(-2, 3, (slotIndex, slotOffset) => {
      calls.push([slotIndex, slotOffset]);
    });
    expect(calls).toEqual([
      [-2, 0],
      [-1, 1],
      [0, 2],
    ]);
  });

  it('handles large slotCount', () => {
    let count = 0;
    forEachSlot(0, 100, () => {
      count++;
    });
    expect(count).toBe(100);
  });
});

// ── isAbortError ───────────────────────────────────────────────────

describe('isAbortError', () => {
  it('returns true for DOMException with name "AbortError"', () => {
    const err = new DOMException('The operation was aborted.', 'AbortError');
    expect(isAbortError(err)).toBe(true);
  });

  it('returns false for DOMException without AbortError name', () => {
    const err = new DOMException('Aborted', 'SomeOtherError');
    expect(isAbortError(err)).toBe(false);
  });

  it('returns false for other DOMException types', () => {
    const err = new DOMException('Not found', 'NotFoundError');
    expect(isAbortError(err)).toBe(false);
  });

  it('returns false for regular Error', () => {
    expect(isAbortError(new Error('something happened'))).toBe(false);
  });

  it('returns false for TypeError', () => {
    expect(isAbortError(new TypeError('network error'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isAbortError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isAbortError(undefined)).toBe(false);
  });

  it('returns false for plain objects', () => {
    expect(isAbortError({ name: 'AbortError' })).toBe(false);
  });

  it('returns false for strings', () => {
    expect(isAbortError('AbortError')).toBe(false);
  });
});

// ── findElementMatch ───────────────────────────────────────────────

describe('findElementMatch', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns the first matching element and selector', () => {
    document.body.innerHTML = '<div class="foo">hello</div>';
    const result = findElementMatch(['.foo', '.bar']);
    expect(result).not.toBeNull();
    expect(result!.element.className).toBe('foo');
    expect(result!.selector).toBe('.foo');
  });

  it('returns second selector match when first has no match', () => {
    document.body.innerHTML = '<div class="bar">world</div>';
    const result = findElementMatch(['.foo', '.bar']);
    expect(result).not.toBeNull();
    expect(result!.selector).toBe('.bar');
    expect(result!.element.className).toBe('bar');
  });

  it('returns null when no selector matches', () => {
    document.body.innerHTML = '<div class="baz">test</div>';
    const result = findElementMatch(['.foo', '.bar']);
    expect(result).toBeNull();
  });

  it('respects predicate option', () => {
    // querySelector returns the first match. The predicate filters that result.
    document.body.innerHTML =
      '<div class="item" data-active="true">A</div><div class="item" data-active="false">B</div>';
    const result = findElementMatch(['.item'], {
      predicate: (el) => el.getAttribute('data-active') === 'true',
    });
    expect(result).not.toBeNull();
    expect(result!.element.getAttribute('data-active')).toBe('true');
    expect(result!.selector).toBe('.item');
  });

  it('returns null when predicate rejects first querySelector match', () => {
    // findElementMatch uses querySelector (first match), not querySelectorAll.
    // If predicate rejects the first match, it moves to the next selector.
    document.body.innerHTML =
      '<div class="item" data-active="false">A</div><div class="item" data-active="true">B</div>';
    const result = findElementMatch(['.item'], {
      predicate: (el) => el.getAttribute('data-active') === 'true',
    });
    // First .item has data-active="false" → predicate fails → no more selectors → null
    expect(result).toBeNull();
  });

  it('returns null when predicate rejects all matches', () => {
    document.body.innerHTML = '<div class="item">A</div>';
    const result = findElementMatch(['.item'], {
      predicate: () => false,
    });
    expect(result).toBeNull();
  });

  it('supports custom root option', () => {
    document.body.innerHTML = `
      <div class="outer">
        <div class="inner-container">
          <span class="target">found</span>
        </div>
      </div>
      <span class="target">not-this-one</span>
    `;
    const inner = document.querySelector('.inner-container')!;
    const result = findElementMatch(['.target'], { root: inner });
    expect(result).not.toBeNull();
    expect(result!.element.textContent).toBe('found');
  });

  it('handles empty selectors array', () => {
    document.body.innerHTML = '<div class="foo">test</div>';
    const result = findElementMatch([]);
    expect(result).toBeNull();
  });

  it('handles generic type parameter', () => {
    document.body.innerHTML = '<input type="text" value="hello">';
    const result = findElementMatch<HTMLInputElement>(['input']);
    expect(result).not.toBeNull();
    expect(result!.element.value).toBe('hello');
  });
});

// ── isVisibleElement ───────────────────────────────────────────────

describe('isVisibleElement', () => {
  it('returns true when both offsetWidth and offsetHeight > 0', () => {
    const el = document.createElement('div');
    // jsdom defaults offsetWidth/Height to 0
    Object.defineProperty(el, 'offsetWidth', { value: 100 });
    Object.defineProperty(el, 'offsetHeight', { value: 50 });
    expect(isVisibleElement(el)).toBe(true);
  });

  it('returns false when offsetWidth is 0', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'offsetWidth', { value: 0 });
    Object.defineProperty(el, 'offsetHeight', { value: 50 });
    expect(isVisibleElement(el)).toBe(false);
  });

  it('returns false when offsetHeight is 0', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'offsetWidth', { value: 100 });
    Object.defineProperty(el, 'offsetHeight', { value: 0 });
    expect(isVisibleElement(el)).toBe(false);
  });

  it('returns false when both offsetWidth and offsetHeight are 0', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'offsetWidth', { value: 0 });
    Object.defineProperty(el, 'offsetHeight', { value: 0 });
    expect(isVisibleElement(el)).toBe(false);
  });

  it('handles negative values (returns false)', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'offsetWidth', { value: -10 });
    Object.defineProperty(el, 'offsetHeight', { value: 50 });
    expect(isVisibleElement(el)).toBe(false);
  });
});
