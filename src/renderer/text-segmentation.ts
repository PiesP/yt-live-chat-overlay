// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Split text without breaking combining, flag, skin-tone, or ZWJ graphemes. */
export function splitGraphemeClusters(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment);
}
