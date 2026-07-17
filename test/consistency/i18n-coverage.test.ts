import { describe, expect, test } from 'vitest';
import { PANES } from '@settings/ui/panes';
import { TRANSLATION_MAPS } from '@i18n/index';

function collectI18nKeys(): string[] {
  const keys: string[] = [];

  // Pane tabs
  for (const pane of PANES) keys.push(pane.label);

  // Section titles, field labels, tooltips, select options
  for (const pane of PANES) {
    for (const section of pane.sections) {
      if (section.title) keys.push(section.title);
      for (const field of section.fields) {
        if ('label' in field) keys.push(field.label);
        if ('title' in field && field.title) keys.push(field.title);
        if (field.type === 'select' && 'options' in field) {
          for (const [, label] of field.options) keys.push(label);
        }
      }
    }
  }

  // Modal chrome (hardcoded in settings-ui-form.ts createActions, createHeader, etc.)
  keys.push(
    'Chat Overlay', 'Close settings', 'Settings categories',
    'Overlay Enabled', 'Reset', 'Export', 'Import', 'Close',
    'Reset all settings to defaults?', 'Cancel',
    'Import failed: invalid settings format',
    'Settings imported successfully',
    'Import failed: invalid JSON',
    'Chat overlay settings', 'Reset overlay settings', 'Value adjusted to'
  );

  // Author grid
  keys.push('Name Color', 'Show Name', 'Normal', 'Member', 'Moderator', 'Owner', 'Verified', 'SuperChat');

  return [...new Set(keys)]; // dedup
}

// English is the canonical key — the key string itself is the fallback
const EN_FALLBACKS = new Set(collectI18nKeys());

// Language native names are displayed as-is in the UI (e.g. in language
// select dropdowns) and do not need translated entries in each map.
const UNTRANSLATED_KEYS = new Set([
  'English', '한국어', '日本語', 'Español', '中文', 'العربية',
]);

describe('i18n key coverage', () => {
  // English is the canonical key — the key string itself is the fallback,
  // so the `en` map is intentionally empty ({}). Skip it.
  const languages = Object.keys(TRANSLATION_MAPS).filter(l => l !== 'en');

  for (const lang of languages) {
    test(`all PANES keys exist in ${lang} translation map`, () => {
      const map = TRANSLATION_MAPS[lang as keyof typeof TRANSLATION_MAPS]!;
      const missing: string[] = [];
      for (const key of EN_FALLBACKS) {
        if (UNTRANSLATED_KEYS.has(key)) continue;
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
