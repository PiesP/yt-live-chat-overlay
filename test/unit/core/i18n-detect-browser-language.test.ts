import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectBrowserLanguage } from '@i18n/index';

describe('detectBrowserLanguage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── navigator.languages 배열 우선순위 테스트 ──

  it('returns first supported language from navigator.languages', () => {
    vi.stubGlobal('navigator', {
      languages: ['fr-FR', 'en-US', 'ja-JP'],
      language: 'fr-FR',
    });
    expect(detectBrowserLanguage()).toBe('en');
  });

  it('skips unsupported languages in navigator.languages and matches later entry', () => {
    vi.stubGlobal('navigator', {
      languages: ['fr-FR', 'de-DE', 'ko-KR'],
      language: 'fr-FR',
    });
    expect(detectBrowserLanguage()).toBe('ko');
  });

  it('falls back to navigator.language when navigator.languages is empty', () => {
    vi.stubGlobal('navigator', {
      languages: [],
      language: 'ja-JP',
    });
    expect(detectBrowserLanguage()).toBe('ja');
  });

  it('falls back to navigator.language when navigator.languages is undefined', () => {
    vi.stubGlobal('navigator', {
      languages: undefined,
      language: 'ko-KR',
    });
    expect(detectBrowserLanguage()).toBe('ko');
  });

  it('returns "en" when navigator.languages has no supported language', () => {
    vi.stubGlobal('navigator', {
      languages: ['fr-FR', 'de-DE', 'pt-BR'],
      language: 'fr-FR',
    });
    expect(detectBrowserLanguage()).toBe('en');
  });

  // ── navigator.language 단일값 폴백 (기존 동작 유지) ──

  it('returns "ko" for ko-KR', () => {
    vi.stubGlobal('navigator', { language: 'ko-KR' });
    expect(detectBrowserLanguage()).toBe('ko');
  });

  it('returns "en" for en-US', () => {
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(detectBrowserLanguage()).toBe('en');
  });

  it('returns "ja" for ja-JP', () => {
    vi.stubGlobal('navigator', { language: 'ja-JP' });
    expect(detectBrowserLanguage()).toBe('ja');
  });

  it('returns "es" for es-ES', () => {
    vi.stubGlobal('navigator', { language: 'es-ES' });
    expect(detectBrowserLanguage()).toBe('es');
  });

  it('returns "zh-CN" for zh-CN', () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' });
    expect(detectBrowserLanguage()).toBe('zh-CN');
  });

  it('returns "en" for unsupported language', () => {
    vi.stubGlobal('navigator', { language: 'fr-FR' });
    expect(detectBrowserLanguage()).toBe('en');
  });

  it('returns "en" when navigator.language is empty', () => {
    vi.stubGlobal('navigator', { language: '' });
    expect(detectBrowserLanguage()).toBe('en');
  });

  it('returns "en" when navigator is unavailable', () => {
    vi.stubGlobal('navigator', undefined);
    expect(detectBrowserLanguage()).toBe('en');
  });

  // ── 모든 지원 언어 매칭 검증 ──

  it('matches all supported languages via navigator.languages', () => {
    const cases: Array<[string, string]> = [
      ['ko-KR', 'ko'],
      ['ja-JP', 'ja'],
      ['es-ES', 'es'],
      ['zh-CN', 'zh-CN'],
      ['en-US', 'en'],
    ];
    for (const [input, expected] of cases) {
      vi.stubGlobal('navigator', {
        languages: [input],
        language: input,
      });
      expect(detectBrowserLanguage()).toBe(expected);
    }
  });
});
