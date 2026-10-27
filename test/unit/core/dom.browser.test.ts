import { isAbortError } from '@piesp/browser-core/error';
import {
  findElementMatch,
  findPlayerContainerElement,
  forEachSlot,
  isVisibleElement,
} from '@util/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

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
  function sizedElement(width: string, height: string): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = `display: inline-block; width: ${width}; height: ${height}`;
    document.body.append(el);
    return el;
  }

  it('returns true when both offsetWidth and offsetHeight > 0', () => {
    const el = sizedElement('100px', '50px');
    expect(isVisibleElement(el)).toBe(true);
  });

  it('returns false when offsetWidth is 0', () => {
    const el = sizedElement('0px', '50px');
    expect(isVisibleElement(el)).toBe(false);
  });

  it('returns false when offsetHeight is 0', () => {
    const el = sizedElement('100px', '0px');
    expect(isVisibleElement(el)).toBe(false);
  });

  it('returns false when both offsetWidth and offsetHeight are 0', () => {
    const el = sizedElement('0px', '0px');
    expect(isVisibleElement(el)).toBe(false);
  });

  it('treats a negative CSS width as zero layout width', () => {
    const el = sizedElement('-10px', '50px');
    expect(el.offsetWidth).toBe(0);
    expect(isVisibleElement(el)).toBe(false);
  });
});

