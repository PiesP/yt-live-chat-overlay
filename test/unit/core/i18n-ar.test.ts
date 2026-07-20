import { describe, expect, it } from 'vitest';
import { AR } from '@i18n/ar';

describe('Arabic translations', () => {
  it('has proper Arabic labels for font-related keys', () => {
    expect(AR['danmaku.font']).toBeDefined();
    expect(AR['danmaku.fontSize']).toBeDefined();
  });

  it('does not leave English stroke fragments in Arabic labels', () => {
    expect(AR['appearance.outlineWidthDesc']).not.toContain('stroke');
    expect(AR['appearance.outlineOpacityDesc']).not.toContain('stroke');
  });

  it('spells cache-size labels without an extra letter', () => {
    const cacheLabels = Object.entries(AR)
      .filter(([key]) => key.startsWith('advanced.') && (key.includes('Cache') || key.includes('cache')))
      .map(([, value]) => value);

    expect(cacheLabels.length).toBeGreaterThanOrEqual(3);
    expect(cacheLabels.every((value) => !value.includes('لللذاكرة'))).toBe(true);
  });
});
