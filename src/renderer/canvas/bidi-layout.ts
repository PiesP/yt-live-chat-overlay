// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { ResizableByteLimitedCache } from '@piesp/browser-core/util';
import { splitGraphemeClusters } from '@renderer/text-segmentation';
import bidiFactory from 'bidi-js';

export type TextDirection = 'ltr' | 'rtl';

export interface LogicalInlineTextPiece {
  readonly type: 'text';
  readonly text: string;
}

export interface LogicalInlineObjectPiece<T> {
  readonly type: 'object';
  readonly value: T;
  readonly width: number;
}

export type LogicalInlinePiece<T> = LogicalInlineTextPiece | LogicalInlineObjectPiece<T>;

export interface LogicalInlineLine<T> {
  readonly pieces: readonly LogicalInlinePiece<T>[];
  /** Collapsed whitespace omitted at the preceding soft line break. */
  readonly separatorBefore?: string;
}

export interface VisualInlineTextPiece {
  readonly type: 'text';
  readonly text: string;
  readonly direction: TextDirection;
  readonly width: number;
}

export type VisualInlineObjectPiece<T> = LogicalInlineObjectPiece<T>;

export type VisualInlinePiece<T> = VisualInlineTextPiece | VisualInlineObjectPiece<T>;

interface TextToken {
  readonly type: 'text';
  readonly logicalIndex: number;
  readonly pieceIndex: number;
  readonly grapheme: string;
}

interface ObjectToken<T> {
  readonly type: 'object';
  readonly logicalIndex: number;
  readonly pieceIndex: number;
  readonly value: T;
  readonly width: number;
}

type InlineToken<T> = TextToken | ObjectToken<T>;

const OBJECT_REPLACEMENT_CHARACTER = '\uFFFC';
const bidi = bidiFactory();
const DIRECTION_CACHE_BYTES = 64 * 1024;
const PLAN_CACHE_BYTES = 256 * 1024;
const BIDI_CACHE_MAX_ENTRIES = 512;
interface BidiPlan {
  readonly levels: Uint8Array;
  readonly lineVisualIndices: readonly (readonly number[])[];
}
const directionCache = new ResizableByteLimitedCache<TextDirection>(
  DIRECTION_CACHE_BYTES,
  () => 8,
  undefined,
  BIDI_CACHE_MAX_ENTRIES
);
const planCache = new ResizableByteLimitedCache<BidiPlan>(
  PLAN_CACHE_BYTES,
  (plan) =>
    plan.levels.byteLength +
    plan.lineVisualIndices.reduce((total, indices) => total + indices.length * 8, 0) +
    32,
  undefined,
  BIDI_CACHE_MAX_ENTRIES
);

const BIDI_CLASS_REPRESENTATIVES: Readonly<Record<string, string>> = {
  AL: '\u0627',
  AN: '\u0661',
  B: '\n',
  BN: '\u00AD',
  CS: ',',
  EN: '1',
  ES: '+',
  ET: '$',
  FSI: '\u2068',
  L: 'A',
  LRE: '\u202A',
  LRI: '\u2066',
  LRO: '\u202D',
  NSM: '\u0300',
  ON: OBJECT_REPLACEMENT_CHARACTER,
  PDF: '\u202C',
  PDI: '\u2069',
  R: '\u05D0',
  RLE: '\u202B',
  RLI: '\u2067',
  RLO: '\u202E',
  S: '\t',
  WS: ' ',
};
const RESOLVER_ONLY_BIDI_CONTROLS = new Set([
  '\u202A', // LRE
  '\u202B', // RLE
  '\u202C', // PDF
  '\u202D', // LRO
  '\u202E', // RLO
  '\u2066', // LRI
  '\u2067', // RLI
  '\u2068', // FSI
  '\u2069', // PDI
]);

/**
 * bidi-js 1.0.3 indexes UTF-16 code units. Collapse each grapheme to one BMP
 * resolver character with the same bidi class so UAX ordering cannot split an
 * astral or ZWJ grapheme. Actual text is retained separately for native shaping.
 */
function toResolverCharacter(grapheme: string): string {
  const codePoint = grapheme.codePointAt(0);
  if (codePoint === undefined) return OBJECT_REPLACEMENT_CHARACTER;
  const firstCodePoint = String.fromCodePoint(codePoint);
  if (firstCodePoint.length === 1) return firstCodePoint;
  return (
    BIDI_CLASS_REPRESENTATIVES[bidi.getBidiCharTypeName(grapheme)] ?? OBJECT_REPLACEMENT_CHARACTER
  );
}

function isBidiFormattingControl(grapheme: string): boolean {
  return RESOLVER_ONLY_BIDI_CONTROLS.has(grapheme);
}