describe('findPlayerContainerElement', () => {
  let player: HTMLElement;

  function setPlayerWidth(width: number): void {
    player.style.width = `${width}px`;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    player = document.createElement('div');
    player.id = 'movie_player';
    player.style.cssText = 'display: inline-block; width: 0; height: 100px';
    document.body.append(player);
  });

  afterEach(() => {
    try {
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      document.body.innerHTML = '';
    }
  });

  it('returns the first visible selector immediately, even when pre-aborted', async () => {
    setPlayerWidth(100);
    const controller = new AbortController();
    controller.abort();
    await expect(findPlayerContainerElement({ signal: controller.signal })).resolves.toBe(player);
  });

  it('rejects a pre-aborted lookup when no player is visible', async () => {
    const controller = new AbortController();
    controller.abort('original reason');
    await expect(findPlayerContainerElement({ signal: controller.signal })).rejects.toBe(
      'original reason'
    );
  });

  it('finds a style-only visibility change at the next probe', async () => {
    const lookup = findPlayerContainerElement({ attempts: 5, intervalMs: 1000 });
    let found: HTMLElement | null | undefined;
    void lookup.then((result) => {
      found = result;
    });
    await vi.advanceTimersByTimeAsync(100);
    setPlayerWidth(100);
    await vi.advanceTimersByTimeAsync(899);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(found).toBe(player);
    await expect(lookup).resolves.toBe(player);
    await vi.advanceTimersByTimeAsync(9000);
  });

  it('retains the observer window and final deadline probe', async () => {
    const lookup = findPlayerContainerElement({ attempts: 5, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(8999);
    setPlayerWidth(100);
    await vi.advanceTimersByTimeAsync(1);
    await expect(lookup).resolves.toBe(player);
  });

  it('responds to an inserted player without waiting for the next timer', async () => {
    player.remove();
    setPlayerWidth(100);
    const lookup = findPlayerContainerElement({ attempts: 5, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(100);
    document.body.append(player);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
    await expect(lookup).resolves.toBe(player);
  });

  it('keeps first-match visibility and selector precedence', async () => {
    const hiddenFirst = player;
    const visibleSecond = document.createElement('div');
    visibleSecond.id = 'movie_player';
    visibleSecond.style.cssText = 'display: inline-block; width: 100px; height: 100px';
    document.body.append(visibleSecond);
    const classPlayer = document.createElement('div');
    classPlayer.className = 'html5-video-player';
    classPlayer.style.cssText = 'display: inline-block; width: 100px; height: 100px';
    document.body.append(classPlayer);
    await expect(findPlayerContainerElement()).resolves.toBe(classPlayer);
    hiddenFirst.remove();
    await expect(findPlayerContainerElement()).resolves.toBe(visibleSecond);
  });

  it('returns null at the observer deadline without an appended polling window', async () => {
    const lookup = findPlayerContainerElement({ attempts: 5, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(8999);
    let settled = false;
    void lookup.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(lookup).resolves.toBeNull();
  });

  it('retains the helper default deadlines with and without observation', async () => {
    const observed = findPlayerContainerElement();
    await vi.advanceTimersByTimeAsync(4499);
    let observedSettled = false;
    void observed.then(() => {
      observedSettled = true;
    });
    expect(observedSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(observed).resolves.toBeNull();

    vi.stubGlobal('MutationObserver', undefined);
    const polling = findPlayerContainerElement();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(polling).resolves.toBeNull();
  });

  it('keeps the shorter no-observer deadline and its final probe', async () => {
    vi.stubGlobal('MutationObserver', undefined);
    const lookup = findPlayerContainerElement({ attempts: 5, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3999);
    setPlayerWidth(100);
    await vi.advanceTimersByTimeAsync(1);
    await expect(lookup).resolves.toBe(player);
  });

  it('uses exactly five idle lookups without an observer', async () => {
    vi.stubGlobal('MutationObserver', undefined);
    const query = vi.spyOn(document, 'querySelector');
    const lookup = findPlayerContainerElement({ attempts: 5, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(4000);
    await expect(lookup).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(10);
    query.mockRestore();
  });

  it('bounds idle probes and mutation bursts without restarting the deadline', async () => {
    let notify: (() => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'MutationObserver',
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe(): void {}
        disconnect = disconnect;
      }
    );
    const query = vi.spyOn(document, 'querySelector');
    const lookup = findPlayerContainerElement({ attempts: 5, intervalMs: 1000 });
    expect(query).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 20; i++) notify?.();
    expect(query).toHaveBeenCalledTimes(42);
    await vi.advanceTimersByTimeAsync(8900);
    await expect(lookup).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(60); // 1 initial + 20 mutations + 9 timed probes
    expect(disconnect).toHaveBeenCalledTimes(1);
    notify?.();
    await vi.advanceTimersByTimeAsync(9000);
    expect(query).toHaveBeenCalledTimes(60);
    query.mockRestore();
  });

  it('aborts during waiting and does not probe after settlement', async () => {
    const controller = new AbortController();
    const query = vi.spyOn(document, 'querySelector');
    const lookup = findPlayerContainerElement({
      attempts: 5,
      intervalMs: 1000,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await expect(lookup).rejects.toMatchObject({ name: 'AbortError' });
    const count = query.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(query).toHaveBeenCalledTimes(count);
    query.mockRestore();
  });

  it('aborts during the later window and settles only once when visibility and timeout race', async () => {
    const controller = new AbortController();
    const lookup = findPlayerContainerElement({
      attempts: 5,
      intervalMs: 1000,
      signal: controller.signal,
    });
    const rejection = expect(lookup).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(5000);
    controller.abort();
    setPlayerWidth(100);
    await vi.advanceTimersByTimeAsync(4000);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);

    setPlayerWidth(0);
    const timeoutController = new AbortController();
    const timeoutLookup = findPlayerContainerElement({
      attempts: 1,
      intervalMs: 1000,
      signal: timeoutController.signal,
    });
    await vi.advanceTimersByTimeAsync(1000);
    timeoutController.abort();
    await expect(timeoutLookup).resolves.toBeNull();
  });

  it('preserves observer and polling abort reason classification', async () => {
    const timeout = new DOMException('lookup timed out', 'TimeoutError');
    const early = new AbortController();
    const earlyLookup = findPlayerContainerElement({ signal: early.signal });
    const earlyRejection = expect(earlyLookup).rejects.toMatchObject({ name: 'AbortError' });
    early.abort(timeout);
    await earlyRejection;

    const late = new AbortController();
    const lateLookup = findPlayerContainerElement({
      attempts: 5,
      intervalMs: 1000,
      signal: late.signal,
    });
    const lateRejection = expect(lateLookup).rejects.toBe(timeout);
    await vi.advanceTimersByTimeAsync(5000);
    late.abort(timeout);
    await lateRejection;

    vi.stubGlobal('MutationObserver', undefined);
    const fallback = new AbortController();
    const fallbackLookup = findPlayerContainerElement({ signal: fallback.signal });
    const fallbackRejection = expect(fallbackLookup).rejects.toBe(timeout);
    fallback.abort(timeout);
    await fallbackRejection;
  });

  it('keeps concurrent callers independent when one aborts', async () => {
    const controller = new AbortController();
    const cancelled = findPlayerContainerElement({ signal: controller.signal });
    const live = findPlayerContainerElement();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    setPlayerWidth(100);
    await vi.advanceTimersByTimeAsync(500);
    await expect(live).resolves.toBe(player);
  });

  it('disconnects an observer when setup or a later query throws', async () => {
    const disconnect = vi.fn();
    vi.stubGlobal(
      'MutationObserver',
      class {
        observe(): void {
          throw new Error('observe failed');
        }
        disconnect = disconnect;
      }
    );
    await expect(findPlayerContainerElement()).rejects.toThrow('observe failed');
    expect(disconnect).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    const query = vi.spyOn(document, 'querySelector');
    const lookup = findPlayerContainerElement({ intervalMs: 1000 });
    const rejection = expect(lookup).rejects.toThrow('query failed');
    query.mockImplementation(() => {
      throw new Error('query failed');
    });
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    query.mockRestore();
  });

  it("releases each invocation's listener, observer and timer on every settlement path", async () => {
    for (const scenario of ['success', 'timeout', 'abort', 'setup-error', 'query-error'] as const) {
      let notify: (() => void) | undefined;
      const disconnect = vi.fn();
      vi.stubGlobal(
        'MutationObserver',
        class {
          constructor(callback: () => void) {
            notify = callback;
          }
          observe(): void {
            if (scenario === 'setup-error') throw new Error('observe failed');
          }
          disconnect = disconnect;
        }
      );
      const controller = new AbortController();
      const added = vi.spyOn(controller.signal, 'addEventListener');
      const removed = vi.spyOn(controller.signal, 'removeEventListener');
      const query = vi.spyOn(document, 'querySelector');
      setPlayerWidth(0);
      const lookup = findPlayerContainerElement({
        attempts: 5,
        intervalMs: 1000,
        signal: controller.signal,
      });
      if (scenario === 'success') {
        setPlayerWidth(100);
        notify?.();
        await expect(lookup).resolves.toBe(player);
      } else if (scenario === 'timeout') {
        await vi.advanceTimersByTimeAsync(9000);
        await expect(lookup).resolves.toBeNull();
      } else if (scenario === 'abort') {
        const rejection = expect(lookup).rejects.toMatchObject({ name: 'AbortError' });
        controller.abort();
        await rejection;
      } else if (scenario === 'setup-error') {
        await expect(lookup).rejects.toThrow('observe failed');
      } else {
        const rejection = expect(lookup).rejects.toBeUndefined();
        query.mockImplementation(() => {
          throw undefined;
        });
        notify?.();
        await rejection;
      }
      const expectedListeners = scenario === 'setup-error' ? 0 : 1;
      const abortAdds = added.mock.calls.filter(([type]) => type === 'abort');
      const abortRemoves = removed.mock.calls.filter(([type]) => type === 'abort');
      expect(abortAdds).toHaveLength(expectedListeners);
      expect(abortRemoves).toHaveLength(expectedListeners);
      if (expectedListeners) expect(abortRemoves[0]?.[1]).toBe(abortAdds[0]?.[1]);
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      const probes = query.mock.calls.length;
      notify?.();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(query.mock.calls).toHaveLength(probes);
      query.mockRestore();
      added.mockRestore();
      removed.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('settles finite edge inputs without scheduling an endless wait', async () => {
    vi.stubGlobal('MutationObserver', undefined);
    await expect(findPlayerContainerElement({ attempts: 1, intervalMs: 0 })).resolves.toBeNull();
    const lookup = findPlayerContainerElement({
      attempts: Number.NaN,
      intervalMs: Number.POSITIVE_INFINITY,
    });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(lookup).resolves.toBeNull();
    const extreme = findPlayerContainerElement({
      attempts: Number.MAX_VALUE,
      intervalMs: Number.MAX_VALUE,
    });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(extreme).resolves.toBeNull();
  });
});
