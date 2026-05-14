/**
 * Shared Canvas-based text measurement for dimension estimation.
 *
 * Uses a single hidden canvas context so callers can measure text without
 * DOM reflow or creating their own context.
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

/** Pixel width of a text string at the given font CSS shorthand. */
export function measureTextWidth(text: string, font: string): number {
  const ctx = getCtx();
  ctx.font = font;
  return Math.ceil(ctx.measureText(text).width);
}

/** Pixel height of rendered text at the given font and size. */
export function measureTextHeight(font: string, fontSize: number): number {
  const ctx = getCtx();
  ctx.font = font;
  const m = ctx.measureText('Mg');
  const ascent = m.fontBoundingBoxAscent;
  const descent = m.fontBoundingBoxDescent;
  if (ascent !== undefined && descent !== undefined && ascent > 0) {
    return Math.ceil(ascent + descent);
  }
  return Math.ceil(fontSize * 1.1);
}

export const FONT_FAMILY = 'system-ui, -apple-system, sans-serif';

export function getFontString(
  sizePx: number,
  weight: 'normal' | 'bold' = 'bold',
  fontFamily: string = FONT_FAMILY
): string {
  return `${weight === 'bold' ? 'bold' : '400'} ${sizePx}px ${fontFamily}`;
}
