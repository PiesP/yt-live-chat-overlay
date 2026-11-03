// SPDX-License-Identifier: MIT

import type {
  LanguageSetting,
  TranslationSource,
  TranslationSourceLanguage,
  TranslationTarget,
} from '@app-types';
import { TRANSLATION_MAPS } from '@i18n/index';
import {
  getInterfaceLanguageDirection,
  INTERFACE_LANGUAGE_CODES,
  INTERFACE_LANGUAGE_OPTIONS,
  isLanguageSetting,
  isTranslationSource,
  isTranslationTarget,
  resolvePreferredLanguage,
  TRANSLATION_SOURCE_CODES,
  TRANSLATION_SOURCE_OPTIONS,
  TRANSLATION_TARGET_CODES,
  TRANSLATION_TARGET_OPTIONS,
} from '@i18n/language-domains';
import { DEFAULT_SETTINGS, normalizeStoredSettings } from '@settings/schema';
import { PANES } from '@settings/ui/panes';
import { describe, expect, expectTypeOf, it } from 'vite-plus/test';

const expectedInterface = ['auto', 'en', 'ko', 'ja', 'es', 'zh-CN', 'ar'];
const expectedTarget = ['auto', 'ko', 'en', 'ja', 'es', 'zh-CN', 'ar'];
const expectedLabels = ['English', '한국어', '日本語', 'Español', '中文', 'العربية'];

describe('product language domains', () => {
  it('keeps separate product orders and exhaustive shipped interface maps', () => {
    expect(['auto', ...INTERFACE_LANGUAGE_CODES]).toEqual(expectedInterface);
    expect(['auto', ...TRANSLATION_SOURCE_CODES]).toEqual(expectedInterface);
    expect(['auto', ...TRANSLATION_TARGET_CODES]).toEqual(expectedTarget);
    expect(Object.keys(TRANSLATION_MAPS).sort()).toEqual(['ar', 'en', 'es', 'ja', 'ko', 'zh-CN']);
  });

  it('preserves the deliberate Chinese native label and distinct auto wording', () => {
    expect(INTERFACE_LANGUAGE_OPTIONS.map(([, label]) => label)).toEqual([
      'translation.languageAuto',
      ...expectedLabels,
    ]);
    expect(TRANSLATION_SOURCE_OPTIONS.map(([, label]) => label)).toEqual([
      'translation.sourceAuto',
      ...expectedLabels,
    ]);
    expect(TRANSLATION_TARGET_OPTIONS.map(([, label]) => label)).toEqual([
      'translation.languageAuto',
      '한국어',
      'English',
      '日本語',
      'Español',
      '中文',
      'العربية',
    ]);
  });

  it.each([
    ['language', INTERFACE_LANGUAGE_OPTIONS, expectedInterface, isLanguageSetting],
    ['translationSource', TRANSLATION_SOURCE_OPTIONS, expectedInterface, isTranslationSource],
    ['translationTarget', TRANSLATION_TARGET_OPTIONS, expectedTarget, isTranslationTarget],
  ] as const)(
    'derives %s selectors and strict persisted validation from its domain',
    (key, options, expected, accepts) => {
      const field = PANES.flatMap((pane) => pane.sections)
        .flatMap((section) => section.fields)
        .find((entry) => 'key' in entry && entry.key === key);
      expect(field?.type).toBe('select');
      if (field?.type !== 'select') throw new Error('Language selector is unavailable');
      expect(field.options).toBe(options);
      expect(field.options.map(([value]) => value)).toEqual(expected);
      expect(new Set(field.options.map(([value]) => value)).size).toBe(expected.length);
      for (const value of expected) {
        expect(accepts(value)).toBe(true);
        const normalized = normalizeStoredSettings({ [key]: value });
        expect(normalized[key]).toBe(value);
        expect(normalizeStoredSettings(JSON.parse(JSON.stringify(normalized)))[key]).toBe(value);
      }
      for (const value of [
        'EN',
        'ko-KR',
        'zh-cn',
        'zh-Hans',
        'zh-Hant',
        'en-US',
        ' auto',
        'AUTO',
        'fr',
        '',
        null,
        1,
      ]) {
        expect(accepts(value)).toBe(false);
        expect(normalizeStoredSettings({ [key]: value })[key]).toBe(DEFAULT_SETTINGS[key]);
      }
    }
  );

  it('derives strict persisted types without adding detector-only scripts', () => {
    type ExpectedSetting = 'auto' | 'en' | 'ko' | 'ja' | 'es' | 'zh-CN' | 'ar';
    expectTypeOf<LanguageSetting>().toEqualTypeOf<ExpectedSetting>();
    expectTypeOf<TranslationSource>().toEqualTypeOf<ExpectedSetting>();
    expectTypeOf<TranslationTarget>().toEqualTypeOf<ExpectedSetting>();
    expectTypeOf<TranslationSourceLanguage>().toEqualTypeOf<
      Exclude<ExpectedSetting, 'auto'> | 'zh-Hans' | 'zh-Hant'
    >();
  });

  it('uses matching shared direction metadata without applying it to the page', () => {
    expect(
      INTERFACE_LANGUAGE_CODES.map((code) => [code, getInterfaceLanguageDirection(code)])
    ).toEqual([
      ['en', 'ltr'],
      ['ko', 'ltr'],
      ['ja', 'ltr'],
      ['es', 'ltr'],
      ['zh-CN', 'ltr'],
      ['ar', 'rtl'],
    ]);
  });
});

describe('browser candidate resolution within a product domain', () => {
  it('skips a shared supported language outside a future product subset before later matches', () => {
    expect(resolvePreferredLanguage(['ja-JP', 'ko-KR', 'en-US'], ['ko', 'en'], 'en')).toBe('ko');
    expect(resolvePreferredLanguage(['ar-EG', 'ja-JP', 'es-MX'], ['es', 'en'], 'en')).toBe('es');
  });

  it.each([
    [[' KO-kr ', 'ja-JP'], 'ko'],
    [['zh-hANT-TW', 'en-US'], 'zh-CN'],
    [['AR-eg'], 'ar'],
    [['fr-FR', 'es-MX'], 'es'],
    [['en_US', 'auto', 'fr-FR'], 'en'],
    [[undefined, ''], 'en'],
  ] as const)(
    'normalizes ordered browser hints %s and falls back independently',
    (candidates, expected) => {
      expect(resolvePreferredLanguage(candidates, INTERFACE_LANGUAGE_CODES, 'en')).toBe(expected);
    }
  );
});
