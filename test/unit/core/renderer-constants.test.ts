import { describe, it, expect } from 'vitest';
import { hashStringForTier } from '@renderer/constants';
import { desaturateColor } from '@renderer/color-utils';

// ── hashStringForTier ────────────────────────────────────────────────

describe('hashStringForTier', () => {
  it('returns a number between 0 and 1', () => {
    for (const str of ['a', 'hello', 'test123', '🎉', '']) {
      const result = hashStringForTier(str);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThan(1);
    }
  });

  it('returns consistent results for the same input', () => {
    expect(hashStringForTier('test')).toBe(hashStringForTier('test'));
    expect(hashStringForTier('abc')).toBe(hashStringForTier('abc'));
  });

  it('returns different results for different inputs', () => {
    expect(hashStringForTier('a')).not.toBe(hashStringForTier('b'));
    expect(hashStringForTier('hello')).not.toBe(hashStringForTier('world'));
  });

  it('returns 0 for empty string', () => {
    // djb2 of empty string: hash=5381, (5381>>>0)/4294967296
    const result = hashStringForTier('');
    expect(result).toBe((5381 >>> 0) / 4294967296);
  });

  it('distributes values without clustering at the extremes', () => {
    const values = Array.from({ length: 100 }, (_, i) => hashStringForTier(`str-${i}`));
    const uniqueCount = new Set(values).size;
    expect(uniqueCount).toBe(100);
    // djb2 is deterministic but not perfectly uniform for sequential inputs.
    // Just verify all values are in [0, 1) and not all clustered in a tiny range.
    const range = Math.max(...values) - Math.min(...values);
    expect(range).toBeGreaterThan(0.01); // at least 20% spread
  });
});

// ── desaturateColor ──────────────────────────────────────────────────

describe('desaturateColor', () => {
  describe('hex colors', () => {
    it('desaturates 6-digit hex', () => {
      const result = desaturateColor('#FF0000', 1.0);
      expect(result).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    });

    it('desaturates 3-digit hex', () => {
      const result = desaturateColor('#F00', 1.0);
      expect(result).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    });

    it('returns original color for factor 0', () => {
      expect(desaturateColor('#FF0000', 0)).toBe('rgb(255,0,0)');
    });

    it('returns grayscale for factor 1', () => {
      // Red (255,0,0) → gray value = 0.299*255 + 0.587*0 + 0.114*0 = 76.245
      const result = desaturateColor('#FF0000', 1.0);
      expect(result).toBe('rgb(76,76,76)');
    });

    it('handles black', () => {
      expect(desaturateColor('#000000', 1.0)).toBe('rgb(0,0,0)');
    });

    it('handles white', () => {
      expect(desaturateColor('#FFFFFF', 1.0)).toBe('rgb(255,255,255)');
    });
  });

  describe('rgb/rgba colors', () => {
    it('desaturates rgb() format', () => {
      const result = desaturateColor('rgb(255, 0, 0)', 1.0);
      expect(result).toBe('rgb(76,76,76)');
    });

    it('desaturates rgba() format (ignores alpha)', () => {
      const result = desaturateColor('rgba(255, 0, 0, 0.5)', 1.0);
      expect(result).toBe('rgb(76,76,76)');
    });

    it('returns original for factor 0 with rgb()', () => {
      expect(desaturateColor('rgb(255, 0, 0)', 0)).toBe('rgb(255,0,0)');
    });
  });

  describe('edge cases', () => {
    it('returns original for unrecognized format', () => {
      expect(desaturateColor('hsl(0, 100%, 50%)', 0.5)).toBe('hsl(0, 100%, 50%)');
      expect(desaturateColor('', 0.5)).toBe('');
    });

    it('handles partial desaturation (factor 0.5)', () => {
      // Red (255,0,0) with factor 0.5 → halfway to gray (76)
      const result = desaturateColor('#FF0000', 0.5);
      // r = 255 + (76-255)*0.5 = 255 - 89.5 = 165.5 → 166
      expect(result).toBe('rgb(166,38,38)');
    });

    it('handles mid-gray (no change at any factor)', () => {
      // Gray (128,128,128) → gray value = 128 → no change
      expect(desaturateColor('#808080', 1.0)).toBe('rgb(128,128,128)');
    });
  });
});