function tokenizeLines<T>(lines: readonly LogicalInlineLine<T>[]): {
  readonly resolverText: string;
  readonly tokens: readonly InlineToken<T>[];
  readonly lineRanges: ReadonlyArray<readonly [start: number, end: number]>;
} {
  const tokens: InlineToken<T>[] = [];
  const resolverCharacters: string[] = [];
  const lineRanges: Array<readonly [number, number]> = [];
  let pieceIndex = 0;
  const appendPiece = (piece: LogicalInlinePiece<T>): void => {
    if (piece.type === 'object') {
      const logicalIndex = tokens.length;
      tokens.push({ ...piece, logicalIndex, pieceIndex });
      resolverCharacters.push(OBJECT_REPLACEMENT_CHARACTER);
      pieceIndex++;
      return;
    }
    for (const grapheme of splitGraphemeClusters(piece.text)) {
      const logicalIndex = tokens.length;
      tokens.push({ type: 'text', logicalIndex, pieceIndex, grapheme });
      resolverCharacters.push(toResolverCharacter(grapheme));
    }
    pieceIndex++;
  };
  for (const [lineIndex, line] of lines.entries()) {
    if (lineIndex > 0 && line.separatorBefore) {
      for (const grapheme of splitGraphemeClusters(line.separatorBefore)) {
        const logicalIndex = tokens.length;
        tokens.push({ type: 'text', logicalIndex, pieceIndex, grapheme });
        resolverCharacters.push(toResolverCharacter(grapheme));
      }
      pieceIndex++;
    }

    const start = tokens.length;
    for (const piece of line.pieces) {
      appendPiece(piece);
    }
    lineRanges.push([start, tokens.length - 1]);
  }
  return { resolverText: resolverCharacters.join(''), tokens, lineRanges };
}

export function resetBidiLayoutCaches(): void {
  directionCache.clear();
  planCache.clear();
}

export function getBidiLayoutCacheUsage(): {
  readonly direction: {
    readonly entries: number;
    readonly bytes: number;
    readonly maxBytes: number;
  };
  readonly plan: { readonly entries: number; readonly bytes: number; readonly maxBytes: number };
} {
  return {
    direction: {
      entries: directionCache.size,
      bytes: directionCache.currentBytes,
      maxBytes: directionCache.maxBytes,
    },
    plan: {
      entries: planCache.size,
      bytes: planCache.currentBytes,
      maxBytes: planCache.maxBytes,
    },
  };
}

export function resolveTextDirection(text: string): TextDirection {
  if (!text) return 'ltr';
  const cached = directionCache.get(text);
  if (cached) return cached;
  let direction: TextDirection = 'ltr';
  let needsEmbeddingResolution = false;
  for (const codePoint of text) {
    if (RESOLVER_ONLY_BIDI_CONTROLS.has(codePoint)) {
      needsEmbeddingResolution = true;
      break;
    }
    const bidiClass = bidi.getBidiCharTypeName(toResolverCharacter(codePoint));
    if (bidiClass === 'L') break;
    if (bidiClass === 'R' || bidiClass === 'AL') {
      direction = 'rtl';
      break;
    }
  }
  if (needsEmbeddingResolution) {
    const resolverCharacters: string[] = [];
    for (const grapheme of splitGraphemeClusters(text)) {
      resolverCharacters.push(toResolverCharacter(grapheme));
    }
    const paragraph = bidi.getEmbeddingLevels(resolverCharacters.join('')).paragraphs[0];
    direction = paragraph && (paragraph.level & 1) === 1 ? 'rtl' : 'ltr';
  }
  directionCache.set(text, direction);
  return direction;
}

/**
 * Resolve logical text and inline replaced objects into left-to-right visual
 * drawing pieces. Text pieces stay in logical order for one native Canvas bidi
 * and shaping pass; only their run/object placement comes from UAX #9 levels.
 */
export function resolveVisualInlinePieces<T>(
  pieces: readonly LogicalInlinePiece<T>[],
  measureText: (text: string, direction: TextDirection) => number
): VisualInlinePiece<T>[] {
  return resolveVisualInlineLines([{ pieces }], measureText)[0] ?? [];
}

/**
 * Resolve multiple visual lines from one paragraph embedding pass. Soft-wrap
 * separators participate in paragraph direction resolution but are excluded
 * from the visible line ranges passed to UAX #9 line reordering.
 */
