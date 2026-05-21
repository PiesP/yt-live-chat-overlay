/**
 * Shared Canvas-based text measurement for dimension estimation.
 *
 * Uses a single hidden canvas context so callers can measure text without
 * DOM reflow or creating their own context.
 *
 * Width measurement uses `actualBoundingBoxLeft + actualBoundingBoxRight`
 * instead of `TextMetrics.width` (advance width) to capture glyph
 * overshoot (e.g. italic fonts, CJK characters that extend beyond the
 * advance width). Height uses `actualBoundingBoxAscent + Descent` for
 * the tightest fit around rendered glyphs.
 */

let measureCtx: CanvasRenderingContext2D | null = null;

/** LRU cache for measureTextWidth. Keyed by `${font}|${text}`. */
const widthCache = new Map<string, number>();
const WIDTH_CACHE_MAX = 500;

function getCtx(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const canvas = document.createElement('canvas');
    canvas.width = 0;
    canvas.height = 0;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to create Canvas 2D context for text measurement');
    measureCtx = ctx;
  }
  return measureCtx;
}

/**
 * Clear the text measurement caches.
 * Call when settings change (font, fontSize) to avoid stale entries.
 */
export function clearTextMeasurementCaches(): void {
  widthCache.clear();
}

/**
 * Measure the full bounding-box width of a text string.
 *
 * Uses `actualBoundingBoxLeft + actualBoundingBoxRight` so that glyph
 * overshoot (common with italic fonts and some CJK glyphs) is included.
 * Falls back to `TextMetrics.width` when the bounding-box API returns
 * zeros (empty or whitespace-only strings).
 *
 * Results are cached in an LRU cache (max 500 entries) for performance
 * in hot paths like the Canvas2D render loop.
 */
export function measureTextWidth(text: string, font: string): number {
  const key = `${font}|${text}`;
  const cached = widthCache.get(key);
  if (cached !== undefined) return cached;

  const ctx = getCtx();
  ctx.font = font;
  const m = ctx.measureText(text);
  const bbWidth = Math.abs(m.actualBoundingBoxLeft) + Math.abs(m.actualBoundingBoxRight);
  const width = bbWidth > 0 ? Math.ceil(bbWidth) : Math.ceil(m.width);

  if (widthCache.size >= WIDTH_CACHE_MAX) {
    const oldestKey = widthCache.keys().next().value;
    if (oldestKey !== undefined) widthCache.delete(oldestKey);
  }
  widthCache.set(key, width);
  return width;
}

/**
 * Measure the full bounding-box height of the font's rendered glyphs.
 *
 * Uses `actualBoundingBoxAscent + actualBoundingBoxDescent` measured
 * against a representative string ("Mg") for the tightest vertical fit.
 * Falls back to a fontSize-based estimate when the bounding-box API is
 * unavailable (very old browsers).
 */
export function measureTextHeight(font: string, fontSize: number): number {
  const ctx = getCtx();
  ctx.font = font;
  const m = ctx.measureText('Mg');

  const actualAscent = m.actualBoundingBoxAscent;
  const actualDescent = m.actualBoundingBoxDescent;
  if (actualAscent > 0 && actualDescent > 0) {
    return Math.ceil(actualAscent + actualDescent);
  }

  return Math.ceil(fontSize * 1.1);
}

export function getFontString(
  sizePx: number,
  weight: 'normal' | 'bold' = 'bold',
  fontFamily: string = 'system-ui, -apple-system, sans-serif'
): string {
  return `${weight === 'bold' ? 'bold' : '400'} ${sizePx}px ${fontFamily}`;
}

/**
 * Split a single line of text into wrapped line segments constrained to
 * `maxWidth` pixels, using the given font.
 *
 * Uses a greedy word-wrapping algorithm: words are accumulated until
 * adding the next word would exceed `maxWidth`, then a new line starts.
 * For CJK text without spaces, falls back to character-level wrapping so
 * that long CJK strings are never wider than `maxWidth`.
 *
 * @param line     - A single line of text (no newlines).
 * @param ctx      - Canvas rendering context with font already set.
 * @param maxWidth - Maximum line width in pixels.
 * @returns Array of line segments (always >= 1 for non-empty input, 0 for empty).
 */
function wrapLine(line: string, ctx: CanvasRenderingContext2D, maxWidth: number): string[] {
  const words = line.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];

  const spaceWidth = ctx.measureText(' ').width;
  const lines: string[] = [];
  let currentLine = words[0] ?? '';
  let currentWidth = ctx.measureText(currentLine).width;

  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (!word) continue;
    const wordWidth = ctx.measureText(word).width;

    // If a single word exceeds maxWidth, use character-level wrapping
    if (wordWidth > maxWidth) {
      // Flush the current line first if it has content
      if (currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = '';
        currentWidth = 0;
      }
      // Wrap the long word character by character
      const charWrapped = wrapChars(word, ctx, maxWidth);
      // All but the last char segment become their own lines
      for (let j = 0; j < charWrapped.length - 1; j++) {
        lines.push(charWrapped[j] ?? '');
      }
      const lastChar = charWrapped[charWrapped.length - 1] ?? '';
      currentLine = lastChar;
      currentWidth = ctx.measureText(lastChar).width;
      continue;
    }

    if (currentWidth + spaceWidth + wordWidth > maxWidth) {
      lines.push(currentLine);
      currentLine = word;
      currentWidth = wordWidth;
    } else {
      currentLine += ` ${word}`;
      currentWidth += spaceWidth + wordWidth;
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Wrap a single word (no spaces) at character boundaries so each segment
 * fits within `maxWidth`.
 */
function wrapChars(word: string, ctx: CanvasRenderingContext2D, maxWidth: number): string[] {
  const segments: string[] = [];
  let current = '';
  let currentWidth = 0;

  for (const ch of word) {
    const chWidth = ctx.measureText(ch).width;
    if (currentWidth + chWidth > maxWidth && current.length > 0) {
      segments.push(current);
      current = ch;
      currentWidth = chWidth;
    } else {
      current += ch;
      currentWidth += chWidth;
    }
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

/**
 * Wrap text into lines constrained to `maxWidth` pixels.
 *
 * Honors explicit newlines (`\n`) in the text. Each paragraph is wrapped
 * independently. CJK text without spaces is wrapped at character boundaries.
 *
 * @param text     - The text to wrap.
 * @param font     - CSS font string (e.g. "bold 16px sans-serif").
 * @param maxWidth - Maximum line width in pixels.
 * @returns Array of wrapped lines (always >= 1 for non-empty text, 0 for empty).
 */
export function wrapTextLines(text: string, font: string, maxWidth: number): string[] {
  if (text.length === 0) return [];

  const ctx = getCtx();
  ctx.font = font;

  const paragraphs = text.split('\n');
  const result: string[] = [];

  for (const paragraph of paragraphs) {
    const wrapped = wrapLine(paragraph, ctx, maxWidth);
    for (const line of wrapped) {
      result.push(line);
    }
  }

  return result;
}
