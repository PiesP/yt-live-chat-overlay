import { describe, it, expect } from 'vitest';
import {
  parseAnyColor,
  computeOutlineColor,
  toRgba,
  computeReadableTextColor,
  resolveSuperChatRgb,
} from '@renderer/color-utils';
import type { SuperChatTier } from '@app-types';
import type { RgbColor } from '@app-types';

// ── parseAnyColor ─────────────────────────────────────────────────────

describe('parseAnyColor', () => {
  describe('hex colors', () => {
    it('parses 6-digit hex', () => {
      expect(parseAnyColor('#FF0000')).toEqual({ r: 255, g: 0, b: 0 });
      expect(parseAnyColor('#00ff00')).toEqual({ r: 0, g: 255, b: 0 });
      expect(parseAnyColor('#0000FF')).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('parses 3-digit short hex', () => {
      expect(parseAnyColor('#F00')).toEqual({ r: 255, g: 0, b: 0 });
      expect(parseAnyColor('#0F0')).toEqual({ r: 0, g: 255, b: 0 });
      expect(parseAnyColor('#00F')).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('parses 4-digit hex (treated as short)', () => {
      // 4-digit hex: expand each char
      expect(parseAnyColor('#F00F')).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('parses 8-digit hex (treated as long)', () => {
      // 8-digit: first 6 chars are RGB
      expect(parseAnyColor('#FF0000FF')).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('returns null for hex shorter than 3 chars', () => {
      expect(parseAnyColor('#FF')).toBeNull();
      expect(parseAnyColor('#0')).toBeNull();
    });

    it('returns null for invalid hex', () => {
      expect(parseAnyColor('#GGGGGG')).toBeNull();
    });

    it('handles black and white', () => {
      expect(parseAnyColor('#000000')).toEqual({ r: 0, g: 0, b: 0 });
      expect(parseAnyColor('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255 });
    });
  });

  describe('rgb/rgba colors', () => {
    it('parses rgb() format', () => {
      expect(parseAnyColor('rgb(255, 0, 0)')).toEqual({ r: 255, g: 0, b: 0 });
      expect(parseAnyColor('rgb(0, 128, 255)')).toEqual({ r: 0, g: 128, b: 255 });
    });

    it('parses rgba() format (ignores alpha)', () => {
      expect(parseAnyColor('rgba(255, 0, 0, 0.5)')).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('handles spaces in rgb()', () => {
      expect(parseAnyColor('rgb( 255 , 128 , 64 )')).toEqual({ r: 255, g: 128, b: 64 });
    });

    it('returns null for non-matching strings', () => {
      expect(parseAnyColor('hsl(0, 100%, 50%)')).toBeNull();
      expect(parseAnyColor('red')).toBeNull();
      expect(parseAnyColor('')).toBeNull();
    });
  });
});

// ── computeOutlineColor ───────────────────────────────────────────────

describe('computeOutlineColor', () => {
  it('returns dark outline for light text colors', () => {
    // White is light → dark outline
    expect(computeOutlineColor('#FFFFFF', 0.8)).toBe('rgba(0, 0, 0, 0.8)');
    // Yellow is light → dark outline
    expect(computeOutlineColor('#FFFF00', 0.5)).toBe('rgba(0, 0, 0, 0.5)');
  });

  it('returns light outline for dark text colors', () => {
    // Black is dark → light outline
    expect(computeOutlineColor('#000000', 0.8)).toBe('rgba(255, 255, 255, 0.8)');
    // Dark blue is dark → light outline
    expect(computeOutlineColor('#000080', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
  });

  it('returns dark outline for unparseable colors (fallback)', () => {
    expect(computeOutlineColor('invalid', 0.8)).toBe('rgba(0, 0, 0, 0.8)');
    expect(computeOutlineColor('', 0.5)).toBe('rgba(0, 0, 0, 0.5)');
  });

  it('uses the provided opacity', () => {
    expect(computeOutlineColor('#FFFFFF', 1.0)).toBe('rgba(0, 0, 0, 1)');
    expect(computeOutlineColor('#000000', 0.0)).toBe('rgba(255, 255, 255, 0)');
  });

  it('handles rgb() format', () => {
    expect(computeOutlineColor('rgb(255, 255, 255)', 0.8)).toBe('rgba(0, 0, 0, 0.8)');
    expect(computeOutlineColor('rgb(0, 0, 0)', 0.8)).toBe('rgba(255, 255, 255, 0.8)');
  });
});

// ── toRgba ────────────────────────────────────────────────────────────

describe('toRgba', () => {
  it('converts rgb() to rgba() with given alpha', () => {
    expect(toRgba('rgb(255, 0, 0)', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
    expect(toRgba('rgb(0, 128, 255)', 1.0)).toBe('rgba(0, 128, 255, 1)');
  });

  it('converts rgba() to rgba() with new alpha', () => {
    expect(toRgba('rgba(255, 0, 0, 0.3)', 0.8)).toBe('rgba(255, 0, 0, 0.8)');
  });

  it('returns original string for non-matching input', () => {
    expect(toRgba('#FF0000', 0.5)).toBe('#FF0000');
    expect(toRgba('hsl(0, 100%, 50%)', 0.5)).toBe('hsl(0, 100%, 50%)');
    expect(toRgba('', 0.5)).toBe('');
  });

  it('handles spaces in input', () => {
    expect(toRgba('rgb( 255 , 128 , 64 )', 0.5)).toBe('rgba(255, 128, 64, 0.5)');
  });
});

// ── computeReadableTextColor ──────────────────────────────────────────

describe('computeReadableTextColor', () => {
  it('returns black for light backgrounds', () => {
    expect(computeReadableTextColor('#FFFFFF')).toBe('#000000');
    expect(computeReadableTextColor('#FFFF00')).toBe('#000000');
    expect(computeReadableTextColor('#90EE90')).toBe('#000000');
  });

  it('returns white for dark backgrounds', () => {
    expect(computeReadableTextColor('#000000')).toBe('#ffffff');
    expect(computeReadableTextColor('#000080')).toBe('#ffffff');
    expect(computeReadableTextColor('#800000')).toBe('#ffffff');
  });

  it('returns white for unparseable colors (fallback)', () => {
    expect(computeReadableTextColor('invalid')).toBe('#ffffff');
    expect(computeReadableTextColor('')).toBe('#ffffff');
  });

  it('handles rgb() format', () => {
    expect(computeReadableTextColor('rgb(255, 255, 255)')).toBe('#000000');
    expect(computeReadableTextColor('rgb(0, 0, 0)')).toBe('#ffffff');
  });

  it('handles the boundary (mid-gray)', () => {
    // Mid-gray ~128,128,128 → luminance ≈ 0.215 → dark → white text
    const result = computeReadableTextColor('#808080');
    expect(result).toBe('#ffffff');
  });
});

// ── resolveSuperChatRgb ───────────────────────────────────────────────

describe('resolveSuperChatRgb', () => {
  const makeColors = (): Record<SuperChatTier, RgbColor> => ({
    blue: { r: 0, g: 0, b: 255 },
    cyan: { r: 0, g: 255, b: 255 },
    green: { r: 0, g: 255, b: 0 },
    yellow: { r: 255, g: 255, b: 0 },
    orange: { r: 255, g: 165, b: 0 },
    magenta: { r: 255, g: 0, b: 255 },
    red: { r: 255, g: 0, b: 0 },
  });

  it('uses headerBackgroundColor when available', () => {
    const result = resolveSuperChatRgb(
      { headerBackgroundColor: '#FF0000', tier: 'blue' },
      makeColors()
    );
    expect(result).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('falls back to backgroundColor when headerBackgroundColor is absent', () => {
    const result = resolveSuperChatRgb(
      { backgroundColor: '#00FF00', tier: 'blue' },
      makeColors()
    );
    expect(result).toEqual({ r: 0, g: 255, b: 0 });
  });

  it('prefers headerBackgroundColor over backgroundColor when both are present', () => {
    const result = resolveSuperChatRgb(
      { headerBackgroundColor: '#FF0000', backgroundColor: '#0000FF', tier: 'green' },
      makeColors()
    );
    expect(result).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('falls back to tier color when no source color is available', () => {
    const result = resolveSuperChatRgb(
      { tier: 'yellow' },
      makeColors()
    );
    expect(result).toEqual({ r: 255, g: 255, b: 0 });
  });

  it('falls back to blue tier color when tier key is missing from colors', () => {
    const colors = makeColors();
    delete (colors as Partial<typeof colors>).orange;
    const result = resolveSuperChatRgb(
      { tier: 'orange' },
      colors
    );
    expect(result).toEqual(colors.blue!);
  });

  it('handles unparseable color strings (falls back to tier)', () => {
    const result = resolveSuperChatRgb(
      { headerBackgroundColor: 'invalid-color', tier: 'red' },
      makeColors()
    );
    expect(result).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('handles rgba() color format', () => {
    const result = resolveSuperChatRgb(
      { headerBackgroundColor: 'rgba(100, 150, 200, 0.8)', tier: 'blue' },
      makeColors()
    );
    expect(result).toEqual({ r: 100, g: 150, b: 200 });
  });

  it('handles empty string colors (falls back to tier)', () => {
    const result = resolveSuperChatRgb(
      { headerBackgroundColor: '', tier: 'green' },
      makeColors()
    );
    expect(result).toEqual({ r: 0, g: 255, b: 0 });
  });
});

// ── desaturateColor ────────────────────────────────────────────────────

import { desaturateColor } from '@renderer/color-utils';

describe('desaturateColor', () => {
  it('factor 0 returns original color (hex)', () => {
    expect(desaturateColor('#FF0000', 0)).toBe('rgb(255,0,0)');
    expect(desaturateColor('#00FF00', 0)).toBe('rgb(0,255,0)');
  });

  it('factor 1 returns full grayscale (hex)', () => {
    // 0.299*255 + 0.587*0 + 0.114*0 = 76.245 → gray ≈ 76
    const gray = desaturateColor('#FF0000', 1);
    expect(gray).toBe('rgb(76,76,76)');
  });

  it('factor 0.5 on mid-gray returns same gray (already neutral)', () => {
    const result = desaturateColor('#808080', 0.5);
    expect(result).toBe('rgb(128,128,128)');
  });

  it('handles 3-digit short hex', () => {
    expect(desaturateColor('#F00', 0)).toBe('rgb(255,0,0)');
  });

  it('handles rgb() format', () => {
    expect(desaturateColor('rgb(255, 0, 0)', 0)).toBe('rgb(255,0,0)');
  });

  it('handles rgba() format', () => {
    expect(desaturateColor('rgba(0, 255, 0, 0.5)', 0)).toBe('rgb(0,255,0)');
  });

  it('returns original for unparseable colors', () => {
    expect(desaturateColor('not-a-color', 0.5)).toBe('not-a-color');
  });

  it('full desaturation of pure white is still white', () => {
    expect(desaturateColor('#FFFFFF', 1)).toBe('rgb(255,255,255)');
  });
});
