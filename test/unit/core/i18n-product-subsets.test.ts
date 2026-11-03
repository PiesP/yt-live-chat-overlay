// SPDX-License-Identifier: MIT

import { detectBrowserLanguage, resolveTranslationTarget } from '@i18n/index';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

// Future product domains can be narrower and different while core still recognizes all hints.
vi.mock('@i18n/language-domains', async (original) => ({
  ...(await original<typeof import('@i18n/language-domains')>()),
  INTERFACE_LANGUAGE_CODES: ['en', 'ko'],
  TRANSLATION_TARGET_CODES: ['en', 'es'],
}));

describe('separate interface and target detection domains', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('continues past shared-only platform/list candidates inside each product domain', () => {
    vi.stubGlobal('chrome', { i18n: { getUILanguage: () => 'ar-EG' } });
    vi.stubGlobal('navigator', { languages: ['ja-JP', 'ko-KR', 'es-MX'], language: 'fr-FR' });
    expect(detectBrowserLanguage()).toBe('ko');
    expect(resolveTranslationTarget('auto')).toBe('es');
  });

  it('uses the single browser hint only after all earlier candidates miss the target domain', () => {
    vi.stubGlobal('chrome', undefined);
    vi.stubGlobal('navigator', { languages: ['ja-JP', 'ko-KR'], language: 'es-MX' });
    expect(detectBrowserLanguage()).toBe('ko');
    expect(resolveTranslationTarget('auto')).toBe('es');
  });
});
