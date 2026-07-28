// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { PANES } from '@settings/ui/panes';
import type { PaneDef, FieldDef } from '@settings/ui/panes';
import { ROOT_SETTING_META } from '@settings/meta';
import { DEFAULT_SETTINGS } from '@settings/schema';

describe('SettingsPanes', () => {
  it('PANES is a non-empty array', () => {
    expect(Array.isArray(PANES)).toBe(true);
    expect(PANES.length).toBeGreaterThan(0);
  });

  it('each pane has a unique id', () => {
    const ids = PANES.map((p: PaneDef) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('each pane has a label and non-empty sections array', () => {
    for (const pane of PANES) {
      expect(pane.id).toBeTruthy();
      expect(typeof pane.label).toBe('string');
      expect(Array.isArray(pane.sections)).toBe(true);
    }
  });

  it('each section has a title and fields array', () => {
    for (const pane of PANES) {
      for (const section of pane.sections) {
        expect(typeof section.title).toBe('string');
        expect(Array.isArray(section.fields)).toBe(true);
      }
    }
  });

  it('each field has a valid type', () => {
    const validTypes = new Set([
      'number', 'checkbox', 'select', 'text', 'font-preview', 'weight-toggle',
      'font-chips', 'enabled', 'author-grid', 'range',
    ]);

    for (const pane of PANES) {
      for (const section of pane.sections) {
        for (const field of section.fields) {
          expect(validTypes.has(field.type)).toBe(true);
        }
      }
    }
  });

  it('has expected pane IDs', () => {
    const ids = PANES.map((p: PaneDef) => p.id);
    expect(ids).toContain('comments');
    expect(ids).toContain('colors');
    expect(ids).toContain('advanced');
    expect(ids).toContain('translation');
  });

  it('comments pane has enabled field', () => {
    const commentsPane = PANES.find((p: PaneDef) => p.id === 'comments');
    expect(commentsPane).toBeDefined();
    const hasEnabled = commentsPane!.sections.some(
      (s) => s.fields.some((f: FieldDef) => f.type === 'enabled')
    );
    expect(hasEnabled).toBe(true);
  });

  it('comments pane has danmakuMode select', () => {
    const commentsPane = PANES.find((p: PaneDef) => p.id === 'comments');
    expect(commentsPane).toBeDefined();
    const hasModeSelect = commentsPane!.sections.some(
      (s) => s.fields.some(
        (f: FieldDef) => f.type === 'select' && (f as { key: string }).key === 'danmakuMode'
      )
    );
    expect(hasModeSelect).toBe(true);
  });

  it('colors pane has author-grid field', () => {
    const colorsPane = PANES.find((p: PaneDef) => p.id === 'colors');
    expect(colorsPane).toBeDefined();
    const hasAuthorGrid = colorsPane!.sections.some(
      (s) => s.fields.some((f: FieldDef) => f.type === 'author-grid')
    );
    expect(hasAuthorGrid).toBe(true);
  });

  it('select fields have options array', () => {
    for (const pane of PANES) {
      for (const section of pane.sections) {
        for (const field of section.fields) {
          if (field.type === 'select') {
            const f = field as { type: 'select'; options: ReadonlyArray<[string, string]> };
            expect(Array.isArray(f.options)).toBe(true);
            expect(f.options.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('every keyed pane field exists in the settings metadata schema', () => {
    for (const pane of PANES) {
      for (const section of pane.sections) {
        for (const field of section.fields) {
          if (!('key' in field)) continue;

          if (field.modifier) {
            const nestedSettings = DEFAULT_SETTINGS[field.modifier as keyof typeof DEFAULT_SETTINGS];
            expect(nestedSettings, `${field.modifier}.${field.key}`).toBeTypeOf('object');
            expect(field.key in (nestedSettings as unknown as Record<string, unknown>)).toBe(true);
          } else {
            expect(field.key in ROOT_SETTING_META, field.key).toBe(true);
          }
        }
      }
    }
  });
});
