// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { getRegularCardInsets } from '@renderer/layout/card-layout';
import {
  getFontString,
  getTextMeasurementGeneration,
  measureTextTopBounds,
} from '@renderer/text-measure';
import { rendererLayout } from '@util/design-tokens';

type MeasureContext = Parameters<typeof measureTextTopBounds>[3];
interface ContentLike {
  text: string;
  content: readonly {
    type: string;
    content?: string;
    emojiFallbackText?: string;
    emoji?: { fallbackText?: string };
  }[];
}

// A retained content array keeps its prepared bounds even when the bounded
// text LRU evicts its strings. This prevents measurement during frame drawing.
const contentBounds = new WeakMap<
  object,
  {
    font: string;
    fontSize: number;
    text: string;
    generation: number;
    bounds: { height: number; above: number };
  }
>();

/** Complete baseline envelope and actual fallback-font/emoji overflow. */
export function getRegularContentBounds(
  message: ContentLike,
  font: string,
  fontSize: number,
  context?: MeasureContext
): { height: number; above: number } {
  const text = message.content.length ? '' : message.text;
  const generation = getTextMeasurementGeneration();
  const cached = contentBounds.get(message.content);
  if (
    cached &&
    cached.font === font &&
    cached.fontSize === fontSize &&
    cached.text === text &&
    cached.generation === generation
  )
    return cached.bounds;
  const base = measureTextTopBounds(font, fontSize, undefined, context);
  let above = base.above;
  let below = base.below;
  const texts = message.content.length
    ? message.content.map((segment) =>
        segment.type === 'text'
          ? (segment.content ?? '')
          : (segment.emojiFallbackText ?? segment.emoji?.fallbackText ?? '')
      )
    : [message.text];
  for (const text of texts) {
    if (!text) continue;
    const bounds = measureTextTopBounds(font, fontSize, text, context);
    above = Math.max(above, bounds.above);
    below = Math.max(below, bounds.below);
  }
  const emojiHeight = message.content.some((segment) => segment.type === 'emoji')
    ? Math.round(fontSize * rendererLayout.emojiSize)
    : 0;
  const bounds = { height: Math.max(1, above + below, emojiHeight), above };
  contentBounds.set(message.content, { font, fontSize, text, generation, bounds });
  return bounds;
}

/** Baseline transparent, author-free row includes mandatory outline/AA insets. */
export function getRegularRowHeight(
  fontSize: number,
  fontWeight: 'bold' | 'normal',
  fontFamily: string,
  outlineWidthPx: number,
  context?: MeasureContext
): number {
  const bounds = getRegularContentBounds(
    { text: '', content: [] },
    getFontString(fontSize, fontWeight, fontFamily),
    fontSize,
    context
  );
  return bounds.height + 2 * getRegularCardInsets(fontSize, outlineWidthPx, false, false).vertical;
}

/** Density refines the grid; full ordinary rows always keep the same pitch. */
export function getRowGridHeight(baseHeight: number, gap: number, densityFactor = 1): number {
  const subdivisions = densityFactor <= 0.5 ? 4 : densityFactor < 1 ? 2 : 1;
  return Math.max(1, (baseHeight + gap) / subdivisions);
}

/** Reserve user spacing outside the content rectangle, including tall cards. */
export function getRowSlotCount(height: number, gridHeight: number, gap = 0): number {
  return Math.max(1, Math.ceil((height + gap) / gridHeight - 1e-9));
}

export function getRowContentOffset(height: number, gridHeight: number, gap = 0): number {
  return Math.max(
    0,
    Math.floor((getRowSlotCount(height, gridHeight, gap) * gridHeight - gap - height) / 2)
  );
}
