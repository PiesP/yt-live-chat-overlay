import { describe, expect, it } from 'vitest';
import { AR } from '@i18n/ar';

describe('Arabic translations', () => {
  it('uses the English Japanese-language key', () => {
    expect(AR['日本語']).toBe('اليابانية');
    expect(AR['اليابانية']).toBeUndefined();
  });

  it('does not leave English stroke fragments in Arabic labels', () => {
    expect(AR['Text outline stroke width in pixels (0-8)']).not.toContain('stroke');
    expect(AR['Text outline stroke opacity (0-100%)']).not.toContain('stroke');
  });

  it('spells cache-size labels without an extra letter', () => {
    const cacheLabels = Object.entries(AR)
      .filter(([key]) => key.startsWith('Max memory for'))
      .map(([, value]) => value);

    expect(cacheLabels).toHaveLength(4);
    expect(cacheLabels.every((value) => !value.includes('لللذاكرة'))).toBe(true);
  });
});
