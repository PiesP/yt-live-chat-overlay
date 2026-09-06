// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getBidiLayoutCacheUsage,
  resetBidiLayoutCaches,
  resolveTextDirection,
  resolveVisualInlineLines,
  resolveVisualInlinePieces,
} from '@renderer/canvas/bidi-layout';

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

  it.each([
    ['مرحبا English 123', 'rtl'],
    ['… — 123 مرحبا', 'rtl'],
    ['English مرحبا 123', 'ltr'],
  ] as const)('resolves the first strong direction for %s', (text, expected) => {
    expect(resolveTextDirection(text)).toBe(expected);
  });

  it('keeps astral and ZWJ graphemes atomic while preserving their bidi class', () => {
    const source = 'مرحبا 👨‍👩‍👧‍👦 𐤀 English';
    const result = resolveVisualInlinePieces(
      [{ type: 'text', text: source }],
      measureText
    );
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
