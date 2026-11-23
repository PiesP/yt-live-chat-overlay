// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import {
  ActiveBidiRunPlanCache,
  getBidiLayoutCacheUsage,
  type LogicalInlinePiece,
  resetBidiLayoutCaches,
  resolveTextDirection,
  resolveVisualInlineLines,
  resolveVisualInlinePieces,
} from '@renderer/canvas/bidi-layout';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const measureText = (text: string): number => Array.from(text).length * 10;

describe('Canvas bidi inline layout', () => {
  afterEach(() => {
    resetBidiLayoutCaches();
  });

  it('preserves an embedded LTR text-object-text run inside an RTL paragraph', () => {
    const emoji = { id: 'emoji' };
    const result = resolveVisualInlinePieces(
      [
        { type: 'text', text: 'مرحبا Hello ' },
        { type: 'object', value: emoji, width: 24 },
        { type: 'text', text: ' World' },
      ],
      measureText
    );

    expect(result).toEqual([
      { type: 'text', text: 'Hello ', direction: 'ltr', width: 60 },
      { type: 'object', value: emoji, width: 24 },
      { type: 'text', text: ' World', direction: 'ltr', width: 60 },
      { type: 'text', text: 'مرحبا ', direction: 'rtl', width: 60 },
    ]);
  });

  it('places an inline object between two Arabic runs in visual order', () => {
    const emoji = { id: 'emoji' };
    const result = resolveVisualInlinePieces(
      [
        { type: 'text', text: 'مرحبا ' },
        { type: 'object', value: emoji, width: 24 },
        { type: 'text', text: ' بكم' },
      ],
      measureText
    );

    expect(result).toEqual([
      { type: 'text', text: ' بكم', direction: 'rtl', width: 40 },
      { type: 'object', value: emoji, width: 24 },
      { type: 'text', text: 'مرحبا ', direction: 'rtl', width: 60 },
    ]);
  });

  it('measures adjacent RTL pieces separately in logical grapheme order', () => {
    const first = 'א\u05B7ב';
    const second = 'ג\u05B0ד';
    const measure = vi.fn(measureText);

    expect(
      resolveVisualInlinePieces(
        [
          { type: 'text', text: first },
          { type: 'text', text: second },
        ],
        measure
      )
    ).toEqual([
      { type: 'text', text: second, direction: 'rtl', width: 30 },
      { type: 'text', text: first, direction: 'rtl', width: 30 },
    ]);
    expect(measure.mock.calls).toEqual([
      [second, 'rtl'],
      [first, 'rtl'],
    ]);
  });

  it.each([
    ['مرحبا English 123', 'rtl'],
    ['… — 123 مرحبا', 'rtl'],
    ['English مرحبا 123', 'ltr'],
  ] as const)('resolves the first strong direction for %s', (text, expected) => {
    expect(resolveTextDirection(text)).toBe(expected);
  });

  it('keeps astral and ZWJ graphemes atomic while preserving their bidi class', () => {
    const source = 'مرحبا 👨‍👩‍👧‍👦 𐤀 English';
    const result = resolveVisualInlinePieces([{ type: 'text', text: source }], measureText);
    const renderedText = result
      .filter((piece) => piece.type === 'text')
      .map((piece) => piece.text)
      .join('');

    expect(renderedText).toContain('👨‍👩‍👧‍👦');
    expect(renderedText).toContain('𐤀');
    expect(renderedText).not.toContain('\uFFFD');
    expect(Array.from(renderedText).sort()).toEqual(Array.from(source).sort());
  });

  it('applies explicit bidi isolates once without drawing their formatting controls', () => {
    const result = resolveVisualInlinePieces(
      [{ type: 'text', text: 'مرحبا \u2066English 123\u2069' }],
      measureText
    );
    const renderedText = result
      .filter((piece) => piece.type === 'text')
      .map((piece) => piece.text)
      .join('');

    expect(renderedText).toContain('English 123');
    expect(renderedText).toContain('مرحبا');
    expect(renderedText).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/u);
  });

  it('preserves ZWJ and ZWNJ shaping controls in the logical Canvas text', () => {
    const source = '\u200Dا ب\u200Cت English';
    const result = resolveVisualInlinePieces([{ type: 'text', text: source }], measureText);
    const renderedText = result
      .filter((piece) => piece.type === 'text')
      .map((piece) => piece.text)
      .join('');

    expect(renderedText).toContain('\u200Dا');
    expect(renderedText).toContain('ب\u200Cت');
  });

  it('uses one paragraph embedding when later visual lines start with weak and LTR text', () => {
    const result = resolveVisualInlineLines(
      [
        { pieces: [{ type: 'text', text: 'مرحبامرحبا' }] },
        {
          separatorBefore: ' ',
          pieces: [
            { type: 'text', text: '123' },
            { type: 'text', text: ' English' },
          ],
        },
      ],
      measureText
    );

    expect(result[1]).toEqual([
      { type: 'text', text: 'English', direction: 'ltr', width: 70 },
      { type: 'text', text: ' ', direction: 'rtl', width: 10 },
      { type: 'text', text: '123', direction: 'ltr', width: 30 },
    ]);
  });

  it('reorders and measures only the requested visible lines', () => {
    const measure = vi.fn(measureText);
    const lines = Array.from({ length: 200 }, (_, index) => ({
      separatorBefore: ' ',
      pieces: [{ type: 'text' as const, text: `مرحبا ${index}` }],
    }));

    const result = resolveVisualInlineLines(lines, measure, 3);

    expect(result).toHaveLength(3);
    expect(measure).toHaveBeenCalled();
    expect(measure.mock.calls.every(([text]) => !text.includes('199'))).toBe(true);
  });

  it('keeps ordinary LTR content on the streaming fast path without a retained plan', () => {
    resetBidiLayoutCaches();
    const emoji = { id: 'emoji' };

    expect(
      resolveVisualInlinePieces(
        [
          { type: 'text', text: 'Hello ' },
          { type: 'object', value: emoji, width: 24 },
          { type: 'text', text: ' world 123' },
        ],
        measureText
      )
    ).toEqual([
      { type: 'text', text: 'Hello ', direction: 'ltr', width: 60 },
      { type: 'object', value: emoji, width: 24 },
      { type: 'text', text: ' world 123', direction: 'ltr', width: 100 },
    ]);
    expect(getBidiLayoutCacheUsage().plan.entries).toBe(0);
  });

  it('bounds both retained caches by bytes and entries and clears them explicitly', () => {
    for (let index = 0; index < 700; index++) {
      const text = `مرحبا ${index}`;
      resolveTextDirection(text);
      resolveVisualInlinePieces([{ type: 'text', text }], measureText);
    }

    const populated = getBidiLayoutCacheUsage();
    expect(populated.direction.entries).toBeGreaterThan(0);
    expect(populated.plan.entries).toBeGreaterThan(0);
    expect(populated.direction.entries).toBeLessThanOrEqual(512);
    expect(populated.plan.entries).toBeLessThanOrEqual(512);
    expect(populated.direction.bytes).toBeLessThanOrEqual(populated.direction.maxBytes);
    expect(populated.plan.bytes).toBeLessThanOrEqual(populated.plan.maxBytes);

    resetBidiLayoutCaches();
    expect(getBidiLayoutCacheUsage()).toEqual({
      direction: { entries: 0, bytes: 0, maxBytes: 64 * 1024 },
      plan: { entries: 0, bytes: 0, maxBytes: 256 * 1024 },
    });
  });
});

