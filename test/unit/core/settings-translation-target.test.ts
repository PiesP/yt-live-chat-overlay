import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, normalizeStoredSettings } from '@settings/schema';

describe('translationTarget validation', () => {
  it('default translationTarget is "auto"', () => {
    expect(DEFAULT_SETTINGS.translationTarget).toBe('auto');
  });

  it('accepts "auto" as valid translationTarget from storage', () => {
    const normalized = normalizeStoredSettings({ translationTarget: 'auto' });
    expect(normalized.translationTarget).toBe('auto');
  });

  it('accepts concrete language codes', () => {
    for (const lang of ['en', 'ko', 'ja', 'es', 'zh-CN', 'ar']) {
      const normalized = normalizeStoredSettings({ translationTarget: lang });
      expect(normalized.translationTarget).toBe(lang);
    }
  });

  it('falls back to default for invalid translationTarget', () => {
    const normalized = normalizeStoredSettings({ translationTarget: 'invalid' });
    expect(normalized.translationTarget).toBe('auto');
  });

  it('translationSource accepts "auto"', () => {
    const normalized = normalizeStoredSettings({ translationSource: 'auto' });
    // 'auto' is now a valid TranslationSource value
    expect(normalized.translationSource).toBe('auto');
  });
});
