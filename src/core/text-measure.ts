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
 * Measure the full bounding-box width of a text string.
 *
 * Uses `actualBoundingBoxLeft + actualBoundingBoxRight` so that glyph
 * overshoot (common with italic fonts and some CJK glyphs) is included.
 * Falls back to `TextMetrics.width` when the bounding-box API returns
 * zeros (empty or whitespace-only strings).
 */
export function measureTextWidth(text: string, font: string): number {
  const ctx = getCtx();
  ctx.font = font;
  const m = ctx.measureText(text);
  const bbWidth = Math.abs(m.actualBoundingBoxLeft) + Math.abs(m.actualBoundingBoxRight);
  if (bbWidth > 0) {
    return Math.ceil(bbWidth);
  }
  // Fallback: empty / whitespace-only strings report 0 for bounding box.
  return Math.ceil(m.width);
}

/**
 * Measure the full bounding-box height of the font's rendered glyphs.
 *
 * Uses `actualBoundingBoxAscent + actualBoundingBoxDescent` measured
 * against a representative string ("Mg") for the tightest vertical fit.
 * Falls back to `fontBoundingBoxAscent + Descent` and then to a
 * fontSize-based estimate.
 */
export function measureTextHeight(font: string, fontSize: number): number {
  const ctx = getCtx();
  ctx.font = font;
  const m = ctx.measureText('Mg');

  // Prefer actual (per-glyph) bounding box — most accurate.
  const actualAscent = m.actualBoundingBoxAscent;
  const actualDescent = m.actualBoundingBoxDescent;
  if (actualAscent !== undefined && actualDescent !== undefined && actualAscent > 0) {
    return Math.ceil(actualAscent + actualDescent);
  }

  // Fallback: font-level bounding box (em-square based).
  const fontAscent = m.fontBoundingBoxAscent;
  const fontDescent = m.fontBoundingBoxDescent;
  if (fontAscent !== undefined && fontDescent !== undefined && fontAscent > 0) {
    return Math.ceil(fontAscent + fontDescent);
  }

  // Last resort: rough estimate from font size.
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
 * Measure the number of wrapped lines a text string will occupy when
 * constrained to `maxWidth` pixels, using the given font.
 *
 * Uses a greedy word-wrapping algorithm: words are accumulated until
 * adding the next word would exceed `maxWidth`, then a new line starts.
 * Explicit newlines (\n) in the text are always honoured.
 *
 * @param text     - The text to measure.
 * @param font     - CSS font string (e.g. "bold 16px sans-serif").
 * @param maxWidth - Maximum line width in pixels.
 * @returns The number of lines (always >= 1 for non-empty text, 0 for empty).
 */
export function measureWrappedLineCount(text: string, font: string, maxWidth: number): number {
  if (text.length === 0) return 0;

  const ctx = getCtx();
  ctx.font = font;

  const lines = text.split('\n');
  let totalLines = 0;

  for (const line of lines) {
    if (line.length === 0) {
      totalLines++;
      continue;
    }

    const words = line.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      totalLines++;
      continue;
    }

    let currentLineWidth = ctx.measureText(words[0] ?? '').width;
    let lineCount = 1;

    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      if (!word) continue;
      const wordWidth = ctx.measureText(word).width;
      const spaceWidth = ctx.measureText(' ').width;

      if (currentLineWidth + spaceWidth + wordWidth > maxWidth) {
        lineCount++;
        currentLineWidth = wordWidth;
      } else {
        currentLineWidth += spaceWidth + wordWidth;
      }
    }

    totalLines += lineCount;
  }

  return totalLines;
}