describe('active scrolling bidi run plans', () => {
  afterEach(resetBidiLayoutCaches);

  it('reuses exact original text while reading current measurements and emoji slots', () => {
    const cache = new ActiveBidiRunPlanCache();
    const first: LogicalInlinePiece<string>[] = [
      { type: 'text', text: 'مرحبا \u2066Hello ' },
      { type: 'object', value: 'loading', width: 24 },
      { type: 'text', text: ' World\u2069 بكم' },
    ];
    expect(cache.resolve('same', first, measureText)).toEqual(
      resolveVisualInlinePieces(first, measureText)
    );
    const originalUsage = cache.getUsage();
    expect(originalUsage.entries).toBe(1);

    first[1] = { type: 'object', value: 'ready', width: 52 };
    const wider = (text: string): number => measureText(text) * 2;
    const changed = cache.resolve('same', first, wider);
    expect(changed).toEqual(resolveVisualInlinePieces(first, wider));
    expect(changed).toContainEqual(first[1]);
    expect(cache.getUsage()).toEqual(originalUsage);
  });

  it('rejects stale text and kind/slot ordering after a same-ID in-place edit', () => {
    const cache = new ActiveBidiRunPlanCache();
    const content: LogicalInlinePiece<string>[] = [
      { type: 'text', text: 'א literal \uFFFC ' },
      { type: 'object', value: 'emoji', width: 24 },
      { type: 'text', text: ' ب' },
    ];
    const original = cache.resolve('same', content, measureText);
    content[0] = { type: 'text', text: 'ב literal \uFFFC ' };
    expect(cache.resolve('same', content, measureText)).not.toEqual(original);
    expect(cache.resolve('same', content, measureText)).toEqual(
      resolveVisualInlinePieces(content, measureText)
    );
    content[1] = { type: 'text', text: '\uFFFC' };
    content[2] = { type: 'object', value: 'moved', width: 50 };
    expect(cache.resolve('same', content, measureText)).toEqual(
      resolveVisualInlinePieces(content, measureText)
    );
    content[0] = { type: 'text', text: 'LTR ' };
    expect(cache.resolve('same', content, measureText)).toEqual(
      resolveVisualInlinePieces(content, measureText)
    );
    expect(cache.getUsage()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it('bounds estimated retained bytes and entries independently per renderer', () => {
    const first = new ActiveBidiRunPlanCache();
    const second = new ActiveBidiRunPlanCache();
    const small = [{ type: 'text', text: 'א' }] as const;
    for (let i = 0; i < 400; i++) first.resolve(String(i), small, measureText);
    expect(first.getUsage()).toMatchObject({ entries: 256, maxEntries: 256 });
    expect(first.getUsage().bytes).toBeLessThanOrEqual(first.getUsage().maxBytes);
    expect(second.getUsage()).toMatchObject({ entries: 0, bytes: 0 });

    const oversized = [{ type: 'text', text: 'ב'.repeat(33_000) }] as const;
    expect(second.resolve('large', oversized, measureText)).toEqual(
      resolveVisualInlinePieces(oversized, measureText)
    );
    expect(second.getUsage()).toMatchObject({ entries: 0, bytes: 0 });

    first.delete('399');
    expect(first.getUsage().entries).toBe(255);
    first.clear();
    expect(first.getUsage()).toEqual({
      entries: 0,
      bytes: 0,
      maxEntries: 256,
      maxBytes: 128 * 1024,
    });
  });
});
