import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveTranslationTarget } from '@i18n/index';

describe('resolveTranslationTarget', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes through concrete language unchanged', () => {
    expect(resolveTranslationTarget('ja')).toBe('ja');
    expect(resolveTranslationTarget('ko')).toBe('ko');
    expect(resolveTranslationTarget('en')).toBe('en');
  });

  it('resolves "auto" to browser language (ko-KR)', () => {
    vi.stubGlobal('navigator', { language: 'ko-KR' });
    expect(resolveTranslationTarget('auto')).toBe('ko');
  });

  it('resolves "auto" to browser language (ja-JP)', () => {
    vi.stubGlobal('navigator', { language: 'ja-JP' });
    expect(resolveTranslationTarget('auto')).toBe('ja');
  });

  it('resolves "auto" to "en" for unsupported language (fr-FR)', () => {
    vi.stubGlobal('navigator', { language: 'fr-FR' });
    expect(resolveTranslationTarget('auto')).toBe('en');
  });

  it('resolves "auto" to "en" when navigator.language is empty', () => {
    vi.stubGlobal('navigator', { language: '' });
    expect(resolveTranslationTarget('auto')).toBe('en');
  });

  it('handles all supported languages', () => {
    for (const lang of ['en', 'ko', 'ja', 'es', 'zh-CN', 'ar'] as const) {
      expect(resolveTranslationTarget(lang)).toBe(lang);
    }
  });
});