export function resolveVisualInlineLines<T>(
  lines: readonly LogicalInlineLine<T>[],
  measureText: (text: string, direction: TextDirection) => number,
  lineLimit = lines.length
): VisualInlinePiece<T>[][] {
  const visibleLines = lines.slice(0, Math.max(0, lineLimit));
  if (!requiresBidiResolution(lines)) {
    return visibleLines.map(({ pieces }) =>
      pieces.flatMap((piece): VisualInlinePiece<T>[] => {
        if (piece.type === 'object') return [piece];
        return piece.text
          ? [
              {
                type: 'text',
                text: piece.text,
                direction: 'ltr',
                width: measureText(piece.text, 'ltr'),
              },
            ]
          : [];
      })
    );
  }
  const { resolverText, tokens, lineRanges } = tokenizeLines(lines);
  const resolvedRanges = lineRanges.slice(0, visibleLines.length);
  if (tokens.length === 0) return resolvedRanges.map(() => []);
  const planKey = `${resolverText}\u0000${resolvedRanges.map(([start, end]) => `${start}:${end}`).join(',')}`;
  let plan = planCache.get(planKey);
  if (!plan) {
    const embedding = bidi.getEmbeddingLevels(resolverText);
    plan = {
      levels: embedding.levels,
      lineVisualIndices: resolvedRanges.map(([start, end]) =>
        getRangeReorderedIndices(resolverText, embedding, start, end)
      ),
    };
    planCache.set(planKey, plan);
  }
  const { levels } = plan;
  return plan.lineVisualIndices.map((visualIndices) =>
    buildVisualPieces(tokens, levels, visualIndices, measureText)
  );
}

function requiresBidiResolution<T>(lines: readonly LogicalInlineLine<T>[]): boolean {
  for (const { pieces } of lines) {
    if (piecesRequireBidiResolution(pieces)) return true;
  }
  return false;
}

function piecesRequireBidiResolution<T>(pieces: readonly LogicalInlinePiece<T>[]): boolean {
  for (const piece of pieces) {
    if (piece.type === 'object') continue;
    for (const codePoint of piece.text) {
      if (RESOLVER_ONLY_BIDI_CONTROLS.has(codePoint)) return true;
      const bidiClass = bidi.getBidiCharTypeName(toResolverCharacter(codePoint));
      if (bidiClass === 'R' || bidiClass === 'AL') return true;
    }
  }
  return false;
}

function getRangeReorderedIndices(
  resolverText: string,
  embedding: Parameters<typeof bidi.getReorderSegments>[1],
  start: number,
  end: number
): number[] {
  if (end < start) return [];
  const indices = Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
  for (const [segmentStart, segmentEnd] of bidi.getReorderSegments(
    resolverText,
    embedding,
    start,
    end
  )) {
    let left = segmentStart - start;
    let right = segmentEnd - start;
    while (left < right) {
      const leftIndex = indices[left];
      const rightIndex = indices[right];
      if (leftIndex === undefined || rightIndex === undefined) break;
      indices[left] = rightIndex;
      indices[right] = leftIndex;
      left++;
      right--;
    }
  }
  return indices;
}

function buildVisualPieces<T>(
  tokens: readonly InlineToken<T>[],
  levels: Uint8Array,
  visualIndices: readonly number[],
  measureText: (text: string, direction: TextDirection) => number
): VisualInlinePiece<T>[] {
  const result: VisualInlinePiece<T>[] = [];

  for (let visualIndex = 0; visualIndex < visualIndices.length; ) {
    const logicalIndex = visualIndices[visualIndex];
    if (logicalIndex === undefined) {
      visualIndex++;
      continue;
    }
    const token = tokens[logicalIndex];
    if (!token) {
      visualIndex++;
      continue;
    }
    if (token.type === 'object') {
      result.push({ type: 'object', value: token.value, width: token.width });
      visualIndex++;
      continue;
    }

    const level = levels[logicalIndex] ?? 0;
    const direction: TextDirection = (level & 1) === 1 ? 'rtl' : 'ltr';
    const logicalStep = direction === 'rtl' ? -1 : 1;
    const run: TextToken[] = [token];
    let previousLogicalIndex = logicalIndex;
    visualIndex++;
    while (visualIndex < visualIndices.length) {
      const nextLogicalIndex = visualIndices[visualIndex];
      const nextToken = nextLogicalIndex === undefined ? undefined : tokens[nextLogicalIndex];
      if (
        nextLogicalIndex === undefined ||
        nextToken?.type !== 'text' ||
        nextToken.pieceIndex !== token.pieceIndex ||
        (levels[nextLogicalIndex] ?? 0) !== level ||
        nextLogicalIndex !== previousLogicalIndex + logicalStep
      ) {
        break;
      }
      run.push(nextToken);
      previousLogicalIndex = nextLogicalIndex;
      visualIndex++;
    }

    run.sort((left, right) => left.logicalIndex - right.logicalIndex);
    const text = run
      .map(({ grapheme }) => grapheme)
      .filter((grapheme) => !isBidiFormattingControl(grapheme))
      .join('');
    if (text) {
      result.push({ type: 'text', text, direction, width: measureText(text, direction) });
    }
  }
  return result;
}
