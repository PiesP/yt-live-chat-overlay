// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Lazy-initialized Intl.Segmenter for grapheme-cluster splitting. */
let graphemeSegmenter: Intl.Segmenter | undefined;

function getGraphemeSegmenter(): Intl.Segmenter | undefined {
  if (typeof Intl.Segmenter !== 'function') return undefined;
  if (graphemeSegmenter === undefined) {
    try {
      graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    } catch {
      graphemeSegmenter = undefined;
    }
  }
  return graphemeSegmenter;
}

/** Return null when exact grapheme boundaries are unavailable to a truncation caller. */
export function splitGraphemesForTruncation(text: string): string[] | null {
  const segmenter = getGraphemeSegmenter();
  return segmenter ? Array.from(segmenter.segment(text), (segment) => segment.segment) : null;
}

/** Split text without breaking combining, flag, skin-tone, or ZWJ graphemes. */
export function splitGraphemeClusters(text: string): string[] {
  const segmenter = getGraphemeSegmenter();
  if (segmenter) {
    return Array.from(segmenter.segment(text), (segment) => segment.segment);
  }
  return Array.from(text);
}
