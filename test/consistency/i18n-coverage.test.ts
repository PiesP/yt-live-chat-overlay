import { describe, expect, test } from 'vitest';
import { PANES } from '@settings/ui/panes';
import { TRANSLATION_MAPS } from '@i18n/index';

function collectI18nKeys(): string[] {
  const keys: string[] = [];

  const collectSectionKeys = (sections: (typeof PANES)[number]['sections']): void => {
    for (const section of sections) {
      if (section.title) keys.push(section.title);
      for (const field of section.fields) {
        if ('label' in field) keys.push(field.label);
        if ('title' in field && field.title) keys.push(field.title);
        if (field.type === 'select' && 'options' in field) {
          for (const [, label] of field.options) keys.push(label);
        }
      }
    }
  };

  // Pane tabs (dot-notation keys now)
  for (const pane of PANES) keys.push(pane.label);

  // Section titles, field labels, tooltips, select options, and disclosures.
  for (const pane of PANES) {
    collectSectionKeys(pane.sections);
    for (const disclosure of pane.disclosures ?? []) {
      keys.push(disclosure.label);
      collectSectionKeys(disclosure.sections);
    }
  }

  // Modal chrome keys used in form.ts and controller.ts
  keys.push(
    'app.title', 'app.close', 'app.settingsCategories',
    'app.enabled', 'actions.reset', 'actions.export', 'actions.import',
    'app.done', 'app.cancel',
    'reset.confirm', 'import.invalidFormat', 'import.success',
    'import.invalidJson', 'app.settings', 'reset.confirmDesc',
    'format.valueAdjusted', 'format.shortMessagesShown',
    'app.autoSave', 'app.reload', 'appearance.authorsBackground',
    'danmaku.preview', 'danmaku.previewMessage',
    'translation.capabilityDetected', 'translation.capabilityUnavailable',
  );

  return [...new Set(keys)];
}

// Keys that are intentionally not translated (native names, author enums)
const UNTRANSLATED_KEYS = new Set([
  'English', '한국어', '日本語', 'Español', '中文', 'العربية',
]);

describe('i18n key coverage', () => {
  const languages = Object.keys(TRANSLATION_MAPS).filter(l => l !== 'en');

  for (const lang of languages) {
    test(`all PANES keys exist in ${lang} translation map`, () => {
      const map = TRANSLATION_MAPS[lang as keyof typeof TRANSLATION_MAPS]!;
      const missing: string[] = [];
      for (const key of collectI18nKeys()) {
        if (UNTRANSLATED_KEYS.has(key)) continue;
        // Skip AuthorGrid field type (has no label, handled differently)
        if (typeof key !== 'string') continue;
        const entry = map[key as keyof typeof map];
        if (entry === undefined) missing.push(key);
      }
      expect(missing,
        `Missing ${missing.length} translation(s) in ${lang}:\n` +
        missing.map(k => `  - "${k}"`).join('\n')
      ).toEqual([]);
    });
  }
});
